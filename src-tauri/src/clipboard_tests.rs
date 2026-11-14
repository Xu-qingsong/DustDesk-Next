use super::*;
use image::{Rgba, RgbaImage};

fn fixture() -> DynamicImage {
    DynamicImage::ImageRgba8(RgbaImage::from_fn(320, 240, |column, row| {
        Rgba([
            column as u8,
            row as u8,
            91,
            if column < 100 { 80 } else { 255 },
        ])
    }))
}

#[test]
fn validates_ids_base64_canonical_form_and_write_shapes_before_accessing_clipboard() {
    assert!(valid_id("").is_err());
    assert!(valid_id("a\0b").is_err());
    assert!(valid_id(&"😀".repeat(65)).is_err());
    assert!(valid_id(&"😀".repeat(64)).is_ok());
    for invalid in ["", "a", "data:image/png;base64,eA==", "eB==", "eA==\n"] {
        assert!(decode_base64(invalid).is_err(), "{invalid}");
    }
    assert_eq!(decode_base64("eA==").unwrap(), b"x");
    assert!(decode_base64(&"A".repeat(MAX_IMAGE_BYTES.div_ceil(3) * 4 + 4)).is_err());
    for invalid in [
        json!(null),
        json!({"text":false}),
        json!({"text":null}),
        json!({"recordId":null}),
        json!({"path":"C:/private"}),
    ] {
        assert!(serde_json::from_value::<WriteContent>(invalid).is_err());
    }
    let empty: WriteContent = serde_json::from_value(json!({})).unwrap();
    assert!(prepare(empty).is_err());
    let empty_text: WriteContent = serde_json::from_value(json!({"text":""})).unwrap();
    assert!(matches!(prepare(empty_text),Ok(PreparedContent::Text(text)) if text.is_empty()));
    let nul: WriteContent = serde_json::from_value(json!({"text":"bad\0text"})).unwrap();
    assert!(prepare(nul).is_err());
    let huge = WriteContent {
        text: Some("😀".repeat(MAX_TEXT_UNITS / 2 + 1)),
        image_png_base64: None,
        record_id: None,
    };
    assert!(prepare(huge).is_err());
    let mixed = WriteContent {
        text: Some("must not be copied before invalid image is rejected".into()),
        image_png_base64: Some("eA==".into()),
        record_id: None,
    };
    assert!(prepare(mixed).is_err());
}

#[test]
fn png_and_top_down_dibv5_preserve_dimensions_pixels_and_alpha() {
    let original = fixture();
    let png = encode_png(&original).unwrap();
    assert_eq!(decode_image(&png).unwrap().to_rgba8(), original.to_rgba8());
    let bitmap = dib(&original);
    assert_eq!(u32::from_le_bytes(bitmap[0..4].try_into().unwrap()), 124);
    assert_eq!(i32::from_le_bytes(bitmap[8..12].try_into().unwrap()), -240);
    assert_eq!(
        image_from_dib(&bitmap).unwrap().to_rgba8(),
        original.to_rgba8()
    );
    let mixed = WriteContent {
        text: Some("text loses to image, as with the existing Electron writer".into()),
        image_png_base64: Some(STANDARD.encode(&png)),
        record_id: None,
    };
    assert!(matches!(prepare(mixed), Ok(PreparedContent::Image { .. })));
}

#[test]
fn previews_scale_to_bounds_without_upscaling_and_keep_original_dimensions() {
    let bytes = encode_png(&fixture()).unwrap();
    let thumbnail = preview(&bytes, true).unwrap();
    assert_eq!(thumbnail["image"]["width"], 320);
    assert_eq!(thumbnail["image"]["height"], 240);
    let decode = |value: &Value| {
        decode_image(
            &STANDARD
                .decode(
                    value["image"]["dataUrl"]
                        .as_str()
                        .unwrap()
                        .strip_prefix("data:image/png;base64,")
                        .unwrap(),
                )
                .unwrap(),
        )
        .unwrap()
    };
    let reduced = decode(&thumbnail);
    assert_eq!((reduced.width(), reduced.height()), (160, 120));
    let full = decode(&preview(&bytes, false).unwrap());
    assert_eq!(full.to_rgba8(), fixture().to_rgba8());
    let tiny = DynamicImage::new_rgba8(3, 2);
    let tiny_preview = decode(&preview(&encode_png(&tiny).unwrap(), true).unwrap());
    assert_eq!((tiny_preview.width(), tiny_preview.height()), (3, 2));
    let narrow = DynamicImage::new_rgba8(1, 1000);
    let narrow_preview = decode(&preview(&encode_png(&narrow).unwrap(), true).unwrap());
    assert_eq!((narrow_preview.width(), narrow_preview.height()), (1, 120));
}

#[test]
fn legacy_bottom_up_bitfields_use_external_masks_and_reverse_physical_scanlines() {
    let original = DynamicImage::ImageRgba8(RgbaImage::from_fn(3, 2, |column, row| {
        Rgba([10 + column as u8, 20 + row as u8, 30, 255])
    }));
    let top_down = dib(&original);
    let mut legacy = top_down[..40].to_vec();
    legacy[0..4].copy_from_slice(&40u32.to_le_bytes());
    legacy[8..12].copy_from_slice(&2i32.to_le_bytes());
    legacy.extend_from_slice(&top_down[40..52]);
    legacy.extend_from_slice(&top_down[136..148]);
    legacy.extend_from_slice(&top_down[124..136]);
    assert_eq!(
        image_from_dib(&legacy).unwrap().to_rgba8(),
        original.to_rgba8()
    );
    legacy[32..36].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(image_from_dib(&legacy).is_err());
}

#[test]
fn rejects_oversized_headers_and_malformed_dib_before_large_pixel_allocation() {
    let mut bytes = encode_png(&fixture()).unwrap();
    bytes[16..20].copy_from_slice(&40001u32.to_be_bytes());
    bytes[20..24].copy_from_slice(&1000u32.to_be_bytes());
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
    assert!(decode_image(&bytes).unwrap_err().contains("尺寸过大"));
    let valid = dib(&fixture());
    for length in [0, 3, 20, 39, 123] {
        assert!(image_from_dib(&valid[..length]).is_err());
    }
    for (offset, value) in [
        (0, 500u32),
        (4, 0),
        (8, i32::MIN as u32),
        (16, 99),
        (4, 40000001),
    ] {
        let mut malformed = valid.clone();
        malformed[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        assert!(image_from_dib(&malformed).is_err());
    }
    let mut truncated = valid;
    truncated.truncate(124);
    assert!(image_from_dib(&truncated).is_err());
}
