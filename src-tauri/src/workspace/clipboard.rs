use super::{Snapshot, WorkspaceStore};
use crate::clipboard::WriteContent;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;

impl WorkspaceStore {
    pub fn clipboard_enabled(&mut self) -> Result<bool, String> {
        Ok(self.read()?["Settings"]["ClipboardMonitoringEnabled"] != false)
    }

    pub fn ingest_clipboard(
        &mut self,
        record: Value,
    ) -> Result<Option<(Snapshot, Option<Value>)>, String> {
        let mut state = self.read()?;
        if state["Settings"]["ClipboardMonitoringEnabled"] == false {
            return Ok(None);
        }
        self.insert_clipboard_record(record, &mut state, false)
    }
    pub fn screenshot_settings(&mut self) -> Result<Value, String> {
        Ok(self.read()?["Settings"].clone())
    }
    pub fn ingest_screenshot(
        &mut self,
        png: &[u8],
        name: &str,
    ) -> Result<Option<(Snapshot, Option<Value>)>, String> {
        use sha2::{Digest, Sha256};
        let mut state = self.read()?;
        if state["Settings"]["ScreenshotAutoAddToClipboardHistory"] != true {
            return Ok(None);
        }
        let fingerprint = format!("{:x}", Sha256::digest(png));
        let asset_name = format!("{fingerprint}.png");
        if state["ClipboardHistory"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["ImageSha256"] == fingerprint || item["ImageAssetName"] == asset_name)
        {
            return Ok(None);
        }
        self.insert_clipboard_record(serde_json::json!({"Id":uuid::Uuid::new_v4().to_string(),"Kind":"Image","Text":"","ImagePngBase64":STANDARD.encode(png),"ImageFileName":name,"ImageSha256":fingerprint,"CreatedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"IsLocked":false,"IsPinned":false}), &mut state, true)
    }
    fn insert_clipboard_record(
        &mut self,
        record: Value,
        state: &mut Value,
        keep_first_two_hundred: bool,
    ) -> Result<Option<(Snapshot, Option<Value>)>, String> {
        let history = state["ClipboardHistory"].as_array_mut().unwrap();
        if history
            .iter()
            .any(|item| item["ImageSha256"] == record["ImageSha256"])
        {
            return Ok(None);
        }
        let id = record["Id"].clone();
        history.insert(0, record);
        let protected = history
            .iter()
            .filter(|item| item["IsLocked"] == true || item["IsPinned"] == true)
            .count();
        let mut remaining = 200usize.saturating_sub(protected);
        let mut index = 0;
        history.retain(|item| {
            let original_index = index;
            index += 1;
            if keep_first_two_hundred {
                return original_index < 200
                    || item["IsLocked"] == true
                    || item["IsPinned"] == true;
            }
            if item["IsLocked"] == true || item["IsPinned"] == true {
                true
            } else if remaining > 0 {
                remaining -= 1;
                true
            } else {
                false
            }
        });
        self.write(state, true)?;
        let record = state["ClipboardHistory"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["Id"] == id)
            .cloned();
        Ok(Some((self.snapshot(state.clone()), record)))
    }

    pub fn clipboard_content(&mut self, id: &str) -> Result<WriteContent, String> {
        let state = self.read()?;
        let item = state["ClipboardHistory"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["Id"] == id)
            .ok_or("剪贴板记录已删除")?;
        if item["Kind"] == "Image" {
            Ok(WriteContent {
                text: None,
                image_png_base64: Some(STANDARD.encode(super::assets::read(&self.root, item)?)),
                record_id: None,
            })
        } else {
            Ok(WriteContent {
                text: Some(item["Text"].as_str().unwrap_or("").into()),
                image_png_base64: None,
                record_id: None,
            })
        }
    }
}

#[cfg(test)]
#[path = "clipboard_tests.rs"]
mod tests;
