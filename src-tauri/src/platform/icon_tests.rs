use super::*;

#[test]
fn native_icon_conversion_preserves_handle_dimensions_instead_of_forcing_32_pixels() {
    let color = [12u8, 44, 180, 255].repeat(64 * 64);
    let mask = vec![0u8; 64 * 64 / 8];
    let handle = unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::CreateIcon(
            null_mut(),
            64,
            64,
            1,
            32,
            mask.as_ptr(),
            color.as_ptr(),
        )
    };
    assert!(!handle.is_null());
    let icon = Icon(HICON(handle));
    assert_eq!(dimensions(&icon).unwrap(), (64, 64));
    let bytes = encode(icon).unwrap();
    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (64, 64));
}

#[test]
fn resource_path_expansion_enforces_utf16_budget_before_growing_the_buffer() {
    let mut path = "😀".repeat(2048);
    assert!(append_path(&mut path, "x").is_err());
    assert_eq!(path.encode_utf16().count(), 4096);
    let link = Path::new("C:/links/example.lnk");
    assert_eq!(
        resolve(&units(&"%SystemRoot%".repeat(1000)), link).unwrap_err(),
        "图标路径过长"
    );
}

fn units(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

#[test]
fn shortcut_resources_resolve_quotes_relative_names_commas_and_environment_variables() {
    let link = Path::new("C:/links/example.lnk");
    assert_eq!(
        resolve(&units("relative.ico"), link).unwrap(),
        PathBuf::from("C:/links/relative.ico")
    );
    assert_eq!(
        resolve(&units("\"C:/图标，含,逗号.ico\""), link).unwrap(),
        PathBuf::from("C:/图标，含,逗号.ico")
    );
    let expected = PathBuf::from(std::env::var("SystemRoot").unwrap()).join("System32/shell32.dll");
    assert_eq!(
        resolve(&units("%SystemRoot%/System32/shell32.dll"), link).unwrap(),
        expected
    );
    let name = format!("DUSTDESK_UNKNOWN_{}", uuid::Uuid::new_v4().simple());
    assert_eq!(
        resolve(&units(&format!("%{name}%/icon.ico")), link).unwrap(),
        PathBuf::from(format!("C:/links/%{name}%/icon.ico"))
    );
}

#[test]
fn native_resource_paths_reject_device_stream_overlong_and_invalid_unicode_values() {
    let link = Path::new("C:/links/example.lnk");
    for value in [
        r"\\?\C:\icons\icon.ico",
        r"\\.\C:\icons\icon.ico",
        "C:/icons/icon.ico:secret",
    ] {
        assert!(resolve(&units(value), link).is_err(), "{value}");
    }
    assert!(resolve(&units(&format!("C:/{}.ico", "a".repeat(4100))), link).is_err());
    assert!(resolve(&[0xd800, 0], link).is_err());
    assert!(resolve(&[], link).is_err());
    assert!(wide(Path::new("relative.ico")).is_err());
    assert!(wide(Path::new("C:/icons/bad\0file.ico")).is_err());
}
