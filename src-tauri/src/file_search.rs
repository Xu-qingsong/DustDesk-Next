use crate::{
    lifecycle::QuitState,
    system,
    workspace::{
        checked_path,
        commands::{operation, StorageState},
        productivity,
        resource_api::ResourceService,
    },
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};
use tokio::sync::{watch, Semaphore};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct SearchResult {
    name: String,
    path: String,
    is_directory: bool,
}
struct Search {
    id: String,
    cancelled: watch::Sender<bool>,
}
struct Cached {
    key: String,
    expires: Instant,
    items: Vec<SearchResult>,
}
#[derive(Default)]
struct Session {
    active: Option<Arc<Search>>,
    published: Option<Arc<Search>>,
    grants: HashSet<String>,
    cache: VecDeque<Cached>,
}
pub struct SearchService {
    session: Mutex<Session>,
    slot: Arc<Semaphore>,
    owners: Mutex<HashMap<String, Arc<SearchService>>>,
}
impl Default for SearchService {
    fn default() -> Self {
        Self {
            session: Mutex::default(),
            slot: Arc::new(Semaphore::new(1)),
            owners: Mutex::default(),
        }
    }
}
impl SearchService {
    pub fn owner(&self, label: &str) -> Result<Arc<SearchService>, String> {
        let mut owners = self.owners.lock().map_err(|error| error.to_string())?;
        Ok(owners
            .entry(label.into())
            .or_insert_with(|| {
                Arc::new(SearchService {
                    session: Mutex::default(),
                    slot: self.slot.clone(),
                    owners: Mutex::default(),
                })
            })
            .clone())
    }
    pub fn release_owner(&self, label: &str) {
        if let Ok(mut owners) = self.owners.lock() {
            if let Some(service) = owners.remove(label) {
                service.release();
            }
        }
    }
    fn begin(&self, id: String) -> Result<Arc<Search>, String> {
        let search = Arc::new(Search {
            id,
            cancelled: watch::channel(false).0,
        });
        let mut session = self.session.lock().map_err(|error| error.to_string())?;
        if let Some(previous) = session.active.replace(search.clone()) {
            previous.cancelled.send_replace(true);
        }
        session.grants.clear();
        session.published = None;
        Ok(search)
    }
    fn finish(&self, search: &Arc<Search>, items: &[SearchResult]) -> bool {
        let Ok(mut session) = self.session.lock() else {
            return false;
        };
        if *search.cancelled.borrow()
            || !session
                .active
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, search))
        {
            return false;
        }
        session.grants = items
            .iter()
            .filter_map(|item| system::path_key(&item.path).ok())
            .collect();
        session.active = None;
        session.published = Some(search.clone());
        true
    }
    fn cached(&self, key: &str) -> Option<Vec<SearchResult>> {
        let mut session = self.session.lock().ok()?;
        session.cache.retain(|entry| entry.expires > Instant::now());
        session
            .cache
            .iter()
            .find(|entry| entry.key == key)
            .map(|entry| entry.items.clone())
    }
    fn cache(&self, search: &Arc<Search>, key: String, items: Vec<SearchResult>) {
        let Ok(mut session) = self.session.lock() else {
            return;
        };
        if *search.cancelled.borrow()
            || !session
                .active
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, search))
        {
            return;
        }
        session
            .cache
            .retain(|entry| entry.key != key && entry.expires > Instant::now());
        session.cache.push_back(Cached {
            key,
            items,
            expires: Instant::now() + Duration::from_secs(2),
        });
        while session.cache.len() > 32 {
            session.cache.pop_front();
        }
    }
    pub fn cancel(&self, request: Option<&str>) {
        if let Ok(mut session) = self.session.lock() {
            if session
                .active
                .as_ref()
                .is_some_and(|active| request.is_none_or(|id| active.id == id))
            {
                if let Some(search) = session.active.take() {
                    search.cancelled.send_replace(true);
                }
                session.grants.clear();
            }
            if session
                .published
                .as_ref()
                .is_some_and(|search| request.is_none_or(|id| search.id == id))
            {
                session.published = None;
                session.grants.clear();
            }
        }
    }
    fn abort(&self, search: &Arc<Search>) {
        if let Ok(mut session) = self.session.lock() {
            search.cancelled.send_replace(true);
            if session
                .active
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, search))
            {
                session.active = None;
                session.grants.clear();
            }
        }
    }
    pub fn release(&self) {
        if let Ok(mut owners) = self.owners.lock() {
            for (_, service) in owners.drain() {
                service.release();
            }
        }
        if let Ok(mut session) = self.session.lock() {
            if let Some(search) = session.active.take() {
                search.cancelled.send_replace(true);
            }
            session.grants.clear();
            session.cache.clear();
            session.published = None;
        }
    }
    pub fn granted(&self, key: &str) -> bool {
        self.session
            .lock()
            .is_ok_and(|session| session.grants.contains(key))
    }
}
struct SearchGuard {
    service: Arc<SearchService>,
    search: Arc<Search>,
}
impl Drop for SearchGuard {
    fn drop(&mut self) {
        let service = &self.service;
        if let Ok(mut session) = service.session.lock() {
            if session
                .active
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, &self.search))
            {
                session.active = None;
            }
        };
    }
}
fn valid_query(query: &str) -> bool {
    query.encode_utf16().count() <= 256 && productivity::trim(query).encode_utf16().count() >= 2
}
fn normalized_roots(roots: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut positions = HashMap::new();
    let mut output = Vec::new();
    for root in roots {
        let Ok(absolute) = std::path::absolute(root) else {
            continue;
        };
        let Some(key) = absolute
            .to_str()
            .and_then(|value| system::path_key(value).ok())
        else {
            continue;
        };
        if let Some(index) = positions.get(&key).copied() {
            output[index] = absolute;
        } else {
            positions.insert(key, output.len());
            output.push(absolute);
        }
    }
    output.truncate(10);
    output
}
fn roots(
    state: &Value,
    desktop: PathBuf,
    app_data: PathBuf,
    cancelled: &watch::Receiver<bool>,
) -> Vec<PathBuf> {
    let settings = &state["Settings"];
    let mut roots = Vec::new();
    if settings["SearchDesktopFiles"] == true {
        roots.push(desktop);
    }
    if settings["SearchStartMenuApps"] == true {
        roots.push(app_data.join("Microsoft/Windows/Start Menu/Programs"));
    }
    if settings["SearchAppData"] == true {
        roots.push(app_data);
    }
    if settings["SearchProjectPaths"] == true {
        let mut targets = Vec::new();
        for project in state["Projects"].as_array().into_iter().flatten() {
            targets.push(project["ProjectPath"].as_str().unwrap_or(""));
            for phase in project["Phases"].as_array().into_iter().flatten() {
                targets.push(phase["ProjectPath"].as_str().unwrap_or(""));
                for task in phase["Subtasks"].as_array().into_iter().flatten() {
                    targets.push(task["FilePath"].as_str().unwrap_or(""));
                }
            }
        }
        let mut seen = HashSet::new();
        for target in targets.into_iter().filter(|target| !target.is_empty()) {
            if *cancelled.borrow() {
                return Vec::new();
            }
            if !seen.insert(target) {
                continue;
            }
            let path = Path::new(target);
            if checked_path(path).is_err() {
                continue;
            }
            if let Ok(metadata) = std::fs::metadata(path) {
                if metadata.is_dir() {
                    roots.push(path.to_owned());
                } else if let Some(parent) = path.parent() {
                    roots.push(parent.to_owned());
                }
            }
        }
    }
    if settings["SearchCustomPaths"] == true {
        roots.extend(
            settings["SearchCustomRoots"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
        );
    }
    normalized_roots(roots)
}
fn scan(roots: &[PathBuf], query: &str, cancelled: &watch::Receiver<bool>) -> Vec<SearchResult> {
    let needle = productivity::trim(query).to_lowercase();
    let mut items = Vec::new();
    let mut directories = HashSet::new();
    let mut results = HashSet::new();
    for root in roots {
        let mut pending = VecDeque::from([root.clone()]);
        let mut visited = 0;
        while let Some(directory) = pending.pop_front() {
            if *cancelled.borrow() {
                return Vec::new();
            }
            if visited >= 50000 || items.len() >= 40 {
                break;
            }
            let Some(key) = directory
                .to_str()
                .and_then(|value| system::path_key(value).ok())
            else {
                continue;
            };
            if !directories.insert(key) || checked_path(&directory).is_err() {
                continue;
            }
            let Ok(reader) = std::fs::read_dir(&directory) else {
                continue;
            };
            let mut entries = Vec::new();
            for entry in reader.take(50001) {
                if *cancelled.borrow() {
                    return Vec::new();
                }
                let Ok(entry) = entry else {
                    continue;
                };
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                entries.push((name, entry));
            }
            for (name, entry) in entries {
                visited += 1;
                if visited > 50000 || items.len() >= 40 || *cancelled.borrow() {
                    break;
                }
                let target = entry.path();
                if checked_path(&target).is_err() {
                    continue;
                }
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if kind.is_symlink() || (!kind.is_file() && !kind.is_dir()) {
                    continue;
                }
                let Some(path) = target.to_str() else {
                    continue;
                };
                let Ok(key) = system::path_key(path) else {
                    continue;
                };
                if name.to_lowercase().contains(&needle) && results.insert(key) {
                    items.push(SearchResult {
                        name,
                        path: path.to_owned(),
                        is_directory: kind.is_dir(),
                    });
                }
                if kind.is_dir() {
                    pending.push_back(target);
                }
            }
        }
        if items.len() >= 40 {
            break;
        }
    }
    if *cancelled.borrow() {
        Vec::new()
    } else {
        items
    }
}
#[tauri::command]
pub fn system_search_cancel(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    crate::widgets::business(&app, &window, &["search"])?;
    app.state::<SearchService>()
        .owner(window.label())?
        .cancel(Some(&request_id));
    Ok(())
}
#[tauri::command]
pub async fn system_search_files(
    app: tauri::AppHandle,
    window: WebviewWindow,
    query: String,
    request_id: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    crate::widgets::business(&app, &window, &["search"])?;
    app.state::<QuitState>().require_interactive()?;
    let service = app.state::<SearchService>().owner(window.label())?;
    let search = service.begin(request_id.unwrap_or_else(|| Uuid::new_v4().to_string()))?;
    let _guard = SearchGuard {
        service: service.clone(),
        search: search.clone(),
    };
    if !valid_query(&query) {
        service.finish(&search, &[]);
        return Ok(Vec::new());
    }
    let mut cancellation = search.cancelled.subscribe();
    let outcome = async {
        let state = operation(app.clone(), |store| store.resource_snapshot()).await?;
        if *search.cancelled.borrow() {
            return Ok(Vec::new());
        }
        let slot = service
            .slot
            .clone()
            .acquire_owned()
            .await
            .map_err(|error| error.to_string())?;
        let file_slot = app
            .state::<ResourceService>()
            .file_slots()
            .acquire_owned()
            .await
            .map_err(|error| error.to_string())?;
        let desktop = app.state::<crate::desktop::DesktopService>().root();
        let app_data = app
            .state::<StorageState>()
            .root
            .parent()
            .ok_or("隔离应用目录无效")?
            .to_owned();
        let worker_service = service.clone();
        let worker_search = search.clone();
        let receiver = search.cancelled.subscribe();
        tauri::async_runtime::spawn_blocking(move || {
            let _slot = slot;
            let _file_slot = file_slot;
            let roots = roots(&state, desktop, app_data, &receiver);
            if *receiver.borrow() {
                return Vec::new();
            }
            let key = serde_json::to_string(&(
                roots
                    .iter()
                    .filter_map(|root| root.to_str().and_then(|value| system::path_key(value).ok()))
                    .collect::<Vec<_>>(),
                productivity::trim(&query).to_lowercase(),
            ))
            .unwrap();
            let service = worker_service;
            if let Some(items) = service.cached(&key) {
                return items;
            }
            let items = scan(&roots, &query, &receiver);
            service.cache(&worker_search, key, items.clone());
            items
        })
        .await
        .map_err(|error| error.to_string())
    };
    let items = tokio::select! {
        result = outcome => result?,
        _ = cancellation.changed() => return Ok(Vec::new()),
        _ = tokio::time::sleep(Duration::from_secs(6)) => { service.abort(&search); return Ok(Vec::new()); }
    };
    if service.finish(&search, &items) {
        Ok(items)
    } else {
        Ok(Vec::new())
    }
}

#[cfg(test)]
#[path = "file_search_tests.rs"]
mod tests;
