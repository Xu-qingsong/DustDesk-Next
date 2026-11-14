use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[cfg(test)]
pub(crate) fn publish(path: &Path, bytes: &[u8]) -> Result<(), String> {
    publish_checked(path, bytes, || Ok(()))
}

pub(crate) fn publish_checked(
    path: &Path,
    bytes: &[u8],
    require_active: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    prepare_checked(path, bytes, &require_active)?.publish(require_active)
}
pub(crate) struct PreparedExport {
    path: PathBuf,
    temporary: super::TemporaryFile,
}
impl PreparedExport {
    pub fn publish(self, require_active: impl Fn() -> Result<(), String>) -> Result<(), String> {
        super::checked_path(&self.path)?;
        require_active()?;
        super::replace_file(&self.temporary.0, &self.path)
    }
}
pub(crate) fn prepare_checked(
    path: &Path,
    bytes: &[u8],
    require_active: impl Fn() -> Result<(), String>,
) -> Result<PreparedExport, String> {
    require_active()?;
    super::checked_path(path)?;
    let parent = path.parent().ok_or("导出目标缺少父目录")?;
    if !parent.is_dir() {
        return Err("导出目录不存在".into());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err("导出目标不是普通文件".into());
            }
            let file = OpenOptions::new()
                .read(true)
                .open(path)
                .map_err(|error| error.to_string())?;
            let identity = super::ownership::inspect_file(&file)?;
            if identity.links != 1 || identity.reparse {
                return Err("导出目标包含重解析点或多个硬链接".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let temporary =
        super::TemporaryFile(parent.join(format!(".dustdesk-export-{}.tmp", uuid::Uuid::new_v4())));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary.0)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    drop(file);
    Ok(PreparedExport {
        path: path.to_path_buf(),
        temporary,
    })
}

pub(crate) fn require_external(path: &Path, protected: &Path) -> Result<(), String> {
    let key = crate::system::path_key(path.to_str().ok_or("导出路径无效")?)?;
    let protected = crate::system::path_key(protected.to_str().ok_or("隔离数据目录无效")?)?;
    if key == protected || key.starts_with(&(protected + std::path::MAIN_SEPARATOR_STR)) {
        return Err("不能将导出覆盖到应用内部数据目录".into());
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn exact_utf8_bytes_include_empty_nul_and_newlines_without_a_bom() {
        let root = std::env::temp_dir().join(format!(
            "dustdesk-rust-text-export-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("text.txt");
        for text in ["中文🪶\r\nCafé\0end", "", "{\"ok\":true}"] {
            publish(&path, text.as_bytes()).unwrap();
            assert_eq!(fs::read(&path).unwrap(), text.as_bytes());
            assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn protected_directory_check_uses_case_insensitive_boundaries_not_a_name_prefix() {
        let root = Path::new(r"C:\Users\test\AppData\DustDesk");
        for target in [
            r"C:\Users\test\AppData\DustDesk",
            r"c:\users\test\appdata\DUSTDESK\WebView2\file.txt",
            r"C:\Users\test\AppData\DustDesk\Workspace\..\workspace.json",
        ] {
            assert!(require_external(Path::new(target), root).is_err());
        }
        for target in [
            r"C:\Users\test\AppData\DustDesk-export\file.txt",
            r"C:\Users\test\Documents\file.txt",
        ] {
            require_external(Path::new(target), root).unwrap();
        }
    }
    #[test]
    fn cancellation_after_staging_preserves_the_original_and_cleans_temporary_before_explicit_retry(
    ) {
        let root = std::env::temp_dir().join(format!(
            "dustdesk-rust-export-cancel-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("keep.txt");
        fs::write(&path, b"original").unwrap();
        let checks = std::cell::Cell::new(0);
        let error = publish_checked(&path, b"must not publish", || {
            checks.set(checks.get() + 1);
            if checks.get() == 2 {
                Err("fixture cancelled after staging".into())
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert_eq!(error, "fixture cancelled after staging");
        assert_eq!(checks.get(), 2);
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        publish(&path, b"explicit retry").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"explicit retry");
        fs::remove_dir_all(root).unwrap();
    }
}
