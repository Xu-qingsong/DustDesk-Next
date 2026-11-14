use crate::{lifecycle::QuitState, platform};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};
use tokio::sync::watch;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct DiskSpace {
    pub drive_name: String,
    pub free_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct SystemMetrics {
    pub cpu_percent: f64,
    pub memory_percent: f64,
    pub used_memory_bytes: u64,
    pub total_memory_bytes: u64,
    pub download_bytes_per_second: f64,
    pub upload_bytes_per_second: f64,
    pub disk_read_bytes_per_second: Option<f64>,
    pub disk_write_bytes_per_second: Option<f64>,
    pub disk_spaces: Vec<DiskSpace>,
    pub ping_milliseconds: i64,
    pub uptime_seconds: u64,
}

type Sample = Result<SystemMetrics, String>;
type Pending = watch::Receiver<Option<Sample>>;

#[derive(Default)]
struct Samples {
    cached: Option<(Instant, SystemMetrics)>,
    pending: Option<Pending>,
}

#[derive(Clone, Default)]
pub struct MetricsService {
    samples: Arc<Mutex<Samples>>,
}

impl MetricsService {
    async fn sample_using(
        &self,
        collector: impl FnOnce() -> Sample + Send + 'static,
        timeout: Duration,
    ) -> Sample {
        let mut receiver = {
            let mut samples = self.samples.lock().map_err(|error| error.to_string())?;
            if let Some((expires, value)) = &samples.cached {
                if *expires > Instant::now() {
                    return Ok(value.clone());
                }
            }
            if let Some(pending) = &samples.pending {
                pending.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                samples.pending = Some(receiver.clone());
                let shared = self.samples.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(collector))
                        .unwrap_or_else(|_| Err("原生系统采样失败".into()));
                    match shared.lock() {
                        Ok(mut samples) => {
                            if let Ok(value) = &result {
                                samples.cached =
                                    Some((Instant::now() + Duration::from_secs(2), value.clone()));
                            }
                            samples.pending = None;
                            sender.send_replace(Some(result));
                        }
                        Err(error) => {
                            sender.send_replace(Some(Err(error.to_string())));
                        }
                    }
                });
                receiver
            }
        };
        tokio::time::timeout(timeout, async {
            loop {
                if let Some(result) = receiver.borrow_and_update().clone() {
                    return result;
                }
                receiver
                    .changed()
                    .await
                    .map_err(|_| "原生系统采样意外中止".to_string())?;
            }
        })
        .await
        .map_err(|_| "系统采样超时，请稍后重试".to_string())?
    }
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy)]
pub struct CpuTimes {
    pub idle: u64,
    pub kernel: u64,
    pub user: u64,
}

#[cfg(any(windows, test))]
pub fn cpu_percent(before: Option<CpuTimes>, after: Option<CpuTimes>) -> f64 {
    let Some((before, after)) = before.zip(after) else {
        return 0.0;
    };
    let deltas = || {
        let idle = after.idle.checked_sub(before.idle)?;
        let total = after
            .kernel
            .checked_sub(before.kernel)?
            .checked_add(after.user.checked_sub(before.user)?)?;
        (total > 0).then_some((idle, total))
    };
    deltas().map_or(0.0, |(idle, total)| {
        (total.saturating_sub(idle) as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
    })
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy)]
pub struct NetworkCounters {
    pub interface: u64,
    pub received: u64,
    pub sent: u64,
    pub at: Instant,
}

#[cfg(any(windows, test))]
pub fn network_rates(
    before: Option<NetworkCounters>,
    after: Option<NetworkCounters>,
) -> (f64, f64) {
    let Some((before, after)) = before.zip(after) else {
        return (0.0, 0.0);
    };
    let seconds = after.at.saturating_duration_since(before.at).as_secs_f64();
    if before.interface != after.interface || seconds == 0.0 {
        return (0.0, 0.0);
    }
    (
        after.received.saturating_sub(before.received) as f64 / seconds,
        after.sent.saturating_sub(before.sent) as f64 / seconds,
    )
}

#[cfg(any(windows, test))]
pub fn valid_disk_rate(value: f64) -> Option<f64> {
    (value.is_finite() && value >= 0.0).then_some(value)
}

#[tauri::command]
pub async fn system_sample(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<SystemMetrics, String> {
    crate::widgets::business(&app, &window, &["monitor"])?;
    app.state::<QuitState>().require_interactive()?;
    app.state::<MetricsService>()
        .sample_using(platform::sample_system_metrics, Duration::from_secs(5))
        .await
}

#[cfg(test)]
#[path = "metrics_tests.rs"]
mod tests;
