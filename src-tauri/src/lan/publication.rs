//! Crash-recoverable, non-overwriting publication of verified receiver parts.
//! Calls are blocking and must be serialized with task cancellation/state edits.
use super::{
    files::{check_cancel, Directory, FileIdentity, OwnedFile},
    protocol::Entry,
    state_store::StateStore,
    storage::{Direction, State, Task},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io, path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

const JOURNAL: &str = "rustPublicationV1";
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Intent {
    index: usize,
    identity: FileIdentity,
    size: u64,
    hash: String,
    candidate: String,
    collision: usize,
    #[serde(default, skip_serializing_if = "is_false")]
    legacy_link: bool,
}
fn is_false(value: &bool) -> bool {
    !value
}

mod legacy;

fn task<'a>(state: &'a State, id: &str, root: &Directory) -> Result<&'a Task, String> {
    let task = state
        .tasks
        .iter()
        .find(|task| task.view.id == id)
        .ok_or("接收任务不存在")?;
    if task.view.direction != Direction::Receive
        || task.manifest.text.is_some()
        || task.view.directory.as_deref().map(Path::new) != Some(root.path())
    {
        return Err("接收目录尚未由本机授权".into());
    }
    let expected = root
        .path()
        .join(format!(".dustdesk-part-{}", task.manifest.id));
    if task.staging.as_deref().map(Path::new) != Some(expected.as_path()) {
        return Err("接收暂存目录不符合任务身份".into());
    }
    task.manifest.validate()?;
    Ok(task)
}
fn decode(task: &Task) -> Result<Option<Intent>, String> {
    task.extra
        .get(JOURNAL)
        .map(|value| serde_json::from_value(value.clone()).map_err(|_| "接收发布记录损坏".into()))
        .transpose()
}
fn candidate(entry: &Entry, collision: usize) -> Result<String, String> {
    if collision >= 10_000 {
        return Err("同名文件过多".into());
    }
    if collision == 0 {
        return Ok(entry.relative.clone());
    }
    let (parent, name) = entry
        .relative
        .rsplit_once('/')
        .unwrap_or(("", &entry.relative));
    // Node path.extname treats a single leading dot as a basename.
    let (base, extension) = match name.rfind('.') {
        Some(index) if index > 0 => (&name[..index], &name[index..]),
        _ => (name, ""),
    };
    let name = format!("{base}-{collision}{extension}");
    let value = if parent.is_empty() {
        name
    } else {
        format!("{parent}/{name}")
    };
    super::protocol::path_key(&value)?;
    Ok(value)
}
fn validate(intent: &Intent, task: &Task) -> Result<(), String> {
    let entry = task
        .manifest
        .entries
        .get(intent.index)
        .ok_or("发布文件序号无效")?;
    if intent.size != entry.size
        || intent.hash != entry.hash
        || intent.candidate != candidate(entry, intent.collision)?
        || intent.identity.index == 0
    {
        return Err("发布记录与原任务不一致".into());
    }
    if let Some(mapped) = task
        .files
        .as_ref()
        .and_then(|files| files.get(&intent.index.to_string()))
    {
        let expected = Path::new(task.view.directory.as_deref().ok_or("接收目录缺失")?)
            .join(intent.candidate.replace('/', "\\"));
        if !intent.legacy_link || mapped.as_str().map(Path::new) != Some(expected.as_path()) {
            return Err("发布记录与已完成文件映射冲突".into());
        }
    }
    Ok(())
}
fn save_intent(
    store: &mut StateStore,
    id: &str,
    intent: &Intent,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let mut state = store.state().clone();
    let task = state
        .tasks
        .iter_mut()
        .find(|task| task.view.id == id)
        .ok_or("接收任务不存在")?;
    task.extra.insert(
        JOURNAL.to_owned(),
        serde_json::to_value(intent).map_err(|_| "发布记录编码失败")?,
    );
    store.commit_cancellable(state, &[cancel])
}

/// The exclusive source handle is retained from verification through rename
/// and mapping commit. Dropping leaves a durable intent for explicit recovery.
pub struct Prepared {
    file: OwnedFile,
    root: Arc<Directory>,
    task_id: String,
    intent: Intent,
    renamed: bool,
}
impl Prepared {
    pub fn begin(
        store: &mut StateStore,
        id: &str,
        index: usize,
        root: Arc<Directory>,
        mut part: OwnedFile,
        cancel: &CancellationToken,
    ) -> Result<Self, String> {
        let task = task(store.state(), id, &root)?;
        if decode(task)?.is_some() {
            return Err("存在未恢复的文件发布记录".into());
        }
        let entry = task.manifest.entries.get(index).ok_or("接收文件序号无效")?;
        if task
            .files
            .as_ref()
            .is_some_and(|files| files.contains_key(&index.to_string()))
            || part.path()
                != Path::new(task.staging.as_deref().unwrap()).join(format!("{index}.part"))
        {
            return Err("待发布文件不属于此任务".into());
        }
        check_cancel(cancel).map_err(|e| e.to_string())?;
        part.sync().map_err(|e| e.to_string())?;
        if part.hash(entry.size, cancel).map_err(|e| e.to_string())? != entry.hash {
            return Err("文件校验失败，未发布接收文件".into());
        }
        let intent = Intent {
            index,
            identity: part.identity().clone(),
            size: entry.size,
            hash: entry.hash.clone(),
            candidate: candidate(entry, 0)?,
            collision: 0,
            legacy_link: false,
        };
        check_cancel(cancel).map_err(|e| e.to_string())?;
        save_intent(store, id, &intent, cancel)?;
        Ok(Self {
            file: part,
            root,
            task_id: id.to_owned(),
            intent,
            renamed: false,
        })
    }
    fn current(&self, store: &StateStore) -> Result<(), String> {
        let task = task(store.state(), &self.task_id, &self.root)?;
        validate(&self.intent, task)?;
        if decode(task)?.as_ref() != Some(&self.intent) {
            return Err("发布记录已变化".into());
        }
        Ok(())
    }
    pub fn rename(
        &mut self,
        store: &mut StateStore,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        self.current(store)?;
        if self.renamed {
            return Ok(());
        }
        loop {
            check_cancel(cancel).map_err(|e| e.to_string())?;
            let (parent, name) = self
                .root
                .parent_for(&self.intent.candidate, true)
                .map_err(|e| e.to_string())?;
            match self.file.publish(&parent, &name) {
                Ok(()) => {
                    self.renamed = true;
                    return Ok(());
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let task = task(store.state(), &self.task_id, &self.root)?;
                    let mut next = self.intent.clone();
                    next.collision += 1;
                    next.candidate = candidate(&task.manifest.entries[next.index], next.collision)?;
                    save_intent(store, &self.task_id, &next, cancel)?;
                    self.intent = next;
                }
                Err(error) => return Err(format!("发布接收文件失败：{error}")),
            }
        }
    }
    /// After a successful rename, finish this state commit even if cancellation
    /// arrived: published bytes are preserved and must be accounted for.
    pub fn commit(self, store: &mut StateStore) -> Result<String, String> {
        self.current(store)?;
        if !self.renamed {
            return Err("接收文件尚未发布".into());
        }
        let path = self
            .file
            .path()
            .to_str()
            .ok_or("发布路径无法编码")?
            .to_owned();
        let mut state = store.state().clone();
        let task = state
            .tasks
            .iter_mut()
            .find(|task| task.view.id == self.task_id)
            .unwrap();
        task.files
            .get_or_insert_default()
            .insert(self.intent.index.to_string(), Value::String(path.clone()));
        task.extra.remove(JOURNAL);
        store.commit(state)?;
        Ok(path)
    }
    pub fn finish(
        mut self,
        store: &mut StateStore,
        cancel: &CancellationToken,
    ) -> Result<String, String> {
        self.rename(store, cancel)?;
        self.commit(store)
    }
}

/// Call only after the native host has freshly authorized this saved directory.
/// Identical bytes at a different native file identity are never adopted.
pub fn recover(
    store: &mut StateStore,
    id: &str,
    root: Arc<Directory>,
    cancel: &CancellationToken,
) -> Result<Option<String>, String> {
    let recovered = recover_intent(store, id, root.clone(), cancel)?;
    Ok(legacy::recover_links(store, id, root, cancel)?.or(recovered))
}

fn recover_intent(
    store: &mut StateStore,
    id: &str,
    root: Arc<Directory>,
    cancel: &CancellationToken,
) -> Result<Option<String>, String> {
    let task = task(store.state(), id, &root)?;
    let Some(intent) = decode(task)? else {
        return Ok(None);
    };
    validate(&intent, task)?;
    if intent.legacy_link {
        return legacy::recover_intent(store, id, root, intent, cancel).map(Some);
    }
    let staging = root.child(&format!(".dustdesk-part-{}", task.manifest.id), false);
    let part = match staging {
        Ok(staging) => staging.part(&format!("{}.part", intent.index)),
        Err(error) => Err(error),
    };
    let (mut file, renamed) = match part {
        Ok(file) => (file, false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let (parent, name) = root
                .parent_for(&intent.candidate, false)
                .map_err(|e| e.to_string())?;
            (
                parent
                    .read(&name)
                    .map_err(|e| format!("无法恢复已发布文件：{e}"))?,
                true,
            )
        }
        Err(error) => return Err(format!("无法恢复暂存文件：{error}")),
    };
    if file.identity() != &intent.identity
        || file.hash(intent.size, cancel).map_err(|e| e.to_string())? != intent.hash
    {
        return Err("恢复文件身份或校验值不一致，保留原文件".into());
    }
    check_cancel(cancel).map_err(|e| e.to_string())?;
    Prepared {
        file,
        root,
        task_id: id.to_owned(),
        intent,
        renamed,
    }
    .finish(store, cancel)
    .map(Some)
}

#[cfg(test)]
#[path = "publication_tests.rs"]
mod tests;
