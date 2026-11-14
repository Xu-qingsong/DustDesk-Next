use crate::{
    lifecycle::QuitState,
    system,
    workspace::{api::require_workspace, checked_path, resource_api::ResourceService},
};
use icu_collator::{options::CollatorOptions, Collator};
use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Manager, WebviewWindow};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct Entry {
    name: String,
    path: String,
    is_directory: bool,
}
pub struct DesktopService {
    root: PathBuf,
    grants: Mutex<HashSet<String>>,
    generation: AtomicU64,
    slot: Arc<tokio::sync::Semaphore>,
}
impl DesktopService {
    pub fn busy(&self) -> bool {
        self.slot.available_permits() == 0
    }
    pub(crate) fn root(&self) -> PathBuf {
        self.root.clone()
    }
    pub fn new(root: PathBuf) -> Result<Self, String> {
        system::path_key(root.to_str().ok_or("桌面路径无效")?)?;
        Ok(Self {
            root,
            grants: Mutex::default(),
            generation: AtomicU64::new(0),
            slot: Arc::new(tokio::sync::Semaphore::new(1)),
        })
    }
    pub fn granted(&self, key: &str) -> bool {
        self.grants.lock().is_ok_and(|grants| grants.contains(key))
    }
    pub fn release(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut grants) = self.grants.lock() {
            grants.clear();
        }
    }
    fn publish(&self, generation: u64, entries: &[Entry]) -> bool {
        let Ok(mut grants) = self.grants.lock() else {
            return false;
        };
        if self.generation.load(Ordering::SeqCst) != generation {
            return false;
        }
        *grants = entries
            .iter()
            .filter_map(|entry| system::path_key(&entry.path).ok())
            .collect();
        true
    }
}
fn list(root: &Path) -> Result<Vec<Entry>, String> {
    checked_path(root)?;
    let mut entries = Vec::new();
    for item in std::fs::read_dir(root).map_err(|error| error.to_string())? {
        let item = item.map_err(|error| error.to_string())?;
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| "桌面包含无法表示的文件名")?;
        if name.eq_ignore_ascii_case("desktop.ini") {
            continue;
        }
        let path = item
            .path()
            .into_os_string()
            .into_string()
            .map_err(|_| "桌面项目路径无效")?;
        let directory = item
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir();
        entries.push(Entry {
            name,
            path,
            is_directory: directory,
        });
    }
    let locale: icu_locale_core::Locale = "zh-CN"
        .parse()
        .map_err(|error| format!("排序区域无效：{error}"))?;
    let collator = Collator::try_new(locale.into(), CollatorOptions::default())
        .map_err(|error| error.to_string())?;
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| collator.compare(&left.name, &right.name))
    });
    checked_path(root)?;
    Ok(entries)
}
#[tauri::command]
pub async fn system_desktop_entries(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Vec<Entry>, String> {
    require_workspace(&window)?;
    if app.state::<QuitState>().require_interactive().is_err() {
        return Ok(Vec::new());
    }
    let service = app.state::<DesktopService>();
    let Ok(permit) = service.slot.clone().try_acquire_owned() else {
        return Ok(Vec::new());
    };
    let generation = service.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let root = service.root.clone();
    let slots = app.state::<ResourceService>().file_slots();
    let entries = tokio::time::timeout(Duration::from_secs(6), async move {
        let files = slots
            .acquire_owned()
            .await
            .map_err(|error| error.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            let _files = files;
            list(&root)
        })
        .await
        .map_err(|error| error.to_string())?
    })
    .await
    .ok()
    .and_then(Result::ok)
    .unwrap_or_default();
    if app.state::<QuitState>().require_interactive().is_err() {
        service.release();
        return Ok(Vec::new());
    }
    Ok(if service.publish(generation, &entries) {
        entries
    } else {
        Vec::new()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Root(PathBuf);
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn root() -> Root {
        let path = std::env::temp_dir().join(format!("dustdesk-desktop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Root(path)
    }
    #[test]
    fn lists_direct_children_only_excludes_desktop_ini_and_sorts_folders_first() {
        let root = root();
        for name in ["中.txt", "a.txt", "阿.txt", "Desktop.INI"] {
            std::fs::write(root.0.join(name), "content").unwrap();
        }
        for name in ["文件夹.exe", "资料.lnk"] {
            std::fs::create_dir(root.0.join(name)).unwrap();
            std::fs::write(root.0.join(name).join("not-listed.txt"), "nested").unwrap();
        }
        let entries = list(&root.0).unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["文件夹.exe", "资料.lnk", "阿.txt", "中.txt", "a.txt"]
        );
        assert!(entries[..2].iter().all(|entry| entry.is_directory));
        assert!(entries[2..].iter().all(|entry| !entry.is_directory));
        assert!(entries
            .iter()
            .all(|entry| Path::new(&entry.path).parent() == Some(root.0.as_path())));
    }
    #[test]
    fn scan_grants_replace_previous_exact_paths_and_stale_publications_cannot_resurrect_them() {
        let root = root();
        let service = DesktopService::new(root.0.clone()).unwrap();
        let first = Entry {
            name: "first".into(),
            path: root.0.join("first").display().to_string(),
            is_directory: true,
        };
        let next = Entry {
            name: "next".into(),
            path: root.0.join("next").display().to_string(),
            is_directory: false,
        };
        let key = system::path_key(&first.path).unwrap();
        assert!(service.publish(0, std::slice::from_ref(&first)));
        assert!(service.granted(&key));
        assert!(!service
            .granted(&system::path_key(root.0.join("first/child").to_str().unwrap()).unwrap()));
        assert!(service.publish(0, &[next]));
        assert!(!service.granted(&key));
        service.release();
        assert!(!service.publish(0, &[first]));
        assert!(service.grants.lock().unwrap().is_empty());
    }
    #[test]
    fn unavailable_or_file_roots_fail_without_mutating_the_filesystem() {
        let root = root();
        let file = root.0.join("file");
        std::fs::write(&file, "preserve").unwrap();
        assert!(list(&file).is_err());
        assert!(list(&root.0.join("missing")).is_err());
        assert_eq!(std::fs::read(file).unwrap(), b"preserve");
        assert!(DesktopService::new(PathBuf::from("relative")).is_err());
    }
}
