//! Native browser draft validation shared by export and whole-runtime application.
use serde::{de::Visitor, Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use std::collections::HashMap;
const MAX_BYTES: usize = 64 * 1024 * 1024;
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub key: String,
    pub value: String,
}
fn invalid() -> String {
    "草稿数据无效或超出白名单，未截断或导出".into()
}
// JavaScript strings can contain unpaired UTF-16 surrogates. serde_json's
// byte-string visitor decodes those as WTF-8; count code units without making a
// lossy Rust String. The original JSON text is retained unchanged in Entry.
struct TextLength(usize);
impl<'de> Deserialize<'de> for TextLength {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct LengthVisitor;
        impl Visitor<'_> for LengthVisitor {
            type Value = TextLength;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a JSON string")
            }
            fn visit_bytes<E: serde::de::Error>(self, value: &[u8]) -> Result<TextLength, E> {
                Ok(TextLength(
                    value
                        .iter()
                        .filter(|byte| **byte & 0xc0 != 0x80)
                        .map(|byte| if *byte & 0xf8 == 0xf0 { 2 } else { 1 })
                        .sum(),
                ))
            }
        }
        deserializer.deserialize_bytes(LengthVisitor)
    }
}
type Fields = HashMap<String, Box<RawValue>>;
pub fn text(value: &RawValue, maximum: usize, required: bool) -> Result<(), String> {
    let TextLength(length) = serde_json::from_str(value.get()).map_err(|_| invalid())?;
    if length > maximum || (required && length == 0) {
        return Err(invalid());
    }
    Ok(())
}
fn identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.encode_utf16().count() > 256
        || value
            .chars()
            .any(|character| character < ' ' || character == '\u{7f}')
    {
        return Err(invalid());
    }
    Ok(())
}
fn exact(value: &Fields, fields: &[&str]) -> Result<(), String> {
    if value.len() != fields.len() || fields.iter().any(|name| !value.contains_key(*name)) {
        return Err(invalid());
    }
    Ok(())
}
// encodeURIComponent's exact UTF-8 alphabet, including uppercase escapes.
fn encoded(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            result.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(result, "%{byte:02X}").unwrap();
        }
    }
    result
}
fn decoded(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut result = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value.get(index + 1..index + 3).ok_or_else(invalid)?;
            result.push(u8::from_str_radix(hex, 16).map_err(|_| invalid())?);
            index += 3;
        } else {
            result.push(bytes[index]);
            index += 1;
        }
    }
    let result = String::from_utf8(result).map_err(|_| invalid())?;
    if encoded(&result) != value {
        return Err(invalid());
    }
    Ok(result)
}
pub fn validate(entry: &Entry) -> Result<(), String> {
    if entry.key.encode_utf16().count() > 2048 || entry.value.len() > MAX_BYTES {
        return Err(invalid());
    }
    if entry.key == "widget-notes:selected" {
        return if entry.value.is_empty() {
            Ok(())
        } else {
            identifier(&entry.value)
        };
    }
    let value: Fields = serde_json::from_str(&entry.value).map_err(|_| invalid())?;
    if entry.key == "widget-task-draft:v1:todo" {
        exact(&value, &["title", "requestId"])?;
        text(&value["title"], 300, false)?;
        return text(&value["requestId"], 128, true);
    }
    if entry.key == "quick-capture-draft" {
        if value.contains_key("requestId") {
            exact(&value, &["kind", "title", "text", "requestId"])?;
            text(&value["requestId"], 128, true)?;
        } else {
            exact(&value, &["kind", "title", "text"])?;
        }
        if !matches!(
            serde_json::from_str::<String>(value["kind"].get()).as_deref(),
            Ok("note" | "task")
        ) {
            return Err(invalid());
        }
        text(&value["title"], 300, false)?;
        return text(&value["text"], 200000, false);
    }
    if let Some(key) = entry.key.strip_prefix("widget-note:v2:") {
        let (owner, note) = key.split_once(':').ok_or_else(invalid)?;
        let owner = decoded(owner)?;
        let note = decoded(note)?;
        identifier(&note)?;
        if owner != "notes" && owner != format!("note:{note}") {
            return Err(invalid());
        }
    } else if let Some(note) = entry.key.strip_prefix("widget-note:") {
        if note
            .strip_prefix('v')
            .and_then(|rest| rest.split_once(':'))
            .is_some_and(|(version, _)| {
                !version.is_empty() && version.bytes().all(|byte| byte.is_ascii_digit())
            })
        {
            return Err(invalid());
        }
        identifier(note)?;
    } else {
        return Err(invalid());
    }
    if value
        .get("saved")
        .is_some_and(|value| value.get() == "true")
    {
        return exact(&value, &["saved"]);
    }
    exact(&value, &["title", "text", "previousTitle", "previousText"])?;
    for name in ["title", "previousTitle"] {
        text(&value[name], 300, false)?;
    }
    for name in ["text", "previousText"] {
        text(&value[name], 200000, false)?;
    }
    Ok(())
}
