//! Serial durable state owner. The receiver must retain its operation permit
//! inside every blocking job and serialize commits through this owner.
use super::{
    files::{Directory, OwnedFile},
    protocol::MAX_JSON_BYTES,
    storage::State,
};
use std::{io, path::Path, sync::Arc};

pub struct StateStore {
    root: Arc<Directory>,
    _lease: Arc<super::ownership::Lease>,
    migration: Option<Arc<super::migration::handover::Custody>>,
    _lock: OwnedFile,
    state: State,
}
impl StateStore {
    pub(crate) fn original_custody(
        &self,
    ) -> Result<Arc<super::migration::handover::Custody>, String> {
        self.confirm_migration()?;
        self.migration.clone().ok_or("不是原 LAN 服务存储".into())
    }
    /// Root must exist. Acquire the physical-directory lease before any file
    /// creation/read; the preparation Electron build uses the same protocol.
    /// The desktop host must still exclude unaware published old binaries.
    pub fn open(root: &Path) -> Result<Self, String> {
        let root = Directory::open(root).map_err(|e| e.to_string())?;
        let lease = Arc::new(super::ownership::Lease::acquire(&root)?);
        let lock = Self::lock(&root)?;
        let state = match root.read("state.json") {
            Ok(mut file) => State::parse(
                &file
                    .read_bounded(MAX_JSON_BYTES)
                    .map_err(|e| e.to_string())?,
            )?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => State::default(),
            Err(error) => return Err(error.to_string()),
        };
        Ok(Self {
            root,
            _lease: lease,
            migration: None,
            _lock: lock,
            state,
        })
    }
    pub(super) fn lock(root: &Arc<Directory>) -> Result<OwnedFile, String> {
        Ok(match root.create(".rust-owner.lock") {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                root.part(".rust-owner.lock").map_err(|e| e.to_string())?
            }
            Err(error) => return Err(error.to_string()),
        })
    }
    pub(super) fn adopt(
        root: Arc<Directory>,
        lease: Arc<super::ownership::Lease>,
        lock: OwnedFile,
        state: State,
        custody: Arc<super::migration::handover::Custody>,
    ) -> Self {
        Self {
            root,
            _lease: lease,
            migration: Some(custody),
            _lock: lock,
            state,
        }
    }
    pub fn state(&self) -> &State {
        &self.state
    }
    /// Same-process service suspension retains text in RAM only. Never load
    /// these from workspace backup or renderer input, or write them to disk.
    pub fn restore_transient(&mut self, tasks: Vec<super::storage::Task>) -> Result<(), String> {
        let mut ids: std::collections::HashSet<_> = self
            .state
            .tasks
            .iter()
            .map(|task| task.view.id.clone())
            .collect();
        for task in &tasks {
            task.validate()?;
            if task.manifest.text.is_none() || !ids.insert(task.view.id.clone()) {
                return Err("临时文本任务无效或重复".into());
            }
        }
        for mut task in tasks {
            task.restart();
            self.state.tasks.push(task);
        }
        Ok(())
    }
    pub(super) fn take_transient(&mut self) -> Vec<super::storage::Task> {
        let (texts, tasks) = std::mem::take(&mut self.state.tasks)
            .into_iter()
            .partition(|task| task.manifest.text.is_some());
        self.state.tasks = tasks;
        texts
    }
    /// Explicit native initialization on a supervised blocking job. Requires
    /// this profile's exclusive Rust owner; never creates the root directory.
    /// The host must separately exclude unaware old binaries before takeover.
    pub fn ensure_identity(
        &self,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<super::storage::Identity, String> {
        self.confirm_migration()?;
        if self.migration.is_some() {
            return Err("已移交原设备身份；禁止重新初始化身份".into());
        }
        super::identity::ensure(&self.root, cancel)
    }
    pub(super) fn require_identity(
        &self,
        expected: &super::storage::Identity,
    ) -> Result<(), String> {
        if let Some(owner) = &self.migration {
            return owner.require_identity(expected);
        }
        let actual = super::identity::load(&self.root)?.ok_or("设备身份缺失")?;
        if actual.id != expected.id || actual.fingerprint != expected.fingerprint {
            return Err("设备身份与局域网状态所有者不一致".into());
        }
        Ok(())
    }
    /// Updates live memory only after the atomic file replacement succeeds.
    /// Callers must keep cancellation admission/commit serialized themselves.
    pub fn commit(&mut self, candidate: State) -> Result<(), String> {
        self.commit_cancellable(candidate, &[])
    }
    pub(super) fn task_view_mut(&mut self, id: &str) -> Option<&mut super::storage::TransferView> {
        self.state
            .tasks
            .iter_mut()
            .find(|task| task.view.id == id)
            .map(|task| &mut task.view)
    }
    pub(super) fn commit_cancellable(
        &mut self,
        candidate: State,
        cancellations: &[&tokio_util::sync::CancellationToken],
    ) -> Result<(), String> {
        let check = || {
            self.confirm_migration()?;
            cancellations
                .iter()
                .try_for_each(|cancel| super::files::check_cancel(cancel))
                .map_err(|e| e.to_string())
        };
        check()?;
        let bytes = candidate.encode_for_restart()?;
        let name = format!(".state-{}.tmp", uuid::Uuid::new_v4());
        let mut temporary = self.root.create(&name).map_err(|e| e.to_string())?;
        let result = (|| {
            temporary.write_all(&bytes)?;
            temporary.sync()?;
            // Refuse a linked/reparse/irregular old state without touching it.
            match self.root.read("state.json") {
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            check().map_err(io::Error::other)?;
            temporary.replace(&self.root, "state.json")
        })();
        if let Err(error) = result {
            let _ = temporary.remove(); // Exact temp handle, never path deletion.
            return Err(format!("保存局域网状态失败：{error}"));
        }
        self.state = candidate;
        Ok(())
    }
    fn confirm_migration(&self) -> Result<(), String> {
        self.migration
            .as_ref()
            .map_or(Ok(()), |owner| owner.confirm_writable())
    }
}
