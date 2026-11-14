use super::*;
use serde_json::json;

#[cfg(windows)]
mod runtime_ownership;

#[cfg(windows)]
#[test]
fn replacement_failure_reports_delete_sharing_without_retrying_or_changing_either_file() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = TestRoot::new();
    fs::create_dir(&root.0).unwrap();
    let (source, target) = (root.0.join("incoming.tmp"), root.0.join("record.json"));
    fs::write(&source, b"incoming").unwrap();
    fs::write(&target, b"existing").unwrap();
    let reader = OpenOptions::new()
        .read(true)
        .share_mode(1 | 2)
        .open(&target)
        .unwrap();
    let error = replace_file(&source, &target).unwrap_err();
    assert!(
        error.contains("MoveFileExW") && error.contains("失败后即时采样"),
        "{error}"
    );
    assert!(
        error.contains("DELETE 访问探测=") && error.contains("os error 32"),
        "{error}"
    );
    assert!(error.contains("只读=false"), "{error}");
    assert_eq!(fs::read(&source).unwrap(), b"incoming");
    assert_eq!(fs::read(&target).unwrap(), b"existing");
    drop(reader);
    replace_file(&source, &target).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"incoming");
}

#[cfg(windows)]
#[test]
fn replacement_failure_reports_read_only_attribute_without_changing_permissions_or_decision() {
    let root = TestRoot::new();
    fs::create_dir(&root.0).unwrap();
    let (source, target) = (root.0.join("incoming.tmp"), root.0.join("record.json"));
    fs::write(&source, b"incoming").unwrap();
    fs::write(&target, b"existing").unwrap();
    let original = fs::metadata(&target).unwrap().permissions();
    let mut readonly = original.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&target, readonly).unwrap();
    let error = replace_file(&source, &target).unwrap_err();
    assert!(
        error.contains("os error 5") && error.contains("只读=true"),
        "{error}"
    );
    assert!(fs::metadata(&target).unwrap().permissions().readonly());
    assert_eq!(fs::read(&source).unwrap(), b"incoming");
    assert_eq!(fs::read(&target).unwrap(), b"existing");
    fs::set_permissions(&target, original).unwrap();
    replace_file(&source, &target).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"incoming");
}

struct TestRoot(PathBuf);
impl TestRoot {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("dustdesk-rust-workspace-{}", Uuid::new_v4())))
    }
    fn store(&self) -> WorkspaceStore {
        WorkspaceStore::open(self.0.clone()).unwrap()
    }
}
impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture() -> Value {
    normalize::normalize(json!({"SchemaVersion":3,"Settings":{"Theme":"light","UnknownSetting":[1,2]},"Todos":[{"Id":"task","Title":"task"}],"Notes":[{"Id":"note","Title":"note","Text":"original","UnknownNote":{"one":1}}],"Projects":[],"Launchers":[],"LinkGroups":[{"Id":"group","Name":"links","Links":[]}],"ClipboardHistory":[],"DesktopCategories":[],"TagPresets":[],"RecycleBin":[],"OrganizerRules":[],"FocusSessions":[],"ActiveFocus":null,"UnknownTop":{"value":"保留未知数据"}})).unwrap()
}

fn temporary_files(root: &TestRoot) -> Vec<PathBuf> {
    fs::read_dir(&root.0)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .contains("tauri-tmp")
        })
        .collect()
}

#[test]
fn lock_excludes_another_store_and_is_released_on_drop() {
    let root = TestRoot::new();
    let store = root.store();
    assert!(WorkspaceStore::open(root.0.clone())
        .err()
        .unwrap()
        .contains("另一个进程"));
    drop(store);
    assert!(WorkspaceStore::open(root.0.clone()).is_ok());
}

#[test]
fn valid_integer_settings_and_layout_do_not_rewrite_existing_electron_workspace_bytes() {
    let root = TestRoot::new();
    let mut state = fixture();
    state["Settings"]["BackupRetentionDays"] = json!(30);
    state["Settings"]["WidgetPlacements"] =
        json!({"todo":{"X":-1920,"Y":20,"Width":320,"Height":200,"Visible":false}});
    state["UnknownLargeInteger"] = json!(u64::MAX);
    assert_eq!(normalize::normalize(state.clone()).unwrap(), state);
    fs::create_dir_all(&root.0).unwrap();
    let original = format!("{}\n", serde_json::to_string_pretty(&state).unwrap());
    fs::write(root.0.join("workspace.json"), original.as_bytes()).unwrap();
    let mut store = root.store();
    assert_eq!(store.load("main").unwrap().state, state);
    assert_eq!(
        fs::read_to_string(root.0.join("workspace.json")).unwrap(),
        original
    );
    assert!(!root.0.join("workspace.json.bak").exists());
}

#[test]
fn numeric_normalization_still_clamps_rounds_and_keeps_unknown_large_integers_exact() {
    let mut state = fixture();
    state["Settings"]["BackupRetentionDays"] = json!(999.3);
    state["Settings"]["WidgetPlacements"] =
        json!({"todo":{"X":-2.5,"Y":-0.5,"Width":3.2,"Height":9007199254740993_u64}});
    state["UnknownLargeInteger"] = json!(u64::MAX);
    let normalized = normalize::normalize(state).unwrap();
    assert_eq!(
        normalized["Settings"]["BackupRetentionDays"].as_f64(),
        Some(365.0)
    );
    let placement = &normalized["Settings"]["WidgetPlacements"]["todo"];
    assert_eq!(placement["X"].as_f64(), Some(-2.0));
    assert_eq!(placement["Y"].as_f64(), Some(0.0));
    assert_eq!(placement["Width"].as_f64(), Some(3.0));
    assert_eq!(placement["Height"].as_f64(), Some(9_007_199_254_740_992.0));
    assert_eq!(normalized["UnknownLargeInteger"].as_u64(), Some(u64::MAX));
}

#[cfg(windows)]
#[test]
fn ownership_uses_native_directory_identity_and_keeps_distinct_workspaces_independent() {
    let root = TestRoot::new();
    let independent = TestRoot::new();
    let store = root.store();
    let other = independent.store();
    let uppercase = PathBuf::from(root.0.to_string_lossy().to_uppercase());
    assert!(WorkspaceStore::open(uppercase)
        .err()
        .unwrap()
        .contains("另一个进程"));
    drop(store);
    let reopened = root.store();
    drop(other);
    drop(reopened);
}

#[cfg(windows)]
#[test]
fn ownership_holds_directory_against_rename_until_store_is_dropped() {
    let root = TestRoot::new();
    let destination = TestRoot::new();
    let store = root.store();
    assert!(fs::rename(&root.0, &destination.0).is_err());
    assert!(root.0.is_dir());
    drop(store);
    fs::rename(&root.0, &destination.0).unwrap();
    assert!(!root.0.exists());
    let reopened = destination.store();
    drop(reopened);
}

#[test]
fn initialize_roundtrip_preserves_unknown_values_and_refuses_overwrite() {
    let root = TestRoot::new();
    let mut store = root.store();
    let original = fixture();
    assert!(store.load("main").is_err());
    let initial = store.initialize(original.clone(), "main").unwrap();
    assert_eq!(initial.revision, 1);
    assert_eq!(store.load("widget").unwrap().state, original);
    assert!(store.initialize(fixture(), "main").is_err());
    drop(store);
    assert_eq!(root.store().load("main").unwrap().state, original);
}

#[test]
fn concurrent_baselines_keep_independent_edits_and_background_additions() {
    let root = TestRoot::new();
    let mut store = root.store();
    let original = fixture();
    store.initialize(original.clone(), "main").unwrap();
    store.load("widget").unwrap();
    let mut first = original.clone();
    first["Notes"][0]["Title"] = json!("main-title");
    first["Todos"]
        .as_array_mut()
        .unwrap()
        .push(json!({"Id":"background","Title":"new task"}));
    store.save(first, None, "main").unwrap();
    let mut second = original.clone();
    second["Notes"][0]["Text"] = json!("widget-text");
    let snapshot = store.save(second, None, "widget").unwrap();
    assert_eq!(snapshot.state["Notes"][0]["Title"], "main-title");
    assert_eq!(snapshot.state["Notes"][0]["Text"], "widget-text");
    assert_eq!(snapshot.state["Todos"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot.state["UnknownTop"], original["UnknownTop"]);
    assert_eq!(snapshot.revision, 3);
    assert!(temporary_files(&root).is_empty());
}

#[test]
fn stale_edit_cannot_resurrect_deleted_records_or_overwrite_owned_state() {
    let root = TestRoot::new();
    let mut store = root.store();
    let mut original = fixture();
    original["OrganizerUndoStack"] = json!([{"Id":"native-owned"}]);
    store.initialize(original.clone(), "main").unwrap();
    let mut deletion = original.clone();
    deletion["Notes"] = json!([]);
    deletion["FocusSessions"] =
        json!([{"Id":"forged","TaskTitle":"fake","ProjectName":"fake","Seconds":1}]);
    deletion["OrganizerUndoStack"] = json!([]);
    let deleted = store
        .save(deletion, Some(original.clone()), "main")
        .unwrap();
    assert_eq!(deleted.state["RecycleBin"].as_array().unwrap().len(), 1);
    assert_eq!(
        deleted.state["RecycleBin"][0]["value"],
        original["Notes"][0]
    );
    assert_eq!(deleted.state["FocusSessions"], json!([]));
    assert_eq!(
        deleted.state["OrganizerUndoStack"],
        original["OrganizerUndoStack"]
    );
    let mut stale = original.clone();
    stale["Notes"][0]["Text"] = json!("late draft");
    let saved = store.save(stale, Some(original), "widget").unwrap();
    assert_eq!(saved.state["Notes"], json!([]));
    assert_eq!(saved.state["RecycleBin"].as_array().unwrap().len(), 1);
}

#[test]
fn backup_recovery_never_overwrites_good_backup_with_corruption() {
    let root = TestRoot::new();
    let mut store = root.store();
    let original = fixture();
    store.initialize(original.clone(), "main").unwrap();
    let mut next = original.clone();
    next["QuickNote"] = json!("next");
    store.save(next, Some(original.clone()), "main").unwrap();
    fs::write(store.path(), b"{broken").unwrap();
    assert_eq!(store.load("main").unwrap().state, original);
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(store.backup()).unwrap()).unwrap(),
        original
    );
    assert!(temporary_files(&root).is_empty());
}

#[test]
fn newer_schemas_are_never_downgraded_from_backup() {
    for version in [json!(4), json!(999), json!(4.5)] {
        let root = TestRoot::new();
        let mut store = root.store();
        let original = fixture();
        store.initialize(original.clone(), "main").unwrap();
        fs::write(store.backup(), serde_json::to_vec(&original).unwrap()).unwrap();
        let mut protected = original;
        protected["SchemaVersion"] = version;
        let bytes = serde_json::to_vec(&protected).unwrap();
        fs::write(store.path(), &bytes).unwrap();
        assert!(store.load("main").is_err());
        assert_eq!(fs::read(store.path()).unwrap(), bytes);
    }
}

#[test]
fn legacy_records_receive_ids_defaults_and_keep_original_recovery_data() {
    let root = TestRoot::new();
    let mut store = root.store();
    let mut legacy = fixture();
    legacy["SchemaVersion"] = json!(1);
    legacy["Notes"][0].as_object_mut().unwrap().remove("Id");
    legacy["Todos"][0].as_object_mut().unwrap().remove("Id");
    legacy["Settings"] = json!({"SidebarHidden":[],"BackupRetentionDays":999,"WidgetPlacements":{"todo":{"X":-2.5,"Visible":true},"unknown":{"Visible":true}}});
    let bytes = serde_json::to_vec(&legacy).unwrap();
    fs::write(store.path(), &bytes).unwrap();
    let migrated = store.load("main").unwrap();
    assert_eq!(migrated.state["SchemaVersion"], 3);
    assert_eq!(migrated.state["Notes"][0]["Text"], "original");
    assert!(Uuid::parse_str(migrated.state["Notes"][0]["Id"].as_str().unwrap()).is_ok());
    assert_eq!(migrated.state["Settings"]["SidebarHidden"], json!([]));
    assert_eq!(
        migrated.state["Settings"]["BackupRetentionDays"].as_f64(),
        Some(365.0)
    );
    assert_eq!(
        migrated.state["Settings"]["WidgetPlacements"]["todo"]["X"].as_f64(),
        Some(-2.0)
    );
    assert!(migrated.state["Settings"]["WidgetPlacements"]
        .get("unknown")
        .is_none());
    assert_eq!(fs::read(store.backup()).unwrap(), bytes);
    assert_eq!(store.load("main").unwrap().state, migrated.state);
    assert_eq!(store.load("main").unwrap().revision, migrated.revision);
}

#[test]
fn layout_normalization_keeps_unknown_fields_and_removes_invalid_known_values() {
    let root = TestRoot::new();
    let mut store = root.store();
    let mut state = fixture();
    let extensions = json!({"future":{"nested":["保留",42]},"FutureFlag":true,"Visible":"invalid","Width":"invalid","DockEdge":"invalid","X":-3.5});
    state["Settings"]["WidgetPlacements"] = json!({"todo":extensions});
    state["Settings"]["WidgetLayoutPresets"] = json!({"future-layout":{"todo":extensions}});
    state["Settings"]["NoteWidgetPlacements"] =
        json!([{"NoteId":"note","FutureNoteSetting":{"alpha":7},"X":3.5}]);
    let saved = store.initialize(state, "main").unwrap();
    let placement = &saved.state["Settings"]["WidgetPlacements"]["todo"];
    assert_eq!(
        placement,
        &json!({"future":{"nested":["保留",42]},"FutureFlag":true,"X":-3.0})
    );
    assert_eq!(
        saved.state["Settings"]["WidgetLayoutPresets"]["future-layout"]["todo"],
        *placement
    );
    assert_eq!(
        saved.state["Settings"]["NoteWidgetPlacements"][0]["FutureNoteSetting"],
        json!({"alpha":7})
    );
    assert_eq!(store.load("main").unwrap().state, saved.state);
}

#[test]
fn date_only_recycle_expiration_is_preserved_until_its_utc_deadline() {
    let root = TestRoot::new();
    let mut store = root.store();
    let mut state = fixture();
    state["RecycleBin"] = json!([
        {"Id":"future","kind":"note","value":state["Notes"][0],"DeletedAt":"2026-01-01","ExpiresAt":"2099-12-31"},
        {"Id":"expired","kind":"note","value":state["Notes"][0],"DeletedAt":"2000-01-01","ExpiresAt":"2000-02-01"}
    ]);
    let initial = store.initialize(state, "main").unwrap();
    let saved = store
        .save(initial.state.clone(), Some(initial.state.clone()), "main")
        .unwrap();
    assert_eq!(
        saved.state["RecycleBin"],
        json!([initial.state["RecycleBin"][0]])
    );
    assert_eq!(
        validation::parse_date(&json!("2099-12-31"))
            .unwrap()
            .to_rfc3339(),
        "2099-12-31T00:00:00+00:00"
    );
}

#[test]
fn inline_images_deduplicate_and_retained_assets_survive_history_deletion() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let root = TestRoot::new();
    let mut store = root.store();
    let mut state = fixture();
    let bytes = b"same-image-payload";
    state["ClipboardHistory"] = json!([{"Id":"image-one","Kind":"Image","Text":"","ImagePngBase64":STANDARD.encode(bytes)},{"Id":"image-two","Kind":"Image","Text":"","ImagePngBase64":STANDARD.encode(bytes)}]);
    let saved = store.initialize(state, "main").unwrap();
    let first = &saved.state["ClipboardHistory"][0];
    assert_eq!(first["ImagePngBase64"], "");
    assert_eq!(
        first["ImageAssetName"],
        saved.state["ClipboardHistory"][1]["ImageAssetName"]
    );
    assert_eq!(store.image("image-one").unwrap(), bytes);
    let asset = root
        .0
        .join("ClipboardImages")
        .join(first["ImageAssetName"].as_str().unwrap());
    assert_eq!(
        fs::read_dir(root.0.join("ClipboardImages"))
            .unwrap()
            .count(),
        1
    );
    let mut next = saved.state.clone();
    next["ClipboardHistory"] = json!([]);
    store.save(next, Some(saved.state), "main").unwrap();
    assert_eq!(fs::read(asset).unwrap(), bytes);
}

#[test]
fn asset_corruption_and_failed_asset_writes_never_clear_inline_recovery() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let root = TestRoot::new();
    let mut store = root.store();
    let original = fixture();
    store.initialize(original.clone(), "main").unwrap();
    let before = fs::read(store.path()).unwrap();
    let mut incoming = original.clone();
    incoming["ClipboardHistory"] = json!([{"Id":"image","Kind":"Image","Text":"","ImagePngBase64":STANDARD.encode(b"payload")}]);
    fs::write(root.0.join("ClipboardImages"), b"blocked-directory").unwrap();
    assert!(store
        .save(incoming.clone(), Some(original.clone()), "main")
        .is_err());
    assert_eq!(fs::read(store.path()).unwrap(), before);
    assert!(temporary_files(&root).is_empty());
    fs::remove_file(root.0.join("ClipboardImages")).unwrap();
    let saved = store.save(incoming, Some(original), "main").unwrap();
    let asset = root.0.join("ClipboardImages").join(
        saved.state["ClipboardHistory"][0]["ImageAssetName"]
            .as_str()
            .unwrap(),
    );
    fs::write(&asset, b"corrupted").unwrap();
    assert!(store.image("image").unwrap_err().contains("损坏"));
    fs::remove_file(asset).unwrap();
    assert!(store.image("image").is_err());
    assert_eq!(
        store.load("main").unwrap().state["ClipboardHistory"][0]["Id"],
        "image"
    );
}

#[test]
fn malformed_legacy_collections_are_not_silently_replaced() {
    let root = TestRoot::new();
    let mut store = root.store();
    let mut damaged = fixture();
    damaged["SchemaVersion"] = json!(1);
    damaged.as_object_mut().unwrap().remove("Notes");
    let bytes = serde_json::to_vec(&damaged).unwrap();
    fs::write(store.path(), &bytes).unwrap();
    assert!(store.load("main").is_err());
    assert_eq!(fs::read(store.path()).unwrap(), bytes);
}
#[test]
fn missing_or_damaged_data_never_creates_an_empty_replacement() {
    let root = TestRoot::new();
    let mut store = root.store();
    store.initialize(fixture(), "main").unwrap();
    fs::remove_file(store.path()).unwrap();
    assert!(store.load("main").unwrap_err().contains("已丢失"));
    assert!(store.initialize(fixture(), "main").is_err());
    fs::write(store.path(), b"broken-current").unwrap();
    fs::write(store.backup(), b"broken-backup").unwrap();
    assert!(store.load("main").is_err());
    assert_eq!(fs::read(store.path()).unwrap(), b"broken-current");
    assert_eq!(fs::read(store.backup()).unwrap(), b"broken-backup");
}

#[test]
fn failed_backup_keeps_current_data_and_cleans_temporary_files_then_retries() {
    let root = TestRoot::new();
    let mut store = root.store();
    let original = fixture();
    store.initialize(original.clone(), "main").unwrap();
    let before = fs::read(store.path()).unwrap();
    fs::create_dir(store.backup()).unwrap();
    let mut next = original.clone();
    next["QuickNote"] = json!("retry");
    assert!(store
        .save(next.clone(), Some(original.clone()), "main")
        .is_err());
    assert_eq!(fs::read(store.path()).unwrap(), before);
    assert!(temporary_files(&root).is_empty());
    fs::remove_dir(store.backup()).unwrap();
    assert_eq!(
        store.save(next, Some(original), "main").unwrap().state["QuickNote"],
        "retry"
    );
}

#[cfg(windows)]
#[test]
fn sharing_failure_cannot_fall_back_to_an_older_backup() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = TestRoot::new();
    let mut store = root.store();
    let original = fixture();
    store.initialize(original.clone(), "main").unwrap();
    let mut next = original.clone();
    next["QuickNote"] = json!("latest");
    store.save(next, Some(original), "main").unwrap();
    let held = OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(store.path())
        .unwrap();
    assert!(store.load("main").is_err());
    drop(held);
    assert_eq!(store.load("main").unwrap().state["QuickNote"], "latest");
}

#[test]
fn malformed_and_duplicate_records_leave_both_files_untouched() {
    let root = TestRoot::new();
    let mut store = root.store();
    let original = fixture();
    store.initialize(original.clone(), "main").unwrap();
    let mut duplicate = original.clone();
    duplicate["Notes"]
        .as_array_mut()
        .unwrap()
        .push(original["Notes"][0].clone());
    assert!(store.save(duplicate, None, "main").is_err());
    let mut missing = original.clone();
    missing.as_object_mut().unwrap().remove("Todos");
    assert!(store.save(missing, None, "main").is_err());
    let mut links = original.clone();
    links["LinkGroups"] = json!([{"Id":"one","Name":"one","Links":[{"Id":"same","Name":"one","Url":"https://example.com"}]},{"Id":"two","Name":"two","Links":[{"Id":"same","Name":"two","Url":"https://example.com"}]}]);
    assert!(store.save(links, None, "main").is_err());
    assert_eq!(store.load("main").unwrap().state, original);
    assert!(!store.backup().exists());
}

#[test]
fn failed_atomic_actions_keep_files_unchanged_and_retries_do_not_duplicate_capture() {
    let root = TestRoot::new();
    let mut store = root.store();
    store.initialize(fixture(), "main").unwrap();
    let before = fs::read(store.path()).unwrap();
    fs::create_dir(store.backup()).unwrap();
    let action = json!({"type":"capture","kind":"task","title":"stable","text":"","requestId":"stable-request"});
    assert!(store.productivity_action(action.clone()).is_err());
    assert_eq!(fs::read(store.path()).unwrap(), before);
    fs::remove_dir(store.backup()).unwrap();
    let first = store.productivity_action(action.clone()).unwrap();
    let retry = store.productivity_action(action).unwrap();
    assert_eq!(first.state, retry.state);
    let note = retry.state["Notes"][0].clone();
    let before = fs::read(store.path()).unwrap();
    let invalid = json!({"type":"note-edit","id":note["Id"],"previousTitle":note["Title"],"previousText":note["Text"],"title":"must-not-partially-save","text":"😀".repeat(100001)});
    assert!(store.productivity_action(invalid).is_err());
    assert_eq!(fs::read(store.path()).unwrap(), before);
    assert!(store
        .productivity_action(json!({"type":"unknown"}))
        .is_err());
    assert_eq!(fs::read(store.path()).unwrap(), before);
}

#[test]
fn restart_focus_checkpoint_waits_for_a_successful_write_before_marking_recovery_complete() {
    let root = TestRoot::new();
    let mut store = root.store();
    let mut state = fixture();
    let now = Utc::now();
    productivity::apply(
        &mut state,
        productivity::Action::FocusStart {
            task_id: "".into(),
            project_id: "".into(),
            minutes: 1.0,
        },
        now - chrono::Duration::seconds(10),
    )
    .unwrap();
    state["ActiveFocus"]["CheckpointAt"] =
        json!(productivity::time(now - chrono::Duration::seconds(5)));
    store.initialize(state, "main").unwrap();
    let before = fs::read(store.path()).unwrap();
    fs::create_dir(store.backup()).unwrap();
    assert!(store.ensure_productivity().is_err());
    assert!(!store.productivity_ready);
    assert_eq!(fs::read(store.path()).unwrap(), before);
    fs::remove_dir(store.backup()).unwrap();
    let recovered = store.ensure_productivity().unwrap().unwrap();
    assert_eq!(recovered.state["ActiveFocus"]["ElapsedSeconds"], 5.0);
    assert!(recovered.state["ActiveFocus"]["RunningSince"].is_null());
    assert!(store.ensure_productivity().unwrap().is_none());
    store
        .productivity_action(json!({"type":"focus-resume"}))
        .unwrap();
    assert!(
        store.stop_productivity().unwrap().unwrap().state["ActiveFocus"]["RunningSince"].is_null()
    );
    assert!(store.stop_productivity().unwrap().is_none());
}

#[test]
fn failed_background_completion_retries_without_losing_or_duplicating_the_focus_session() {
    let root = TestRoot::new();
    let mut store = root.store();
    store.initialize(fixture(), "main").unwrap();
    let mut state = store
        .productivity_action(json!({"type":"focus-start","taskId":"","projectId":"","minutes":1}))
        .unwrap()
        .state;
    let now = Utc::now();
    state["ActiveFocus"]["RunningSince"] =
        json!(productivity::time(now - chrono::Duration::seconds(61)));
    state["ActiveFocus"]["CheckpointAt"] = json!(productivity::time(now));
    let before = serde_json::to_vec(&state).unwrap();
    fs::write(store.path(), &before).unwrap();
    fs::remove_file(store.backup()).unwrap();
    fs::create_dir(store.backup()).unwrap();
    assert!(store.productivity_tick().is_err());
    assert_eq!(fs::read(store.path()).unwrap(), before);
    fs::remove_dir(store.backup()).unwrap();
    let (snapshot, notifications) = store.productivity_tick().unwrap();
    let completed = snapshot.unwrap();
    assert!(completed.state["ActiveFocus"].is_null());
    assert_eq!(
        completed.state["FocusSessions"].as_array().unwrap().len(),
        1
    );
    assert_eq!(notifications.len(), 1);
    assert_eq!(notifications[0].title, "专注完成");
    let (snapshot, notifications) = store.productivity_tick().unwrap();
    assert!(snapshot.is_none());
    assert!(notifications.is_empty());
}

#[test]
fn failed_reminder_save_retains_due_tasks_and_retry_returns_notifications_only_once() {
    let root = TestRoot::new();
    let mut store = root.store();
    let mut state = fixture();
    state["Todos"][0]["ReminderAt"] = json!("2026-01-01T00:00:00.000Z");
    store.initialize(state, "main").unwrap();
    let before = fs::read(store.path()).unwrap();
    fs::create_dir(store.backup()).unwrap();
    assert!(store.productivity_tick().is_err());
    assert_eq!(fs::read(store.path()).unwrap(), before);
    fs::remove_dir(store.backup()).unwrap();
    let (snapshot, notifications) = store.productivity_tick().unwrap();
    assert_eq!(notifications.len(), 1);
    assert_eq!(notifications[0].body, "task");
    assert!(snapshot.unwrap().state["Todos"][0]["ReminderNotifiedAt"].is_string());
    let (snapshot, notifications) = store.productivity_tick().unwrap();
    assert!(snapshot.is_none());
    assert!(notifications.is_empty());
    drop(store);
    assert!(root.store().productivity_tick().unwrap().1.is_empty());
}
