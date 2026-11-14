use super::binding::{snapshot::FrozenSource, Binding, BoundSource, Locations};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{self, BufRead, Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

const MAX_LINE: u64 = 64 * 1024;
const MAX_DRAFTS: usize = 64 * 1024 * 1024;

#[cfg(debug_assertions)]
fn runtime_destination(
    root: Option<&PathBuf>,
    destination: &std::path::Path,
) -> Result<(), String> {
    if let Some(root) = root {
        let parent = destination
            .parent()
            .ok_or("隔离输出没有父目录")?
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if &parent != root {
            return Err("隔离运行输出必须位于原专用 TEMP 根".into());
        }
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Lease,
    Snapshot,
    #[cfg(debug_assertions)]
    Runtime,
}

impl Mode {
    fn snapshot(self) -> bool {
        self != Self::Lease
    }
}

pub struct RuntimeLaunch {
    pub owner: super::binding::snapshot::RuntimeOwner,
    pub request_id: String,
    pub cancel: CancellationToken,
    pub browser_start: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub original_lan: bool,
    pub lan_start: Arc<AtomicBool>,
    pub stop: CancellationToken,
    pub seal: Arc<AtomicBool>,
    pub client_closed: CancellationToken,
}

enum Source {
    Lease(Box<BoundSource>),
    Snapshot(Box<FrozenSource>),
}

impl Source {
    fn binding(&self) -> &Binding {
        match self {
            Self::Lease(source) => source.binding(),
            Self::Snapshot(source) => source.binding(),
        }
    }
    fn confirm(&mut self, cancel: &CancellationToken) -> Result<(), String> {
        match self {
            Self::Lease(source) => source.confirm(cancel, || Ok(())),
            Self::Snapshot(source) => source.confirm(cancel, || Ok(())),
        }
    }
}

struct DraftUpload {
    bytes: Zeroizing<Vec<u8>>,
    length: usize,
    sha256: String,
}

impl DraftUpload {
    fn new(length: usize, sha256: String) -> Result<Self, String> {
        if length == 0 || length > MAX_DRAFTS || !super::valid_hash(&sha256) {
            return Err("组合快照草稿长度或摘要无效".into());
        }
        let mut bytes = Zeroizing::new(Vec::new());
        bytes
            .try_reserve_exact(length)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            bytes,
            length,
            sha256,
        })
    }
    fn push(&mut self, data: &str) -> Result<usize, String> {
        let chunk = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| "组合快照草稿分块编码无效")?;
        if chunk.is_empty()
            || chunk.len() > 32 * 1024
            || self
                .bytes
                .len()
                .checked_add(chunk.len())
                .is_none_or(|length| length > self.length)
        {
            return Err("组合快照草稿分块为空或超过声明上限".into());
        }
        self.bytes.extend_from_slice(&chunk);
        Ok(self.bytes.len())
    }
    fn finish(self) -> Result<Zeroizing<Vec<u8>>, String> {
        if self.bytes.len() != self.length
            || format!("{:x}", Sha256::digest(&self.bytes)) != self.sha256
        {
            return Err("组合快照草稿分块未完成或原始摘要不匹配".into());
        }
        Ok(self.bytes)
    }
}

#[derive(Deserialize)]
#[serde(
    deny_unknown_fields,
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Command {
    Open {
        version: u32,
        request_id: String,
        locations: Locations,
    },
    Confirm {
        request_id: String,
    },
    Close {
        request_id: String,
    },
    DraftsBegin {
        request_id: String,
        bytes: usize,
        sha256: String,
    },
    DraftsChunk {
        request_id: String,
        data: String,
    },
    Prepare {
        request_id: String,
        destination: PathBuf,
    },
    VerifyPrepared {
        request_id: String,
        id: String,
    },
    PrepareRuntime {
        request_id: String,
        id: String,
        destination: PathBuf,
    },
    VerifyRuntime {
        request_id: String,
        preparation_id: String,
        id: String,
    },
    QueryRuntime {
        request_id: String,
        id: String,
        after_id: Option<String>,
    },
    #[cfg(debug_assertions)]
    ContinueRuntime {
        request_id: String,
    },
    #[cfg(debug_assertions)]
    StartOriginalLan {
        request_id: String,
    },
    #[cfg(debug_assertions)]
    SealRuntime {
        request_id: String,
    },
    #[cfg(debug_assertions)]
    RecoverRuntimeHandback {
        request_id: String,
        preparation_id: String,
        runtime_id: String,
        ownership_id: String,
    },
    #[cfg(debug_assertions)]
    PrepareRuntimeApplication {
        request_id: String,
    },
    #[cfg(debug_assertions)]
    ResumeRuntimeApplication {
        request_id: String,
    },
    #[cfg(debug_assertions)]
    ReleaseOriginalLan {
        request_id: String,
        preparation_id: String,
        runtime_id: String,
        ownership_id: String,
    },
    #[cfg(debug_assertions)]
    LaunchRuntime {
        request_id: String,
        preparation_id: String,
        id: String,
        ownership_id: Option<String>,
        #[serde(default)]
        original_lan: bool,
    },
}

fn line(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, String> {
    let mut bytes = Vec::new();
    Read::by_ref(reader)
        .take(MAX_LINE + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.len() as u64 > MAX_LINE || bytes.last() != Some(&b'\n') {
        return Err("来源租约消息超限或未完整结束".into());
    }
    Ok(Some(bytes))
}

fn emit(output: &mut impl Write, message: Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
    if bytes.len() as u64 >= MAX_LINE {
        return Err("来源租约响应超限".into());
    }
    output
        .write_all(&bytes)
        .and_then(|_| output.write_all(b"\n"))
        .and_then(|_| output.flush())
        .map_err(|error| error.to_string())
}

fn session(
    input: mpsc::Receiver<Result<Command, String>>,
    output: &mut impl Write,
    cancel: &CancellationToken,
    mode: Mode,
    _graceful: Arc<AtomicBool>,
) -> Result<Option<RuntimeLaunch>, String> {
    let command = input.recv().map_err(|_| "来源租约连接已关闭")??;
    let Command::Open {
        version,
        request_id,
        locations,
    } = command
    else {
        return Err("来源租约必须先打开".into());
    };
    if version != 1
        || !uuid::Uuid::parse_str(&request_id)
            .is_ok_and(|id| id.get_version_num() == 4 && id.to_string() == request_id)
    {
        return Err("来源租约版本或请求身份无效".into());
    }
    #[cfg(debug_assertions)]
    let runtime_root = if mode == Mode::Runtime {
        let parent = locations.data.parent().ok_or("隔离运行 Data 没有父目录")?;
        let temporary = std::env::temp_dir()
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let actual = parent.canonicalize().map_err(|error| error.to_string())?;
        if actual.parent() != Some(temporary.as_path())
            || !actual.file_name().is_some_and(|name| {
                name.to_string_lossy()
                    .starts_with("dustdesk-runtime-preview-")
            })
            || locations.user_data.parent() != Some(parent)
            || locations.browser_profile != locations.user_data
        {
            return Err("隔离启动仅允许专用 TEMP 根中的同级测试 Data 与 profile".into());
        }
        Some(actual)
    } else {
        None
    };
    let source = BoundSource::open(locations, cancel, || Ok(()))?;
    let mut source = match mode {
        Mode::Lease => Source::Lease(Box::new(source)),
        Mode::Snapshot => Source::Snapshot(Box::new(source.freeze(cancel, || Ok(()))?)),
        #[cfg(debug_assertions)]
        Mode::Runtime => Source::Snapshot(Box::new(source.freeze(cancel, || Ok(()))?)),
    };
    let mut upload: Option<DraftUpload> = None;
    let mut prepared = false;
    emit(
        output,
        json!({"event":"ready","requestId":request_id,"binding":source.binding()}),
    )?;
    while let Ok(command) = input.recv() {
        match command? {
            Command::Confirm {
                request_id: received,
            } if received == request_id => {
                source.confirm(cancel)?;
                emit(output, json!({"event":"confirmed","requestId":request_id}))?;
            }
            Command::Close {
                request_id: received,
            } if received == request_id => {
                drop(source);
                emit(output, json!({"event":"closed","requestId":request_id}))?;
                return Ok(None);
            }
            Command::DraftsBegin {
                request_id: received,
                bytes,
                sha256,
            } if received == request_id && mode.snapshot() && upload.is_none() && !prepared => {
                upload = Some(DraftUpload::new(bytes, sha256)?);
                emit(
                    output,
                    json!({"event":"draftsStarted","requestId":request_id}),
                )?;
            }
            Command::DraftsChunk {
                request_id: received,
                data,
            } if received == request_id && mode.snapshot() && !prepared => {
                let accepted = upload
                    .as_mut()
                    .ok_or("必须先声明草稿原始长度和摘要")?
                    .push(&data)?;
                emit(
                    output,
                    json!({"event":"draftsAccepted","requestId":request_id,"bytes":accepted}),
                )?;
            }
            Command::Prepare {
                request_id: received,
                destination,
            } if received == request_id && mode.snapshot() && !prepared => {
                #[cfg(debug_assertions)]
                runtime_destination(runtime_root.as_ref(), &destination)?;
                let Source::Snapshot(source) = &mut source else {
                    unreachable!()
                };
                let drafts = upload.take().ok_or("必须先交付受控浏览器草稿")?.finish()?;
                let status =
                    source.prepare(&destination, &request_id, &drafts, cancel, || Ok(()))?;
                let crate::managed_snapshot::preparation::Outcome::HandoffPrepared { receipt } =
                    status.outcome
                else {
                    return Err("组合快照缺少原生成功决定".into());
                };
                prepared = true;
                emit(
                    output,
                    json!({"event":"prepared","requestId":request_id,"id":status.id,"receipt":receipt}),
                )?;
            }
            Command::VerifyPrepared {
                request_id: received,
                id,
            } if received == request_id && mode.snapshot() && upload.is_none() => {
                let Source::Snapshot(source) = &mut source else {
                    unreachable!()
                };
                let receipt = source.verify_prepared(&id, cancel, || Ok(()))?;
                emit(
                    output,
                    json!({"event":"verifiedPrepared","requestId":request_id,"id":id,"receipt":receipt}),
                )?;
            }
            Command::PrepareRuntime {
                request_id: received,
                id,
                destination,
            } if received == request_id && mode.snapshot() && upload.is_none() => {
                #[cfg(debug_assertions)]
                runtime_destination(runtime_root.as_ref(), &destination)?;
                let Source::Snapshot(source) = &mut source else {
                    unreachable!()
                };
                let receipt = source.prepare_runtime(&id, &destination, cancel, || Ok(()))?;
                emit(
                    output,
                    json!({"event":"runtimePrepared","requestId":request_id,"preparationId":id,
                    "id":receipt.id,"receipt":receipt,"scope":"runtime-data-only","productionReady":false,"migrationComplete":false}),
                )?;
            }
            Command::VerifyRuntime {
                request_id: received,
                preparation_id,
                id,
            } if received == request_id && mode.snapshot() && upload.is_none() => {
                let Source::Snapshot(source) = &mut source else {
                    unreachable!()
                };
                let receipt = source.verify_runtime(&preparation_id, &id, cancel, || Ok(()))?;
                emit(
                    output,
                    json!({"event":"runtimeVerified","requestId":request_id,"preparationId":preparation_id,
                    "id":id,"receipt":receipt,"scope":"runtime-data-only","productionReady":false,"migrationComplete":false}),
                )?;
            }
            Command::QueryRuntime {
                request_id: received,
                id,
                after_id,
            } if received == request_id && mode.snapshot() && upload.is_none() => {
                let Source::Snapshot(source) = &mut source else {
                    unreachable!()
                };
                let statuses = source.runtime_statuses(&id, cancel, || Ok(()))?;
                let page = crate::managed_snapshot::preparation::runtime::page(
                    &statuses,
                    after_id.as_deref(),
                )?;
                let message = json!({"event":"runtimeStatus","requestId":request_id,"preparationId":id,
                    "page":page,"scope":"native-runtime-preparation-metadata-only","productionReady":false,"migrationComplete":false});
                if serde_json::to_vec(&message)
                    .map_err(|error| error.to_string())?
                    .len() as u64
                    > MAX_LINE
                {
                    return Err("运行准备状态响应超过有界消息大小".into());
                }
                emit(output, message)?;
            }
            #[cfg(debug_assertions)]
            Command::ReleaseOriginalLan {
                request_id: received,
                preparation_id,
                runtime_id,
                ownership_id,
            } if received == request_id && mode == Mode::Runtime && upload.is_none() => {
                let Source::Snapshot(source) = source else {
                    unreachable!()
                };
                let (mut owner, kind) = source.resume_runtime_for_original_lan_release(
                    &preparation_id,
                    &runtime_id,
                    &ownership_id,
                    cancel,
                    || Ok(()),
                )?;
                let proof = match kind {
                    crate::lan::migration::ReleaseKind::NotStarted => {
                        json!({"kind":"notStarted","checkpoint":owner.confirm_original_lan_not_started_preview()?})
                    }
                    crate::lan::migration::ReleaseKind::Handback => {
                        let receipt = owner.resume_original_lan_handback_preview(|| Ok(()))?;
                        json!({"kind":"handback","checkpoint":receipt.checkpoint,"receipt":receipt})
                    }
                    crate::lan::migration::ReleaseKind::Drain => {
                        let (store, identity) = owner.resume_original_lan_preview(|| Ok(()))?;
                        let runtime = tokio::runtime::Builder::new_current_thread()
                            .enable_all()
                            .build()
                            .map_err(|e| e.to_string())?;
                        let drained = runtime.block_on(
                            crate::lan::migration::service::Services::drain_recovered(
                                store, identity,
                            ),
                        )?;
                        let receipt = owner.finish_original_lan_preview(&drained, || Ok(()))?;
                        json!({"kind":"handback","checkpoint":receipt.checkpoint,"receipt":receipt})
                    }
                };
                owner.verify()?;
                emit(
                    output,
                    json!({"event":"originalLanReleased","requestId":request_id,"ownershipId":ownership_id,"proof":proof,"businessServicesStarted":false,"productionReady":false,"migrationComplete":false}),
                )?;
                return Ok(None);
            }
            #[cfg(debug_assertions)]
            Command::RecoverRuntimeHandback {
                request_id: received,
                preparation_id,
                runtime_id,
                ownership_id,
            } if received == request_id && mode == Mode::Runtime && upload.is_none() => {
                let Source::Snapshot(source) = source else {
                    unreachable!()
                };
                let mut owner = source.resume_runtime_for_handback_preview(
                    &preparation_id,
                    &runtime_id,
                    &ownership_id,
                    cancel,
                    || Ok(()),
                )?;
                runtime_destination(runtime_root.as_ref(), owner.path())?;
                let receipt = owner.resume_runtime_handback_preview(|| Ok(()))?;
                emit(
                    output,
                    json!({"event":"runtimeHandbackRecovered","requestId":request_id,
                    "receipt":receipt,"businessServicesStarted":false,"productionReady":false,"migrationComplete":false}),
                )?;
                // Input preparation is explicit and follows native terminal
                // re-acquisition. IPC supplies no paths, drafts or manifests.
                // Keep both sources pinned; never construct a store or WebView.
                while let Ok(command) = input.recv() {
                    match command? {
                        Command::Close {
                            request_id: received,
                        } if received == request_id => {
                            drop(owner);
                            emit(output, json!({"event":"closed","requestId":request_id}))?;
                            return Ok(None);
                        }
                        Command::PrepareRuntimeApplication {
                            request_id: received,
                        } if received == request_id => {
                            let receipt = owner.prepare_runtime_application_preview(|| Ok(()))?;
                            emit(
                                output,
                                json!({"event":"runtimeApplicationPrepared","requestId":request_id,
                                "receipt":receipt,"businessServicesStarted":false,"productionReady":false,"migrationComplete":false}),
                            )?;
                        }
                        Command::ResumeRuntimeApplication {
                            request_id: received,
                        } if received == request_id => {
                            let receipt = owner.resume_runtime_application_preview(|| Ok(()))?;
                            emit(
                                output,
                                json!({"event":"runtimeApplicationRecovered","requestId":request_id,
                                "receipt":receipt,"businessServicesStarted":false,"productionReady":false,"migrationComplete":false}),
                            )?;
                        }
                        _ => {
                            return Err(
                                "整体交还恢复只允许输入准备、核验或关闭，未开放应用或服务".into()
                            )
                        }
                    }
                }
                return Ok(None);
            }
            #[cfg(debug_assertions)]
            Command::LaunchRuntime {
                request_id: received,
                preparation_id,
                id,
                ownership_id,
                original_lan,
            } if received == request_id && mode == Mode::Runtime && upload.is_none() => {
                let Source::Snapshot(source) = source else {
                    unreachable!()
                };
                let mut owner = match ownership_id {
                    Some(ref ownership_id) => {
                        source
                            .resume_runtime(&preparation_id, &id, ownership_id, cancel, || Ok(()))?
                    }
                    None => source.claim_runtime(&preparation_id, &id, cancel, || Ok(()))?,
                };
                runtime_destination(runtime_root.as_ref(), owner.path())?;
                if ownership_id.is_some() {
                    owner.resume_browser_profile()?;
                } else {
                    owner.prepare_browser_profile()?;
                }
                // A live original LAN owner must be able to save its final
                // paused state after client EOF. Admission stops immediately;
                // custody is revoked only after the supervised drain/handback.
                let stop = CancellationToken::new();
                let launch_stop = stop.clone();
                let seal = Arc::new(AtomicBool::new(false));
                let request_seal = seal.clone();
                let client_closed = CancellationToken::new();
                let disconnected = client_closed.clone();
                let browser_start = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                let lan_start = Arc::new(AtomicBool::new(false));
                let begin_lan = lan_start.clone();
                let start = browser_start.clone();
                let request = request_id.clone();
                _graceful.store(true, Ordering::SeqCst);
                owner.confirm()?;
                // Acknowledge only the already bound browser. Later commands
                // can start the original LAN once or request terminal sealing;
                // other input, malformed messages and EOF stop admission.
                std::thread::spawn(move || {
                    if let Ok(Ok(Command::ContinueRuntime { request_id })) = input.recv() {
                        if request_id == request && !stop.is_cancelled() {
                            start.store(true, std::sync::atomic::Ordering::SeqCst);
                            let mut lan_requested = false;
                            while let Ok(Ok(command)) = input.recv() {
                                match command {
                                    Command::StartOriginalLan { request_id }
                                        if original_lan
                                            && !lan_requested
                                            && request_id == request =>
                                    {
                                        lan_requested = true;
                                        begin_lan.store(true, Ordering::SeqCst);
                                    }
                                    Command::SealRuntime { request_id }
                                        if request_id == request =>
                                    {
                                        request_seal.store(true, Ordering::SeqCst);
                                        stop.cancel();
                                        // Hold the sealed native checkpoint until
                                        // the client closes (or sends a final message).
                                        let _ = input.recv();
                                        break;
                                    }
                                    _ => break,
                                }
                            }
                        }
                    }
                    stop.cancel();
                    disconnected.cancel();
                });
                return Ok(Some(RuntimeLaunch {
                    owner,
                    request_id,
                    cancel: cancel.clone(),
                    browser_start,
                    original_lan,
                    lan_start,
                    stop: launch_stop,
                    seal,
                    client_closed,
                }));
            }
            _ => return Err("来源租约消息阶段或请求身份不匹配".into()),
        }
    }
    Ok(None)
}

pub fn run_stdio() -> Result<(), String> {
    run_stdio_mode(Mode::Lease).map(|_| ())
}

pub fn run_snapshot_stdio() -> Result<(), String> {
    run_stdio_mode(Mode::Snapshot).map(|_| ())
}

#[cfg(debug_assertions)]
pub fn runtime_stdio() -> Result<Option<RuntimeLaunch>, String> {
    run_stdio_mode(Mode::Runtime)
}

fn run_stdio_mode(mode: Mode) -> Result<Option<RuntimeLaunch>, String> {
    if std::env::args().count() != 2 {
        return Err("来源租约模式不接受额外命令行参数".into());
    }
    let cancel = CancellationToken::new();
    let reader_cancel = cancel.clone();
    let graceful = Arc::new(AtomicBool::new(false));
    let reader_graceful = graceful.clone();
    let (sender, receiver) = mpsc::sync_channel(2);
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            match line(&mut input) {
                Ok(Some(bytes)) => {
                    let command = serde_json::from_slice(&bytes)
                        .map_err(|error| format!("来源租约消息无效：{error}"));
                    let failed = command.is_err();
                    if sender.send(command).is_err() || failed {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = sender.send(Err(error));
                    break;
                }
            }
        }
        if !reader_graceful.load(Ordering::SeqCst) {
            reader_cancel.cancel();
        }
    });
    session(receiver, &mut io::stdout().lock(), &cancel, mode, graceful)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_protocol_is_bounded_and_rejects_truncated_or_extra_fields() {
        for input in [vec![b'x'; MAX_LINE as usize + 1], b"{}".to_vec()] {
            assert!(line(&mut io::Cursor::new(input)).is_err());
        }
        assert!(line(&mut io::Cursor::new(Vec::<u8>::new()))
            .unwrap()
            .is_none());
        assert_eq!(
            line(&mut io::Cursor::new(b"{}\n")).unwrap().unwrap(),
            b"{}\n"
        );
        for input in [
            r#"{"action":"confirm","requestId":"id","trusted":true}"#,
            r#"{"action":"close","requestId":"id","path":"C:\\data"}"#,
            r#"{"action":"write","requestId":"id"}"#,
        ] {
            assert!(serde_json::from_str::<Command>(input).is_err());
        }
    }
    #[test]
    fn confirm_cannot_create_source_authority_without_open() {
        let (sender, receiver) = mpsc::channel();
        sender
            .send(Ok(Command::Confirm {
                request_id: "fake".into(),
            }))
            .unwrap();
        assert!(session(
            receiver,
            &mut Vec::new(),
            &CancellationToken::new(),
            Mode::Lease,
            Arc::new(AtomicBool::new(false))
        )
        .err()
        .unwrap()
        .contains("必须先打开"));
    }

    #[test]
    fn bounded_draft_chunks_require_exact_length_digest_and_encoding() {
        for (length, hash) in [
            (0, "a".repeat(64)),
            (MAX_DRAFTS + 1, "a".repeat(64)),
            (1, "invalid".into()),
        ] {
            assert!(DraftUpload::new(length, hash).is_err());
        }
        let bytes = b"raw\r\n\0data";
        let hash = format!("{:x}", Sha256::digest(bytes));
        let mut upload = DraftUpload::new(bytes.len(), hash.clone()).unwrap();
        assert!(upload.push("@@").is_err());
        assert!(upload.push("").is_err());
        assert!(upload
            .push(&base64::engine::general_purpose::STANDARD.encode(vec![0; 32 * 1024 + 1]))
            .is_err());
        assert_eq!(
            upload
                .push(&base64::engine::general_purpose::STANDARD.encode(&bytes[..3]))
                .unwrap(),
            3
        );
        assert!(upload
            .push(&base64::engine::general_purpose::STANDARD.encode(bytes))
            .is_err());
        assert_eq!(
            upload
                .push(&base64::engine::general_purpose::STANDARD.encode(&bytes[3..]))
                .unwrap(),
            bytes.len()
        );
        assert_eq!(upload.finish().unwrap().as_slice(), bytes);
        let mut wrong = DraftUpload::new(bytes.len(), "a".repeat(64)).unwrap();
        wrong
            .push(&base64::engine::general_purpose::STANDARD.encode(bytes))
            .unwrap();
        assert!(wrong.finish().is_err());
        assert!(DraftUpload::new(bytes.len(), hash)
            .unwrap()
            .finish()
            .is_err());
    }
}
