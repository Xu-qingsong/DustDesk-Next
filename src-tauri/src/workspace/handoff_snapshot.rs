use super::{commands::StorageState, draft_browser, draft_export};
use dustdesk_tauri::{
    lan::{files::Directory, migration::Frozen},
    managed_snapshot::{bundle::Inputs, preparation::require_external_destination},
};
use serde_json::{json, Value};
use std::path::Path;
use tauri::{Manager, WebviewWindow};
use tokio_util::sync::CancellationToken;

#[tauri::command]
pub async fn handoff_snapshot_prepare(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Value, String> {
    crate::toolbox::require_active(&app, &window)?;
    let selected = crate::system::system_pick(
        app.clone(),
        window.clone(),
        true,
        Some("选择交接快照保存位置".into()),
    )
    .await?;
    if selected["canceled"] == true {
        return Ok(json!({"canceled":true}));
    }
    let parent = selected["path"]
        .as_str()
        .filter(|_| selected["ok"] == true)
        .ok_or_else(|| {
            selected["error"]
                .as_str()
                .unwrap_or("未取得交接快照保存位置")
                .to_owned()
        })?;
    let parent = Directory::open(Path::new(parent)).map_err(|error| error.to_string())?;
    let destination = parent.path().join(format!(
        "DustDesk-Handoff-{}-{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S"),
        uuid::Uuid::new_v4()
    ));
    let profile = app
        .state::<StorageState>()
        .root
        .parent()
        .ok_or("原生 profile 目录无效")?
        .to_path_buf();
    require_external_destination(&destination, &profile)?;
    let checkpoint =
        crate::draft_maintenance::drafts_prepare(app.clone(), window.clone(), Some(false)).await?;
    let request = checkpoint.request_id.clone();
    let result = async {
        let binding = draft_browser::binding(&app, &window)?;
        let (drafts, entries) = draft_export::collect_archive(&window, &checkpoint.workspace_fingerprint, &app.package_info().version.to_string()).await?;
        if draft_browser::binding(&app, &window)?.fingerprint != binding.fingerprint { return Err("交接快照的浏览器来源已变化".into()); }
        let gate = app.state::<crate::widgets::Service>().gate.clone(); let _guard = gate.lock().await;
        let handle = app.clone(); let window = window.clone();
        tokio::task::spawn_blocking(move || {
            let _parent = parent;
            let storage = handle.state::<StorageState>(); let slot = storage.store.lock().map_err(|error| error.to_string())?;
            let store = slot.as_ref().ok_or("工作区尚未读取")?; let service = handle.state::<crate::draft_maintenance::Service>();
            let active = || {
                if !crate::main_window::current(&handle, &window)
                    || service.ready_fingerprint(&checkpoint.request_id)? != checkpoint.workspace_fingerprint
                { return Err("交接快照维护检查点已失效".into()); }
                Ok(())
            };
            active()?; crate::platform::legacy_processes::require_stopped()?;
            let cancel = CancellationToken::new();
            let mut lan = Frozen::capture(&profile, &cancel, active)?;
            let provenance = store.record_draft_export(&drafts, &checkpoint.workspace_fingerprint, active)?;
            let status = store.prepare_handoff_snapshot(&destination, Inputs { request_id: &checkpoint.request_id,
                workspace_sha256: &checkpoint.workspace_fingerprint, drafts: drafts.as_bytes(), browser_binding: &binding.fingerprint, lan: &mut lan, source: None }, &cancel, active)?;
            lan.confirm(&cancel, active)?;
            crate::platform::legacy_processes::require_stopped()?; active()?;
            Ok::<_, String>(json!({"id":status.id,"path":destination,"entries":entries,"provenance":provenance,
                "scope":"same-profile-handoff","identityMode":"original-profile-only","externalTransferFiles":"original-locations-required",
                "productionReady":false,"migrationComplete":false}))
        }).await.map_err(|error| error.to_string())?
    }.await;
    let ended = crate::draft_maintenance::drafts_end(app, window, request).await;
    match result {
        Ok(mut result) => {
            if !matches!(ended, Ok(true)) {
                let error = ended.err().unwrap_or_else(|| "维护请求未确认释放".into());
                result["warning"] = json!(format!("交接快照已准备，但维护收尾需要核验：{error}"));
            }
            Ok(result)
        }
        Err(error) => Err(error),
    }
}
