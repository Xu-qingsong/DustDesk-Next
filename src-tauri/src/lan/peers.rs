//! Broadcasts are hints; only durably approved TLS identities become peers.
//! Monotonic liveness and revisions keep late probes from replacing new hints.
use super::protocol::{Device, Discovery};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

const MAX_HINTS: usize = 256;
struct Seen {
    device: Device,
    at: Instant,
}
struct Paired {
    device: Device,
    at: Option<Instant>,
    probed: Option<Instant>,
    revision: u64,
}
#[derive(Clone)]
pub(super) struct Probe {
    pub device: Device,
    revision: u64,
}
#[derive(Default)]
pub(super) struct Peers {
    hints: HashMap<String, Seen>,
    paired: HashMap<String, Paired>,
    revision: u64,
}
impl Peers {
    fn next_revision(&mut self) -> u64 {
        self.revision = self.revision.wrapping_add(1);
        self.revision
    }
    pub fn pair(&mut self, device: Device) {
        self.insert_pair(device, Some(Instant::now()));
    }
    pub fn restore(&mut self, device: Device) {
        // Saved endpoints are useful for probing, but are never online merely
        // because they were present in a restart file.
        if !self.paired.contains_key(&device.fingerprint) {
            self.insert_pair(device, None);
        }
    }
    fn insert_pair(&mut self, device: Device, at: Option<Instant>) {
        self.hints.remove(&device.id);
        let revision = self.next_revision();
        self.paired.insert(
            device.fingerprint.clone(),
            Paired {
                device,
                at,
                probed: None,
                revision,
            },
        );
    }
    pub fn known(&self) -> HashMap<String, Device> {
        self.paired
            .iter()
            .map(|(key, peer)| (key.clone(), peer.device.clone()))
            .collect()
    }
    pub fn observe(&mut self, packet: Discovery, address: String, at: Instant, wall: f64) {
        let pin = self
            .paired
            .iter()
            .find(|(_, peer)| peer.device.id == packet.id)
            .map(|(pin, _)| pin.clone());
        if let Some(pin) = pin {
            if pin != packet.fingerprint {
                return;
            }
            let endpoint_changed = self.paired[&pin].device.address != address
                || self.paired[&pin].device.port != packet.port;
            let revision = if endpoint_changed {
                self.next_revision()
            } else {
                self.paired[&pin].revision
            };
            let peer = self.paired.get_mut(&pin).unwrap();
            if peer.device.observe(&packet, &address, wall).is_ok() {
                peer.at = Some(at);
                peer.revision = revision;
            }
            return;
        }
        if !self.hints.contains_key(&packet.id) && self.hints.len() >= MAX_HINTS {
            if let Some(oldest) = self
                .hints
                .iter()
                .min_by_key(|(_, seen)| seen.at)
                .map(|(id, _)| id.clone())
            {
                self.hints.remove(&oldest);
            }
        }
        self.hints.insert(
            packet.id.clone(),
            Seen {
                device: Device {
                    id: packet.id,
                    name: packet.name,
                    address,
                    port: packet.port,
                    fingerprint: packet.fingerprint,
                    last_seen: wall,
                    extra: Default::default(),
                },
                at,
            },
        );
    }
    pub fn visible(&self, at: Instant, ttl: Duration) -> Vec<Device> {
        let mut visible = self
            .hints
            .values()
            .filter(|seen| at.saturating_duration_since(seen.at) <= ttl)
            .map(|seen| seen.device.clone())
            .collect::<Vec<_>>();
        visible.extend(
            self.paired
                .values()
                .filter(|peer| {
                    peer.at
                        .is_some_and(|seen| at.saturating_duration_since(seen) <= ttl)
                })
                .map(|peer| peer.device.clone()),
        );
        visible.sort_by(|a, b| a.id.cmp(&b.id));
        visible
    }
    pub fn prune(&mut self, at: Instant, ttl: Duration) {
        self.hints
            .retain(|_, seen| at.saturating_duration_since(seen.at) <= ttl);
    }
    pub fn probes(
        &mut self,
        at: Instant,
        cadence: Duration,
        pending: &HashSet<String>,
        limit: usize,
    ) -> Vec<Probe> {
        let mut eligible = self
            .paired
            .iter()
            .filter(|(pin, peer)| {
                !pending.contains(*pin)
                    && peer
                        .probed
                        .is_none_or(|time| at.saturating_duration_since(time) >= cadence)
            })
            .map(|(pin, peer)| (pin.clone(), peer.probed))
            .collect::<Vec<_>>();
        eligible.sort_by_key(|(pin, time)| (*time, pin.clone()));
        eligible
            .into_iter()
            .take(limit)
            .map(|(pin, _)| {
                let peer = self.paired.get_mut(&pin).unwrap();
                peer.probed = Some(at);
                Probe {
                    device: peer.device.clone(),
                    revision: peer.revision,
                }
            })
            .collect()
    }
    pub fn probed(&mut self, probe: &Probe, device: Device, at: Instant) {
        if let Some(peer) = self.paired.get_mut(&probe.device.fingerprint) {
            if peer.revision == probe.revision
                && device.id == peer.device.id
                && device.fingerprint == peer.device.fingerprint
            {
                peer.device = device;
                peer.at = Some(at);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn device(id: &str) -> Device {
        Device {
            id: id.into(),
            name: id.into(),
            address: "127.0.0.1".into(),
            port: 12345,
            fingerprint: "a".repeat(64),
            last_seen: 0.0,
            extra: Default::default(),
        }
    }
    fn packet(device: &Device) -> Discovery {
        Discovery {
            protocol: "dustdesk-1".into(),
            id: device.id.clone(),
            name: device.name.clone(),
            port: device.port,
            fingerprint: device.fingerprint.clone(),
        }
    }
    #[test]
    fn hints_never_pair_expire_monotonically_and_are_bounded() {
        let mut peers = Peers::default();
        let now = Instant::now();
        let ttl = Duration::from_secs(20);
        for index in 0..300 {
            let peer = device(&index.to_string());
            peers.observe(
                packet(&peer),
                peer.address,
                now + Duration::from_millis(index),
                1.0,
            );
        }
        assert!(peers.known().is_empty());
        assert_eq!(peers.hints.len(), MAX_HINTS);
        assert_eq!(
            peers.visible(now + Duration::from_secs(1), ttl).len(),
            MAX_HINTS
        );
        peers.prune(now + Duration::from_secs(21), ttl);
        assert!(peers.hints.is_empty());
    }
    #[test]
    fn changed_pin_is_ignored_and_late_probe_cannot_replace_a_new_endpoint() {
        let mut peers = Peers::default();
        let now = Instant::now();
        let original = device("paired");
        peers.pair(original.clone());
        let probe = peers
            .probes(now, Duration::ZERO, &HashSet::new(), 1)
            .remove(0);
        let mut changed = packet(&original);
        changed.fingerprint = "b".repeat(64);
        changed.port = 54321;
        peers.observe(changed, "10.0.0.1".into(), now, 2.0);
        assert_eq!(peers.known()[&original.fingerprint].port, original.port);
        let mut changed = packet(&original);
        changed.port = 54321;
        peers.observe(changed, "10.0.0.1".into(), now, 3.0);
        peers.probed(&probe, original.clone(), now + Duration::from_secs(1));
        let latest = &peers.known()[&original.fingerprint];
        assert_eq!(latest.port, 54321);
        assert_eq!(latest.last_seen, 3.0);
    }
    #[test]
    fn restored_peers_start_offline_and_successful_probes_reappear() {
        let mut peers = Peers::default();
        let now = Instant::now();
        let original = device("paired");
        peers.restore(original.clone());
        assert!(peers.visible(now, Duration::from_secs(20)).is_empty());
        let probe = peers
            .probes(now, Duration::from_secs(5), &HashSet::new(), 1)
            .remove(0);
        assert!(peers
            .probes(now, Duration::from_secs(5), &HashSet::new(), 1)
            .is_empty());
        peers.probed(&probe, original, now);
        assert_eq!(peers.visible(now, Duration::from_secs(20)).len(), 1);
        assert!(peers
            .visible(now + Duration::from_secs(21), Duration::from_secs(20))
            .is_empty());
        assert_eq!(peers.known().len(), 1);
    }
    #[test]
    fn probe_admission_is_bounded_and_fair_without_duplicate_pending_work() {
        let mut peers = Peers::default();
        let now = Instant::now();
        let cadence = Duration::from_secs(5);
        for index in 0..12 {
            let mut peer = device(&index.to_string());
            peer.fingerprint = format!("{index:064x}");
            peers.pair(peer);
        }
        let first = peers.probes(now, cadence, &HashSet::new(), 8);
        assert_eq!(first.len(), 8);
        let pending = first
            .iter()
            .map(|probe| probe.device.fingerprint.clone())
            .collect();
        let rest = peers.probes(now, cadence, &pending, 8);
        assert_eq!(rest.len(), 4);
        assert!(rest
            .iter()
            .all(|probe| !pending.contains(&probe.device.fingerprint)));
        assert!(peers.probes(now, cadence, &HashSet::new(), 8).is_empty());
        assert_eq!(peers.probes(now + cadence, cadence, &pending, 8).len(), 4);
    }
    #[test]
    fn same_endpoint_hints_do_not_invalidate_an_authenticated_probe() {
        let mut peers = Peers::default();
        let now = Instant::now();
        let peer = device("paired");
        peers.pair(peer.clone());
        let probe = peers
            .probes(now, Duration::ZERO, &HashSet::new(), 1)
            .remove(0);
        peers.observe(packet(&peer), peer.address.clone(), now, 1.0);
        let mut authenticated = peer.clone();
        authenticated.name = "authenticated".into();
        peers.probed(&probe, authenticated, now);
        assert_eq!(peers.known()[&peer.fingerprint].name, "authenticated");
    }
}
