use super::{ownership, WorkspaceStore};
use dustdesk_tauri::{
    lan::files::Directory,
    managed_snapshot::preparation::{require_external_destination, Catalog, Status},
};
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use tauri::Manager;
use tokio_util::sync::CancellationToken;

fn location(root: &Path, ownership: &ownership::Ownership) -> Result<PathBuf, String> {
    let identity = ownership.identity(root)?;
    Ok(root
        .parent()
        .ok_or("受管 Data 缺少原生 profile 父目录")?
        .join(format!(
            ".DustDeskSnapshotPreparation-{}-{}",
            identity.volume, identity.file
        )))
}

#[tauri::command]
pub async fn data_snapshot_prepare(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<serde_json::Value, String> {
    crate::toolbox::require_active(&app, &window)?;
    let selected = crate::system::system_pick(
        app.clone(),
        window.clone(),
        true,
        Some("选择 Data 快照保存位置".into()),
    )
    .await?;
    if selected["canceled"] == true {
        return Ok(serde_json::json!({"canceled":true}));
    }
    let parent = selected["path"]
        .as_str()
        .filter(|_| selected["ok"] == true)
        .ok_or_else(|| {
            selected["error"]
                .as_str()
                .unwrap_or("未取得快照保存位置")
                .to_owned()
        })?;
    let parent = Directory::open(Path::new(parent)).map_err(|error| error.to_string())?;
    let destination = parent.path().join(format!(
        "DustDesk-Data-{}-{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S"),
        uuid::Uuid::new_v4()
    ));
    let protected = app
        .state::<super::commands::StorageState>()
        .root
        .parent()
        .ok_or("原生 profile 目录无效")?
        .to_path_buf();
    require_external_destination(&destination, &protected)?;
    let checkpoint =
        crate::draft_maintenance::drafts_prepare(app.clone(), window.clone(), Some(false)).await?;
    let request = checkpoint.request_id.clone();
    let result = async {
        let gate = app.state::<crate::widgets::Service>().gate.clone();
        let _guard = gate.lock().await;
        let handle = app.clone();
        let window = window.clone();
        tokio::task::spawn_blocking(move || {
            let _parent = parent;
            let storage = handle.state::<super::commands::StorageState>();
            let slot = storage.store.lock().map_err(|error| error.to_string())?;
            let store = slot.as_ref().ok_or("工作区尚未读取")?;
            let service = handle.state::<crate::draft_maintenance::Service>();
            let active = || {
                if !crate::main_window::current(&handle, &window)
                    || service.ready_fingerprint(&checkpoint.request_id)?
                        != checkpoint.workspace_fingerprint
                {
                    return Err("Data 快照维护检查点已失效".into());
                }
                Ok(())
            };
            crate::platform::legacy_processes::require_stopped()?;
            let status = store.prepare_data_snapshot(
                &destination,
                &checkpoint.request_id,
                &checkpoint.workspace_fingerprint,
                &CancellationToken::new(),
                active,
            )?;
            crate::platform::legacy_processes::require_stopped()?;
            active()?;
            Ok::<_, String>(serde_json::json!({"id":status.id,"path":destination,
                "scope":"managed-data-only","productionReady":false,"migrationComplete":false}))
        })
        .await
        .map_err(|error| error.to_string())?
    }
    .await;
    let ended = crate::draft_maintenance::drafts_end(app, window, request).await;
    match result {
        Ok(mut result) => {
            if !matches!(ended, Ok(true)) {
                let error = ended.err().unwrap_or_else(|| "维护请求未确认释放".into());
                result["warning"] =
                    serde_json::json!(format!("Data 快照已准备，但维护收尾需要核验：{error}"));
            }
            Ok(result)
        }
        Err(error) => Err(error),
    }
}

pub(super) fn recover(root: &Path, ownership: &ownership::Ownership) -> Result<(), String> {
    let catalog = location(root, ownership)?;
    super::checked_path(&catalog)?;
    match fs::symlink_metadata(&catalog) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "检查原生快照准备目录失败（{}）：{error}",
                catalog.display()
            ))
        }
        Ok(_) => {}
    }
    let catalog = Catalog::open(root, &catalog)?;
    ownership.identity(root)?;
    catalog.recover()?;
    ownership.identity(root)?;
    Ok(())
}

impl WorkspaceStore {
    fn snapshot_catalog(&self, destination: &Path) -> Result<Catalog, String> {
        self.require_draft_recovered()?;
        self._ownership.identity(&self.root)?;
        let parent = self
            .root
            .parent()
            .ok_or("受管 Data 缺少原生 profile 父目录")?;
        let _profile = Directory::open(parent).map_err(|error| error.to_string())?;
        require_external_destination(destination, parent)?;
        let catalog = location(&self.root, &self._ownership)?;
        match fs::create_dir(&catalog) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!(
                    "创建原生快照准备目录失败（{}）：{error}",
                    catalog.display()
                ))
            }
        }
        Catalog::open(&self.root, &catalog)
    }

    pub(crate) fn prepare_handoff_snapshot(
        &self,
        destination: &Path,
        inputs: dustdesk_tauri::managed_snapshot::bundle::Inputs<'_>,
        cancel: &CancellationToken,
        require_active: impl Fn() -> Result<(), String>,
    ) -> Result<Status, String> {
        require_active()?;
        let catalog = self.snapshot_catalog(destination)?;
        catalog.prepare_handoff(destination, inputs, cancel, || {
            self._ownership.identity(&self.root)?;
            require_active()
        })
    }

    pub(crate) fn prepare_data_snapshot(
        &self,
        destination: &Path,
        request: &str,
        fingerprint: &str,
        cancel: &CancellationToken,
        require_active: impl Fn() -> Result<(), String>,
    ) -> Result<Status, String> {
        require_active()?;
        let catalog = self.snapshot_catalog(destination)?;
        catalog.prepare(destination, request, fingerprint, cancel, || {
            self._ownership.identity(&self.root)?;
            require_active()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dustdesk_tauri::managed_snapshot::preparation::Outcome;
    use sha2::{Digest, Sha256};
    use std::cell::Cell;
    use uuid::Uuid;

    struct Fixture {
        root: PathBuf,
        source: PathBuf,
        destination: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("dustdesk-native-snapshot-test-{}", Uuid::new_v4()));
            let source = root.join("Profile/Data");
            let destination = root.join("snapshot");
            Self {
                root,
                source,
                destination,
            }
        }
        fn store(&self) -> WorkspaceStore {
            let mut store = WorkspaceStore::open(self.source.clone()).unwrap();
            if !store.path().exists() {
                store
                    .initialize(super::super::normalize::default_state(), "test")
                    .unwrap();
            }
            store
        }
        fn fingerprint(&self) -> String {
            format!(
                "{:x}",
                Sha256::digest(fs::read(self.source.join("workspace.json")).unwrap())
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn actual_workspace_ownership_is_held_through_native_preparation_and_recovery() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let fingerprint = fixture.fingerprint();
        assert!(ownership::Ownership::acquire(&fixture.source).is_err());
        let status = store
            .prepare_data_snapshot(
                &fixture.destination,
                &Uuid::new_v4().to_string(),
                &fingerprint,
                &CancellationToken::new(),
                || {
                    assert!(ownership::Ownership::acquire(&fixture.source).is_err());
                    Ok(())
                },
            )
            .unwrap();
        let catalog = location(&fixture.source, &store._ownership).unwrap();
        drop(store);
        let mut reopened = fixture.store();
        let catalog = Catalog::open(&fixture.source, &catalog).unwrap();
        assert!(matches!(
            catalog.recover().unwrap()[0].outcome,
            Outcome::Prepared { .. }
        ));
        catalog
            .verify_prepared(&status.id, &CancellationToken::new())
            .unwrap();
        assert_eq!(fixture.fingerprint(), fingerprint);
        reopened.load("test").unwrap();
    }

    #[test]
    fn startup_aborts_uncommitted_copy_before_workspace_load_without_deleting_the_snapshot() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let fingerprint = fixture.fingerprint();
        let checked = Cell::new(false);
        assert!(store
            .prepare_data_snapshot(
                &fixture.destination,
                &Uuid::new_v4().to_string(),
                &fingerprint,
                &CancellationToken::new(),
                || {
                    if fixture.destination.join("snapshot.json").exists() {
                        checked.set(true);
                        return Err("revoked".into());
                    }
                    Ok(())
                }
            )
            .is_err());
        assert!(checked.get());
        let catalog = location(&fixture.source, &store._ownership).unwrap();
        let id = fs::read_dir(&catalog)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .find(|name| Uuid::parse_str(name).is_ok())
            .unwrap();
        assert!(!catalog.join(&id).join("decision.json").exists());
        drop(store);
        let mut reopened = fixture.store();
        let decision: serde_json::Value =
            serde_json::from_slice(&fs::read(catalog.join(&id).join("decision.json")).unwrap())
                .unwrap();
        assert_eq!(decision["outcome"]["state"], "aborted");
        assert!(fixture.destination.join("snapshot.json").is_file());
        assert_eq!(fixture.fingerprint(), fingerprint);
        reopened.load("test").unwrap();
    }

    #[test]
    fn broken_native_recovery_blocks_store_open_and_preserves_intent_until_explicit_repair() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let fingerprint = fixture.fingerprint();
        assert!(store
            .prepare_data_snapshot(
                &fixture.destination,
                &Uuid::new_v4().to_string(),
                &fingerprint,
                &CancellationToken::new(),
                || {
                    if fixture.destination.exists() {
                        return Err("revoked".into());
                    }
                    Ok(())
                }
            )
            .is_err());
        let catalog = location(&fixture.source, &store._ownership).unwrap();
        let id = fs::read_dir(&catalog)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .find(|name| Uuid::parse_str(name).is_ok())
            .unwrap();
        let intent = fs::read(catalog.join(&id).join("intent.json")).unwrap();
        let decision = catalog.join(&id).join("decision.json");
        fs::create_dir(&decision).unwrap();
        drop(store);
        assert!(WorkspaceStore::open(fixture.source.clone()).is_err());
        assert_eq!(fixture.fingerprint(), fingerprint);
        assert_eq!(
            fs::read(catalog.join(&id).join("intent.json")).unwrap(),
            intent
        );
        assert!(decision.is_dir());
        fs::remove_dir(&decision).unwrap();
        fixture.store().load("test").unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(&decision).unwrap()).unwrap();
        assert_eq!(value["outcome"]["state"], "aborted");
    }

    #[test]
    fn native_profile_and_browser_destinations_are_rejected_before_catalog_creation() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let profile = fixture.source.parent().unwrap();
        fs::create_dir(profile.join("WebView2")).unwrap();
        for destination in [
            fixture.source.join("snapshot"),
            profile.join("snapshot"),
            profile.join("WebView2/snapshot"),
            PathBuf::from(format!(
                r"\\?\{}",
                profile.join("WebView2/snapshot").display()
            )),
        ] {
            assert!(store
                .prepare_data_snapshot(
                    &destination,
                    &Uuid::new_v4().to_string(),
                    &fixture.fingerprint(),
                    &CancellationToken::new(),
                    || Ok(())
                )
                .is_err());
            assert!(!destination.exists());
        }
        assert!(!location(&fixture.source, &store._ownership)
            .unwrap()
            .exists());
    }
}
