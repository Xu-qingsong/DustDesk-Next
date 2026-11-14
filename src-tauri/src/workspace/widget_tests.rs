use super::*;
use std::fs;
use uuid::Uuid;
struct Root(std::path::PathBuf);

#[test]
fn widget_resources_are_exact_current_business_references_without_inheriting_main_grants() {
    let (_root, mut store) = setup();
    let mut state = store.read().unwrap();
    state["Launchers"] = json!([{"Path":"C:/Allowed/启动.exe"}]);
    state["DesktopCategories"] = json!([{"Id":"first","ItemPaths":["C:/Allowed/one.txt"]},{"Id":"other","ItemPaths":["C:/Private/other.txt"]}]);
    state["LinkGroups"] = json!([{"Links":[{"Url":"http://127.0.0.1:45892/allowed"}]}]);
    state["Notes"] = json!([{"Id":"first","BackgroundImagePath":"C:/Notes/first.png"},{"Id":"other","BackgroundImagePath":"C:/Notes/other.png"}]);
    assert!(permits_resource(
        &state,
        "launcher",
        "c:/allowed/启动.exe",
        false
    ));
    assert!(!permits_resource(&state, "launcher", "C:/Allowed", false));
    assert!(!permits_resource(
        &state,
        "todo",
        "C:/Allowed/启动.exe",
        false
    ));
    assert!(permits_resource(
        &state,
        "organizer-group:first",
        "C:/Allowed/one.txt",
        false
    ));
    assert!(!permits_resource(
        &state,
        "organizer-group:first",
        "C:/Private/other.txt",
        false
    ));
    assert!(permits_resource(
        &state,
        "organizer",
        "C:/Private/other.txt",
        false
    ));
    assert!(permits_resource(
        &state,
        "links",
        "http://127.0.0.1:45892/allowed",
        true
    ));
    assert!(!permits_resource(
        &state,
        "links",
        "http://127.0.0.1:45892/foreign",
        true
    ));
    assert!(!permits_resource(
        &state,
        "launcher",
        "http://127.0.0.1:45892/allowed",
        true
    ));
    assert!(permits_note_image(
        &state,
        "note:first",
        "C:/Notes/first.png"
    ));
    assert!(!permits_note_image(
        &state,
        "note:first",
        "C:/Notes/other.png"
    ));
    assert!(!permits_note_image(
        &state,
        "clipboard",
        "C:/Notes/first.png"
    ));
    assert!(permits_note_image(&state, "notes", "C:/Notes/other.png"));
    state["Launchers"] = json!([]);
    assert!(!permits_resource(
        &state,
        "launcher",
        "C:/Allowed/启动.exe",
        false
    ));
}

#[test]
fn negative_half_pixel_coordinates_follow_javascript_rounding_not_rust_away_from_zero() {
    let (_root, mut store) = setup();
    let area = Rect {
        x: -1920.0,
        y: -1080.0,
        width: 1920.0,
        height: 1080.0,
    };
    let restored = Rect::restore(
        "todo",
        &json!({"X":-400.5,"Y":-300.5}),
        Rect::defaults("todo"),
        &[area],
    );
    assert_eq!(restored.x, -400.0);
    assert_eq!(restored.y, -300.0);
    store
        .widget_geometry(
            "todo",
            Rect {
                x: -400.5,
                y: -300.5,
                width: 390.0,
                height: 320.0,
            },
            "None",
            false,
        )
        .unwrap();
    let state = store.read().unwrap();
    assert_eq!(state["Settings"]["WidgetPlacements"]["todo"]["X"], -400.0);
    assert_eq!(state["Settings"]["WidgetPlacements"]["todo"]["Y"], -300.0);
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn setup() -> (Root, WorkspaceStore) {
    let root = Root(std::env::temp_dir().join(format!("dustdesk-widgets-{}", Uuid::new_v4())));
    let mut store = WorkspaceStore::open(root.0.clone()).unwrap();
    let mut state = super::super::normalize::default_state();
    state["Settings"]["AutomaticBackupEnabled"] = json!(false);
    store.initialize(state, "widgets").unwrap();
    (root, store)
}
#[test]
fn visibility_options_presets_and_unknown_fields_survive_restart_without_touching_business_data() {
    let (root, mut store) = setup();
    let mut initial = store.read().unwrap();
    initial["Settings"]["WidgetPlacements"]["todo"] = json!({"Unknown":{"keep":1}});
    initial["UnknownRoot"] = json!({"keep":true});
    store.write(&mut initial, true).unwrap();
    store.widget_visible("todo", true).unwrap();
    store
        .widget_options(
            "todo",
            Options {
                locked: Some(true),
                ..Default::default()
            },
            None,
        )
        .unwrap();
    store.widget_preset("save", " 工作布局 ").unwrap();
    store.widget_visible("todo", false).unwrap();
    store.widget_preset("apply", "工作布局").unwrap();
    let state = store.read().unwrap();
    assert_eq!(
        state["Settings"]["WidgetPlacements"]["todo"],
        json!({"Visible":true,"Locked":true,"Unknown":{"keep":1}})
    );
    assert_eq!(state["Notes"], initial["Notes"]);
    assert_eq!(state["UnknownRoot"], initial["UnknownRoot"]);
    drop(store);
    let mut reopened = WorkspaceStore::open(root.0.clone()).unwrap();
    assert_eq!(reopened.read().unwrap(), state);
}
#[test]
fn metadata_failures_and_invalid_keys_never_change_saved_layouts() {
    let (_root, mut store) = setup();
    let original = fs::read(store.path()).unwrap();
    assert!(store.widget_visible("note:../../outside", true).is_err());
    assert!(store
        .widget_visible("note:00000000-0000-0000-0000-000000000000", true)
        .is_err());
    assert!(store.widget_preset("save", &"😀".repeat(41)).is_err());
    assert_eq!(fs::read(store.path()).unwrap(), original);
    if store.backup().exists() {
        fs::remove_file(store.backup()).unwrap();
    }
    fs::create_dir(store.backup()).unwrap();
    assert!(store.widget_visible("todo", true).is_err());
    assert_eq!(fs::read(store.path()).unwrap(), original);
}
#[test]
fn locked_geometry_is_rejected_and_option_updates_preserve_expanded_height() {
    let (_root, mut store) = setup();
    store
        .widget_geometry(
            "todo",
            Rect {
                x: -120.0,
                y: 80.0,
                width: 640.0,
                height: 360.0,
            },
            "Left",
            true,
        )
        .unwrap();
    store
        .widget_options(
            "todo",
            Options {
                collapsed: Some(true),
                locked: Some(true),
                ..Default::default()
            },
            None,
        )
        .unwrap();
    assert!(store
        .widget_geometry("todo", Rect::defaults("todo"), "None", false)
        .is_err());
    assert_eq!(
        store.read().unwrap()["Settings"]["WidgetPlacements"]["todo"]["Height"],
        360.0
    );
}
#[test]
fn restore_and_snap_keep_negative_work_areas_and_electron_edge_precedence() {
    let area = Rect {
        x: -1920.0,
        y: -80.0,
        width: 1920.0,
        height: 1040.0,
    };
    let original = Rect {
        x: -1910.0,
        y: -70.0,
        width: 390.0,
        height: 320.0,
    };
    let (snapped, edge) = original.snap(&[area], true);
    assert_eq!(edge, "Left");
    assert_eq!(snapped.x, -1920.0);
    assert_eq!(snapped.y, -80.0);
    assert_eq!(original.snap(&[area], false), (original, "None"));
    let restored = Rect::restore(
        "todo",
        &json!({"X":90000,"Y":-90000,"Width":20,"Height":5000}),
        original,
        &[area],
    );
    assert_eq!(restored.width, 300.0);
    assert_eq!(restored.height, 900.0);
    assert_eq!(restored.x, -80.0);
    assert_eq!(restored.y, -80.0);
}
#[test]
fn widget_snapshots_and_actions_are_scoped_to_native_business_roles() {
    let (_root, mut store) = setup();
    let original = store.load("projection").unwrap();
    let note = original.state["Notes"][0]["Id"].as_str().unwrap();
    let scoped = project(original.clone(), &format!("note:{note}"));
    assert_eq!(scoped.state["Notes"].as_array().unwrap().len(), 1);
    assert_eq!(scoped.state["Todos"], json!([]));
    assert!(scoped.path.is_empty());
    assert!(authorize_action(
        &format!("note:{note}"),
        &json!({"type":"note-edit","id":note})
    )
    .is_ok());
    assert!(authorize_action(
        &format!("note:{note}"),
        &json!({"type":"note-edit","id":"other"})
    )
    .is_err());
    assert!(authorize_action("todo", &json!({"type":"capture","kind":"task"})).is_ok());
    assert!(authorize_action("todo", &json!({"type":"capture","kind":"note"})).is_err());
    assert!(authorize_action("monitor", &json!({"type":"task-complete"})).is_err());
}
