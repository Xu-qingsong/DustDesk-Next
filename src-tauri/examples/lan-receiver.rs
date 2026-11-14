//! Development-only service host. Native UI is replaced by explicit stdin
//! decisions, not automatic approval. No desktop IPC or production paths.
#[cfg(windows)]
fn main() -> Result<(), String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(run())
}
#[cfg(not(windows))]
fn main() {
    panic!("Windows-only receiver driver");
}

#[cfg(windows)]
fn emit(value: serde_json::Value) {
    use std::io::Write;
    let mut output = std::io::stdout().lock();
    writeln!(output, "{value}").unwrap();
    output.flush().unwrap();
}
#[cfg(windows)]
struct Decisions {
    next: std::sync::atomic::AtomicU64,
    pending: std::sync::Mutex<
        std::collections::HashMap<u64, tokio::sync::oneshot::Sender<serde_json::Value>>,
    >,
    downloads: std::path::PathBuf,
}
#[cfg(windows)]
struct Pending {
    decisions: std::sync::Arc<Decisions>,
    id: u64,
}
#[cfg(windows)]
impl Drop for Pending {
    fn drop(&mut self) {
        self.decisions.pending.lock().unwrap().remove(&self.id);
        emit(serde_json::json!({"event":"decision-closed","request":self.id}));
    }
}
#[cfg(windows)]
impl Decisions {
    fn ask(
        self: &std::sync::Arc<Self>,
        mut prompt: serde_json::Value,
    ) -> dustdesk_tauri::lan::receiver::Decision<serde_json::Value> {
        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (send, receive) = tokio::sync::oneshot::channel();
        self.pending.lock().unwrap().insert(id, send);
        let guard = Pending {
            decisions: self.clone(),
            id,
        };
        prompt["request"] = serde_json::json!(id);
        emit(prompt);
        Box::pin(async move {
            let _guard = guard;
            receive.await.map_err(|_| "decision canceled".into())
        })
    }
}
#[cfg(windows)]
struct Approval(std::sync::Arc<Decisions>);
#[cfg(windows)]
impl dustdesk_tauri::lan::receiver::Approvals for Approval {
    fn pair(
        &self,
        peer: dustdesk_tauri::lan::protocol::Device,
        code: String,
    ) -> dustdesk_tauri::lan::receiver::Decision<bool> {
        let choice = self
            .0
            .ask(serde_json::json!({"event":"pair","peer":peer,"code":code}));
        Box::pin(async move { Ok(choice.await?["accept"] == true) })
    }
    fn receive(
        &self,
        prompt: dustdesk_tauri::lan::receiver::ReceivePrompt,
    ) -> dustdesk_tauri::lan::receiver::Decision<Option<std::path::PathBuf>> {
        let choice = self.0.ask(serde_json::json!({"event":"receive","peer":prompt.peer,"manifest":prompt.manifest,"existing":prompt.existing_directory}));
        let root = prompt
            .existing_directory
            .unwrap_or_else(|| self.0.downloads.clone());
        Box::pin(async move {
            let choice = choice.await?;
            Ok((choice["accept"] == true).then(|| {
                choice["directory"]
                    .as_str()
                    .map(std::path::PathBuf::from)
                    .unwrap_or(root)
            }))
        })
    }
}

#[cfg(windows)]
async fn run() -> Result<(), String> {
    use dustdesk_tauri::lan::{
        receiver::Receiver,
        storage::Identity,
        transport::{Limits, Server},
    };
    use serde_json::{json, Value};
    use std::{
        io::BufRead,
        net::{Ipv4Addr, SocketAddrV4},
        path::PathBuf,
        sync::{atomic::AtomicU64, Arc, Mutex},
    };
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 && !(args.len() == 3 && args[2] == "--create-identity") {
        return Err(
            "expected isolated profile and downloads arguments, optionally --create-identity"
                .into(),
        );
    }
    let profile = PathBuf::from(&args[0]);
    let downloads = PathBuf::from(&args[1]);
    let identity = if args.len() == 3 {
        let path = profile.clone();
        // Explicit fixture initialization only. The blocking job is joined;
        // no production path is created or selected by this driver.
        Arc::new(
            tokio::task::spawn_blocking(move || {
                dustdesk_tauri::lan::state_store::StateStore::open(&path)?
                    .ensure_identity(&tokio_util::sync::CancellationToken::new())
            })
            .await
            .map_err(|_| "identity initialization interrupted")??,
        )
    } else {
        Arc::new(Identity::load(&profile)?.ok_or("identity must already exist")?)
    };
    let decisions = Arc::new(Decisions {
        next: AtomicU64::new(1),
        pending: Mutex::default(),
        downloads: downloads.clone(),
    });
    let receiver = Receiver::start(
        profile.clone(),
        identity.clone(),
        "Rust receiver fixture".into(),
        Arc::new(Approval(decisions.clone())),
    )
    .await?;
    let server = Server::bind(
        identity.clone(),
        SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0),
        Limits::default(),
        Arc::new(receiver.clone()),
    )
    .await?;
    receiver.set_port(server.address().port());
    emit(
        json!({"event":"ready","port":server.address().port(),"fingerprint":identity.fingerprint,"device":identity.id}),
    );
    let (send, mut input) = tokio::sync::mpsc::unbounded_channel();
    let reader = std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                break;
            };
            let stop = value["command"] == "stop";
            if send.send(value).is_err() || stop {
                break;
            }
        }
    });
    let mut tasks = tokio::task::JoinSet::new();
    let mut state_lock = None;
    while let Some(value) = input.recv().await {
        match value["command"].as_str() {
            Some("approve") => {
                if let Some(send) = decisions
                    .pending
                    .lock()
                    .unwrap()
                    .remove(&value["request"].as_u64().unwrap_or(0))
                {
                    let _ = send.send(value);
                }
            }
            Some("snapshot") => {
                let receiver = receiver.clone();
                tasks.spawn(async move {
                    match receiver.snapshot().await {
                        Ok(state) => emit(json!({"id":value["id"],"ok":true,"state":state})),
                        Err(error) => emit(json!({"id":value["id"],"ok":false,"error":error})),
                    }
                });
            }
            Some(
                "connect" | "send" | "control-send" | "discovery-start" | "discovery-stop"
                | "discovery",
            ) => {
                let receiver = receiver.clone();
                tasks.spawn(async move {
                    let result = async {
                        match value["command"].as_str().unwrap() {
                            "discovery-start" => {
                                use dustdesk_tauri::lan::discovery::Config;
                                let bind = if value["udp"] == false { None } else { Some(value["bind"].as_str().unwrap_or("127.0.0.1:0").parse().map_err(|_| "bad UDP bind")?) };
                                let targets = value.get("targets").map(|targets| targets.as_array().ok_or("bad targets")?.iter().map(|target| target.as_str().ok_or("bad target")?.parse().map_err(|_| "bad target")).collect::<Result<Vec<_>, _>>()).transpose()?;
                                let defaults = Config::default();
                                receiver.start_discovery(Config { bind, targets: Some(targets.unwrap_or_default()), cadence: value["cadenceMs"].as_u64().map(std::time::Duration::from_millis).unwrap_or(defaults.cadence), timeout: value["timeoutMs"].as_u64().map(std::time::Duration::from_millis).unwrap_or(defaults.timeout), ttl: value["ttlMs"].as_u64().map(std::time::Duration::from_millis).unwrap_or(defaults.ttl), reuse_address: value["reuse"] == true }).await?;
                                Ok(json!({"status":receiver.discovery_status().await,"devices":receiver.devices().await}))
                            },
                            "discovery-stop" => { receiver.stop_discovery().await?; Ok(json!({})) },
                            "discovery" => Ok(json!({"status":receiver.discovery_status().await,"devices":receiver.devices().await})),
                            "connect" => {
                                let expected = if value.get("expected").is_some() { Some(serde_json::from_value(value["expected"].clone()).map_err(|_| "bad expected peer")?) } else { None };
                                let port = value["port"].as_u64().and_then(|port| u16::try_from(port).ok()).ok_or("bad port")?;
                                serde_json::to_value(receiver.connect_device(value["address"].as_str().ok_or("missing address")?, port, expected).await?).map_err(|e| e.to_string())
                            },
                            "send" => {
                                let paths = value["paths"].as_array().ok_or("missing paths")?.iter().map(|path| path.as_str().map(PathBuf::from).ok_or("bad path")).collect::<Result<Vec<_>, _>>()?;
                                let text = value.get("text").map(|text| text.as_str().map(str::to_owned).ok_or("bad text")).transpose()?;
                                Ok(json!({"task":receiver.send_local(value["peer"].as_str().ok_or("missing peer")?.to_owned(), paths, text).await?}))
                            },
                            "control-send" => {
                                let task = value["task"].as_str().ok_or("missing task")?; let action = value["action"].as_str().ok_or("missing action")?;
                                if action == "resume" { receiver.resume_send(task).await?; Ok(json!({})) }
                                else { Ok(json!({"remoteError":receiver.control_send(task, action).await?})) }
                            },
                            _ => unreachable!(),
                        }
                    }.await;
                    emit(match result { Ok(result) => json!({"id":value["id"],"ok":true,"value":result}), Err(error) => json!({"id":value["id"],"ok":false,"error":error}) });
                });
            }
            Some("progress") => emit(json!({"id":value["id"],"ok":true,"views":receiver.views()})),
            Some("state-lock") => {
                use std::os::windows::fs::OpenOptionsExt;
                state_lock = Some(
                    std::fs::OpenOptions::new()
                        .read(true)
                        .share_mode(1)
                        .open(profile.join("state.json"))
                        .map_err(|e| e.to_string())?,
                );
                emit(json!({"id":value["id"],"ok":true}));
            }
            Some("state-unlock") => {
                drop(state_lock.take());
                emit(json!({"id":value["id"],"ok":true}));
            }
            Some("stop") => break,
            _ => {}
        }
        while tasks.try_join_next().is_some() {}
    }
    drop(state_lock);
    let (network, files) = tokio::join!(server.stop(), receiver.stop());
    while tasks.join_next().await.is_some() {}
    reader.join().map_err(|_| "stdin thread failed")?;
    network?;
    files?;
    // The Receiver is deliberately still alive here. DELETE-access directory
    // opens prove that stopped sessions released their deny-delete pins.
    use std::os::windows::fs::OpenOptionsExt;
    let directories = receiver
        .views()
        .into_iter()
        .filter_map(|view| view.directory)
        .map(PathBuf::from)
        .collect::<std::collections::HashSet<_>>();
    for directory in directories.iter().chain(std::iter::once(&profile)) {
        if directory != &profile && !directory.starts_with(&downloads) {
            return Err("fixture release check outside approved root".into());
        }
        std::fs::OpenOptions::new()
            .access_mode(0x0001_0080)
            .share_mode(7)
            .custom_flags(0x0220_0000)
            .open(directory)
            .map_err(|e| format!("directory pin retained after joined stop: {e}"))?;
    }
    emit(
        json!({"event":"stopped","pending":decisions.pending.lock().unwrap().len(),"releaseVerified":true,"checkedDirectories":directories.len()+1}),
    );
    Ok(())
}
