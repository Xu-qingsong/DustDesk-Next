//! Read-only Windows IPv4 enumeration; no PowerShell, DNS or firewall changes.
use super::protocol::private_ipv4;
use serde::Serialize;
use std::net::Ipv4Addr;
use windows::Win32::{
    Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_NO_DATA, NO_ERROR},
    NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    },
    Networking::WinSock::{AF_INET, SOCKADDR_IN},
};

#[derive(Clone, Debug, Serialize)]
pub struct Adapter {
    pub address: Ipv4Addr,
    pub prefix: u8,
    pub broadcast: Ipv4Addr,
}
fn broadcast(address: Ipv4Addr, prefix: u8) -> Option<Ipv4Addr> {
    if prefix > 32 {
        return None;
    }
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    Some(Ipv4Addr::from(u32::from(address) | !mask))
}
pub fn enumerate() -> Result<Vec<Adapter>, String> {
    let mut size = 15_000_u32;
    for _ in 0..3 {
        if size > 1024 * 1024 {
            return Err("网络适配器信息过大".into());
        }
        // Windows structures require pointer alignment, unlike Vec<u8>.
        let mut buffer = vec![0_u64; (size as usize).div_ceil(8)];
        let first = buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        let result = unsafe {
            GetAdaptersAddresses(
                AF_INET.0 as u32,
                GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER,
                None,
                Some(first),
                &mut size,
            )
        };
        if result == ERROR_BUFFER_OVERFLOW.0 {
            continue;
        }
        if result == ERROR_NO_DATA.0 {
            return Ok(Vec::new());
        }
        if result != NO_ERROR.0 {
            return Err(format!("读取网络适配器失败：{result}"));
        }
        let mut adapters = Vec::new();
        let mut cursor = first;
        while !cursor.is_null() {
            // All linked structures are owned by the still-live aligned buffer
            // returned successfully by this OS call; no pointers escape it.
            let adapter = unsafe { &*cursor };
            if adapter.OperStatus.0 == 1 && adapter.IfType != 24 {
                let mut unicast = adapter.FirstUnicastAddress;
                while !unicast.is_null() {
                    let entry = unsafe { &*unicast };
                    if entry.Address.iSockaddrLength as usize >= std::mem::size_of::<SOCKADDR_IN>()
                        && !entry.Address.lpSockaddr.is_null()
                    {
                        let address = unsafe { &*entry.Address.lpSockaddr.cast::<SOCKADDR_IN>() };
                        if address.sin_family == AF_INET {
                            let ip = Ipv4Addr::from(
                                unsafe { address.sin_addr.S_un.S_addr }.to_ne_bytes(),
                            );
                            if private_ipv4(ip) && !ip.is_loopback() {
                                if let Some(broadcast) = broadcast(ip, entry.OnLinkPrefixLength) {
                                    adapters.push(Adapter {
                                        address: ip,
                                        prefix: entry.OnLinkPrefixLength,
                                        broadcast,
                                    });
                                }
                            }
                        }
                    }
                    unicast = entry.Next;
                }
            }
            cursor = adapter.Next;
        }
        adapters.sort_by_key(|adapter| (adapter.address, adapter.prefix));
        adapters.dedup_by_key(|adapter| (adapter.address, adapter.prefix));
        return Ok(adapters);
    }
    Err("网络适配器变化过快，请重试".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn broadcast_masks_include_point_to_point_and_reject_invalid_prefixes() {
        let address = Ipv4Addr::new(192, 168, 1, 7);
        assert_eq!(
            broadcast(address, 24),
            Some(Ipv4Addr::new(192, 168, 1, 255))
        );
        assert_eq!(broadcast(address, 32), Some(address));
        assert_eq!(broadcast(address, 0), Some(Ipv4Addr::BROADCAST));
        assert_eq!(broadcast(address, 33), None);
    }
}
