use super::{normalize, note_images, WorkspaceStore};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn setup() -> (Root, WorkspaceStore, String, PathBuf) {
    let root = Root(std::env::temp_dir().join(format!("dustdesk-note-image-{}", Uuid::new_v4())));
    let mut store = WorkspaceStore::open(root.0.clone()).unwrap();
    let mut state = normalize::default_state();
    state["Settings"]["AutomaticBackupEnabled"] = json!(false);
    state["Notes"][0]["UnknownImageTest"] = json!({"keep":[1,2]});
    let id = state["Notes"][0]["Id"].as_str().unwrap().to_owned();
    store.initialize(state, "main").unwrap();
    let source = root.0.join("源图片.PNG");
    fs::write(&source, b"source-image-bytes").unwrap();
    (root, store, id, source)
}
fn files(root: &Root) -> Vec<PathBuf> {
    let mut output: Vec<_> = fs::read_dir(root.0.join("NoteBackgrounds"))
        .into_iter()
        .flatten()
        .map(|entry| entry.unwrap().path())
        .collect();
    output.sort();
    output
}
fn image(source: &Path) -> note_images::ImageSource {
    note_images::read_source(source.to_str().unwrap()).unwrap()
}

#[test]
fn import_copies_exact_bytes_preserves_unknown_fields_and_clear_keeps_the_recovery_reference() {
    let (root, mut store, id, source) = setup();
    let (snapshot, reply) = store
        .import_note_image(&id, image(&source), Some(None))
        .unwrap();
    let path = reply["path"].as_str().unwrap();
    assert!(reply["fileName"].as_str().unwrap().starts_with("note-"));
    assert!(path.ends_with(".png"));
    assert_eq!(
        reply["dataUrl"],
        format!(
            "data:image/png;base64,{}",
            STANDARD.encode(b"source-image-bytes")
        )
    );
    assert_eq!(fs::read(path).unwrap(), fs::read(&source).unwrap());
    assert_eq!(
        snapshot.state["Notes"][0]["UnknownImageTest"],
        json!({"keep":[1,2]})
    );
    assert_eq!(snapshot.state["Notes"][0]["BackgroundImagePath"], path);
    assert!(store.read_note_image(path).is_ok());
    let cleared = store
        .clear_note_image(&id, Some(Some(path.into())))
        .unwrap();
    assert!(cleared.state["Notes"][0]["BackgroundImagePath"].is_null());
    assert_eq!(cleared.state["Notes"][0]["BackgroundImageFileName"], "");
    assert_eq!(cleared.state["Notes"][0]["ImageOnly"], false);
    assert_eq!(fs::read(path).unwrap(), b"source-image-bytes");
    assert!(store.read_note_image(path).is_err());
    let recovery: Value =
        serde_json::from_slice(&fs::read(root.0.join("workspace.json.bak")).unwrap()).unwrap();
    assert_eq!(recovery["Notes"][0]["BackgroundImagePath"], path);
    assert_eq!(fs::read(source).unwrap(), b"source-image-bytes");
}

#[test]
fn omitted_expected_path_does_not_mean_explicit_empty_and_stale_or_deleted_notes_never_publish() {
    let (root, mut store, id, source) = setup();
    let (_, first) = store
        .import_note_image(&id, image(&source), Some(None))
        .unwrap();
    let before = fs::read(root.0.join("workspace.json")).unwrap();
    let original_files = files(&root);
    assert!(store
        .import_note_image(&id, image(&source), Some(None))
        .err()
        .unwrap()
        .contains("其他窗口"));
    assert!(store
        .clear_note_image(&id, Some(None))
        .unwrap_err()
        .contains("其他窗口"));
    assert!(store
        .import_note_image("deleted", image(&source), None)
        .err()
        .unwrap()
        .contains("便签不存在"));
    assert_eq!(fs::read(root.0.join("workspace.json")).unwrap(), before);
    assert_eq!(files(&root), original_files);
    let (_, second) = store.import_note_image(&id, image(&source), None).unwrap();
    assert_ne!(first["path"], second["path"]);
    assert!(PathBuf::from(first["path"].as_str().unwrap()).exists());
}

#[test]
fn metadata_failure_removes_only_new_assets_and_clear_failure_retains_current_background() {
    let (root, mut store, id, source) = setup();
    let (_, reply) = store.import_note_image(&id, image(&source), None).unwrap();
    let original_files = files(&root);
    let before = fs::read(root.0.join("workspace.json")).unwrap();
    fs::remove_file(root.0.join("workspace.json.bak")).unwrap();
    fs::create_dir(root.0.join("workspace.json.bak")).unwrap();
    assert!(store.import_note_image(&id, image(&source), None).is_err());
    assert!(store.clear_note_image(&id, None).is_err());
    assert_eq!(files(&root), original_files);
    assert_eq!(fs::read(root.0.join("workspace.json")).unwrap(), before);
    assert_eq!(
        fs::read(reply["path"].as_str().unwrap()).unwrap(),
        b"source-image-bytes"
    );
    assert_eq!(fs::read(source).unwrap(), b"source-image-bytes");
}

#[test]
fn blocked_asset_directory_cannot_commit_background_metadata() {
    let (root, mut store, id, source) = setup();
    let before = fs::read(root.0.join("workspace.json")).unwrap();
    fs::write(root.0.join("NoteBackgrounds"), b"blocked").unwrap();
    assert!(store.import_note_image(&id, image(&source), None).is_err());
    assert_eq!(fs::read(root.0.join("workspace.json")).unwrap(), before);
    assert_eq!(
        fs::read(root.0.join("NoteBackgrounds")).unwrap(),
        b"blocked"
    );
}

#[test]
fn source_validation_is_bounded_and_accepts_all_legacy_extensions_without_transcoding() {
    let (root, _store, _id, _source) = setup();
    for extension in ["png", "jpg", "jpeg", "webp", "gif", "bmp"] {
        let path = root.0.join(format!("test.{extension}"));
        fs::write(&path, b"preserved-original-bytes").unwrap();
        let image = image(&path);
        assert_eq!(image.extension, extension);
        assert_eq!(image.bytes, b"preserved-original-bytes");
    }
    let empty = root.0.join("empty.png");
    fs::write(&empty, b"").unwrap();
    let large = root.0.join("large.png");
    fs::File::create(&large)
        .unwrap()
        .set_len(note_images::MAX_BYTES + 1)
        .unwrap();
    let directory = root.0.join("directory.png");
    fs::create_dir(&directory).unwrap();
    let invalid = root.0.join("invalid.svg");
    fs::write(&invalid, b"<svg/>").unwrap();
    for path in [empty, large, directory, invalid] {
        assert!(note_images::read_source(path.to_str().unwrap()).is_err());
    }
    assert!(note_images::read_source("\u{feff}   ").is_err());
    assert!(note_images::read_source("bad\0.png").is_err());
}

#[test]
fn clearing_live_note_never_deletes_shared_recycled_background_bytes() {
    let (root, mut store, id, source) = setup();
    let (snapshot, reply) = store.import_note_image(&id, image(&source), None).unwrap();
    let mut state = snapshot.state;
    let mut note = state["Notes"][0].clone();
    note["Id"] = json!("recycled-note");
    state["RecycleBin"] = json!([{"Id":"recycled-entry","kind":"note","value":note,"DeletedAt":"2026-11-09T00:00:00Z","ExpiresAt":"2099-01-01T00:00:00Z"}]);
    store.write(&mut state, true).unwrap();
    store.clear_note_image(&id, None).unwrap();
    let path = reply["path"].as_str().unwrap();
    assert_eq!(fs::read(path).unwrap(), b"source-image-bytes");
    assert!(store.read_note_image(path).is_ok());
    assert_eq!(files(&root).len(), 1);
}
