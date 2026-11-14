//! Development-only network driver; no commands are exposed by the desktop
//! app. Pair/receive decisions here are test fixtures, not native product UI.
use dustdesk_tauri::lan::{
    protocol::{Device, MAX_JSON_BYTES},
    storage::Identity,
    transport::{self, Client, Handler, HandlerFuture, Limits, Peer, Server},
};
use http_body_util::BodyExt;
use hyper::{body::Incoming, Request, StatusCode};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::{self, BufRead, Write},
    net::{Ipv4Addr, SocketAddrV4},
    path::Path,
    sync::{
        atomic::{AtomicU16, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

fn emit(value: Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}
struct State {
    id: String,
    port: AtomicU16,
    calls: AtomicU64,
    next: AtomicU64,
    trusted: Mutex<HashSet<String>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<bool>>>,
}
struct Pending {
    state: Arc<State>,
    id: u64,
}
impl Drop for Pending {
    fn drop(&mut self) {
        self.state.pending.lock().unwrap().remove(&self.id);
    }
}
struct Fixture(Arc<State>);
impl Handler for Fixture {
    fn trusted(&self, fp: &str) -> bool {
        self.0.trusted.lock().unwrap().contains(fp)
    }
    fn handle(&self, peer: Peer, mut request: Request<Incoming>) -> HandlerFuture {
        let state = self.0.clone();
        state.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            let path = request.uri().path().to_owned();
            let value = match path.as_str() {
                "/hello" => {
                    json!({"protocol":1,"id":state.id,"name":"Rust transport fixture","port":state.port.load(Ordering::SeqCst)})
                }
                "/pair" => {
                    let body =
                        transport::read_json(request.body_mut(), 4096, &peer.cancellation).await?;
                    if state.trusted.lock().unwrap().contains(&peer.fingerprint) {
                        return Ok(transport::json_response(json!({"ok":true}), StatusCode::OK));
                    }
                    let id = state.next.fetch_add(1, Ordering::SeqCst);
                    let (send, receive) = oneshot::channel();
                    state.pending.lock().unwrap().insert(id, send);
                    let _pending = Pending {
                        state: state.clone(),
                        id,
                    };
                    emit(
                        json!({"event":"pair","request":id,"fingerprint":peer.fingerprint,"device":body["id"]}),
                    );
                    let accepted = tokio::select! { biased; _ = peer.cancellation.cancelled() => return Err("fixture pair canceled".into()), value = receive => value.unwrap_or(false) };
                    if !accepted || peer.cancellation.is_cancelled() {
                        return Err("fixture pair declined".into());
                    }
                    state.trusted.lock().unwrap().insert(peer.fingerprint);
                    json!({"ok":true})
                }
                "/file" => {
                    let mut size = 0_u64;
                    let mut hash = Sha256::new();
                    while let Some(frame) = request.body_mut().frame().await {
                        let frame = frame.map_err(|error| error.to_string())?;
                        if let Ok(bytes) = frame.into_data() {
                            size += bytes.len() as u64;
                            hash.update(&bytes);
                        }
                    }
                    // Verifies transport streaming only; no file is published
                    // and no task-token authorization is implemented here.
                    json!({"ok":true,"size":size,"sha256":format!("{:x}",hash.finalize()),"fingerprint":peer.fingerprint})
                }
                _ => {
                    let body = transport::read_json(
                        request.body_mut(),
                        MAX_JSON_BYTES,
                        &peer.cancellation,
                    )
                    .await?;
                    json!({"ok":true,"echo":body,"fingerprint":peer.fingerprint})
                }
            };
            Ok(transport::json_response(value, StatusCode::OK))
        })
    }
}

async fn command(client: Client, value: Value, cancel: CancellationToken) -> Result<Value, String> {
    match value["command"].as_str().ok_or("command missing")? {
        "discover" => Ok(serde_json::to_value(
            client
                .discover(
                    value["address"].as_str().ok_or("address missing")?,
                    value["port"]
                        .as_u64()
                        .ok_or("port missing")?
                        .try_into()
                        .map_err(|_| "invalid port")?,
                    &cancel,
                )
                .await?,
        )
        .unwrap()),
        "hello" => {
            let device: Device =
                serde_json::from_value(value["device"].clone()).map_err(|_| "device invalid")?;
            Ok(serde_json::to_value(client.hello(&device, &cancel).await?).unwrap())
        }
        "json" => {
            let device: Device =
                serde_json::from_value(value["device"].clone()).map_err(|_| "device invalid")?;
            client
                .json(
                    &device,
                    value["path"].as_str().ok_or("path missing")?,
                    value.get("body"),
                    &cancel,
                )
                .await
        }
        "upload" => {
            let device: Device =
                serde_json::from_value(value["device"].clone()).map_err(|_| "device invalid")?;
            let file = std::fs::File::open(value["file"].as_str().ok_or("file missing")?)
                .map_err(|error| error.to_string())?;
            let reader = tokio::fs::File::from_std(file);
            let body = transport::reader_body(reader);
            client
                .upload(
                    &device,
                    value["path"].as_str().ok_or("path missing")?,
                    body,
                    &cancel,
                )
                .await
        }
        _ => Err("unknown command".into()),
    }
}

async fn run(root: &Path) -> Result<(), String> {
    let identity = Arc::new(Identity::load(root)?.ok_or("fixture identity missing")?);
    let state = Arc::new(State {
        id: identity.id.clone(),
        port: AtomicU16::new(0),
        calls: AtomicU64::new(0),
        next: AtomicU64::new(1),
        trusted: Mutex::new(HashSet::new()),
        pending: Mutex::new(HashMap::new()),
    });
    let limits = Limits {
        handshake: Duration::from_millis(800),
        headers: Duration::from_millis(800),
        idle: Duration::from_millis(1500),
        connections: 4,
        ..Limits::default()
    };
    let client = Client::new(identity.clone(), limits)?;
    let server = Server::bind(
        identity.clone(),
        SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0),
        limits,
        Arc::new(Fixture(state.clone())),
    )
    .await?;
    state.port.store(server.address().port(), Ordering::SeqCst);
    let (send, mut receive) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if send.send(line).is_err() {
                break;
            }
        }
    });
    emit(
        json!({"event":"ready","port":server.address().port(),"id":identity.id,"fingerprint":identity.fingerprint}),
    );
    let mut commands = HashMap::<String, CancellationToken>::new();
    let mut tasks = tokio::task::JoinSet::new();
    while let Some(line) = receive.recv().await {
        let value: Value = serde_json::from_str(&line).map_err(|_| "fixture command invalid")?;
        let id = value["id"].as_str().unwrap_or_default().to_string();
        match value["command"].as_str() {
            Some("stop") => break,
            Some("stats") => emit(
                json!({"id":id,"ok":true,"value":{"calls":state.calls.load(Ordering::SeqCst),"trusted":state.trusted.lock().unwrap().len(),"pending":state.pending.lock().unwrap().len()}}),
            ),
            Some("decision") => {
                let sender = state
                    .pending
                    .lock()
                    .unwrap()
                    .remove(&value["request"].as_u64().unwrap_or(0));
                let sent =
                    sender.is_some_and(|sender| sender.send(value["accepted"] == true).is_ok());
                emit(json!({"id":id,"ok":true,"value":sent}));
            }
            Some("trust") => {
                let mut trusted = state.trusted.lock().unwrap();
                let fp = value["fingerprint"].as_str().unwrap_or_default();
                if value["enabled"] == true {
                    trusted.insert(fp.into());
                } else {
                    trusted.remove(fp);
                }
                emit(json!({"id":id,"ok":true,"value":true}));
            }
            Some("cancel") => {
                let canceled = commands
                    .get(value["target"].as_str().unwrap_or_default())
                    .map(|token| token.cancel());
                emit(json!({"id":id,"ok":true,"value":canceled.is_some()}));
            }
            _ => {
                let cancel = CancellationToken::new();
                commands.insert(id.clone(), cancel.clone());
                let client = client.clone();
                tasks.spawn(async move {
                    let result = command(client, value, cancel).await;
                    emit(match result {
                        Ok(value) => json!({"id":id,"ok":true,"value":value}),
                        Err(error) => json!({"id":id,"ok":false,"error":error}),
                    });
                });
            }
        }
        while tasks.try_join_next().is_some() {}
    }
    for cancel in commands.values() {
        cancel.cancel();
    }
    server.stop().await?;
    while tasks.join_next().await.is_some() {}
    emit(json!({"event":"stopped","pending":state.pending.lock().unwrap().len()}));
    Ok(())
}

fn main() {
    let root = std::env::args_os()
        .nth(1)
        .expect("fixture identity directory required");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    if let Err(error) = runtime.block_on(run(Path::new(&root))) {
        emit(json!({"event":"fatal","error":error}));
        std::process::exit(1);
    }
}
