//! Isolated development driver for filesystem crash tests. No desktop IPC.
//! All roots come from explicit local process arguments, never a LAN request.
#[cfg(windows)]
fn main() -> Result<(), String> {
    use dustdesk_tauri::lan::{
        files::Directory,
        publication::{self, Prepared},
        state_store::StateStore,
    };
    use serde_json::{json, Value};
    use std::{
        io::{self, BufRead, Write},
        path::PathBuf,
    };
    use tokio_util::sync::CancellationToken;
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.len() != 2 {
        return Err("expected isolated profile and approved receive directory".into());
    }
    let mut store = StateStore::open(&PathBuf::from(&arguments[0]))?;
    let root = Directory::open(&PathBuf::from(&arguments[1])).map_err(|e| e.to_string())?;
    let mut prepared: Option<Prepared> = None;
    let emit = |value: Value| {
        let mut out = io::stdout().lock();
        writeln!(out, "{value}").unwrap();
        out.flush().unwrap();
    };
    emit(json!({"event":"ready"}));
    for line in io::stdin().lock().lines() {
        let value: Value =
            serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let result = (|| -> Result<Value, String> {
            let id = value["task"].as_str().ok_or("task missing")?;
            let cancel = CancellationToken::new();
            if value["canceled"] == true {
                cancel.cancel();
            }
            match value["command"].as_str().ok_or("command missing")? {
                "begin" => {
                    let index = value["index"].as_u64().ok_or("index missing")? as usize;
                    let task = store
                        .state()
                        .tasks
                        .iter()
                        .find(|task| task.view.id == id)
                        .ok_or("task not found")?;
                    let staging = root
                        .child(&format!(".dustdesk-part-{}", task.manifest.id), false)
                        .map_err(|e| e.to_string())?;
                    let part = staging
                        .part(&format!("{index}.part"))
                        .map_err(|e| e.to_string())?;
                    prepared = Some(Prepared::begin(
                        &mut store,
                        id,
                        index,
                        root.clone(),
                        part,
                        &cancel,
                    )?);
                    Ok(json!({"phase":"intent"}))
                }
                "rename" => {
                    prepared
                        .as_mut()
                        .ok_or("begin missing")?
                        .rename(&mut store, &cancel)?;
                    Ok(json!({"phase":"renamed"}))
                }
                "commit" => {
                    Ok(json!({"path":prepared.take().ok_or("begin missing")?.commit(&mut store)?}))
                }
                "recover" => {
                    Ok(json!({"path":publication::recover(&mut store, id, root.clone(), &cancel)?}))
                }
                _ => Err("unknown command".into()),
            }
        })();
        emit(match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        });
    }
    Ok(())
}
#[cfg(not(windows))]
fn main() {
    panic!("Windows-only receiver storage driver");
}
