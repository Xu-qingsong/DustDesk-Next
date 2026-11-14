use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, io::Read, net::Ipv4Addr};

pub const DISCOVERY_PORT: u16 = 45892;
pub const MAX_JSON_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 10000;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(crate) fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

pub fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Hash a confirmed resume prefix from a source handle already authorized by
/// the service. Never allocates the file size or reads beyond the prefix.
pub fn hash_prefix(mut source: impl Read, size: u64) -> Result<String, String> {
    if size > MAX_SAFE_INTEGER {
        return Err("续传前缀超出安全范围".into());
    }
    let mut hash = Sha256::new();
    let mut remaining = size;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let count = usize::try_from(remaining.min(buffer.len() as u64)).unwrap();
        let count = source
            .read(&mut buffer[..count])
            .map_err(|error| format!("读取续传前缀失败：{error}"))?;
        if count == 0 {
            return Err("发送源短于续传偏移，请重新发送".into());
        }
        hash.update(&buffer[..count]);
        remaining -= count as u64;
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn valid_fingerprint(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
}

pub fn pairing_code(a: &str, b: &str) -> Result<String, String> {
    if !valid_fingerprint(a) || !valid_fingerprint(b) {
        return Err("设备证书指纹无效".into());
    }
    let (first, second) = if a <= b { (a, b) } else { (b, a) };
    let hash = Sha256::digest(format!("{first}:{second}"));
    let prefix = hash[..6]
        .iter()
        .fold(0_u64, |sum, byte| (sum << 8) | u64::from(*byte));
    Ok(format!("{:06}", prefix % 1_000_000))
}

pub fn valid_address(value: &str) -> bool {
    // Node accepts leading-zero octets; avoid Rust's stricter textual parser.
    let parts = value.split('.').collect::<Vec<_>>();
    if parts.len() != 4
        || parts.iter().any(|part| {
            part.is_empty() || part.len() > 3 || !part.bytes().all(|ch| ch.is_ascii_digit())
        })
    {
        return false;
    }
    let Ok(octets) = parts
        .iter()
        .map(|part| part.parse::<u8>())
        .collect::<Result<Vec<_>, _>>()
    else {
        return false;
    };
    // Match the existing textual private-prefix check, including its treatment
    // of leading zeroes, rather than silently permitting a new address range.
    value.starts_with("127.")
        || value.starts_with("10.")
        || value.starts_with("192.168.")
        || value.starts_with("169.254.")
        || (parts[0] == "172" && (16..=31).contains(&octets[1]) && parts[1].len() == 2)
}

pub fn private_ipv4(value: Ipv4Addr) -> bool {
    valid_address(&value.to_string())
}

pub(crate) fn safe_integer<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = Value::deserialize(deserializer)?;
    let number = value
        .as_f64()
        .ok_or_else(|| serde::de::Error::custom("整数无效"))?;
    if !number.is_finite()
        || number < 0.0
        || number.fract() != 0.0
        || number > MAX_SAFE_INTEGER as f64
    {
        return Err(serde::de::Error::custom("整数超出安全范围"));
    }
    Ok(number as u64)
}

fn port<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u16, D::Error> {
    let value = safe_integer(deserializer)?;
    u16::try_from(value)
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| serde::de::Error::custom("端口无效"))
}

fn present_text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Entry {
    pub relative: String,
    #[serde(deserialize_with = "safe_integer")]
    pub size: u64,
    pub mtime: f64,
    pub hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub entries: Vec<Entry>,
    pub directories: Vec<String>,
    #[serde(
        default,
        deserialize_with = "present_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub text: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-')
}

pub(crate) fn path_key(name: &str) -> Result<String, String> {
    if utf16_len(name) > 2048
        || name.contains('\\')
        || name.split('/').any(|part| {
            let base = part
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            let reserved = matches!(base.as_str(), "con" | "prn" | "aux" | "nul")
                || ((base.starts_with("com") || base.starts_with("lpt"))
                    && base.len() == 4
                    && (b'1'..=b'9').contains(&base.as_bytes()[3]));
            part.is_empty()
                || part == "."
                || part == ".."
                || part.ends_with(['.', ' '])
                || part
                    .chars()
                    .any(|ch| ch <= '\u{1f}' || "<>:\"|?*".contains(ch))
                || reserved
        })
    {
        return Err("传输路径无效".into());
    }
    Ok(name.to_lowercase())
}

impl Manifest {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_JSON_BYTES {
            return Err("请求内容过大".into());
        }
        let value: Self =
            serde_json::from_slice(bytes).map_err(|_| "传输清单无效或文件大小无效".to_string())?;
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<(), String> {
        if !valid_id(&self.id)
            || utf16_len(&self.name) > 255
            || self.entries.len().saturating_add(self.directories.len()) > MAX_ENTRIES
        {
            return Err("传输清单无效或超过 10000 项".into());
        }
        let mut seen = HashSet::new();
        let mut files = HashSet::new();
        for directory in &self.directories {
            if !seen.insert(path_key(directory)?) {
                return Err("清单含重复路径".into());
            }
        }
        let mut total = 0_u64;
        for entry in &self.entries {
            let key = path_key(&entry.relative)?;
            if !seen.insert(key.clone()) {
                return Err("清单含重复路径".into());
            }
            files.insert(key);
            if entry.size > MAX_SAFE_INTEGER
                || !entry.mtime.is_finite()
                || !valid_fingerprint(&entry.hash)
            {
                return Err("文件大小或校验值无效".into());
            }
            total = total
                .checked_add(entry.size)
                .filter(|total| *total <= MAX_SAFE_INTEGER)
                .ok_or("总大小超过安全范围")?;
        }
        for name in seen {
            let mut parent = name.as_str();
            while let Some((prefix, _)) = parent.rsplit_once('/') {
                if files.contains(prefix) {
                    return Err("文件与目录冲突".into());
                }
                parent = prefix;
            }
        }
        if self.text.as_ref().is_some_and(|text| {
            text.len() > MAX_TEXT_BYTES || !self.entries.is_empty() || !self.directories.is_empty()
        }) {
            return Err("文本传输无效".into());
        }
        Ok(())
    }

    pub fn total(&self) -> Result<u64, String> {
        self.validate()?;
        Ok(self.entries.iter().map(|entry| entry.size).sum())
    }

    /// File-system locations are local state, never protocol-1 offer fields.
    pub fn public(&self) -> Self {
        let mut manifest = self.clone();
        manifest.extra.clear();
        for entry in &mut manifest.entries {
            entry.source = None;
            entry.extra.clear();
        }
        manifest
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest() -> Value {
        json!({"id":"unit-test","name":"目录 😀","directories":["目录","目录/empty"],"entries":[{"relative":"目录/中文.txt","size":3,"mtime":123.125,"hash":"a".repeat(64),"source":"C:/private/source"}]})
    }

    #[test]
    fn prefix_hashing_is_bounded_and_rejects_a_short_source() {
        let mut source = std::io::Cursor::new(vec![42; 256 * 1024]);
        assert_eq!(
            hash_prefix(&mut source, 65_537).unwrap(),
            fingerprint(&vec![42; 65_537])
        );
        assert_eq!(source.position(), 65_537);
        assert!(hash_prefix(&mut source, 256 * 1024).is_err());
        assert_eq!(hash_prefix(std::io::empty(), 0).unwrap(), fingerprint(&[]));
    }

    fn parse(value: &Value) -> Result<Manifest, String> {
        Manifest::parse(&serde_json::to_vec(value).unwrap())
    }

    #[test]
    fn protocol_one_manifest_preserves_fractional_mtime_and_strips_local_offer_fields() {
        let mut value = manifest();
        value["local"] = json!("private");
        value["entries"][0]["local"] = json!("private");
        let parsed = parse(&value).unwrap();
        assert_eq!(parsed.entries[0].mtime, 123.125);
        assert_eq!(parsed.total().unwrap(), 3);
        let public = serde_json::to_value(parsed.public()).unwrap();
        assert!(public.get("local").is_none());
        assert!(public["entries"][0].get("source").is_none());
        assert!(public["entries"][0].get("local").is_none());
        assert!(parsed.entries[0].source.is_some());
    }

    #[test]
    fn path_rules_block_escape_reserved_duplicate_and_file_directory_conflicts() {
        for path in [
            "../a", "/a", "a\\b", "a//b", "a/./b", "a/../b", "con.txt", "a/LPT9.x", "a/com1", "a ",
            "a.", "a/b:", "a\0b", "a\nb", "a?b",
        ] {
            let mut value = manifest();
            value["entries"][0]["relative"] = json!(path);
            assert!(parse(&value).is_err(), "{path:?}");
        }
        for path in ["目录", "目录/EMPTY", "目录/中文.txt/child"] {
            let mut value = manifest();
            value["directories"]
                .as_array_mut()
                .unwrap()
                .push(json!(path));
            assert!(parse(&value).is_err(), "{path}");
        }
    }

    #[test]
    fn utf16_and_utf8_limits_match_their_distinct_electron_boundaries() {
        let mut value = manifest();
        value["name"] = json!("😀".repeat(127) + "a");
        assert!(parse(&value).is_ok());
        value["name"] = json!("😀".repeat(128));
        assert!(parse(&value).is_err());
        let mut value = json!({"id":"text","name":"文本","entries":[],"directories":[],"text":"x".repeat(MAX_TEXT_BYTES)});
        assert!(parse(&value).is_ok());
        value["text"] = json!("x".repeat(MAX_TEXT_BYTES) + "字");
        assert!(parse(&value).is_err());
        value["text"] = Value::Null;
        assert!(parse(&value).is_err());
    }

    #[test]
    fn safe_integer_checks_accept_json_exponents_but_reject_unsafe_totals() {
        let mut value = manifest();
        value["entries"][0]["size"] = json!(1.0);
        assert_eq!(parse(&value).unwrap().total().unwrap(), 1);
        for size in [
            json!(-1),
            json!(0.5),
            json!(MAX_SAFE_INTEGER + 1),
            json!("1"),
        ] {
            value["entries"][0]["size"] = size;
            assert!(parse(&value).is_err());
        }
        value["entries"][0]["size"] = json!(MAX_SAFE_INTEGER);
        let mut second = value["entries"][0].clone();
        second["relative"] = json!("another");
        second["size"] = json!(1);
        value["entries"].as_array_mut().unwrap().push(second);
        assert!(parse(&value).is_err());
    }

    #[test]
    fn entry_count_limit_and_empty_directory_batches_are_preserved() {
        let mut value = json!({"id":"empty","name":"","entries":[],"directories":(0..MAX_ENTRIES).map(|i| i.to_string()).collect::<Vec<_>>()});
        assert!(parse(&value).is_ok());
        value["directories"]
            .as_array_mut()
            .unwrap()
            .push(json!("extra"));
        assert!(parse(&value).is_err());
    }

    #[test]
    fn offsets_require_a_valid_token_and_cannot_claim_an_incomplete_file_is_complete() {
        let manifest = parse(&manifest()).unwrap();
        let mut offer = OfferReply {
            token: "b".repeat(64),
            offsets: vec![Offset {
                size: 2,
                hash: "c".repeat(64),
                complete: false,
            }],
        };
        assert!(offer.validate(&manifest).is_ok());
        offer.offsets[0].complete = true;
        assert!(offer.validate(&manifest).is_err());
        offer.offsets[0].size = 3;
        assert!(offer.validate(&manifest).is_err());
        offer.offsets[0].hash = "a".repeat(64);
        assert!(offer.validate(&manifest).is_ok());
        offer.token = "bad".into();
        assert!(offer.validate(&manifest).is_err());
    }

    #[test]
    fn discovery_does_not_replace_an_already_paired_fingerprint() {
        let packet = json!({"protocol":"dustdesk-1","id":"peer","name":"对方","port":12345,"fingerprint":"a".repeat(64)});
        let bytes = serde_json::to_vec(&packet).unwrap();
        let parsed = Discovery::parse(&bytes, "192.168.1.2", "self").unwrap();
        let mut device = Device {
            id: "peer".into(),
            name: "old".into(),
            address: "10.0.0.1".into(),
            port: 1,
            fingerprint: "b".repeat(64),
            last_seen: 0.0,
            extra: Map::new(),
        };
        assert!(device.observe(&parsed, "192.168.1.2", 1.0).is_err());
        assert_eq!(device.address, "10.0.0.1");
        device.fingerprint = "a".repeat(64);
        device.observe(&parsed, "192.168.1.2", 1.0).unwrap();
        assert_eq!(device.port, 12345);
        assert!(Discovery::parse(&bytes, "8.8.8.8", "self").is_err());
        assert!(Discovery::parse(&bytes, "127.0.0.1", "peer").is_err());
        assert!(Discovery::parse(&vec![b' '; 2049], "127.0.0.1", "self").is_err());
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Discovery {
    pub protocol: String,
    pub id: String,
    pub name: String,
    #[serde(deserialize_with = "port")]
    pub port: u16,
    pub fingerprint: String,
}

impl Discovery {
    pub fn parse(bytes: &[u8], remote: &str, own_id: &str) -> Result<Self, String> {
        if bytes.len() > 2048 || !valid_address(remote) {
            return Err("发现数据无效".into());
        }
        let packet: Self = serde_json::from_slice(bytes).map_err(|_| "发现数据无效")?;
        if packet.protocol != "dustdesk-1"
            || utf16_len(&packet.id) > 80
            || packet.id == own_id
            || utf16_len(&packet.name) > 255
            || !valid_fingerprint(&packet.fingerprint)
        {
            return Err("发现数据无效".into());
        }
        Ok(packet)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub address: String,
    #[serde(deserialize_with = "port")]
    pub port: u16,
    pub fingerprint: String,
    pub last_seen: f64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Device {
    pub fn validate(&self) -> Result<(), String> {
        if utf16_len(&self.id) > 80
            || utf16_len(&self.name) > 255
            || !valid_address(&self.address)
            || self.port == 0
            || !valid_fingerprint(&self.fingerprint)
            || !self.last_seen.is_finite()
        {
            return Err("设备信息无效".into());
        }
        Ok(())
    }

    /// A broadcast can update the address, never the pinned identity.
    pub fn observe(&mut self, packet: &Discovery, remote: &str, now: f64) -> Result<(), String> {
        if self.id != packet.id
            || self.fingerprint != packet.fingerprint
            || !valid_address(remote)
            || !now.is_finite()
        {
            return Err("设备身份已变化，请重新连接并核对配对码".into());
        }
        self.name.clone_from(&packet.name);
        self.address = remote.into();
        self.port = packet.port;
        self.last_seen = now;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Offset {
    #[serde(deserialize_with = "safe_integer")]
    pub size: u64,
    pub hash: String,
    pub complete: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OfferReply {
    pub token: String,
    pub offsets: Vec<Offset>,
}

impl OfferReply {
    // File-prefix hashes must additionally be streamed and compared before use.
    pub fn validate(&self, manifest: &Manifest) -> Result<(), String> {
        manifest.validate()?;
        if !valid_fingerprint(&self.token) || self.offsets.len() != manifest.entries.len() {
            return Err("续传信息无效".into());
        }
        for (offset, entry) in self.offsets.iter().zip(&manifest.entries) {
            if offset.size > entry.size
                || !valid_fingerprint(&offset.hash)
                || (offset.complete && (offset.size != entry.size || offset.hash != entry.hash))
            {
                return Err("续传临时文件校验失败，请取消并重新发送".into());
            }
        }
        Ok(())
    }
}
