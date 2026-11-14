use super::*;

#[test]
fn browser_profile_is_fresh_pinned_and_resumes_only_the_same_native_directory() {
    let (runtime, preparation_id, prepared, source) = setup();
    let cancel = CancellationToken::new();
    let mut owner = source
        .claim_runtime(&preparation_id, &prepared.id, &cancel, || Ok(()))
        .unwrap();
    let id = owner.receipt().id.clone();
    let binding = owner.prepare_browser_profile().unwrap();
    assert_eq!(binding.ownership_id(), id);
    assert_eq!(binding.origin(), "http://tauri.localhost");
    assert_eq!(fs::read_dir(binding.path()).unwrap().count(), 0);
    fs::write(
        binding.path().join("browser-owned"),
        b"legitimate WebView2 state",
    )
    .unwrap();
    assert!(fs::rename(binding.path(), binding.path().with_extension("moved")).is_err());
    owner.verify().unwrap();
    drop(owner);
    let source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let mut owner = source
        .resume_runtime(&preparation_id, &prepared.id, &id, &cancel, || Ok(()))
        .unwrap();
    assert!(owner.prepare_browser_profile().is_err());
    assert_eq!(owner.resume_browser_profile().unwrap(), binding);
    cancel.cancel();
    assert!(owner.confirm().is_err());
    assert!(fs::rename(binding.path(), binding.path().with_extension("moved")).is_err());
    drop(owner);
    let original = binding.path().with_extension("original");
    fs::rename(binding.path(), &original).unwrap();
    copy_tree(&original, binding.path());
    let cancel = CancellationToken::new();
    let source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let mut owner = source
        .resume_runtime(&preparation_id, &prepared.id, &id, &cancel, || Ok(()))
        .unwrap();
    assert!(owner.resume_browser_profile().is_err());
    assert_eq!(
        fs::read(binding.path().join("browser-owned")).unwrap(),
        b"legitimate WebView2 state"
    );
}

#[test]
fn browser_profile_refuses_existing_paths_and_incomplete_or_unknown_records_without_repair() {
    let (runtime, preparation_id, prepared, source) = setup();
    let cancel = CancellationToken::new();
    let mut owner = source
        .claim_runtime(&preparation_id, &prepared.id, &cancel, || Ok(()))
        .unwrap();
    let id = owner.receipt().id.clone();
    let path = runtime.fixture.0.join(format!("DustDesk-WebView2-{id}"));
    fs::create_dir(&path).unwrap();
    fs::write(path.join("existing"), b"keep").unwrap();
    assert!(owner.prepare_browser_profile().is_err());
    fs::remove_file(path.join("existing")).unwrap();
    fs::remove_dir(&path).unwrap();
    let binding = owner.prepare_browser_profile().unwrap();
    let record = records(&runtime, &preparation_id)
        .join(&prepared.id)
        .join("Ownership")
        .join(&id)
        .join("BrowserProfile");
    fs::write(record.join("unknown"), b"keep unknown evidence").unwrap();
    assert!(owner.confirm().is_err());
    fs::remove_file(record.join("unknown")).unwrap();
    drop(owner);
    let intent = fs::read(record.join("intent.json")).unwrap();
    let decision = fs::read(record.join("decision.json")).unwrap();
    fs::remove_file(record.join("decision.json")).unwrap();
    let source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let mut owner = source
        .resume_runtime(&preparation_id, &prepared.id, &id, &cancel, || Ok(()))
        .unwrap();
    assert!(owner.resume_browser_profile().is_err());
    assert!(owner.prepare_browser_profile().is_err());
    assert!(binding.path().is_dir());
    assert_eq!(fs::read(record.join("intent.json")).unwrap(), intent);
    assert!(!record.join("decision.json").exists());
    drop(owner);
    fs::write(record.join("decision.json"), decision).unwrap();
    let source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let mut owner = source
        .resume_runtime(&preparation_id, &prepared.id, &id, &cancel, || Ok(()))
        .unwrap();
    owner.resume_browser_profile().unwrap();
}
