#[cfg(test)]
use super::export_file::publish;
use super::export_file::publish_checked;
use serde_json::{json, Value};
use tauri::{Manager, WebviewWindow};

type Row = [String; 9];
const MAX_ROWS: usize = 1_048_576;
const MAX_BYTES: usize = 64 * 1024 * 1024;

fn text(value: &Value, field: &str) -> String {
    value[field].as_str().unwrap_or("").to_string()
}

fn rows(state: &Value) -> Result<Vec<Row>, String> {
    let projects = state["Projects"].as_array().ok_or("项目数据无效")?;
    if projects.is_empty() {
        return Err("没有可导出的项目".into());
    }
    let mut rows = vec![[
        "项目",
        "项目路径",
        "阶段",
        "状态",
        "进度",
        "阶段路径",
        "子事项",
        "完成",
        "子事项路径",
    ]
    .map(String::from)];
    let mut bytes = 0usize;
    let mut append = |row: Row| -> Result<(), String> {
        bytes = bytes
            .checked_add(row.iter().map(String::len).sum())
            .ok_or("项目导出过大")?;
        if rows.len() >= MAX_ROWS || bytes > MAX_BYTES {
            return Err("项目导出超过 Excel 行数或 64 MiB 文本限制".into());
        }
        rows.push(row);
        Ok(())
    };
    for project in projects {
        let phases = project["Phases"].as_array().ok_or("项目阶段数据无效")?;
        if phases.is_empty() {
            append([
                text(project, "Name"),
                text(project, "ProjectPath"),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
            ])?;
        }
        for phase in phases {
            let subtasks = phase["Subtasks"].as_array().ok_or("项目子事项数据无效")?;
            let explicit = phase["ProgressPercent"].as_f64().unwrap_or(-1.0);
            let progress = if explicit >= 0.0 {
                explicit.clamp(0.0, 100.0)
            } else if !subtasks.is_empty() {
                (subtasks
                    .iter()
                    .filter(|task| task["IsCompleted"] == true)
                    .count() as f64
                    * 100.0
                    / subtasks.len() as f64)
                    .round()
            } else {
                match phase["Status"].as_str() {
                    Some("Done") => 100.0,
                    Some("Doing") => 50.0,
                    _ => 0.0,
                }
            };
            let base = [
                text(project, "Name"),
                text(project, "ProjectPath"),
                text(phase, "Title"),
                text(phase, "Status"),
                format!("{progress}%"),
                text(phase, "ProjectPath"),
            ];
            if subtasks.is_empty() {
                append([
                    base[0].clone(),
                    base[1].clone(),
                    base[2].clone(),
                    base[3].clone(),
                    base[4].clone(),
                    base[5].clone(),
                    String::new(),
                    String::new(),
                    String::new(),
                ])?;
            }
            for task in subtasks {
                append([
                    base[0].clone(),
                    base[1].clone(),
                    base[2].clone(),
                    base[3].clone(),
                    base[4].clone(),
                    base[5].clone(),
                    text(task, "Title"),
                    if task["IsCompleted"] == true {
                        "是"
                    } else {
                        "否"
                    }
                    .into(),
                    text(task, "FilePath"),
                ])?;
            }
        }
    }
    Ok(rows)
}

fn csv_cell(value: &str) -> String {
    let protected = if value.starts_with(['=', '+', '-', '@']) {
        format!("'{value}")
    } else {
        value.to_string()
    };
    if protected.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", protected.replace('"', "\"\""))
    } else {
        protected
    }
}

fn encode(rows: &[Row], csv: bool) -> Result<Vec<u8>, String> {
    if csv {
        let mut result = String::from("\u{feff}");
        for row in rows {
            result.push_str(
                &row.iter()
                    .map(|cell| csv_cell(cell))
                    .collect::<Vec<_>>()
                    .join(","),
            );
            result.push_str("\r\n");
            if result.len() > MAX_BYTES {
                return Err("CSV 导出超过 64 MiB".into());
            }
        }
        return Ok(result.into_bytes());
    }
    let mut workbook = rust_xlsxwriter::Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet
        .set_name("项目管理")
        .map_err(|error| error.to_string())?;
    for (column, width) in [20, 34, 22, 12, 10, 34, 24, 10, 42].into_iter().enumerate() {
        sheet
            .set_column_width(column as u16, width)
            .map_err(|error| error.to_string())?;
    }
    for (index, row) in rows.iter().enumerate() {
        for (column, value) in row.iter().enumerate() {
            if !value.is_empty() {
                sheet
                    .write_string(index as u32, column as u16, value)
                    .map_err(|error| format!("项目导出单元格无效：{error}"))?;
            }
        }
    }
    let bytes = workbook
        .save_to_buffer()
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("Excel 导出超过 64 MiB".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn projects_export(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Value, String> {
    super::api::require_workspace(&window)?;
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()?;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    let result = async {
        let rows = super::commands::operation(app.clone(), |store| {
            rows(&store.load("workspace-main")?.state)
        })
        .await?;
        let Some(selection) =
            crate::system::select_project_export(app.clone(), window.clone()).await?
        else {
            return Ok(json!({"ok":false,"canceled":true}));
        };
        let csv = selection
            .path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("csv"));
        let bytes = tauri::async_runtime::spawn_blocking(move || encode(&rows, csv))
            .await
            .map_err(|error| error.to_string())??;
        let path = selection.path.clone();
        let storage = app.state::<super::commands::StorageState>();
        let protected = storage.root.parent().ok_or("隔离数据目录无效")?;
        super::export_file::require_external(&path, protected)?;
        let output = path.display().to_string();
        let handle = app.clone();
        super::commands::operation(app.clone(), move |_store| {
            publish_checked(&path, &bytes, || {
                selection.require_active()?;
                handle
                    .state::<crate::lifecycle::QuitState>()
                    .require_interactive()?;
                if !crate::main_window::current(&handle, &window) {
                    return Err("主窗口已失效，未写入导出文件".into());
                }
                Ok(())
            })
        })
        .await?;
        Ok::<Value, String>(json!({"ok":true,"path":output}))
    }
    .await;
    Ok(result.unwrap_or_else(|error| json!({"ok":false,"error":error})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, OpenOptions};
    #[test]
    fn hierarchy_progress_empty_phases_and_unicode_match_the_electron_table() {
        let state = json!({"Projects":[{"Name":"空🪶","ProjectPath":"D:\\项目","Phases":[]},{"Name":"项目","Phases":[{"Title":"进行","Status":"Doing","ProgressPercent":-1,"Subtasks":[]},{"Title":"完成","Status":"Done","Subtasks":[]},{"Title":"自动","Subtasks":[{"Title":"第一","IsCompleted":true},{"Title":"第二","IsCompleted":false},{"Title":"第三","IsCompleted":false}]},{"Title":"显式","ProgressPercent":130,"Subtasks":[]}]}]});
        let rows = rows(&state).unwrap();
        assert_eq!(rows.len(), 8);
        assert_eq!(rows[1][0], "空🪶");
        assert_eq!(rows[2][4], "50%");
        assert_eq!(rows[3][4], "100%");
        assert_eq!(rows[4][4], "33%");
        assert_eq!(rows[4][7], "是");
        assert_eq!(rows[5][7], "否");
        assert_eq!(rows[7][4], "100%");
    }
    #[test]
    fn csv_preserves_bom_quotes_newlines_and_blocks_formula_prefixes() {
        assert_eq!(csv_cell("=1+1"), "'=1+1");
        assert_eq!(csv_cell("+1"), "'+1");
        assert_eq!(csv_cell("-1"), "'-1");
        assert_eq!(csv_cell("@link"), "'@link");
        assert_eq!(csv_cell("a,\"b\"\nc"), "\"a,\"\"b\"\"\nc\"");
        let bytes = encode(
            &[[
                "中文".into(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
            ]],
            true,
        )
        .unwrap();
        assert!(bytes.starts_with(&[0xef, 0xbb, 0xbf]));
        assert!(bytes.ends_with(b"\r\n"));
    }
    #[test]
    fn no_projects_fails_and_xlsx_rejects_oversized_cells_instead_of_truncating() {
        assert!(rows(&json!({"Projects":[]}))
            .unwrap_err()
            .contains("没有可导出"));
        let mut row: Row = Default::default();
        row[0] = "界".repeat(32768);
        assert!(encode(&[row], false).is_err());
        let mut row: Row = Default::default();
        row[0] = "=1+1".into();
        let bytes = encode(&[row], false).unwrap();
        assert!(bytes.starts_with(b"PK"));
    }
    #[test]
    fn file_publication_is_complete_replaces_only_regular_files_and_cleans_failed_temporaries() {
        let root =
            std::env::temp_dir().join(format!("dustdesk-rust-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("项目.csv");
        publish(&path, b"first").unwrap();
        publish(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        let directory = root.join("directory");
        fs::create_dir(&directory).unwrap();
        assert!(publish(&directory, b"invalid").is_err());
        let alias = root.join("alias.csv");
        fs::hard_link(&path, &alias).unwrap();
        assert!(publish(&alias, b"invalid").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 3);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn locked_destination_preserves_original_bytes_and_cleans_temporary_then_retries() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = std::env::temp_dir().join(format!(
            "dustdesk-rust-export-lock-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("locked.csv");
        fs::write(&path, b"keep-original").unwrap();
        let held = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(publish(&path, b"replacement").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"keep-original");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        drop(held);
        publish(&path, b"replacement").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        fs::remove_dir_all(root).unwrap();
    }
}
