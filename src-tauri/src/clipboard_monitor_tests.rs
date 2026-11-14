use super::*;
use crate::clipboard::ClipboardContent;

#[test]
fn fingerprints_match_electron_text_plus_base64_utf8_and_records_have_compatible_fields() {
    assert!(record(ClipboardContent::default()).unwrap().is_none());
    let content = ClipboardContent {
        text: "中文 😀\r\n第二行".into(),
        image_png_base64: String::new(),
    };
    let first = record(content.clone()).unwrap().unwrap();
    let second = record(content).unwrap().unwrap();
    assert_ne!(first["Id"], second["Id"]);
    assert_eq!(first["ImageSha256"], second["ImageSha256"]);
    assert_eq!(
        first["ImageSha256"],
        format!("{:x}", Sha256::digest("中文 😀\r\n第二行".as_bytes()))
    );
    assert_eq!(first["Kind"], "Text");
    assert_eq!(first["ImagePngBase64"], "");
    assert_eq!(first["IsPinned"], false);
    assert_eq!(first["IsLocked"], false);
    assert!(chrono::DateTime::parse_from_rfc3339(first["CreatedAt"].as_str().unwrap()).is_ok());
    assert_eq!(first.as_object().unwrap().len(), 9);
    assert!(record(ClipboardContent {
        text: "😀".repeat(2_500_001),
        image_png_base64: String::new()
    })
    .is_err());
}

#[test]
fn pause_generations_reject_old_samples_across_configuration_changes_nested_pauses_and_resume() {
    let control = Arc::new(Control::default());
    let generation = control.generation.load(Ordering::SeqCst);
    assert!(control.valid(generation));
    control.configure(true);
    assert!(!control.valid(generation));
    let enabled = control.generation.load(Ordering::SeqCst);
    control.configure(true);
    assert!(control.valid(enabled));
    let first = Pause::new(control.clone(), None);
    let second = Pause::new(control.clone(), None);
    assert!(!control.valid(enabled));
    drop(first);
    let resumed = control.generation.load(Ordering::SeqCst);
    assert!(!control.valid(resumed));
    drop(second);
    assert!(!control.valid(enabled));
    assert!(control.valid(control.generation.load(Ordering::SeqCst)));
    control.stopped.store(true, Ordering::SeqCst);
    assert!(!control.valid(control.generation.load(Ordering::SeqCst)));
}

#[test]
fn monitor_rejects_oversized_png_dimensions_before_allocating_pixels() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let mut bytes = crate::clipboard::encode_png(&image::DynamicImage::new_rgba8(1, 1)).unwrap();
    bytes[16..20].copy_from_slice(&4001u32.to_be_bytes());
    bytes[20..24].copy_from_slice(&4000u32.to_be_bytes());
    let mut checksum = u32::MAX;
    for byte in &bytes[12..29] {
        checksum ^= u32::from(*byte);
        for _bit in 0..8 {
            checksum = if checksum & 1 != 0 {
                (checksum >> 1) ^ 0xedb88320
            } else {
                checksum >> 1
            };
        }
    }
    bytes[29..33].copy_from_slice(&(!checksum).to_be_bytes());
    let error = record(ClipboardContent {
        text: String::new(),
        image_png_base64: STANDARD.encode(bytes),
    })
    .unwrap_err();
    assert!(error.contains("尺寸过大"), "{error}");
}

#[test]
fn quit_pause_owns_the_exact_accepted_candidate_and_veto_returns_it_without_resampling() {
    let control = Arc::new(Control::default());
    control.configure(true);
    let generation = control.generation.load(Ordering::SeqCst);
    let original = json!({"Id":"accepted-before-quit","CreatedAt":"2026-11-10T01:02:03.004Z"});
    assert!(control.accept(23, generation, original.clone()).unwrap());
    let pause = Pause::new(control.clone(), Some(23));
    assert_eq!(pause.pending.as_ref().unwrap().record, original);
    assert!(control.pending.lock().unwrap().is_none());
    assert!(!control
        .accept(23, generation, json!({"Id":"late"}))
        .unwrap());
    control.clear(23, generation);
    drop(pause);
    let resumed = control.generation.load(Ordering::SeqCst);
    assert!(control.valid(resumed));
    assert_eq!(control.candidate(23, resumed).unwrap(), Some(original));
    assert!(control.candidate(24, resumed).unwrap().is_none());
}

#[test]
fn quit_boundary_never_revives_a_candidate_superseded_before_shutdown_or_a_restore_pause() {
    for preserve in [None, Some(24)] {
        let control = Arc::new(Control::default());
        control.configure(true);
        let generation = control.generation.load(Ordering::SeqCst);
        assert!(control.accept(23, generation, json!({"Id":"old"})).unwrap());
        let pause = Pause::new(control.clone(), preserve);
        assert!(pause.pending.is_none());
        drop(pause);
        assert!(control
            .candidate(23, control.generation.load(Ordering::SeqCst))
            .unwrap()
            .is_none());
    }
}

#[test]
fn nested_restore_settings_changes_and_stop_invalidate_a_frozen_quit_candidate() {
    for invalidation in ["restore", "settings", "stop"] {
        let control = Arc::new(Control::default());
        control.configure(true);
        let generation = control.generation.load(Ordering::SeqCst);
        assert!(control.accept(23, generation, json!({"Id":"old"})).unwrap());
        let pause = Pause::new(control.clone(), Some(23));
        assert!(pause.pending.is_some());
        match invalidation {
            "restore" => drop(Pause::new(control.clone(), None)),
            "settings" => {
                control.configure(false);
                control.configure(true);
            }
            _ => control.stopped.store(true, Ordering::SeqCst),
        }
        drop(pause);
        assert_eq!(control.pauses.load(Ordering::SeqCst), 0);
        assert!(control.pending.lock().unwrap().is_none());
    }
}

#[test]
fn racing_acceptance_and_quit_capture_have_no_accepted_but_unowned_record() {
    for _iteration in 0..64 {
        let control = Arc::new(Control::default());
        control.configure(true);
        let generation = control.generation.load(Ordering::SeqCst);
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let worker_control = control.clone();
        let worker_barrier = barrier.clone();
        let worker = std::thread::spawn(move || {
            worker_barrier.wait();
            worker_control
                .accept(23, generation, json!({"Id":"racing"}))
                .unwrap()
        });
        barrier.wait();
        let pause = Pause::new(control.clone(), Some(23));
        assert_eq!(worker.join().unwrap(), pause.pending.is_some());
    }
}

#[test]
fn settings_invalidation_never_discards_a_candidate_accepted_in_the_new_configuration_epoch() {
    for _iteration in 0..64 {
        let control = Arc::new(Control::default());
        control.configure(true);
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let worker_control = control.clone();
        let worker_barrier = barrier.clone();
        let worker = std::thread::spawn(move || {
            worker_barrier.wait();
            let generation = worker_control.generation.load(Ordering::SeqCst);
            let accepted = worker_control
                .accept(23, generation, json!({"Id":"new-epoch"}))
                .unwrap();
            (generation, accepted)
        });
        barrier.wait();
        control.configure(false);
        control.configure(true);
        let (accepted_generation, accepted) = worker.join().unwrap();
        let generation = control.generation.load(Ordering::SeqCst);
        if accepted && generation == accepted_generation {
            assert_eq!(
                control.candidate(23, generation).unwrap(),
                Some(json!({"Id":"new-epoch"}))
            );
        }
    }
}
