use super::*;
use crate::lan::files::tests::Fixture;
use std::{cell::Cell, fs, fs::OpenOptions, os::windows::fs::OpenOptionsExt};

struct Installation {
    fixture: Fixture,
    release: Release,
}

impl Installation {
    fn new() -> Self {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("resources")).unwrap();
        let executable = vec![0x51; 180_000];
        let archive = vec![0x72; 150_000];
        fs::write(fixture.0.join(FILE_PATHS[0]), &executable).unwrap();
        fs::write(fixture.0.join(FILE_PATHS[1]), &archive).unwrap();
        let mut release = catalog().unwrap().releases.remove(0);
        release.version = "synthetic-test-only".into();
        for (file, bytes) in release.files.iter_mut().zip([executable, archive]) {
            file.size = bytes.len() as u64;
            file.sha256 = format!("{:x}", Sha256::digest(&bytes));
        }
        Self { fixture, release }
    }

    fn open(&self) -> Result<PinnedInstallation, String> {
        PinnedInstallation::open_trusted(
            &self.fixture.0,
            std::slice::from_ref(&self.release),
            &CancellationToken::new(),
            &|| Ok(()),
        )
    }
}

#[test]
fn compiled_catalog_matches_one_exact_official_release() {
    let catalog = catalog().unwrap();
    assert_eq!(catalog.releases.len(), 1);
    let release = &catalog.releases[0];
    assert_eq!(release.version, "1.0.2");
    assert_eq!(release.zip_name, "DustDesk-1.0.2-x64-green.zip");
    assert_eq!(release.package_name, "dustdesk-electron");
    assert_eq!(release.main_entry, "out/main/index.js");
    assert_eq!(release.browser_entry, "out/renderer/index.html");
    assert_eq!(release.data_relative_to_app_data, "DustDesk.Next/Data");
    assert_eq!(release.lan_relative_to_user_data, "LanTransfers");
}

#[test]
fn synthetic_fixtures_cannot_authenticate_against_production_trust() {
    let installation = Installation::new();
    assert!(PinnedInstallation::open(
        &installation.fixture.0,
        &CancellationToken::new(),
        || Ok(())
    )
    .err()
    .unwrap()
    .contains("文件大小"));
}

#[test]
fn holds_both_files_and_every_directory_until_native_object_is_dropped() {
    let installation = Installation::new();
    let mut source = installation.open().unwrap();
    for path in [
        installation.fixture.0.clone(),
        installation.fixture.0.join("resources"),
        installation.fixture.0.join(FILE_PATHS[0]),
        installation.fixture.0.join(FILE_PATHS[1]),
    ] {
        assert!(fs::rename(&path, path.with_extension("moved")).is_err());
    }
    assert!(fs::write(installation.fixture.0.join(FILE_PATHS[0]), b"changed").is_err());
    assert!(fs::write(installation.fixture.0.join(FILE_PATHS[1]), b"changed").is_err());
    source
        .confirm(&CancellationToken::new(), || Ok(()))
        .unwrap();
    let inspection = serde_json::to_value(source.inspection()).unwrap();
    assert_eq!(inspection["purpose"], "installation-identification-only");
    for field in [
        "productionReady",
        "migrationComplete",
        "legacyExecuted",
        "productionDataRead",
    ] {
        assert_eq!(inspection[field], false);
    }
    drop(source);
    fs::write(installation.fixture.0.join(FILE_PATHS[0]), b"changed").unwrap();
    assert!(installation.open().is_err());
}

#[test]
fn same_size_modification_is_rejected_for_each_critical_file() {
    for relative in FILE_PATHS {
        let installation = Installation::new();
        let path = installation.fixture.0.join(relative);
        let mut bytes = fs::read(&path).unwrap();
        let middle = bytes.len() / 2;
        bytes[middle] ^= 1;
        fs::write(path, bytes).unwrap();
        assert!(installation.open().err().unwrap().contains("未同时匹配"));
    }
}

#[test]
fn files_from_different_trusted_releases_cannot_be_mixed() {
    let installation = Installation::new();
    let mut alternate = installation.release.clone();
    alternate.version = "different-test-release".into();
    alternate.files[0].sha256 = "0".repeat(64);
    let mut original = installation.release.clone();
    original.files[1].sha256 = "0".repeat(64);
    assert!(PinnedInstallation::open_trusted(
        &installation.fixture.0,
        &[original, alternate],
        &CancellationToken::new(),
        &|| Ok(()),
    )
    .err()
    .unwrap()
    .contains("未同时匹配"));
}

#[test]
fn missing_paths_and_directory_substitutes_are_rejected_without_creation() {
    for relative in ["DustDesk.exe", "resources/app.asar", "resources"] {
        let installation = Installation::new();
        let path = installation.fixture.0.join(relative);
        if path.is_dir() {
            fs::remove_dir_all(&path).unwrap();
        } else {
            fs::remove_file(&path).unwrap();
        }
        assert!(installation.open().is_err());
        assert!(!path.exists());
        if relative != "resources" {
            fs::create_dir(&path).unwrap();
            assert!(installation.open().is_err());
        }
    }
}

#[test]
fn each_critical_file_must_be_single_link_and_preserve_other_names() {
    for relative in FILE_PATHS {
        let installation = Installation::new();
        let path = installation.fixture.0.join(relative);
        let alias = installation.fixture.0.join("alias");
        fs::hard_link(&path, &alias).unwrap();
        let original = fs::read(&alias).unwrap();
        assert!(installation.open().is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read(alias).unwrap(), original);
    }
}

#[test]
fn active_reader_or_writer_blocks_inspection_without_changing_content() {
    for relative in FILE_PATHS {
        let installation = Installation::new();
        let path = installation.fixture.0.join(relative);
        let original = fs::read(&path).unwrap();
        for write in [false, true] {
            let handle = OpenOptions::new()
                .read(true)
                .write(write)
                .share_mode(1 | 2 | 4)
                .open(&path)
                .unwrap();
            assert!(installation.open().is_err());
            drop(handle);
            assert_eq!(fs::read(&path).unwrap(), original);
            installation.open().unwrap();
        }
    }
}

#[test]
fn readonly_sources_are_identified_without_changing_permissions() {
    let installation = Installation::new();
    let path = installation.fixture.0.join(FILE_PATHS[0]);
    let permissions = fs::metadata(&path).unwrap().permissions();
    let mut readonly = permissions.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&path, readonly).unwrap();
    let result = installation.open();
    let remains_readonly = fs::metadata(&path).unwrap().permissions().readonly();
    let succeeded = result.is_ok();
    drop(result);
    fs::set_permissions(path, permissions).unwrap();
    assert!(succeeded);
    assert!(remains_readonly);
}

#[test]
fn cancellation_before_open_does_not_create_missing_installation() {
    let fixture = Fixture::new();
    let path = fixture.0.join("absent");
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(PinnedInstallation::open(&path, &cancel, || Ok(()))
        .err()
        .unwrap()
        .contains("已取消"));
    assert!(!path.exists());
}

#[test]
fn hashing_checks_native_authority_between_bounded_chunks() {
    let installation = Installation::new();
    let checks = Cell::new(0);
    let result = PinnedInstallation::open_trusted(
        &installation.fixture.0,
        std::slice::from_ref(&installation.release),
        &CancellationToken::new(),
        &|| {
            checks.set(checks.get() + 1);
            if checks.get() == 4 {
                Err("native-authority-expired".into())
            } else {
                Ok(())
            }
        },
    );
    assert!(result.err().unwrap().contains("native-authority-expired"));
    assert_eq!(checks.get(), 4);
    installation.open().unwrap();
}

#[test]
fn cancellation_during_hash_and_confirmation_releases_all_pins() {
    let installation = Installation::new();
    let cancel = CancellationToken::new();
    let checks = Cell::new(0);
    let result = PinnedInstallation::open_trusted(
        &installation.fixture.0,
        std::slice::from_ref(&installation.release),
        &cancel,
        &|| {
            checks.set(checks.get() + 1);
            if checks.get() == 3 {
                cancel.cancel();
            }
            Ok(())
        },
    );
    assert!(result.err().unwrap().contains("已取消"));
    let mut source = installation.open().unwrap();
    assert!(source.confirm(&cancel, || Ok(())).is_err());
    drop(source);
    fs::rename(
        installation.fixture.0.join("resources"),
        installation.fixture.0.join("moved"),
    )
    .unwrap();
}

#[test]
fn inspection_metadata_is_informational_and_copy_does_not_reuse_physical_binding() {
    let first = Installation::new();
    let second = Installation::new();
    let first_source = first.open().unwrap();
    let second_source = second.open().unwrap();
    let first_proof = serde_json::to_value(first_source.inspection()).unwrap();
    let second_proof = serde_json::to_value(second_source.inspection()).unwrap();
    assert_eq!(first_proof["release"], second_proof["release"]);
    assert_ne!(first_proof["rootIdentity"], second_proof["rootIdentity"]);
    assert_ne!(
        first_proof["resourcesIdentity"],
        second_proof["resourcesIdentity"]
    );
}

#[test]
fn relative_parent_network_device_and_alternate_stream_paths_are_rejected() {
    let installation = Installation::new();
    for path in [
        "relative".to_owned(),
        "C:relative".to_owned(),
        "\\\\server\\share\\DustDesk".to_owned(),
        "\\\\.\\C:\\DustDesk".to_owned(),
        format!("{}\\..\\outside", installation.fixture.0.display()),
        format!("{}:stream", installation.fixture.0.display()),
    ] {
        assert!(
            PinnedInstallation::open_trusted(
                Path::new(&path),
                std::slice::from_ref(&installation.release),
                &CancellationToken::new(),
                &|| Ok(()),
            )
            .is_err(),
            "{path}"
        );
    }
}

#[test]
fn junction_installations_ancestors_and_resources_are_rejected_without_following_them() {
    let installation = Installation::new();
    let fixture = Fixture::new();
    for (target, suffix) in [
        (installation.fixture.0.clone(), ""),
        (
            installation.fixture.0.parent().unwrap().to_path_buf(),
            installation
                .fixture
                .0
                .file_name()
                .unwrap()
                .to_str()
                .unwrap(),
        ),
    ] {
        let link = fixture.0.join("linked");
        assert!(std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(target)
            .output()
            .unwrap()
            .status
            .success());
        let result = PinnedInstallation::open_trusted(
            &link.join(suffix),
            std::slice::from_ref(&installation.release),
            &CancellationToken::new(),
            &|| Ok(()),
        );
        fs::remove_dir(&link).unwrap();
        assert!(result.is_err());
    }
    let original = installation.fixture.0.join("original-resources");
    let link = installation.fixture.0.join("resources");
    fs::rename(&link, &original).unwrap();
    assert!(std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&link)
        .arg(&original)
        .output()
        .unwrap()
        .status
        .success());
    let result = installation.open();
    fs::remove_dir(&link).unwrap();
    assert!(result.is_err());
    assert_eq!(
        fs::metadata(original.join("app.asar")).unwrap().len(),
        installation.release.files[1].size
    );
}

#[test]
#[ignore = "requires explicitly selected official ZIP extraction; never launches the legacy program"]
fn official_release_bytes_match_compiled_trust_without_reading_production_data() {
    let path = std::env::var_os("DUSTDESK_LEGACY_REFERENCE")
        .expect("set DUSTDESK_LEGACY_REFERENCE to the verified official reference-installation");
    let mut source =
        PinnedInstallation::open(Path::new(&path), &CancellationToken::new(), || Ok(())).unwrap();
    source
        .confirm(&CancellationToken::new(), || Ok(()))
        .unwrap();
    let inspection = serde_json::to_value(source.inspection()).unwrap();
    assert_eq!(inspection["release"]["version"], "1.0.2");
    assert_eq!(inspection["productionDataRead"], false);
    assert_eq!(inspection["legacyExecuted"], false);
    assert_eq!(inspection["productionReady"], false);
    println!("{}", serde_json::to_string(&inspection).unwrap());
}
