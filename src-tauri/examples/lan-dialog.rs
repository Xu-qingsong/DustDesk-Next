//! Standalone native dialog fixture. No network, trust state, directory grant
//! or desktop IPC. The reader can cancel while the owned UI call is blocked.
#[cfg(windows)]
fn main() -> Result<(), String> {
    use dustdesk_tauri::lan::{dialog, protocol::Device, receiver::ReceivePrompt};
    use serde_json::{json, Value};
    use std::{
        io::{BufRead, Write},
        path::PathBuf,
    };
    use tokio_util::sync::CancellationToken;
    fn emit(value: Value) {
        let mut output = std::io::stdout().lock();
        writeln!(output, "{value}").unwrap();
        output.flush().unwrap();
    }
    let cancel = CancellationToken::new();
    let input_cancel = cancel.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                break;
            };
            if value["command"] == "cancel" || value["command"] == "stop" {
                input_cancel.cancel();
            }
            let stop = value["command"] == "stop";
            if send.send(value).is_err() || stop {
                break;
            }
        }
        input_cancel.cancel();
    });
    emit(json!({"event":"ready"}));
    for value in receive {
        if value["command"] == "stop" {
            break;
        }
        if value["command"] == "cancel" {
            continue;
        }
        let result = (|| -> Result<Value, String> {
            let owner = value["owner"].as_i64().unwrap_or(0) as isize;
            let peer: Device =
                serde_json::from_value(value["peer"].clone()).map_err(|_| "bad peer")?;
            if value["command"] == "pair" {
                Ok(
                    json!({"accepted":dialog::pair(owner, &peer, value["code"].as_str().unwrap_or(""), &cancel)?}),
                )
            } else if value["command"] == "receive" {
                let prompt = ReceivePrompt {
                    peer,
                    manifest: serde_json::from_value(value["manifest"].clone())
                        .map_err(|_| "bad manifest")?,
                    existing_directory: value["existing"].as_str().map(PathBuf::from),
                };
                let root = PathBuf::from(value["downloads"].as_str().unwrap_or(""));
                let choice = dialog::receive(owner, &prompt, &root, &cancel)?;
                Ok(
                    json!({"choice":match choice { dialog::ReceiveChoice::Accept => "accept", dialog::ReceiveChoice::Decline => "decline", dialog::ReceiveChoice::ChooseDirectory => "choose" }}),
                )
            } else {
                Err("bad command".into())
            }
        })();
        match result {
            Ok(reply) => emit(json!({"id":value["id"],"ok":true,"value":reply})),
            Err(error) => emit(json!({"id":value["id"],"ok":false,"error":error})),
        }
    }
    reader.join().map_err(|_| "dialog input failed")?;
    emit(json!({"event":"stopped"}));
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    panic!("Windows-only native LAN dialog fixture");
}
