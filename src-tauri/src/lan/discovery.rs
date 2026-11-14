//! Supervised UDP announcements and pinned HTTPS heartbeats. UDP failure is
//! visible while manually paired HTTPS peers keep probing independently.
use super::{
    adapters::{self, Adapter},
    peers::{Peers, Probe},
    protocol::{private_ipv4, utf16_len, Discovery, DISCOVERY_PORT},
    storage::Identity,
    transport::{Client, Limits},
};
use serde::Serialize;
use std::{
    collections::HashSet,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant},
};
use tokio::{
    net::UdpSocket,
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct Config {
    pub bind: Option<SocketAddrV4>,
    /// None derives broadcasts from current adapters. Explicit targets are a
    /// native-host testing/configuration surface, never a renderer permission.
    pub targets: Option<Vec<SocketAddrV4>>,
    pub cadence: Duration,
    pub timeout: Duration,
    pub ttl: Duration,
    pub reuse_address: bool,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            bind: Some(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT)),
            targets: None,
            cadence: Duration::from_secs(5),
            timeout: Duration::from_secs(3),
            ttl: Duration::from_secs(20),
            reuse_address: true,
        }
    }
}
impl Config {
    fn validate(&self) -> Result<(), String> {
        if self.cadence.is_zero()
            || self.timeout.is_zero()
            || self.ttl < self.cadence
            || self.bind.is_some_and(|address| {
                !address.ip().is_unspecified() && !private_ipv4(*address.ip())
            })
            || self.targets.as_ref().is_some_and(|targets| {
                targets.len() > 256
                    || targets.iter().any(|target| {
                        target.port() == 0
                            || (!private_ipv4(*target.ip()) && !target.ip().is_broadcast())
                    })
            })
        {
            return Err("设备发现配置无效".into());
        }
        Ok(())
    }
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub udp_address: Option<SocketAddrV4>,
    pub adapters: Vec<Adapter>,
    pub error: Option<String>,
    pub active_probes: usize,
    pub probes_completed: u64,
    pub received_packets: u64,
    pub adapter_refreshes: u64,
}
pub(super) struct Service {
    cancel: CancellationToken,
    task: Option<JoinHandle<Result<(), String>>>,
    status: Arc<RwLock<Status>>,
    pub ttl: Duration,
}
struct Running(Arc<RwLock<Status>>);
impl Drop for Running {
    fn drop(&mut self) {
        let mut status = self.0.write().unwrap();
        status.running = false;
        status.udp_address = None;
        status.active_probes = 0;
    }
}
impl Service {
    pub async fn start(
        config: Config,
        identity: Arc<Identity>,
        name: String,
        port: u16,
        peers: Arc<Mutex<Peers>>,
        parent: &CancellationToken,
    ) -> Result<Self, String> {
        config.validate()?;
        if port == 0 || utf16_len(&name) > 255 {
            return Err("请先启动传输监听".into());
        }
        let packet = serde_json::to_vec(&Discovery {
            protocol: "dustdesk-1".into(),
            id: identity.id.clone(),
            name,
            port,
            fingerprint: identity.fingerprint.clone(),
        })
        .map_err(|_| "发现数据无法编码")?;
        if packet.len() > 2048 {
            return Err("设备名称编码后的发现数据过长".into());
        }
        let cancel = parent.child_token();
        let status = Arc::new(RwLock::new(Status {
            running: true,
            ..Status::default()
        }));
        let socket = config
            .bind
            .and_then(|address| match bind(address, config.reuse_address) {
                Ok(socket) => {
                    status.write().unwrap().udp_address =
                        socket.local_addr().ok().and_then(|address| {
                            if let SocketAddr::V4(address) = address {
                                Some(address)
                            } else {
                                None
                            }
                        });
                    Some(socket)
                }
                Err(error) => {
                    status.write().unwrap().error =
                        Some(format!("设备发现受阻：{error}，可手动连接"));
                    None
                }
            });
        let worker_cancel = cancel.clone();
        let worker_status = status.clone();
        let ttl = config.ttl;
        let task = tokio::spawn(async move {
            let _running = Running(worker_status.clone());
            run(
                config,
                identity,
                packet,
                peers,
                socket,
                worker_status,
                worker_cancel,
            )
            .await
        });
        Ok(Self {
            cancel,
            task: Some(task),
            status,
            ttl,
        })
    }
    pub fn status(&self) -> Status {
        self.status.read().unwrap().clone()
    }
    pub async fn stop(&mut self) -> Result<(), String> {
        self.cancel.cancel();
        let result = if let Some(task) = self.task.as_mut() {
            task.await
                .map_err(|_| "设备发现工作任务未正常退出".to_owned())
                .and_then(|value| value)
        } else {
            Ok(())
        };
        self.task = None;
        self.status.write().unwrap().running = false;
        result
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
fn bind(address: SocketAddrV4, reuse: bool) -> std::io::Result<UdpSocket> {
    let socket = socket2::Socket::new(
        socket2::Domain::IPV4,
        socket2::Type::DGRAM,
        Some(socket2::Protocol::UDP),
    )?;
    socket.set_reuse_address(reuse)?;
    socket.set_broadcast(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&SocketAddr::V4(address).into())?;
    UdpSocket::from_std(socket.into())
}
async fn heartbeat(
    identity: Arc<Identity>,
    probe: Probe,
    timeout: Duration,
    cancel: CancellationToken,
) -> (Probe, Result<super::protocol::Device, String>) {
    let _guard = cancel.clone().drop_guard();
    let limits = Limits {
        connect: timeout,
        handshake: timeout,
        headers: timeout,
        idle: timeout,
        ..Limits::default()
    };
    let result = match Client::new(identity, limits) {
        Ok(client) => {
            let operation = client.hello(&probe.device, &cancel);
            tokio::pin!(operation);
            tokio::select! { result = &mut operation => result, _ = tokio::time::sleep(timeout) => { cancel.cancel(); operation.await } }
        }
        Err(error) => Err(error),
    };
    (probe, result)
}
async fn run(
    config: Config,
    identity: Arc<Identity>,
    packet: Vec<u8>,
    peers: Arc<Mutex<Peers>>,
    mut socket: Option<UdpSocket>,
    status: Arc<RwLock<Status>>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let mut interval = tokio::time::interval(config.cadence);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut jobs: JoinSet<(Probe, Result<super::protocol::Device, String>)> = JoinSet::new();
    let mut pending = HashSet::new();
    let mut buffer = [0_u8; 2049];
    let mut window = Instant::now();
    let mut packets = 0;
    let mut failure = None;
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(window + Duration::from_secs(1))), if packets >= 256 => {
                window = Instant::now();
                packets = 0;
            },
            completion = jobs.join_next(), if !jobs.is_empty() => {
                match completion {
                    Some(Ok((probe, result))) => {
                        pending.remove(&probe.device.fingerprint);
                        {
                            let mut status = status.write().unwrap();
                            status.active_probes = pending.len();
                            status.probes_completed = status.probes_completed.saturating_add(1);
                        }
                        if !cancel.is_cancelled() {
                            if let Ok(device) = result {
                                peers.lock().unwrap().probed(&probe, device, Instant::now());
                            }
                        }
                    },
                    Some(Err(error)) => {
                        failure = Some(format!("设备保活工作异常：{error}"));
                        break;
                    },
                    None => {},
                }
            },
            _ = interval.tick() => {
                let interfaces = match tokio::task::spawn_blocking(adapters::enumerate).await {
                    Ok(interfaces) => interfaces,
                    Err(_) => {
                        failure = Some("网络适配器工作线程异常".into());
                        break;
                    }
                };
                {
                    let mut status = status.write().unwrap();
                    match interfaces {
                        Ok(interfaces) => status.adapters = interfaces,
                        Err(error) => status.error = Some(format!("{error}，可手动连接")),
                    }
                    status.adapter_refreshes = status.adapter_refreshes.saturating_add(1);
                }
                if cancel.is_cancelled() { break; }
                let now = Instant::now();
                let probes = {
                    let mut peers = peers.lock().unwrap();
                    peers.prune(now, config.ttl);
                    peers.probes(now, config.cadence, &pending, 8_usize.saturating_sub(pending.len()))
                };
                for probe in probes {
                    pending.insert(probe.device.fingerprint.clone());
                    jobs.spawn(heartbeat(identity.clone(), probe, config.timeout, cancel.child_token()));
                }
                status.write().unwrap().active_probes = pending.len();
                if let Some(socket) = &socket {
                    let targets = config.targets.clone().unwrap_or_else(|| {
                        let mut targets = vec![SocketAddrV4::new(Ipv4Addr::BROADCAST, DISCOVERY_PORT)];
                        targets.extend(status.read().unwrap().adapters.iter().map(|adapter| SocketAddrV4::new(adapter.broadcast, DISCOVERY_PORT)));
                        targets.sort();
                        targets.dedup();
                        targets
                    });
                    for target in targets {
                        let result = tokio::select! {
                            biased;
                            _ = cancel.cancelled() => break,
                            value = socket.send_to(&packet, target) => value,
                        };
                        if let Err(error) = result {
                            status.write().unwrap().error = Some(format!("设备发现受阻：{error}，可手动连接"));
                        }
                    }
                }
            },
            result = async { socket.as_ref().unwrap().recv_from(&mut buffer).await }, if socket.is_some() && packets < 256 => {
                match result {
                    Ok((length, SocketAddr::V4(remote))) => {
                        let at = Instant::now();
                        if at.duration_since(window) >= Duration::from_secs(1) {
                            window = at;
                            packets = 0;
                        }
                        packets += 1;
                        {
                            let mut state = status.write().unwrap();
                            state.received_packets = state.received_packets.saturating_add(1);
                        }
                        if let Ok(packet) = Discovery::parse(&buffer[..length], &remote.ip().to_string(), &identity.id) {
                            peers.lock().unwrap().observe(packet, remote.ip().to_string(), at, chrono::Utc::now().timestamp_millis() as f64);
                        }
                    },
                    Ok(_) => {},
                    Err(error) => {
                        let mut state = status.write().unwrap();
                        state.error = Some(format!("设备发现受阻：{error}，可手动连接"));
                        state.udp_address = None;
                        socket = None;
                    },
                }
            }
        }
    }
    cancel.cancel();
    while jobs.join_next().await.is_some() {}
    failure.map_or(Ok(()), Err)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_preserve_wire_port_heartbeat_and_offline_windows() {
        let config = Config::default();
        assert_eq!(config.bind.unwrap().port(), 45892);
        assert_eq!(config.cadence, Duration::from_secs(5));
        assert_eq!(config.timeout, Duration::from_secs(3));
        assert_eq!(config.ttl, Duration::from_secs(20));
        assert!(config.validate().is_ok());
        assert!(Config {
            cadence: Duration::ZERO,
            ..config.clone()
        }
        .validate()
        .is_err());
        assert!(Config {
            targets: Some(vec!["8.8.8.8:45892".parse().unwrap()]),
            ..config
        }
        .validate()
        .is_err());
    }
}
