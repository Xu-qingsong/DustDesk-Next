//! Debug-only loopback integration driver. Uses compiled official source trust,
//! real runtime ownership and LAN recovery, with explicit stdin UI decisions.
#[cfg(windows)]
mod driver {
    use dustdesk_tauri::{
        lan::{
            migration::service::Services,
            protocol::Device,
            receiver::{Approvals, Decision, ReceivePrompt},
        },
        legacy_source::binding::{BoundSource, Locations},
    };
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::{
        collections::HashMap,
        io::{BufRead, Write},
        net::{Ipv4Addr, SocketAddrV4},
        path::PathBuf,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc, Mutex,
        },
    };
    use tokio_util::sync::CancellationToken;

    fn emit(value: Value) {
        let mut output = std::io::stdout().lock();
        writeln!(output, "{value}").unwrap();
        output.flush().unwrap();
    }

    struct Decisions {
        next: AtomicU64,
        pending: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<bool>>>,
        downloads: PathBuf,
    }
    struct Pending {
        decisions: Arc<Decisions>,
        id: u64,
    }
    impl Drop for Pending {
        fn drop(&mut self) {
            self.decisions.pending.lock().unwrap().remove(&self.id);
            emit(json!({"event":"decisionClosed","request":self.id}));
        }
    }
    impl Decisions {
        fn ask(self: &Arc<Self>, mut prompt: Value) -> Decision<bool> {
            let id = self.next.fetch_add(1, Ordering::SeqCst);
            let (send, receive) = tokio::sync::oneshot::channel();
            self.pending.lock().unwrap().insert(id, send);
            let guard = Pending {
                decisions: self.clone(),
                id,
            };
            prompt["request"] = id.into();
            emit(prompt);
            Box::pin(async move {
                let _guard = guard;
                receive.await.map_err(|_| "decision canceled".into())
            })
        }
    }
    struct Approval(Arc<Decisions>);
    impl Approvals for Approval {
        fn pair(&self, peer: Device, code: String) -> Decision<bool> {
            self.0.ask(json!({"event":"pair","peer":peer,"code":code}))
        }
        fn receive(&self, prompt: ReceivePrompt) -> Decision<Option<PathBuf>> {
            let root = prompt
                .existing_directory
                .clone()
                .unwrap_or_else(|| self.0.downloads.clone());
            if !root.starts_with(&self.0.downloads) {
                return Box::pin(async { Err("receive path outside isolated downloads".into()) });
            }
            let choice = self.0.ask(json!({"event":"receive","peer":prompt.peer,"manifest":prompt.manifest,"existing":prompt.existing_directory}));
            Box::pin(async move { Ok(choice.await?.then_some(root)) })
        }
    }

    fn input() -> (
        std::thread::JoinHandle<()>,
        tokio::sync::mpsc::UnboundedReceiver<Value>,
    ) {
        let (send, receive) = tokio::sync::mpsc::unbounded_channel();
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
        (reader, receive)
    }

    async fn hold_handback(
        owner: &mut dustdesk_tauri::legacy_source::binding::snapshot::RuntimeOwner,
        input: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
    ) -> Result<(), String> {
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(200));
        loop {
            tokio::select! {
                _ = tick.tick() => owner.confirm()?,
                value = input.recv() => match value {
                    None => return owner.verify(),
                    Some(value) if value["command"] == "stop" => return owner.verify(),
                    _ => return Err("handback accepts only explicit stop or EOF".into()),
                }
            }
        }
    }

    pub(super) async fn run() -> Result<(), String> {
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        if !cfg!(debug_assertions) || (args.len() != 3 && args.len() != 6) {
            return Err("Debug driver requires TEMP root, official reference and --prepare or --resume with three original IDs".into());
        }
        let root = PathBuf::from(&args[0]);
        if root.parent() != Some(std::env::temp_dir().as_path())
            || !root.file_name().is_some_and(|name| {
                name.to_string_lossy()
                    .starts_with("dustdesk-runtime-preview-")
            })
        {
            return Err("only direct dedicated TEMP roots are accepted".into());
        }
        let profile = root.join("Profile");
        let data = root.join("Data");
        let bytes =
            std::fs::read(data.join("workspace.json")).map_err(|error| error.to_string())?;
        let workspace_sha256 = format!("{:x}", Sha256::digest(&bytes));
        let cancel = CancellationToken::new();
        let source = BoundSource::open(
            Locations {
                installation: PathBuf::from(&args[1]),
                data,
                user_data: profile.clone(),
                browser_profile: profile,
                workspace_sha256: workspace_sha256.clone(),
            },
            &cancel,
            || Ok(()),
        )?;
        let mut source = source.freeze(&cancel, || Ok(()))?;
        let (mut owner, preparation_id, runtime_id) = if args[2] == "--prepare" && args.len() == 3 {
            let payload = json!({"id":uuid::Uuid::new_v4().to_string(),"createdAt":"2026-11-13T04:00:00.000Z",
                "source":{"runtime":"electron","appVersion":"1.0.2","workspaceFingerprint":workspace_sha256},
                "entries":[{"key":"widget-task-draft:v1:todo","value":"{\"title\":\"LAN recovery fixture\"}"}]}).to_string();
            let archive = json!({"format":"dustdesk-browser-drafts","version":1,"sha256":format!("{:x}",Sha256::digest(payload.as_bytes())),"payload":payload}).to_string();
            let preparation = source.prepare(
                &root.join("Snapshot"),
                &uuid::Uuid::new_v4().to_string(),
                archive.as_bytes(),
                &cancel,
                || Ok(()),
            )?;
            let runtime = source.prepare_runtime(
                &preparation.id,
                &root.join("RuntimeData"),
                &cancel,
                || Ok(()),
            )?;
            let owner = source.claim_runtime(&preparation.id, &runtime.id, &cancel, || Ok(()))?;
            (owner, preparation.id, runtime.id)
        } else if (args[2] == "--resume" || args[2] == "--resume-handback") && args.len() == 6 {
            let ids = args[3..]
                .iter()
                .map(|value| {
                    value
                        .to_str()
                        .map(str::to_owned)
                        .ok_or("invalid ID".to_owned())
                })
                .collect::<Result<Vec<_>, _>>()?;
            let owner = if args[2] == "--resume-handback" {
                source.resume_runtime_for_original_lan_handback(
                    &ids[0],
                    &ids[1],
                    &ids[2],
                    &cancel,
                    || Ok(()),
                )?
            } else {
                source.resume_runtime_with_original_lan(
                    &ids[0],
                    &ids[1],
                    &ids[2],
                    &cancel,
                    || Ok(()),
                )?
            };
            (owner, ids[0].clone(), ids[1].clone())
        } else {
            return Err("invalid driver action".into());
        };
        if args[2] == "--resume-handback" {
            let receipt = owner.resume_original_lan_handback_preview(|| Ok(()))?;
            emit(json!({"event":"handbackReady", "receipt":receipt}));
            let (reader, mut input) = input();
            let result = hold_handback(&mut owner, &mut input).await;
            if reader.is_finished() {
                reader.join().map_err(|_| "stdin reader failed")?;
            }
            return result;
        }
        let (store, identity) = if args[2] == "--prepare" {
            owner.prepare_original_lan_preview(|| Ok(()))?
        } else {
            owner.resume_original_lan_preview(|| Ok(()))?
        };
        let decisions = Arc::new(Decisions {
            next: AtomicU64::new(1),
            pending: Mutex::default(),
            downloads: root.join("Downloads"),
        });
        let services = Services::start(
            store,
            identity.clone(),
            "Original LAN recovery fixture".into(),
            SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0),
            Arc::new(Approval(decisions.clone())),
        )
        .await?;
        let receiver = services.receiver();
        let binding = serde_json::to_value(owner.binding()).map_err(|error| error.to_string())?;
        let data_identity = &binding["dataIdentity"];
        let handback_record = root
            .join("Profile/LegacySnapshotPreparation")
            .join(format!(
                "{:016x}-{}",
                data_identity["volume"].as_u64().ok_or("missing volume")?,
                data_identity["index"]
                    .as_str()
                    .ok_or("missing native index")?
            ))
            .join(&preparation_id)
            .join("RuntimePreparation")
            .join(&runtime_id)
            .join("Ownership")
            .join(&owner.receipt().id)
            .join("OriginalLan/Handback");
        emit(
            json!({"event":"ready","port":services.address().port(),"deviceId":identity.id,"fingerprint":identity.fingerprint,
            "preparationId":preparation_id,"runtimeId":runtime_id,"ownershipId":owner.receipt().id,
            "handbackRecord":handback_record,
            "productionReady":false,"migrationComplete":false}),
        );
        let (reader, mut input) = input();
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(200));
        let mut failure = None;
        let mut handback = None;
        loop {
            tokio::select! {
                _ = tick.tick() => {
                    if let Err(error) = owner.confirm() { failure = Some(error); break; }
                }
                value = input.recv() => {
                    let Some(value) = value else { break };
                    match value["command"].as_str() {
                        Some("approve") => {
                            if let Some(send) = value["request"].as_u64().and_then(|id| decisions.pending.lock().unwrap().remove(&id)) {
                                let _ = send.send(value["accept"] == true);
                            }
                        }
                        Some("snapshot") => {
                            let result = receiver.snapshot().await;
                            emit(match result { Ok(state) => json!({"id":value["id"],"ok":true,"state":state}), Err(error) => json!({"id":value["id"],"ok":false,"error":error}) });
                        }
                        Some("progress") => emit(json!({"id":value["id"],"ok":true,"views":receiver.views()})),
                        Some("verify") => {
                            let result = owner.verify();
                            emit(match result { Ok(()) => json!({"id":value["id"],"ok":true}), Err(error) => json!({"id":value["id"],"ok":false,"error":error}) });
                        }
                        Some("stop") => break,
                        Some("handback") => { handback = Some(value); break; },
                        _ => { failure = Some("unknown driver command".into()); break; }
                    }
                }
            }
        }
        let drained = services.stop().await?;
        if let Some(command) = handback {
            let receipt = owner.finish_original_lan_preview(&drained, || {
                let boundary = command["interruptAt"].as_str();
                if let Some(boundary @ ("intent" | "decision")) = boundary {
                    if handback_record.join(format!("{boundary}.json")).exists() {
                        emit(json!({"event":"handbackBoundary", "boundary":boundary}));
                        loop {
                            std::thread::park();
                        }
                    }
                }
                Ok(())
            })?;
            emit(json!({"event":"handbackReady", "receipt":receipt}));
            hold_handback(&mut owner, &mut input).await?;
        }
        // Normal stop/EOF has ended the input reader. On supervision failure,
        // stdin may still be held by the client: do not block joining its read.
        if reader.is_finished() {
            reader.join().map_err(|_| "stdin reader failed")?;
        }
        drop(owner);
        emit(json!({"event":"stopped","productionReady":false,"migrationComplete":false}));
        failure.map_or(Ok(()), Err)
    }
}

#[cfg(windows)]
fn main() -> Result<(), String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?
        .block_on(driver::run())
}
#[cfg(not(windows))]
fn main() {
    panic!("Windows-only driver")
}
