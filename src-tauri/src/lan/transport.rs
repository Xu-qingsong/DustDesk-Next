use super::{
    protocol::{fingerprint, private_ipv4, utf16_len, valid_address, Device, MAX_JSON_BYTES},
    storage::Identity,
    tls,
};
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, StreamBody};
use hyper::{body::Incoming, service::service_fn, Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    future::Future,
    io,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::{JoinHandle, JoinSet},
    time::{Instant, Sleep},
};
use tokio_rustls::{TlsAcceptor, TlsConnector};
use tokio_util::sync::CancellationToken;

pub type OutgoingBody = UnsyncBoxBody<Bytes, io::Error>;
pub type HandlerFuture =
    Pin<Box<dyn Future<Output = Result<Response<Full<Bytes>>, String>> + Send>>;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub connect: Duration,
    pub handshake: Duration,
    pub headers: Duration,
    pub idle: Duration,
    pub connections: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(15),
            handshake: Duration::from_secs(15),
            headers: Duration::from_secs(15),
            idle: Duration::from_secs(120),
            connections: 32,
        }
    }
}
impl Limits {
    fn validate(&self) -> Result<(), String> {
        if [self.connect, self.handshake, self.headers, self.idle]
            .iter()
            .any(Duration::is_zero)
            || !(1..=256).contains(&self.connections)
        {
            return Err("局域网连接限制无效".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct Peer {
    pub address: Ipv4Addr,
    pub fingerprint: String,
    pub cancellation: CancellationToken,
}

/// Called only after mutual TLS, route/method validation, and the live trust
/// check. The service must still validate pairing decisions and task tokens.
pub trait Handler: Send + Sync + 'static {
    fn trusted(&self, fingerprint: &str) -> bool;
    fn handle(&self, peer: Peer, request: Request<Incoming>) -> HandlerFuture;
}

fn route(method: &Method, path: &str) -> Result<bool, String> {
    match (method, path) {
        (&Method::GET, "/hello") | (&Method::POST, "/pair") => Ok(false),
        (&Method::POST, "/offer" | "/file" | "/complete" | "/pause" | "/cancel") => Ok(true),
        _ => Err("未知传输操作或请求方法无效".into()),
    }
}

pub fn json_response(value: Value, status: StatusCode) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(value.to_string())));
    *response.status_mut() = status;
    response.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json"),
    );
    response
}

pub fn bytes_body(bytes: impl Into<Bytes>) -> OutgoingBody {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed_unsync()
}

/// The caller supplies an authorized reader and enforces the declared file
/// size. The transport reads at most 64 KiB per frame and honors backpressure.
pub fn reader_body(reader: impl AsyncRead + Unpin + Send + 'static) -> OutgoingBody {
    let stream = tokio_util::io::ReaderStream::with_capacity(reader, 64 * 1024);
    StreamBody::new(stream.map(|result| result.map(hyper::body::Frame::data))).boxed_unsync()
}

pub async fn read_json(
    body: &mut Incoming,
    limit: usize,
    cancel: &CancellationToken,
) -> Result<Value, String> {
    let mut bytes = Vec::new();
    loop {
        let frame = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("局域网请求已取消".into()),
            frame = body.frame() => frame,
        };
        let Some(frame) = frame else { break };
        let frame = frame.map_err(|error| format!("读取传输请求失败：{error}"))?;
        if let Ok(chunk) = frame.into_data() {
            if chunk.len() > limit.saturating_sub(bytes.len()) {
                return Err("请求内容过大".into());
            }
            bytes.extend_from_slice(&chunk);
        }
    }
    serde_json::from_slice(&bytes).map_err(|_| "传输响应或请求不是有效 JSON".into())
}

pub struct Server {
    address: SocketAddrV4,
    cancel: CancellationToken,
    task: Option<JoinHandle<Result<(), String>>>,
}
impl Server {
    pub async fn bind(
        identity: Arc<Identity>,
        address: SocketAddrV4,
        limits: Limits,
        handler: Arc<dyn Handler>,
    ) -> Result<Self, String> {
        limits.validate()?;
        if !address.ip().is_unspecified() && !private_ipv4(*address.ip()) {
            return Err("仅支持局域网 IPv4 监听".into());
        }
        let acceptor = TlsAcceptor::from(tls::server_config(&identity)?);
        let listener = TcpListener::bind(address)
            .await
            .map_err(|error| format!("局域网服务无法监听：{error}"))?;
        let SocketAddr::V4(address) = listener.local_addr().map_err(|error| error.to_string())?
        else {
            return Err("仅支持局域网 IPv4".into());
        };
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let task = tokio::spawn(async move {
            let slots = Arc::new(Semaphore::new(limits.connections));
            let mut tasks = JoinSet::new();
            let result = loop {
                tokio::select! {
                    biased;
                    _ = stop.cancelled() => break Ok(()),
                    Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
                    accepted = listener.accept() => {
                        let (stream, peer) = match accepted { Ok(value) => value, Err(error) => break Err(format!("局域网服务接收连接失败：{error}")) };
                        let SocketAddr::V4(peer) = peer else { continue };
                        if !private_ipv4(*peer.ip()) { continue; }
                        let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
                        let acceptor = acceptor.clone(); let handler = handler.clone(); let stop = stop.child_token();
                        tasks.spawn(async move {
                            let _permit = permit;
                            let _cancel_on_drop = stop.clone().drop_guard();
                            let connection = serve(stream, *peer.ip(), acceptor, handler, limits, stop.clone());
                            tokio::select! { biased; _ = stop.cancelled() => {}, _ = connection => {} }
                        });
                    }
                }
            };
            stop.cancel();
            while tasks.join_next().await.is_some() {}
            result
        });
        Ok(Self {
            address,
            cancel,
            task: Some(task),
        })
    }
    pub fn address(&self) -> SocketAddrV4 {
        self.address
    }
    pub async fn stop(mut self) -> Result<(), String> {
        self.cancel.cancel();
        if let Some(task) = self.task.take() {
            task.await.map_err(|_| "局域网监听任务未正常结束")?
        } else {
            Ok(())
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

async fn serve(
    stream: TcpStream,
    address: Ipv4Addr,
    acceptor: TlsAcceptor,
    handler: Arc<dyn Handler>,
    limits: Limits,
    cancel: CancellationToken,
) -> Result<(), String> {
    let stream = tokio::time::timeout(
        limits.handshake,
        acceptor.accept(IdleIo::new(stream, limits.idle)),
    )
    .await
    .map_err(|_| "设备 TLS 握手超时")?
    .map_err(|error| format!("设备 TLS 握手失败：{error}"))?;
    let cert = stream
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|certs| certs.first())
        .ok_or("缺少设备证书")?;
    let pin = fingerprint(cert.as_ref());
    let service = service_fn(move |request: Request<Incoming>| {
        let handler = handler.clone();
        let peer = Peer {
            address,
            fingerprint: pin.clone(),
            cancellation: cancel.child_token(),
        };
        async move {
            let stop = peer.cancellation.clone();
            let _cancel_on_drop = stop.clone().drop_guard();
            let result = async {
                let paired = route(request.method(), request.uri().path())?;
                if request.uri().scheme().is_some() || request.uri().authority().is_some() { return Err("仅接受本地协议相对路径".into()); }
                if paired && !handler.trusted(&peer.fingerprint) { return Err("请先配对设备".into()); }
                tokio::select! { biased; _ = stop.cancelled() => Err("局域网请求已取消".into()), result = handler.handle(peer, request) => result }
            }.await;
            Ok::<_, Infallible>(result.unwrap_or_else(|error| {
                json_response(json!({"error":error}), StatusCode::BAD_REQUEST)
            }))
        }
    });
    hyper::server::conn::http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(limits.headers)
        .max_headers(64)
        .max_buf_size(64 * 1024)
        .keep_alive(false)
        .serve_connection(TokioIo::new(stream), service)
        .await
        .map_err(|error| format!("HTTPS 连接已结束：{error}"))
}

#[derive(Clone)]
pub struct Client {
    identity: Arc<Identity>,
    limits: Limits,
}
impl Client {
    pub fn new(identity: Arc<Identity>, limits: Limits) -> Result<Self, String> {
        limits.validate()?;
        Ok(Self { identity, limits })
    }

    /// Unpaired certificate observation is restricted to this single hello
    /// request and never emits pair/offer/file requests or changes trust.
    pub async fn discover(
        &self,
        address: &str,
        port: u16,
        cancel: &CancellationToken,
    ) -> Result<Device, String> {
        let (hello, pin) = self
            .send(address, port, None, "/hello", None, cancel)
            .await?;
        self.device(address, port, hello, pin, None)
    }

    pub async fn hello(
        &self,
        device: &Device,
        cancel: &CancellationToken,
    ) -> Result<Device, String> {
        device.validate()?;
        let (hello, pin) = self
            .send(
                &device.address,
                device.port,
                Some(&device.fingerprint),
                "/hello",
                None,
                cancel,
            )
            .await?;
        self.device(&device.address, device.port, hello, pin, Some(&device.id))
    }

    fn device(
        &self,
        address: &str,
        port: u16,
        hello: Value,
        pin: String,
        expected: Option<&str>,
    ) -> Result<Device, String> {
        let id = hello["id"].as_str().ok_or("对方不是兼容的 DustDesk 设备")?;
        let name = hello["name"]
            .as_str()
            .ok_or("对方不是兼容的 DustDesk 设备")?;
        if hello["protocol"].as_u64() != Some(1)
            || id == self.identity.id
            || utf16_len(id) > 80
            || utf16_len(name) > 255
            || expected.is_some_and(|expected| expected != id)
        {
            return Err("设备身份已变化或不是兼容的 DustDesk 设备".into());
        }
        Ok(Device {
            id: id.into(),
            name: name.into(),
            address: address.into(),
            port,
            fingerprint: pin,
            last_seen: chrono::Utc::now().timestamp_millis() as f64,
            extra: Default::default(),
        })
    }

    pub async fn json(
        &self,
        device: &Device,
        path: &str,
        value: Option<&Value>,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        device.validate()?;
        let body = value
            .map(|value| {
                let bytes = serde_json::to_vec(value).map_err(|_| "传输请求无法编码")?;
                if bytes.len() > MAX_JSON_BYTES {
                    return Err("请求内容过大");
                }
                Ok(bytes_body(bytes))
            })
            .transpose()
            .map_err(str::to_string)?;
        self.send(
            &device.address,
            device.port,
            Some(&device.fingerprint),
            path,
            body.map(|body| (body, false)),
            cancel,
        )
        .await
        .map(|(value, _)| value)
    }

    pub async fn upload(
        &self,
        device: &Device,
        path: &str,
        body: OutgoingBody,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        device.validate()?;
        self.send(
            &device.address,
            device.port,
            Some(&device.fingerprint),
            path,
            Some((body, true)),
            cancel,
        )
        .await
        .map(|(value, _)| value)
    }

    async fn send(
        &self,
        address: &str,
        port: u16,
        pin: Option<&str>,
        path: &str,
        body: Option<(OutgoingBody, bool)>,
        cancel: &CancellationToken,
    ) -> Result<(Value, String), String> {
        if !valid_address(address) || port == 0 {
            return Err("请输入局域网 IPv4 地址和有效端口".into());
        }
        let uri: hyper::Uri = path.parse().map_err(|_| "传输路径无效")?;
        if !path.starts_with('/') || uri.scheme().is_some() || uri.authority().is_some() {
            return Err("传输路径无效".into());
        }
        let method = if body.is_some() {
            Method::POST
        } else {
            Method::GET
        };
        route(&method, uri.path())?;
        if pin.is_none() && (method != Method::GET || path != "/hello") {
            return Err("未配对连接仅能查询设备身份".into());
        }
        let octets = address
            .split('.')
            .map(|part| part.parse::<u8>())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "IPv4 地址无效")?;
        let endpoint = SocketAddrV4::new(
            Ipv4Addr::new(octets[0], octets[1], octets[2], octets[3]),
            port,
        );
        let mut driver = None;
        let operation = async {
            let stream = tokio::time::timeout(self.limits.connect, TcpStream::connect(endpoint))
                .await
                .map_err(|_| "连接超时，请检查对方是否在线及防火墙设置")?
                .map_err(|error| format!("无法连接设备：{error}"))?;
            let connector = TlsConnector::from(tls::client_config(&self.identity, pin)?);
            let name = rustls::pki_types::ServerName::IpAddress((*endpoint.ip()).into());
            let stream = tokio::time::timeout(
                self.limits.handshake,
                connector.connect(name, IdleIo::new(stream, self.limits.idle)),
            )
            .await
            .map_err(|_| "设备 TLS 握手超时")?
            .map_err(|error| format!("设备 TLS 握手失败：{error}"))?;
            let cert = stream
                .get_ref()
                .1
                .peer_certificates()
                .and_then(|certs| certs.first())
                .ok_or("缺少设备证书")?;
            let observed = fingerprint(cert.as_ref());
            let (mut sender, connection) =
                hyper::client::conn::http1::handshake(TokioIo::new(stream))
                    .await
                    .map_err(|error| format!("HTTPS 请求无法启动：{error}"))?;
            driver = Some(Driver(tokio::spawn(async move {
                let _ = connection.await;
            })));
            let (body, binary) = body.unwrap_or_else(|| (bytes_body(Bytes::new()), false));
            let request = Request::builder()
                .method(method)
                .uri(uri)
                .header(hyper::header::HOST, endpoint.to_string())
                .header(hyper::header::CONNECTION, "close")
                .header(
                    hyper::header::CONTENT_TYPE,
                    if binary {
                        "application/octet-stream"
                    } else {
                        "application/json"
                    },
                )
                .body(body)
                .map_err(|_| "传输请求无效")?;
            let mut response = sender
                .send_request(request)
                .await
                .map_err(|error| format!("传输请求失败：{error}"))?;
            let status = response.status();
            let value = read_json(response.body_mut(), MAX_JSON_BYTES, cancel).await?;
            if status.is_redirection() {
                return Err("局域网传输不接受重定向".into());
            }
            if !status.is_success() {
                return Err(value["error"]
                    .as_str()
                    .unwrap_or("传输请求失败")
                    .chars()
                    .take(4096)
                    .collect());
            }
            Ok((value, observed))
        };
        let result = tokio::select! { biased; _ = cancel.cancelled() => Err("局域网请求已取消".into()), result = operation => result };
        // Explicit cancellation and ordinary completion both drain the local
        // connection driver before returning. Dropping this future still has
        // the RAII abort guard; a service must join its own request tasks too.
        if let Some(driver) = driver.as_mut() {
            driver.0.abort();
            let _ = (&mut driver.0).await;
        }
        result
    }
}

struct Driver(JoinHandle<()>);
impl Drop for Driver {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Activity resets the deadline; a large transfer is not stopped simply for
/// lasting longer than the idle limit. Both reads and writes share the clock.
struct IdleIo<T> {
    inner: T,
    idle: Duration,
    deadline: Pin<Box<Sleep>>,
}
impl<T> IdleIo<T> {
    fn new(inner: T, idle: Duration) -> Self {
        Self {
            inner,
            idle,
            deadline: Box::pin(tokio::time::sleep(idle)),
        }
    }
    fn ready(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        if self.deadline.as_mut().poll(cx).is_ready() {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "局域网连接空闲超时",
            ))
        } else {
            Ok(())
        }
    }
    fn activity(&mut self) {
        self.deadline.as_mut().reset(Instant::now() + self.idle);
    }
}
impl<T: AsyncRead + Unpin> AsyncRead for IdleIo<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if let Err(error) = self.ready(cx) {
            return Poll::Ready(Err(error));
        }
        let before = buffer.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buffer);
        if matches!(result, Poll::Ready(Ok(()))) && buffer.filled().len() > before {
            self.activity();
        }
        result
    }
}
impl<T: AsyncWrite + Unpin> AsyncWrite for IdleIo<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        if let Err(error) = self.ready(cx) {
            return Poll::Ready(Err(error));
        }
        let result = Pin::new(&mut self.inner).poll_write(cx, buffer);
        if matches!(result, Poll::Ready(Ok(count)) if count > 0) {
            self.activity();
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Err(error) = self.ready(cx) {
            return Poll::Ready(Err(error));
        }
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[test]
    fn only_protocol_routes_and_methods_can_pass_the_transport_gate() {
        assert_eq!(route(&Method::GET, "/hello"), Ok(false));
        assert_eq!(route(&Method::POST, "/pair"), Ok(false));
        for path in ["/offer", "/file", "/complete", "/pause", "/cancel"] {
            assert_eq!(route(&Method::POST, path), Ok(true));
            assert!(route(&Method::GET, path).is_err());
        }
        for path in ["/", "/hello/../file", "/%66ile", "/state.json"] {
            assert!(route(&Method::POST, path).is_err());
        }
    }
    #[tokio::test]
    async fn idle_deadline_is_reset_by_progress_but_stalled_reads_fail() {
        let (left, mut right) = tokio::io::duplex(64);
        let mut io = IdleIo::new(left, Duration::from_millis(120));
        for _ in 0..4 {
            tokio::time::sleep(Duration::from_millis(40)).await;
            right.write_all(&[1]).await.unwrap();
            assert_eq!(io.read_u8().await.unwrap(), 1);
        }
        assert_eq!(
            io.read_u8().await.unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
    }
}
