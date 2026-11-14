use super::{
    active, digest_file, hash, names, object_name, valid_hash, validate, Directory, Entry,
    FileIdentity, Manifest, OwnedFile, SourceStamp, MANIFEST, MAX_MANIFEST_BYTES,
};
use sha2::{Digest, Sha256};
use std::{fs, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(crate) struct File {
    file: OwnedFile,
    stamp: SourceStamp,
    read_only: bool,
    sha256: String,
}

impl File {
    pub(crate) fn read_verified(
        &mut self,
        maximum: usize,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
        active(cancel, current)?;
        self.confirm()?;
        if self.stamp.size > maximum as u64 {
            return Err("已固定目标文件超过读取上限".into());
        }
        let mut bytes = zeroize::Zeroizing::new(Vec::new());
        bytes
            .try_reserve_exact(self.stamp.size as usize)
            .map_err(|error| error.to_string())?;
        self.file.seek(0).map_err(|error| error.to_string())?;
        let mut buffer = zeroize::Zeroizing::new([0_u8; 64 * 1024]);
        loop {
            active(cancel, current)?;
            let count = self
                .file
                .read_chunk(&mut buffer[..], cancel)
                .map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            if bytes
                .len()
                .checked_add(count)
                .is_none_or(|length| length as u64 > self.stamp.size)
            {
                return Err("已固定目标文件读取期间大小已变化".into());
            }
            bytes.extend_from_slice(&buffer[..count]);
        }
        if bytes.len() as u64 != self.stamp.size || hash(&bytes) != self.sha256 {
            return Err("已固定目标文件读取期间完整摘要不匹配".into());
        }
        self.confirm()?;
        active(cancel, current)?;
        Ok(bytes)
    }

    pub(super) fn copy_to(
        &mut self,
        destination: &mut OwnedFile,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        active(cancel, current)?;
        self.confirm()?;
        self.file.seek(0).map_err(|error| error.to_string())?;
        let mut digest = Sha256::new();
        let mut copied = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            active(cancel, current)?;
            let count = self
                .file
                .read_chunk(&mut buffer, cancel)
                .map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            copied = copied
                .checked_add(count as u64)
                .filter(|size| *size <= self.stamp.size)
                .ok_or("运行目录恢复期间快照对象大小已变化")?;
            destination
                .write_all(&buffer[..count])
                .map_err(|error| super::failure("恢复运行文件", &destination.path(), error))?;
            digest.update(&buffer[..count]);
        }
        if copied != self.stamp.size || format!("{:x}", digest.finalize()) != self.sha256 {
            return Err("运行目录恢复期间快照对象完整摘要不匹配".into());
        }
        destination
            .sync()
            .map_err(|error| super::failure("刷新运行文件", &destination.path(), error))?;
        if digest_file(destination, copied, cancel, current)? != self.sha256 {
            return Err("运行目录落盘文件完整摘要不匹配".into());
        }
        self.confirm()?;
        active(cancel, current)
    }

    pub(crate) fn capture(file: OwnedFile, sha256: String) -> Result<Self, String> {
        file.require_single_link()
            .map_err(|error| error.to_string())?;
        let stamp = file.source_stamp().map_err(|error| error.to_string())?;
        let read_only = fs::metadata(file.path())
            .map_err(|error| error.to_string())?
            .permissions()
            .readonly();
        Ok(Self {
            file,
            stamp,
            read_only,
            sha256,
        })
    }

    pub(crate) fn confirm(&self) -> Result<(), String> {
        self.file
            .require_single_link()
            .map_err(|error| error.to_string())?;
        if self
            .file
            .source_stamp()
            .map_err(|error| error.to_string())?
            != self.stamp
            || fs::metadata(self.file.path())
                .map_err(|error| error.to_string())?
                .permissions()
                .readonly()
                != self.read_only
        {
            return Err("已固定目标文件的物理身份、大小、时间或属性已变化".into());
        }
        Ok(())
    }

    pub(crate) fn verify(
        &mut self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        active(cancel, current)?;
        self.confirm()?;
        if digest_file(&mut self.file, self.stamp.size, cancel, current)? != self.sha256 {
            return Err("已固定目标文件的完整摘要不匹配".into());
        }
        self.confirm()?;
        active(cancel, current)
    }
}

pub(super) struct Data {
    pub(super) root: Arc<Directory>,
    pub(super) manifest: Manifest,
    objects: Arc<Directory>,
    publication: File,
    files: Vec<File>,
    expected: Vec<String>,
}

impl Data {
    pub(super) fn materialize(
        &mut self,
        destination: &std::path::Path,
        id: &str,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<super::runtime_data::PreparedData, String> {
        self.confirm(cancel, current)?;
        let result = super::runtime_data::PreparedData::create(
            &self.manifest,
            &mut self.files,
            destination,
            id,
            cancel,
            current,
        )?;
        self.confirm(cancel, current)?;
        Ok(result)
    }

    pub(super) fn capture(
        root: Arc<Directory>,
        manifest_sha256: &str,
        expected_identity: Option<&FileIdentity>,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        active(cancel, current)?;
        if !valid_hash(manifest_sha256) {
            return Err("快照清单摘要无效".into());
        }
        if expected_identity.is_some_and(|identity| root.identity().as_ref().ok() != Some(identity))
        {
            return Err("快照物理目录与原生回执不匹配，复制包不是原目录授权".into());
        }
        let mut publication = root.read(MANIFEST).map_err(|error| error.to_string())?;
        let bytes = publication
            .read_bounded(MAX_MANIFEST_BYTES)
            .map_err(|error| error.to_string())?;
        if hash(&bytes) != manifest_sha256 {
            return Err("快照清单摘要不匹配".into());
        }
        let manifest: Manifest =
            serde_json::from_slice(&bytes).map_err(|error| format!("快照清单格式无效：{error}"))?;
        validate(&manifest)?;
        let publication = File::capture(publication, manifest_sha256.to_owned())?;
        let objects = root
            .child("objects", false)
            .map_err(|error| error.to_string())?;
        let expected: Vec<_> = manifest
            .entries
            .iter()
            .filter_map(|entry| match entry {
                Entry::File { object, .. } => Some(object_name(*object)),
                _ => None,
            })
            .collect();
        if names(&root)? != ["objects", MANIFEST] || names(&objects)? != expected {
            return Err("快照对象列表不完整或含额外内容".into());
        }
        let mut files = Vec::with_capacity(expected.len());
        for entry in &manifest.entries {
            active(cancel, current)?;
            if let Entry::File {
                object,
                stamp,
                sha256,
                ..
            } = entry
            {
                let file = objects
                    .read(&object_name(*object))
                    .map_err(|error| error.to_string())?;
                if file.size().map_err(|error| error.to_string())? != stamp.size {
                    return Err("快照文件大小不匹配".into());
                }
                files.push(File::capture(file, sha256.clone())?);
            }
        }
        let mut target = Self {
            root,
            manifest,
            objects,
            publication,
            files,
            expected,
        };
        target.verify(cancel, current)?;
        Ok(target)
    }

    pub(super) fn confirm(
        &self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        active(cancel, current)?;
        if names(&self.root)? != ["objects", MANIFEST] || names(&self.objects)? != self.expected {
            return Err("快照核验期间对象列表发生变化".into());
        }
        self.publication.confirm()?;
        for file in &self.files {
            active(cancel, current)?;
            file.confirm()?;
        }
        active(cancel, current)
    }

    pub(super) fn verify(
        &mut self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        self.confirm(cancel, current)?;
        self.publication.verify(cancel, current)?;
        for file in &mut self.files {
            file.verify(cancel, current)?;
        }
        self.confirm(cancel, current)
    }
}
