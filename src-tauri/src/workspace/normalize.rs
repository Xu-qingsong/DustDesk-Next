use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

const SIDEBAR: &[&str] = &[
    "overview",
    "tasks",
    "notes",
    "projects",
    "library",
    "clipboard",
    "organizer",
    "screenshot",
    "monitor",
    "focus",
    "stats",
    "health",
    "recycle",
    "textTools",
    "imageTools",
    "lan",
];

fn expand(value: &mut Value) {
    match value {
        Value::String(text) if text == "__DUSTDESK_NOW__" => {
            *text = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
        }
        Value::String(text) if text.starts_with("__DUSTDESK_UUID_") => {
            *text = Uuid::new_v4().to_string()
        }
        Value::Array(items) => items.iter_mut().for_each(expand),
        Value::Object(items) => items.values_mut().for_each(expand),
        _ => {}
    }
}

pub fn default_state() -> Value {
    let mut state: Value =
        serde_json::from_str(include_str!("../../resources/workspace-defaults.json"))
            .expect("valid checked-in workspace defaults");
    expand(&mut state);
    state
}

fn ids(value: Option<&Value>, allowed: &[&str]) -> Vec<Value> {
    let mut result = Vec::new();
    if let Some(items) = value.and_then(Value::as_array) {
        for item in items {
            if item.as_str().is_some_and(|text| allowed.contains(&text)) && !result.contains(item) {
                result.push(item.clone());
            }
        }
    }
    result
}

fn widget_key(value: &str) -> bool {
    if [
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
    ]
    .contains(&value)
    {
        return true;
    }
    let uuid = |id: &str| {
        id.len() == 36
            && id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    };
    if let Some(id) = value
        .strip_prefix("note:")
        .or_else(|| value.strip_prefix("project:"))
    {
        return uuid(id);
    }
    value
        .strip_prefix("organizer-group:")
        .is_some_and(|ids| ids.split(',').all(uuid))
}

fn placement(value: &Value) -> Option<Value> {
    let source = value.as_object()?;
    let mut output = source.clone();
    for key in [
        "Visible",
        "Locked",
        "TopMost",
        "AutoCollapseEnabled",
        "IsCollapsed",
        "SnapToEdges",
        "TransparentBackground",
    ] {
        output.remove(key);
        if let Some(value) = source.get(key).filter(|value| value.is_boolean()) {
            output.insert(key.into(), value.clone());
        }
    }
    for key in ["X", "Y", "Width", "Height"] {
        output.remove(key);
        if let Some(original) = source.get(key) {
            if let Some(value) = original.as_f64() {
                let rounded = (value + 0.5).floor();
                let number = if value.abs() <= 9_007_199_254_740_991.0 && value == rounded {
                    original.clone()
                } else {
                    json!(rounded)
                };
                output.insert(key.into(), number);
            }
        }
    }
    output.remove("DockEdge");
    if value["DockEdge"]
        .as_str()
        .is_some_and(|edge| ["None", "Left", "Right", "Top", "Bottom"].contains(&edge))
    {
        output.insert("DockEdge".into(), value["DockEdge"].clone());
    }
    Some(Value::Object(output))
}

fn placements(value: &Value) -> Value {
    Value::Object(
        value
            .as_object()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|(key, value)| {
                        if widget_key(key) {
                            placement(value).map(|value| (key.clone(), value))
                        } else {
                            None
                        }
                    })
                    .collect()
            })
            .unwrap_or_default(),
    )
}

fn defaults(value: &mut Value, fallback: Value) {
    for (name, default) in fallback.as_object().unwrap() {
        let accepted = value.get(name).is_some_and(|candidate| match default {
            Value::String(_) => candidate.is_string(),
            Value::Number(_) => candidate.is_number(),
            Value::Bool(_) => candidate.is_boolean(),
            Value::Null => candidate.is_string(),
            Value::Array(_) => candidate.is_array(),
            Value::Object(_) => candidate.is_object(),
        });
        if !accepted {
            value[name] = default.clone();
        }
    }
}

pub fn normalize(mut value: Value) -> Result<Value, String> {
    let base = default_state();
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let settings = value["Settings"].as_object_mut().ok_or("设置数据不完整")?;
    let original = Value::Object(settings.clone());
    for (key, default) in base["Settings"].as_object().unwrap() {
        if !default.is_array() && !default.is_object() {
            let valid = settings.get(key).is_some_and(|candidate| {
                (default.is_string() && candidate.is_string())
                    || (default.is_number() && candidate.is_number())
                    || (default.is_boolean() && candidate.is_boolean())
            });
            if !valid {
                settings.insert(key.clone(), default.clone());
            }
        }
    }
    let mut order = ids(original.get("SidebarOrder"), SIDEBAR);
    for name in SIDEBAR {
        let name = json!(name);
        if !order.contains(&name) {
            order.push(name);
        }
    }
    settings.insert("SidebarOrder".into(), json!(order));
    let hidden = if original["SidebarHidden"].is_array() {
        ids(original.get("SidebarHidden"), SIDEBAR)
    } else {
        vec![json!("textTools"), json!("imageTools"), json!("lan")]
    };
    settings.insert("SidebarHidden".into(), json!(hidden));
    settings.insert(
        "WidgetPlacements".into(),
        placements(&original["WidgetPlacements"]),
    );
    let presets = original["WidgetLayoutPresets"]
        .as_object()
        .map(|items| {
            items
                .iter()
                .filter(|(_, value)| value.is_object())
                .map(|(key, value)| (key.clone(), placements(value)))
                .collect()
        })
        .unwrap_or_default();
    settings.insert("WidgetLayoutPresets".into(), Value::Object(presets));
    for (name, id_name) in [
        ("NoteWidgetPlacements", "NoteId"),
        ("OrganizerGroupWidgetPlacements", "GroupId"),
    ] {
        let items = original[name]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let id = item[id_name].as_str().filter(|text| !text.is_empty())?;
                        let mut output = placement(item)?;
                        output[id_name] = json!(id);
                        if id_name == "GroupId" {
                            output["CategoryIds"] = json!(item["CategoryIds"]
                                .as_array()
                                .map(|items| items
                                    .iter()
                                    .filter(|value| value.is_string())
                                    .cloned()
                                    .collect::<Vec<_>>())
                                .unwrap_or_default());
                        }
                        Some(output)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        settings.insert(name.into(), json!(items));
    }
    for name in ["SearchCustomRoots", "DesktopHotKeyWidgetKeys"] {
        let items = original[name]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter(|value| {
                        value.as_str().is_some_and(|text| {
                            name != "DesktopHotKeyWidgetKeys" || widget_key(text)
                        })
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        settings.insert(name.into(), json!(items));
    }
    let retention = settings["BackupRetentionDays"].as_f64().unwrap_or(30.0);
    let normalized_retention = (retention + 0.5).floor().clamp(1.0, 365.0);
    if retention != normalized_retention {
        settings.insert("BackupRetentionDays".into(), json!(normalized_retention));
    }
    value["SchemaVersion"] = json!(3);
    value["LegacyImportCompleted"] = json!(value["LegacyImportCompleted"] == true);
    if !value["QuickNote"].is_string() {
        value["QuickNote"] = json!("");
    }
    for name in ["RecycleBin", "OrganizerRules", "FocusSessions"] {
        if value.get(name).is_none() {
            value[name] = json!([]);
        }
    }
    if value.get("ActiveFocus").is_none() {
        value["ActiveFocus"] = Value::Null;
    }
    for item in value["Todos"].as_array_mut().ok_or("任务数据不完整")? {
        defaults(
            item,
            json!({"Id":Uuid::new_v4().to_string(),"Title":"","Tag":"","Note":"","IsCompleted":false,"CreatedAt":now,"CompletedAt":null,"ReminderAt":null,"ReminderNotifiedAt":null,"ReminderRepeat":"None"}),
        );
        if !["None", "Daily", "Weekdays", "Weekly"]
            .contains(&item["ReminderRepeat"].as_str().unwrap())
        {
            item["ReminderRepeat"] = json!("None");
        }
    }
    for item in value["Notes"].as_array_mut().ok_or("便签数据不完整")? {
        defaults(
            item,
            json!({"Id":Uuid::new_v4().to_string(),"Title":"","Text":"","ColorArgb":-411768,"FontColorArgb":-1385444,"FontSize":14,"FontBold":false,"BackgroundImagePath":null,"BackgroundImageFileName":"","ImageOnly":false,"CreatedAt":now,"UpdatedAt":now}),
        );
    }
    for project in value["Projects"].as_array_mut().ok_or("项目数据不完整")? {
        defaults(
            project,
            json!({"Id":Uuid::new_v4().to_string(),"Name":"","ProjectPath":"","Phases":[]}),
        );
        for phase in project["Phases"].as_array_mut().unwrap() {
            defaults(
                phase,
                json!({"Id":Uuid::new_v4().to_string(),"Title":"","Status":"Todo","StartDate":null,"EndDate":null,"ProgressPercent":0,"ProjectPath":"","Subtasks":[]}),
            );
            if !["Todo", "Doing", "Done"].contains(&phase["Status"].as_str().unwrap()) {
                phase["Status"] = json!("Todo");
            }
            for task in phase["Subtasks"].as_array_mut().unwrap() {
                defaults(
                    task,
                    json!({"Id":Uuid::new_v4().to_string(),"Title":"","IsCompleted":false,"FilePath":""}),
                );
            }
        }
    }
    for item in value["Launchers"].as_array_mut().ok_or("启动项不完整")? {
        defaults(
            item,
            json!({"Id":Uuid::new_v4().to_string(),"Name":"","Path":""}),
        );
    }
    for group in value["LinkGroups"].as_array_mut().ok_or("链接分组不完整")? {
        defaults(
            group,
            json!({"Id":Uuid::new_v4().to_string(),"Name":"未命名","Links":[]}),
        );
        for link in group["Links"].as_array_mut().unwrap() {
            defaults(
                link,
                json!({"Id":Uuid::new_v4().to_string(),"Name":"","Url":"","Note":"","CreatedAt":now,"UpdatedAt":now}),
            );
        }
    }
    if value["LinkGroups"].as_array().unwrap().is_empty() {
        value["LinkGroups"] = base["LinkGroups"].clone();
    }
    for item in value["ClipboardHistory"]
        .as_array_mut()
        .ok_or("剪贴板数据不完整")?
    {
        defaults(
            item,
            json!({"Id":Uuid::new_v4().to_string(),"Kind":"Text","Text":"","ImagePngBase64":"","ImageFileName":"","ImageSha256":"","CreatedAt":now,"IsLocked":false,"IsPinned":false}),
        );
    }
    for item in value["DesktopCategories"]
        .as_array_mut()
        .ok_or("收纳数据不完整")?
    {
        defaults(
            item,
            json!({"Id":Uuid::new_v4().to_string(),"Name":"未命名","IsCollapsed":false,"ItemPaths":[]}),
        );
    }
    for item in value["TagPresets"].as_array_mut().ok_or("标签数据不完整")? {
        defaults(item, json!({"ColorArgb":-1576078}));
    }
    value["TagPresets"]
        .as_array_mut()
        .unwrap()
        .retain(|item| !item["Name"].as_str().unwrap_or("").is_empty());
    if value.get("OrganizerUndoStack").is_none() {
        value["OrganizerUndoStack"] = json!([]);
    }
    super::validation::validate(&value)?;
    Ok(value)
}
