use super::{commands::StorageState, draft_transaction::Status};
use serde::Serialize;
use std::path::Path;
use tauri::{Manager, WebviewWindow};

#[derive(Debug, Serialize)]
pub struct SelectedArchive {
    name: String,
    serialized: String,
}

fn read_selected(path: &Path) -> Result<SelectedArchive, String> {
    let bytes = super::draft_lineage::read_bounded(path, 64 * 1024 * 1024)
        .map_err(|error| format!("无法读取草稿迁移包：{error}"))?;
    if bytes.is_empty() {
        return Err("草稿迁移包为空".into());
    }
    let serialized = String::from_utf8(bytes).map_err(|_| "草稿迁移包不是有效 UTF-8 文本")?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("迁移包文件名无效")?
        .to_string();
    Ok(SelectedArchive { name, serialized })
}

#[tauri::command]
pub async fn drafts_pick(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Option<SelectedArchive>, String> {
    super::api::require_workspace(&window)?;
    app.state::<crate::draft_startup::Service>()
        .require_ready()?;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    let selected = crate::system::pick_drafts(app.clone(), window.clone()).await?;
    if selected["canceled"] == true {
        return Ok(None);
    }
    if selected["ok"] != true {
        return Err(selected["error"]
            .as_str()
            .unwrap_or("选择草稿迁移包失败")
            .into());
    }
    let path = selected["path"]
        .as_str()
        .ok_or("原生文件选择结果无效")?
        .to_owned();
    let slots = app
        .state::<super::resource_api::ResourceService>()
        .file_slots();
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), async move {
        let permit = slots
            .acquire_owned()
            .await
            .map_err(|error| error.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            read_selected(Path::new(&path))
        })
        .await
        .map_err(|error| error.to_string())?
    })
    .await
    .map_err(|_| "读取草稿包超时，请检查磁盘连接后重试".to_string())??;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效，未交付迁移包".into());
    }
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()?;
    app.state::<crate::draft_startup::Service>()
        .require_ready()?;
    Ok(Some(result))
}

#[tauri::command]
pub async fn drafts_import_state(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Option<Status>, String> {
    super::api::require_workspace(&window)?;
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let storage = app.state::<StorageState>();
        let slot = storage.store.lock().map_err(|error| error.to_string())?;
        slot.as_ref()
            .ok_or("工作区尚未读取")?
            .draft_recovery_status()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};
    struct Root(PathBuf);
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn root() -> Root {
        let root = Root(
            std::env::temp_dir().join(format!("dustdesk-rust-import-{}", uuid::Uuid::new_v4())),
        );
        fs::create_dir_all(&root.0).unwrap();
        root
    }
    #[test]
    fn selected_file_returns_only_the_name_and_exact_utf8_without_normalizing() {
        let root = root();
        let path = root.0.join("迁移包.json");
        let raw = "{\r\n  \"草稿\": \"原文🪶\"\r\n}";
        fs::write(&path, raw).unwrap();
        let selected = read_selected(&path).unwrap();
        assert_eq!(selected.serialized, raw);
        assert_eq!(selected.name, "迁移包.json");
    }
    #[test]
    fn empty_invalid_utf8_and_directory_inputs_do_not_become_archives() {
        let root = root();
        let path = root.0.join("invalid.json");
        assert!(read_selected(&root.0).is_err());
        fs::write(&path, []).unwrap();
        assert!(read_selected(&path).is_err());
        fs::write(&path, [0xff, 0xfe]).unwrap();
        assert!(read_selected(&path).is_err());
    }
    #[test]
    fn oversized_and_hardlinked_files_are_rejected_before_import() {
        let root = root();
        let path = root.0.join("large.json");
        let file = fs::File::create(&path).unwrap();
        file.set_len(64 * 1024 * 1024 + 1).unwrap();
        drop(file);
        assert!(read_selected(&path).is_err());
        fs::write(&path, "{}").unwrap();
        let alias = root.0.join("alias.json");
        fs::hard_link(&path, &alias).unwrap();
        assert!(read_selected(&alias).is_err());
    }
}
