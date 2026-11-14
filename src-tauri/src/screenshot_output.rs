use crate::screenshot::{Document, Rect, MAX_BYTES, MAX_PIXELS};
use image::{DynamicImage, ImageFormat};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, io::Cursor};

const MAX_METADATA: usize = 16 * 1024 * 1024;
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Copy,
    Save,
    SaveAs,
    Pin,
    OpenEditor,
    UpdatePin,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metadata {
    pub request_id: String,
    pub document: Document,
    pub action: Action,
    pub format: Option<String>,
    pub png_length: usize,
    pub jpeg_length: usize,
}
pub struct Packet {
    pub metadata: Metadata,
    pub digest: [u8; 32],
    bytes: Vec<u8>,
    start: usize,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pin_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canceled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}
pub struct Completed {
    pub document_id: String,
    pub request_id: String,
    pub digest: [u8; 32],
    pub output: Output,
}
impl Output {
    pub fn warn(&mut self, message: String) {
        self.warning = Some(match self.warning.take() {
            Some(previous) => format!("{previous}；{message}"),
            None => message,
        });
    }
}
fn integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}
fn point(coordinate_x: f64, coordinate_y: f64) -> bool {
    coordinate_x.is_finite()
        && coordinate_y.is_finite()
        && coordinate_x.abs() <= 32768.0
        && coordinate_y.abs() <= 32768.0
}
fn rect(value: &Rect, width: u32, height: u32) -> bool {
    point(value.x, value.y)
        && value.width.is_finite()
        && value.height.is_finite()
        && value.width >= 1.0
        && value.height >= 1.0
        && value.x >= 0.0
        && value.y >= 0.0
        && value.x + value.width <= f64::from(width)
        && value.y + value.height <= f64::from(height)
}
fn ranged(value: &Value, minimum: f64, maximum: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.is_finite() && number >= minimum && number <= maximum)
}
pub fn valid_document(document: &Document) -> bool {
    if document.width == 0
        || document.height == 0
        || u64::from(document.width) * u64::from(document.height) > MAX_PIXELS
        || !integer(document.revision)
        || document.revision < 0.0
        || !integer(document.next_number)
        || document.next_number <= 0.0
        || !rect(&document.crop, document.width, document.height)
        || document.annotations.len() > 1000
    {
        return false;
    }
    if document.source_rect.as_ref().is_some_and(|source| {
        !rect(source, document.width, document.height)
            || !integer(source.width)
            || !integer(source.height)
    }) {
        return false;
    }
    let mut ids = HashSet::new();
    document.annotations.iter().all(|annotation| {
        let Some(id) = annotation["id"].as_str() else {
            return false;
        };
        let Some(points) = annotation["points"].as_array() else {
            return false;
        };
        let style = &annotation["style"];
        let color = style["color"].as_str().unwrap_or("");
        ids.insert(id)
            && matches!(
                annotation["kind"].as_str(),
                Some(
                    "pen"
                        | "highlighter"
                        | "line"
                        | "arrow"
                        | "rectangle"
                        | "ellipse"
                        | "text"
                        | "number"
                        | "mosaic"
                        | "blur"
                        | "cover"
                )
            )
            && !points.is_empty()
            && points.len() <= 20000
            && points
                .iter()
                .all(|value| match (value["x"].as_f64(), value["y"].as_f64()) {
                    (Some(coordinate_x), Some(coordinate_y)) => point(coordinate_x, coordinate_y),
                    _ => false,
                })
            && color.len() == 7
            && color.starts_with('#')
            && color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
            && ranged(&style["width"], 1.0, 200.0)
            && ranged(&style["fontSize"], 8.0, 200.0)
            && ranged(&style["strength"], 1.0, 80.0)
            && style["filled"].is_boolean()
            && matches!(style["mode"].as_str(), Some("rectangle" | "brush"))
            && annotation.get("text").is_none_or(|text| {
                text.as_str()
                    .is_some_and(|text| text.encode_utf16().count() <= 5000)
            })
            && annotation.get("number").is_none_or(|value| {
                value
                    .as_f64()
                    .is_some_and(|number| integer(number) && number > 0.0)
            })
    })
}
impl Packet {
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
    pub fn prepared(
        document: Document,
        action: Action,
        png: &[u8],
        jpeg: &[u8],
    ) -> Result<Self, String> {
        let metadata = serde_json::to_vec(&serde_json::json!({"requestId":uuid::Uuid::new_v4().to_string(),"document":document,"action":action,"pngLength":png.len(),"jpegLength":jpeg.len()})).map_err(|error| error.to_string())?;
        let mut bytes = (metadata.len() as u32).to_le_bytes().to_vec();
        bytes.extend(metadata);
        bytes.extend(png);
        bytes.extend(jpeg);
        Self::parse(bytes)
    }
    pub fn parse(bytes: Vec<u8>) -> Result<Self, String> {
        if bytes.len() < 4 || bytes.len() > 4 + MAX_METADATA + MAX_BYTES * 2 {
            return Err("截图输出请求无效或过大".into());
        }
        let length = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
        if length == 0 || length > MAX_METADATA || 4 + length > bytes.len() {
            return Err("截图文档元数据无效或超过 16 MiB".into());
        }
        let metadata: Metadata = serde_json::from_slice(&bytes[4..4 + length])
            .map_err(|error| format!("编辑数据无效：{error}"))?;
        if metadata.request_id.encode_utf16().count() > 128
            || !valid_document(&metadata.document)
            || metadata
                .format
                .as_ref()
                .is_some_and(|format| !matches!(format.as_str(), "png" | "jpg"))
            || metadata.png_length > MAX_BYTES
            || metadata.jpeg_length > MAX_BYTES
            || metadata.png_length + metadata.jpeg_length != bytes.len() - 4 - length
        {
            return Err("截图输出数据无效或过大（单图最大 32 MB）".into());
        }
        let digest = Sha256::digest(&bytes).into();
        Ok(Self {
            metadata,
            digest,
            bytes,
            start: 4 + length,
        })
    }
    pub fn png(&self) -> &[u8] {
        &self.bytes[self.start..self.start + self.metadata.png_length]
    }
    pub fn jpeg(&self) -> &[u8] {
        &self.bytes[self.start + self.metadata.png_length..]
    }
    pub fn image(&self) -> Result<DynamicImage, String> {
        if image::guess_format(self.png()).ok() != Some(ImageFormat::Png) {
            return Err("截图导出数据必须是 PNG 图片".into());
        }
        let image = crate::clipboard::decode_image_limited(self.png(), MAX_PIXELS)?;
        let crop = &self.metadata.document.crop;
        if f64::from(image.width()) != crop.width || f64::from(image.height()) != crop.height {
            return Err("导出图片与选区尺寸不一致".into());
        }
        Ok(image)
    }
    pub fn jpeg_output(&self, image: &DynamicImage) -> Result<Vec<u8>, String> {
        if !self.jpeg().is_empty() {
            if image::guess_format(self.jpeg()).ok() != Some(ImageFormat::Jpeg) {
                return Err("JPEG 导出数据无效".into());
            }
            let converted = crate::clipboard::decode_image_limited(self.jpeg(), MAX_PIXELS)?;
            if converted.width() != image.width() || converted.height() != image.height() {
                return Err("JPEG 导出尺寸不一致".into());
            }
            return Ok(self.jpeg().to_vec());
        }
        let mut output = Cursor::new(Vec::new());
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 92)
            .encode_image(&DynamicImage::ImageRgb8(image.to_rgb8()))
            .map_err(|error| error.to_string())?;
        if output.get_ref().len() > MAX_BYTES {
            return Err("JPEG 导出过大（最大 32 MB）".into());
        }
        Ok(output.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screenshot::{self, Service};
    use serde_json::json;
    fn sample() -> (Service, Document, Vec<u8>) {
        let image = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            3,
            2,
            image::Rgba([20, 70, 190, 128]),
        ));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        let bytes = bytes.into_inner();
        let service = Service::default();
        let document = service
            .create(0, screenshot::decode(&bytes).unwrap(), || Ok(()))
            .unwrap();
        (service, document, bytes)
    }
    fn packet(document: &Document, png: &[u8]) -> Packet {
        let metadata = serde_json::to_vec(&json!({"requestId":"same-request","document":document,"action":"save","format":"png","pngLength":png.len(),"jpegLength":0})).unwrap();
        let mut bytes = (metadata.len() as u32).to_le_bytes().to_vec();
        bytes.extend(metadata);
        bytes.extend(png);
        Packet::parse(bytes).unwrap()
    }
    #[test]
    fn document_validation_keeps_fractional_geometry_and_all_annotation_constraints() {
        let (_, mut document, _) = sample();
        document.crop.x = 0.25;
        document.crop.width = 2.5;
        let annotation = json!({"id":"one","kind":"rectangle","points":[{"x":-10.5,"y":32768}],"style":{"color":"#aB09Ff","width":1,"fontSize":200,"strength":80,"filled":false,"mode":"rectangle"},"text":"🪶".repeat(2500),"number":1});
        document.annotations = vec![annotation.clone()];
        assert!(valid_document(&document));
        for (pointer, value) in [
            ("/kind", json!("unknown")),
            ("/style/color", json!("#GGGGGG")),
            ("/style/filled", json!(0)),
            ("/style/width", json!(201)),
            ("/style/fontSize", json!(7)),
            ("/style/strength", json!(0)),
            ("/style/mode", json!("arbitrary")),
            ("/points/0/x", json!(32769)),
            ("/points", json!([])),
            ("/text", json!("🪶".repeat(2501))),
            ("/number", json!(1.5)),
        ] {
            let mut invalid = document.clone();
            *invalid.annotations[0].pointer_mut(pointer).unwrap() = value;
            assert!(!valid_document(&invalid), "{pointer}");
        }
        document.annotations.push(annotation);
        assert!(!valid_document(&document));
        document.annotations.clear();
        document.revision = f64::INFINITY;
        assert!(!valid_document(&document));
    }
    #[test]
    fn wire_format_is_exact_bounded_and_rejects_trailing_bytes_or_non_png_pixels() {
        let (_, document, png) = sample();
        let packet = packet(&document, &png);
        assert_eq!(packet.png(), png);
        packet.image().unwrap();
        let mut truncated = packet.bytes.clone();
        truncated.pop();
        assert!(Packet::parse(truncated).is_err());
        let mut trailing = packet.bytes.clone();
        trailing.push(0);
        assert!(Packet::parse(trailing).is_err());
        for bytes in [Vec::new(), vec![255; 4], vec![0; 4]] {
            assert!(Packet::parse(bytes).is_err());
        }
        let bad = super::tests::packet(&document, b"GIF89a");
        assert!(bad.image().is_err());
        let mut cropped = document.clone();
        cropped.crop.width = 2.0;
        assert!(super::tests::packet(&cropped, &png).image().is_err());
        let converted = packet.jpeg_output(&packet.image().unwrap()).unwrap();
        assert_eq!(image::guess_format(&converted).unwrap(), ImageFormat::Jpeg);
    }
    #[test]
    fn failed_outputs_do_not_commit_and_successes_are_identity_bound_and_deduplicated() {
        let (service, mut document, png) = sample();
        document.revision = 1.0;
        let packet = packet(&document, &png);
        assert!(service
            .transact(0, &packet, || Ok(()), || Err("disk failed".into()))
            .is_err());
        assert_eq!(service.read(&document.id).unwrap().0.revision, 0.0);
        assert!(service.check_finish(0, &packet).unwrap().is_none());
        let output = service
            .transact(
                0,
                &packet,
                || Ok(()),
                || {
                    Ok(Output {
                        ok: true,
                        path: Some("saved.png".into()),
                        ..Output::default()
                    })
                },
            )
            .unwrap();
        assert_eq!(service.read(&document.id).unwrap().0.revision, 1.0);
        assert_eq!(
            service
                .transact(
                    0,
                    &packet,
                    || Ok(()),
                    || panic!("Duplicate must not run native effects")
                )
                .unwrap()
                .path,
            output.path
        );
        let mut changed = packet.metadata.document.clone();
        changed.crop.width = 2.0;
        assert!(service
            .check_finish(0, &super::tests::packet(&changed, &png))
            .is_err());
        service.cancel_pending();
        assert!(service
            .transact(
                0,
                &packet,
                || Ok(()),
                || panic!("Cancelled output must not run")
            )
            .is_err());
        assert_eq!(service.read(&document.id).unwrap().1.as_ref(), png);
    }
    #[test]
    fn successful_output_cache_does_not_grant_cross_window_ownership() {
        let (service, document, png) = sample();
        let main = packet(&document, &png);
        assert!(service
            .transact_owned(
                0,
                &main,
                "screenshot-overlay-exact",
                || Ok(()),
                || panic!("Cross-owner effect must not run")
            )
            .is_err());
        let owned = service
            .create_owned(
                0,
                crate::screenshot::decode(&png).unwrap(),
                "screenshot-overlay-exact",
                || Ok(()),
            )
            .unwrap();
        let overlay = packet(&owned, &png);
        service
            .transact_owned(
                0,
                &overlay,
                "screenshot-overlay-exact",
                || Ok(()),
                || {
                    Ok(Output {
                        ok: true,
                        ..Output::default()
                    })
                },
            )
            .unwrap();
        assert!(service
            .check_finish_owned(0, &overlay, "workspace-main")
            .is_err());
        assert!(service
            .check_finish_owned(0, &overlay, "screenshot-overlay-other")
            .is_err());
        assert!(service
            .check_finish_owned(0, &overlay, "screenshot-overlay-exact")
            .unwrap()
            .is_some());
    }
}
