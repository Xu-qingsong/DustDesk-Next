use super::*;
use crate::lan::{files::tests::Fixture, protocol::fingerprint};
use std::sync::atomic::AtomicBool;
use tokio::sync::Notify;

fn job(cancel: CancellationToken, handle: JoinHandle<Result<(), String>>) -> Arc<Job> {
    Arc::new(Job {
        cancel,
        completion: tokio::sync::Mutex::new(Completion {
            handle: Some(handle),
            result: None,
        }),
        token: Arc::new(Mutex::new(None)),
        peer: Arc::new(Mutex::new(Device {
            id: "fixture".into(),
            name: "fixture".into(),
            address: "127.0.0.1".into(),
            port: 12345,
            fingerprint: "a".repeat(64),
            last_seen: 0.0,
            extra: Map::new(),
        })),
        done: Arc::new(AtomicU64::new(0)),
    })
}

#[tokio::test]
async fn dropping_join_and_stop_futures_keeps_the_owned_job_joinable() {
    let runtime = Runtime::default();
    let cancel = CancellationToken::new();
    let worker_cancel = cancel.clone();
    let release = Arc::new(Notify::new());
    let worker_release = release.clone();
    let exited = Arc::new(AtomicBool::new(false));
    let worker_exited = exited.clone();
    let owned = job(
        cancel,
        tokio::spawn(async move {
            worker_cancel.cancelled().await;
            worker_release.notified().await;
            worker_exited.store(true, Ordering::SeqCst);
            Ok(())
        }),
    );
    runtime
        .jobs
        .lock()
        .unwrap()
        .insert("task".into(), owned.clone());
    let short = std::time::Duration::from_millis(10);
    assert!(tokio::time::timeout(short, owned.join()).await.is_err());
    assert!(!owned.is_finished().await);
    assert!(tokio::time::timeout(short, stop(&runtime)).await.is_err());
    assert!(owned.cancel.is_cancelled());
    assert_eq!(runtime.jobs.lock().unwrap().len(), 1);
    assert!(!exited.load(Ordering::SeqCst));
    release.notify_one();
    stop(&runtime).await.unwrap();
    assert!(exited.load(Ordering::SeqCst));
    assert!(owned.is_finished().await);
    assert!(runtime.jobs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn repeated_join_preserves_the_original_failed_checkpoint_result() {
    let owned = job(
        CancellationToken::new(),
        tokio::spawn(async { Err("original checkpoint failure".into()) }),
    );
    assert_eq!(
        owned.join().await.unwrap_err(),
        "original checkpoint failure"
    );
    assert_eq!(
        owned.join().await.unwrap_err(),
        "original checkpoint failure"
    );
    assert!(owned.is_finished().await);
}

#[tokio::test]
async fn bounded_source_stream_only_sends_the_suffix_but_hashes_the_entire_file() {
    let fixture = Fixture::new();
    let source = fixture.0.join("source.bin");
    let bytes = (0..200_003)
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    std::fs::write(&source, &bytes).unwrap();
    let cancel = CancellationToken::new();
    let manifest = sources::prepare("stream".into(), "stream".into(), &[source], &cancel).unwrap();
    let entry = &manifest.entries[0];
    for offset in [0, 65_539, entry.size] {
        let file = sources::open(entry, &cancel).unwrap();
        let (send, mut receive) = mpsc::channel(2);
        let expected = entry.hash.clone();
        let size = entry.size;
        let worker_cancel = cancel.clone();
        let worker = tokio::task::spawn_blocking(move || {
            stream_file(
                file,
                &expected,
                size,
                offset,
                send,
                &worker_cancel,
                |_, _| {},
            )
        });
        let mut received = Vec::new();
        while let Some(chunk) = receive.recv().await {
            assert!(chunk.len() <= 64 * 1024);
            received.extend_from_slice(&chunk);
        }
        worker.await.unwrap().unwrap();
        assert_eq!(received, bytes[offset as usize..]);
    }
    let file = sources::open(entry, &cancel).unwrap();
    let (send, mut receive) = mpsc::channel(2);
    let size = entry.size;
    let worker = tokio::task::spawn_blocking(move || {
        stream_file(
            file,
            &fingerprint(b"wrong whole file"),
            size,
            size,
            send,
            &cancel,
            |_, _| {},
        )
    });
    assert!(receive.recv().await.is_none());
    assert!(worker.await.unwrap().unwrap_err().contains("发送源"));
}
