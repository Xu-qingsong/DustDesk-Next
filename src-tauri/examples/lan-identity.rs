//! Isolated development driver. Holds the Rust owner until explicit stop and
//! joins the stdin reader. Cancellation can arrive during native RSA creation.
#[cfg(windows)]
fn main() -> Result<(), String> {
    use dustdesk_tauri::lan::state_store::StateStore;
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
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 1 {
        return Err("expected existing isolated profile".into());
    }
    let profile = PathBuf::from(&args[0]);
    let store = StateStore::open(&profile)?;
    let cancel = CancellationToken::new();
    let reader_cancel = cancel.clone();
    let (send, input) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                break;
            };
            if value["command"] == "cancel" || value["command"] == "stop" {
                reader_cancel.cancel();
            }
            let stop = value["command"] == "stop";
            if send.send(value).is_err() || stop {
                break;
            }
        }
        reader_cancel.cancel();
    });
    emit(json!({"event":"opened"}));
    for value in input {
        if value["command"] == "stop" {
            break;
        }
        if value["command"] == "cancel" {
            continue;
        }
        emit(json!({"event":"initializing", "id":value["id"]}));
        let result = store.ensure_identity(&cancel);
        match result {
            Ok(identity) => emit(json!({"event":"identity", "id":value["id"], "ok":true,
                "device":identity.id, "fingerprint":identity.fingerprint})),
            Err(error) => {
                emit(json!({"event":"identity", "id":value["id"], "ok":false, "error":error}))
            }
        }
    }
    reader.join().map_err(|_| "identity input thread failed")?;
    drop(store);
    emit(json!({"event":"stopped"}));
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    panic!("Windows-only identity driver");
}
