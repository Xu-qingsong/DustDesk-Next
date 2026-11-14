use crate::{lifecycle::QuitState, system};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};
use tokio::sync::{watch, Semaphore};

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathIcon {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_directory: Option<bool>,
}
struct Cached {
    value: PathIcon,
    expires: Instant,
    created: Instant,
}
#[derive(Default)]
struct State {
    cache: HashMap<String, Cached>,
    pending: HashMap<String, watch::Receiver<Option<PathIcon>>>,
}
#[derive(Clone)]
pub struct IconService {
    state: Arc<Mutex<State>>,
    slots: Arc<Semaphore>,
    capacity: usize,
    cache_budget: usize,
    timeout: Duration,
}
impl Default for IconService {
    fn default() -> Self {
        Self {
            state: Arc::default(),
            slots: Arc::new(Semaphore::new(4)),
            capacity: 256,
            cache_budget: 8 * 1024 * 1024,
            timeout: Duration::from_secs(6),
        }
    }
}
impl IconService {
    async fn read(
        &self,
        key: String,
        load: impl FnOnce() -> Result<PathIcon, String> + Send + 'static,
    ) -> PathIcon {
        let mut receiver = {
            let Ok(mut state) = self.state.lock() else {
                return PathIcon::default();
            };
            state
                .cache
                .retain(|_, cached| cached.expires > Instant::now());
            if let Some(cached) = state.cache.get(&key) {
                return cached.value.clone();
            }
            if let Some(receiver) = state.pending.get(&key) {
                receiver.clone()
            } else {
                if state.pending.len() >= self.capacity.min(32) {
                    return PathIcon::default();
                }
                let (sender, receiver) = watch::channel(None);
                state.pending.insert(key.clone(), receiver.clone());
                let service = self.clone();
                tokio::spawn(async move {
                    let slots = service.slots.clone();
                    let value = tokio::time::timeout(service.timeout, async move {
                        let permit = slots
                            .acquire_owned()
                            .await
                            .map_err(|error| error.to_string())?;
                        system::sta(move || {
                            let _permit = permit;
                            load()
                        })
                        .await
                    })
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or_default();
                    if let Ok(mut state) = service.state.lock() {
                        state.pending.remove(&key);
                        let weight = value.data_url.as_ref().map_or(0, String::len);
                        if weight <= service.cache_budget {
                            while state.cache.len() >= service.capacity
                                || state
                                    .cache
                                    .values()
                                    .map(|entry| {
                                        entry.value.data_url.as_ref().map_or(0, String::len)
                                    })
                                    .sum::<usize>()
                                    + weight
                                    > service.cache_budget
                            {
                                let Some(oldest) = state
                                    .cache
                                    .iter()
                                    .min_by_key(|(_, entry)| entry.created)
                                    .map(|(key, _)| key.clone())
                                else {
                                    break;
                                };
                                state.cache.remove(&oldest);
                            }
                            let ttl = if value.data_url.is_some() {
                                Duration::from_secs(30)
                            } else {
                                Duration::from_secs(3)
                            };
                            state.cache.insert(
                                key,
                                Cached {
                                    value: value.clone(),
                                    created: Instant::now(),
                                    expires: Instant::now() + ttl,
                                },
                            );
                        }
                    }
                    let _ = sender.send(Some(value));
                });
                receiver
            }
        };
        loop {
            if let Some(value) = receiver.borrow().clone() {
                return value;
            }
            if receiver.changed().await.is_err() {
                return PathIcon::default();
            }
        }
    }
}
#[tauri::command]
pub async fn system_icon(
    app: tauri::AppHandle,
    window: WebviewWindow,
    target: String,
) -> Result<PathIcon, String> {
    crate::widgets::business(
        &app,
        &window,
        &["launcher", "organizer", "organizer-group:", "search"],
    )?;
    if app.state::<QuitState>().require_interactive().is_err() {
        return Ok(PathIcon::default());
    }
    let Ok(key) = system::authorize_path_for(app.clone(), window.label(), &target).await else {
        return Ok(PathIcon::default());
    };
    let source = target.clone();
    let result = app
        .state::<IconService>()
        .read(key, move || {
            #[cfg(windows)]
            {
                crate::platform::icons::read(std::path::Path::new(&source))
            }
            #[cfg(not(windows))]
            {
                let _ = source;
                Err("当前平台尚未接通原生文件图标".into())
            }
        })
        .await;
    if app.state::<QuitState>().require_interactive().is_err()
        || system::authorize_path_for(app, window.label(), &target)
            .await
            .is_err()
    {
        return Ok(PathIcon::default());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn icon() -> PathIcon {
        PathIcon {
            data_url: Some("test-icon".into()),
            is_directory: Some(false),
        }
    }
    #[tokio::test]
    async fn duplicate_requests_share_native_work_and_cache_without_starting_more_threads() {
        let service = IconService::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let first_calls = calls.clone();
        let next_calls = calls.clone();
        let (first, next) = tokio::join!(
            service.read("same".into(), move || {
                first_calls.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(10));
                Ok(icon())
            }),
            service.read("same".into(), move || {
                next_calls.fetch_add(1, Ordering::SeqCst);
                Ok(icon())
            })
        );
        assert_eq!(first, icon());
        assert_eq!(next, icon());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            service
                .read("same".into(), || panic!(
                    "cached request must not read native data"
                ))
                .await,
            icon()
        );
    }
    #[tokio::test]
    async fn failures_cache_briefly_expire_and_retry_without_poisoning_success() {
        let service = IconService::default();
        assert_eq!(
            service.read("bad".into(), || Err("failed".into())).await,
            PathIcon::default()
        );
        assert_eq!(
            service
                .read("bad".into(), || panic!(
                    "failure cache must suppress retries"
                ))
                .await,
            PathIcon::default()
        );
        service
            .state
            .lock()
            .unwrap()
            .cache
            .get_mut("bad")
            .unwrap()
            .expires = Instant::now() - Duration::from_secs(1);
        assert_eq!(service.read("bad".into(), || Ok(icon())).await, icon());
    }
    #[tokio::test]
    async fn cache_capacity_is_bounded_and_oldest_entries_can_be_reloaded() {
        let service = IconService {
            capacity: 2,
            ..Default::default()
        };
        for key in ["first", "second", "third"] {
            assert_eq!(service.read(key.into(), || Ok(icon())).await, icon());
        }
        let state = service.state.lock().unwrap();
        assert_eq!(state.cache.len(), 2);
        assert!(!state.cache.contains_key("first"));
        assert!(state.pending.is_empty());
    }
    #[tokio::test]
    async fn cache_evicts_by_byte_budget_and_does_not_retain_oversized_results() {
        let service = IconService {
            cache_budget: 64,
            ..Default::default()
        };
        let small = || {
            Ok(PathIcon {
                data_url: Some("x".repeat(40)),
                is_directory: Some(false),
            })
        };
        service.read("first".into(), small).await;
        service.read("second".into(), small).await;
        {
            let state = service.state.lock().unwrap();
            assert_eq!(state.cache.len(), 1);
            assert!(state.cache.contains_key("second"));
        }
        let large = service
            .read("too-large".into(), || {
                Ok(PathIcon {
                    data_url: Some("x".repeat(80)),
                    is_directory: Some(false),
                })
            })
            .await;
        assert_eq!(large.data_url.unwrap().len(), 80);
        assert!(!service
            .state
            .lock()
            .unwrap()
            .cache
            .contains_key("too-large"));
    }
    #[tokio::test]
    async fn timed_out_native_threads_hold_slots_until_real_completion() {
        let service = IconService {
            slots: Arc::new(Semaphore::new(2)),
            timeout: Duration::from_millis(50),
            ..Default::default()
        };
        let started = Arc::new(AtomicUsize::new(0));
        let completed = Arc::new(AtomicUsize::new(0));
        let mut requests = Vec::new();
        for index in 0..8 {
            let service = service.clone();
            let started = started.clone();
            let completed = completed.clone();
            requests.push(tokio::spawn(async move {
                service
                    .read(format!("icon-{index}"), move || {
                        started.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(180));
                        completed.fetch_add(1, Ordering::SeqCst);
                        Ok(icon())
                    })
                    .await
            }));
        }
        for request in requests {
            assert_eq!(request.await.unwrap(), PathIcon::default());
        }
        assert_eq!(started.load(Ordering::SeqCst), 2);
        assert_eq!(service.slots.available_permits(), 0);
        assert_eq!(
            service
                .read("while-blocked".into(), || panic!(
                    "timed out native work still owns its permits"
                ))
                .await,
            PathIcon::default()
        );
        tokio::time::sleep(Duration::from_millis(140)).await;
        assert_eq!(completed.load(Ordering::SeqCst), 2);
        assert_eq!(service.slots.available_permits(), 2);
        assert_eq!(
            service.read("after-completion".into(), || Ok(icon())).await,
            icon()
        );
    }
}
