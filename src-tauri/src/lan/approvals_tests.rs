use super::*;
use crate::lan::protocol::Manifest;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Condvar, Mutex as StdMutex,
};

struct Fake {
    events: mpsc::UnboundedSender<&'static str>,
    hold: AtomicBool,
    linger: (StdMutex<bool>, Condvar),
    valid: AtomicBool,
    active: AtomicUsize,
    peak: AtomicUsize,
    choice: ReceiveChoice,
    selected: Option<PathBuf>,
}
impl Fake {
    fn new(
        choice: ReceiveChoice,
        selected: Option<PathBuf>,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<&'static str>) {
        let (events, receive) = mpsc::unbounded_channel();
        (
            Arc::new(Self {
                events,
                hold: AtomicBool::new(false),
                linger: (StdMutex::new(false), Condvar::new()),
                valid: AtomicBool::new(true),
                active: AtomicUsize::new(0),
                peak: AtomicUsize::new(0),
                choice,
                selected,
            }),
            receive,
        )
    }
    fn block(&self, event: &'static str, cancel: &CancellationToken) {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(active, Ordering::SeqCst);
        self.events.send(event).unwrap();
        while self.hold.load(Ordering::SeqCst) && !cancel.is_cancelled() {
            std::thread::sleep(Duration::from_millis(1));
        }
        if cancel.is_cancelled() {
            self.events.send("canceled").unwrap();
        }
        let mut linger = self.linger.0.lock().unwrap();
        while *linger {
            linger = self.linger.1.wait(linger).unwrap();
        }
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
    fn release(&self) {
        *self.linger.0.lock().unwrap() = false;
        self.linger.1.notify_all();
    }
}
impl Ui for Fake {
    fn check(&self) -> Result<(), String> {
        if self.valid.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err("宿主已撤权".into())
        }
    }
    fn pair(&self, _: &Device, _: &str, cancel: &CancellationToken) -> Result<bool, String> {
        self.block("pair", cancel);
        Ok(true)
    }
    fn receive(
        &self,
        _: &ReceivePrompt,
        _: &Path,
        cancel: &CancellationToken,
    ) -> Result<ReceiveChoice, String> {
        self.block("receive", cancel);
        Ok(self.choice)
    }
    fn choose_directory(&self, cancel: &CancellationToken) -> Result<Option<PathBuf>, String> {
        self.block("picker", cancel);
        Ok(self.selected.clone())
    }
}
fn prompt() -> ReceivePrompt {
    ReceivePrompt {
        peer: Device {
            id: "peer".into(),
            name: "设备".into(),
            address: "127.0.0.1".into(),
            port: 1234,
            fingerprint: "a".repeat(64),
            last_seen: 0.0,
            extra: Default::default(),
        },
        manifest: Manifest {
            id: "task".into(),
            name: "文件".into(),
            entries: vec![],
            directories: vec![],
            text: None,
            extra: Default::default(),
        },
        existing_directory: None,
    }
}
fn queue(ui: Arc<Fake>) -> Queue {
    Queue::start(ui, "C:\\downloads".into(), Duration::from_secs(5)).unwrap()
}
async fn event(events: &mut mpsc::UnboundedReceiver<&'static str>, expected: &str) {
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap()
            .unwrap(),
        expected
    );
}

#[tokio::test]
async fn chosen_directory_requires_completed_picker_and_cancel_has_no_fallback() {
    for selected in [Some(PathBuf::from("D:\\chosen")), None] {
        let (ui, mut events) = Fake::new(ReceiveChoice::ChooseDirectory, selected.clone());
        let queue = queue(ui);
        assert_eq!(queue.receive(prompt()).await.unwrap(), selected);
        event(&mut events, "receive").await;
        event(&mut events, "picker").await;
        queue.stop().await.unwrap();
    }
}
#[tokio::test]
async fn explicit_default_original_and_text_acceptance_keep_distinct_paths() {
    let (ui, mut events) = Fake::new(ReceiveChoice::Accept, None);
    let queue = queue(ui);
    assert_eq!(
        queue.receive(prompt()).await.unwrap(),
        Some("C:\\downloads".into())
    );
    let mut resumed = prompt();
    resumed.existing_directory = Some("D:\\original".into());
    assert_eq!(
        queue.receive(resumed).await.unwrap(),
        Some("D:\\original".into())
    );
    let mut text = prompt();
    text.manifest.text = Some("文本".into());
    assert_eq!(
        queue.receive(text).await.unwrap(),
        Some("C:\\downloads".into())
    );
    for _ in 0..3 {
        event(&mut events, "receive").await;
    }
    assert!(events.try_recv().is_err());
    queue.stop().await.unwrap();
}
#[tokio::test]
async fn decline_never_opens_picker_or_approves_directory() {
    let (ui, mut events) = Fake::new(ReceiveChoice::Decline, Some("D:\\unused".into()));
    let queue = queue(ui);
    assert!(queue.receive(prompt()).await.unwrap().is_none());
    event(&mut events, "receive").await;
    assert!(events.try_recv().is_err());
    queue.stop().await.unwrap();
}
#[tokio::test]
async fn resume_and_text_cannot_be_redirected_even_by_faulty_presenter() {
    let (ui, mut events) = Fake::new(ReceiveChoice::ChooseDirectory, Some("D:\\other".into()));
    let queue = queue(ui);
    let mut resumed = prompt();
    resumed.existing_directory = Some("D:\\original".into());
    assert!(queue.receive(resumed).await.unwrap_err().contains("不允许"));
    let mut text = prompt();
    text.manifest.text = Some("文本".into());
    assert!(queue.receive(text).await.unwrap_err().contains("不允许"));
    event(&mut events, "receive").await;
    event(&mut events, "receive").await;
    assert!(events.try_recv().is_err());
    queue.stop().await.unwrap();
}
#[tokio::test]
async fn invalid_inputs_and_revoked_owner_never_open_native_ui() {
    let (ui, mut events) = Fake::new(ReceiveChoice::Accept, None);
    let queue = queue(ui.clone());
    assert!(queue.pair(prompt().peer, "bad".into()).await.is_err());
    let mut invalid = prompt();
    invalid.existing_directory = Some("relative".into());
    assert!(queue.receive(invalid).await.is_err());
    let mut invalid = prompt();
    invalid.manifest.text = Some("text".into());
    invalid.existing_directory = Some("C:\\old".into());
    assert!(queue.receive(invalid).await.is_err());
    ui.valid.store(false, Ordering::SeqCst);
    assert!(queue.receive(prompt()).await.unwrap_err().contains("撤权"));
    assert!(events.try_recv().is_err());
    queue.stop().await.unwrap();
}
#[tokio::test]
async fn relative_picker_result_is_not_a_path_grant() {
    let (ui, mut events) = Fake::new(ReceiveChoice::ChooseDirectory, Some("relative".into()));
    let queue = queue(ui);
    assert!(queue
        .receive(prompt())
        .await
        .unwrap_err()
        .contains("目录无效"));
    event(&mut events, "receive").await;
    event(&mut events, "picker").await;
    queue.stop().await.unwrap();
}
#[tokio::test]
async fn stop_waits_for_native_completion_and_discards_late_acceptance() {
    let (ui, mut events) = Fake::new(ReceiveChoice::Accept, None);
    ui.hold.store(true, Ordering::SeqCst);
    *ui.linger.0.lock().unwrap() = true;
    let queue = queue(ui.clone());
    let call = tokio::spawn(queue.receive(prompt()));
    event(&mut events, "receive").await;
    let stop_queue = queue.clone();
    let mut stop = tokio::spawn(async move { stop_queue.stop().await });
    event(&mut events, "canceled").await;
    assert!(tokio::time::timeout(Duration::from_millis(25), &mut stop)
        .await
        .is_err());
    assert!(!call.is_finished());
    ui.release();
    assert!(call.await.unwrap().is_err());
    stop.await.unwrap().unwrap();
    queue.stop().await.unwrap();
    assert!(queue.receive(prompt()).await.is_err());
    assert_eq!(ui.active.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn dropped_request_cancels_native_ui_before_the_next_job() {
    let (ui, mut events) = Fake::new(ReceiveChoice::Accept, None);
    ui.hold.store(true, Ordering::SeqCst);
    let queue = queue(ui.clone());
    let first = tokio::spawn(queue.pair(prompt().peer, "123456".into()));
    event(&mut events, "pair").await;
    let second = tokio::spawn(queue.receive(prompt()));
    first.abort();
    assert!(first.await.is_err());
    event(&mut events, "canceled").await;
    event(&mut events, "receive").await;
    ui.hold.store(false, Ordering::SeqCst);
    assert!(second.await.unwrap().unwrap().is_some());
    assert_eq!(ui.peak.load(Ordering::SeqCst), 1);
    queue.stop().await.unwrap();
}
#[tokio::test]
async fn deadline_cancels_real_job_and_does_not_accept_its_late_result() {
    let (ui, mut events) = Fake::new(ReceiveChoice::Accept, None);
    ui.hold.store(true, Ordering::SeqCst);
    let queue = Queue::start(
        ui.clone(),
        "C:\\downloads".into(),
        Duration::from_millis(80),
    )
    .unwrap();
    let call = tokio::spawn(queue.receive(prompt()));
    event(&mut events, "receive").await;
    event(&mut events, "canceled").await;
    assert!(call.await.unwrap().is_err());
    assert_eq!(ui.active.load(Ordering::SeqCst), 0);
    queue.stop().await.unwrap();
}
#[tokio::test]
async fn bounded_queue_rejects_overflow_and_stop_cancels_all_pending_jobs() {
    let (ui, mut events) = Fake::new(ReceiveChoice::Accept, None);
    ui.hold.store(true, Ordering::SeqCst);
    let queue = queue(ui.clone());
    let first = tokio::spawn(queue.receive(prompt()));
    event(&mut events, "receive").await;
    let mut pending = Vec::new();
    for _ in 0..CAPACITY {
        let mut future = queue.receive(prompt());
        assert!(matches!(
            futures_util::poll!(&mut future),
            std::task::Poll::Pending
        ));
        pending.push(future);
    }
    assert!(queue.receive(prompt()).await.unwrap_err().contains("过多"));
    queue.stop().await.unwrap();
    assert!(first.await.unwrap().is_err());
    for future in pending {
        assert!(future.await.is_err());
    }
    event(&mut events, "canceled").await;
    assert!(events.try_recv().is_err());
    assert_eq!(ui.peak.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn owner_revocation_after_user_acceptance_cannot_grant_path() {
    let (ui, mut events) = Fake::new(ReceiveChoice::Accept, None);
    ui.hold.store(true, Ordering::SeqCst);
    let queue = queue(ui.clone());
    let call = tokio::spawn(queue.receive(prompt()));
    event(&mut events, "receive").await;
    ui.valid.store(false, Ordering::SeqCst);
    ui.hold.store(false, Ordering::SeqCst);
    assert!(call.await.unwrap().unwrap_err().contains("撤权"));
    queue.stop().await.unwrap();
}
