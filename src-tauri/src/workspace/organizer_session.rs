use super::{
    checked_path,
    organizer_files::{self as files, Tree},
    read_json, Snapshot, WorkspaceStore,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
use uuid::Uuid;

fn key(path: &Path) -> Result<String, String> {
    crate::system::path_key(path.to_str().ok_or("收纳路径无法表示")?)
}
fn records(state: &Value) -> Result<Vec<Value>, String> {
    match state.get("OrganizerDesktopRestores") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items.clone()),
        _ => Err("桌面恢复记录格式无效，已保留".into()),
    }
}
fn record_paths(record: &Value) -> Result<(PathBuf, PathBuf, &str), String> {
    Ok((
        PathBuf::from(record["source"].as_str().ok_or("恢复记录源无效")?),
        PathBuf::from(record["target"].as_str().ok_or("恢复记录目标无效")?),
        record["categoryId"].as_str().ok_or("恢复记录分类无效")?,
    ))
}
fn tree(record: &Value) -> Result<Option<Tree>, String> {
    match record.get("NativeTree") {
        Some(value) => {
            let tree: Tree = serde_json::from_value(value.clone())
                .map_err(|error| format!("恢复记录身份无效：{error}"))?;
            tree.validate()?;
            Ok(Some(tree))
        }
        None => Ok(None),
    }
}
fn update_identity(record: &mut Value, tree: &Tree) -> Result<(), String> {
    let (inode, birth) = tree.legacy_identity()?;
    record["ino"] = json!(inode);
    record["birthtimeMs"] = json!(birth);
    record["NativeTree"] =
        serde_json::to_value(tree.root_only()?).map_err(|error| error.to_string())?;
    Ok(())
}
pub(super) fn seal_restore(state: &mut Value, id: &str, tree: &Tree) -> Result<(), String> {
    let record = state["OrganizerDesktopRestores"]
        .as_array_mut()
        .ok_or("缺少桌面恢复记录")?
        .iter_mut()
        .find(|record| record["NativeRestoreId"] == id)
        .ok_or("桌面恢复事务记录丢失")?;
    update_identity(record, tree)
}

impl WorkspaceStore {
    pub(super) fn finish_organizer_startup(&mut self, state: Value) -> Result<Value, String> {
        if self.organizer_session_ready
            || self.organizer_session_starting
            || self.organizer_desktop.is_none()
        {
            return Ok(state);
        }
        self.organizer_session_starting = true;
        let result = self.organizer_resume_session();
        self.organizer_session_starting = false;
        let snapshot = result?;
        self.organizer_session_ready = true;
        Ok(snapshot.map_or(state, |snapshot| snapshot.state))
    }
    fn valid_restore(&self, record: &Value, state: &Value) -> Result<bool, String> {
        let (source, target, category_id) = record_paths(record)?;
        let desktop = self.organizer_desktop.as_ref().ok_or("尚未配置隔离桌面")?;
        if key(target.parent().ok_or("恢复目标无效")?)? != key(desktop)? {
            return Err("恢复记录不属于当前桌面，已保留".into());
        }
        let Some(category) = state["DesktopCategories"]
            .as_array()
            .unwrap()
            .iter()
            .find(|category| category["Id"] == category_id)
        else {
            return Ok(false);
        };
        if source
            .parent()
            .and_then(Path::parent)
            .map(key)
            .transpose()?
            != Some(key(&self.root.join("DesktopOrganizer"))?)
        {
            return Ok(false);
        }
        checked_path(&source)?;
        checked_path(&target)?;
        Ok(category["ItemPaths"]
            .as_array()
            .unwrap()
            .iter()
            .any(|path| {
                path.as_str().and_then(|path| key(Path::new(path)).ok()) == key(&source).ok()
            }))
    }
    pub(super) fn organizer_resume_session(&mut self) -> Result<Option<Snapshot>, String> {
        let mut state = self.read()?;
        let pending = records(&state)?;
        if pending.is_empty() {
            return Ok(None);
        }
        let desktop = self.organizer_desktop.clone().ok_or("尚未配置隔离桌面")?;
        let mut latest = None;
        let mut failures = Vec::new();
        for record in pending {
            state = self.read()?;
            let result = (|| -> Result<Option<Snapshot>, String> {
                let (source, target, _) = record_paths(&record)?;
                let valid = self.valid_restore(&record, &state)?;
                let source_exists = valid && files::exists(&source)?;
                let target_exists = valid && files::exists(&target)?;
                let mut next_records = records(&state)?;
                let Some(index) = next_records.iter().position(|current| *current == record) else {
                    return Ok(None);
                };
                if !valid || source_exists || !target_exists {
                    next_records.remove(index);
                    state["OrganizerDesktopRestores"] = json!(next_records);
                    self.write(&mut state, true)?;
                    return Ok(Some(self.snapshot(state.clone())));
                }
                let actual = Tree::read(&target)?;
                let matches = if let Some(expected) = tree(&record)? {
                    expected.same_root_identity(&actual)
                } else {
                    let (inode, birth) = actual.legacy_identity()?;
                    record["ino"].as_f64() == Some(inode)
                        && record["birthtimeMs"]
                            .as_f64()
                            .is_some_and(|saved| birth == saved)
                };
                next_records.remove(index);
                state["OrganizerDesktopRestores"] = json!(next_records);
                if !matches {
                    self.write(&mut state, true)?;
                    return Ok(Some(self.snapshot(state.clone())));
                }
                self.organizer_recollect_transaction(
                    &desktop,
                    target,
                    source,
                    state.clone(),
                    actual,
                )
                .map(Some)
            })();
            match result {
                Ok(Some(snapshot)) => latest = Some(snapshot),
                Ok(None) => {}
                Err(error) => {
                    self.organizer_failure("启动恢复收纳", record["target"].as_str(), &error);
                    failures.push(error);
                }
            }
        }
        if !failures.is_empty() {
            return Err(format!(
                "部分桌面项目暂时无法重新收纳，已保留文件与记录；解除占用或检查权限后重试：{}",
                failures.join("；")
            ));
        }
        Ok(latest)
    }

    pub(super) fn organizer_has_items(&mut self) -> Result<bool, String> {
        let state = self.read()?;
        Ok(!self.session_sources(&state)?.is_empty())
    }
    fn session_sources(&self, state: &Value) -> Result<Vec<(PathBuf, String)>, String> {
        let mut found = Vec::new();
        let mut seen = HashSet::new();
        for category in state["DesktopCategories"].as_array().unwrap() {
            for source in category["ItemPaths"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
            {
                let source = PathBuf::from(source);
                if source
                    .parent()
                    .and_then(Path::parent)
                    .map(key)
                    .transpose()?
                    != Some(key(&self.root.join("DesktopOrganizer"))?)
                    || !files::exists(&source)?
                    || !seen.insert(key(&source)?)
                {
                    continue;
                }
                checked_path(&source)?;
                found.push((
                    source,
                    category["Id"].as_str().ok_or("分类无效")?.to_owned(),
                ));
            }
        }
        Ok(found)
    }
    pub(super) fn organizer_restore_session(&mut self) -> Result<Option<Snapshot>, String> {
        self.organizer_resume_session()?;
        let mut state = self.read()?;
        let sources = self.session_sources(&state)?;
        let desktop = self.organizer_desktop.clone().ok_or("尚未配置隔离桌面")?;
        checked_path(&desktop)?;
        let mut latest = None;
        for (source, category) in sources {
            state = self.read()?;
            let source_tree = Tree::read(&source)?;
            let name = source.file_name().ok_or("恢复源文件名无效")?;
            let mut target = desktop.join(name);
            let extension = if source.is_dir() {
                None
            } else {
                source
                    .extension()
                    .and_then(|value| value.to_str())
                    .filter(|value| !value.is_empty())
            };
            let stem = if extension.is_some() {
                source.file_stem().and_then(|value| value.to_str())
            } else {
                name.to_str()
            }
            .ok_or("恢复文件名无法表示")?;
            let mut suffix = 1u64;
            while files::exists(&target)? {
                let name = match extension {
                    Some(extension) => format!("{stem} ({suffix}).{extension}"),
                    None => format!("{stem} ({suffix})"),
                };
                target = desktop.join(name);
                suffix = suffix.checked_add(1).ok_or("同名项目过多")?;
            }
            let id = Uuid::new_v4().to_string();
            let mut record = json!({"source":source.to_str().unwrap(),"target":target.to_str().ok_or("恢复目标无法表示")?,"categoryId":category,"NativeRestoreId":id});
            update_identity(&mut record, &source_tree)?;
            let mut pending = records(&state)?;
            pending.push(record);
            state["OrganizerDesktopRestores"] = json!(pending);
            match self.organizer_session_transaction(&desktop, source.clone(), target, state, id) {
                Ok(snapshot) => latest = Some(snapshot),
                Err(error) => {
                    self.organizer_failure("退出恢复桌面", source.to_str(), &error);
                    return Err(format!("退出恢复桌面失败，已取消退出并保留数据：{error}"));
                }
            }
        }
        Ok(latest)
    }
    pub(super) fn refresh_compensated_restore(
        &mut self,
        path: &Path,
        expected: &Tree,
        restored: &Tree,
    ) -> Result<(), String> {
        let Some(mut state) = read_json(&self.path()).map_err(|_| "补偿后无法读取桌面恢复记录")?
        else {
            return Ok(());
        };
        let mut pending = records(&state)?;
        let mut changed = false;
        for record in &mut pending {
            if record["target"]
                .as_str()
                .and_then(|value| key(Path::new(value)).ok())
                != Some(key(path)?)
            {
                continue;
            }
            if let Some(tree) = tree(record)? {
                if tree.same_root_identity(restored) {
                    continue;
                }
                if !tree.same_root_identity(expected) {
                    return Err("补偿前的桌面身份与恢复记录不匹配，日志已保留".into());
                }
            } else {
                let (inode, birth) = expected.legacy_identity()?;
                if record["ino"].as_f64() != Some(inode)
                    || !record["birthtimeMs"]
                        .as_f64()
                        .is_some_and(|saved| birth == saved)
                {
                    return Err("补偿前的旧版桌面身份不匹配，日志已保留".into());
                }
            }
            update_identity(record, restored)?;
            changed = true;
        }
        if changed {
            state["OrganizerDesktopRestores"] = json!(pending);
            self.write(&mut state, true)?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "organizer_session_tests.rs"]
mod tests;
