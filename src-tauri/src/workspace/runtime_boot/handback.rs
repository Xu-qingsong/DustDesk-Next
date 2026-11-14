//! Final read of the quarantined browser, followed by a retained native seal.
//! Ordinary editors and application back to Electron are separate gates.
use super::{emit, Phase, Service};
use crate::workspace::{draft_browser, draft_export, draft_lineage};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{sync::atomic::Ordering, time::Duration};
use tauri::Manager;

pub(super) async fn seal(app: &tauri::AppHandle) -> Result<(), String> {
    let service = app.state::<Service>();
    {
        let mut phase = service.phase.lock().map_err(|e| e.to_string())?;
        if *phase != Phase::Ready {
            return Err("浏览器导入尚未核验完成，未封存整体交还".into());
        }
        *phase = Phase::Sealing;
    }
    let window = app
        .get_webview_window("runtime-import")
        .ok_or("最终浏览器窗口已丢失")?;
    let generation = service.generation.load(Ordering::SeqCst);
    let binding = draft_browser::binding(app, &window)?;
    let current = || {
        if service.cancel.is_cancelled()
            || service.generation.load(Ordering::SeqCst) != generation
            || draft_browser::binding(app, &window)?.fingerprint != binding.fingerprint
        {
            return Err("最终浏览器读取代次或物理配置已变化，未确认整体交还".into());
        }
        Ok(())
    };
    current()?;
    let workspace = {
        let store = service.store.lock().map_err(|e| e.to_string())?;
        store._ownership.confirm_runtime()?;
        store.require_draft_recovered()?;
        format!(
            "{:x}",
            Sha256::digest(draft_lineage::read_bounded(
                &store.path(),
                64 * 1024 * 1024
            )?)
        )
    };
    emit(
        &service.request_id,
        "runtimeHandbackReading",
        json!({"ownershipId":service.ownership_id,"businessServicesStarted":false}),
    )?;
    // No entries, archive, destination, expected hash or profile come from IPC.
    // This host has one hidden recovery page and no ordinary editor services.
    let collected =
        draft_export::collect_archive(&window, &workspace, &app.package_info().version.to_string())
            .await;
    // Navigation can invalidate the JavaScript callback itself. Recheck the
    // native generation even when that callback returned an invalid response.
    current()?;
    let (drafts, entries) = collected?;
    let receipt = {
        let store = service.store.lock().map_err(|e| e.to_string())?;
        store._ownership.seal_runtime(
            drafts.as_bytes(),
            &workspace,
            &binding.fingerprint,
            current,
        )?
    };
    // A success response never leaves a live browser that can modify its values.
    // The native owner, profile binding and current Data pins remain held.
    window.destroy().map_err(|e| e.to_string())?;
    emit(
        &service.request_id,
        "runtimeHandbackSealed",
        json!({"receipt":receipt,"entries":entries,"businessServicesStarted":false}),
    )?;
    while !service.client_closed.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(200)).await;
        service
            .store
            .lock()
            .map_err(|e| e.to_string())?
            ._ownership
            .confirm_runtime_handback()?;
    }
    service
        .store
        .lock()
        .map_err(|e| e.to_string())?
        ._ownership
        .confirm_runtime_handback()?;
    Ok(())
}
