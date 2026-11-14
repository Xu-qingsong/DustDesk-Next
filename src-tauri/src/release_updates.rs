use serde::Serialize;
use serde_json::Value;
use std::{
    cmp::Ordering,
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Manager, WebviewWindow};
use tokio::sync::watch;

const REPOSITORY: &str = "https://api.github.com/repos/Xu-qingsong/DustDesk-Next";
const RELEASES: &str = "https://github.com/Xu-qingsong/DustDesk-Next/releases";
const MAX_RESPONSE: usize = 1024 * 1024;
const CANCELLED: &str = "更新检查已取消";

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    ok: bool,
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    release_notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    release_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
impl UpdateResult {
    fn failure(error: String) -> Self {
        Self {
            error: Some(error),
            ..Default::default()
        }
    }
}
struct Version<'source> {
    numbers: Vec<&'source str>,
    prerelease: Option<Vec<&'source str>>,
}
fn identifiers(value: &str) -> bool {
    value.split('.').all(|part| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}
fn version(value: &str) -> Result<Version<'_>, String> {
    let invalid = || format!("无法识别版本号：{value}");
    let bare = value.strip_prefix('v').unwrap_or(value);
    let base = if let Some((base, metadata)) = bare.split_once('+') {
        if !identifiers(metadata) {
            return Err(invalid());
        }
        base
    } else {
        bare
    };
    let (base, prerelease) = if let Some((base, pre)) = base.split_once('-') {
        if !identifiers(pre) {
            return Err(invalid());
        }
        (base, Some(pre.split('.').collect()))
    } else {
        (base, None)
    };
    let numbers: Vec<_> = base.split('.').collect();
    if numbers.len() != 3
        || numbers.iter().any(|number| {
            number.is_empty()
                || !number.bytes().all(|byte| byte.is_ascii_digit())
                || (number.len() > 1 && number.starts_with('0'))
        })
    {
        return Err(invalid());
    }
    Ok(Version {
        numbers,
        prerelease,
    })
}
fn decimal_compare(left: &str, right: &str) -> Ordering {
    let left = left.trim_start_matches('0');
    let right = right.trim_start_matches('0');
    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
}
fn compare_versions(left: &str, right: &str) -> Result<Ordering, String> {
    let left = version(left)?;
    let right = version(right)?;
    for (left, right) in left.numbers.iter().zip(&right.numbers) {
        let comparison = decimal_compare(left, right);
        if comparison != Ordering::Equal {
            return Ok(comparison);
        }
    }
    let (left, right) = match (left.prerelease, right.prerelease) {
        (None, None) => return Ok(Ordering::Equal),
        (None, Some(_)) => return Ok(Ordering::Greater),
        (Some(_), None) => return Ok(Ordering::Less),
        (Some(left), Some(right)) => (left, right),
    };
    for index in 0..left.len().max(right.len()) {
        let (left, right) = match (left.get(index), right.get(index)) {
            (Some(left), Some(right)) if left == right => continue,
            (Some(left), Some(right)) => (*left, *right),
            (None, _) => return Ok(Ordering::Less),
            (_, None) => return Ok(Ordering::Greater),
        };
        let numeric_left = left.bytes().all(|byte| byte.is_ascii_digit());
        let numeric_right = right.bytes().all(|byte| byte.is_ascii_digit());
        return Ok(match (numeric_left, numeric_right) {
            (true, true) => {
                if decimal_compare(left, right) == Ordering::Greater {
                    Ordering::Greater
                } else {
                    Ordering::Less
                }
            }
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => left.cmp(right),
        });
    }
    Ok(Ordering::Equal)
}
fn release_url(tag: &str) -> String {
    let mut encoded = String::new();
    for byte in tag.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    format!("{RELEASES}/tag/{encoded}")
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(value) => value.as_f64() != Some(0.0),
        _ => true,
    }
}
fn parse_release(release: Value, current: &str) -> Result<UpdateResult, String> {
    let tag = release
        .get("tag_name")
        .and_then(Value::as_str)
        .ok_or("GitHub 正式版本信息无效")?;
    if ["draft", "prerelease"]
        .iter()
        .any(|field| release.get(field).is_some_and(truthy))
    {
        return Err("GitHub 正式版本信息无效".into());
    }
    let available = compare_versions(tag, current)? == Ordering::Greater;
    let body = release
        .get("body")
        .and_then(Value::as_str)
        .map(crate::workspace::productivity::trim)
        .filter(|body| !body.is_empty())
        .unwrap_or("此版本未提供更新说明，请查看版本发布页面。");
    let mut units = 0;
    let notes = body
        .chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= 20_000
        })
        .collect();
    Ok(UpdateResult {
        ok: true,
        available,
        current_version: Some(current.into()),
        version: Some(tag.into()),
        release_notes: Some(notes),
        release_url: Some(release_url(tag)),
        ..Default::default()
    })
}

struct Job {
    cancelled: watch::Sender<bool>,
    result: watch::Sender<Option<UpdateResult>>,
    feedback: AtomicBool,
    owner: Option<WebviewWindow>,
}
#[derive(Default)]
pub struct Service {
    pending: Mutex<Option<Arc<Job>>>,
}
impl Service {
    pub fn busy(&self) -> bool {
        self.pending.lock().map_or(true, |slot| slot.is_some())
    }
    pub fn cancel(&self) {
        if let Ok(slot) = self.pending.lock() {
            if let Some(job) = slot.as_ref() {
                job.cancelled.send_replace(true);
            }
        }
    }
    async fn check(
        &self,
        app: tauri::AppHandle,
        owner: Option<WebviewWindow>,
        feedback: bool,
    ) -> Result<UpdateResult, String> {
        require_interactive(&app)?;
        if owner
            .as_ref()
            .is_some_and(|window| !crate::main_window::current(&app, window))
        {
            return Err("主窗口已失效".into());
        }
        let job = {
            let mut pending = self.pending.lock().map_err(|error| error.to_string())?;
            if let Some(job) = pending.as_ref() {
                if feedback {
                    job.feedback.store(true, AtomicOrdering::SeqCst);
                }
                job.clone()
            } else {
                let job = Arc::new(Job {
                    cancelled: watch::channel(false).0,
                    result: watch::channel(None).0,
                    feedback: AtomicBool::new(feedback),
                    owner,
                });
                *pending = Some(job.clone());
                let active = job.clone();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let mut result = execute(&app, &active).await.unwrap_or_else(|error| {
                        eprintln!("检查更新失败：{error}");
                        UpdateResult::failure(error)
                    });
                    if !result.available
                        && active.feedback.load(AtomicOrdering::SeqCst)
                        && validate(&app, &active).is_ok()
                    {
                        let message = result
                            .error
                            .as_deref()
                            .or(result.message.as_deref())
                            .unwrap_or("当前已是最新版本");
                        if let Err(error) = dialog(&app, &active, "检查更新", message, false).await
                        {
                            eprintln!("检查更新提示失败：{error}");
                            result = UpdateResult::failure(error);
                        }
                    }
                    let service = app.state::<Service>();
                    if let Ok(mut pending) = service.pending.lock() {
                        if pending
                            .as_ref()
                            .is_some_and(|value| Arc::ptr_eq(value, &active))
                        {
                            *pending = None;
                        }
                    }
                    active.result.send_replace(Some(result));
                });
                job
            }
        };
        let mut receiver = job.result.subscribe();
        loop {
            if let Some(result) = receiver.borrow().clone() {
                return Ok(result);
            }
            receiver
                .changed()
                .await
                .map_err(|_| "更新检查服务已停止".to_string())?;
        }
    }
}
fn require_interactive(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<crate::draft_startup::Service>()
        .require_ready()?;
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()
}
fn validate(app: &tauri::AppHandle, job: &Job) -> Result<(), String> {
    if *job.cancelled.borrow() {
        return Err(CANCELLED.into());
    }
    require_interactive(app)?;
    if job
        .owner
        .as_ref()
        .is_some_and(|window| !crate::main_window::current(app, window))
    {
        return Err("主窗口已失效".into());
    }
    Ok(())
}
fn request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "检查更新超时，请检查网络后重试".into()
    } else {
        format!("无法连接 GitHub，请检查网络后重试：{error}")
    }
}
async fn read_response(mut response: reqwest::Response) -> Result<Value, String> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE as u64)
    {
        return Err("GitHub 正式版本信息过大".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE {
            return Err("GitHub 正式版本信息过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "GitHub 正式版本信息无效".into())
}
async fn fetch_release(base: &str, current: &str) -> Result<UpdateResult, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(request_error)?;
    let request = |url: String| {
        client
            .get(url)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", format!("DustDesk/{current}"))
            .send()
    };
    let response = request(format!("{base}/releases/latest"))
        .await
        .map_err(request_error)?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        let repository = request(base.to_owned()).await.map_err(request_error)?;
        if !repository.status().is_success() {
            return Err("无法访问项目仓库，请稍后重试".into());
        }
        return Ok(UpdateResult {
            ok: true,
            current_version: Some(current.into()),
            message: Some("当前仓库尚未发布正式版本".into()),
            ..Default::default()
        });
    }
    if matches!(status.as_u16(), 403 | 429) {
        return Err("GitHub 请求受限，请稍后再检查更新".into());
    }
    if !status.is_success() {
        return Err(format!("无法读取 GitHub 发布版本（{}）", status.as_u16()));
    }
    parse_release(read_response(response).await?, current)
}
async fn execute(app: &tauri::AppHandle, job: &Arc<Job>) -> Result<UpdateResult, String> {
    validate(app, job)?;
    let base = test_base().unwrap_or_else(|| REPOSITORY.into());
    let current = app.package_info().version.to_string();
    let mut cancelled = job.cancelled.subscribe();
    let result = tokio::select! {
        biased;
        _ = cancelled.wait_for(|value| *value) => return Err(CANCELLED.into()),
        result = tokio::time::timeout(Duration::from_secs(15), fetch_release(&base, &current)) => result.map_err(|_| "检查更新超时，请检查网络后重试".to_string())??,
    };
    validate(app, job)?;
    if result.available {
        let version = result.version.as_deref().ok_or("缺少版本号")?;
        let message = format!("发现 DustDesk {version}，是否前往更新？\n\n当前版本：{current}\n\n{}\n\n将打开版本发布页面，不会自动下载或安装。", result.release_notes.as_deref().unwrap_or_default());
        if dialog(app, job, "发现新版本", &message, true).await? {
            validate(app, job)?;
            let target = release_url(version);
            let handle = app.clone();
            let active = job.clone();
            crate::system::sta(move || {
                validate(&handle, &active)?;
                if test_open(&target)? {
                    return Ok(());
                }
                #[cfg(windows)]
                {
                    crate::platform::shell::open(0, target)
                }
                #[cfg(not(windows))]
                {
                    let _ = target;
                    Err("当前平台尚不支持打开更新页面".into())
                }
            })
            .await?;
        }
    }
    Ok(result)
}
async fn dialog(
    app: &tauri::AppHandle,
    job: &Arc<Job>,
    title: &str,
    content: &str,
    confirm: bool,
) -> Result<bool, String> {
    validate(app, job)?;
    #[cfg(windows)]
    let owner = job
        .owner
        .as_ref()
        .map(|window| {
            window
                .hwnd()
                .map(|handle| handle.0 as isize)
                .map_err(|error| error.to_string())
        })
        .transpose()?
        .unwrap_or(0);
    #[cfg(not(windows))]
    let owner = 0;
    let title = title.to_owned();
    let content = content.to_owned();
    let cancellation = job.cancelled.subscribe();
    let accepted = crate::system::sta(move || {
        crate::platform::update_dialog::show(owner, &title, &content, confirm, cancellation)
    })
    .await?;
    validate(app, job)?;
    Ok(accepted)
}

#[cfg(debug_assertions)]
fn test_directory() -> Option<std::path::PathBuf> {
    let root = std::path::PathBuf::from(std::env::var_os("DUSTDESK_TEST_USER_DATA_DIR")?);
    let parent = root.parent()?;
    if !root.is_absolute()
        || root.file_name()? != "user-data"
        || parent.parent()? != std::env::temp_dir()
        || !parent
            .file_name()?
            .to_str()?
            .starts_with("dustdesk-tauri-test-")
        || std::fs::symlink_metadata(parent)
            .ok()?
            .file_type()
            .is_symlink()
    {
        return None;
    }
    Some(parent.to_path_buf())
}
fn test_base() -> Option<String> {
    #[cfg(debug_assertions)]
    {
        test_directory()?;
        let base = std::env::var("DUSTDESK_TAURI_TEST_UPDATE_BASE").ok()?;
        let url = reqwest::Url::parse(&base).ok()?;
        if url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
        {
            return Some(base.trim_end_matches('/').into());
        }
    }
    None
}
fn test_open(target: &str) -> Result<bool, String> {
    #[cfg(debug_assertions)]
    if test_base().is_some() {
        if let Some(directory) = test_directory() {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(directory.join("update-opened.txt"))
                .map_err(|error| error.to_string())?;
            writeln!(file, "{target}").map_err(|error| error.to_string())?;
            return Ok(true);
        }
    }
    let _ = target;
    Ok(false)
}
#[tauri::command]
pub async fn release_check(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<UpdateResult, String> {
    crate::workspace::api::require_workspace(&window)?;
    app.state::<Service>()
        .check(app.clone(), Some(window), false)
        .await
}
pub fn request_from_tray(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = app
            .state::<Service>()
            .check(app.clone(), app.get_webview_window("workspace-main"), true)
            .await
        {
            eprintln!("检查更新未启动：{error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn versions_preserve_electron_precedence_and_arbitrary_precision() {
        for (left, right, expected) in [
            ("v1.2.3", "1.2.3+build", Ordering::Equal),
            ("999999999999999999999.0.0", "2.0.0", Ordering::Greater),
            ("1.2.3", "1.2.3-rc.2", Ordering::Greater),
            ("1.2.3-beta.11", "1.2.3-beta.2", Ordering::Greater),
            ("1.2.3-1", "1.2.3-a", Ordering::Less),
            ("1.2.3-a", "1.2.3-a.1", Ordering::Less),
            ("1.2.3-01", "1.2.3-1", Ordering::Less),
        ] {
            assert_eq!(compare_versions(left, right).unwrap(), expected);
        }
        for invalid in [
            "1.2",
            "01.2.3",
            "V1.2.3",
            "1.2.3-",
            "1.2.3+a+b",
            "1.2.3 ",
            "1.2.3-a..b",
            "1.2.3-中文",
        ] {
            assert!(version(invalid).is_err(), "{invalid}");
        }
    }
    #[test]
    fn release_ignores_untrusted_urls_and_limits_notes_without_splitting_unicode() {
        let result = parse_release(json!({"tag_name":"v2.0.0+build", "body":format!(" {} ", "🪶".repeat(12_000)), "html_url":"file:///malicious"}), "1.0.2").unwrap();
        assert!(result.available);
        assert_eq!(
            result.release_url.unwrap(),
            format!("{RELEASES}/tag/v2.0.0%2Bbuild")
        );
        assert_eq!(result.release_notes.unwrap().encode_utf16().count(), 20_000);
        for release in [
            Value::Null,
            json!({"tag_name":123}),
            json!({"tag_name":"v2.0.0","draft":true}),
            json!({"tag_name":"v2.0.0","prerelease":true}),
        ] {
            assert!(parse_release(release, "1.0.2").is_err());
        }
        let result = parse_release(
            json!({"tag_name":"v1.0.2","body":format!("{} ", char::from_u32(0xfeff).unwrap())}),
            "1.0.2",
        )
        .unwrap();
        assert!(!result.available);
        assert_eq!(
            result.release_notes.as_deref(),
            Some("此版本未提供更新说明，请查看版本发布页面。")
        );
    }
}
