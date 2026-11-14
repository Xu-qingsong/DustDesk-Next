use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};

pub const MAX_WINDOWS: usize = 128;
const MAX_THUMBNAIL: usize = 256 * 1024;
const MAX_THUMBNAILS: usize = 4 * 1024 * 1024;
const SOURCE_LIFETIME: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub handle: isize,
    pub process_id: u32,
    pub thread_id: u32,
    pub name: String,
}
pub struct Preview {
    pub target: Target,
    pub thumbnail: String,
}
#[derive(Serialize)]
pub struct Source {
    pub id: String,
    pub name: String,
    pub thumbnail: String,
}
#[derive(Default)]
struct State {
    generation: u64,
    issued: Option<Instant>,
    targets: HashMap<String, Target>,
}
#[derive(Default)]
pub struct Sources(Mutex<State>);
impl Sources {
    fn generation(&self) -> Result<u64, String> {
        Ok(self.0.lock().map_err(|error| error.to_string())?.generation)
    }
    pub fn clear(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.generation = state.generation.wrapping_add(1);
            state.issued = None;
            state.targets.clear();
        }
    }
    fn replace(
        &self,
        generation: u64,
        previews: Vec<Preview>,
        active: impl Fn() -> Result<(), String>,
    ) -> Result<Vec<Source>, String> {
        if previews.len() > MAX_WINDOWS {
            return Err("截图窗口数量超过限制".into());
        }
        let mut targets = HashMap::new();
        let mut handles = HashSet::new();
        let mut sources = Vec::new();
        let mut thumbnail_bytes = 0usize;
        for preview in previews {
            if preview.target.handle == 0
                || preview.target.process_id == 0
                || preview.target.thread_id == 0
                || preview.target.name.is_empty()
                || preview.target.name.encode_utf16().count() > 2048
                || !handles.insert(preview.target.handle)
            {
                return Err("截图窗口列表无效".into());
            }
            let thumbnail = if preview.thumbnail.len() <= MAX_THUMBNAIL
                && thumbnail_bytes.saturating_add(preview.thumbnail.len()) <= MAX_THUMBNAILS
            {
                thumbnail_bytes += preview.thumbnail.len();
                preview.thumbnail
            } else {
                String::new()
            };
            let id = format!("window:{}", uuid::Uuid::new_v4());
            sources.push(Source {
                id: id.clone(),
                name: preview.target.name.clone(),
                thumbnail,
            });
            targets.insert(id, preview.target);
        }
        let mut state = self.0.lock().map_err(|error| error.to_string())?;
        if state.generation != generation {
            return Err("截图窗口列表已失效，请重新选择".into());
        }
        active()?;
        state.targets = targets;
        state.issued = Some(Instant::now());
        Ok(sources)
    }
    pub(crate) fn resolve(&self, id: &str) -> Result<Target, String> {
        let state = self.0.lock().map_err(|error| error.to_string())?;
        if state
            .issued
            .is_none_or(|issued| issued.elapsed() >= SOURCE_LIFETIME)
        {
            return Err("截图窗口列表已过期，请重新选择".into());
        }
        state
            .targets
            .get(id)
            .cloned()
            .ok_or_else(|| "capture-window-unavailable".into())
    }
}
fn active(app: &tauri::AppHandle, window: &WebviewWindow, generation: u64) -> Result<(), String> {
    crate::toolbox::require_active(app, window)?;
    if app.state::<crate::screenshot::Service>().generation()? != generation {
        return Err("截图操作已取消".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn screenshot_windows(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Vec<Source>, String> {
    crate::toolbox::require_active(&app, &window)?;
    let service = app.state::<crate::screenshot::Service>();
    let generation = service.generation()?;
    let sources_generation = service.windows.generation()?;
    let permit = service
        .slot
        .clone()
        .try_acquire_owned()
        .map_err(|_| "正在处理上一项截图操作")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        active(&app, &window, generation)?;
        let targets = crate::platform::capture_targets()?;
        let deadline = Instant::now() + Duration::from_secs(4);
        let mut previews = Vec::new();
        for target in targets {
            active(&app, &window, generation)?;
            let thumbnail = if Instant::now() < deadline {
                let source_deadline = deadline.min(Instant::now() + Duration::from_millis(400));
                crate::platform::capture_thumbnail(&target, source_deadline, || {
                    active(&app, &window, generation).is_err()
                })
                .unwrap_or_default()
            } else {
                String::new()
            };
            previews.push(Preview { target, thumbnail });
        }
        active(&app, &window, generation)?;
        app.state::<crate::screenshot::Service>().windows.replace(
            sources_generation,
            previews,
            || crate::toolbox::require_active(&app, &window),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn screenshot_capture_window(
    app: tauri::AppHandle,
    window: WebviewWindow,
    source_id: String,
) -> Result<crate::screenshot::Document, String> {
    crate::toolbox::require_active(&app, &window)?;
    let service = app.state::<crate::screenshot::Service>();
    let generation = service.generation()?;
    let target = service.windows.resolve(&source_id)?;
    let permit = service
        .slot
        .clone()
        .try_acquire_owned()
        .map_err(|_| "正在处理上一项截图操作")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        active(&app, &window, generation)?;
        let bytes = crate::platform::capture_target(&target, || {
            active(&app, &window, generation).is_err()
        })?;
        let decoded = crate::screenshot::decode(&bytes)?;
        app.state::<crate::screenshot::Service>()
            .create(generation, decoded, || {
                crate::toolbox::require_active(&app, &window)?;
                if app
                    .state::<crate::screenshot::Service>()
                    .windows
                    .resolve(&source_id)?
                    != target
                {
                    return Err("capture-window-unavailable".into());
                }
                Ok(())
            })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn preview(handle: isize) -> Preview {
        Preview {
            target: Target {
                handle,
                process_id: 20,
                thread_id: 21,
                name: "测试窗口 🖼️".into(),
            },
            thumbnail: "data:image/png;base64,test".into(),
        }
    }
    #[test]
    fn sources_are_opaque_exact_replaced_and_revoked() {
        let service = Sources::default();
        assert!(service.resolve("window:123:0").is_err());
        let generation = service.generation().unwrap();
        let sources = service
            .replace(generation, vec![preview(123)], || Ok(()))
            .unwrap();
        let source = &sources[0];
        assert!(uuid::Uuid::parse_str(source.id.strip_prefix("window:").unwrap()).is_ok());
        assert_eq!(service.resolve(&source.id).unwrap(), preview(123).target);
        assert!(service.resolve("123").is_err());
        assert!(service.resolve("window:123:0").is_err());
        service
            .replace(generation, vec![preview(456)], || Ok(()))
            .unwrap();
        assert!(service.resolve(&source.id).is_err());
        service.clear();
        assert!(service
            .replace(generation, vec![preview(123)], || Ok(()))
            .is_err());
        let generation = service.generation().unwrap();
        let sources = service
            .replace(generation, vec![preview(123)], || Ok(()))
            .unwrap();
        service.0.lock().unwrap().issued = Some(Instant::now() - SOURCE_LIFETIME);
        assert!(service.resolve(&sources[0].id).is_err());
    }
    #[test]
    fn invalid_lists_and_failed_publication_preserve_existing_sources() {
        let service = Sources::default();
        let generation = service.generation().unwrap();
        let sources = service
            .replace(generation, vec![preview(123)], || Ok(()))
            .unwrap();
        assert!(service
            .replace(generation, vec![preview(234)], || Err("paused".into()))
            .is_err());
        assert_eq!(service.resolve(&sources[0].id).unwrap().handle, 123);
        for previews in [
            vec![preview(0)],
            vec![preview(123), preview(123)],
            (1..=MAX_WINDOWS as isize + 1).map(preview).collect(),
        ] {
            assert!(service.replace(generation, previews, || Ok(())).is_err());
        }
        assert_eq!(service.resolve(&sources[0].id).unwrap().handle, 123);
    }
    #[test]
    fn thumbnails_are_bounded_without_dropping_window_identity() {
        let service = Sources::default();
        let previews = (1..=MAX_WINDOWS as isize)
            .map(|handle| {
                let mut value = preview(handle);
                value.thumbnail = "x".repeat(MAX_THUMBNAIL);
                value
            })
            .collect();
        let sources = service.replace(0, previews, || Ok(())).unwrap();
        assert_eq!(sources.len(), MAX_WINDOWS);
        assert_eq!(
            sources
                .iter()
                .map(|source| source.thumbnail.len())
                .sum::<usize>(),
            MAX_THUMBNAILS
        );
        assert!(service.resolve(&sources.last().unwrap().id).is_ok());
        let mut oversized = preview(123);
        oversized.thumbnail = "x".repeat(MAX_THUMBNAIL + 1);
        assert!(service.replace(0, vec![oversized], || Ok(())).unwrap()[0]
            .thumbnail
            .is_empty());
    }
}
