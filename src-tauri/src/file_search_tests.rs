use super::*;
use serde_json::json;
struct Root(PathBuf);

#[test]
fn search_owners_isolate_cancellation_grants_and_cache_while_sharing_one_scan_budget() {
    let root = setup();
    let manager = SearchService::default();
    let main = manager.owner("workspace-main").unwrap();
    let widget = manager.owner("workspace-widget-search").unwrap();
    assert!(Arc::ptr_eq(&main.slot, &widget.slot));
    let main_request = main.begin("same-id".into()).unwrap();
    let widget_request = widget.begin("same-id".into()).unwrap();
    assert!(!*main_request.cancelled.borrow());
    assert!(main.finish(&main_request, &[item(&root.0, "main")]));
    assert!(widget.finish(&widget_request, &[item(&root.0, "widget")]));
    let main_key = system::path_key(root.0.join("main").to_str().unwrap()).unwrap();
    let widget_key = system::path_key(root.0.join("widget").to_str().unwrap()).unwrap();
    assert!(main.granted(&main_key));
    assert!(!widget.granted(&main_key));
    assert!(widget.granted(&widget_key));
    main.cancel(Some("same-id"));
    assert!(widget.granted(&widget_key));
    manager.release_owner("workspace-main");
    assert!(widget.granted(&widget_key));
    manager.release();
    assert!(!widget.granted(&widget_key));
    assert!(!manager
        .owner("workspace-widget-search")
        .unwrap()
        .granted(&widget_key));
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn setup() -> Root {
    let root = Root(std::env::temp_dir().join(format!("dustdesk-search-{}", Uuid::new_v4())));
    std::fs::create_dir_all(&root.0).unwrap();
    root
}
fn item(root: &Path, name: &str) -> SearchResult {
    SearchResult {
        name: name.into(),
        path: root.join(name).to_str().unwrap().into(),
        is_directory: false,
    }
}
#[test]
fn query_limits_use_utf16_and_javascript_whitespace() {
    assert!(!valid_query(" a "));
    assert!(!valid_query("\u{feff}a\u{feff}"));
    assert!(valid_query("🔎"));
    assert!(valid_query("\u{0085}a"));
    assert!(valid_query(&"🔎".repeat(128)));
    assert!(!valid_query(&"🔎".repeat(129)));
    assert!(!valid_query(&"a".repeat(257)));
}
#[test]
fn new_searches_cancel_old_ones_and_stale_completions_never_publish_grants() {
    let root = setup();
    let service = SearchService::default();
    let first = service.begin("first".into()).unwrap();
    let next = service.begin("next".into()).unwrap();
    assert!(*first.cancelled.borrow());
    service.cancel(Some("first"));
    assert!(!*next.cancelled.borrow());
    assert!(!service.finish(&first, &[item(&root.0, "stale")]));
    assert!(service.finish(&next, &[item(&root.0, "result")]));
    service.cancel(Some("wrong-id"));
    assert!(service.granted(&system::path_key(root.0.join("result").to_str().unwrap()).unwrap()));
    assert!(!service.granted(&system::path_key(root.0.to_str().unwrap()).unwrap()));
    service.cancel(Some("next"));
    assert!(!service.granted(&system::path_key(root.0.join("result").to_str().unwrap()).unwrap()));
    let request = service.begin("again".into()).unwrap();
    assert!(!service.granted(&system::path_key(root.0.join("result").to_str().unwrap()).unwrap()));
    service.release();
    assert!(*request.cancelled.borrow());
    assert!(!service.finish(&request, &[item(&root.0, "result")]));
}
#[test]
fn result_cache_is_bounded_expires_and_cannot_be_poisoned_by_cancelled_work() {
    let root = setup();
    let service = SearchService::default();
    let request = service.begin("active".into()).unwrap();
    for index in 0..40 {
        service.cache(&request, index.to_string(), vec![item(&root.0, "cached")]);
    }
    assert_eq!(service.session.lock().unwrap().cache.len(), 32);
    assert!(service.cached("0").is_none());
    assert!(service.cached("39").is_some());
    service
        .session
        .lock()
        .unwrap()
        .cache
        .back_mut()
        .unwrap()
        .expires = Instant::now() - Duration::from_secs(1);
    assert!(service.cached("39").is_none());
    service.cancel(Some("active"));
    service.cache(&request, "cancelled".into(), vec![]);
    assert!(service.cached("cancelled").is_none());
    service.release();
    assert!(service.session.lock().unwrap().cache.is_empty());
}

#[test]
fn timed_out_old_work_cannot_cancel_a_new_search_even_when_the_request_id_is_reused() {
    let service = SearchService::default();
    let old = service.begin("same-id".into()).unwrap();
    let current = service.begin("same-id".into()).unwrap();
    service.abort(&old);
    assert!(!*current.cancelled.borrow());
    assert!(service.finish(&current, &[]));
}

#[tokio::test]
async fn cancelled_blocking_io_keeps_its_worker_slot_until_real_io_finishes() {
    let service = SearchService::default();
    let slot = service.slot.clone().acquire_owned().await.unwrap();
    let request = service.begin("blocked".into()).unwrap();
    let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
    let (release_sender, release_receiver) = std::sync::mpsc::channel();
    let worker = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        started_sender.send(()).unwrap();
        release_receiver.recv().unwrap();
    });
    started_receiver.await.unwrap();
    service.cancel(Some("blocked"));
    assert!(*request.cancelled.borrow());
    assert!(service.slot.clone().try_acquire_owned().is_err());
    release_sender.send(()).unwrap();
    worker.await.unwrap();
    assert!(service.slot.clone().try_acquire_owned().is_ok());
}
#[test]
fn roots_follow_settings_project_directory_or_file_parent_deduplication_and_ten_root_limit() {
    let root = setup();
    let project = root.0.join("Project");
    std::fs::create_dir(&project).unwrap();
    let file = project.join("file.txt");
    std::fs::write(&file, b"file").unwrap();
    let state = json!({"Settings":{"SearchDesktopFiles":true,"SearchStartMenuApps":true,"SearchAppData":true,"SearchProjectPaths":true,"SearchCustomPaths":true,"SearchCustomRoots":[project.to_str().unwrap(),root.0.join("custom").to_str().unwrap()]},"Projects":[{"ProjectPath":project.to_str().unwrap(),"Phases":[{"ProjectPath":file.to_str().unwrap(),"Subtasks":[{"FilePath":root.0.join("missing").to_str().unwrap()}]}]}]});
    let result = roots(
        &state,
        root.0.join("Desktop"),
        root.0.join("AppData"),
        &watch::channel(false).1,
    );
    assert_eq!(
        result,
        vec![
            root.0.join("Desktop"),
            root.0.join("AppData/Microsoft/Windows/Start Menu/Programs"),
            root.0.join("AppData"),
            project,
            root.0.join("custom")
        ]
    );
    assert_eq!(
        normalized_roots(
            (0..15)
                .map(|index| root.0.join(index.to_string()))
                .collect()
        )
        .len(),
        10
    );
    assert!(roots(
        &json!({"Settings":{}}),
        root.0.clone(),
        root.0.clone(),
        &watch::channel(false).1
    )
    .is_empty());
}
#[test]
fn breadth_first_search_is_case_insensitive_deduplicates_nested_roots_and_stops_at_forty_results() {
    let root = setup();
    let nested = root.0.join("match-directory");
    std::fs::create_dir(&nested).unwrap();
    std::fs::write(root.0.join("MATCH-报告.txt"), b"top").unwrap();
    std::fs::write(nested.join("match-child.txt"), b"child").unwrap();
    let (_, cancelled) = watch::channel(false);
    let found = scan(&[root.0.clone(), nested.clone()], " MATCH ", &cancelled);
    assert_eq!(found.len(), 3);
    assert!(found[..2].iter().any(|item| item.name == "MATCH-报告.txt"));
    assert!(found[..2].iter().any(|item| item.is_directory));
    assert_eq!(found[2].name, "match-child.txt");
    for index in 0..60 {
        std::fs::write(nested.join(format!("match-{index:02}")), b"").unwrap();
    }
    assert_eq!(
        scan(std::slice::from_ref(&root.0), "match", &cancelled).len(),
        40
    );
    let (sender, cancelled) = watch::channel(false);
    sender.send_replace(true);
    assert!(scan(std::slice::from_ref(&root.0), "match", &cancelled).is_empty());
    assert!(scan(&[root.0.join("missing")], "match", &watch::channel(false).1).is_empty());
}
#[cfg(windows)]
#[test]
fn junction_roots_and_entries_are_not_returned_or_traversed() {
    let root = setup();
    let outside = root.0.join("outside");
    let inside = root.0.join("inside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::create_dir(&inside).unwrap();
    std::fs::write(outside.join("match-private"), b"private").unwrap();
    let junction = inside.join("match-junction");
    let result = std::process::Command::new("cmd.exe")
        .args([
            "/c",
            "mklink",
            "/J",
            junction.to_str().unwrap(),
            outside.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(result.status.success());
    assert!(scan(
        &[inside, junction.clone()],
        "match",
        &watch::channel(false).1
    )
    .is_empty());
    std::fs::remove_dir(junction).unwrap();
    assert!(outside.join("match-private").exists());
}
