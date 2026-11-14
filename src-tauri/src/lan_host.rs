//! Desktop owner of the isolated LAN profile. One supervised actor retains
//! startup and shutdown work even when an IPC caller or maintenance wait ends.
use dustdesk_tauri::lan::{
    approvals::{Queue, Ui},
    dialog::{self, ReceiveChoice},
    discovery,
    files::Directory,
    folder,
    protocol::Device,
    receiver::{Approvals, Decision, ReceivePrompt, Receiver},
    state_store::StateStore,
    storage::{Direction, Identity, State, Task, TransferView},
    transport::{Limits, Server},
};
use serde::Serialize;
use std::{
    net::{Ipv4Addr, SocketAddrV4},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, WebviewWindow};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

const CLOSED: &str = "局域网操作已取消";
#[derive(Clone, Default, Serialize)]
pub struct Snapshot {
    enabled: bool,
    devices: Vec<Device>,
    tasks: Vec<TransferView>,
    addresses: Vec<String>,
    port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
#[derive(Default)]
struct Admission {
    revision: u64,
    cancel: Option<CancellationToken>,
    queue: Option<Queue>,
    receiver: Option<Receiver>,
    renderer: CancellationToken,
    renderer_nonce: String,
    suspended: bool,
}
impl Admission {
    fn reset_renderer(&mut self) {
        self.renderer.cancel();
        self.renderer = CancellationToken::new();
    }
    fn renderer(&self, lease: &str) -> Result<CancellationToken, String> {
        if lease.is_empty() || lease != self.renderer_nonce {
            return Err("局域网页面授权已失效".into());
        }
        Ok(self.renderer.clone())
    }
    fn interrupt(&mut self) -> u64 {
        self.revision = self.revision.wrapping_add(1);
        if let Some(cancel) = &self.cancel {
            cancel.cancel();
        }
        if let Some(queue) = &self.queue {
            queue.cancel();
        }
        if let Some(receiver) = &self.receiver {
            receiver.cancel();
        }
        self.revision
    }
}
pub struct Service {
    app: tauri::AppHandle,
    send: mpsc::Sender<Command>,
    admission: Arc<Mutex<Admission>>,
    // Retain the actor, never abort it on a renderer's cancellation.
    _actor: tauri::async_runtime::JoinHandle<()>,
}
struct Client {
    receiver: Receiver,
    cancel: CancellationToken,
    renderer: CancellationToken,
}
struct Session {
    receiver: Receiver,
    server: Server,
    queue: Queue,
    cancel: CancellationToken,
}
enum Command {
    Snapshot(oneshot::Sender<Result<Snapshot, String>>),
    Enable {
        enabled: bool,
        revision: u64,
        renderer: CancellationToken,
        reply: oneshot::Sender<Result<Snapshot, String>>,
    },
    Restore(u64),
    Suspend(oneshot::Sender<Result<(), String>>),
    Client(CancellationToken, oneshot::Sender<Result<Client, String>>),
    Control {
        id: String,
        action: String,
        renderer: CancellationToken,
        reply: oneshot::Sender<Result<(), String>>,
    },
}
struct Actor {
    app: tauri::AppHandle,
    root: PathBuf,
    admission: Arc<Mutex<Admission>>,
    session: Option<Session>,
    snapshot: Snapshot,
    published: Option<serde_json::Value>,
    texts: Vec<Task>,
}
struct OfflineApprovals;
impl Approvals for OfflineApprovals {
    fn pair(&self, _: Device, _: String) -> Decision<bool> {
        Box::pin(async { Err("请先开启局域网传输".into()) })
    }
    fn receive(&self, _: ReceivePrompt) -> Decision<Option<PathBuf>> {
        Box::pin(async { Err("请先开启局域网传输".into()) })
    }
}

struct NativeUi {
    app: tauri::AppHandle,
    session: CancellationToken,
}
impl Ui for NativeUi {
    fn check(&self) -> Result<(), String> {
        if self.session.is_cancelled() {
            return Err(CLOSED.into());
        }
        self.app
            .state::<crate::draft_startup::Service>()
            .require_ready()?;
        self.app
            .state::<crate::lifecycle::QuitState>()
            .require_interactive()
    }
    fn pair(&self, peer: &Device, code: &str, cancel: &CancellationToken) -> Result<bool, String> {
        let _lease = crate::system::native_modal(&self.app, cancel)?;
        self.check()?;
        dialog::pair(0, peer, code, cancel)
    }
    fn receive(
        &self,
        prompt: &ReceivePrompt,
        downloads: &Path,
        cancel: &CancellationToken,
    ) -> Result<ReceiveChoice, String> {
        let _lease = crate::system::native_modal(&self.app, cancel)?;
        self.check()?;
        dialog::receive(0, prompt, downloads, cancel)
    }
    fn choose_directory(&self, cancel: &CancellationToken) -> Result<Option<PathBuf>, String> {
        let _lease = crate::system::native_modal(&self.app, cancel)?;
        self.check()?;
        folder::choose(0, cancel)
    }
}
impl Service {
    pub fn new(app: tauri::AppHandle, root: PathBuf) -> Self {
        let (send, receive) = mpsc::channel(32);
        let admission = Arc::new(Mutex::new(Admission::default()));
        let actor = Actor {
            app: app.clone(),
            root,
            admission: admission.clone(),
            session: None,
            snapshot: Snapshot::default(),
            published: None,
            texts: Vec::new(),
        };
        Self {
            app,
            send,
            admission,
            _actor: tauri::async_runtime::spawn(actor.run(receive)),
        }
    }
    fn revision(&self) -> Result<u64, String> {
        Ok(self
            .admission
            .lock()
            .map_err(|error| error.to_string())?
            .revision)
    }
    /// Synchronous revocation precedes queued cleanup, including during CNG.
    fn interrupt(&self) -> Result<u64, String> {
        Ok(self
            .admission
            .lock()
            .map_err(|error| error.to_string())?
            .interrupt())
    }
    pub fn navigated(&self) {
        if let Ok(mut admission) = self.admission.lock() {
            admission.reset_renderer();
            admission.renderer_nonce.clear();
        }
    }
    pub fn cancel_renderer(&self) {
        if let Ok(mut admission) = self.admission.lock() {
            admission.reset_renderer();
        }
    }
    fn renderer(&self, lease: &str) -> Result<CancellationToken, String> {
        self.admission
            .lock()
            .map_err(|error| error.to_string())?
            .renderer(lease)
    }
    fn enable_lease(&self, lease: &str, enabled: bool) -> Result<(CancellationToken, u64), String> {
        let mut admission = self.admission.lock().map_err(|error| error.to_string())?;
        let renderer = admission.renderer(lease)?;
        let revision = if enabled {
            admission.revision
        } else {
            admission.interrupt()
        };
        Ok((renderer, revision))
    }
    async fn client(&self, lease: &str) -> Result<Client, String> {
        let renderer = self.renderer(lease)?;
        self.submit(|reply| Command::Client(renderer, reply)).await
    }
    async fn submit<T>(
        &self,
        make: impl FnOnce(oneshot::Sender<Result<T, String>>) -> Command,
    ) -> Result<T, String> {
        let (reply, receive) = oneshot::channel();
        self.send
            .send(make(reply))
            .await
            .map_err(|_| "局域网宿主已关闭")?;
        receive.await.map_err(|_| "局域网宿主未完成操作")?
    }
    pub async fn suspend(&self) -> Result<(), String> {
        self.admission
            .lock()
            .map_err(|error| error.to_string())?
            .suspended = true;
        self.interrupt()?;
        self.submit(Command::Suspend).await
    }
    pub fn restore(&self) {
        if self
            .app
            .state::<crate::lifecycle::QuitState>()
            .require_interactive()
            .is_err()
        {
            return;
        }
        if let Ok(mut admission) = self.admission.lock() {
            admission.suspended = false;
        }
        if let Ok(revision) = self.revision() {
            let send = self.send.clone();
            tauri::async_runtime::spawn(async move {
                let _ = send.send(Command::Restore(revision)).await;
            });
        }
    }
    pub async fn pause(&self) -> Result<Pause<'_>, String> {
        let pause = Pause(self);
        self.suspend().await?;
        Ok(pause)
    }
}
pub struct Pause<'a>(&'a Service);
impl Drop for Pause<'_> {
    fn drop(&mut self) {
        self.0.restore();
    }
}
impl Actor {
    fn test_local(&self) -> Result<bool, String> {
        if !cfg!(debug_assertions)
            || std::env::var_os("DUSTDESK_TAURI_TEST_LAN_LOCAL_ONLY").is_none()
        {
            return Ok(false);
        }
        let user = std::env::var_os("DUSTDESK_TEST_USER_DATA_DIR")
            .map(PathBuf::from)
            .ok_or("LAN 测试缺少隔离目录")?;
        let root = user.parent().ok_or("LAN 测试目录无效")?;
        if root.parent() != Some(std::env::temp_dir().as_path())
            || !root
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("dustdesk-tauri-test-"))
            || user.join("tauri-preview") != self.root
        {
            return Err("LAN 测试仅允许独立临时目录".into());
        }
        Ok(true)
    }
    fn ready(&self) -> Result<(), String> {
        if self
            .admission
            .lock()
            .map_err(|error| error.to_string())?
            .suspended
        {
            return Err("局域网服务正在退出或维护".into());
        }
        self.app
            .state::<crate::draft_startup::Service>()
            .require_ready()?;
        self.app
            .state::<crate::lifecycle::QuitState>()
            .require_interactive()
    }
    fn begin(&self, revision: u64) -> Result<CancellationToken, String> {
        self.ready()?;
        let mut admission = self.admission.lock().map_err(|error| error.to_string())?;
        if admission.revision != revision {
            return Err(CLOSED.into());
        }
        let cancel = CancellationToken::new();
        admission.cancel = Some(cancel.clone());
        Ok(cancel)
    }
    async fn load(&mut self) -> Result<State, String> {
        let root = self.root.join("LanTransfers");
        let state = tokio::task::spawn_blocking(move || {
            // Disabled snapshots and startup restore must obey the same
            // admission as writers. Do not read another runtime's live state.
            // Preserve lazy startup when no LAN profile has ever been used.
            if !root.try_exists().map_err(|error| error.to_string())? {
                return Ok::<_, String>(State::default());
            }
            Ok(StateStore::open(&root)?.state().clone())
        })
        .await
        .map_err(|error| error.to_string())??;
        self.snapshot.tasks = state.tasks.iter().map(|task| task.view.clone()).collect();
        self.snapshot
            .tasks
            .extend(self.texts.iter().map(|task| task.view.clone()));
        Ok(state)
    }
    async fn start(
        &mut self,
        revision: u64,
        renderer: Option<&CancellationToken>,
    ) -> Result<(), String> {
        if let Some(session) = &self.session {
            if !session.cancel.is_cancelled() {
                return Ok(());
            }
            self.stop().await?;
        }
        let cancel = self.begin(revision)?;
        let test_local = self.test_local()?;
        let root = self.root.clone();
        let initialization = cancel.clone();
        let texts = self.texts.clone();
        // Actor awaits this real blocking owner; dropping the IPC cannot
        // detach identity initialization or let a second owner race it.
        let (store, identity) = tokio::task::spawn_blocking(move || {
            let parent = Directory::open(&root).map_err(|error| error.to_string())?;
            let profile = parent
                .child("LanTransfers", true)
                .map_err(|error| error.to_string())?;
            let mut store = StateStore::open(profile.path())?;
            store.restore_transient(texts)?;
            let identity = Arc::new(store.ensure_identity(&initialization)?);
            Ok::<_, String>((store, identity))
        })
        .await
        .map_err(|error| error.to_string())??;
        self.ready()?;
        if cancel.is_cancelled() || renderer.is_some_and(CancellationToken::is_cancelled) {
            return Err(CLOSED.into());
        }
        let downloads = if test_local {
            self.root.join("Downloads")
        } else {
            self.app
                .path()
                .download_dir()
                .map_err(|error| error.to_string())?
        };
        let queue = Queue::start(
            Arc::new(NativeUi {
                app: self.app.clone(),
                session: cancel.clone(),
            }),
            downloads,
            Duration::from_secs(120),
        )?;
        {
            let mut admission = self.admission.lock().map_err(|error| error.to_string())?;
            if admission.revision != revision {
                queue.cancel();
            }
            admission.queue = Some(queue.clone());
        }
        let name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "DustDesk".into());
        let receiver =
            match Receiver::start_owned(store, identity.clone(), name, Arc::new(queue.clone()))
                .await
            {
                Ok(receiver) => receiver,
                Err(error) => {
                    let _ = queue.stop().await;
                    return Err(error);
                }
            };
        {
            let mut admission = self.admission.lock().map_err(|error| error.to_string())?;
            if admission.revision != revision || cancel.is_cancelled() {
                receiver.cancel();
            }
            admission.receiver = Some(receiver.clone());
        }
        let server = match Server::bind(
            identity,
            SocketAddrV4::new(
                if test_local {
                    Ipv4Addr::LOCALHOST
                } else {
                    Ipv4Addr::UNSPECIFIED
                },
                0,
            ),
            Limits::default(),
            Arc::new(receiver.clone()),
        )
        .await
        {
            Ok(server) => server,
            Err(error) => {
                let _ = receiver.stop().await;
                let _ = queue.stop().await;
                return Err(error);
            }
        };
        receiver.set_port(server.address().port());
        self.texts.clear();
        self.session = Some(Session {
            receiver,
            server,
            queue,
            cancel: cancel.clone(),
        });
        let result: Result<(), String> = async {
            self.ready()?;
            if cancel.is_cancelled() || renderer.is_some_and(CancellationToken::is_cancelled) {
                return Err(CLOSED.into());
            }
            let session = self.session.as_ref().ok_or(CLOSED)?;
            session.receiver.set_enabled(true).await?;
            // UDP failure remains a visible warning; manual TLS still works.
            self.snapshot.error = session
                .receiver
                .start_discovery(if test_local {
                    discovery::Config {
                        bind: None,
                        targets: Some(Vec::new()),
                        ..Default::default()
                    }
                } else {
                    discovery::Config::default()
                })
                .await
                .err();
            if cancel.is_cancelled() || renderer.is_some_and(CancellationToken::is_cancelled) {
                return Err(CLOSED.into());
            }
            Ok(())
        }
        .await;
        if let Err(error) = result {
            let cleanup = self.stop().await.err();
            return Err(cleanup.map_or(error.clone(), |cleanup| format!("{error}；{cleanup}")));
        }
        Ok(())
    }
    async fn stop(&mut self) -> Result<(), String> {
        let Some(session) = self.session.take() else {
            return Ok(());
        };
        session.cancel.cancel();
        session.queue.cancel();
        session.receiver.cancel();
        // Revoke before any await. Text handoff occurs after the real worker
        // exits, never through a snapshot queued behind disk preparation.
        let (server, receiver, queue) = tokio::join!(
            session.server.stop(),
            session.receiver.stop(),
            session.queue.stop()
        );
        self.snapshot.tasks = session.receiver.views();
        self.texts = session.receiver.take_stopped_texts();
        if let Ok(mut admission) = self.admission.lock() {
            admission.receiver = None;
            admission.queue = None;
            admission.cancel = None;
        }
        self.snapshot.enabled = false;
        self.snapshot.devices.clear();
        self.snapshot.addresses.clear();
        self.snapshot.port = 0;
        let errors = [server.err(), receiver.err(), queue.err()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("；"))
        }
    }
    async fn disable(&mut self) -> Result<(), String> {
        // A failed settings save must never skip actual listener/file cleanup.
        let stopped = self.stop().await;
        let persisted = if self.root.join("LanTransfers").exists() {
            let root = self.root.join("LanTransfers");
            tokio::task::spawn_blocking(move || {
                let mut store = StateStore::open(&root)?;
                let mut state = store.state().clone();
                state.enabled = false;
                store.commit(state)
            })
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result)
        } else {
            Ok(())
        };
        let errors = [stopped.err(), persisted.err()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        if errors.is_empty() {
            self.snapshot.error = None;
            Ok(())
        } else {
            Err(errors.join("；"))
        }
    }
    async fn control(
        &mut self,
        id: &str,
        action: &str,
        renderer: CancellationToken,
    ) -> Result<(), String> {
        self.ready()?;
        if renderer.is_cancelled() {
            return Err(CLOSED.into());
        }
        if !matches!(action, "pause" | "resume" | "cancel" | "clear") {
            return Err("任务操作无效".into());
        }
        if let Some(session) = &self.session {
            let client = Client {
                receiver: session.receiver.clone(),
                cancel: session.cancel.clone(),
                renderer,
            };
            return client.run(control(&client.receiver, id, action)).await;
        }
        if action == "resume" {
            return Err("请先开启局域网传输".into());
        }
        let revision = self
            .admission
            .lock()
            .map_err(|error| error.to_string())?
            .revision;
        let cancel = self.begin(revision)?;
        let root = self.root.join("LanTransfers");
        let texts = self.texts.clone();
        let (store, identity) = tokio::task::spawn_blocking(move || {
            let mut store = StateStore::open(&root)?;
            store.restore_transient(texts)?;
            let identity = Arc::new(Identity::load(&root)?.ok_or("设备身份缺失")?);
            Ok::<_, String>((store, identity))
        })
        .await
        .map_err(|error| error.to_string())??;
        let receiver = Receiver::start_owned(
            store,
            identity,
            "DustDesk".into(),
            Arc::new(OfflineApprovals),
        )
        .await?;
        let client = Client {
            receiver: receiver.clone(),
            cancel,
            renderer,
        };
        let result = client.run(control(&receiver, id, action)).await;
        let cleanup = receiver.stop().await;
        self.snapshot.tasks = receiver.views();
        self.texts = receiver.take_stopped_texts();
        result.and(cleanup)
    }
    async fn refresh(&mut self) -> Snapshot {
        if let Some(session) = &self.session {
            let status = session.receiver.discovery_status().await;
            self.snapshot.enabled = !session.cancel.is_cancelled();
            self.snapshot.port = if self.snapshot.enabled {
                session.server.address().port()
            } else {
                0
            };
            self.snapshot.devices = session.receiver.devices().await;
            self.snapshot.tasks = session.receiver.views();
            self.snapshot.addresses = status
                .adapters
                .iter()
                .map(|adapter| adapter.address.to_string())
                .collect();
            if status.error.is_some() {
                self.snapshot.error = status.error;
            }
        }
        self.snapshot.clone()
    }
    async fn publish(&mut self) {
        let snapshot = self.refresh().await;
        if let Ok(value) = serde_json::to_value(&snapshot) {
            if self.published.as_ref() != Some(&value) {
                let _ = crate::events::emit(
                    &self.app,
                    "workspace-main",
                    "runtime:onLanChanged",
                    (snapshot,),
                );
                self.published = Some(value);
            }
        }
    }
    async fn run(mut self, mut receive: mpsc::Receiver<Command>) {
        let mut tick = tokio::time::interval(Duration::from_millis(500));
        loop {
            let command = tokio::select! {
                command = receive.recv() => match command { Some(command) => command, None => break },
                _ = tick.tick() => { self.publish().await; continue; }
            };
            match command {
                Command::Snapshot(reply) => {
                    let result = if self.session.is_none() {
                        self.load().await.map(|_| ())
                    } else {
                        Ok(())
                    };
                    let snapshot = self.refresh().await;
                    let _ = reply.send(result.map(|_| snapshot));
                }
                Command::Enable {
                    enabled,
                    revision,
                    renderer,
                    reply,
                } => {
                    let result = if !enabled {
                        // Already admitted native user intent completes even if
                        // navigation cancels the waiting renderer afterwards.
                        self.disable().await
                    } else if renderer.is_cancelled() {
                        Err(CLOSED.into())
                    } else if let Err(error) = self.ready() {
                        Err(error)
                    } else {
                        self.start(revision, Some(&renderer)).await
                    };
                    if let Err(error) = &result {
                        self.snapshot.error = Some(error.clone());
                    }
                    let snapshot = self.refresh().await;
                    let _ = reply.send(result.map(|_| snapshot));
                }
                Command::Restore(revision) => {
                    if self.ready().is_ok() && self.session.is_none() {
                        let result = match self.load().await {
                            Ok(state) if state.enabled => self.start(revision, None).await,
                            Ok(_) => Ok(()),
                            Err(error) => Err(error),
                        };
                        if let Err(error) = result {
                            self.snapshot.error = Some(error);
                        }
                    }
                }
                Command::Suspend(reply) => {
                    let _ = reply.send(self.stop().await);
                }
                Command::Client(renderer, reply) => {
                    let result = self.ready().and_then(|()| {
                        if renderer.is_cancelled() {
                            return Err(CLOSED.into());
                        }
                        let session = self
                            .session
                            .as_ref()
                            .filter(|session| !session.cancel.is_cancelled())
                            .ok_or("请先开启局域网传输")?;
                        Ok(Client {
                            receiver: session.receiver.clone(),
                            cancel: session.cancel.clone(),
                            renderer,
                        })
                    });
                    let _ = reply.send(result);
                }
                Command::Control {
                    id,
                    action,
                    renderer,
                    reply,
                } => {
                    let _ = reply.send(self.control(&id, &action, renderer).await);
                }
            }
            self.publish().await;
        }
        let _ = self.stop().await;
    }
}
impl Client {
    async fn run<T>(
        &self,
        job: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        tokio::select! { biased;
            _ = self.cancel.cancelled() => Err(CLOSED.into()),
            _ = self.renderer.cancelled() => Err("主窗口页面已失效".into()),
            result = job => result,
        }
    }
}
async fn control(receiver: &Receiver, id: &str, action: &str) -> Result<(), String> {
    let receive = receiver
        .views()
        .iter()
        .find(|task| task.id == id)
        .ok_or("任务不存在")?
        .direction
        == Direction::Receive;
    if receive {
        receiver.control_receive(id, action).await
    } else if action == "resume" {
        receiver.resume_send(id).await
    } else {
        receiver.control_send(id, action).await.map(|_| ())
    }
}
#[tauri::command]
pub fn toolbox_lan_attach(app: tauri::AppHandle, window: WebviewWindow) -> Result<String, String> {
    crate::toolbox::require_active(&app, &window)?;
    let service = app.state::<Service>();
    let mut admission = service
        .admission
        .lock()
        .map_err(|error| error.to_string())?;
    admission.reset_renderer();
    admission.renderer_nonce = uuid::Uuid::new_v4().to_string();
    Ok(admission.renderer_nonce.clone())
}
#[tauri::command]
pub async fn toolbox_lan_snapshot(
    app: tauri::AppHandle,
    window: WebviewWindow,
    lease: String,
) -> Result<Snapshot, String> {
    crate::toolbox::require_active(&app, &window)?;
    app.state::<Service>().renderer(&lease)?;
    app.state::<Service>().submit(Command::Snapshot).await
}
#[tauri::command]
pub async fn toolbox_lan_enable(
    app: tauri::AppHandle,
    window: WebviewWindow,
    lease: String,
    enabled: bool,
) -> Result<Snapshot, String> {
    crate::toolbox::require_active(&app, &window)?;
    let service = app.state::<Service>();
    let (renderer, revision) = service.enable_lease(&lease, enabled)?;
    service
        .submit(|reply| Command::Enable {
            enabled,
            revision,
            renderer,
            reply,
        })
        .await
}
#[tauri::command]
pub async fn toolbox_lan_connect(
    app: tauri::AppHandle,
    window: WebviewWindow,
    lease: String,
    address: String,
    port: u16,
) -> Result<Device, String> {
    crate::toolbox::require_active(&app, &window)?;
    let client = app.state::<Service>().client(&lease).await?;
    crate::toolbox::require_active(&app, &window)?;
    client
        .run(client.receiver.connect_device(&address, port, None))
        .await
}
#[tauri::command]
pub async fn toolbox_lan_send(
    app: tauri::AppHandle,
    window: WebviewWindow,
    lease: String,
    device: String,
    assets: Vec<String>,
    text: Option<String>,
) -> Result<(), String> {
    crate::toolbox::require_active(&app, &window)?;
    let grants = app.state::<crate::toolbox::transfer_assets::Service>();
    let paths = grants.paths(grants.epoch()?, &assets)?;
    let client = app.state::<Service>().client(&lease).await?;
    crate::toolbox::require_active(&app, &window)?;
    client
        .run(client.receiver.send_local(device, paths, text))
        .await
        .map(|_| ())
}
#[tauri::command]
pub async fn toolbox_lan_control(
    app: tauri::AppHandle,
    window: WebviewWindow,
    lease: String,
    id: String,
    action: String,
) -> Result<(), String> {
    crate::toolbox::require_active(&app, &window)?;
    let service = app.state::<Service>();
    let renderer = service.renderer(&lease)?;
    service
        .submit(|reply| Command::Control {
            id,
            action,
            renderer,
            reply,
        })
        .await
}
