use super::*;
use crate::clipboard::{encode_png, ClipboardContent};
use crate::clipboard_monitor::record;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;
use std::{fs, path::PathBuf};
use uuid::Uuid;

struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn setup() -> (Root, WorkspaceStore) {
    let root =
        Root(std::env::temp_dir().join(format!("dustdesk-monitor-store-{}", Uuid::new_v4())));
    let mut store = WorkspaceStore::open(root.0.clone()).unwrap();
    store
        .initialize(super::super::normalize::default_state(), "test")
        .unwrap();
    (root, store)
}
#[test]
fn screenshot_history_is_explicit_deduplicated_and_independent_of_monitoring() {
    let (_root, mut store) = setup();
    let mut state = store.read().unwrap();
    state["Settings"]["ClipboardMonitoringEnabled"] = json!(false);
    state["Settings"]["ScreenshotAutoAddToClipboardHistory"] = json!(true);
    store.write(&mut state, true).unwrap();
    let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        3,
        2,
        image::Rgba([20, 70, 190, 255]),
    ));
    let png = encode_png(&image).unwrap();
    assert!(store.ingest_screenshot(&png, "截图.png").unwrap().is_some());
    assert!(store.ingest_screenshot(&png, "重复.png").unwrap().is_none());
    let state = store.read().unwrap();
    assert_eq!(state["ClipboardHistory"].as_array().unwrap().len(), 1);
    assert_eq!(state["ClipboardHistory"][0]["ImageFileName"], "截图.png");
    assert_eq!(
        store
            .image(state["ClipboardHistory"][0]["Id"].as_str().unwrap())
            .unwrap(),
        png
    );
}
fn captured(text: &str) -> Value {
    record(ClipboardContent {
        text: text.into(),
        image_png_base64: String::new(),
    })
    .unwrap()
    .unwrap()
}
#[test]
fn screenshot_retention_matches_its_electron_first_two_hundred_plus_protected_rule() {
    let (_root, mut store) = setup();
    let mut state = store.read().unwrap();
    state["Settings"]["ScreenshotAutoAddToClipboardHistory"] = json!(true);
    state["ClipboardHistory"] = json!((0..205)
        .map(|index| {
            let mut record = captured(&format!("old-{index}"));
            record["IsLocked"] = json!(index == 204);
            record["IsPinned"] = json!(index == 203);
            record
        })
        .collect::<Vec<_>>());
    store.write(&mut state, true).unwrap();
    let png = encode_png(&image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_pixel(1, 1, image::Rgba([20, 70, 190, 255])),
    ))
    .unwrap();
    store.ingest_screenshot(&png, "retention.png").unwrap();
    let state = store.read().unwrap();
    let records = state["ClipboardHistory"].as_array().unwrap();
    assert_eq!(records.len(), 202);
    assert_eq!(records[0]["ImageFileName"], "retention.png");
    assert_eq!(records[199]["Text"], "old-198");
    assert!(records.iter().any(|item| item["Text"] == "old-204"));
    assert!(records.iter().any(|item| item["Text"] == "old-203"));
}

#[test]
fn commits_before_publishing_and_deduplicates_after_reopen_without_erasing_other_fields() {
    let (root, mut store) = setup();
    let mut state = store.read().unwrap();
    state["UnknownMonitor"] = json!({"keep":true});
    store.write(&mut state, true).unwrap();
    let record = captured("first");
    let (snapshot, published) = store.ingest_clipboard(record.clone()).unwrap().unwrap();
    let published = published.unwrap();
    assert_eq!(published["Text"], "first");
    assert_eq!(snapshot.state["UnknownMonitor"], json!({"keep":true}));
    assert_eq!(store.read().unwrap()["ClipboardHistory"][0], published);
    let bytes = fs::read(store.path()).unwrap();
    assert!(store.ingest_clipboard(captured("first")).unwrap().is_none());
    assert_eq!(fs::read(store.path()).unwrap(), bytes);
    drop(store);
    let mut reopened = WorkspaceStore::open(root.0.clone()).unwrap();
    assert!(reopened.ingest_clipboard(record).unwrap().is_none());
}

#[test]
fn disabled_capture_and_failed_metadata_never_publish_and_same_record_can_retry() {
    let (_root, mut store) = setup();
    let mut state = store.read().unwrap();
    state["Settings"]["ClipboardMonitoringEnabled"] = json!(false);
    store.write(&mut state, true).unwrap();
    assert!(!store.clipboard_enabled().unwrap());
    let before = fs::read(store.path()).unwrap();
    let record = captured("retry exactly once");
    assert!(store.ingest_clipboard(record.clone()).unwrap().is_none());
    assert_eq!(fs::read(store.path()).unwrap(), before);
    state["Settings"]["ClipboardMonitoringEnabled"] = json!(true);
    store.write(&mut state, true).unwrap();
    let before = fs::read(store.path()).unwrap();
    fs::remove_file(store.backup()).unwrap();
    fs::create_dir(store.backup()).unwrap();
    assert!(store.ingest_clipboard(record.clone()).is_err());
    assert_eq!(fs::read(store.path()).unwrap(), before);
    fs::remove_dir(store.backup()).unwrap();
    let (_, published) = store.ingest_clipboard(record.clone()).unwrap().unwrap();
    assert_eq!(published.unwrap()["Id"], record["Id"]);
    assert_eq!(
        store.read().unwrap()["ClipboardHistory"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn protected_history_is_never_evicted_and_retention_matches_shared_electron_rule() {
    let (_root, mut store) = setup();
    let mut state = store.read().unwrap();
    let mut history = Vec::new();
    for index in 0..205 {
        let mut item = captured(&format!("old-{index}"));
        item["IsPinned"] = json!(index == 204);
        item["IsLocked"] = json!(index == 203);
        history.push(item);
    }
    state["ClipboardHistory"] = json!(history);
    store.write(&mut state, true).unwrap();
    store.ingest_clipboard(captured("newest")).unwrap();
    let state = store.read().unwrap();
    let history = state["ClipboardHistory"].as_array().unwrap();
    assert_eq!(history.len(), 200);
    assert_eq!(history[0]["Text"], "newest");
    assert!(history.iter().any(|item| item["Text"] == "old-204"));
    assert!(history.iter().any(|item| item["Text"] == "old-203"));
    assert!(!history.iter().any(|item| item["Text"] == "old-202"));
    let mut state = state;
    for item in state["ClipboardHistory"].as_array_mut().unwrap() {
        item["IsLocked"] = json!(true)
    }
    store.write(&mut state, true).unwrap();
    let (_, published) = store
        .ingest_clipboard(captured("not retained"))
        .unwrap()
        .unwrap();
    assert!(published.is_none());
    assert_eq!(
        store.read().unwrap()["ClipboardHistory"]
            .as_array()
            .unwrap()
            .len(),
        200
    );
}

#[test]
fn image_asset_commits_before_small_record_event_and_survives_save_failure_retry() {
    let (root, mut store) = setup();
    let image = image::DynamicImage::new_rgba8(2, 2);
    let png = encode_png(&image).unwrap();
    let record = record(ClipboardContent {
        text: String::new(),
        image_png_base64: STANDARD.encode(&png),
    })
    .unwrap()
    .unwrap();
    if store.backup().exists() {
        fs::remove_file(store.backup()).unwrap();
    }
    fs::create_dir(store.backup()).unwrap();
    let before = fs::read(store.path()).unwrap();
    assert!(store.ingest_clipboard(record.clone()).is_err());
    assert_eq!(fs::read(store.path()).unwrap(), before);
    fs::remove_dir(store.backup()).unwrap();
    let (snapshot, published) = store.ingest_clipboard(record).unwrap().unwrap();
    let published = published.unwrap();
    assert_eq!(published["ImagePngBase64"], "");
    assert_eq!(snapshot.state["ClipboardHistory"][0], published);
    let name = published["ImageAssetName"].as_str().unwrap();
    assert_eq!(
        fs::read(root.0.join("ClipboardImages").join(name)).unwrap(),
        png
    );
    assert!(!published["ImageFileName"].as_str().unwrap().contains(':'));
    assert_eq!(store.image(published["Id"].as_str().unwrap()).unwrap(), png);
}
