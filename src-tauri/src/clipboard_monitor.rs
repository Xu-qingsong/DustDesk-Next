use crate::{
    clipboard::{self, ClipboardContent, ClipboardService},
    lifecycle::QuitState,
    platform::clipboard_listener,
    workspace::{
        commands::{broadcast, operation},
        Snapshot,
    },
};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::Manager;
use tokio::sync::{watch, Mutex as AsyncMutex};
use uuid::Uuid;

struct Pending {
    sequence: u32,
    generation: u64,
    record: Value,
}

struct Control {
    generation: AtomicU64,
    pauses: AtomicUsize,
    stopped: AtomicBool,
    enabled: AtomicBool,
    signal: watch::Sender<u64>,
    ignore_sequence: Mutex<Option<u32>>,
    pending: Mutex<Option<Pending>>,
    cycle: AsyncMutex<()>,
}
impl Default for Control {
    fn default() -> Self {
        Self {
            generation: AtomicU64::new(0),
            pauses: AtomicUsize::new(0),
            stopped: AtomicBool::new(false),
            enabled: AtomicBool::new(false),
            signal: watch::channel(0).0,
            ignore_sequence: Mutex::new(None),
            pending: Mutex::new(None),
            cycle: AsyncMutex::new(()),
        }
    }
}
impl Control {
    fn signal(&self) {
        self.signal
            .send_modify(|value| *value = value.wrapping_add(1));
    }
    fn valid(&self, generation: u64) -> bool {
        !self.stopped.load(Ordering::SeqCst)
            && self.pauses.load(Ordering::SeqCst) == 0
            && self.generation.load(Ordering::SeqCst) == generation
    }
    fn configure(&self, enabled: bool) {
        let mut pending = self.pending.lock().ok();
        if self.enabled.swap(enabled, Ordering::SeqCst) != enabled {
            self.generation.fetch_add(1, Ordering::SeqCst);
            if let Some(pending) = pending.as_mut() {
                **pending = None;
            }
            self.signal();
        }
    }
    fn candidate(&self, sequence: u32, generation: u64) -> Result<Option<Value>, String> {
        let mut pending = self.pending.lock().map_err(|error| error.to_string())?;
        if !self.valid(generation) {
            return Ok(None);
        }
        if pending.as_ref().is_some_and(|candidate| {
            candidate.sequence != sequence || candidate.generation != generation
        }) {
            *pending = None;
        }
        Ok(pending.as_ref().map(|candidate| candidate.record.clone()))
    }
    fn accept(&self, sequence: u32, generation: u64, record: Value) -> Result<bool, String> {
        let mut pending = self.pending.lock().map_err(|error| error.to_string())?;
        if !self.valid(generation) || !self.enabled.load(Ordering::SeqCst) {
            return Ok(false);
        }
        *pending = Some(Pending {
            sequence,
            generation,
            record,
        });
        Ok(true)
    }
    fn clear(&self, sequence: u32, generation: u64) {
        if let Ok(mut pending) = self.pending.lock() {
            if pending.as_ref().is_some_and(|candidate| {
                candidate.sequence == sequence && candidate.generation == generation
            }) {
                *pending = None;
            }
        }
    }
}

#[derive(Default)]
pub struct MonitorService {
    started: AtomicBool,
    control: Arc<Control>,
    listener: Mutex<Option<clipboard_listener::Listener>>,
}

pub struct Pause {
    control: Arc<Control>,
    pending: Option<Pending>,
    generation: u64,
    failed: bool,
}
impl Pause {
    fn new(control: Arc<Control>, sequence: Option<u32>) -> Self {
        let mut slot = control.pending.lock().ok();
        let failed = slot.is_none();
        let previous = control.generation.fetch_add(1, Ordering::SeqCst);
        let pauses = control.pauses.fetch_add(1, Ordering::SeqCst);
        let pending = slot
            .as_mut()
            .and_then(|slot| slot.take())
            .filter(|candidate| {
                pauses == 0
                    && !control.stopped.load(Ordering::SeqCst)
                    && control.enabled.load(Ordering::SeqCst)
                    && candidate.generation == previous
                    && Some(candidate.sequence) == sequence
            });
        drop(slot);
        control.signal();
        Self {
            control,
            pending,
            generation: previous.wrapping_add(1),
            failed,
        }
    }

    pub async fn drain(&mut self, app: &tauri::AppHandle) -> Result<(), String> {
        let _idle = tokio::time::timeout(Duration::from_secs(10), self.control.cycle.lock())
            .await
            .map_err(|_| "等待剪贴板后台任务完成超时，已取消退出".to_string())?;
        if self.failed {
            return Err("无法取得待入库剪贴板，已取消退出".into());
        }
        let Some(candidate) = &self.pending else {
            return Ok(());
        };
        let control = self.control.clone();
        let generation = self.generation;
        let record = candidate.record.clone();
        let saved = operation(app.clone(), move |store| {
            if control.generation.load(Ordering::SeqCst) != generation
                || control.pauses.load(Ordering::SeqCst) != 1
                || control.stopped.load(Ordering::SeqCst)
            {
                return Ok(None);
            }
            store.ingest_clipboard(record)
        })
        .await
        .map_err(|error| format!("保存待入库剪贴板失败，已取消退出：{error}"))?;
        self.pending = None;
        if let Some((snapshot, record)) = saved {
            broadcast(app, &snapshot);
            if let Some(record) = record {
                publish_record(app, record);
            }
        }
        Ok(())
    }
}
impl Drop for Pause {
    fn drop(&mut self) {
        let mut slot = self.control.pending.lock().ok();
        let previous = self.control.generation.fetch_add(1, Ordering::SeqCst);
        let pauses = self.control.pauses.fetch_sub(1, Ordering::SeqCst);
        if previous == self.generation
            && pauses == 1
            && !self.control.stopped.load(Ordering::SeqCst)
            && self.control.enabled.load(Ordering::SeqCst)
        {
            if let (Some(slot), Some(mut candidate)) = (slot.as_mut(), self.pending.take()) {
                candidate.generation = previous.wrapping_add(1);
                **slot = Some(candidate);
            }
        }
        drop(slot);
        self.control.signal();
    }
}

pub fn pause(app: &tauri::AppHandle) -> Pause {
    Pause::new(app.state::<MonitorService>().control.clone(), None)
}

pub fn pause_for_quit(app: &tauri::AppHandle) -> Pause {
    pause_for_write(app)
}
pub fn pause_for_write(app: &tauri::AppHandle) -> Pause {
    Pause::new(
        app.state::<MonitorService>().control.clone(),
        Some(clipboard_listener::sequence()),
    )
}

pub fn stop(app: &tauri::AppHandle) {
    let service = app.state::<MonitorService>();
    service.control.stopped.store(true, Ordering::SeqCst);
    service.control.signal();
    if let Ok(mut listener) = service.listener.lock() {
        listener.take();
    };
}

pub fn changed(app: &tauri::AppHandle, snapshot: &Snapshot) {
    app.state::<MonitorService>()
        .control
        .configure(snapshot.state["Settings"]["ClipboardMonitoringEnabled"] != false);
}

pub fn restored(app: &tauri::AppHandle) {
    ignore_written_sequence(app, clipboard_listener::sequence());
}
pub fn ignore_written_sequence(app: &tauri::AppHandle, sequence: u32) {
    let service = app.state::<MonitorService>();
    let control = &service.control;
    if let Ok(mut ignored) = control.ignore_sequence.lock() {
        *ignored = Some(sequence);
    };
}

pub fn record(content: ClipboardContent) -> Result<Option<Value>, String> {
    if content.text.encode_utf16().count() > clipboard::MAX_TEXT_UNITS {
        return Err("剪贴板文本过大".into());
    }
    if content.text.is_empty() && content.image_png_base64.is_empty() {
        return Ok(None);
    }
    let image = !content.image_png_base64.is_empty();
    if image {
        let bytes = clipboard::decode_base64(&content.image_png_base64)?;
        clipboard::decode_image_limited(&bytes, 16_000_000)?;
    }
    let fingerprint = format!(
        "{:x}",
        Sha256::new()
            .chain_update(content.text.as_bytes())
            .chain_update(content.image_png_base64.as_bytes())
            .finalize()
    );
    let created = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    Ok(Some(
        json!({"Id":Uuid::new_v4().to_string(),"Kind":if image {"Image"}else{"Text"},"Text":content.text,"ImagePngBase64":content.image_png_base64,"ImageFileName":if image {format!("Clipboard-{}.png",created.replace([':', '.'],"-"))}else{String::new()},"ImageSha256":fingerprint,"CreatedAt":created,"IsLocked":false,"IsPinned":false}),
    ))
}

pub fn start(app: &tauri::AppHandle) {
    if std::env::var_os("DUSTDESK_TEST_USER_DATA_DIR").is_some()
        && std::env::var_os("DUSTDESK_TAURI_ENABLE_TEST_CLIPBOARD").is_none()
    {
        return;
    }
    let service = app.state::<MonitorService>();
    if service.started.swap(true, Ordering::SeqCst) {
        return;
    }
    let control = service.control.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut wake = control.signal.subscribe();
        let starting = loop {
            let gate = control.cycle.lock().await;
            if control.stopped.load(Ordering::SeqCst) {
                return;
            }
            if control.pauses.load(Ordering::SeqCst) == 0 {
                break gate;
            }
            drop(gate);
            if wake.changed().await.is_err() {
                return;
            }
        };
        let signal = control.signal.clone();
        let listener =
            tauri::async_runtime::spawn_blocking(move || clipboard_listener::listen(signal)).await;
        match listener {
            Ok(Ok(listener)) => match app.state::<MonitorService>().listener.lock() {
                Ok(mut slot) => {
                    if control.stopped.load(Ordering::SeqCst) {
                        return;
                    }
                    *slot = Some(listener)
                }
                Err(error) => {
                    eprintln!("剪贴板监听启动失败：{error}");
                    return;
                }
            },
            result => {
                eprintln!(
                    "剪贴板监听启动失败：{}",
                    match result {
                        Ok(Err(error)) => error,
                        Err(error) => error.to_string(),
                        _ => unreachable!(),
                    }
                );
                app.state::<MonitorService>()
                    .started
                    .store(false, Ordering::SeqCst);
                return;
            }
        }
        drop(starting);
        run(app, control).await;
    });
}

async fn run(app: tauri::AppHandle, control: Arc<Control>) {
    let mut wake = control.signal.subscribe();
    let mut acknowledged = None;
    let mut retry = false;
    let mut first = true;
    let mut read_failures = 0;
    let mut failure_key = None;
    loop {
        if !first {
            if retry {
                tokio::select! {_=wake.changed()=>{},_=tokio::time::sleep(Duration::from_secs(1))=>{}}
            } else if wake.changed().await.is_err() {
                break;
            }
        }
        first = false;
        retry = false;
        let _cycle = control.cycle.lock().await;
        if control.stopped.load(Ordering::SeqCst) {
            break;
        }
        let generation = control.generation.load(Ordering::SeqCst);
        if !control.valid(generation) || app.state::<QuitState>().require_interactive().is_err() {
            continue;
        }
        let enabled = match operation(app.clone(), |store| store.clipboard_enabled()).await {
            Ok(enabled) => enabled,
            Err(error) => {
                eprintln!("读取剪贴板监听配置失败：{error}");
                retry = true;
                continue;
            }
        };
        control.configure(enabled);
        let generation = control.generation.load(Ordering::SeqCst);
        if !enabled {
            acknowledged = None;
            read_failures = 0;
            continue;
        }
        let sequence = clipboard_listener::sequence();
        let ignored = control
            .ignore_sequence
            .lock()
            .map(|mut ignored| {
                if *ignored == Some(sequence) {
                    true
                } else {
                    *ignored = None;
                    false
                }
            })
            .unwrap_or(false);
        if ignored {
            control.clear(sequence, generation);
            acknowledged = Some((sequence, generation));
            continue;
        }
        if failure_key != Some((sequence, generation)) {
            failure_key = Some((sequence, generation));
            read_failures = 0;
        }
        if acknowledged == Some((sequence, generation)) {
            continue;
        }
        let mut candidate = match control.candidate(sequence, generation) {
            Ok(candidate) => candidate,
            Err(error) => {
                eprintln!("读取待入库剪贴板失败，将重试：{error}");
                retry = true;
                continue;
            }
        };
        if candidate.is_none() {
            let slot = match app
                .state::<ClipboardService>()
                .slot
                .clone()
                .acquire_owned()
                .await
            {
                Ok(slot) => slot,
                Err(_) => break,
            };
            let sampled = tauri::async_runtime::spawn_blocking(move || {
                let _slot = slot;
                let content = crate::platform::clipboard::read_monitored()?;
                record(content)
            })
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result);
            if !control.valid(generation) || clipboard_listener::sequence() != sequence {
                read_failures = 0;
                retry = true;
                continue;
            }
            match sampled {
                Ok(Some(record)) => {
                    match control.accept(sequence, generation, record.clone()) {
                        Ok(true) => candidate = Some(record),
                        Ok(false) => continue,
                        Err(error) => {
                            eprintln!("接收待入库剪贴板失败，将重试：{error}");
                            retry = true;
                            continue;
                        }
                    }
                    read_failures = 0;
                }
                Ok(None) => {
                    acknowledged = Some((sequence, generation));
                    continue;
                }
                Err(error) => {
                    read_failures += 1;
                    if read_failures == 1 {
                        eprintln!("剪贴板后台采样失败，将重试：{error}");
                    }
                    retry =
                        error.contains("占用") || error.contains("请稍后重试") || read_failures < 6;
                    if !retry {
                        acknowledged = Some((sequence, generation));
                        read_failures = 0;
                    }
                    continue;
                }
            }
        }
        let record = candidate.unwrap();
        let commit_control = control.clone();
        let commit_app = app.clone();
        let saved = operation(app.clone(), move |store| {
            if !commit_control.valid(generation)
                || commit_app
                    .state::<QuitState>()
                    .require_interactive()
                    .is_err()
                || clipboard_listener::sequence() != sequence
            {
                return Ok(None);
            }
            store.ingest_clipboard(record)
        })
        .await;
        match saved {
            Ok(result) => {
                control.clear(sequence, generation);
                acknowledged = Some((sequence, generation));
                if let Some((snapshot, record)) = result {
                    broadcast(&app, &snapshot);
                    if let Some(record) = record.filter(|_| {
                        control.valid(generation)
                            && app.state::<QuitState>().require_interactive().is_ok()
                    }) {
                        publish_record(&app, record);
                    }
                }
            }
            Err(error) => {
                eprintln!("保存剪贴板历史失败，将重试：{error}");
                retry = true;
            }
        }
    }
}

#[cfg(test)]
#[path = "clipboard_monitor_tests.rs"]
mod tests;

pub(crate) fn publish_record(app: &tauri::AppHandle, record: Value) {
    let service = app.state::<crate::widgets::Service>();
    for label in service
        .labels()
        .into_iter()
        .filter(|label| service.key(label).as_deref() == Some("clipboard"))
        .chain(std::iter::once("workspace-main".into()))
    {
        if app.get_webview_window(&label).is_some() {
            let _ =
                crate::events::emit(app, &label, "runtime:onClipboardChanged", [record.clone()]);
        }
    }
}
