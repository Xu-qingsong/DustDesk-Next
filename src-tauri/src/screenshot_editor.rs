use crate::{
    screenshot::Document,
    screenshot_output::{Output, Packet},
};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};
use tokio::sync::oneshot;

#[derive(Clone, Serialize)]
pub struct Delivery {
    ticket: String,
    document: Document,
}
struct Pending {
    delivery: Delivery,
    source: WebviewWindow,
    target: WebviewWindow,
    generation: u64,
    source_epoch: u64,
    deadline: Instant,
    packet: Arc<Packet>,
    reply: oneshot::Sender<Result<Output, String>>,
}
#[derive(Default)]
pub struct Service {
    pending: Mutex<Option<Pending>>,
    gate: tokio::sync::Mutex<()>,
    ready: Mutex<Option<WebviewWindow>>,
    changed: tokio::sync::Notify,
}
fn source_active(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    id: &str,
    epoch: u64,
) -> Result<(), String> {
    if crate::screenshot_capture::require_document(app, window, id)? != epoch {
        return Err("截图覆盖层已导航，交接已取消".into());
    }
    Ok(())
}
fn active(app: &tauri::AppHandle, pending: &Pending) -> Result<(), String> {
    if Instant::now() >= pending.deadline {
        return Err("主编辑页接收截图超时，原截图仍可重试".into());
    }
    source_active(
        app,
        &pending.source,
        &pending.packet.metadata.document.id,
        pending.source_epoch,
    )?;
    crate::toolbox::require_active(app, &pending.target)?;
    if app.state::<crate::screenshot::Service>().generation()? != pending.generation {
        return Err("截图交接已取消".into());
    }
    Ok(())
}
fn reject(app: &tauri::AppHandle, pending: Pending, error: String) {
    let _ = app
        .state::<crate::screenshot::Service>()
        .remove_owned(&pending.delivery.document.id, Some("workspace-main"));
    let _ = pending.reply.send(Err(error));
}
impl Service {
    fn cancel(
        &self,
        app: &tauri::AppHandle,
        ticket: Option<&str>,
        window: Option<&str>,
        error: &str,
    ) {
        let pending = self.pending.lock().ok().and_then(|mut state| {
            if state.as_ref().is_some_and(|pending| {
                ticket.is_none_or(|ticket| pending.delivery.ticket == ticket)
                    && window.is_none_or(|label| {
                        pending.source.label() == label || pending.target.label() == label
                    })
            }) {
                state.take()
            } else {
                None
            }
        });
        if let Some(pending) = pending {
            reject(app, pending, error.into());
        }
    }
}
pub fn cancel_window(app: &tauri::AppHandle, label: &str) {
    if label == "workspace-main" {
        if let Ok(mut ready) = app.state::<Service>().ready.lock() {
            *ready = None;
        }
    }
    app.state::<Service>().changed.notify_waiters();
    app.state::<Service>().cancel(
        app,
        None,
        Some(label),
        "截图交接窗口已关闭或导航，原操作已取消",
    );
}
pub fn reset(app: &tauri::AppHandle) {
    app.state::<Service>()
        .cancel(app, None, None, "截图交接已取消");
    app.state::<Service>().changed.notify_waiters();
}
pub async fn open(
    app: tauri::AppHandle,
    window: WebviewWindow,
    packet: Arc<Packet>,
) -> Result<Output, String> {
    let service = app.state::<Service>();
    let _guard = service
        .gate
        .try_lock()
        .map_err(|_| "正在交接另一张截图，请稍后重试")?;
    let source_epoch =
        crate::screenshot_capture::require_document(&app, &window, &packet.metadata.document.id)?;
    let deadline = Instant::now() + Duration::from_secs(15);
    crate::main_window::show(&app).await?;
    let target = loop {
        let notified = service.changed.notified();
        source_active(&app, &window, &packet.metadata.document.id, source_epoch)?;
        let ready = service
            .ready
            .lock()
            .map_err(|error| error.to_string())?
            .clone();
        if let Some(target) = ready.filter(|target| crate::main_window::current(&app, target)) {
            crate::toolbox::require_active(&app, &target)?;
            break target;
        }
        tokio::time::timeout_at(deadline.into(), notified)
            .await
            .map_err(|_| "主编辑页准备接收截图超时，原截图仍可重试".to_string())?;
    };
    source_active(&app, &window, &packet.metadata.document.id, source_epoch)?;
    crate::toolbox::require_active(&app, &target)?;
    let generation = app.state::<crate::screenshot::Service>().generation()?;
    let document = app.state::<crate::screenshot::Service>().stage_editor(
        generation,
        &packet,
        window.label(),
        || {
            source_active(&app, &window, &packet.metadata.document.id, source_epoch)?;
            crate::toolbox::require_active(&app, &target)
        },
    )?;
    let ticket = uuid::Uuid::new_v4().to_string();
    let (reply, mut receiver) = oneshot::channel();
    let staged_id = document.id.clone();
    let pending = Pending {
        delivery: Delivery {
            ticket: ticket.clone(),
            document,
        },
        source: window,
        target,
        generation,
        source_epoch,
        deadline,
        packet,
        reply,
    };
    let registration = (|| {
        let mut state = service.pending.lock().map_err(|error| error.to_string())?;
        active(&app, &pending)?;
        if state.is_some() {
            return Err("已有待接收截图".into());
        }
        *state = Some(pending);
        Ok::<(), String>(())
    })();
    if let Err(error) = registration {
        let _ = app
            .state::<crate::screenshot::Service>()
            .remove_owned(&staged_id, Some("workspace-main"));
        return Err(error);
    }
    if let Err(error) = crate::events::emit(&app, "workspace-main", "screenshot:editor", ()) {
        service.cancel(&app, Some(&ticket), None, &error);
    }
    tokio::select! {
        result = &mut receiver => result.map_err(|_| "截图交接应答中断".to_string())?,
        _ = tokio::time::sleep_until(deadline.into()) => {
            service.cancel(&app, Some(&ticket), None, "主编辑页接收截图超时，原截图仍可重试");
            receiver.await.map_err(|_| "截图交接应答中断".to_string())?
        }
    }
}
#[tauri::command]
pub fn screenshot_editor_pending(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Option<Delivery>, String> {
    crate::toolbox::require_active(&app, &window)?;
    let service = app.state::<Service>();
    *service.ready.lock().map_err(|error| error.to_string())? = Some(window.clone());
    service.changed.notify_waiters();
    let state = service.pending.lock().map_err(|error| error.to_string())?;
    state
        .as_ref()
        .map(|pending| {
            active(&app, pending)?;
            Ok(pending.delivery.clone())
        })
        .transpose()
}
#[tauri::command]
pub fn screenshot_editor_received(
    app: tauri::AppHandle,
    window: WebviewWindow,
    ticket: String,
    error: Option<String>,
) -> Result<(), String> {
    crate::toolbox::require_active(&app, &window)?;
    let service = app.state::<Service>();
    let mut state = service.pending.lock().map_err(|error| error.to_string())?;
    if state
        .as_ref()
        .is_none_or(|pending| pending.delivery.ticket != ticket)
    {
        return Err("截图交接凭据已失效".into());
    }
    let pending = state.take().ok_or("截图交接已结束")?;
    let result = (|| {
        active(&app, &pending)?;
        if let Some(error) = error {
            return Err(format!(
                "主编辑页读取截图失败：{}",
                error.chars().take(2000).collect::<String>()
            ));
        }
        app.state::<crate::screenshot::Service>().transact_owned(
            pending.generation,
            &pending.packet,
            pending.source.label(),
            || {
                source_active(
                    &app,
                    &pending.source,
                    &pending.packet.metadata.document.id,
                    pending.source_epoch,
                )?;
                crate::toolbox::require_active(&app, &pending.target)
            },
            || {
                Ok(Output {
                    ok: true,
                    ..Output::default()
                })
            },
        )
    })();
    match result {
        Ok(output) => {
            let _ = pending.reply.send(Ok(output));
        }
        Err(error) => {
            reject(&app, pending, error.clone());
            return Err(error);
        }
    }
    Ok(())
}
