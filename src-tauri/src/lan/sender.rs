//! Send orchestration uses the receiver's single durable state owner. File
//! readers are separately owned jobs; cancel/stop joins them and HTTP drivers.
use super::{
    files::{check_cancel, OwnedFile},
    protocol::{Device, Manifest, OfferReply, MAX_TEXT_BYTES},
    receiver::{Decision, Receiver},
    sources,
    state_store::StateStore,
    storage::{Direction, Identity, Status, Task, TransferView},
    transport::{Client, Limits},
};
use bytes::Bytes;
use futures_util::stream;
use http_body_util::{BodyExt, StreamBody};
use hyper::body::Frame;
use serde_json::{json, Map};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
};
use tokio::{sync::mpsc, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub(super) enum StateCommand {
    New {
        peer: String,
        paths: Vec<String>,
        text: Option<String>,
    },
    Get {
        id: String,
    },
    Prepared {
        id: String,
        manifest: Manifest,
    },
    Update {
        id: String,
        status: Status,
        done: u64,
        error: Option<String>,
        peer: Option<Device>,
    },
    Clear {
        id: String,
    },
}
pub(super) type Rpc = Arc<dyn Fn(StateCommand, CancellationToken) -> Decision<Task> + Send + Sync>;
pub(super) type Progress = Arc<RwLock<HashMap<String, (u64, f64)>>>;
#[derive(Clone)]
pub(super) struct Io {
    pub rpc: Rpc,
    pub identity: Arc<Identity>,
    pub name: String,
    pub port: u16,
    pub stop: CancellationToken,
    pub progress: Progress,
    pub failures: Arc<RwLock<HashMap<String, String>>>,
}
pub(super) struct Context {
    pub io: Io,
    pub runtime: Arc<Runtime>,
}
#[derive(Default)]
pub(super) struct Runtime {
    gate: tokio::sync::Mutex<()>,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    pub failures: Arc<RwLock<HashMap<String, String>>>,
}
struct Job {
    cancel: CancellationToken,
    completion: tokio::sync::Mutex<Completion>,
    token: Arc<Mutex<Option<String>>>,
    peer: Arc<Mutex<Device>>,
    done: Arc<AtomicU64>,
}
struct Completion {
    handle: Option<JoinHandle<Result<(), String>>>,
    result: Option<Result<(), String>>,
}
impl Job {
    async fn is_finished(&self) -> bool {
        let completion = self.completion.lock().await;
        completion
            .handle
            .as_ref()
            .is_none_or(JoinHandle::is_finished)
    }
    /// Await the handle in place. Dropping a control future must leave the job
    /// registered so a later control or service stop can still join its I/O.
    async fn join(&self) -> Result<(), String> {
        let mut completion = self.completion.lock().await;
        if let Some(handle) = completion.handle.as_mut() {
            let result = handle
                .await
                .map_err(|_| "发送工作任务未正常退出".to_owned())
                .and_then(|result| result);
            completion.handle = None;
            completion.result = Some(result);
        }
        completion.result.clone().unwrap_or(Ok(()))
    }
}
struct ProgressGuard {
    id: String,
    progress: Progress,
}
impl Drop for ProgressGuard {
    fn drop(&mut self) {
        self.progress.write().unwrap().remove(&self.id);
    }
}

impl Receiver {
    pub async fn send_local(
        &self,
        peer: String,
        paths: Vec<PathBuf>,
        text: Option<String>,
    ) -> Result<String, String> {
        let context = self.sender_context();
        let _gate = context.runtime.gate.lock().await;
        let cancel = context.io.stop.child_token();
        let paths = paths
            .into_iter()
            .map(|path| path.to_str().map(str::to_owned).ok_or("发送源路径无法编码"))
            .collect::<Result<Vec<_>, _>>()?;
        let task =
            (context.io.rpc)(StateCommand::New { peer, paths, text }, cancel.clone()).await?;
        let id = task.view.id.clone();
        context.spawn(task, cancel);
        Ok(id)
    }
    pub async fn resume_send(&self, id: &str) -> Result<(), String> {
        let context = self.sender_context();
        let _gate = context.runtime.gate.lock().await;
        let previous = context.runtime.jobs.lock().unwrap().get(id).cloned();
        let mut unsettled_failure = false;
        if let Some(job) = previous {
            if !job.is_finished().await {
                return Err("任务正在处理".into());
            }
            unsettled_failure = job.join().await.is_err();
        }
        let cancel = context.io.stop.child_token();
        let task =
            (context.io.rpc)(StateCommand::Get { id: id.to_owned() }, cancel.clone()).await?;
        if task.view.direction != Direction::Send
            || !(matches!(task.view.status, Status::Paused | Status::Failed)
                || (unsettled_failure
                    && !matches!(task.view.status, Status::Completed | Status::Canceled)))
        {
            return Err("发送任务不能继续".into());
        }
        context.spawn(task, cancel);
        Ok(())
    }
    /// Local state always settles after the running job is joined. A returned
    /// remote error means its pause/cancel acknowledgement was not received.
    pub async fn control_send(&self, id: &str, action: &str) -> Result<Option<String>, String> {
        if !matches!(action, "pause" | "cancel" | "clear") {
            return Err("任务操作无效".into());
        }
        let context = self.sender_context();
        let _gate = context.runtime.gate.lock().await;
        check_cancel(&context.io.stop).map_err(|e| e.to_string())?;
        let job = context.runtime.jobs.lock().unwrap().get(id).cloned();
        let mut remote = None;
        let mut done = None;
        if let Some(job) = job {
            job.cancel.cancel();
            // An earlier failed checkpoint must not prevent this explicit
            // action from committing once storage becomes writable again.
            let _ = job.join().await;
            done = Some(job.done.load(Ordering::SeqCst));
            let token = job.token.lock().unwrap().clone();
            if let Some(token) = token {
                remote = Some((job.peer.lock().unwrap().clone(), token));
            }
        }
        let cancel = context.io.stop.child_token();
        let task =
            (context.io.rpc)(StateCommand::Get { id: id.to_owned() }, cancel.clone()).await?;
        if task.view.direction != Direction::Send {
            return Err("该任务不是发送任务".into());
        }
        if action == "pause" && matches!(task.view.status, Status::Completed | Status::Canceled) {
            return Ok(None);
        }
        (context.io.rpc)(
            StateCommand::Update {
                id: id.to_owned(),
                status: if action == "pause" {
                    Status::Paused
                } else {
                    Status::Canceled
                },
                done: done.unwrap_or(task.view.done).min(task.view.total),
                error: None,
                peer: None,
            },
            cancel.clone(),
        )
        .await?;
        let mut remote_error = None;
        if let Some((peer, token)) = remote {
            let request_cancel = CancellationToken::new();
            let client = Client::new(context.io.identity.clone(), Limits::default())?;
            let route = format!(
                "/{}?id={}&token={token}",
                if action == "pause" { "pause" } else { "cancel" },
                task.manifest.id
            );
            let empty = json!({});
            let request = client.json(&peer, &route, Some(&empty), &request_cancel);
            tokio::pin!(request);
            let result = tokio::select! { value = &mut request => value, _ = tokio::time::sleep(std::time::Duration::from_secs(3)) => {
                request_cancel.cancel(); request.await
            }};
            remote_error = match result {
                Ok(value) if value["ok"] == true => None,
                Ok(_) => Some("对方未确认任务操作".into()),
                Err(error) => Some(error),
            };
        }
        if action == "clear" {
            (context.io.rpc)(StateCommand::Clear { id: id.to_owned() }, cancel).await?;
        }
        context.io.failures.write().unwrap().remove(id);
        if remote_error.is_none() || action == "clear" {
            context.runtime.jobs.lock().unwrap().remove(id);
        }
        Ok(remote_error)
    }
}
impl Context {
    fn spawn(&self, task: Task, cancel: CancellationToken) {
        self.io.failures.write().unwrap().remove(&task.view.id);
        let token = Arc::new(Mutex::new(None));
        let peer = Arc::new(Mutex::new(task.peer.clone()));
        let io = self.io.clone();
        let job_cancel = cancel.clone();
        let job_token = token.clone();
        let job_peer = peer.clone();
        let task_id = task.view.id.clone();
        let id = task_id.clone();
        let done = Arc::new(AtomicU64::new(task.view.done));
        let job_done = done.clone();
        let handle = tokio::spawn(async move {
            let _progress = ProgressGuard {
                id: task.view.id.clone(),
                progress: io.progress.clone(),
            };
            let result = io
                .run(task, &job_cancel, &job_token, &job_peer, &job_done)
                .await;
            if let Err(error) = result {
                if !job_cancel.is_cancelled() && !io.stop.is_cancelled() {
                    let saved = async {
                        let current =
                            (io.rpc)(StateCommand::Get { id: id.clone() }, job_cancel.clone())
                                .await?;
                        (io.rpc)(
                            StateCommand::Update {
                                id: id.clone(),
                                status: Status::Failed,
                                done: job_done.load(Ordering::SeqCst).min(current.view.total),
                                error: Some(error.clone()),
                                peer: None,
                            },
                            job_cancel.clone(),
                        )
                        .await
                    }
                    .await;
                    if let Err(storage_error) = saved {
                        // Durable state remains unchanged. Keep the failure
                        // visible and retryable while this process is alive.
                        if !job_cancel.is_cancelled() && !io.stop.is_cancelled() {
                            io.failures
                                .write()
                                .unwrap()
                                .insert(id, format!("{error}；{storage_error}"));
                            return Err(storage_error);
                        }
                    }
                }
            }
            Ok(())
        });
        self.runtime.jobs.lock().unwrap().insert(
            task_id,
            Arc::new(Job {
                cancel,
                completion: tokio::sync::Mutex::new(Completion {
                    handle: Some(handle),
                    result: None,
                }),
                token,
                peer,
                done,
            }),
        );
    }
}

pub(super) async fn stop(runtime: &Runtime) -> Result<(), String> {
    let _gate = runtime.gate.lock().await;
    let jobs = runtime
        .jobs
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for job in &jobs {
        job.cancel.cancel();
    }
    let mut errors = Vec::new();
    for job in jobs {
        match job.join().await {
            Ok(()) => {}
            Err(error) => errors.push(error),
        }
    }
    runtime.jobs.lock().unwrap().clear();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("发送任务收尾失败：{}", errors.join("；")))
    }
}

impl Io {
    async fn update(
        &self,
        task: &Task,
        status: Status,
        done: u64,
        cancel: &CancellationToken,
        peer: Option<Device>,
    ) -> Result<Task, String> {
        (self.rpc)(
            StateCommand::Update {
                id: task.view.id.clone(),
                status,
                done,
                error: None,
                peer,
            },
            cancel.clone(),
        )
        .await
    }
    async fn run(
        &self,
        mut task: Task,
        cancel: &CancellationToken,
        token: &Mutex<Option<String>>,
        remote: &Mutex<Device>,
        done_hint: &Arc<AtomicU64>,
    ) -> Result<(), String> {
        task = self
            .update(
                &task,
                Status::Preparing,
                task.view.done,
                cancel,
                Some(task.peer.clone()),
            )
            .await?;
        if task.prepared != Some(true) && task.manifest.text.is_none() {
            let id = task.manifest.id.clone();
            let name = task.view.name.clone();
            let paths = task
                .sources
                .clone()
                .unwrap_or_default()
                .into_iter()
                .map(PathBuf::from)
                .collect::<Vec<_>>();
            let prepare_cancel = cancel.clone();
            let manifest = tokio::task::spawn_blocking(move || {
                sources::prepare(id, name, &paths, &prepare_cancel)
            })
            .await
            .map_err(|_| "发送源准备工作线程异常")??;
            task = (self.rpc)(
                StateCommand::Prepared {
                    id: task.view.id.clone(),
                    manifest,
                },
                cancel.clone(),
            )
            .await?;
        }
        let client = Client::new(self.identity.clone(), Limits::default())?;
        let peer = client.hello(&task.peer, cancel).await?;
        let pair = client
            .json(
                &peer,
                "/pair",
                Some(&json!({"id":self.identity.id,"name":self.name,"port":self.port})),
                cancel,
            )
            .await?;
        if pair["ok"] != true {
            return Err("对方未确认配对".into());
        }
        *remote.lock().unwrap() = peer.clone();
        for entry in &task.manifest.entries {
            let entry = entry.clone();
            let check = cancel.clone();
            tokio::task::spawn_blocking(move || sources::open(&entry, &check).map(drop))
                .await
                .map_err(|_| "发送源复核工作线程异常")??;
        }
        task = self
            .update(
                &task,
                Status::Waiting,
                task.view.done,
                cancel,
                Some(peer.clone()),
            )
            .await?;
        let response = client
            .json(
                &peer,
                "/offer",
                Some(&serde_json::to_value(task.manifest.public()).map_err(|_| "清单无法编码")?),
                cancel,
            )
            .await?;
        let offer: OfferReply = serde_json::from_value(response).map_err(|_| "续传回复无效")?;
        offer.validate(&task.manifest)?;
        *token.lock().unwrap() = Some(offer.token.clone());
        if task.manifest.text.is_some() {
            self.update(&task, Status::Completed, task.view.total, cancel, None)
                .await?;
            return Ok(());
        }
        let mut done = 0_u64;
        done_hint.store(0, Ordering::SeqCst);
        for (index, (entry, offset)) in task.manifest.entries.iter().zip(&offer.offsets).enumerate()
        {
            let source = entry.clone();
            let prefix = offset.clone();
            let check = cancel.clone();
            let file = tokio::task::spawn_blocking(move || {
                let mut file = sources::open(&source, &check)?;
                if file
                    .hash_prefix(prefix.size, &check)
                    .map_err(|e| e.to_string())?
                    != prefix.hash
                {
                    return Err("续传临时文件校验失败，请取消并重新发送".to_owned());
                }
                Ok(file)
            })
            .await
            .map_err(|_| "续传校验工作线程异常")??;
            done += offset.size;
            done_hint.store(done, Ordering::SeqCst);
            if offset.complete {
                continue;
            }
            self.update(&task, Status::Transferring, done, cancel, None)
                .await?;
            let (send, receive) = mpsc::channel(2);
            let file_cancel = cancel.child_token();
            let read_cancel = file_cancel.clone();
            let expected = entry.clone();
            let prefix = offset.size;
            let progress = self.progress.clone();
            let id = task.view.id.clone();
            let base = done;
            let hint = done_hint.clone();
            let reader = tokio::task::spawn_blocking(move || {
                stream_file(
                    file,
                    &expected.hash,
                    expected.size,
                    prefix,
                    send,
                    &read_cancel,
                    |sent, speed| {
                        hint.store(base + sent, Ordering::SeqCst);
                        progress
                            .write()
                            .unwrap()
                            .insert(id.clone(), (base + sent, speed));
                    },
                )
            });
            let frames = stream::unfold(receive, |mut receive| async move {
                receive
                    .recv()
                    .await
                    .map(|bytes| (Ok::<_, io::Error>(Frame::data(bytes)), receive))
            });
            let body = StreamBody::new(frames).boxed_unsync();
            let route = format!(
                "/file?id={}&token={}&index={index}&offset={}",
                task.manifest.id, offer.token, offset.size
            );
            let result = client.upload(&peer, &route, body, cancel).await;
            if result.is_err() {
                file_cancel.cancel();
            }
            let read = reader.await.map_err(|_| "发送流工作线程异常")?;
            result?;
            read?;
            done += entry.size - offset.size;
            done_hint.store(done, Ordering::SeqCst);
            self.progress.write().unwrap().remove(&task.view.id);
            self.update(&task, Status::Transferring, done, cancel, None)
                .await?;
        }
        let completed = client
            .json(
                &peer,
                &format!("/complete?id={}&token={}", task.manifest.id, offer.token),
                Some(&json!({})),
                cancel,
            )
            .await?;
        if completed["ok"] != true {
            return Err("对方未确认传输完成".into());
        }
        self.update(&task, Status::Completed, task.view.total, cancel, None)
            .await?;
        Ok(())
    }
}

fn stream_file(
    mut file: OwnedFile,
    expected: &str,
    size: u64,
    offset: u64,
    send: mpsc::Sender<Bytes>,
    cancel: &CancellationToken,
    progress: impl Fn(u64, f64),
) -> Result<(), String> {
    file.seek(0).map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();
    let mut read = 0_u64;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    while read < size {
        let length = ((size - read).min(buffer.len() as u64)) as usize;
        let count = file
            .read_chunk(&mut buffer[..length], cancel)
            .map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("发送源在传输期间被截断".into());
        }
        hash.update(&buffer[..count]);
        let begin = offset.saturating_sub(read).min(count as u64) as usize;
        read += count as u64;
        if begin < count {
            send.blocking_send(Bytes::copy_from_slice(&buffer[begin..count]))
                .map_err(|_| "发送流已关闭")?;
            progress(
                read - offset,
                (read - offset) as f64 / started.elapsed().as_secs_f64().max(0.001),
            );
        }
    }
    check_cancel(cancel).map_err(|e| e.to_string())?;
    if format!("{:x}", hash.finalize()) != expected
        || file.size().map_err(|e| e.to_string())? != size
    {
        return Err("发送源在传输期间变化".into());
    }
    Ok(())
}

pub(super) fn apply(
    store: &mut StateStore,
    peers: &HashMap<String, Device>,
    command: StateCommand,
    stop: &CancellationToken,
    cancel: &CancellationToken,
) -> Result<Task, String> {
    check_cancel(stop)
        .and_then(|_| check_cancel(cancel))
        .map_err(|e| e.to_string())?;
    let mut state = store.state().clone();
    let id = match command {
        StateCommand::New { peer, paths, text } => {
            if (paths.is_empty() && text.is_none())
                || text
                    .as_ref()
                    .is_some_and(|text| !paths.is_empty() || text.len() > MAX_TEXT_BYTES)
            {
                return Err("请选择文件或输入不超过 10 MiB 的文本".into());
            }
            let peer = peers
                .values()
                .find(|device| device.id == peer && state.trusted.contains(&device.fingerprint))
                .cloned()
                .ok_or("请先连接并配对设备")?;
            let id = Uuid::new_v4().to_string();
            let name = if text.is_some() {
                "文本".into()
            } else if paths.len() == 1 {
                PathBuf::from(&paths[0])
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("发送源名称无效")?
                    .to_owned()
            } else {
                format!("{} 个项目", paths.len())
            };
            let manifest = Manifest {
                id: id.clone(),
                name: name.clone(),
                entries: vec![],
                directories: vec![],
                text: text.clone(),
                extra: Map::new(),
            };
            manifest.validate()?;
            state.tasks.push(Task {
                peer: peer.clone(),
                manifest,
                sources: Some(paths),
                prepared: Some(text.is_some()),
                staging: None,
                files: None,
                extra: Map::new(),
                view: TransferView {
                    id: id.clone(),
                    direction: Direction::Send,
                    device: peer.name,
                    name,
                    total: 0,
                    done: 0,
                    speed: 0.0,
                    status: Status::Preparing,
                    error: None,
                    directory: None,
                    text,
                    extra: Map::new(),
                },
            });
            id
        }
        StateCommand::Get { id } => {
            let mut task = state
                .tasks
                .iter()
                .find(|task| task.view.id == id)
                .cloned()
                .ok_or("发送任务不存在")?;
            if let Some(peer) = peers
                .get(&task.peer.fingerprint)
                .filter(|peer| peer.id == task.peer.id)
            {
                task.peer = peer.clone();
            }
            return Ok(task);
        }
        StateCommand::Prepared { id, manifest } => {
            manifest.validate()?;
            let task = state
                .tasks
                .iter_mut()
                .find(|task| task.view.id == id && task.view.direction == Direction::Send)
                .ok_or("发送任务不存在")?;
            if manifest.id != task.manifest.id {
                return Err("发送任务身份变化".into());
            }
            task.view.total = manifest.total()?;
            task.manifest = manifest;
            task.prepared = Some(true);
            id
        }
        StateCommand::Update {
            id,
            status,
            done,
            error,
            peer,
        } => {
            let task = state
                .tasks
                .iter_mut()
                .find(|task| task.view.id == id && task.view.direction == Direction::Send)
                .ok_or("发送任务不存在")?;
            if done > task.view.total {
                return Err("发送进度超出声明大小".into());
            }
            if let Some(peer) = peer {
                if peer.id != task.peer.id || peer.fingerprint != task.peer.fingerprint {
                    return Err("发送目标身份变化".into());
                }
                peer.validate()?;
                task.peer = peer;
            }
            task.view.status = status;
            task.view.done = done;
            task.view.speed = 0.0;
            task.view.error = error;
            id
        }
        StateCommand::Clear { id } => {
            let task = state
                .tasks
                .iter()
                .find(|task| task.view.id == id && task.view.direction == Direction::Send)
                .cloned()
                .ok_or("发送任务不存在")?;
            state.tasks.retain(|task| task.view.id != id);
            store.commit_cancellable(state, &[stop, cancel])?;
            return Ok(task);
        }
    };
    store.commit_cancellable(state, &[stop, cancel])?;
    store
        .state()
        .tasks
        .iter()
        .find(|task| task.view.id == id)
        .cloned()
        .ok_or("发送任务不存在".into())
}

#[cfg(test)]
#[path = "sender_tests.rs"]
mod tests;
