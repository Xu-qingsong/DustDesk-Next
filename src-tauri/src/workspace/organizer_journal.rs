use super::{
    checked_path,
    organizer_files::{self as files, Paths, Tree},
    read_json, replace_file, Snapshot, WorkspaceStore,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const LIMIT: u64 = 128 * 1024 * 1024;
struct MoveMode {
    force_copy: bool,
    restore_id: Option<String>,
    expected_root: Option<Tree>,
}

#[cfg(test)]
#[path = "organizer_tests.rs"]
mod tests;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Journal {
    version: u32,
    paths: Paths,
    source: PathBuf,
    target: PathBuf,
    source_tree: Tree,
    target_tree: Tree,
    stage: Option<PathBuf>,
    #[serde(default)]
    rollback: Option<Rollback>,
    #[serde(default)]
    desktop_position: Option<crate::desktop_positions::DesktopPosition>,
    after: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Rollback {
    stage: PathBuf,
    tree: Option<Tree>,
}
fn validate_stage(stage: &Path, destination: &Path) -> Result<(), String> {
    if stage.parent() != destination.parent()
        || !stage
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.strip_prefix(".dustdesk-move-")
                    .is_some_and(|id| Uuid::parse_str(id).is_ok())
            })
    {
        return Err("收纳暂存目录无效".into());
    }
    checked_path(stage)
}
fn overlaps(left: &Path, right: &Path) -> Result<bool, String> {
    let left = crate::system::path_key(left.to_str().ok_or("日志路径无效")?)?;
    let right = crate::system::path_key(right.to_str().ok_or("日志路径无效")?)?;
    Ok(Path::new(&left).starts_with(&right) || Path::new(&right).starts_with(&left))
}
impl Journal {
    fn restore_position(&self, path: &Path) {
        if super::organizer_positions::on_desktop(&self.paths.desktop, path) {
            if let Some(position) = &self.desktop_position {
                crate::desktop_positions::restore(&self.paths.desktop, path, position);
            }
        }
    }
    fn validate(&self, store: &WorkspaceStore) -> Result<(), String> {
        let desktop = store
            .organizer_desktop
            .as_ref()
            .ok_or("尚未绑定隔离桌面，拒绝恢复文件移动")?;
        if crate::system::path_key(desktop.to_str().ok_or("桌面路径无效")?)?
            != crate::system::path_key(self.paths.desktop.to_str().ok_or("日志桌面无效")?)?
        {
            return Err("恢复日志的桌面目录与当前配置不匹配".into());
        }
        if self.version != 1
            || crate::system::path_key(self.paths.organizer.to_str().ok_or("日志目录无效")?)?
                != crate::system::path_key(store.root.join("DesktopOrganizer").to_str().unwrap())?
        {
            return Err("收纳恢复日志的根目录不匹配".into());
        }
        self.paths.validate(&self.source)?;
        self.paths.validate(&self.target)?;
        if overlaps(&self.source, &self.target)? {
            return Err("收纳恢复日志的源与目标不能重叠".into());
        }
        super::validation::validate(&self.after)?;
        self.source_tree.validate()?;
        self.target_tree.validate()?;
        if self.source_tree.0.is_empty() || self.target_tree.0.is_empty() {
            return Err("收纳恢复日志缺少文件校验".into());
        }
        if !self.source_tree.same_content(&self.target_tree) {
            return Err("收纳恢复日志的副本内容不一致".into());
        }
        if let Some(stage) = &self.stage {
            validate_stage(stage, &self.target)?;
        }
        if let Some(rollback) = &self.rollback {
            validate_stage(&rollback.stage, &self.source)?;
            if let Some(tree) = &rollback.tree {
                tree.validate()?;
                if !self.target_tree.same_content(tree) {
                    return Err("反向补偿日志的副本内容不一致".into());
                }
            }
        }
        for stage in self
            .stage
            .iter()
            .chain(self.rollback.iter().map(|value| &value.stage))
        {
            if overlaps(stage, &self.source)? || overlaps(stage, &self.target)? {
                return Err("收纳暂存目录不能与原项目或目标重叠".into());
            }
        }
        if let (Some(stage), Some(rollback)) = (&self.stage, &self.rollback) {
            if overlaps(stage, &rollback.stage)? {
                return Err("收纳暂存与补偿暂存目录不能重叠".into());
            }
        }
        Ok(())
    }
}
impl WorkspaceStore {
    fn journal_path(&self) -> PathBuf {
        self.root.join("organizer.pending.json")
    }
    fn put_journal(&self, journal: &Journal, initial: bool) -> Result<(), String> {
        journal.validate(self)?;
        let bytes = serde_json::to_vec(journal).map_err(|error| error.to_string())?;
        if bytes.len() as u64 > LIMIT {
            return Err("收纳恢复日志超过大小限制".into());
        }
        let path = self.journal_path();
        checked_path(&path)?;
        if initial && files::exists(&path)? {
            return Err("已有收纳恢复日志需要处理".into());
        }
        let temp = self
            .root
            .join(format!("organizer.pending-{}.tmp", Uuid::new_v4()));
        let cleanup = super::TemporaryFile(temp.clone());
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        drop(file);
        replace_file(&temp, &path)?;
        drop(cleanup);
        Ok(())
    }
    fn journal(&self) -> Result<Option<Journal>, String> {
        let path = self.journal_path();
        checked_path(&path)?;
        let file = match std::fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.len() > LIMIT {
            return Err("收纳恢复日志无效或过大，已保留".into());
        }
        let mut bytes = Vec::new();
        file.take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > LIMIT {
            return Err("收纳恢复日志过大，已保留".into());
        }
        let journal: Journal = serde_json::from_slice(&bytes)
            .map_err(|error| format!("收纳恢复日志无法读取，已保留：{error}"))?;
        journal.validate(self)?;
        Ok(Some(journal))
    }
    fn clear_journal(&self, journal: &Journal) -> Result<(), String> {
        for stage in journal
            .stage
            .iter()
            .chain(journal.rollback.iter().map(|value| &value.stage))
        {
            let payload = stage.join("payload");
            if files::exists(&payload)? {
                return Err(format!("收纳暂存仍有待恢复数据：{}", payload.display()));
            }
            if files::exists(stage)? {
                fs::remove_dir(stage).map_err(|error| error.to_string())?;
            }
        }
        checked_path(&self.journal_path())?;
        fs::remove_file(self.journal_path()).map_err(|error| error.to_string())
    }
    fn begin_reverse_copy(&mut self, journal: &mut Journal) -> Result<(), String> {
        journal.rollback = Some(Rollback {
            stage: journal
                .source
                .parent()
                .ok_or("原位置目录无效")?
                .join(format!(".dustdesk-move-{}", Uuid::new_v4())),
            tree: None,
        });
        self.put_journal(journal, false)?;
        self.resume_reverse_copy(journal)
    }
    fn resume_reverse_copy(&mut self, journal: &mut Journal) -> Result<(), String> {
        let rollback = journal.rollback.as_ref().ok_or("缺少反向补偿日志")?;
        let stage = rollback.stage.clone();
        let payload = stage.join("payload");
        if rollback.tree.is_none() {
            if files::exists(&journal.source)? || files::exists(&payload)? {
                return Err(
                    "反向补偿的原位置被占用或暂存数据身份不明，完整目标与日志已保留".into(),
                );
            }
            if !journal.target_tree.matches(&journal.target) {
                return Err("反向补偿的目标已变化，拒绝继续复制".into());
            }
            if files::exists(&stage)? {
                if fs::read_dir(&stage)
                    .map_err(|error| error.to_string())?
                    .next()
                    .is_some()
                {
                    return Err("反向补偿暂存目录包含未知数据，已保留".into());
                }
            } else {
                fs::create_dir(&stage).map_err(|error| error.to_string())?;
            }
            let tree = files::copy(&journal.target, &payload, &journal.target_tree)?;
            journal.rollback.as_mut().unwrap().tree = Some(tree);
            self.put_journal(journal, false)?;
        }
        let restored = journal.rollback.as_ref().unwrap().tree.as_ref().unwrap();
        if !files::exists(&journal.source)? {
            if !restored.matches(&payload) || !journal.target_tree.matches(&journal.target) {
                return Err("反向补偿副本已变化，完整目标与暂存数据已保留".into());
            }
            journal.paths.validate(&journal.source)?;
            files::rename(&payload, &journal.source)
                .map_err(|error| format!("反向补偿无法发布原位置，完整副本已保留：{error}"))?;
        }
        if !restored.matches(&journal.source) || files::exists(&payload)? {
            return Err("反向补偿原位置身份不匹配，拒绝覆盖或清理完整副本".into());
        }
        self.refresh_compensated_restore(&journal.source, &journal.source_tree, restored)?;
        if files::exists(&journal.target)? {
            journal.target_tree.remove_exact(&journal.target)?;
        }
        journal.restore_position(&journal.source);
        self.clear_journal(journal)
    }
    pub(super) fn recover_organizer(&mut self) -> Result<(), String> {
        let Some(mut journal) = self.journal()? else {
            return Ok(());
        };
        let committed = match read_json(&self.path()) {
            Ok(Some(state)) => state == journal.after,
            _ => false,
        };
        if committed {
            if journal.rollback.is_some() {
                return Err("已提交状态与反向补偿日志冲突，文件与日志已保留".into());
            }
            if !files::exists(&journal.source)? && journal.target_tree.matches(&journal.target) {
                journal.restore_position(&journal.target);
                return self.clear_journal(&journal);
            }
            return Err("已提交的收纳文件发生变化，恢复日志已保留，请检查原位置与目标位置".into());
        }
        if journal.rollback.is_some() {
            return self.resume_reverse_copy(&mut journal).map_err(|error| {
                format!(
                    "收纳反向补偿未完成，文件与日志已保留：{} -> {}；{error}",
                    journal.target.display(),
                    journal.source.display()
                )
            });
        }
        let source = files::exists(&journal.source)?;
        let target = files::exists(&journal.target)?;
        if !source && target && journal.target_tree.matches(&journal.target) {
            match files::rename(&journal.target, &journal.source) {
                Ok(()) => {}
                Err(error) if files::different_volume(&error) => {
                    return self.begin_reverse_copy(&mut journal).map_err(|error| {
                        format!(
                            "收纳反向补偿未完成，文件与日志已保留：{} -> {}；{error}",
                            journal.target.display(),
                            journal.source.display()
                        )
                    });
                }
                Err(error) => {
                    return Err(format!(
                        "收纳回滚失败，完整项目保留在 {}：{error}",
                        journal.target.display()
                    ));
                }
            }
        } else if source && !target && journal.source_tree.matches(&journal.source) {
        } else if source
            && target
            && journal.source_tree.matches(&journal.source)
            && journal.target_tree.matches(&journal.target)
        {
            journal.target_tree.remove_exact(&journal.target)?;
        } else {
            return Err(format!(
                "收纳事务未能安全补偿，完整副本/原项目已保留：{} -> {}；请勿删除恢复日志",
                journal.source.display(),
                journal.target.display()
            ));
        }
        if let Some(stage) = &journal.stage {
            let payload = stage.join("payload");
            if files::exists(&payload)? {
                if !journal.source_tree.matches(&journal.source) {
                    return Err("源项目已变化，暂存副本已保留".into());
                }
                if !journal.target_tree.matches(&payload) {
                    return Err(format!(
                        "暂存数据无法确认身份，已保留：{}",
                        payload.display()
                    ));
                }
                journal.target_tree.remove_exact(&payload)?;
            }
        }
        journal.restore_position(&journal.source);
        self.clear_journal(&journal)
    }
    pub(super) fn organizer_transaction(
        &mut self,
        desktop: &Path,
        source: PathBuf,
        target: PathBuf,
        after: Value,
        force_copy: bool,
    ) -> Result<Snapshot, String> {
        self.organizer_move_transaction(
            desktop,
            source,
            target,
            after,
            MoveMode {
                force_copy,
                restore_id: None,
                expected_root: None,
            },
        )
    }
    pub(super) fn organizer_session_transaction(
        &mut self,
        desktop: &Path,
        source: PathBuf,
        target: PathBuf,
        after: Value,
        restore_id: String,
    ) -> Result<Snapshot, String> {
        self.organizer_move_transaction(
            desktop,
            source,
            target,
            after,
            MoveMode {
                force_copy: false,
                restore_id: Some(restore_id),
                expected_root: None,
            },
        )
    }
    pub(super) fn organizer_recollect_transaction(
        &mut self,
        desktop: &Path,
        source: PathBuf,
        target: PathBuf,
        after: Value,
        expected_root: Tree,
    ) -> Result<Snapshot, String> {
        self.organizer_move_transaction(
            desktop,
            source,
            target,
            after,
            MoveMode {
                force_copy: false,
                restore_id: None,
                expected_root: Some(expected_root),
            },
        )
    }
    fn organizer_move_transaction(
        &mut self,
        desktop: &Path,
        source: PathBuf,
        target: PathBuf,
        mut after: Value,
        mode: MoveMode,
    ) -> Result<Snapshot, String> {
        self.recover_organizer()?;
        if self
            .organizer_desktop
            .as_ref()
            .and_then(|path| path.to_str())
            .and_then(|path| crate::system::path_key(path).ok())
            != desktop
                .to_str()
                .and_then(|path| crate::system::path_key(path).ok())
        {
            return Err("移动桌面与当前配置不匹配".into());
        }
        let paths = Paths {
            desktop: desktop.into(),
            organizer: self.root.join("DesktopOrganizer"),
        };
        paths.validate(&source)?;
        paths.validate(&target)?;
        if files::exists(&target)? {
            return Err("目标位置已存在同名项目".into());
        }
        if !files::exists(&source)? {
            return Err("源文件或文件夹不存在".into());
        }
        fs::create_dir_all(target.parent().ok_or("目标目录无效")?)
            .map_err(|error| error.to_string())?;
        paths.validate(&target)?;
        let source_tree = Tree::read(&source)?;
        if mode
            .expected_root
            .as_ref()
            .is_some_and(|expected| !source_tree.same_root_identity(expected))
        {
            return Err("桌面项目身份已变化，拒绝重新收纳替换文件".into());
        }
        let desktop_position = super::organizer_positions::prepare(
            &mut after,
            desktop,
            &source,
            &target,
            mode.restore_id.is_some(),
            mode.expected_root.is_some(),
        )?;
        after["OrganizerTransactionId"] = serde_json::json!(Uuid::new_v4().to_string());
        let mut journal = Journal {
            version: 1,
            paths,
            source,
            target,
            source_tree: source_tree.clone(),
            target_tree: source_tree,
            stage: None,
            rollback: None,
            desktop_position,
            after: after.clone(),
        };
        self.put_journal(&journal, true)?;
        let moved = (|| {
            if !journal.source_tree.matches(&journal.source) {
                return Err("源项目已变化".into());
            }
            let result = if mode.force_copy {
                Err(std::io::Error::from_raw_os_error(17))
            } else {
                files::rename(&journal.source, &journal.target)
            };
            match result {
                Ok(()) => {}
                Err(error) if files::different_volume(&error) => {
                    let stage = journal
                        .target
                        .parent()
                        .unwrap()
                        .join(format!(".dustdesk-move-{}", Uuid::new_v4()));
                    journal.stage = Some(stage.clone());
                    self.put_journal(&journal, false)?;
                    fs::create_dir(&stage).map_err(|error| error.to_string())?;
                    journal.target_tree = files::copy(
                        &journal.source,
                        &stage.join("payload"),
                        &journal.source_tree,
                    )?;
                    self.put_journal(&journal, false)?;
                    journal.paths.validate(&journal.target)?;
                    files::rename(&stage.join("payload"), &journal.target)
                        .map_err(|error| error.to_string())?;
                    if !journal.target_tree.matches(&journal.target) {
                        return Err("目标复制校验失败，源项目已保留".into());
                    }
                    journal.source_tree.remove_exact(&journal.source)?;
                }
                Err(error) => return Err(error.to_string()),
            }
            if !journal.target_tree.matches(&journal.target) {
                return Err("目标文件校验失败，恢复日志已保留".into());
            }
            if let Some(id) = &mode.restore_id {
                super::organizer_session::seal_restore(&mut after, id, &journal.target_tree)?;
                journal.after = after.clone();
                self.put_journal(&journal, false)?;
            }
            self.write(&mut after, true)?;
            Ok(())
        })();
        match moved {
            Ok(()) => {
                journal.restore_position(&journal.target);
                if let Err(error) = self.clear_journal(&journal) {
                    eprintln!("收纳已提交，恢复日志暂未清理：{error}");
                }
                Ok(self.snapshot(after))
            }
            Err(error) => match self.recover_organizer() {
                Ok(()) => Err(error),
                Err(recovery) => Err(format!("{error}；{recovery}")),
            },
        }
    }
}
