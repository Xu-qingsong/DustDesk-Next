//! Native receiving service, still independent of desktop IPC/UI. State has
//! one owner; bounded streaming jobs are supervised and joined before shutdown.
use super::{
    discovery,
    files::{check_cancel, Directory, OwnedFile},
    peers,
    protocol::{
        fingerprint, pairing_code, valid_fingerprint, Device, Entry, Manifest, OfferReply, Offset,
        MAX_JSON_BYTES,
    },
    publication, sender,
    state_store::StateStore,
    storage::{Direction, Identity, State, Status, Task, TransferView},
    transport::{self, Handler, HandlerFuture, Peer},
};
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::{body::Incoming, Request, StatusCode};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::{
    sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub type Decision<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send>>;
#[derive(Clone)]
pub struct ReceivePrompt {
    pub peer: Device,
    pub manifest: Manifest,
    /// Resume confirmation must explicitly approve this existing directory.
    pub existing_directory: Option<PathBuf>,
}
pub trait Approvals: Send + Sync + 'static {
    fn pair(&self, peer: Device, code: String) -> Decision<bool>;
    fn receive(&self, prompt: ReceivePrompt) -> Decision<Option<PathBuf>>;
}

struct Session {
    token: Option<String>,
    generation: Uuid,
    cancel: CancellationToken,
    root: Option<Arc<Directory>>,
    gate: Arc<Semaphore>,
}
type Sessions = Arc<Mutex<HashMap<String, Session>>>;
#[derive(Clone)]
struct Authorization {
    id: String,
    generation: Uuid,
    cancel: CancellationToken,
    root: Option<Arc<Directory>>,
    gate: Arc<Semaphore>,
}
struct Busy {
    _permit: OwnedSemaphorePermit,
}
#[derive(Default)]
struct FileJobs {
    stopping: bool,
    handles: Vec<JoinHandle<()>>,
}
type Progress = Arc<RwLock<HashMap<String, (u64, f64)>>>;
struct ReceivePlan {
    file: OwnedFile,
    entry: Entry,
    before: u64,
    offset: u64,
}
struct ReceiveOutcome {
    file: Option<OwnedFile>,
    done: u64,
    error: Option<String>,
}
struct Pending {
    ids: Arc<Mutex<HashSet<String>>>,
    id: String,
}
impl Drop for Pending {
    fn drop(&mut self) {
        self.ids.lock().unwrap().remove(&self.id);
    }
}

enum Command {
    Inspect {
        id: String,
        fingerprint: String,
        reply: oneshot::Sender<Result<(Option<Task>, Device), String>>,
    },
    Pair {
        peer: Device,
        cancel: CancellationToken,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Offer {
        peer: Device,
        manifest: Manifest,
        approved: PathBuf,
        cancel: CancellationToken,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    File {
        authorization: Authorization,
        index: usize,
        offset: u64,
        body: mpsc::Receiver<Bytes>,
        cancel: CancellationToken,
        _busy: Busy,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Control {
        authorization: Authorization,
        action: String,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    LocalControl {
        id: String,
        action: String,
        authorization: Option<Authorization>,
        _idle: Option<OwnedSemaphorePermit>,
        cancel: CancellationToken,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    FinishFile {
        authorization: Authorization,
        index: usize,
        outcome: ReceiveOutcome,
        cancel: CancellationToken,
        _busy: Busy,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Snapshot {
        reply: oneshot::Sender<State>,
    },
    Enabled {
        enabled: bool,
        cancel: CancellationToken,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Stop,
    Outgoing {
        operation: sender::StateCommand,
        cancel: CancellationToken,
        reply: oneshot::Sender<Result<Task, String>>,
    },
}
struct Inner {
    identity: Arc<Identity>,
    name: String,
    port: std::sync::atomic::AtomicU16,
    approvals: Arc<dyn Approvals>,
    tx: mpsc::Sender<Command>,
    worker: Mutex<Option<JoinHandle<Result<(), String>>>>,
    stop_gate: tokio::sync::Mutex<()>,
    stop_result: Mutex<Option<Result<(), String>>>,
    stop: CancellationToken,
    trusted: Arc<RwLock<HashSet<String>>>,
    sessions: Sessions,
    pending: Arc<Mutex<HashSet<String>>>,
    views: Arc<RwLock<Vec<TransferView>>>,
    stopped_texts: Arc<Mutex<Vec<Task>>>,
    file_jobs: Arc<Mutex<FileJobs>>,
    progress: Progress,
    outgoing: Arc<sender::Runtime>,
    peers: Arc<Mutex<peers::Peers>>,
    discovery: tokio::sync::Mutex<Option<discovery::Service>>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
#[derive(Clone)]
pub struct Receiver {
    inner: Arc<Inner>,
}
impl Receiver {
    /// Existing, isolated profile and identity. Production ownership remains
    /// a separate host gate; start_owned keeps a freshly initialized owner.
    pub async fn start(
        profile: PathBuf,
        identity: Arc<Identity>,
        name: String,
        approvals: Arc<dyn Approvals>,
    ) -> Result<Self, String> {
        Self::start_inner(
            move || StateStore::open(&profile),
            identity,
            name,
            approvals,
        )
        .await
    }
    pub async fn start_owned(
        store: StateStore,
        identity: Arc<Identity>,
        name: String,
        approvals: Arc<dyn Approvals>,
    ) -> Result<Self, String> {
        Self::start_inner(move || Ok(store), identity, name, approvals).await
    }
    async fn start_inner(
        open: impl FnOnce() -> Result<StateStore, String> + Send + 'static,
        identity: Arc<Identity>,
        name: String,
        approvals: Arc<dyn Approvals>,
    ) -> Result<Self, String> {
        if name.encode_utf16().count() > 255 {
            return Err("设备名称过长".into());
        }
        let (tx, rx) = mpsc::channel(32);
        let (ready, initialized) = oneshot::channel();
        let stop = CancellationToken::new();
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        let trusted = Arc::new(RwLock::new(HashSet::new()));
        let worker_stop = stop.clone();
        let worker_sessions = sessions.clone();
        let worker_trusted = trusted.clone();
        let views = Arc::new(RwLock::new(Vec::new()));
        let worker_views = views.clone();
        let stopped_texts = Arc::new(Mutex::new(Vec::new()));
        let worker_texts = stopped_texts.clone();
        let file_jobs = Arc::new(Mutex::new(FileJobs::default()));
        let worker_jobs = file_jobs.clone();
        let progress = Arc::new(RwLock::new(HashMap::new()));
        let worker_progress = progress.clone();
        let worker_tx = tx.downgrade();
        let peers = Arc::new(Mutex::new(peers::Peers::default()));
        let worker_peers = peers.clone();
        let worker_identity = identity.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let store = match open().and_then(|store| {
                store.require_identity(&worker_identity)?;
                Ok(store)
            }) {
                Ok(store) => store,
                Err(error) => {
                    let _ = ready.send(Err(error.clone()));
                    return Err(error);
                }
            };
            *worker_trusted.write().unwrap() = store.state().trusted.iter().cloned().collect();
            for task in store.state().tasks.iter().rev() {
                if store.state().trusted.contains(&task.peer.fingerprint) {
                    worker_peers.lock().unwrap().restore(task.peer.clone());
                }
            }
            let _ = ready.send(Ok(()));
            Core {
                store,
                sessions: worker_sessions,
                trusted: worker_trusted,
                peers: worker_peers,
                stop: worker_stop,
                views: worker_views,
                stopped_texts: worker_texts,
                file_jobs: worker_jobs,
                progress: worker_progress,
                tx: worker_tx,
            }
            .run(rx)
        });
        let receiver = Self {
            inner: Arc::new(Inner {
                identity,
                name,
                port: 0.into(),
                approvals,
                tx,
                worker: Mutex::new(Some(worker)),
                stop_gate: tokio::sync::Mutex::new(()),
                stop_result: Mutex::new(None),
                stop,
                sessions,
                trusted,
                pending: Arc::new(Mutex::new(HashSet::new())),
                views,
                stopped_texts,
                file_jobs,
                progress,
                outgoing: Arc::new(sender::Runtime::default()),
                peers,
                discovery: tokio::sync::Mutex::new(None),
            }),
        };
        match initialized.await.map_err(|_| "接收服务初始化中断")? {
            Ok(()) => Ok(receiver),
            Err(error) => {
                let _ = receiver.stop().await;
                Err(error)
            }
        }
    }
    pub fn set_port(&self, port: u16) {
        self.inner
            .port
            .store(port, std::sync::atomic::Ordering::SeqCst);
    }
    /// Synchronous admission revocation. The native owner must still await
    /// stop() and Server::stop() to join actual work and release disk handles.
    pub fn cancel(&self) {
        self.inner.stop.cancel();
    }
    /// Moves RAM-only text tasks out after stop() has joined the state owner.
    /// Shutdown never waits for a snapshot behind a long disk preparation.
    pub fn take_stopped_texts(&self) -> Vec<Task> {
        std::mem::take(&mut *self.inner.stopped_texts.lock().unwrap())
    }
    /// The native host explicitly starts discovery after HTTPS binds. Failure
    /// to bind UDP is reported separately; HTTPS/manual pairing stays usable.
    pub async fn start_discovery(&self, config: discovery::Config) -> Result<(), String> {
        let mut service = self.inner.discovery.lock().await;
        check_cancel(&self.inner.stop).map_err(|error| error.to_string())?;
        if service.is_some() {
            return Err("设备发现已经启动".into());
        }
        *service = Some(
            discovery::Service::start(
                config,
                self.inner.identity.clone(),
                self.inner.name.clone(),
                self.inner.port.load(std::sync::atomic::Ordering::SeqCst),
                self.inner.peers.clone(),
                &self.inner.stop,
            )
            .await?,
        );
        Ok(())
    }
    pub async fn discovery_status(&self) -> discovery::Status {
        self.inner
            .discovery
            .lock()
            .await
            .as_ref()
            .map_or_else(discovery::Status::default, discovery::Service::status)
    }
    pub async fn stop_discovery(&self) -> Result<(), String> {
        let mut service = self.inner.discovery.lock().await;
        let result = match service.as_mut() {
            Some(service) => service.stop().await,
            None => Ok(()),
        };
        *service = None;
        result
    }
    pub async fn devices(&self) -> Vec<Device> {
        let service = self.inner.discovery.lock().await;
        let ttl = service
            .as_ref()
            .map_or(std::time::Duration::from_secs(20), |service| service.ttl);
        self.inner
            .peers
            .lock()
            .unwrap()
            .visible(std::time::Instant::now(), ttl)
    }
    pub(super) fn sender_context(&self) -> sender::Context {
        let tx = self.inner.tx.clone();
        let stop = self.inner.stop.clone();
        let rpc: sender::Rpc = Arc::new(move |operation, cancel| {
            let tx = tx.clone();
            let stop = stop.clone();
            Box::pin(async move {
                let (reply, receive) = oneshot::channel();
                tokio::select! { biased;
                    _ = stop.cancelled() => return Err("局域网服务已关闭".into()),
                    _ = cancel.cancelled() => return Err("发送任务已取消".into()),
                    result = tx.send(Command::Outgoing { operation, cancel: cancel.clone(), reply }) => result.map_err(|_| "传输状态线程已关闭")?,
                }
                tokio::select! { biased;
                    _ = stop.cancelled() => Err("局域网服务已关闭".into()),
                    _ = cancel.cancelled() => Err("发送任务已取消".into()),
                    result = receive => result.map_err(|_| "发送状态保存中断")?,
                }
            })
        });
        sender::Context {
            io: sender::Io {
                rpc,
                identity: self.inner.identity.clone(),
                name: self.inner.name.clone(),
                port: self.inner.port.load(std::sync::atomic::Ordering::SeqCst),
                stop: self.inner.stop.clone(),
                progress: self.inner.progress.clone(),
                failures: self.inner.outgoing.failures.clone(),
            },
            runtime: self.inner.outgoing.clone(),
        }
    }
    /// Native host action: observe an actual TLS peer, ask local confirmation,
    /// ask the remote peer, then durably grant local trust.
    pub async fn connect_device(
        &self,
        address: &str,
        port: u16,
        expected: Option<Device>,
    ) -> Result<Device, String> {
        let cancel = self.inner.stop.child_token();
        let _guard = cancel.clone().drop_guard();
        let client =
            transport::Client::new(self.inner.identity.clone(), transport::Limits::default())?;
        let device = if let Some(mut expected) = expected {
            expected.address = address.to_owned();
            expected.port = port;
            client.hello(&expected, &cancel).await?
        } else {
            client.discover(address, port, &cancel).await?
        };
        if !self.trusted(&device.fingerprint) {
            let approved = tokio::select! { biased; _ = cancel.cancelled() => return Err("配对已取消".into()),
            approved = self.inner.approvals.pair(device.clone(), pairing_code(&self.inner.identity.fingerprint, &device.fingerprint)?) => approved? };
            if !approved {
                return Err("配对已取消".into());
            }
        }
        let remote = client.json(&device, "/pair", Some(&json!({"id":self.inner.identity.id,"name":self.inner.name,"port":self.inner.port.load(std::sync::atomic::Ordering::SeqCst)})), &cancel).await?;
        if remote["ok"] != true {
            return Err("对方未确认配对".into());
        }
        let (reply, rx) = oneshot::channel();
        self.send(Command::Pair {
            peer: device.clone(),
            cancel: cancel.clone(),
            reply,
        })
        .await?;
        self.result(rx, &cancel).await?;
        Ok(device)
    }
    async fn send(&self, command: Command) -> Result<(), String> {
        tokio::select! { biased; _ = self.inner.stop.cancelled() => Err("局域网接收服务已关闭".into()),
        value = self.inner.tx.send(command) => value.map_err(|_| "接收工作线程已结束".into()) }
    }
    async fn result<T>(
        &self,
        rx: oneshot::Receiver<Result<T, String>>,
        peer: &CancellationToken,
    ) -> Result<T, String> {
        tokio::select! { biased; _ = self.inner.stop.cancelled() => Err("局域网接收服务已关闭".into()),
        _ = peer.cancelled() => Err("局域网请求已取消".into()), value = rx => value.map_err(|_| "接收操作未正常完成")? }
    }
    pub async fn snapshot(&self) -> Result<State, String> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::Snapshot { reply }).await?;
        rx.await.map_err(|_| "接收状态读取中断".into())
    }
    /// Persist the host's enabled setting through the same serial state owner.
    /// Listener/discovery lifecycle is still controlled by the native host.
    pub async fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        let cancel = self.inner.stop.child_token();
        let _guard = cancel.clone().drop_guard();
        let (reply, rx) = oneshot::channel();
        self.send(Command::Enabled {
            enabled,
            cancel: cancel.clone(),
            reply,
        })
        .await?;
        self.result(rx, &cancel).await.map(|_| ())
    }
    /// Trusted native host only. Revoke the live token and wait for the file
    /// owner before cleanup; completed files are never deleted by clear.
    pub async fn control_receive(&self, id: &str, action: &str) -> Result<(), String> {
        if action == "resume" {
            return Err("请在发送电脑点击继续，对方重新确认后续传".into());
        }
        if !matches!(action, "pause" | "cancel" | "clear") {
            return Err("任务操作无效".into());
        }
        let cancel = self.inner.stop.child_token();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let authorization = {
            let mut sessions = self.inner.sessions.lock().unwrap();
            sessions.get_mut(id).map(|session| {
                session.cancel.cancel();
                session.token = None;
                Authorization {
                    id: id.to_owned(),
                    generation: session.generation,
                    cancel: session.cancel.clone(),
                    root: session.root.clone(),
                    gate: session.gate.clone(),
                }
            })
        };
        let idle = if let Some(authorization) = &authorization {
            Some(tokio::select! { biased;
                _ = cancel.cancelled() => return Err("接收控制已取消".into()),
                permit = authorization.gate.clone().acquire_owned() => permit.map_err(|_| "接收会话已关闭")?,
            })
        } else {
            None
        };
        let (reply, result) = oneshot::channel();
        self.send(Command::LocalControl {
            id: id.to_owned(),
            action: action.to_owned(),
            authorization,
            _idle: idle,
            cancel: cancel.clone(),
            reply,
        })
        .await?;
        self.result(result, &cancel).await.map(|_| ())
    }
    /// Live progress never waits behind a stalled file body on the disk worker.
    pub fn views(&self) -> Vec<TransferView> {
        let mut views = self.inner.views.read().unwrap().clone();
        let progress = self.inner.progress.read().unwrap();
        let failures = self.inner.outgoing.failures.read().unwrap();
        for view in &mut views {
            if let Some((done, speed)) = progress.get(&view.id) {
                view.done = *done;
                view.speed = *speed;
                view.status = Status::Transferring;
            }
            if let Some(error) = failures.get(&view.id) {
                view.status = Status::Failed;
                view.speed = 0.0;
                view.error = Some(error.clone());
            }
        }
        views
    }
    async fn read(
        &self,
        request: &mut Request<Incoming>,
        limit: usize,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        tokio::select! { biased; _ = self.inner.stop.cancelled() => Err("接收已关闭".into()),
        value = transport::read_json(request.body_mut(), limit, cancel) => value }
    }
    /// Cancels admission, requests and tasks, then joins all file work. The
    /// host must also call Server::stop() to close/join the HTTPS listener.
    pub async fn stop(&self) -> Result<(), String> {
        let _stop_gate = self.inner.stop_gate.lock().await;
        if let Some(result) = self.inner.stop_result.lock().unwrap().as_ref() {
            return result.clone();
        }
        self.inner.stop.cancel();
        let discovery_result = {
            let mut service = self.inner.discovery.lock().await;
            match service.as_mut() {
                Some(service) => service.stop().await,
                None => Ok(()),
            }
        };
        for session in self.inner.sessions.lock().unwrap().values_mut() {
            session.cancel.cancel();
            session.token = None;
        }
        let jobs = {
            let mut jobs = self.inner.file_jobs.lock().unwrap();
            jobs.stopping = true;
            std::mem::take(&mut jobs.handles)
        };
        let mut job_error = None;
        let outgoing_result = sender::stop(&self.inner.outgoing).await;
        for job in jobs {
            if job.await.is_err() {
                job_error = Some("接收文件工作任务未正常退出".to_owned());
            }
        }
        let worker = self.inner.worker.lock().unwrap().take();
        let result = if let Some(worker) = worker {
            let _ = self.inner.tx.send(Command::Stop).await;
            let result = worker
                .await
                .map_err(|_| "接收工作线程未正常退出".to_owned())
                .and_then(|result| result);
            // Keep the Receiver object reusable for inspection without retaining
            // destination handles after its owned worker has actually stopped.
            self.inner.sessions.lock().unwrap().clear();
            result
                .and(outgoing_result)
                .and(discovery_result)
                .and_then(|_| job_error.map_or(Ok(()), Err))
        } else {
            Err("接收服务缺少真实停止结果".into())
        };
        *self.inner.stop_result.lock().unwrap() = Some(result.clone());
        result
    }
    fn authorize(
        &self,
        fingerprint: &str,
        query: &HashMap<String, String>,
        busy: bool,
        revoke: bool,
    ) -> Result<(Authorization, Option<Busy>), String> {
        let id = format!("{fingerprint}-{}", query.get("id").ok_or("缺少传输身份")?);
        let token = query.get("token").ok_or("缺少传输令牌")?;
        if !valid_fingerprint(token) {
            return Err("传输授权无效".into());
        }
        let mut sessions = self.inner.sessions.lock().unwrap();
        let session = sessions.get_mut(&id).ok_or("请重新确认接收任务")?;
        if session
            .token
            .as_ref()
            .is_none_or(|actual| !bool::from(actual.as_bytes().ct_eq(token.as_bytes())))
        {
            return Err("传输授权无效".into());
        }
        if busy && session.cancel.is_cancelled() {
            return Err("文件传输状态无效".into());
        }
        let authorization = Authorization {
            id,
            generation: session.generation,
            cancel: session.cancel.clone(),
            root: session.root.clone(),
            gate: session.gate.clone(),
        };
        let permit = if busy {
            Some(
                session
                    .gate
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| "任务正在传输")?,
            )
        } else {
            None
        };
        if revoke {
            session.cancel.cancel();
            session.token = None;
        }
        let guard = permit.map(|permit| Busy { _permit: permit });
        Ok((authorization, guard))
    }
    async fn dispatch(&self, peer: Peer, mut request: Request<Incoming>) -> Result<Value, String> {
        let operation = peer.cancellation.child_token();
        let _request_guard = operation.clone().drop_guard();
        match request.uri().path() {
            "/hello" => Ok(
                json!({"protocol":1,"id":self.inner.identity.id,"name":self.inner.name,"port":self.inner.port.load(std::sync::atomic::Ordering::SeqCst)}),
            ),
            "/pair" => {
                let value = self.read(&mut request, 4096, &operation).await?;
                let device = device(&value, &peer)?;
                if !self.trusted(&peer.fingerprint) {
                    let accepted = tokio::select! { biased;
                        _ = self.inner.stop.cancelled() => return Err("配对已取消".into()),
                        _ = operation.cancelled() => return Err("配对已取消".into()),
                        value = self.inner.approvals.pair(device.clone(), pairing_code(&self.inner.identity.fingerprint, &peer.fingerprint)?) => value?,
                    };
                    if !accepted {
                        return Err("配对已取消".into());
                    }
                }
                let (reply, rx) = oneshot::channel();
                self.send(Command::Pair {
                    peer: device,
                    cancel: operation.clone(),
                    reply,
                })
                .await?;
                self.result(rx, &operation).await
            }
            "/offer" => {
                let value = self.read(&mut request, MAX_JSON_BYTES, &operation).await?;
                let manifest =
                    Manifest::parse(&serde_json::to_vec(&value).map_err(|_| "传输清单无效")?)?
                        .public();
                let id = format!("{}-{}", peer.fingerprint, manifest.id);
                if !self.inner.pending.lock().unwrap().insert(id.clone()) {
                    return Err("此传输正在等待确认".into());
                }
                let _pending = Pending {
                    ids: self.inner.pending.clone(),
                    id: id.clone(),
                };
                let (reply, rx) = oneshot::channel();
                self.send(Command::Inspect {
                    id,
                    fingerprint: peer.fingerprint.clone(),
                    reply,
                })
                .await?;
                let (previous, mut device) = self.result(rx, &operation).await?;
                validate_previous(previous.as_ref(), &manifest)?;
                let existing = previous
                    .as_ref()
                    .and_then(|task| task.view.directory.as_ref())
                    .map(PathBuf::from);
                device.address = peer.address.to_string();
                let prompt = ReceivePrompt {
                    peer: device.clone(),
                    manifest: manifest.clone(),
                    existing_directory: existing.clone(),
                };
                let approved = tokio::select! { biased;
                    _ = self.inner.stop.cancelled() => return Err("接收已取消".into()),
                    _ = operation.cancelled() => return Err("接收已取消".into()),
                    value = self.inner.approvals.receive(prompt) => value?,
                }
                .ok_or("对方拒绝接收")?;
                if existing.is_some_and(|saved| saved != approved) {
                    return Err("续传必须明确确认原接收目录".into());
                }
                let (reply, rx) = oneshot::channel();
                self.send(Command::Offer {
                    peer: device,
                    manifest,
                    approved,
                    cancel: operation.clone(),
                    reply,
                })
                .await?;
                self.result(rx, &operation).await
            }
            route => {
                let query = query(request.uri().query().unwrap_or_default())?;
                if route == "/file" {
                    let index = number(query.get("index"))?;
                    let offset = number(query.get("offset"))?;
                    let index = usize::try_from(index).map_err(|_| "文件序号无效")?;
                    let (authorization, busy) =
                        self.authorize(&peer.fingerprint, &query, true, false)?;
                    let file_cancel = authorization.cancel.child_token();
                    let _file_guard = file_cancel.clone().drop_guard();
                    let (send, body) = mpsc::channel(2);
                    let (reply, rx) = oneshot::channel();
                    self.send(Command::File {
                        authorization,
                        index,
                        offset,
                        body,
                        cancel: file_cancel.clone(),
                        _busy: busy.unwrap(),
                        reply,
                    })
                    .await?;
                    loop {
                        let frame = tokio::select! { biased;
                            _ = self.inner.stop.cancelled() => return Err("接收已关闭".into()),
                            _ = operation.cancelled() => return Err("传输已断开".into()),
                            _ = file_cancel.cancelled() => return Err("传输已暂停或取消".into()),
                            frame = request.body_mut().frame() => frame,
                        };
                        let Some(frame) = frame else { break };
                        if let Ok(bytes) = frame.map_err(|e| e.to_string())?.into_data() {
                            for offset in (0..bytes.len()).step_by(64 * 1024) {
                                let piece =
                                    bytes.slice(offset..(offset + 64 * 1024).min(bytes.len()));
                                tokio::select! { biased;
                                    _ = self.inner.stop.cancelled() => return Err("接收已关闭".into()),
                                    _ = operation.cancelled() => return Err("传输已断开".into()),
                                    _ = file_cancel.cancelled() => return Err("传输已暂停或取消".into()),
                                    sent = send.send(piece) => if sent.is_err() { return self.result(rx, &operation).await; },
                                }
                            }
                        }
                    }
                    drop(send);
                    self.result(rx, &operation).await
                } else {
                    let revoke = matches!(route, "/pause" | "/cancel");
                    let (authorization, _) =
                        self.authorize(&peer.fingerprint, &query, false, revoke)?;
                    let _idle = if revoke {
                        tokio::select! { biased;
                            _ = self.inner.stop.cancelled() => return Err("接收已关闭".into()),
                            _ = operation.cancelled() => return Err("控制请求已取消".into()),
                            permit = authorization.gate.clone().acquire_owned() => permit.map_err(|_| "任务已关闭")?,
                        }
                    } else {
                        authorization
                            .gate
                            .clone()
                            .try_acquire_owned()
                            .map_err(|_| "任务正在传输")?
                    };
                    let (reply, rx) = oneshot::channel();
                    self.send(Command::Control {
                        authorization,
                        action: route.to_owned(),
                        reply,
                    })
                    .await?;
                    self.result(rx, &operation).await
                }
            }
        }
    }
}
impl Handler for Receiver {
    fn trusted(&self, fingerprint: &str) -> bool {
        !self.inner.stop.is_cancelled() && self.inner.trusted.read().unwrap().contains(fingerprint)
    }
    fn handle(&self, peer: Peer, request: Request<Incoming>) -> HandlerFuture {
        let receiver = self.clone();
        Box::pin(async move {
            Ok(match receiver.dispatch(peer, request).await {
                Ok(value) => transport::json_response(value, StatusCode::OK),
                Err(error) => {
                    transport::json_response(json!({"error":error}), StatusCode::BAD_REQUEST)
                }
            })
        })
    }
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}
fn device(value: &Value, peer: &Peer) -> Result<Device, String> {
    let device = Device {
        id: value["id"].as_str().ok_or("设备信息无效")?.to_owned(),
        name: value["name"].as_str().ok_or("设备信息无效")?.to_owned(),
        address: peer.address.to_string(),
        port: value["port"]
            .as_u64()
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port > 0)
            .ok_or("设备端口无效")?,
        fingerprint: peer.fingerprint.clone(),
        last_seen: now(),
        extra: Map::new(),
    };
    device.validate()?;
    Ok(device)
}
fn query(value: &str) -> Result<HashMap<String, String>, String> {
    // Protocol identifiers/tokens/integers need no URL escapes. Reject duplicate,
    // unknown or escaped values rather than silently selecting one credential.
    let mut query = HashMap::new();
    for part in value.split('&') {
        let (key, value) = part.split_once('=').ok_or("传输参数无效")?;
        if !matches!(key, "id" | "token" | "index" | "offset")
            || value.len() > 100
            || !value
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-')
            || query.insert(key.to_owned(), value.to_owned()).is_some()
        {
            return Err("传输参数无效或重复".into());
        }
    }
    Ok(query)
}
fn number(value: Option<&String>) -> Result<u64, String> {
    let value = value.ok_or("缺少文件参数")?;
    let number = value.parse::<u64>().map_err(|_| "文件参数无效")?;
    if number.to_string() != *value || number > super::protocol::MAX_SAFE_INTEGER {
        return Err("文件参数无效".into());
    }
    Ok(number)
}
fn validate_previous(previous: Option<&Task>, manifest: &Manifest) -> Result<(), String> {
    if let Some(previous) = previous {
        if serde_json::to_value(previous.manifest.public()).unwrap()
            != serde_json::to_value(manifest.public()).unwrap()
        {
            return Err("发送源已变化，请创建新的发送任务".into());
        }
        if previous.view.status == Status::Canceled {
            return Err("任务已取消，请重新发送".into());
        }
    }
    Ok(())
}

struct Core {
    store: StateStore,
    sessions: Sessions,
    trusted: Arc<RwLock<HashSet<String>>>,
    peers: Arc<Mutex<peers::Peers>>,
    stop: CancellationToken,
    views: Arc<RwLock<Vec<TransferView>>>,
    stopped_texts: Arc<Mutex<Vec<Task>>>,
    file_jobs: Arc<Mutex<FileJobs>>,
    progress: Progress,
    tx: mpsc::WeakSender<Command>,
}
impl Core {
    fn run(mut self, mut rx: mpsc::Receiver<Command>) -> Result<(), String> {
        self.publish_views();
        while let Some(command) = rx.blocking_recv() {
            match command {
                Command::Inspect {
                    id,
                    fingerprint,
                    reply,
                } => {
                    let previous = self
                        .store
                        .state()
                        .tasks
                        .iter()
                        .find(|t| t.view.id == id)
                        .cloned();
                    let peer = self
                        .peers
                        .lock()
                        .unwrap()
                        .known()
                        .get(&fingerprint)
                        .cloned()
                        .or_else(|| previous.as_ref().map(|task| task.peer.clone()));
                    let _ = reply.send(
                        peer.map(|peer| (previous, peer))
                            .ok_or("请重新连接设备".into()),
                    );
                }
                Command::Pair {
                    peer,
                    cancel,
                    reply,
                } => {
                    let result = self.pair(peer, &cancel);
                    let _ = reply.send(result);
                }
                Command::Offer {
                    peer,
                    manifest,
                    approved,
                    cancel,
                    reply,
                } => {
                    let result = self.offer(peer, manifest, approved, &cancel);
                    let _ = reply.send(result);
                }
                Command::File {
                    authorization,
                    index,
                    offset,
                    body,
                    cancel,
                    _busy,
                    reply,
                } => match self.begin_file(&authorization, index, offset, &cancel) {
                    Ok(plan) => {
                        let mut jobs = self.file_jobs.lock().unwrap();
                        if jobs.stopping {
                            let _ = reply.send(Err("接收已关闭".into()));
                            continue;
                        }
                        let Some(tx) = self.tx.upgrade() else {
                            let _ = reply.send(Err("接收已关闭".into()));
                            continue;
                        };
                        let progress = self.progress.clone();
                        let id = authorization.id.clone();
                        progress
                            .write()
                            .unwrap()
                            .insert(id.clone(), (plan.before, 0.0));
                        jobs.handles.push(tokio::spawn(async move {
                            let worker_cancel = cancel.clone();
                            let outcome = tokio::task::spawn_blocking(move || {
                                receive_stream(plan, body, &worker_cancel, &progress, &id)
                            })
                            .await;
                            let outcome = outcome.unwrap_or_else(|_| ReceiveOutcome {
                                file: None,
                                done: offset,
                                error: Some("接收文件工作线程异常".into()),
                            });
                            let _ = tx
                                .send(Command::FinishFile {
                                    authorization,
                                    index,
                                    outcome,
                                    cancel,
                                    _busy,
                                    reply,
                                })
                                .await;
                        }));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                },
                Command::FinishFile {
                    authorization,
                    index,
                    outcome,
                    cancel,
                    _busy,
                    reply,
                } => {
                    let mut result = self.finish_file(&authorization, index, outcome, &cancel);
                    self.progress.write().unwrap().remove(&authorization.id);
                    if let Err(error) = &result {
                        if let Some(view) = self.store.task_view_mut(&authorization.id) {
                            view.status = if authorization.cancel.is_cancelled()
                                || self.stop.is_cancelled()
                            {
                                Status::Paused
                            } else {
                                Status::Failed
                            };
                            view.speed = 0.0;
                            view.error = Some(error.clone());
                        }
                        if let Err(save_error) = self.store.commit(self.store.state().clone()) {
                            result = Err(format!("{error}；保存失败状态失败：{save_error}"));
                        }
                    }
                    let _ = reply.send(result);
                    drop(_busy);
                }
                Command::Control {
                    authorization,
                    action,
                    reply,
                } => {
                    let result = self.control(&authorization, &action);
                    let _ = reply.send(result);
                }
                Command::LocalControl {
                    id,
                    action,
                    authorization,
                    _idle,
                    cancel,
                    reply,
                } => {
                    let result = self.local_control(&id, &action, authorization, &cancel);
                    let _ = reply.send(result);
                    drop(_idle);
                }
                Command::Snapshot { reply } => {
                    let _ = reply.send(self.store.state().clone());
                }
                Command::Enabled {
                    enabled,
                    cancel,
                    reply,
                } => {
                    let result = self.active(&cancel).and_then(|()| {
                        let mut state = self.store.state().clone();
                        state.enabled = enabled;
                        self.store
                            .commit_cancellable(state, &[&self.stop, &cancel])?;
                        Ok(json!({"ok":true}))
                    });
                    let _ = reply.send(result);
                }
                Command::Stop => break,
                Command::Outgoing {
                    operation,
                    cancel,
                    reply,
                } => {
                    let known = self.peers.lock().unwrap().known();
                    let result =
                        sender::apply(&mut self.store, &known, operation, &self.stop, &cancel);
                    let _ = reply.send(result);
                }
            }
            self.publish_views();
        }
        let mut state = self.store.state().clone();
        for task in &mut state.tasks {
            if !matches!(task.view.status, Status::Completed | Status::Canceled) {
                task.view.status = Status::Paused;
                task.view.speed = 0.0;
            }
        }
        let result = self.store.commit(state);
        self.publish_views();
        *self.stopped_texts.lock().unwrap() = self.store.take_transient();
        result
    }
    fn publish_views(&self) {
        *self.views.write().unwrap() = self
            .store
            .state()
            .tasks
            .iter()
            .map(|task| task.view.clone())
            .collect();
    }
    fn active(&self, cancel: &CancellationToken) -> Result<(), String> {
        check_cancel(&self.stop)
            .and_then(|_| check_cancel(cancel))
            .map_err(|e| e.to_string())
    }
    fn pair(&mut self, peer: Device, cancel: &CancellationToken) -> Result<Value, String> {
        self.active(cancel)?;
        peer.validate()?;
        if self
            .peers
            .lock()
            .unwrap()
            .known()
            .values()
            .chain(self.store.state().tasks.iter().map(|task| &task.peer))
            .any(|known| known.id == peer.id && known.fingerprint != peer.fingerprint)
        {
            return Err("设备身份已对应其他已配对证书".into());
        }
        let mut state = self.store.state().clone();
        if !state.trusted.contains(&peer.fingerprint) {
            state.trusted.push(peer.fingerprint.clone());
        }
        self.active(cancel)?;
        self.store
            .commit_cancellable(state, &[&self.stop, cancel])?;
        self.trusted
            .write()
            .unwrap()
            .insert(peer.fingerprint.clone());
        self.peers.lock().unwrap().pair(peer);
        Ok(json!({"ok":true}))
    }
    fn offer(
        &mut self,
        mut peer: Device,
        manifest: Manifest,
        approved: PathBuf,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        self.active(cancel)?;
        manifest.validate()?;
        if !self.store.state().trusted.contains(&peer.fingerprint) {
            return Err("请先配对设备".into());
        }
        let known = self
            .peers
            .lock()
            .unwrap()
            .known()
            .get(&peer.fingerprint)
            .cloned()
            .or_else(|| {
                self.store
                    .state()
                    .tasks
                    .iter()
                    .find(|t| t.peer.fingerprint == peer.fingerprint)
                    .map(|t| t.peer.clone())
            })
            .ok_or("请重新连接设备")?;
        peer.id = known.id;
        peer.name = known.name;
        peer.port = known.port;
        peer.last_seen = now();
        let id = format!("{}-{}", peer.fingerprint, manifest.id);
        let previous = self
            .store
            .state()
            .tasks
            .iter()
            .find(|t| t.view.id == id)
            .cloned();
        validate_previous(previous.as_ref(), &manifest)?;
        if self
            .sessions
            .lock()
            .unwrap()
            .get(&id)
            .is_some_and(|session| session.gate.available_permits() == 0)
        {
            return Err("任务正在传输".into());
        }
        let mut task = previous.clone().unwrap_or(Task {
            view: TransferView {
                id: id.clone(),
                direction: Direction::Receive,
                device: peer.name.clone(),
                name: manifest.name.clone(),
                total: manifest.total()?,
                done: 0,
                speed: 0.0,
                status: Status::Waiting,
                error: None,
                directory: None,
                text: None,
                extra: Map::new(),
            },
            peer: peer.clone(),
            manifest: manifest.clone(),
            sources: None,
            prepared: None,
            staging: None,
            files: Some(Map::new()),
            extra: Map::new(),
        });
        task.peer = peer;
        let mut root = None;
        let mut offsets = Vec::new();
        if let Some(text) = &manifest.text {
            task.view.text = Some(text.clone());
            task.view.status = Status::Completed;
        } else {
            let staging_name = format!(".dustdesk-part-{}", manifest.id);
            if manifest
                .entries
                .iter()
                .map(|e| &e.relative)
                .chain(manifest.directories.iter())
                .any(|relative| {
                    relative
                        .split('/')
                        .next()
                        .unwrap()
                        .eq_ignore_ascii_case(&staging_name)
                })
            {
                return Err("清单与任务暂存目录冲突".into());
            }
            let destination = if let Some(saved) = task.view.directory.as_ref() {
                if Path::new(saved) != approved {
                    return Err("续传目录未经确认".into());
                }
                Directory::open(&approved)
            } else {
                Directory::open(&approved).and_then(|root| {
                    root.create_child(&format!("DustDesk-接收-{}", Uuid::new_v4()))
                })
            }
            .map_err(|e| e.to_string())?;
            task.view.directory = Some(
                destination
                    .path()
                    .to_str()
                    .ok_or("接收目录无效")?
                    .to_owned(),
            );
            task.staging = Some(
                destination
                    .path()
                    .join(&staging_name)
                    .to_str()
                    .ok_or("暂存目录无效")?
                    .to_owned(),
            );
            // A successful cleanup may precede a failed terminal-state save.
            // Fresh native approval permits recreating only this fixed staging
            // directory; mapped files and pending publication identities still
            // require independent verification below.
            destination
                .staging(&staging_name, true)
                .map_err(|e| e.to_string())?;
            for directory in &manifest.directories {
                self.active(cancel)?;
                destination
                    .child(directory, true)
                    .map_err(|e| e.to_string())?;
            }
            // Save a new task before receiving data; persisted existing intents
            // must be recovered before an offer can expose continuation offsets.
            if previous.is_none() {
                let mut state = self.store.state().clone();
                state.tasks.push(task.clone());
                self.active(cancel)?;
                self.store
                    .commit_cancellable(state, &[&self.stop, cancel])?;
            }
            publication::recover(&mut self.store, &id, destination.clone(), cancel)?;
            let staging = destination
                .staging(&staging_name, false)
                .map_err(|e| e.to_string())?;
            task = self
                .store
                .state()
                .tasks
                .iter()
                .find(|t| t.view.id == id)
                .cloned()
                .unwrap_or(task);
            for (index, entry) in manifest.entries.iter().enumerate() {
                self.active(cancel)?;
                let mapped = task
                    .files
                    .as_ref()
                    .and_then(|files| files.get(&index.to_string()))
                    .and_then(Value::as_str);
                if let Some(mapped) = mapped {
                    let relative = Path::new(mapped)
                        .strip_prefix(destination.path())
                        .map_err(|_| "完成文件超出接收目录")?
                        .to_str()
                        .ok_or("完成文件路径无效")?
                        .replace('\\', "/");
                    let (parent, name) = destination
                        .parent_for(&relative, false)
                        .map_err(|e| e.to_string())?;
                    let mut file = parent.read(&name).map_err(|e| e.to_string())?;
                    let hash = file.hash(entry.size, cancel).map_err(|e| e.to_string())?;
                    if hash != entry.hash {
                        return Err("已接收文件被修改，请发送到新目录".into());
                    }
                    offsets.push(Offset {
                        size: entry.size,
                        hash,
                        complete: true,
                    });
                } else {
                    match staging.part(&format!("{index}.part")) {
                        Ok(mut file) => {
                            let size = file.size().map_err(|e| e.to_string())?;
                            if size > entry.size {
                                return Err("暂存文件超过声明大小".into());
                            }
                            offsets.push(Offset {
                                size,
                                hash: file.hash(size, cancel).map_err(|e| e.to_string())?,
                                complete: false,
                            });
                        }
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {
                            offsets.push(Offset {
                                size: 0,
                                hash: fingerprint(&[]),
                                complete: false,
                            })
                        }
                        Err(error) => return Err(error.to_string()),
                    }
                }
            }
            task.view.done = offsets.iter().map(|offset| offset.size).sum();
            task.view.status = Status::Waiting;
            task.view.speed = 0.0;
            task.view.error = None;
            root = Some(destination);
        }
        let mut random = [0_u8; 32];
        rustls::crypto::ring::default_provider()
            .secure_random
            .fill(&mut random)
            .map_err(|_| "无法生成接收令牌")?;
        let token = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let mut state = self.store.state().clone();
        match state.tasks.iter_mut().find(|t| t.view.id == id) {
            Some(saved) => *saved = task,
            None => state.tasks.push(task),
        }
        self.active(cancel)?;
        self.store
            .commit_cancellable(state, &[&self.stop, cancel])?;
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(old) = sessions.remove(&id) {
            old.cancel.cancel();
        }
        sessions.insert(
            id,
            Session {
                token: Some(token.clone()),
                generation: Uuid::new_v4(),
                cancel: self.stop.child_token(),
                root,
                gate: Arc::new(Semaphore::new(1)),
            },
        );
        Ok(serde_json::to_value(OfferReply { token, offsets }).unwrap())
    }
    fn task_index(&self, authorization: &Authorization) -> Result<usize, String> {
        if self
            .sessions
            .lock()
            .unwrap()
            .get(&authorization.id)
            .is_none_or(|session| session.generation != authorization.generation)
        {
            return Err("接收会话已过期".into());
        }
        self.store
            .state()
            .tasks
            .iter()
            .position(|t| t.view.id == authorization.id)
            .ok_or("接收任务不存在".into())
    }
    fn begin_file(
        &mut self,
        authorization: &Authorization,
        index: usize,
        offset: u64,
        cancel: &CancellationToken,
    ) -> Result<ReceivePlan, String> {
        self.active(cancel)?;
        let task_index = self.task_index(authorization)?;
        let task = &self.store.state().tasks[task_index];
        if !matches!(task.view.status, Status::Waiting | Status::Transferring)
            || task
                .files
                .as_ref()
                .is_some_and(|files| files.contains_key(&index.to_string()))
        {
            return Err("文件传输状态无效".into());
        }
        let entry = task
            .manifest
            .entries
            .get(index)
            .ok_or("文件序号无效")?
            .clone();
        if offset > entry.size {
            return Err("续传偏移无效".into());
        }
        let root = authorization.root.clone().ok_or("接收目录未经确认")?;
        let staging = root
            .staging(&format!(".dustdesk-part-{}", task.manifest.id), false)
            .map_err(|e| e.to_string())?;
        let name = format!("{index}.part");
        let file = match staging.part(&name) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound && offset == 0 => {
                staging.create(&name).map_err(|e| e.to_string())?
            }
            Err(error) => return Err(error.to_string()),
        };
        if file.size().map_err(|e| e.to_string())? != offset {
            return Err("续传偏移不一致，请重新恢复任务".into());
        }
        let before = self.store.state().tasks[task_index].view.done;
        if let Some(view) = self.store.task_view_mut(&authorization.id) {
            view.status = Status::Transferring;
            view.error = None;
        }
        Ok(ReceivePlan {
            file,
            entry,
            before,
            offset,
        })
    }
    fn finish_file(
        &mut self,
        authorization: &Authorization,
        index: usize,
        outcome: ReceiveOutcome,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        self.task_index(authorization)?;
        if let Some(view) = self.store.task_view_mut(&authorization.id) {
            view.done = outcome.done;
            view.speed = 0.0;
        }
        if let Some(error) = outcome.error {
            return Err(error);
        }
        self.active(cancel)?;
        let file = outcome.file.ok_or("接收文件工作任务未返回文件")?;
        let root = authorization.root.clone().ok_or("接收目录未经确认")?;
        let prepared = publication::Prepared::begin(
            &mut self.store,
            &authorization.id,
            index,
            root,
            file,
            cancel,
        )?;
        prepared.finish(&mut self.store, cancel)?;
        Ok(json!({"ok":true}))
    }
    fn local_control(
        &mut self,
        id: &str,
        action: &str,
        authorization: Option<Authorization>,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        self.active(cancel)?;
        let task = self
            .store
            .state()
            .tasks
            .iter()
            .find(|task| task.view.id == id)
            .cloned()
            .ok_or("接收任务不存在")?;
        if task.view.direction != Direction::Receive {
            return Err("该任务不是接收任务".into());
        }
        if action == "pause" && matches!(task.view.status, Status::Completed | Status::Canceled) {
            return Ok(json!({"ok":true}));
        }
        let authorization = match authorization {
            Some(authorization) => {
                self.task_index(&authorization)?;
                authorization
            }
            None => {
                let mut sessions = self.sessions.lock().unwrap();
                if sessions.contains_key(id) {
                    return Err("接收会话已变化，请重试".into());
                }
                let root = task
                    .view
                    .directory
                    .as_ref()
                    .map(|path| Directory::open(Path::new(path)).map_err(|error| error.to_string()))
                    .transpose()?;
                let generation = Uuid::new_v4();
                let cancel = CancellationToken::new();
                cancel.cancel();
                let gate = Arc::new(Semaphore::new(1));
                sessions.insert(
                    id.to_owned(),
                    Session {
                        token: None,
                        generation,
                        cancel: cancel.clone(),
                        root: root.clone(),
                        gate: gate.clone(),
                    },
                );
                Authorization {
                    id: id.to_owned(),
                    generation,
                    cancel,
                    root,
                    gate,
                }
            }
        };
        self.control(
            &authorization,
            if action == "pause" {
                "/pause"
            } else {
                "/cancel"
            },
        )?;
        if action == "clear" {
            let mut state = self.store.state().clone();
            state.tasks.retain(|task| task.view.id != id);
            self.store.commit(state)?;
            self.sessions.lock().unwrap().remove(id);
        }
        Ok(json!({"ok":true}))
    }
    fn control(&mut self, authorization: &Authorization, action: &str) -> Result<Value, String> {
        let index = self.task_index(authorization)?;
        let task = self.store.state().tasks[index].clone();
        if action == "/complete"
            && task.files.as_ref().map_or(0, |files| files.len()) != task.manifest.entries.len()
        {
            return Err("仍有文件未完成".into());
        }
        if matches!(action, "/cancel" | "/complete") {
            if let Some(root) = &authorization.root {
                // Reconcile any rename whose mapping save failed before cleanup.
                publication::recover(
                    &mut self.store,
                    &authorization.id,
                    root.clone(),
                    &CancellationToken::new(),
                )?;
                let task = &self.store.state().tasks[index];
                let staging = root.staging(&format!(".dustdesk-part-{}", task.manifest.id), false);
                match staging {
                    Ok(staging) => {
                        for index in 0..task.manifest.entries.len() {
                            match staging.part(&format!("{index}.part")) {
                                Ok(file) => file.remove().map_err(|e| e.to_string())?,
                                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                                Err(error) => return Err(error.to_string()),
                            }
                        }
                        staging
                            .remove_empty()
                            .map_err(|e| format!("暂存目录含未知项目或无法清理：{e}"))?;
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
        }
        let mut state = self.store.state().clone();
        let task = &mut state.tasks[index];
        task.view.speed = 0.0;
        task.view.status = match action {
            "/pause" => Status::Paused,
            "/cancel" => Status::Canceled,
            "/complete" => {
                task.view.done = task.view.total;
                Status::Completed
            }
            _ => return Err("未知传输操作".into()),
        };
        self.store.commit(state)?;
        Ok(json!({"ok":true}))
    }
}

fn receive_stream(
    mut plan: ReceivePlan,
    mut body: mpsc::Receiver<Bytes>,
    cancel: &CancellationToken,
    progress: &Progress,
    id: &str,
) -> ReceiveOutcome {
    let started = std::time::Instant::now();
    let mut received = plan.offset;
    let mut bad_hash = false;
    let result = (|| -> Result<(), String> {
        while let Some(bytes) = body.blocking_recv() {
            plan.file
                .append(received, &bytes, plan.entry.size, cancel)
                .map_err(|e| e.to_string())?;
            received += bytes.len() as u64;
            progress.write().unwrap().insert(
                id.to_owned(),
                (
                    plan.before + received - plan.offset,
                    (received - plan.offset) as f64 / started.elapsed().as_secs_f64().max(0.001),
                ),
            );
        }
        check_cancel(cancel).map_err(|e| e.to_string())?;
        plan.file.sync().map_err(|e| e.to_string())?;
        if received != plan.entry.size {
            return Err("文件未传输完整，保留续传部分".into());
        }
        if plan
            .file
            .hash(plan.entry.size, cancel)
            .map_err(|e| e.to_string())?
            != plan.entry.hash
        {
            bad_hash = true;
            return Err("文件校验失败，请重试".into());
        }
        Ok(())
    })();
    let actual = plan.file.size().unwrap_or(received).min(plan.entry.size);
    let done = plan.before.saturating_sub(plan.offset) + actual;
    match result {
        Ok(()) => ReceiveOutcome {
            file: Some(plan.file),
            done,
            error: None,
        },
        Err(mut error) => {
            // A bad full hash owns exactly this corrupt part. Other errors keep
            // the actual prefix, including a short/failed OS write or cancel.
            if bad_hash {
                if let Err(cleanup) = plan.file.remove() {
                    error.push_str(&format!("；清理失败：{cleanup}"));
                }
                return ReceiveOutcome {
                    file: None,
                    done: plan.before.saturating_sub(plan.offset),
                    error: Some(error),
                };
            }
            if let Err(sync) = plan.file.sync() {
                error.push_str(&format!("；保存部分文件失败：{sync}"));
            }
            ReceiveOutcome {
                file: None,
                done,
                error: Some(error),
            }
        }
    }
}
