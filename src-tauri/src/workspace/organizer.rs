use super::{
    organizer_files::{self as files, Paths},
    resources, Snapshot, WorkspaceStore,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn key(path: &Path) -> Result<String, String> {
    crate::system::path_key(path.to_str().ok_or("路径无效")?)
}
fn same(left: &str, right: &Path) -> bool {
    key(Path::new(left)).ok() == key(right).ok()
}
fn category<'state>(state: &'state Value, id: &str) -> Result<&'state Value, String> {
    state["DesktopCategories"]
        .as_array()
        .unwrap()
        .iter()
        .find(|category| category["Id"] == id)
        .ok_or("分类不存在".into())
}
fn directory(root: &Path, category: &Value) -> PathBuf {
    root.join("DesktopOrganizer")
        .join(resources::safe_name(category["Name"].as_str().unwrap()))
}
fn remove_references(state: &mut Value, source: &Path) {
    for category in state["DesktopCategories"].as_array_mut().unwrap() {
        category["ItemPaths"]
            .as_array_mut()
            .unwrap()
            .retain(|path| !path.as_str().is_some_and(|path| same(path, source)));
    }
}
fn append_path(category: &mut Value, target: &Path) {
    let paths = category["ItemPaths"].as_array_mut().unwrap();
    if !paths
        .iter()
        .any(|path| path.as_str().is_some_and(|path| same(path, target)))
    {
        paths.push(json!(target.display().to_string()));
    }
}
impl WorkspaceStore {
    fn desktop(&self) -> Result<PathBuf, String> {
        self.organizer_desktop
            .clone()
            .ok_or("尚未配置隔离桌面".into())
    }
    pub fn organizer_move(
        &mut self,
        category_id: &str,
        source: &str,
    ) -> Result<(Snapshot, String), String> {
        let mut state = self.read()?;
        let desktop = self.desktop()?;
        let source = std::path::absolute(source).map_err(|error| error.to_string())?;
        key(&source)?;
        let destination = category(&state, category_id)?;
        let target =
            directory(&self.root, destination).join(source.file_name().ok_or("源路径无效")?);
        let previous = state["DesktopCategories"]
            .as_array()
            .unwrap()
            .iter()
            .find(|category| {
                category["ItemPaths"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|path| path.as_str().is_some_and(|path| same(path, &source)))
            })
            .cloned();
        if previous
            .as_ref()
            .is_some_and(|category| category["Id"] == category_id)
        {
            return Err("项目已在当前分类中".into());
        }
        if key(source.parent().ok_or("源路径无效")?)? != key(&desktop)? && previous.is_none() {
            return Err("只能移动桌面项目或已收纳项目".into());
        }
        let paths = Paths {
            desktop: desktop.clone(),
            organizer: self.root.join("DesktopOrganizer"),
        };
        paths.validate(&source)?;
        paths.validate(&target)?;
        let mut action = json!({"source":source.display().to_string(),"target":target.display().to_string(),"categoryId":category_id});
        if let Some(mut previous) = previous {
            action["sourceCategoryId"] = previous["Id"].clone();
            previous["ItemPaths"] = json!([]);
            action["sourceCategory"] = previous;
        }
        remove_references(&mut state, &source);
        let destination = state["DesktopCategories"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|category| category["Id"] == category_id)
            .unwrap();
        append_path(destination, &target);
        if !state["OrganizerUndoStack"].is_array() {
            state["OrganizerUndoStack"] = json!([]);
        }
        let actions = state["OrganizerUndoStack"].as_array_mut().unwrap();
        actions.push(action);
        if actions.len() > 100 {
            actions.drain(..actions.len() - 100);
        }
        let result_path = target.display().to_string();
        self.organizer_transaction(&desktop, source, target, state, false)
            .map(|snapshot| (snapshot, result_path))
    }
    pub fn organizer_restore(
        &mut self,
        category_id: &str,
        source: &str,
    ) -> Result<(Snapshot, String), String> {
        let mut state = self.read()?;
        let desktop = self.desktop()?;
        let source = std::path::absolute(source).map_err(|error| error.to_string())?;
        let source_key = key(&source)?;
        let directory = key(&directory(&self.root, category(&state, category_id)?))?;
        if !Path::new(&source_key)
            .strip_prefix(Path::new(&directory))
            .is_ok_and(|relative| relative.components().count() > 0)
        {
            return Err("只能恢复当前分类中的项目".into());
        }
        let target = desktop.join(source.file_name().ok_or("源路径无效")?);
        let category = state["DesktopCategories"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|category| category["Id"] == category_id)
            .unwrap();
        category["ItemPaths"]
            .as_array_mut()
            .unwrap()
            .retain(|path| !path.as_str().is_some_and(|path| same(path, &source)));
        let result_path = target.display().to_string();
        self.organizer_transaction(&desktop, source, target, state, false)
            .map(|snapshot| (snapshot, result_path))
    }
    pub fn organizer_undo(&mut self) -> Result<(Snapshot, String), String> {
        let mut state = self.read()?;
        let desktop = self.desktop()?;
        let mut actions = state["OrganizerUndoStack"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut recovered = Vec::new();
        for category in state["DesktopCategories"].as_array().unwrap() {
            let directory = directory(&self.root, category);
            super::checked_path(&directory)?;
            let entries = match std::fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.to_string()),
            };
            for entry in entries {
                let entry = entry.map_err(|error| error.to_string())?;
                let target = entry.path();
                if actions.iter().any(|action| {
                    action["target"]
                        .as_str()
                        .is_some_and(|path| same(path, &target))
                }) {
                    continue;
                }
                if entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".dustdesk-move-")
                {
                    continue;
                }
                recovered.push(json!({"source":desktop.join(entry.file_name()).display().to_string(),"target":target.display().to_string(),"categoryId":category["Id"]}));
            }
        }
        recovered.extend(actions);
        actions = recovered;
        let index = actions
            .iter()
            .rposition(|action| {
                action["target"]
                    .as_str()
                    .is_some_and(|path| files::exists(Path::new(path)).unwrap_or(false))
            })
            .ok_or("没有可撤销的收纳操作")?;
        let action = actions.remove(index);
        let source = PathBuf::from(action["target"].as_str().ok_or("撤销路径无效")?);
        let target = PathBuf::from(action["source"].as_str().ok_or("撤销路径无效")?);
        let paths = Paths {
            desktop: desktop.clone(),
            organizer: self.root.join("DesktopOrganizer"),
        };
        paths.validate(&source)?;
        paths.validate(&target)?;
        if !key(&source)?.starts_with(&key(&paths.organizer)?) {
            return Err("撤销路径无效".into());
        }
        let target_in_organizer = key(&target)?.starts_with(&key(&paths.organizer)?);
        remove_references(&mut state, &source);
        if target_in_organizer {
            let original = action["sourceCategory"].clone();
            let original_name = original["Name"]
                .as_str()
                .or_else(|| target.parent()?.file_name()?.to_str())
                .ok_or("撤销分类无效")?
                .to_owned();
            let name = resources::safe_name(&original_name);
            let categories = state["DesktopCategories"].as_array_mut().unwrap();
            let found = categories.iter().position(|category| {
                category["Id"] == action["sourceCategoryId"]
                    || resources::safe_name(category["Name"].as_str().unwrap())
                        .eq_ignore_ascii_case(&name)
            });
            let position=found.unwrap_or_else(||{let category=if original.is_object(){let mut category=original;category["ItemPaths"]=json!([]);category}else{json!({"Id":action["sourceCategoryId"].as_str().unwrap_or("").to_owned(),"Name":original_name,"IsCollapsed":false,"ItemPaths":[]})};categories.push(category);categories.len()-1});
            if categories[position]["Id"]
                .as_str()
                .is_none_or(str::is_empty)
            {
                categories[position]["Id"] = json!(uuid::Uuid::new_v4().to_string());
            }
            append_path(&mut categories[position], &target);
        }
        if actions.len() > 100 {
            actions.drain(..actions.len() - 100);
        }
        state["OrganizerUndoStack"] = json!(actions);
        let result_path = target.display().to_string();
        self.organizer_transaction(&desktop, source, target, state, false)
            .map(|snapshot| (snapshot, result_path))
    }
}
