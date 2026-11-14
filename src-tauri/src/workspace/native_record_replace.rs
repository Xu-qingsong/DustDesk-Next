use super::ownership::{inspect_file, NativeIdentity};
use std::{
    fs::{File, OpenOptions},
    io,
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    path::{Component, Path},
};
use windows::Win32::{
    Foundation::HANDLE,
    Storage::FileSystem::{
        FileRenameInfoEx, SetFileInformationByHandle, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_RENAME_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    },
};

fn plain_identity(file: &File) -> io::Result<NativeIdentity> {
    let info = inspect_file(file).map_err(io::Error::other)?;
    if !file.metadata()?.is_file() || info.reparse || info.links != 1 {
        return Err(io::Error::other("原生记录必须为单硬链接普通文件"));
    }
    Ok(info.identity)
}

fn pin_parents(parent: &Path) -> io::Result<Vec<File>> {
    let mut handles = Vec::new();
    for ancestor in parent.ancestors().collect::<Vec<_>>().into_iter().rev() {
        let file = OpenOptions::new()
            .access_mode(0x80)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
            .open(ancestor)?;
        if !file.metadata()?.is_dir() || inspect_file(&file).map_err(io::Error::other)?.reparse {
            return Err(io::Error::other("原生记录父路径不是普通目录"));
        }
        handles.push(file);
    }
    Ok(handles)
}

fn reader(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_DELETE.0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)
}

fn replace_inner(source: &Path, target: &Path) -> io::Result<()> {
    if !source.is_absolute()
        || !target.is_absolute()
        || source == target
        || source.parent() != target.parent()
        || source
            .components()
            .chain(target.components())
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        || !matches!(
            target.file_name().and_then(|name| name.to_str()),
            Some("MigrationTransaction.json" | "MigrationBrowserJournal.json")
        )
    {
        return Err(io::Error::other("原生记录替换路径无效"));
    }
    let _parents = pin_parents(
        target
            .parent()
            .ok_or_else(|| io::Error::other("原生记录缺少父目录"))?,
    )?;
    let source_file = OpenOptions::new()
        .access_mode(0x8001_0000)
        .share_mode(FILE_SHARE_READ.0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(source)?;
    let source_identity = plain_identity(&source_file)?;
    let target_file = reader(target)?;
    let target_identity = plain_identity(&target_file)?;
    if source_identity == target_identity {
        return Err(io::Error::other("原生记录源与目标身份相同"));
    }
    if target_file.metadata()?.permissions().readonly() {
        return Err(io::Error::from_raw_os_error(5));
    }
    let current = reader(target)?;
    if plain_identity(&current)? != target_identity {
        return Err(io::Error::other("原生记录目标身份已变化"));
    }
    let wide: Vec<u16> = target.as_os_str().encode_wide().collect();
    let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    let length = (offset + (wide.len() + 1) * 2).max(std::mem::size_of::<FILE_RENAME_INFO>());
    let mut buffer = vec![0_u64; length.div_ceil(8)];
    let pointer = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*pointer).Anonymous.Flags = 0x0000_0001 | 0x0000_0002;
        (*pointer).RootDirectory = HANDLE::default();
        (*pointer).FileNameLength =
            u32::try_from(wide.len() * 2).map_err(|_| io::Error::other("原生记录目标路径过长"))?;
        std::ptr::copy_nonoverlapping(wide.as_ptr(), (*pointer).FileName.as_mut_ptr(), wide.len());
        SetFileInformationByHandle(
            HANDLE(source_file.as_raw_handle()),
            FileRenameInfoEx,
            pointer.cast(),
            u32::try_from(length).map_err(|_| io::Error::other("原生记录重命名缓冲过大"))?,
        )
        .map_err(|error| io::Error::from_raw_os_error(error.code().0 & 0xffff))?;
    }
    let published = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(target)?;
    if plain_identity(&published)? != source_identity {
        return Err(io::Error::other("发布后的原生记录身份不匹配"));
    }
    Ok(())
}

pub(super) fn replace(source: &Path, target: &Path) -> Result<(), String> {
    replace_inner(source, target).map_err(|error| {
        format!(
            "原生记录原子替换失败（FileRenameInfoEx，{} -> {}）：{}；失败后即时采样：源[{}]，目标[{}]",
            source.display(), target.display(), error,
            super::replacement_path_diagnostic(source), super::replacement_path_diagnostic(target)
        )
    })
}

#[cfg(test)]
mod tests;
