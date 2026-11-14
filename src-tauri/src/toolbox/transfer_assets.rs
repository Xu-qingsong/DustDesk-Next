//! Main-page scoped native path grants. File bytes never cross IPC; only the
//! LAN sender can resolve these IDs, and it revalidates sources before use.
use super::image_store::Asset;
use dustdesk_tauri::lan::{files::Directory, protocol::MAX_SAFE_INTEGER};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

struct Entry {
    path: PathBuf,
    _directory: Arc<Directory>,
}
#[derive(Default)]
struct State {
    epoch: u64,
    entries: HashMap<String, Entry>,
}
#[derive(Default)]
pub struct Service(Mutex<State>);
impl Service {
    pub fn epoch(&self) -> Result<u64, String> {
        Ok(self.0.lock().map_err(|error| error.to_string())?.epoch)
    }
    pub fn reset(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.epoch = state.epoch.wrapping_add(1);
            state.entries.clear();
        }
    }
    pub fn register(
        &self,
        epoch: u64,
        paths: Vec<PathBuf>,
        active: impl Fn() -> Result<(), String>,
    ) -> Result<Vec<Asset>, String> {
        if paths.len() > 10000 {
            return Err("一次最多导入 10000 项".into());
        }
        let mut entries = Vec::new();
        for path in paths {
            active()?;
            crate::system::path_key(path.to_str().ok_or("发送源路径无法编码")?)?;
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("不能发送整个盘符")?
                .to_owned();
            let parent = Directory::open(path.parent().ok_or("发送源路径无效")?)
                .map_err(|error| error.to_string())?;
            let info = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            let (directory, size) = if info.is_dir() {
                (
                    parent
                        .child(&name, false)
                        .map_err(|error| error.to_string())?,
                    0,
                )
            } else {
                let file = parent.read(&name).map_err(|error| error.to_string())?;
                (parent, file.size().map_err(|error| error.to_string())?)
            };
            if size > MAX_SAFE_INTEGER {
                return Err("发送源大小超出安全范围".into());
            }
            let asset = Asset {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                size: size as usize,
            };
            entries.push((
                asset,
                Entry {
                    path,
                    _directory: directory,
                },
            ));
        }
        let mut state = self.0.lock().map_err(|error| error.to_string())?;
        active()?;
        if state.epoch != epoch {
            return Err("文件授权页面已失效".into());
        }
        if state.entries.len() + entries.len() > 10000 {
            return Err("文件授权过多，请先移除已选项目".into());
        }
        let mut output = Vec::new();
        for (asset, entry) in entries {
            state.entries.insert(asset.id.clone(), entry);
            output.push(asset);
        }
        Ok(output)
    }
    pub fn paths(&self, epoch: u64, ids: &[String]) -> Result<Vec<PathBuf>, String> {
        let state = self.0.lock().map_err(|error| error.to_string())?;
        if state.epoch != epoch || ids.len() > 10000 {
            return Err("文件授权页面已失效或参数无效".into());
        }
        ids.iter()
            .map(|id| {
                state
                    .entries
                    .get(id)
                    .map(|entry| entry.path.clone())
                    .ok_or("文件授权已失效，请重新选择".into())
            })
            .collect()
    }
    pub fn release(&self, epoch: u64, ids: &[String]) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|error| error.to_string())?;
        if state.epoch != epoch || ids.len() > 10000 {
            return Err("文件授权页面已失效或参数无效".into());
        }
        for id in ids {
            state.entries.remove(id);
        }
        Ok(())
    }
}
