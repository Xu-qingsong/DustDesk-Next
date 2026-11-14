use super::{backup, productivity, WorkspaceStore};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Semaphore;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceHealth {
    pub kind: String,
    pub id: String,
    #[serde(
        default,
        deserialize_with = "parent_id",
        skip_serializing_if = "Option::is_none"
    )]
    pub parent_id: Option<String>,
    pub name: String,
    pub target: String,
    pub status: String,
    pub detail: String,
}
fn parent_id<'de, Deserializer: serde::Deserializer<'de>>(
    deserializer: Deserializer,
) -> Result<Option<String>, Deserializer::Error> {
    String::deserialize(deserializer).map(Some)
}
impl ResourceHealth {
    pub fn same_reference(&self, other: &Self) -> bool {
        self.kind == other.kind
            && self.id == other.id
            && self.parent_id == other.parent_id
            && self.target == other.target
    }
}

pub fn collect(state: &Value) -> Vec<ResourceHealth> {
    let mut output = Vec::new();
    let mut add = |kind: &str, id: &Value, name: String, target: &Value, parent: Option<&Value>| {
        if let Some(target) = target.as_str().filter(|target| !target.is_empty()) {
            output.push(ResourceHealth {
                kind: kind.into(),
                id: id.as_str().unwrap().into(),
                name,
                target: target.into(),
                parent_id: parent.map(|parent| parent.as_str().unwrap().into()),
                status: "ok".into(),
                detail: String::new(),
            });
        }
    };
    for item in state["Launchers"].as_array().unwrap() {
        add(
            "launcher",
            &item["Id"],
            item["Name"].as_str().unwrap().into(),
            &item["Path"],
            None,
        );
    }
    for project in state["Projects"].as_array().unwrap() {
        let name = project["Name"].as_str().unwrap();
        add(
            "project",
            &project["Id"],
            name.into(),
            &project["ProjectPath"],
            None,
        );
        for phase in project["Phases"].as_array().unwrap() {
            add(
                "phase",
                &phase["Id"],
                format!("{} / {}", name, phase["Title"].as_str().unwrap()),
                &phase["ProjectPath"],
                Some(&project["Id"]),
            );
            for item in phase["Subtasks"].as_array().unwrap() {
                add(
                    "subtask",
                    &item["Id"],
                    format!("{} / {}", name, item["Title"].as_str().unwrap()),
                    &item["FilePath"],
                    Some(&phase["Id"]),
                );
            }
        }
    }
    for category in state["DesktopCategories"].as_array().unwrap() {
        for target in category["ItemPaths"].as_array().unwrap() {
            add(
                "organizer",
                target,
                category["Name"].as_str().unwrap().into(),
                target,
                Some(&category["Id"]),
            );
        }
    }
    for group in state["LinkGroups"].as_array().unwrap() {
        for link in group["Links"].as_array().unwrap() {
            add(
                "link",
                &link["Id"],
                link["Name"].as_str().unwrap().into(),
                &link["Url"],
                Some(&group["Id"]),
            );
        }
    }
    output
}

pub fn http_url(value: &str) -> Option<reqwest::Url> {
    let trimmed = productivity::trim(value).to_ascii_lowercase();
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| !host.is_empty()))
    .then_some(url)
}

pub(super) async fn probe_path(target: String, slots: Arc<Semaphore>) -> io::Result<()> {
    let permit = slots.acquire_owned().await.map_err(io::Error::other)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        std::fs::metadata(target).map(|_| ())
    })
    .await
    .map_err(io::Error::other)?
}

pub async fn inspect(
    mut item: ResourceHealth,
    client: reqwest::Client,
    slots: Arc<Semaphore>,
) -> ResourceHealth {
    if item.kind == "link" {
        let outcome = tokio::time::timeout(Duration::from_secs(6), async {
            let url = http_url(&item.target).ok_or(())?;
            if !url.username().is_empty() || url.password().is_some() {
                return Err(());
            }
            let response = client.head(url.clone()).send().await.map_err(|_| ())?;
            let status = response.status();
            drop(response);
            if [405, 501].contains(&status.as_u16()) {
                Ok::<_, ()>(client.get(url).send().await.map_err(|_| ())?.status())
            } else {
                Ok(status)
            }
        })
        .await;
        match outcome {
            Ok(Ok(status)) => {
                item.status = if status.is_success() { "ok" } else { "warning" }.into();
                item.detail = format!(
                    "HTTP {}{}",
                    status.as_u16(),
                    if status.is_success() {
                        ""
                    } else {
                        "，可能需要登录或受访问限制"
                    }
                );
            }
            _ => {
                item.status = "warning".into();
                item.detail = "暂时无法访问，请在浏览器中确认；不会自动删除".into();
            }
        }
    } else {
        match tokio::time::timeout(
            Duration::from_secs(6),
            probe_path(item.target.clone(), slots),
        )
        .await
        {
            Ok(Ok(())) => item.detail = "路径可用".into(),
            Ok(Err(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) =>
            {
                item.status = "missing".into();
                item.detail = "路径不存在，可重新关联".into();
            }
            _ => {
                item.status = "warning".into();
                item.detail = "暂时无法读取路径，请检查权限或磁盘连接".into();
            }
        }
    }
    item
}

fn absolute(target: &str) -> Result<PathBuf, String> {
    let path = std::path::absolute(target).map_err(|error| error.to_string())?;
    let mut output = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            part => output.push(part.as_os_str()),
        }
    }
    Ok(output)
}
fn canonical_key(target: &str) -> Result<String, String> {
    Ok(absolute(target)?.to_string_lossy().to_lowercase())
}
pub(super) fn safe_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let cleaned = productivity::trim(&cleaned);
    if cleaned.is_empty() || cleaned.chars().all(|character| character == '.') {
        "未命名".into()
    } else {
        cleaned.into()
    }
}

pub fn validate_reference(
    state: &Value,
    resource: &ResourceHealth,
    replacement: &str,
) -> Result<(), String> {
    if productivity::trim(replacement).is_empty() || replacement.encode_utf16().count() > 4096 {
        return Err("资源参数无效".into());
    }
    if !collect(state)
        .iter()
        .any(|item| item.same_reference(resource))
    {
        return Err("资源已变化，请重新检查".into());
    }
    if resource.kind == "link" && http_url(replacement).is_none() {
        return Err("请输入有效的 HTTP/HTTPS 地址".into());
    }
    Ok(())
}

pub fn relink(
    root: &Path,
    state: &mut Value,
    resource: &ResourceHealth,
    replacement: &str,
    now: DateTime<Utc>,
) -> Result<(), String> {
    validate_reference(state, resource, replacement)?;
    let field = match resource.kind.as_str() {
        "launcher" => "Path",
        "project" | "phase" => "ProjectPath",
        "subtask" => "FilePath",
        "link" => "Url",
        "organizer" => "ItemPaths",
        _ => return Err("资源参数无效".into()),
    };
    let parent = resource.parent_id.as_deref().unwrap_or("");
    if resource.kind == "organizer" {
        let categories = state["DesktopCategories"].as_array().unwrap();
        let category = categories.iter().find(|item| item["Id"] == parent).unwrap();
        let managed = root.join("DesktopOrganizer");
        let category_root = managed.join(safe_name(category["Name"].as_str().unwrap()));
        let target = absolute(replacement)?;
        let target_key = canonical_key(target.to_str().ok_or("资源路径无效")?)?;
        let category_key = canonical_key(category_root.to_str().ok_or("资源路径无效")?)?;
        if target_key == category_key || !Path::new(&target_key).starts_with(&category_key) {
            return Err("只能重新关联当前分类目录中的项目".into());
        }
        backup::within(&managed, &target)?;
        backup::within(&category_root, &target)?;
        let key = canonical_key(replacement)?;
        for owner in categories {
            for item in owner["ItemPaths"].as_array().unwrap() {
                let owned = item.as_str().unwrap();
                if !(owner["Id"] == parent && owned == resource.target)
                    && canonical_key(owned)? == key
                {
                    return Err("此项目已被收纳记录关联，请选择其他项目".into());
                }
            }
        }
        let category = state["DesktopCategories"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|item| item["Id"] == parent)
            .unwrap();
        for item in category["ItemPaths"].as_array_mut().unwrap() {
            if item == &resource.target {
                *item = json!(replacement);
            }
        }
        return Ok(());
    }
    let item = match resource.kind.as_str() {
        "launcher" => state["Launchers"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|item| item["Id"] == resource.id),
        "project" => state["Projects"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|item| item["Id"] == resource.id),
        "phase" => state["Projects"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|item| item["Id"] == parent)
            .unwrap()["Phases"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|item| item["Id"] == resource.id),
        "subtask" => state["Projects"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .flat_map(|item| item["Phases"].as_array_mut().unwrap())
            .find(|item| item["Id"] == parent)
            .unwrap()["Subtasks"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|item| item["Id"] == resource.id),
        "link" => state["LinkGroups"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|item| item["Id"] == parent)
            .unwrap()["Links"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|item| item["Id"] == resource.id),
        _ => None,
    }
    .ok_or("资源已变化，请重新检查")?;
    item[field] = json!(replacement);
    if resource.kind == "link" {
        item["UpdatedAt"] = json!(productivity::time(now));
    }
    Ok(())
}

impl WorkspaceStore {
    pub fn resource_snapshot(&mut self) -> Result<Value, String> {
        self.read()
    }
}
