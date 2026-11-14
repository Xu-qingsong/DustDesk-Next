//! Development-only native approval queue fixture. No desktop IPC, trust or
//! file/network service; stdin models request lifetime, never auto-accepts.
#[cfg(windows)]
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), String> {
    use dustdesk_tauri::lan::{
        approvals::{Queue, Ui},
        dialog, folder,
        protocol::Device,
        receiver::{Approvals, ReceivePrompt},
    };
    use serde_json::{json, Value};
    use std::{
        collections::HashMap,
        io::{BufRead, Write},
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };
    use tokio_util::sync::CancellationToken;
    struct Native {
        valid: AtomicBool,
    }
    impl Ui for Native {
        fn check(&self) -> Result<(), String> {
            if self.valid.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("原生宿主已撤权".into())
            }
        }
        fn pair(
            &self,
            peer: &Device,
            code: &str,
            cancel: &CancellationToken,
        ) -> Result<bool, String> {
            dialog::pair(0, peer, code, cancel)
        }
        fn receive(
            &self,
            prompt: &ReceivePrompt,
            downloads: &Path,
            cancel: &CancellationToken,
        ) -> Result<dialog::ReceiveChoice, String> {
            dialog::receive(0, prompt, downloads, cancel)
        }
        fn choose_directory(&self, cancel: &CancellationToken) -> Result<Option<PathBuf>, String> {
            folder::choose(0, cancel)
        }
    }
    fn emit(value: Value) {
        let mut output = std::io::stdout().lock();
        writeln!(output, "{value}").unwrap();
        output.flush().unwrap();
    }
    let args: Vec<String> = std::env::args().collect();
    let downloads = PathBuf::from(args.get(1).ok_or("missing downloads")?);
    let timeout = args
        .get(2)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(45_000);
    let ui = Arc::new(Native {
        valid: AtomicBool::new(true),
    });
    let queue = Queue::start(ui.clone(), downloads, Duration::from_millis(timeout))?;
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
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
    let mut pending = HashMap::new();
    emit(json!({"event":"ready"}));
    loop {
        tokio::select! {
            value = receive.recv() => {
                let Some(value) = value else { break };
                match value["command"].as_str() {
                    Some("stop") => { emit(json!({"event":"stopping"})); break; },
                    Some("invalidate") => { ui.valid.store(false, Ordering::SeqCst); queue.cancel(); },
                    Some("cancel") => {
                        if let Some(handle) = pending.remove(value["target"].as_str().unwrap_or("")) {
                            let handle: tokio::task::AbortHandle = handle; handle.abort();
                            emit(json!({"id":value["target"],"ok":false,"error":"request canceled"}));
                        }
                    }
                    _ => {
                        let id = value["id"].as_str().ok_or("missing id")?.to_owned();
                        let queue = queue.clone();
                        let command_id = id.clone();
                        let handle = tasks.spawn(async move {
                            let result = async {
                                let peer: Device = serde_json::from_value(value["peer"].clone()).map_err(|_| "bad peer")?;
                                if value["command"] == "pair" { Ok(json!({"accepted":queue.pair(peer, value["code"].as_str().unwrap_or("").into()).await?})) }
                                else if value["command"] == "receive" {
                                    let prompt = ReceivePrompt { peer, manifest: serde_json::from_value(value["manifest"].clone()).map_err(|_| "bad manifest")?, existing_directory: value["existing"].as_str().map(PathBuf::from) };
                                    Ok(json!({"directory":queue.receive(prompt).await?}))
                                } else { Err("bad command".to_owned()) }
                            }.await;
                            match result {
                                Ok(reply) => emit(json!({"id":command_id,"ok":true,"value":reply})),
                                Err(error) => emit(json!({"id":command_id,"ok":false,"error":error})),
                            }
                            command_id
                        });
                        pending.insert(id, handle);
                    }
                }
            }
            result = tasks.join_next(), if !tasks.is_empty() => { if let Some(Ok(id)) = result { pending.remove(&id); } }
        }
    }
    queue.stop().await?;
    while tasks.join_next().await.is_some() {}
    reader.join().map_err(|_| "approval input failed")?;
    emit(json!({"event":"stopped"}));
    Ok(())
}
#[cfg(not(windows))]
fn main() {
    panic!("Windows-only approval fixture");
}
