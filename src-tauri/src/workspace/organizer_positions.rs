use crate::desktop_positions::{self, DesktopPosition};
use serde_json::{json, Value};
use std::path::Path;

const FIELD: &str = "OrganizerDesktopPositions";
fn key(path: &Path) -> Result<String, String> {
    crate::system::path_key(path.to_str().ok_or("桌面位置路径无效")?)
}
pub(super) fn on_desktop(desktop: &Path, path: &Path) -> bool {
    path.parent().and_then(|parent| key(parent).ok()) == key(desktop).ok()
}
pub(super) fn prepare(
    after: &mut Value,
    desktop: &Path,
    source: &Path,
    target: &Path,
    session_restore: bool,
    recollect: bool,
) -> Result<Option<DesktopPosition>, String> {
    let source_key = key(source)?;
    let target_key = key(target)?;
    let mut positions = match after.get(FIELD) {
        None | Some(Value::Null) => serde_json::Map::new(),
        Some(Value::Object(positions)) => positions.clone(),
        _ => return Err("桌面图标位置记录格式无效，已保留".into()),
    };
    let existing = positions.get(&source_key).cloned();
    let mut position =
        existing.and_then(|value| serde_json::from_value::<DesktopPosition>(value).ok());
    if on_desktop(desktop, source) {
        // Session recollection retains the saved position if Explorer has not refreshed yet.
        position = desktop_positions::capture(desktop, source).or_else(|| {
            recollect
                .then(|| {
                    positions
                        .get(&target_key)
                        .cloned()
                        .and_then(|value| serde_json::from_value(value).ok())
                })
                .flatten()
        });
    }
    if !session_restore {
        positions.remove(&source_key);
    }
    if !on_desktop(desktop, target) {
        positions.remove(&target_key);
        if let Some(position) = &position {
            positions.insert(target_key, json!(position));
        }
    }
    if !positions.is_empty() || after.get(FIELD).is_some() {
        after[FIELD] = Value::Object(positions);
    }
    Ok(position)
}
