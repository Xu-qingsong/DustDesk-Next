use chrono::{DateTime, NaiveDate, Utc};
use serde_json::Value;
use std::collections::HashSet;

pub fn date(value: &Value) -> bool {
    parse_date(value).is_some()
}

pub fn parse_date(value: &Value) -> Option<DateTime<Utc>> {
    let text = value.as_str()?;
    DateTime::parse_from_rfc3339(text)
        .map(|date| date.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            NaiveDate::parse_from_str(text, "%Y-%m-%d")
                .ok()?
                .and_hms_opt(0, 0, 0)
                .map(|date| date.and_utc())
        })
}

fn strings(value: &Value, names: &[&str]) -> bool {
    names
        .iter()
        .all(|name| value.get(*name).is_some_and(Value::is_string))
}

fn collection(value: &Value, valid: impl Fn(&Value) -> bool) -> bool {
    let Some(items) = value.as_array() else {
        return false;
    };
    let mut ids = HashSet::new();
    items.iter().all(|item| {
        item.is_object()
            && item
                .get("Id")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.trim().is_empty() && ids.insert(id))
            && valid(item)
    })
}

fn project(value: &Value) -> bool {
    strings(value, &["Name"])
        && collection(&value["Phases"], |phase| {
            strings(phase, &["Title"])
                && collection(&phase["Subtasks"], |task| strings(task, &["Title"]))
        })
}

fn link(value: &Value) -> bool {
    strings(value, &["Name", "Url"])
}
fn group(value: &Value) -> bool {
    strings(value, &["Name"]) && collection(&value["Links"], link)
}

fn clipboard(value: &Value) -> bool {
    if !strings(value, &["Text"]) {
        return false;
    }
    match value["Kind"].as_str() {
        Some("Text") => true,
        Some("Image") => {
            value["ImagePngBase64"]
                .as_str()
                .is_some_and(|text| !text.is_empty())
                || value["ImageAssetName"].as_str().is_some_and(|name| {
                    name.len() == 68
                        && name.ends_with(".png")
                        && name.as_bytes()[..64]
                            .iter()
                            .copied()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                })
        }
        _ => false,
    }
}

pub fn validate(value: &Value) -> Result<(), String> {
    if value["SchemaVersion"]
        .as_f64()
        .is_some_and(|version| version > 3.0)
    {
        return Err("工作区版本较新，请使用新版应用打开".into());
    }
    if value["SchemaVersion"] != 3 {
        return Err("旧格式须先完成兼容规范化，未改写原文件".into());
    }
    if !value.is_object() || !value["Settings"].is_object() {
        return Err("工作区数据不完整，未保存".into());
    }
    let valid = collection(&value["Todos"], |item| strings(item, &["Title"]))
        && collection(&value["Notes"], |item| strings(item, &["Title", "Text"]))
        && collection(&value["Projects"], project)
        && collection(&value["Launchers"], |item| strings(item, &["Name", "Path"]))
        && collection(&value["LinkGroups"], group)
        && collection(&value["ClipboardHistory"], clipboard)
        && collection(&value["DesktopCategories"], |item| {
            strings(item, &["Name"])
                && item["ItemPaths"]
                    .as_array()
                    .is_some_and(|paths| paths.iter().all(Value::is_string))
        })
        && value["TagPresets"].as_array().is_some_and(|items| {
            items
                .iter()
                .all(|item| item.is_object() && strings(item, &["Name"]))
        });
    if !valid {
        return Err("工作区数据不完整，未保存".into());
    }
    let links: Vec<Value> = value["LinkGroups"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|group| group["Links"].as_array().unwrap().iter().cloned())
        .collect();
    if !collection(&Value::Array(links), link) {
        return Err("链接标识重复，未保存".into());
    }
    for name in ["RecycleBin", "OrganizerRules", "FocusSessions"] {
        if let Some(items) = value.get(name) {
            if !collection(items, |_| true) {
                return Err(format!("{name} 数据不完整或标识重复"));
            }
        }
    }
    if let Some(items) = value["RecycleBin"].as_array() {
        for item in items {
            let payload = &item["value"];
            if !payload.is_object() || !payload["Id"].is_string() || !date(&item["ExpiresAt"]) {
                return Err("回收站数据不完整".into());
            }
            let valid = match item["kind"].as_str() {
                Some("task") => strings(payload, &["Title"]),
                Some("note") => strings(payload, &["Title", "Text"]),
                Some("launcher") => strings(payload, &["Name", "Path"]),
                Some("link") => {
                    link(payload)
                        && item["parent"].is_object()
                        && strings(&item["parent"], &["Id", "Name"])
                }
                Some("group") => group(payload),
                Some("project") => project(payload),
                _ => false,
            };
            if !valid {
                return Err("回收站内容无效".into());
            }
        }
    }
    if let Some(items) = value["OrganizerRules"].as_array() {
        if items.iter().any(|item| {
            !strings(item, &["Pattern", "CategoryId"])
                || !item["Enabled"].is_boolean()
                || !matches!(item["Match"].as_str(), Some("name" | "extension"))
        }) {
            return Err("收纳规则数据无效".into());
        }
    }
    if let Some(items) = value["FocusSessions"].as_array() {
        if items.iter().any(|item| {
            !strings(item, &["TaskTitle", "ProjectName"])
                || !item["Seconds"].as_f64().is_some_and(|value| value >= 0.0)
        }) {
            return Err("专注记录数据无效".into());
        }
    }
    if let Some(active) = value.get("ActiveFocus").filter(|item| !item.is_null()) {
        if !active.is_object()
            || !strings(active, &["Id", "TaskTitle", "ProjectName"])
            || !active["ElapsedSeconds"]
                .as_f64()
                .is_some_and(|value| value >= 0.0)
            || !active["PlannedSeconds"]
                .as_f64()
                .is_some_and(|value| value > 0.0)
            || !date(&active["CheckpointAt"])
            || !(active["RunningSince"].is_null() || date(&active["RunningSince"]))
        {
            return Err("当前专注状态无效".into());
        }
    }
    Ok(())
}

pub fn validate_input(value: &Value) -> Result<(), String> {
    let version = value
        .get("SchemaVersion")
        .cloned()
        .unwrap_or(serde_json::json!(1));
    if version.as_f64().is_some_and(|version| version > 3.0) {
        return Err("工作区版本较新，请使用新版应用打开".into());
    }
    let version = version.as_u64().ok_or("工作区版本无效")?;
    if version > 3 {
        return Err("工作区版本较新，请使用新版应用打开".into());
    }
    if version == 0 {
        return Err("工作区版本无效".into());
    }
    let mut checked = value.clone();
    if !checked.is_object() {
        return Err("工作区数据不完整".into());
    }
    if version == 1 {
        fn assign(items: &mut Value) {
            if let Some(items) = items.as_array_mut() {
                for item in items {
                    if let Some(record) = item.as_object_mut() {
                        if !record.contains_key("Id") {
                            record.insert(
                                "Id".into(),
                                serde_json::json!(uuid::Uuid::new_v4().to_string()),
                            );
                        }
                        for key in ["Phases", "Subtasks", "Links"] {
                            if let Some(items) = record.get_mut(key) {
                                assign(items);
                            }
                        }
                    }
                }
            }
        }
        for key in [
            "Todos",
            "Notes",
            "Projects",
            "Launchers",
            "LinkGroups",
            "ClipboardHistory",
            "DesktopCategories",
        ] {
            assign(&mut checked[key]);
        }
    }
    checked["SchemaVersion"] = serde_json::json!(3);
    validate(&checked)
}
