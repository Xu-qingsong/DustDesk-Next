use super::{Snapshot, WorkspaceStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const STANDARD: &[&str] = &[
    "todo",
    "notes",
    "projects",
    "launcher",
    "links",
    "clipboard",
    "organizer",
    "search",
    "monitor",
    "countdown",
];

pub fn round_coordinate(value: f64) -> f64 {
    (value + 0.5).floor()
}

pub fn valid_key(key: &str) -> bool {
    let identifier = |value: &str| {
        value.len() == 36
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    };
    STANDARD.contains(&key)
        || key
            .strip_prefix("note:")
            .or_else(|| key.strip_prefix("project:"))
            .is_some_and(identifier)
        || key
            .strip_prefix("organizer-group:")
            .is_some_and(|value| !value.is_empty() && value.split(',').all(identifier))
}
pub fn exists(key: &str, state: &Value) -> bool {
    if let Some(id) = key.strip_prefix("note:") {
        return state["Notes"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["Id"] == id));
    }
    if let Some(id) = key.strip_prefix("project:") {
        return state["Projects"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["Id"] == id));
    }
    if let Some(ids) = key.strip_prefix("organizer-group:") {
        return state["DesktopCategories"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| ids.split(',').any(|id| item["Id"] == id))
        });
    }
    STANDARD.contains(&key)
}

pub fn project(mut snapshot: Snapshot, key: &str) -> Snapshot {
    let field = match key {
        "todo" => "Todos",
        "notes" => "Notes",
        "projects" => "Projects",
        "launcher" => "Launchers",
        "links" => "LinkGroups",
        "clipboard" => "ClipboardHistory",
        "organizer" => "DesktopCategories",
        _ if key.starts_with("note:") => "Notes",
        _ if key.starts_with("project:") => "Projects",
        _ if key.starts_with("organizer-group:") => "DesktopCategories",
        _ => "",
    };
    for (name, value) in snapshot.state.as_object_mut().unwrap() {
        if name == "Settings" || name == "SchemaVersion" || name == field {
            continue;
        }
        *value = match value {
            Value::Array(_) => json!([]),
            Value::Object(_) => json!({}),
            Value::String(_) => json!(""),
            Value::Bool(_) => json!(false),
            Value::Number(_) => json!(0),
            Value::Null => Value::Null,
        };
    }
    if let Some(id) = key
        .strip_prefix("note:")
        .or_else(|| key.strip_prefix("project:"))
    {
        if let Some(items) = snapshot.state[field].as_array_mut() {
            items.retain(|item| item["Id"] == id);
        }
    }
    if let Some(ids) = key.strip_prefix("organizer-group:") {
        if let Some(items) = snapshot.state[field].as_array_mut() {
            items.retain(|item| ids.split(',').any(|id| item["Id"] == id));
        }
    }
    snapshot.path.clear();
    snapshot
}

pub fn authorize_action(key: &str, action: &Value) -> Result<(), String> {
    let allowed = match action["type"].as_str() {
        Some("task-complete") => key == "todo",
        Some("note-edit") => {
            key == "notes"
                || key
                    .strip_prefix("note:")
                    .is_some_and(|id| action["id"] == id)
        }
        Some("capture") if action["kind"] == "task" => key == "todo",
        Some("capture") if action["kind"] == "note" => {
            key == "notes"
                || key
                    .strip_prefix("note:")
                    .is_some_and(|id| action["sourceNoteId"] == id)
        }
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err("小组件无此业务操作权限".into())
    }
}

pub fn permits_resource(state: &Value, role: &str, target: &str, url: bool) -> bool {
    if url {
        return role == "links"
            && state["LinkGroups"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|group| group["Links"].as_array().into_iter().flatten())
                .any(|link| {
                    link["Url"].as_str().is_some_and(|value| {
                        super::productivity::trim(value) == super::productivity::trim(target)
                    })
                });
    }
    let Ok(key) = crate::system::path_key(target) else {
        return false;
    };
    match role {
        "launcher" => state["Launchers"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|item| {
                item["Path"].as_str().is_some_and(|value| {
                    crate::system::path_key(value).is_ok_and(|value| value == key)
                })
            }),
        "organizer" => state["DesktopCategories"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|category| category["ItemPaths"].as_array().into_iter().flatten())
            .any(|value| {
                value.as_str().is_some_and(|value| {
                    crate::system::path_key(value).is_ok_and(|value| value == key)
                })
            }),
        role if role.starts_with("organizer-group:") => state["DesktopCategories"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|category| role[16..].split(',').any(|id| category["Id"] == id))
            .flat_map(|category| category["ItemPaths"].as_array().into_iter().flatten())
            .any(|value| {
                value.as_str().is_some_and(|value| {
                    crate::system::path_key(value).is_ok_and(|value| value == key)
                })
            }),
        _ => false,
    }
}
pub fn permits_note_image(state: &Value, role: &str, path: &str) -> bool {
    (role == "notes" || role.starts_with("note:"))
        && state["Notes"].as_array().into_iter().flatten().any(|note| {
            (role == "notes"
                || role
                    .strip_prefix("note:")
                    .is_some_and(|id| note["Id"] == id))
                && note["BackgroundImagePath"] == path
        })
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Rect {
    pub fn defaults(key: &str) -> Self {
        let (width, height) = match key {
            "search" => (520.0, 52.0),
            "countdown" => (540.0, 254.0),
            "links" => (360.0, 320.0),
            "monitor" => (420.0, 260.0),
            _ => (390.0, 320.0),
        };
        Self {
            x: 120.0,
            y: 120.0,
            width,
            height,
        }
    }
    pub fn restore(key: &str, placement: &Value, fallback: Self, areas: &[Self]) -> Self {
        let number = |name: &str, fallback: f64| {
            placement[name]
                .as_f64()
                .filter(|value| value.is_finite())
                .unwrap_or(fallback)
        };
        let mut bounds = Self {
            x: number("X", fallback.x),
            y: number("Y", fallback.y),
            width: number("Width", fallback.width)
                .clamp(if key == "search" { 52.0 } else { 300.0 }, 1200.0)
                .round(),
            height: number("Height", fallback.height)
                .clamp(if key == "search" { 52.0 } else { 120.0 }, 900.0)
                .round(),
        };
        if let Some(area) = areas
            .iter()
            .find(|area| {
                bounds.x + (bounds.width / 2.0).round() >= area.x
                    && bounds.x + (bounds.width / 2.0).round() < area.x + area.width
                    && bounds.y + (bounds.height / 2.0).round() >= area.y
                    && bounds.y + (bounds.height / 2.0).round() < area.y + area.height
            })
            .or_else(|| {
                areas.iter().min_by(|left, right| {
                    distance(bounds, **left).total_cmp(&distance(bounds, **right))
                })
            })
        {
            bounds.x = round_coordinate(
                bounds
                    .x
                    .clamp(area.x - bounds.width + 80.0, area.x + area.width - 80.0),
            );
            bounds.y = round_coordinate(bounds.y.clamp(area.y, area.y + area.height - 34.0));
        }
        bounds
    }
    pub fn snap(self, areas: &[Self], enabled: bool) -> (Self, &'static str) {
        if !enabled {
            return (self, "None");
        }
        let Some(area) = areas
            .iter()
            .min_by(|left, right| distance(self, **left).total_cmp(&distance(self, **right)))
        else {
            return (self, "None");
        };
        let left = (self.x - area.x).abs();
        let right = (self.x - (area.x + area.width - self.width)).abs();
        let top = (self.y - area.y).abs();
        let bottom = (self.y - (area.y + area.height - self.height)).abs();
        let horizontal = if left.min(right) <= 24.0 {
            if left <= right {
                "Left"
            } else {
                "Right"
            }
        } else {
            "None"
        };
        let vertical = if top.min(bottom) <= 24.0 {
            if top <= bottom {
                "Top"
            } else {
                "Bottom"
            }
        } else {
            "None"
        };
        let mut result = self;
        if horizontal == "Left" {
            result.x = area.x;
        } else if horizontal == "Right" {
            result.x = area.x + area.width - self.width;
        }
        if vertical == "Top" {
            result.y = area.y;
        } else if vertical == "Bottom" {
            result.y = area.y + area.height - self.height;
        }
        (
            result,
            if horizontal != "None" {
                horizontal
            } else {
                vertical
            },
        )
    }
}
fn distance(bounds: Rect, area: Rect) -> f64 {
    let center_x = bounds.x + bounds.width / 2.0;
    let center_y = bounds.y + bounds.height / 2.0;
    (center_x - center_x.clamp(area.x, area.x + area.width)).powi(2)
        + (center_y - center_y.clamp(area.y, area.y + area.height)).powi(2)
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub locked: Option<bool>,
    pub top_most: Option<bool>,
    pub transparent_background: Option<bool>,
    pub auto_collapse: Option<bool>,
    pub collapsed: Option<bool>,
    pub snap_to_edges: Option<bool>,
    pub height: Option<f64>,
}

impl WorkspaceStore {
    pub fn widget_load(&mut self) -> Result<Snapshot, String> {
        let state = self.read()?;
        Ok(self.snapshot(state))
    }
    pub fn widget_visible(&mut self, key: &str, visible: bool) -> Result<Snapshot, String> {
        let mut state = self.read()?;
        if !valid_key(key) || (visible && !exists(key, &state)) {
            return Err("小组件对应的项目、便签或分类已不存在".into());
        }
        if !state["Settings"]["WidgetPlacements"][key].is_object() {
            state["Settings"]["WidgetPlacements"][key] = json!({});
        }
        state["Settings"]["WidgetPlacements"][key]["Visible"] = json!(visible);
        self.write(&mut state, true)?;
        Ok(self.snapshot(state))
    }
    pub fn widget_options(
        &mut self,
        key: &str,
        options: Options,
        snapped: Option<(Rect, &'static str)>,
    ) -> Result<Snapshot, String> {
        if !valid_key(key) || options.height.is_some_and(|height| !height.is_finite()) {
            return Err("小组件参数无效".into());
        }
        let mut state = self.read()?;
        if !state["Settings"]["WidgetPlacements"][key].is_object() {
            state["Settings"]["WidgetPlacements"][key] = json!({});
        }
        let placement = state["Settings"]["WidgetPlacements"][key]
            .as_object_mut()
            .unwrap();
        for (name, value) in [
            ("Locked", options.locked),
            ("TopMost", options.top_most),
            ("TransparentBackground", options.transparent_background),
            ("AutoCollapseEnabled", options.auto_collapse),
            ("IsCollapsed", options.collapsed),
            ("SnapToEdges", options.snap_to_edges),
        ] {
            if let Some(value) = value {
                placement.insert(name.into(), json!(value));
            }
        }
        if options.snap_to_edges == Some(false) {
            placement.insert("DockEdge".into(), json!("None"));
        }
        if placement.get("Locked") != Some(&json!(true)) {
            if let Some((bounds, edge)) = snapped {
                placement.insert("X".into(), json!(bounds.x));
                placement.insert("Y".into(), json!(bounds.y));
                placement.insert("DockEdge".into(), json!(edge));
            }
        }
        if key == "search" {
            if let Some(height) = options.height {
                placement.insert("Height".into(), json!(height.round().clamp(52.0, 480.0)));
            }
        }
        self.write(&mut state, true)?;
        Ok(self.snapshot(state))
    }
    pub fn widget_geometry(
        &mut self,
        key: &str,
        bounds: Rect,
        edge: &str,
        resize: bool,
    ) -> Result<Snapshot, String> {
        if !valid_key(key)
            || [bounds.x, bounds.y, bounds.width, bounds.height]
                .iter()
                .any(|value| !value.is_finite())
        {
            return Err("小组件位置或尺寸无效".into());
        }
        let mut state = self.read()?;
        if state["Settings"]["WidgetPlacements"][key]["Locked"] == true {
            return Err("小组件已锁定".into());
        }
        if !state["Settings"]["WidgetPlacements"][key].is_object() {
            state["Settings"]["WidgetPlacements"][key] = json!({});
        }
        let placement = &mut state["Settings"]["WidgetPlacements"][key];
        if resize {
            placement["Width"] = json!(bounds
                .width
                .round()
                .clamp(if key == "search" { 52.0 } else { 300.0 }, 1200.0));
            placement["Height"] = json!(bounds
                .height
                .round()
                .clamp(if key == "search" { 52.0 } else { 120.0 }, 900.0));
        } else {
            placement["X"] = json!(round_coordinate(bounds.x));
            placement["Y"] = json!(round_coordinate(bounds.y));
            placement["DockEdge"] = json!(edge);
        }
        self.write(&mut state, true)?;
        Ok(self.snapshot(state))
    }
    pub fn widget_preset(&mut self, action: &str, name: &str) -> Result<Snapshot, String> {
        let mut state = self.read()?;
        let presets = &mut state["Settings"]["WidgetLayoutPresets"];
        match action {
            "save" => {
                if name.trim().is_empty() || name.encode_utf16().count() > 80 {
                    return Err("布局名称无效".into());
                }
                state["Settings"]["WidgetLayoutPresets"][name.trim()] =
                    state["Settings"]["WidgetPlacements"].clone();
            }
            "apply" => {
                let preset = presets
                    .get(name)
                    .filter(|preset| preset.is_object())
                    .ok_or("布局不存在")?
                    .clone();
                state["Settings"]["WidgetPlacements"] = preset;
            }
            "delete" => {
                presets
                    .as_object_mut()
                    .ok_or("布局数据无效")?
                    .remove(name)
                    .ok_or("布局不存在")?;
            }
            _ => return Err("布局操作无效".into()),
        }
        self.write(&mut state, true)?;
        Ok(self.snapshot(state))
    }
    pub fn widget_native_geometry(
        &mut self,
        key: &str,
        bounds: Rect,
        edge: &str,
    ) -> Result<Snapshot, String> {
        let mut state = self.read()?;
        if !valid_key(key) || state["Settings"]["WidgetPlacements"][key]["Locked"] == true {
            return Err("小组件已锁定或标识无效".into());
        }
        if !state["Settings"]["WidgetPlacements"][key].is_object() {
            state["Settings"]["WidgetPlacements"][key] = json!({});
        }
        let placement = &mut state["Settings"]["WidgetPlacements"][key];
        placement["X"] = json!(bounds.x);
        placement["Y"] = json!(bounds.y);
        placement["Width"] = json!(bounds.width);
        if placement["IsCollapsed"] != true {
            placement["Height"] = json!(bounds.height);
        }
        placement["DockEdge"] = json!(edge);
        self.write(&mut state, true)?;
        Ok(self.snapshot(state))
    }
}

#[cfg(test)]
#[path = "widget_tests.rs"]
mod tests;
