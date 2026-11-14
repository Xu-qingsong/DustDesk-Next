//! The preview uses the original native owner and real Windows approvals.
//! It does not expose LAN controls to the quarantined browser.
use super::{emit, Phase, Service};
use dustdesk_tauri::lan::{
    approvals::{Queue, Ui},
    dialog::{self, ReceiveChoice},
    discovery, folder,
    migration::service::Services,
    protocol::Device,
    receiver::ReceivePrompt,
};
use serde_json::json;
use std::{
    net::{Ipv4Addr, SocketAddrV4},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::Manager;
use tokio_util::sync::CancellationToken;

struct NativeUi {
    app: tauri::AppHandle,
    root: PathBuf,
}
impl NativeUi {
    fn isolated(&self, path: &Path) -> Result<(), String> {
        if !path.starts_with(&self.root)
            || path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err("隔离 LAN 验证只能接收到本次专用临时根内".into());
        }
        // The same native storage opener used by the receiver rejects junctions,
        // symbolic links, alternate streams and non-local drives in every ancestor.
        dustdesk_tauri::lan::files::Directory::open(path).map_err(|e| e.to_string())?;
        Ok(())
    }
}
impl Ui for NativeUi {
    fn check(&self) -> Result<(), String> {
        let service = self.app.state::<Service>();
        if service.stop.is_cancelled()
            || service.cancel.is_cancelled()
            || *service.phase.lock().map_err(|e| e.to_string())? != Phase::Ready
        {
            return Err("隔离 LAN 服务已停止准入".into());
        }
        let result = service
            .store
            .lock()
            .map_err(|e| e.to_string())?
            ._ownership
            .confirm_runtime();
        result
    }
    fn pair(&self, peer: &Device, code: &str, cancel: &CancellationToken) -> Result<bool, String> {
        self.check()?;
        dialog::pair(0, peer, code, cancel)
    }
    fn receive(
        &self,
        prompt: &ReceivePrompt,
        downloads: &Path,
        cancel: &CancellationToken,
    ) -> Result<ReceiveChoice, String> {
        self.check()?;
        if let Some(path) = &prompt.existing_directory {
            self.isolated(path)?;
        }
        let choice = dialog::receive(0, prompt, downloads, cancel)?;
        self.check()?;
        if cancel.is_cancelled() {
            return Err("隔离 LAN 接收已取消".into());
        }
        if matches!(choice, ReceiveChoice::Accept)
            && prompt.existing_directory.is_none()
            && prompt.manifest.text.is_none()
        {
            if downloads != self.root.join("Downloads") {
                return Err("隔离 LAN 默认目录不属于本次临时根".into());
            }
            // The receiver requires an existing authorized directory. Create
            // only this exact child, after explicit acceptance, through the
            // native opener that pins ancestors and rejects reparse points.
            dustdesk_tauri::lan::files::Directory::open(&self.root)
                .and_then(|root| root.child("Downloads", true))
                .map_err(|e| e.to_string())?;
        }
        Ok(choice)
    }
    fn choose_directory(&self, cancel: &CancellationToken) -> Result<Option<PathBuf>, String> {
        self.check()?;
        let selected = folder::choose(0, cancel)?;
        if let Some(path) = &selected {
            self.isolated(path)?;
        }
        Ok(selected)
    }
}
pub(super) struct Running {
    services: Services,
    queue: Queue,
}
pub(super) async fn start(app: &tauri::AppHandle) -> Result<Option<Running>, String> {
    let service = app.state::<Service>();
    if service.stop.is_cancelled() {
        return Err("隔离 LAN 启动已取消".into());
    }
    let prepared = {
        let store = service.store.lock().map_err(|e| e.to_string())?;
        if !store._ownership.original_lan_enabled()? {
            None
        } else {
            Some(store._ownership.prepare_original_lan()?)
        }
    };
    let Some((store, identity)) = prepared else {
        emit(
            &service.request_id,
            "runtimeOriginalLanReady",
            json!({"ownershipId":service.ownership_id,"enabled":false,"businessServicesStarted":false,"port":0}),
        )?;
        return Ok(None);
    };
    let queue = Queue::start(
        Arc::new(NativeUi {
            app: app.clone(),
            root: service.preview_root.clone(),
        }),
        service.preview_root.join("Downloads"),
        Duration::from_secs(90),
    )?;
    let services = match Services::start(
        store,
        identity.clone(),
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "DustDesk".into()),
        SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0),
        Arc::new(queue.clone()),
    )
    .await
    {
        Ok(services) => services,
        Err(error) => {
            queue.cancel();
            let _ = queue.stop().await;
            return Err(error);
        }
    };
    // UDP bind failure is reported without disabling explicitly paired HTTPS.
    let receiver = services.receiver();
    let _ = receiver.start_discovery(discovery::Config::default()).await;
    let status = receiver.discovery_status().await;
    let running = Running { services, queue };
    if let Err(error) = emit(
        &service.request_id,
        "runtimeOriginalLanReady",
        json!({"ownershipId":service.ownership_id,"enabled":true,"businessServicesStarted":true,"port":running.services.address().port(),"deviceId":identity.id,"fingerprint":identity.fingerprint,"discovery":status}),
    ) {
        // Keep all resources on the supervised shutdown path even after EPIPE.
        service.stop.cancel();
        eprintln!("隔离 LAN 启动响应未送达：{error}");
    }
    Ok(Some(running))
}
pub(super) async fn finish(app: &tauri::AppHandle, running: Option<Running>) -> Result<(), String> {
    let service = app.state::<Service>();
    let proof = if let Some(running) = running {
        running.queue.cancel();
        let (drained, dialogs) = tokio::join!(running.services.stop(), running.queue.stop());
        let drained = drained?;
        dialogs?;
        let receipt = service
            .store
            .lock()
            .map_err(|e| e.to_string())?
            ._ownership
            .finish_original_lan(&drained)?;
        json!({"kind":"handback","checkpoint":receipt.checkpoint,"receipt":receipt})
    } else {
        let checkpoint = service
            .store
            .lock()
            .map_err(|e| e.to_string())?
            ._ownership
            .original_lan_not_started()?;
        json!({"kind":"notStarted","checkpoint":checkpoint})
    };
    // A lost response must not prevent the already durable decision or exit.
    let _ = emit(
        &service.request_id,
        "runtimeOriginalLanHandedBack",
        json!({"ownershipId":service.ownership_id,"proof":proof,"businessServicesStarted":false}),
    );
    Ok(())
}
