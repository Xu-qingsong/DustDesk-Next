//! Bounded, serial native approval jobs. Dropping a network request cancels
//! its UI; stopping the queue waits for the real blocking call to finish.
use super::{
    dialog::ReceiveChoice,
    protocol::Device,
    receiver::{Approvals, Decision, ReceivePrompt},
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, Mutex},
    task::JoinHandle,
    time::Instant,
};
use tokio_util::sync::CancellationToken;

const CAPACITY: usize = 8;
const CANCELED: &str = "局域网确认已取消";

/// Trusted native host only. Implementations must check their real owner,
/// window role and lifecycle, including when a background host has no HWND.
/// The picker returns only an explicit user selection, never a default path.
pub trait Ui: Send + Sync + 'static {
    fn check(&self) -> Result<(), String>;
    fn pair(&self, peer: &Device, code: &str, cancel: &CancellationToken) -> Result<bool, String>;
    fn receive(
        &self,
        prompt: &ReceivePrompt,
        downloads: &Path,
        cancel: &CancellationToken,
    ) -> Result<ReceiveChoice, String>;
    fn choose_directory(&self, cancel: &CancellationToken) -> Result<Option<PathBuf>, String>;
}

enum Prompt {
    Pair(Device, String),
    Receive(ReceivePrompt),
}
enum Answer {
    Pair(bool),
    Receive(Option<PathBuf>),
}
struct Request {
    prompt: Prompt,
    cancel: CancellationToken,
    deadline: Instant,
    reply: oneshot::Sender<Result<Answer, String>>,
}
struct Worker {
    handle: Option<JoinHandle<()>>,
    result: Option<Result<(), String>>,
}
struct Inner {
    send: mpsc::Sender<Request>,
    stop: CancellationToken,
    timeout: Duration,
    worker: Mutex<Worker>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
#[derive(Clone)]
pub struct Queue {
    inner: Arc<Inner>,
}

fn valid_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.as_os_str().to_string_lossy().contains('\0') {
        return Err("原生接收目录无效".into());
    }
    Ok(())
}
fn check(ui: &dyn Ui, cancel: &CancellationToken) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Err(CANCELED.into());
    }
    ui.check()?;
    if cancel.is_cancelled() {
        return Err(CANCELED.into());
    }
    Ok(())
}
fn present(
    ui: &dyn Ui,
    downloads: &Path,
    prompt: Prompt,
    cancel: &CancellationToken,
) -> Result<Answer, String> {
    check(ui, cancel)?;
    let answer = match prompt {
        Prompt::Pair(peer, code) => {
            peer.validate()?;
            if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err("配对码无效".into());
            }
            Answer::Pair(ui.pair(&peer, &code, cancel)?)
        }
        Prompt::Receive(prompt) => {
            prompt.peer.validate()?;
            prompt.manifest.validate()?;
            if prompt.manifest.text.is_some() && prompt.existing_directory.is_some() {
                return Err("文本不能恢复磁盘接收任务".into());
            }
            if let Some(path) = &prompt.existing_directory {
                valid_path(path)?;
            }
            let choice = ui.receive(&prompt, downloads, cancel)?;
            check(ui, cancel)?;
            let path = match choice {
                ReceiveChoice::Decline => None,
                ReceiveChoice::Accept => Some(
                    prompt
                        .existing_directory
                        .clone()
                        .unwrap_or_else(|| downloads.to_path_buf()),
                ),
                ReceiveChoice::ChooseDirectory => {
                    if prompt.existing_directory.is_some() || prompt.manifest.text.is_some() {
                        return Err("此传输不允许更改接收目录".into());
                    }
                    ui.choose_directory(cancel)?
                }
            };
            if let Some(path) = &path {
                valid_path(path)?;
            }
            Answer::Receive(path)
        }
    };
    check(ui, cancel)?;
    Ok(answer)
}

impl Queue {
    /// Call on a Tokio runtime. `timeout` includes time waiting in the queue.
    /// The host owns stop(); aborting a blocking native modal is insufficient.
    pub fn start(ui: Arc<dyn Ui>, downloads: PathBuf, timeout: Duration) -> Result<Self, String> {
        valid_path(&downloads)?;
        if timeout.is_zero() {
            return Err("局域网确认超时无效".into());
        }
        let (send, mut receive) = mpsc::channel::<Request>(CAPACITY);
        let stop = CancellationToken::new();
        let stopping = stop.clone();
        let handle = tokio::spawn(async move {
            loop {
                let request = tokio::select! { biased;
                    _ = stopping.cancelled() => break,
                    request = receive.recv() => match request { Some(request) => request, None => break },
                };
                let Request {
                    prompt,
                    cancel,
                    deadline,
                    reply,
                } = request;
                if cancel.is_cancelled() || reply.is_closed() || deadline <= Instant::now() {
                    cancel.cancel();
                    let _ = reply.send(Err(CANCELED.into()));
                    continue;
                }
                let native_ui = ui.clone();
                let root = downloads.clone();
                let native_cancel = cancel.clone();
                let mut job = tokio::task::spawn_blocking(move || {
                    present(native_ui.as_ref(), &root, prompt, &native_cancel)
                });
                let result = tokio::select! { biased;
                    _ = stopping.cancelled() => None,
                    _ = cancel.cancelled() => None,
                    _ = tokio::time::sleep_until(deadline) => None,
                    result = &mut job => Some(result),
                };
                let result = match result {
                    Some(result) => result
                        .map_err(|error| format!("局域网确认工作异常：{error}"))
                        .and_then(|result| result),
                    None => {
                        cancel.cancel();
                        // Even a canceled caller/timeout must not detach the
                        // actual native modal or overlap the next UI job.
                        let _ = job.await;
                        Err(CANCELED.into())
                    }
                };
                let result = if stopping.is_cancelled()
                    || cancel.is_cancelled()
                    || deadline <= Instant::now()
                {
                    Err(CANCELED.into())
                } else {
                    result
                };
                let _ = reply.send(result);
            }
            receive.close();
            while let Some(request) = receive.recv().await {
                request.cancel.cancel();
                let _ = request.reply.send(Err(CANCELED.into()));
            }
        });
        Ok(Self {
            inner: Arc::new(Inner {
                send,
                stop,
                timeout,
                worker: Mutex::new(Worker {
                    handle: Some(handle),
                    result: None,
                }),
            }),
        })
    }

    fn submit(&self, prompt: Prompt) -> Decision<Answer> {
        let inner = self.inner.clone();
        Box::pin(async move {
            if inner.stop.is_cancelled() {
                return Err(CANCELED.into());
            }
            let cancel = CancellationToken::new();
            let _cancel_on_drop = cancel.clone().drop_guard();
            let (reply, result) = oneshot::channel();
            inner
                .send
                .try_send(Request {
                    prompt,
                    cancel,
                    deadline: Instant::now() + inner.timeout,
                    reply,
                })
                .map_err(|error| match error {
                    mpsc::error::TrySendError::Full(_) => "等待局域网确认的请求过多".to_owned(),
                    mpsc::error::TrySendError::Closed(_) => CANCELED.into(),
                })?;
            result
                .await
                .map_err(|_| "局域网确认队列已关闭".to_owned())?
        })
    }
    pub fn cancel(&self) {
        self.inner.stop.cancel();
    }
    pub async fn stop(&self) -> Result<(), String> {
        self.cancel();
        let mut worker = self.inner.worker.lock().await;
        if let Some(handle) = worker.handle.as_mut() {
            let result = handle
                .await
                .map_err(|error| format!("局域网确认队列未正常关闭：{error}"));
            worker.handle = None;
            worker.result = Some(result);
        }
        worker.result.clone().unwrap_or(Ok(()))
    }
}
impl Approvals for Queue {
    fn pair(&self, peer: Device, code: String) -> Decision<bool> {
        let answer = self.submit(Prompt::Pair(peer, code));
        Box::pin(async move {
            match answer.await? {
                Answer::Pair(accepted) => Ok(accepted),
                _ => Err("局域网确认类型不匹配".into()),
            }
        })
    }
    fn receive(&self, prompt: ReceivePrompt) -> Decision<Option<PathBuf>> {
        let answer = self.submit(Prompt::Receive(prompt));
        Box::pin(async move {
            match answer.await? {
                Answer::Receive(path) => Ok(path),
                _ => Err("局域网确认类型不匹配".into()),
            }
        })
    }
}

#[cfg(test)]
#[path = "approvals_tests.rs"]
mod tests;
