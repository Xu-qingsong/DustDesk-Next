use super::*;
use std::path::PathBuf;
use uuid::Uuid;

struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn setup() -> (Root, WorkspaceStore, PathBuf) {
    let root = Root(std::env::temp_dir().join(format!("dustdesk-smart-{}", Uuid::new_v4())));
    let desktop = root.0.join("Desktop");
    fs::create_dir_all(&desktop).unwrap();
    let mut store = WorkspaceStore::open(root.0.join("Data")).unwrap();
    store.organizer_desktop = Some(desktop.clone());
    let mut state = super::super::normalize::default_state();
    state["Settings"]["AutomaticBackupEnabled"] = json!(false);
    state["DesktopCategories"] = json!([
        {"Id":"fallback","Name":"首分类","IsCollapsed":false,"ItemPaths":[],"Unknown":{"keep":1}},
        {"Id":"work","Name":"工作","IsCollapsed":false,"ItemPaths":[]},
        {"Id":"code","Name":"开发","IsCollapsed":false,"ItemPaths":[]},
        {"Id":"tool","Name":"工具","IsCollapsed":false,"ItemPaths":[]},
        {"Id":"files","Name":"文件","IsCollapsed":false,"ItemPaths":[]}
    ]);
    state["OrganizerRules"] = json!([]);
    store.initialize(state, "smart-test").unwrap();
    (root, store, desktop)
}
fn item(source: &std::path::Path, category: &str) -> Value {
    json!({"SourcePath":source.to_str().unwrap(),"CategoryId":category,"CategoryName":"untrusted stale name"})
}

#[test]
fn default_classification_matches_legacy_extensions_and_first_category_fallback() {
    let (_root, mut store, _desktop) = setup();
    let mut state = store.read().unwrap();
    for (name, wanted) in [
        ("报告.PDF", "work"),
        ("x.DOC", "work"),
        ("x.xlsx", "work"),
        ("x.pptx", "work"),
        (".md", "work"),
        ("x.TSX", "code"),
        ("x.h", "code"),
        ("x.HTML", "code"),
        ("x.exe", "tool"),
        ("x.CMD", "tool"),
        ("x.tar.gz", "files"),
        ("folder", "files"),
        ("x.jpeg", "files"),
        ("x.pdf.bak", "files"),
    ] {
        assert_eq!(classify(name, &state).unwrap()["Id"], wanted, "{name}");
    }
    state["DesktopCategories"]
        .as_array_mut()
        .unwrap()
        .retain(|category| category["Id"] == "fallback");
    assert_eq!(classify("x.txt", &state).unwrap()["Id"], "fallback");
    state["DesktopCategories"] = json!([]);
    assert!(classify("x.txt", &state).is_none());
}

#[test]
fn rules_keep_order_disabled_missing_categories_patterns_and_javascript_whitespace_semantics() {
    let (_root, mut store, _desktop) = setup();
    let mut state = store.read().unwrap();
    state["OrganizerRules"] = json!([
        {"Enabled":false,"Match":"name","Pattern":"报告","CategoryId":"tool"},
        {"Enabled":true,"Match":"name","Pattern":"报告","CategoryId":"deleted"},
        {"Enabled":true,"Match":"extension","Pattern":" , ， *.PDF，.TxT,docx ","CategoryId":"code"},
        {"Enabled":true,"Match":"name","Pattern":" 报告，SPECIAL ","CategoryId":"fallback"}
    ]);
    assert_eq!(classify("报告.PDF", &state).unwrap()["Id"], "code");
    assert_eq!(classify("报告.png", &state).unwrap()["Id"], "fallback");
    assert_eq!(
        classify("my-special.JPG", &state).unwrap()["Id"],
        "fallback"
    );
    assert_eq!(classify("random.png", &state).unwrap()["Id"], "files");
    state["OrganizerRules"] = json!([{ "Enabled":true,"Match":"extension","Pattern":"\u{FEFF} *.PDF \u{FEFF}","CategoryId":"code" }]);
    assert_eq!(classify("x.pdf", &state).unwrap()["Id"], "code");
    state["OrganizerRules"][0]["Pattern"] = json!("\u{0085}pdf");
    assert_eq!(classify("x.pdf", &state).unwrap()["Id"], "work");
    state["OrganizerRules"][0]["Pattern"] = json!("*pdf");
    assert_eq!(classify("x.pdf", &state).unwrap()["Id"], "work");
}

#[test]
fn preview_only_enumerates_direct_entries_excludes_ini_and_does_not_create_or_move_data() {
    let (_root, mut store, desktop) = setup();
    fs::write(desktop.join("DESKTOP.INI"), b"hidden").unwrap();
    fs::write(desktop.join("报告.PDF"), b"bytes").unwrap();
    fs::create_dir(desktop.join("directory.ts")).unwrap();
    fs::write(desktop.join("directory.ts/nested.exe"), b"nested").unwrap();
    let before = fs::read(store.path()).unwrap();
    let plan = store.organizer_plan().unwrap();
    assert_eq!(plan.len(), 2);
    assert!(plan.iter().any(
        |item| item.source_path == desktop.join("报告.PDF").to_str().unwrap()
            && item.category_id == "work"
    ));
    assert!(plan
        .iter()
        .any(|item| item.category_name == "开发" && item.category_id == "code"));
    assert_eq!(fs::read(store.path()).unwrap(), before);
    assert!(desktop.join("报告.PDF").is_file());
    assert!(!store.root.join("DesktopOrganizer").exists());
    let mut state = store.read().unwrap();
    state["DesktopCategories"] = json!([]);
    store.write(&mut state, true).unwrap();
    assert!(store.organizer_plan().unwrap().is_empty());
    store.organizer_desktop = Some(desktop.join("missing"));
    assert!(store.organizer_plan().is_err());
    assert!(!desktop.join("missing").exists());
}

#[test]
fn malformed_or_oversize_batches_reject_before_any_valid_item_can_move() {
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("keep.txt");
    fs::write(&source, b"keep").unwrap();
    let valid = item(&source, "work");
    for plan in [
        None,
        Some(json!({})),
        Some(json!([valid.clone(), null])),
        Some(json!([valid.clone(),{"SourcePath":7,"CategoryId":"work"}])),
        Some(json!(vec![valid.clone(); 5001])),
    ] {
        let (result, snapshot) = store.organizer_execute(plan);
        assert_eq!(
            result,
            json!({"ok":false,"moved":0,"error":"请先生成并确认整理预览"})
        );
        assert!(snapshot.is_none());
        assert_eq!(fs::read(&source).unwrap(), b"keep");
        assert!(!store.root.join("organizer.pending.json").exists());
    }
    assert_eq!(
        store.organizer_execute(Some(json!([]))).0,
        json!({"ok":true,"moved":0})
    );
}

#[test]
fn duplicates_are_deduplicated_and_each_success_persists_bytes_unknowns_and_an_undo() {
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("one.txt");
    let other = desktop.join("two.py");
    fs::write(&source, b"first").unwrap();
    fs::write(&other, b"second").unwrap();
    let plan = json!([
        item(&source, "fallback"),
        item(&source, "work"),
        item(&other, "code")
    ]);
    let (result, snapshot) = store.organizer_execute(Some(plan));
    assert_eq!(result, json!({"ok":true,"moved":2}));
    assert_eq!(
        snapshot.unwrap().state["DesktopCategories"][0]["Unknown"]["keep"],
        1
    );
    assert_eq!(
        store.read().unwrap()["OrganizerUndoStack"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    store.organizer_undo().unwrap();
    assert_eq!(fs::read(&other).unwrap(), b"second");
    store.organizer_undo().unwrap();
    assert_eq!(fs::read(&source).unwrap(), b"first");
}

#[test]
fn partial_batch_keeps_successes_continues_after_collisions_and_revalidates_current_categories() {
    let (root, mut store, desktop) = setup();
    let first = desktop.join("collision.txt");
    let second = desktop.join("second.txt");
    let third = desktop.join("third.txt");
    fs::write(&first, b"original").unwrap();
    fs::write(&second, b"second").unwrap();
    fs::write(&third, b"third").unwrap();
    let target = store.root.join("DesktopOrganizer/工作/collision.txt");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, b"existing").unwrap();
    let outside = root.0.join("outside.txt");
    fs::write(&outside, b"private").unwrap();
    let nested = desktop.join("nested/data.txt");
    fs::create_dir(nested.parent().unwrap()).unwrap();
    fs::write(&nested, b"nested").unwrap();
    let plan = json!([
        item(&first, "work"),
        item(&second, "work"),
        item(&outside, "work"),
        item(&nested, "work"),
        item(&third, "missing")
    ]);
    let (result, snapshot) = store.organizer_execute(Some(plan));
    assert_eq!(
        result,
        json!({"ok":false,"moved":1,"error":"已整理 1 项，4 项失败，请重新扫描；已完成的项目可逐项撤销"})
    );
    assert!(snapshot.is_some());
    assert_eq!(fs::read(first).unwrap(), b"original");
    assert_eq!(fs::read(target).unwrap(), b"existing");
    assert_eq!(fs::read(third).unwrap(), b"third");
    assert_eq!(fs::read(outside).unwrap(), b"private");
    assert_eq!(fs::read(nested).unwrap(), b"nested");
    assert!(!second.exists());
    assert!(
        fs::read_to_string(store.root.join("Logs/organizer-move.log"))
            .unwrap()
            .contains("智能收纳")
    );
    store.organizer_undo().unwrap();
    assert_eq!(fs::read(second).unwrap(), b"second");
}

#[test]
fn batch_metadata_failure_returns_zero_and_compensates_without_advancing_undo() {
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("keep.txt");
    fs::write(&source, b"keep bytes").unwrap();
    let before = fs::read(store.path()).unwrap();
    if store.backup().exists() {
        fs::remove_file(store.backup()).unwrap();
    }
    fs::create_dir(store.backup()).unwrap();
    let (result, snapshot) = store.organizer_execute(Some(json!([item(&source, "work")])));
    assert_eq!(result["moved"], 0);
    assert_eq!(result["ok"], false);
    assert!(snapshot.is_none());
    assert_eq!(fs::read(&source).unwrap(), b"keep bytes");
    assert_eq!(fs::read(store.path()).unwrap(), before);
    assert!(!store.root.join("organizer.pending.json").exists());
}
