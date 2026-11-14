use super::validation::parse_date;
use chrono::{DateTime, Datelike, Days, Duration, Local, SecondsFormat, TimeZone, Utc, Weekday};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use uuid::Uuid;

fn supplied_string<'de, Deserializer: serde::Deserializer<'de>>(
    deserializer: Deserializer,
) -> Result<Option<String>, Deserializer::Error> {
    String::deserialize(deserializer).map(Some)
}

#[derive(Debug, Serialize)]
pub struct ActionFailure {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
}

impl From<String> for ActionFailure {
    fn from(error: String) -> Self {
        Self { error, code: None }
    }
}
impl From<&str> for ActionFailure {
    fn from(error: &str) -> Self {
        error.to_string().into()
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    Capture {
        kind: String,
        title: String,
        text: String,
        #[serde(default, deserialize_with = "supplied_string")]
        request_id: Option<String>,
        source_note_id: Option<String>,
    },
    TaskComplete {
        id: String,
        completed: bool,
    },
    NoteEdit {
        id: String,
        title: String,
        text: String,
        previous_text: String,
        previous_title: String,
    },
    RecycleRestore {
        id: String,
    },
    RecycleEmpty {
        ids: Vec<String>,
    },
    RulesSave {
        rules: Vec<Value>,
    },
    FocusStart {
        task_id: String,
        project_id: String,
        minutes: f64,
    },
    FocusPause,
    FocusResume,
    FocusFinish,
    FocusCancel,
    ResourceRelink {
        resource: super::resources::ResourceHealth,
        replacement: String,
    },
}

pub fn time(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(|character: char| matches!(character as u32, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff))
}

fn text(value: &str, maximum: usize, required: bool) -> Result<&str, ActionFailure> {
    if value.encode_utf16().count() > maximum || (required && trim(value).is_empty()) {
        return Err("输入为空或超过长度限制".into());
    }
    Ok(value)
}

fn append(state: &mut Value, key: &str, value: Value) -> Result<(), ActionFailure> {
    let items = state[key].as_array_mut().ok_or("原工作区数据不完整")?;
    if items.iter().any(|item| item["Id"] == value["Id"]) {
        return Err("同一项目已存在，未覆盖现有内容".into());
    }
    items.push(value);
    Ok(())
}

fn restore(state: &mut Value, id: &str, now: DateTime<Utc>) -> Result<(), ActionFailure> {
    let entry = state["RecycleBin"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["Id"] == id)
        .cloned()
        .ok_or("该项目不存在或已过期")?;
    if parse_date(&entry["ExpiresAt"]).is_none_or(|date| date <= now) {
        return Err("该项目不存在或已过期".into());
    }
    let mut value = entry["value"].clone();
    match entry["kind"].as_str().ok_or("回收站内容无效")? {
        "task" => append(state, "Todos", value)?,
        "note" => append(state, "Notes", value)?,
        "project" => append(state, "Projects", value)?,
        "launcher" => append(state, "Launchers", value)?,
        "group" => {
            let ids: HashSet<String> = state["LinkGroups"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|group| group["Links"].as_array().unwrap())
                .map(|link| link["Id"].as_str().unwrap().to_owned())
                .collect();
            value["Links"]
                .as_array_mut()
                .unwrap()
                .retain(|link| !ids.contains(link["Id"].as_str().unwrap()));
            append(state, "LinkGroups", value)?;
        }
        "link" => {
            let groups = state["LinkGroups"].as_array_mut().unwrap();
            if groups.iter().any(|group| {
                group["Links"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|link| link["Id"] == value["Id"])
            }) {
                return Err("链接已存在".into());
            }
            let index = groups
                .iter()
                .position(|group| group["Id"] == entry["parent"]["Id"])
                .unwrap_or_else(|| {
                    let mut group = entry["parent"].clone();
                    group["Links"] = json!([]);
                    groups.push(group);
                    groups.len() - 1
                });
            groups[index]["Links"].as_array_mut().unwrap().push(value);
        }
        _ => return Err("回收站内容无效".into()),
    }
    state["RecycleBin"]
        .as_array_mut()
        .unwrap()
        .retain(|item| item["Id"] != id);
    Ok(())
}

pub fn elapsed(active: &Value, now: DateTime<Utc>) -> f64 {
    let running = parse_date(&active["RunningSince"])
        .map(|start| ((now - start).num_milliseconds() as f64 / 1000.0).max(0.0))
        .unwrap_or(0.0);
    (active["ElapsedSeconds"].as_f64().unwrap_or(0.0) + running)
        .max(0.0)
        .min(active["PlannedSeconds"].as_f64().unwrap_or(0.0))
}

pub fn finish(state: &mut Value, now: DateTime<Utc>) {
    let active = &state["ActiveFocus"];
    if active.is_null() {
        return;
    }
    let seconds = elapsed(active, now).floor();
    if seconds > 0.0 {
        let session = json!({"Id":active["Id"],"TaskId":active["TaskId"],"TaskTitle":active["TaskTitle"],"ProjectId":active["ProjectId"],"ProjectName":active["ProjectName"],"StartedAt":active["StartedAt"],"EndedAt":time(now),"Seconds":seconds,"Completed":seconds >= active["PlannedSeconds"].as_f64().unwrap()});
        state["FocusSessions"].as_array_mut().unwrap().push(session);
    }
    state["ActiveFocus"] = Value::Null;
}

pub fn apply(state: &mut Value, action: Action, now: DateTime<Utc>) -> Result<(), ActionFailure> {
    let stamp = time(now);
    match action {
        Action::Capture {
            kind,
            title,
            text: body,
            request_id,
            source_note_id,
        } => {
            let title = trim(text(&title, 300, true)?);
            text(&body, 200_000, false)?;
            if !["task", "note"].contains(&kind.as_str()) {
                return Err("记录类型无效".into());
            }
            let id = request_id.unwrap_or_else(|| Uuid::new_v4().to_string());
            text(&id, 100, true)?;
            if ["Todos", "Notes"].iter().any(|key| {
                state[*key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|item| item["Id"] == id)
            }) || state["RecycleBin"].as_array().unwrap().iter().any(|item| {
                [Some("task"), Some("note")].contains(&item["kind"].as_str())
                    && item["value"]["Id"] == id
            }) {
                return Ok(());
            }
            if kind == "task" {
                state["Todos"].as_array_mut().unwrap().push(json!({"Id":id,"Title":title,"Tag":"","Note":body,"IsCompleted":false,"CreatedAt":stamp,"CompletedAt":null,"ReminderRepeat":"None"}));
            } else {
                let mut note = source_note_id.and_then(|id| state["Notes"].as_array().unwrap().iter().find(|item| item["Id"] == id).cloned()).unwrap_or_else(|| json!({"ColorArgb":-411768,"FontColorArgb":-1385444,"FontSize":14,"FontBold":false,"BackgroundImageFileName":"","ImageOnly":false}));
                for (key, value) in [
                    ("Id", json!(id)),
                    ("Title", json!(title)),
                    ("Text", json!(body)),
                    ("CreatedAt", json!(stamp)),
                    ("UpdatedAt", json!(stamp)),
                ] {
                    note[key] = value;
                }
                state["Notes"].as_array_mut().unwrap().insert(0, note);
            }
        }
        Action::TaskComplete { id, completed } => {
            let item = state["Todos"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|item| item["Id"] == id)
                .ok_or("任务不存在或参数无效")?;
            item["IsCompleted"] = json!(completed);
        }
        Action::NoteEdit {
            id,
            title,
            text: body,
            previous_text,
            previous_title,
        } => {
            let note = state["Notes"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|item| item["Id"] == id)
                .ok_or_else(|| ActionFailure {
                    error: "便签已删除，请复制当前草稿后另存".into(),
                    code: Some("NOTE_DELETED"),
                })?;
            if note["Text"] != previous_text || note["Title"] != previous_title {
                return Err(ActionFailure {
                    error: "便签已在其他窗口修改，请复制草稿并重新载入后再编辑".into(),
                    code: Some("NOTE_CONFLICT"),
                });
            }
            note["Title"] = json!(trim(text(&title, 300, true)?));
            note["Text"] = json!(text(&body, 200_000, false)?);
            note["UpdatedAt"] = json!(stamp);
        }
        Action::RecycleRestore { id } => restore(state, &id, now)?,
        Action::RecycleEmpty { ids } => state["RecycleBin"]
            .as_array_mut()
            .unwrap()
            .retain(|item| !ids.iter().any(|id| item["Id"] == *id)),
        Action::RulesSave { rules } => {
            if rules.len() > 100 {
                return Err("最多支持 100 条规则".into());
            }
            let mut ids = HashSet::new();
            for rule in &rules {
                let id = rule["Id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or("规则格式无效")?;
                if !ids.insert(id)
                    || !rule["Enabled"].is_boolean()
                    || ![Some("name"), Some("extension")].contains(&rule["Match"].as_str())
                {
                    return Err("规则格式无效".into());
                }
                let pattern = text(
                    rule["Pattern"].as_str().ok_or("输入为空或超过长度限制")?,
                    100,
                    true,
                )?;
                if !pattern.split([',', '，']).any(|part| {
                    let part = trim(part);
                    !part
                        .strip_prefix("*.")
                        .or_else(|| part.strip_prefix('.'))
                        .unwrap_or(part)
                        .is_empty()
                }) {
                    return Err("请输入有效的匹配内容".into());
                }
                if !state["DesktopCategories"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|category| category["Id"] == rule["CategoryId"])
                {
                    return Err("规则对应的分类已删除，请重新选择".into());
                }
            }
            state["OrganizerRules"] = json!(rules);
        }
        Action::FocusStart {
            task_id,
            project_id,
            minutes,
        } => {
            if !state["ActiveFocus"].is_null() {
                return Err("请先结束当前专注".into());
            }
            if !minutes.is_finite() || !(1.0..=180.0).contains(&minutes) {
                return Err("专注时长应为 1–180 分钟".into());
            }
            let task = state["Todos"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["Id"] == task_id);
            let project = state["Projects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["Id"] == project_id);
            if (!task_id.is_empty() && task.is_none())
                || (!project_id.is_empty() && project.is_none())
            {
                return Err("关联的任务或项目已删除".into());
            }
            state["ActiveFocus"] = json!({"Id":Uuid::new_v4().to_string(),"TaskId":task.map(|item|item["Id"].clone()).unwrap_or(json!("")),"TaskTitle":task.map(|item|item["Title"].clone()).unwrap_or(json!("自由专注")),"ProjectId":project.map(|item|item["Id"].clone()).unwrap_or(json!("")),"ProjectName":project.map(|item|item["Name"].clone()).unwrap_or(json!("未关联项目")),"StartedAt":stamp,"PlannedSeconds":(minutes*60.0+0.5).floor(),"ElapsedSeconds":0,"RunningSince":stamp,"CheckpointAt":stamp});
        }
        Action::FocusPause => {
            if state["ActiveFocus"].is_null() {
                return Err("没有进行中的专注".into());
            }
            let seconds = elapsed(&state["ActiveFocus"], now);
            state["ActiveFocus"]["ElapsedSeconds"] = json!(seconds);
            state["ActiveFocus"]["RunningSince"] = Value::Null;
            state["ActiveFocus"]["CheckpointAt"] = json!(stamp);
        }
        Action::FocusResume => {
            if state["ActiveFocus"].is_null() {
                return Err("没有进行中的专注".into());
            }
            if state["ActiveFocus"]["RunningSince"].is_null() {
                state["ActiveFocus"]["RunningSince"] = json!(stamp);
                state["ActiveFocus"]["CheckpointAt"] = json!(stamp);
            }
        }
        Action::FocusFinish => finish(state, now),
        Action::FocusCancel => state["ActiveFocus"] = Value::Null,
        Action::ResourceRelink { .. } => return Err("资源重新关联须通过工作区事务执行".into()),
    }
    Ok(())
}

pub fn recover(state: &mut Value) -> bool {
    if state["ActiveFocus"].is_null() || state["ActiveFocus"]["RunningSince"].is_null() {
        return false;
    }
    let checkpoint = parse_date(&state["ActiveFocus"]["CheckpointAt"]).unwrap();
    state["ActiveFocus"]["ElapsedSeconds"] = json!(elapsed(&state["ActiveFocus"], checkpoint));
    state["ActiveFocus"]["RunningSince"] = Value::Null;
    true
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Notification {
    pub title: &'static str,
    pub body: String,
}

pub fn reminders(state: &mut Value, now: DateTime<Utc>) -> Vec<Notification> {
    reminders_in_zone(state, now, Local)
}

pub(super) fn reminders_in_zone<Tz: TimeZone>(
    state: &mut Value,
    now: DateTime<Utc>,
    zone: Tz,
) -> Vec<Notification> {
    let mut notifications = Vec::new();
    for task in state["Todos"].as_array_mut().unwrap() {
        if task["IsCompleted"] == true
            || task["ReminderNotifiedAt"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        {
            continue;
        }
        let Some(reminder) = parse_date(&task["ReminderAt"]).filter(|date| *date <= now) else {
            continue;
        };
        let repeat = task["ReminderRepeat"].as_str().unwrap_or("None");
        let next = match repeat {
            "Daily" | "Weekly" => {
                let days = if repeat == "Daily" { 1 } else { 7 };
                let interval = Duration::days(days);
                let count = (now - reminder).num_milliseconds() / interval.num_milliseconds() + 1;
                reminder.checked_add_signed(interval * count as i32)
            }
            "Weekdays" => {
                let mut next = reminder.with_timezone(&zone);
                while next.with_timezone(&Utc) <= now {
                    // JavaScript setDate advances the local calendar, including DST.
                    let Some(local) = next.naive_local().checked_add_days(Days::new(1)) else {
                        break;
                    };
                    next = zone
                        .from_local_datetime(&local)
                        .earliest()
                        .unwrap_or_else(|| next.clone() + Duration::days(1));
                    while matches!(next.weekday(), Weekday::Sat | Weekday::Sun) {
                        let Some(local) = next.naive_local().checked_add_days(Days::new(1)) else {
                            break;
                        };
                        next = zone
                            .from_local_datetime(&local)
                            .earliest()
                            .unwrap_or_else(|| next.clone() + Duration::days(1));
                    }
                }
                Some(next.with_timezone(&Utc))
            }
            _ => None,
        };
        if let Some(next) = next.filter(|date| *date > now) {
            task["ReminderAt"] = json!(time(next));
            task["ReminderNotifiedAt"] = Value::Null;
        } else {
            task["ReminderNotifiedAt"] = json!(time(now));
        }
        notifications.push(Notification {
            title: "DustDesk 任务提醒",
            body: task["Title"]
                .as_str()
                .filter(|title| !title.is_empty())
                .unwrap_or("有一项任务到期")
                .to_owned(),
        });
    }
    notifications
}

pub fn tick(state: &mut Value, now: DateTime<Utc>) -> bool {
    let previous_entries = state["RecycleBin"].as_array().unwrap().len();
    state["RecycleBin"]
        .as_array_mut()
        .unwrap()
        .retain(|item| parse_date(&item["ExpiresAt"]).is_some_and(|date| date > now));
    let mut changed = state["RecycleBin"].as_array().unwrap().len() != previous_entries;
    let active = &state["ActiveFocus"];
    if !active.is_null() && !active["RunningSince"].is_null() {
        let checkpoint = parse_date(&active["CheckpointAt"]).unwrap();
        if (now - checkpoint).num_milliseconds() > 20_000 {
            recover(state);
            changed = true;
        } else if elapsed(active, now) >= active["PlannedSeconds"].as_f64().unwrap() {
            finish(state, now);
            changed = true;
        } else {
            let checkpoint = json!(time(now));
            if state["ActiveFocus"]["CheckpointAt"] != checkpoint {
                state["ActiveFocus"]["CheckpointAt"] = checkpoint;
                changed = true;
            }
        }
    }
    changed
}
