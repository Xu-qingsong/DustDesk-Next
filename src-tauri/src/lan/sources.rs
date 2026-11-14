//! Locally authorized send sources. Only native host choices and previously
//! saved local task entries may reach these methods, never incoming offers.
use super::{
    files::{check_cancel, Directory, OwnedFile, SourceStamp},
    protocol::{path_key, Entry, Manifest, MAX_ENTRIES, MAX_SAFE_INTEGER},
};
use serde_json::Map;
use std::{
    collections::HashSet,
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

const STAMP: &str = "rustSourceV1";
struct Visit {
    parent: Arc<Directory>,
    name: String,
    relative: String,
}
fn selected(path: &Path) -> Result<(Arc<Directory>, String), String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("请选择普通文件或文件夹，不能发送整个盘符")?
        .to_owned();
    path_key(&name)?;
    let parent = path.parent().ok_or("发送源路径无效")?;
    Ok((Directory::open(parent).map_err(|e| e.to_string())?, name))
}
pub fn prepare(
    id: String,
    name: String,
    paths: &[PathBuf],
    cancel: &CancellationToken,
) -> Result<Manifest, String> {
    if paths.is_empty() || paths.len() > MAX_ENTRIES {
        return Err("请选择文件，一次最多发送 10000 项".into());
    }
    let mut manifest = Manifest {
        id,
        name,
        entries: Vec::new(),
        directories: Vec::new(),
        text: None,
        extra: Map::new(),
    };
    manifest.validate()?;
    let mut stack = Vec::new();
    let mut names = HashSet::new();
    for path in paths {
        check_cancel(cancel).map_err(|e| e.to_string())?;
        let (parent, name) = selected(path)?;
        let mut relative = name.clone();
        let mut suffix = 1;
        while !names.insert(relative.to_lowercase()) {
            relative = format!("{name}-{suffix}");
            suffix += 1;
        }
        path_key(&relative)?;
        stack.push(Visit {
            parent,
            name,
            relative,
        });
    }
    stack.reverse();
    let mut total = 0_u64;
    while let Some(visit) = stack.pop() {
        check_cancel(cancel).map_err(|e| e.to_string())?;
        path_key(&visit.relative)?;
        if manifest.entries.len() + manifest.directories.len() >= MAX_ENTRIES {
            return Err("一次最多发送 10000 个文件和目录".into());
        }
        let path = visit.parent.path().join(&visit.name);
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("无法检查发送源 {}：{e}", visit.relative))?;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(format!("不支持发送重解析点：{}", visit.relative));
        }
        if metadata.is_dir() {
            let directory = visit
                .parent
                .child(&visit.name, false)
                .map_err(|e| e.to_string())?;
            manifest.directories.push(visit.relative.clone());
            let mut children = Vec::new();
            for child in std::fs::read_dir(directory.path()).map_err(|e| e.to_string())? {
                check_cancel(cancel).map_err(|e| e.to_string())?;
                if manifest.entries.len()
                    + manifest.directories.len()
                    + stack.len()
                    + children.len()
                    >= MAX_ENTRIES
                {
                    return Err("一次最多发送 10000 个文件和目录".into());
                }
                let name = child
                    .map_err(|e| e.to_string())?
                    .file_name()
                    .into_string()
                    .map_err(|_| "发送文件名无法编码")?;
                let relative = format!("{}/{name}", visit.relative);
                path_key(&relative)?;
                children.push(Visit {
                    parent: directory.clone(),
                    name,
                    relative,
                });
            }
            children.sort_by(|a, b| a.name.encode_utf16().cmp(b.name.encode_utf16()));
            stack.extend(children.into_iter().rev());
        } else if metadata.is_file() {
            let mut file = visit
                .parent
                .read(&visit.name)
                .map_err(|e| format!("无法固定发送源 {}：{e}", visit.relative))?;
            let stamp = file.source_stamp().map_err(|e| e.to_string())?;
            total = total
                .checked_add(stamp.size)
                .filter(|total| *total <= MAX_SAFE_INTEGER)
                .ok_or("发送总大小超出安全范围")?;
            let hash = file.hash(stamp.size, cancel).map_err(|e| e.to_string())?;
            if file.source_stamp().map_err(|e| e.to_string())? != stamp {
                return Err(format!("发送源在准备期间变化：{}", visit.relative));
            }
            let mut extra = Map::new();
            extra.insert(
                STAMP.into(),
                serde_json::to_value(&stamp).map_err(|_| "发送源身份无法编码")?,
            );
            manifest.entries.push(Entry {
                relative: visit.relative,
                size: stamp.size,
                mtime: stamp.mtime_ms()?,
                hash,
                source: Some(path.to_str().ok_or("发送源路径无法编码")?.to_owned()),
                extra,
            });
        } else {
            return Err(format!("不支持发送特殊文件：{}", visit.relative));
        }
    }
    manifest.validate()?;
    Ok(manifest)
}

/// Reopens and verifies the actual source, preserving its exclusive handle for
/// prefix verification and streaming. Native IDs add checks to the old fields.
pub fn open(entry: &Entry, cancel: &CancellationToken) -> Result<OwnedFile, String> {
    check_cancel(cancel).map_err(|e| e.to_string())?;
    let source = Path::new(entry.source.as_deref().ok_or("发送源路径缺失")?);
    let (parent, name) = selected(source)?;
    let mut file = parent
        .read(&name)
        .map_err(|e| format!("无法读取发送源 {}：{e}", entry.relative))?;
    let stamp = file.source_stamp().map_err(|e| e.to_string())?;
    if let Some(native) = entry.extra.get(STAMP) {
        let native: SourceStamp =
            serde_json::from_value(native.clone()).map_err(|_| "发送源身份记录损坏")?;
        if native != stamp {
            return Err(format!(
                "发送源身份或时间已变化，请重新发送：{}",
                entry.relative
            ));
        }
    }
    if stamp.size != entry.size
        || stamp.mtime_ms()? != entry.mtime
        || file.hash(entry.size, cancel).map_err(|e| e.to_string())? != entry.hash
    {
        return Err(format!("发送源已变化，请重新发送：{}", entry.relative));
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::super::{files::tests::Fixture, protocol::fingerprint};
    use super::*;
    #[test]
    fn prepare_pins_sources_hashes_empty_unicode_and_strips_private_public_fields() {
        let fixture = Fixture::new();
        let source = fixture.0.join("目录😀");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(source.join("empty")).unwrap();
        std::fs::write(source.join("text.txt"), "中文😀").unwrap();
        std::fs::write(source.join("zero"), []).unwrap();
        let cancel = CancellationToken::new();
        let manifest = prepare("source-test".into(), "目录".into(), &[source], &cancel).unwrap();
        assert_eq!(manifest.directories, ["目录😀", "目录😀/empty"]);
        assert_eq!(manifest.entries.len(), 2);
        let entry = &manifest.entries[0];
        assert_eq!(entry.hash, fingerprint("中文😀".as_bytes()));
        assert!(manifest
            .public()
            .entries
            .iter()
            .all(|entry| entry.source.is_none() && entry.extra.is_empty()));
        let mut file = open(entry, &cancel).unwrap();
        assert_eq!(
            file.hash_prefix(3, &cancel).unwrap(),
            fingerprint(&"中文😀".as_bytes()[..3])
        );
        let mut buffer = [0_u8; 64];
        assert_eq!(
            file.read_chunk(&mut buffer, &cancel).unwrap(),
            "中文😀".len() - 3
        );
        assert!(std::fs::write(entry.source.as_ref().unwrap(), b"no").is_err());
        drop(file);
        std::fs::write(entry.source.as_ref().unwrap(), "同样😀").unwrap();
        assert!(open(entry, &cancel).is_err());
    }
    #[test]
    fn source_duplicates_use_legacy_top_level_suffix_and_cancel_does_not_write() {
        let fixture = Fixture::new();
        let source = fixture.0.join("a.txt");
        std::fs::write(&source, b"abc").unwrap();
        let manifest = prepare(
            "same".into(),
            "two".into(),
            &[source.clone(), source.clone()],
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(
            manifest
                .entries
                .iter()
                .map(|entry| entry.relative.as_str())
                .collect::<Vec<_>>(),
            ["a.txt", "a.txt-1"]
        );
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(prepare(
            "no".into(),
            "no".into(),
            std::slice::from_ref(&source),
            &cancel
        )
        .is_err());
        assert_eq!(std::fs::read(source).unwrap(), b"abc");
        assert!(prepare(
            "no".into(),
            "no".into(),
            &[PathBuf::from("C:\\")],
            &CancellationToken::new()
        )
        .is_err());
    }
    #[test]
    fn old_entries_without_native_stamp_still_require_exact_size_time_and_hash() {
        let fixture = Fixture::new();
        let source = fixture.0.join("old.bin");
        std::fs::write(&source, b"abc").unwrap();
        let cancel = CancellationToken::new();
        let mut entry = prepare("old".into(), "old".into(), &[source], &cancel)
            .unwrap()
            .entries
            .remove(0);
        entry.extra.clear();
        assert!(open(&entry, &cancel).is_ok());
        entry.hash = fingerprint(b"bad");
        assert!(open(&entry, &cancel).is_err());
    }
}
