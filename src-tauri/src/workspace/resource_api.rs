use super::{
    api::{require_workspace, ActionReply},
    commands::operation,
    productivity::Action,
    resources::{self, ResourceHealth},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{Emitter, Manager, WebviewWindow};
use tokio::{
    sync::{watch, Semaphore},
    task::JoinSet,
};
use uuid::Uuid;

struct Scan {
    request_id: String,
    cancelled: watch::Sender<bool>,
}
pub struct ResourceService {
    scans: Mutex<HashMap<String, Arc<Scan>>>,
    files: Arc<Semaphore>,
    client: OnceLock<Result<reqwest::Client, String>>,
}
impl Default for ResourceService {
    fn default() -> Self {
        Self {
            scans: Mutex::new(HashMap::new()),
            files: Arc::new(Semaphore::new(4)),
            client: OnceLock::new(),
        }
    }
}
impl ResourceService {
    pub fn busy(&self, owner: &str) -> bool {
        self.scans
            .lock()
            .map_or(true, |scans| scans.contains_key(owner))
    }
    pub(crate) fn file_slots(&self) -> Arc<Semaphore> {
        self.files.clone()
    }
    pub fn cancel(&self, owner: &str, request_id: Option<&str>) {
        if let Ok(mut scans) = self.scans.lock() {
            if scans
                .get(owner)
                .is_some_and(|scan| request_id.is_none_or(|id| scan.request_id == id))
            {
                if let Some(scan) = scans.remove(owner) {
                    scan.cancelled.send_replace(true);
                }
            }
        }
    }
    pub fn cancel_all(&self) {
        if let Ok(mut scans) = self.scans.lock() {
            for (_, scan) in scans.drain() {
                scan.cancelled.send_replace(true);
            }
        }
    }
    fn client(&self) -> Result<reqwest::Client, String> {
        self.client
            .get_or_init(|| {
                reqwest::Client::builder()
                    .timeout(Duration::from_secs(6))
                    .redirect(reqwest::redirect::Policy::custom(|attempt| {
                        let target = attempt.url();
                        if !matches!(target.scheme(), "http" | "https")
                            || !target.username().is_empty()
                            || target.password().is_some()
                        {
                            attempt.error("资源检查不跟随非 HTTP 或含凭据的重定向")
                        } else {
                            reqwest::redirect::Policy::limited(20).redirect(attempt)
                        }
                    }))
                    .build()
                    .map_err(|error| error.to_string())
            })
            .clone()
    }
}

struct ScanGuard {
    app: tauri::AppHandle,
    owner: String,
    scan: Arc<Scan>,
}
impl ScanGuard {
    fn begin(app: tauri::AppHandle, owner: String, request_id: String) -> Result<Self, String> {
        let service = app.state::<ResourceService>();
        let scan = Arc::new(Scan {
            request_id,
            cancelled: watch::channel(false).0,
        });
        {
            let mut scans = service.scans.lock().map_err(|error| error.to_string())?;
            if let Some(previous) = scans.insert(owner.clone(), scan.clone()) {
                previous.cancelled.send_replace(true);
            }
        }
        Ok(Self { app, owner, scan })
    }
    fn publish(&self, value: Value) -> Result<bool, String> {
        let service = self.app.state::<ResourceService>();
        let scans = service.scans.lock().map_err(|error| error.to_string())?;
        if !scans
            .get(&self.owner)
            .is_some_and(|scan| Arc::ptr_eq(scan, &self.scan))
        {
            return Ok(false);
        }
        self.app
            .emit_to(&self.owner, "resources:progress", value)
            .map_err(|error| error.to_string())?;
        Ok(true)
    }
}
impl Drop for ScanGuard {
    fn drop(&mut self) {
        let service = self.app.state::<ResourceService>();
        if let Ok(mut scans) = service.scans.lock() {
            if scans
                .get(&self.owner)
                .is_some_and(|scan| Arc::ptr_eq(scan, &self.scan))
            {
                scans.remove(&self.owner);
            }
        };
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRequest {
    request_id: String,
    resource: Option<ResourceHealth>,
}

#[tauri::command]
pub async fn workspace_resources_check(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request: Option<ResourceRequest>,
) -> Result<Vec<ResourceHealth>, String> {
    require_workspace(&window)?;
    let request = request.unwrap_or(ResourceRequest {
        request_id: Uuid::new_v4().to_string(),
        resource: None,
    });
    if request.request_id.is_empty() || request.request_id.encode_utf16().count() > 100 {
        return Err("检查请求无效".into());
    }
    let guard = ScanGuard::begin(
        app.clone(),
        window.label().into(),
        request.request_id.clone(),
    )?;
    let mut cancellation = guard.scan.cancelled.subscribe();
    let state = operation(app.clone(), |store| store.resource_snapshot()).await?;
    let mut available = resources::collect(&state);
    if let Some(selected) = request.resource {
        available.retain(|item| item.same_reference(&selected));
        if available.is_empty() {
            return Err("资源已变化，请重新检查".into());
        }
    }
    let service = app.state::<ResourceService>();
    let client = service.client()?;
    let total = available.len();
    if !guard.publish(json!({"requestId":request.request_id,"completed":0,"total":total}))? {
        return Ok(Vec::new());
    }
    let mut pending = available.into_iter().enumerate();
    let mut workers = JoinSet::new();
    let mut output: Vec<Option<ResourceHealth>> = vec![None; total];
    let mut completed = 0;
    for _ in 0..4 {
        if let Some((index, item)) = pending.next() {
            let client = client.clone();
            let slots = service.files.clone();
            workers.spawn(async move { (index, resources::inspect(item, client, slots).await) });
        }
    }
    while !workers.is_empty() {
        if *cancellation.borrow() {
            break;
        }
        tokio::select! {
            biased;
            _ = cancellation.changed() => break,
            result = workers.join_next() => {
                let (index, item) = result.ok_or("资源检查任务已结束")?.map_err(|error| error.to_string())?;
                completed += 1;
                if !guard.publish(json!({"requestId":request.request_id,"completed":completed,"total":total,"item":item}))? { break; }
                output[index] = Some(item);
                if let Some((index, item)) = pending.next() {
                    let client = client.clone(); let slots = service.files.clone();
                    workers.spawn(async move { (index, resources::inspect(item, client, slots).await) });
                }
            }
        }
    }
    workers.abort_all();
    Ok(output.into_iter().flatten().collect())
}

#[tauri::command]
pub fn workspace_resources_cancel(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    require_workspace(&window)?;
    app.state::<ResourceService>()
        .cancel(window.label(), Some(&request_id));
    Ok(())
}

pub async fn preflight(app: tauri::AppHandle, action: &Value) -> Result<(), String> {
    if action["type"] != "resource-relink" {
        return Ok(());
    }
    let Action::ResourceRelink {
        resource,
        replacement,
    } = serde_json::from_value(action.clone()).map_err(|_| "资源参数无效")?
    else {
        return Err("资源参数无效".into());
    };
    let selected = resource.clone();
    let proposed = replacement.clone();
    operation(app.clone(), move |store| {
        resources::validate_reference(&store.resource_snapshot()?, &selected, &proposed)
    })
    .await?;
    if resource.kind != "link" {
        require_path(app, replacement).await?;
    }
    Ok(())
}

pub async fn require_safe_path(app: tauri::AppHandle, target: String) -> Result<(), String> {
    let slots = app
        .state::<crate::workspace::resource_api::ResourceService>()
        .file_slots();
    tokio::time::timeout(std::time::Duration::from_secs(6), async move {
        let permit = slots
            .acquire_owned()
            .await
            .map_err(|error| error.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            let path = std::path::Path::new(&target);
            crate::workspace::checked_path(path)?;
            std::fs::metadata(path).map_err(|error| error.to_string())?;
            crate::workspace::checked_path(path)
        })
        .await
        .map_err(|error| error.to_string())?
    })
    .await
    .map_err(|_| "暂时无法读取路径，请检查权限或磁盘连接".to_owned())?
}

pub async fn require_path(app: tauri::AppHandle, target: String) -> Result<(), String> {
    let slots = app.state::<ResourceService>().files.clone();
    tokio::time::timeout(Duration::from_secs(6), resources::probe_path(target, slots))
        .await
        .map_err(|_| "暂时无法读取路径，请检查权限或磁盘连接")?
        .map_err(|error| error.to_string())
}

pub fn failed_preflight(error: String) -> ActionReply {
    ActionReply {
        result: json!({"ok":false,"error":error}),
        snapshot: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(id: &str) -> Arc<Scan> {
        Arc::new(Scan {
            request_id: id.into(),
            cancelled: watch::channel(false).0,
        })
    }

    #[test]
    fn cancellation_is_bound_to_both_window_owner_and_request_id() {
        let service = ResourceService::default();
        let first = scan("first");
        let other = scan("other");
        service
            .scans
            .lock()
            .unwrap()
            .insert("workspace-main".into(), first.clone());
        service
            .scans
            .lock()
            .unwrap()
            .insert("other-window".into(), other.clone());
        service.cancel("workspace-main", Some("stale"));
        assert!(!*first.cancelled.borrow());
        service.cancel("workspace-main", Some("first"));
        assert!(*first.cancelled.borrow());
        assert!(!*other.cancelled.borrow());
        assert_eq!(service.scans.lock().unwrap().len(), 1);
        service.cancel_all();
        assert!(*other.cancelled.borrow());
        assert!(service.scans.lock().unwrap().is_empty());
    }

    #[test]
    fn blocking_filesystem_probes_share_a_global_four_slot_budget_across_scans() {
        let service = ResourceService::default();
        let first = service.files.clone().try_acquire_many_owned(4).unwrap();
        assert!(service.files.clone().try_acquire_owned().is_err());
        drop(first);
        assert_eq!(service.files.available_permits(), 4);
    }
}
