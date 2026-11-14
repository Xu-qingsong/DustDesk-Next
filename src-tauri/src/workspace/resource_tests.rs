use super::{
    normalize,
    resources::{self, ResourceHealth},
};
use chrono::{TimeZone, Utc};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use uuid::Uuid;

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("dustdesk-resources-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("DesktopOrganizer/分类_A")).unwrap();
        Self(root)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn fixture() -> Value {
    let mut state = normalize::default_state();
    state["Launchers"] =
        json!([{"Id":"launcher","Name":"Launcher","Path":"old.exe","Unknown":{"keep":true}}]);
    state["Projects"] = json!([{"Id":"project","Name":"Project","ProjectPath":"old-project","Phases":[{"Id":"phase","Title":"Phase","ProjectPath":"old-phase","Subtasks":[{"Id":"subtask","Title":"Task","FilePath":"old-task","Unknown":[1,2]}]}]}]);
    state["DesktopCategories"] =
        json!([{"Id":"category","Name":"分类:A","ItemPaths":["old-organizer"]}]);
    state["LinkGroups"] = json!([{"Id":"group","Name":"Links","Links":[{"Id":"link","Name":"Site","Url":"http://localhost/old","UpdatedAt":"old","Unknown":99}]}]);
    state
}
fn selected(state: &Value, kind: &str) -> ResourceHealth {
    resources::collect(state)
        .into_iter()
        .find(|item| item.kind == kind)
        .unwrap()
}

#[test]
fn enumerates_all_six_resource_kinds_in_electron_order_without_optional_parent_nulls() {
    let state = fixture();
    let available = resources::collect(&state);
    assert_eq!(
        available
            .iter()
            .map(|item| item.kind.as_str())
            .collect::<Vec<_>>(),
        vec![
            "launcher",
            "project",
            "phase",
            "subtask",
            "organizer",
            "link"
        ]
    );
    assert_eq!(available[2].parent_id.as_deref(), Some("project"));
    assert_eq!(available[3].parent_id.as_deref(), Some("phase"));
    assert_eq!(available[3].name, "Project / Task");
    assert_eq!(available[4].id, "old-organizer");
    assert!(serde_json::to_value(&available[0])
        .unwrap()
        .get("parentId")
        .is_none());
    let mut empty = state;
    empty["Launchers"][0]["Path"] = json!("");
    assert_eq!(resources::collect(&empty).len(), 5);
}

#[test]
fn reference_identity_ignores_display_status_but_not_parent_target_or_kind() {
    let state = fixture();
    let original = selected(&state, "link");
    let mut changed = original.clone();
    changed.name = "new display".into();
    changed.status = "warning".into();
    changed.detail = "offline".into();
    assert!(changed.same_reference(&original));
    changed.parent_id = Some("other".into());
    assert!(!changed.same_reference(&original));
    changed = original.clone();
    changed.target.push_str("/changed");
    assert!(!changed.same_reference(&original));
    changed = original.clone();
    changed.kind = "launcher".into();
    assert!(!changed.same_reference(&original));
}

#[test]
fn explicit_null_parent_cannot_impersonate_an_absent_reference_field() {
    let original = selected(&fixture(), "launcher");
    let mut payload = serde_json::to_value(original).unwrap();
    assert!(serde_json::from_value::<ResourceHealth>(payload.clone()).is_ok());
    payload["parentId"] = Value::Null;
    assert!(serde_json::from_value::<ResourceHealth>(payload).is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn cancelling_a_queued_filesystem_probe_does_not_leak_a_slot_or_start_an_extra_worker() {
    use std::{sync::Arc, time::Duration};
    use tokio::sync::Semaphore;
    let root = Root::new();
    let slots = Arc::new(Semaphore::new(4));
    let running = slots.clone().acquire_many_owned(4).await.unwrap();
    let queued = resources::probe_path(root.0.display().to_string(), slots.clone());
    assert!(tokio::time::timeout(Duration::from_millis(20), queued)
        .await
        .is_err());
    assert_eq!(slots.available_permits(), 0);
    drop(running);
    resources::probe_path(root.0.display().to_string(), slots.clone())
        .await
        .unwrap();
    assert_eq!(slots.available_permits(), 4);
}

#[test]
fn only_explicit_http_and_https_urls_are_accepted_without_auto_upgrading_http() {
    for value in [
        "http://localhost:123/path",
        "HTTP://intranet/path",
        "https://example.com",
        "  http://127.0.0.1/  ",
        "http://[::1]/",
    ] {
        assert!(resources::http_url(value).is_some(), "{value}");
    }
    for value in [
        "localhost/test",
        "//example.com",
        "http:example.com",
        "https://",
        "javascript:alert(1)",
        "file:///C:/file",
        "ftp://example.com",
    ] {
        assert!(resources::http_url(value).is_none(), "{value}");
    }
    assert_eq!(
        resources::http_url("http://localhost/path")
            .unwrap()
            .scheme(),
        "http"
    );
}

#[test]
fn relinks_nested_records_preserving_unknown_fields_and_timestamping_only_links() {
    let root = Root::new();
    let mut state = fixture();
    let stamp = Utc.with_ymd_and_hms(2026, 11, 9, 0, 0, 0).unwrap();
    for kind in ["launcher", "project", "phase", "subtask", "link"] {
        let resource = selected(&state, kind);
        let replacement = if kind == "link" {
            "http://localhost/new"
        } else {
            "new-path"
        };
        resources::relink(&root.0, &mut state, &resource, replacement, stamp).unwrap();
        assert_eq!(selected(&state, kind).target, replacement);
        let before = state.clone();
        assert!(resources::relink(
            &root.0,
            &mut state,
            &resource,
            "http://localhost/retry",
            stamp
        )
        .unwrap_err()
        .contains("资源已变化"));
        assert_eq!(state, before);
    }
    assert_eq!(state["Launchers"][0]["Unknown"], json!({"keep":true}));
    assert_eq!(
        state["Projects"][0]["Phases"][0]["Subtasks"][0]["Unknown"],
        json!([1, 2])
    );
    assert_eq!(state["LinkGroups"][0]["Links"][0]["Unknown"], 99);
    assert_eq!(
        state["LinkGroups"][0]["Links"][0]["UpdatedAt"],
        "2026-11-09T00:00:00.000Z"
    );
}

#[test]
fn rejects_empty_oversized_stale_and_unsafe_link_inputs_without_mutation() {
    let root = Root::new();
    let mut state = fixture();
    let before = state.clone();
    let link = selected(&state, "link");
    for replacement in [
        "".into(),
        "\u{feff}   ".into(),
        "😀".repeat(2049),
        "javascript:alert(1)".into(),
    ] {
        assert!(resources::relink(&root.0, &mut state, &link, &replacement, Utc::now()).is_err());
        assert_eq!(state, before);
    }
    let mut stale = link;
    stale.parent_id = Some("forged".into());
    assert!(resources::relink(
        &root.0,
        &mut state,
        &stale,
        "https://example.com",
        Utc::now()
    )
    .is_err());
    assert_eq!(state, before);
}

#[test]
fn organizer_relinks_only_unowned_items_inside_the_original_sanitized_category() {
    let root = Root::new();
    let mut state = fixture();
    let category_root = root.0.join("DesktopOrganizer/分类_A");
    let target = category_root.join("新文件.txt");
    fs::write(&target, b"payload").unwrap();
    let resource = selected(&state, "organizer");
    let before = state.clone();
    let outside = root.0.join("outside.txt");
    fs::write(&outside, b"outside").unwrap();
    assert!(resources::relink(
        &root.0,
        &mut state,
        &resource,
        outside.to_str().unwrap(),
        Utc::now()
    )
    .is_err());
    assert!(resources::relink(
        &root.0,
        &mut state,
        &resource,
        category_root.to_str().unwrap(),
        Utc::now()
    )
    .is_err());
    assert_eq!(state, before);
    state["DesktopCategories"].as_array_mut().unwrap().push(json!({"Id":"other","Name":"Other","ItemPaths":[target.display().to_string().to_uppercase()]}));
    let occupied = state.clone();
    assert!(resources::relink(
        &root.0,
        &mut state,
        &resource,
        target.to_str().unwrap(),
        Utc::now()
    )
    .unwrap_err()
    .contains("已被收纳记录关联"));
    assert_eq!(state, occupied);
    state["DesktopCategories"].as_array_mut().unwrap().pop();
    resources::relink(
        &root.0,
        &mut state,
        &resource,
        target.to_str().unwrap(),
        Utc::now(),
    )
    .unwrap();
    assert_eq!(
        state["DesktopCategories"][0]["ItemPaths"][0],
        target.display().to_string()
    );
    assert_eq!(fs::read(&target).unwrap(), b"payload");
    assert_eq!(fs::read(outside).unwrap(), b"outside");
}
