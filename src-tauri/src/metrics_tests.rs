use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc,
};

fn fixture() -> SystemMetrics {
    SystemMetrics {
        cpu_percent: 42.0,
        memory_percent: 25.0,
        used_memory_bytes: 1024,
        total_memory_bytes: 4096,
        download_bytes_per_second: 10.0,
        upload_bytes_per_second: 5.0,
        disk_read_bytes_per_second: None,
        disk_write_bytes_per_second: Some(0.0),
        disk_spaces: vec![DiskSpace {
            drive_name: "C:".into(),
            free_bytes: 100,
            total_bytes: 1000,
        }],
        ping_milliseconds: -1,
        uptime_seconds: 86400,
    }
}

#[test]
fn matches_public_pascal_case_and_unavailable_contract() {
    let value = serde_json::to_value(fixture()).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 11);
    assert_eq!(value["CpuPercent"], 42.0);
    assert_eq!(value["TotalMemoryBytes"], 4096);
    assert_eq!(value["DiskReadBytesPerSecond"], serde_json::Value::Null);
    assert_eq!(value["DiskWriteBytesPerSecond"], 0.0);
    assert_eq!(value["PingMilliseconds"], -1);
    assert_eq!(value["DiskSpaces"][0]["DriveName"], "C:");
    assert_eq!(value["DiskSpaces"][0]["FreeBytes"], 100);
    assert_eq!(value["DiskSpaces"][0]["TotalBytes"], 1000);
}

#[test]
fn cpu_subtracts_idle_included_in_kernel_and_handles_resets() {
    let before = CpuTimes {
        idle: 100,
        kernel: 200,
        user: 100,
    };
    let after = CpuTimes {
        idle: 200,
        kernel: 350,
        user: 150,
    };
    assert_eq!(cpu_percent(Some(before), Some(after)), 50.0);
    assert_eq!(cpu_percent(Some(before), Some(before)), 0.0);
    assert_eq!(cpu_percent(Some(after), Some(before)), 0.0);
    assert_eq!(cpu_percent(None, Some(after)), 0.0);
    assert_eq!(cpu_percent(Some(before), None), 0.0);
    assert_eq!(
        cpu_percent(Some(before), Some(CpuTimes { idle: 500, ..after })),
        0.0
    );
    assert_eq!(
        cpu_percent(Some(before), Some(CpuTimes { idle: 100, ..after })),
        100.0
    );
    assert_eq!(
        cpu_percent(
            Some(before),
            Some(CpuTimes {
                idle: 100,
                kernel: u64::MAX,
                user: u64::MAX
            })
        ),
        0.0
    );
}

#[test]
fn network_uses_elapsed_seconds_and_same_interface_with_reset_safety() {
    let before = NetworkCounters {
        interface: 7,
        received: 100,
        sent: 100,
        at: Instant::now(),
    };
    let after = NetworkCounters {
        interface: 7,
        received: 200,
        sent: 150,
        at: before.at + Duration::from_millis(250),
    };
    assert_eq!(network_rates(Some(before), Some(after)), (400.0, 200.0));
    assert_eq!(
        network_rates(
            Some(before),
            Some(NetworkCounters {
                interface: 8,
                ..after
            })
        ),
        (0.0, 0.0)
    );
    assert_eq!(
        network_rates(
            Some(before),
            Some(NetworkCounters {
                received: 0,
                sent: 0,
                ..after
            })
        ),
        (0.0, 0.0)
    );
    assert_eq!(network_rates(Some(before), Some(before)), (0.0, 0.0));
    assert_eq!(network_rates(Some(after), Some(before)), (0.0, 0.0));
    assert_eq!(network_rates(None, Some(after)), (0.0, 0.0));
    assert_eq!(network_rates(Some(before), None), (0.0, 0.0));
}

#[test]
fn invalid_disk_counters_remain_null_instead_of_fake_zero() {
    assert_eq!(valid_disk_rate(0.0), Some(0.0));
    assert_eq!(valid_disk_rate(42.5), Some(42.5));
    for invalid in [-1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(valid_disk_rate(invalid), None);
    }
}

#[tokio::test]
async fn concurrent_requests_share_one_worker_and_two_second_success_cache() {
    let service = MetricsService::default();
    let count = Arc::new(AtomicUsize::new(0));
    let increment = count.clone();
    let collector = move || {
        increment.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(30));
        Ok(fixture())
    };
    let (first, second) = tokio::join!(
        service.sample_using(collector, Duration::from_secs(2)),
        service.sample_using(|| panic!("duplicate worker"), Duration::from_secs(2)),
    );
    assert_eq!(first.unwrap(), fixture());
    assert_eq!(second.unwrap(), fixture());
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(
        service
            .sample_using(
                || panic!("cached call must not collect"),
                Duration::from_secs(2)
            )
            .await
            .unwrap(),
        fixture()
    );
    let expires = service.samples.lock().unwrap().cached.as_ref().unwrap().0;
    assert!(expires > Instant::now() + Duration::from_secs(1));
    service.samples.lock().unwrap().cached.as_mut().unwrap().0 =
        Instant::now() - Duration::from_secs(1);
    let increment = count.clone();
    service
        .sample_using(
            move || {
                increment.fetch_add(1, Ordering::SeqCst);
                Ok(fixture())
            },
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn timeout_retains_running_worker_and_later_result_without_polling_loop() {
    let service = MetricsService::default();
    let (started, worker_started) = mpsc::channel();
    let (release, unblocked) = mpsc::channel();
    let timeout = service
        .sample_using(
            move || {
                started.send(()).unwrap();
                unblocked.recv_timeout(Duration::from_secs(3)).unwrap();
                Ok(fixture())
            },
            Duration::from_millis(20),
        )
        .await;
    worker_started.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(timeout.unwrap_err().contains("超时"));
    assert!(service.samples.lock().unwrap().pending.is_some());
    let second = service
        .sample_using(
            || panic!("timeout must not free worker slot"),
            Duration::from_millis(20),
        )
        .await;
    assert!(second.unwrap_err().contains("超时"));
    release.send(()).unwrap();
    assert_eq!(
        service
            .sample_using(|| panic!("still same worker"), Duration::from_secs(2))
            .await
            .unwrap(),
        fixture()
    );
    assert!(service.samples.lock().unwrap().pending.is_none());
}

#[tokio::test]
async fn failures_and_worker_panics_do_not_poison_future_requests_or_cache() {
    let service = MetricsService::default();
    assert_eq!(
        service
            .sample_using(
                || Err("injected memory failure".into()),
                Duration::from_secs(2)
            )
            .await
            .unwrap_err(),
        "injected memory failure"
    );
    assert!(service.samples.lock().unwrap().cached.is_none());
    assert_eq!(
        service
            .sample_using(|| panic!("injected panic"), Duration::from_secs(2))
            .await
            .unwrap_err(),
        "原生系统采样失败"
    );
    assert!(service.samples.lock().unwrap().pending.is_none());
    assert_eq!(
        service
            .sample_using(|| Ok(fixture()), Duration::from_secs(2))
            .await
            .unwrap(),
        fixture()
    );
}
