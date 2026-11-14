use super::{checked_path, Snapshot, WorkspaceStore};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashSet, fs, io::Write};

#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
pub(super) struct PlanItem {
    source_path: String,
    category_id: String,
    category_name: String,
}

fn classify<'state>(name: &str, state: &'state Value) -> Option<&'state Value> {
    let lower = name.to_lowercase();
    let categories = state["DesktopCategories"].as_array()?;
    if let Some(rules) = state["OrganizerRules"].as_array() {
        for rule in rules {
            if rule["Enabled"] != true {
                continue;
            }
            let pattern = rule["Pattern"].as_str().unwrap_or("").to_lowercase();
            let matched = pattern
                .split([',', '，'])
                .map(super::productivity::trim)
                .filter(|value| !value.is_empty())
                .any(|value| {
                    if rule["Match"] == "name" {
                        lower.contains(value)
                    } else {
                        let extension = value
                            .strip_prefix("*.")
                            .or_else(|| value.strip_prefix('.'))
                            .unwrap_or(value);
                        lower.ends_with(&format!(".{extension}"))
                    }
                });
            if matched {
                if let Some(category) = categories
                    .iter()
                    .find(|category| category["Id"] == rule["CategoryId"])
                {
                    return Some(category);
                }
            }
        }
    }
    let extension = lower
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or("");
    let wanted = match extension {
        "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "pdf" | "txt" | "md" => "工作",
        "js" | "ts" | "tsx" | "jsx" | "cs" | "cpp" | "h" | "py" | "json" | "css" | "html" => "开发",
        "exe" | "msi" | "lnk" | "bat" | "cmd" => "工具",
        _ => "文件",
    };
    categories
        .iter()
        .find(|category| category["Name"] == wanted)
        .or_else(|| categories.first())
}

impl WorkspaceStore {
    pub(super) fn organizer_failure(&self, operation: &str, source: Option<&str>, error: &str) {
        let directory = self.root.join("Logs");
        let result = (|| -> Result<(), String> {
            checked_path(&directory)?;
            fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
            let path = directory.join("organizer-move.log");
            checked_path(&path)?;
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .map_err(|error| error.to_string())?;
            writeln!(file, "{}", json!({"time":chrono::Utc::now().to_rfc3339(),"operation":operation,"source":source,"error":error})).map_err(|error| error.to_string())
        })();
        if let Err(error) = result {
            eprintln!("收纳失败日志无法写入：{error}");
        }
    }

    pub(super) fn organizer_plan(&mut self) -> Result<Vec<PlanItem>, String> {
        let state = self.read()?;
        let desktop = self.organizer_desktop.as_ref().ok_or("尚未配置隔离桌面")?;
        checked_path(desktop)?;
        let mut plan = Vec::new();
        for entry in fs::read_dir(desktop).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "桌面文件名无法表示")?;
            if name.to_lowercase() == "desktop.ini" {
                continue;
            }
            if let Some(category) = classify(&name, &state) {
                plan.push(PlanItem {
                    source_path: entry.path().to_str().ok_or("桌面路径无法表示")?.to_owned(),
                    category_id: category["Id"].as_str().ok_or("分类 ID 无效")?.to_owned(),
                    category_name: category["Name"].as_str().ok_or("分类名无效")?.to_owned(),
                });
            }
        }
        Ok(plan)
    }

    pub(super) fn organizer_execute(
        &mut self,
        supplied: Option<Value>,
    ) -> (Value, Option<Snapshot>) {
        let Some(plan) = supplied.as_ref().and_then(Value::as_array).filter(|plan| {
            plan.len() <= 5000
                && plan
                    .iter()
                    .all(|item| item["SourcePath"].is_string() && item["CategoryId"].is_string())
        }) else {
            return (
                json!({"ok":false,"moved":0,"error":"请先生成并确认整理预览"}),
                None,
            );
        };
        let mut seen = HashSet::new();
        let plan: Vec<_> = plan
            .iter()
            .filter(|item| seen.insert(item["SourcePath"].as_str().unwrap()))
            .collect();
        let mut moved = 0;
        let mut snapshot = None;
        for item in &plan {
            let source = item["SourcePath"].as_str().unwrap();
            let result = (|| {
                let source = std::path::absolute(source).map_err(|error| error.to_string())?;
                let parent = source.parent().ok_or("源路径无效")?;
                let desktop = self.organizer_desktop.as_ref().ok_or("尚未配置隔离桌面")?;
                if crate::system::path_key(parent.to_str().ok_or("源路径无效")?)?
                    != crate::system::path_key(desktop.to_str().ok_or("桌面路径无效")?)?
                {
                    return Err("只能收纳桌面顶层项目".into());
                }
                self.organizer_move(
                    item["CategoryId"].as_str().unwrap(),
                    source.to_str().ok_or("源路径无效")?,
                )
            })();
            match result {
                Ok((next, _)) => {
                    moved += 1;
                    snapshot = Some(next);
                }
                Err(error) => self.organizer_failure("智能收纳", Some(source), &error),
            }
        }
        let mut result = json!({"ok":moved == plan.len(),"moved":moved});
        if moved < plan.len() {
            result["error"] = json!(format!(
                "已整理 {moved} 项，{} 项失败，请重新扫描；已完成的项目可逐项撤销",
                plan.len() - moved
            ));
        }
        (result, snapshot)
    }
}

#[cfg(test)]
#[path = "organizer_smart_tests.rs"]
mod tests;
