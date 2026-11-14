use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicIsize, Ordering},
        Arc, Mutex,
    },
};
use windows::{
    core::{implement, Interface, Ref, BOOL, HRESULT, PCWSTR},
    Win32::{
        Foundation::HWND,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        },
        System::Ole::IOleWindow,
        UI::{
            Shell::*,
            WindowsAndMessaging::{PostMessageW, SW_SHOWNORMAL, WM_CLOSE},
        },
    },
};

const CHOOSE_FOLDER: u32 = 2001;
const CANCELLED: HRESULT = HRESULT(0x800704c7u32 as i32);
pub(super) struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
pub(super) fn apartment() -> Result<Apartment, String> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|error| error.to_string())?;
    }
    Ok(Apartment)
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn filesystem_path(item: &IShellItem) -> windows::core::Result<PathBuf> {
    unsafe {
        let value = item.GetDisplayName(SIGDN_FILESYSPATH)?;
        let text = value.to_string();
        CoTaskMemFree(Some(value.0.cast()));
        Ok(text.map(PathBuf::from)?)
    }
}

#[implement(IFileDialogEvents, IFileDialogControlEvents)]
struct DialogEvents {
    chosen: Arc<Mutex<Option<PathBuf>>>,
    handle: Arc<AtomicIsize>,
    cancelled: Arc<AtomicBool>,
}
impl IFileDialogEvents_Impl for DialogEvents_Impl {
    fn OnFileOk(&self, _: Ref<IFileDialog>) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnFolderChanging(
        &self,
        _: Ref<IFileDialog>,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnFolderChange(&self, dialog: Ref<IFileDialog>) -> windows::core::Result<()> {
        unsafe {
            let window: IOleWindow = dialog.ok()?.cast()?;
            self.handle
                .store(window.GetWindow()?.0 as isize, Ordering::SeqCst);
            if self.cancelled.load(Ordering::SeqCst) {
                dialog.ok()?.Close(CANCELLED)?;
            }
        }
        Ok(())
    }
    fn OnSelectionChange(&self, _: Ref<IFileDialog>) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnShareViolation(
        &self,
        _: Ref<IFileDialog>,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<FDE_SHAREVIOLATION_RESPONSE> {
        Ok(FDESVR_DEFAULT)
    }
    fn OnTypeChange(&self, _: Ref<IFileDialog>) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnOverwrite(
        &self,
        _: Ref<IFileDialog>,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<FDE_OVERWRITE_RESPONSE> {
        Ok(FDEOR_DEFAULT)
    }
}
impl IFileDialogControlEvents_Impl for DialogEvents_Impl {
    fn OnItemSelected(
        &self,
        _: Ref<IFileDialogCustomize>,
        _: u32,
        _: u32,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnButtonClicked(
        &self,
        control: Ref<IFileDialogCustomize>,
        id: u32,
    ) -> windows::core::Result<()> {
        if id == CHOOSE_FOLDER {
            unsafe {
                let dialog: IFileDialog = control.ok()?.cast()?;
                let selected = filesystem_path(&dialog.GetFolder()?)?;
                *self.chosen.lock().map_err(|_| {
                    windows::core::Error::from_hresult(HRESULT(0x80004005u32 as i32))
                })? = Some(selected);
                dialog.Close(HRESULT(0))?;
            }
        }
        Ok(())
    }
    fn OnCheckButtonToggled(
        &self,
        _: Ref<IFileDialogCustomize>,
        _: u32,
        _: BOOL,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnControlActivating(
        &self,
        _: Ref<IFileDialogCustomize>,
        _: u32,
    ) -> windows::core::Result<()> {
        Ok(())
    }
}
struct DialogHandle(Arc<AtomicIsize>);
impl Drop for DialogHandle {
    fn drop(&mut self) {
        self.0.store(0, Ordering::SeqCst);
    }
}

pub fn pick(
    owner: isize,
    title: String,
    folder_only: bool,
    images_only: bool,
    drafts_only: bool,
    handle: Arc<AtomicIsize>,
    cancelled: Arc<AtomicBool>,
) -> Result<Option<PathBuf>, String> {
    let _apartment = apartment()?;
    let _handle = DialogHandle(handle.clone());
    let outcome = unsafe {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| error.to_string())?;
        let mut options = dialog.GetOptions().map_err(|error| error.to_string())?
            | FOS_FORCEFILESYSTEM
            | FOS_PATHMUSTEXIST
            | FOS_FILEMUSTEXIST
            | FOS_NOCHANGEDIR
            | FOS_DONTADDTORECENT;
        if folder_only {
            options |= FOS_PICKFOLDERS;
        }
        dialog
            .SetOptions(options)
            .map_err(|error| error.to_string())?;
        if images_only || drafts_only {
            let name = wide(if drafts_only {
                "草稿迁移包"
            } else {
                "图片"
            });
            let extensions = wide(if drafts_only {
                "*.json"
            } else {
                "*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp"
            });
            dialog
                .SetFileTypes(&[Common::COMDLG_FILTERSPEC {
                    pszName: PCWSTR(name.as_ptr()),
                    pszSpec: PCWSTR(extensions.as_ptr()),
                }])
                .map_err(|error| error.to_string())?;
        }
        let title = wide(&title);
        dialog
            .SetTitle(PCWSTR(title.as_ptr()))
            .map_err(|error| error.to_string())?;
        let chosen = Arc::new(Mutex::new(None));
        let events: IFileDialogEvents = DialogEvents {
            chosen: chosen.clone(),
            handle,
            cancelled,
        }
        .into();
        if !folder_only && !images_only && !drafts_only {
            let customize: IFileDialogCustomize =
                dialog.cast().map_err(|error| error.to_string())?;
            let label = wide("选择当前文件夹");
            customize
                .AddPushButton(CHOOSE_FOLDER, PCWSTR(label.as_ptr()))
                .map_err(|error| error.to_string())?;
        }
        let cookie = dialog.Advise(&events).map_err(|error| error.to_string())?;
        let result = dialog.Show(Some(HWND(owner as *mut _)));
        let _ = dialog.Unadvise(cookie);
        match result {
            Err(error) if error.code() == CANCELLED => Ok(None),
            Err(error) => Err(error.to_string()),
            Ok(()) => {
                let custom = chosen.lock().map_err(|error| error.to_string())?.take();
                let path = match custom {
                    Some(path) => path,
                    None => {
                        filesystem_path(&dialog.GetResult().map_err(|error| error.to_string())?)
                            .map_err(|error| error.to_string())?
                    }
                };
                Ok(Some(path))
            }
        }
    };
    outcome
}

pub fn pick_tool_paths(
    owner: isize,
    folder: bool,
    images: bool,
    handle: Arc<AtomicIsize>,
    cancelled: Arc<AtomicBool>,
) -> Result<Option<Vec<PathBuf>>, String> {
    let _apartment = apartment()?;
    let _handle = DialogHandle(handle.clone());
    unsafe {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| error.to_string())?;
        let mut options = dialog.GetOptions().map_err(|error| error.to_string())?
            | FOS_FORCEFILESYSTEM
            | FOS_PATHMUSTEXIST
            | FOS_FILEMUSTEXIST
            | FOS_NOCHANGEDIR
            | FOS_DONTADDTORECENT
            | FOS_ALLOWMULTISELECT;
        if folder {
            options |= FOS_PICKFOLDERS;
        }
        dialog
            .SetOptions(options)
            .map_err(|error| error.to_string())?;
        let title = wide(if images {
            "导入图片"
        } else if folder {
            "选择发送文件夹"
        } else {
            "选择发送文件"
        });
        dialog
            .SetTitle(PCWSTR(title.as_ptr()))
            .map_err(|error| error.to_string())?;
        let name = wide("静态图片");
        let extensions = wide("*.png;*.jpg;*.jpeg;*.webp");
        if images {
            dialog
                .SetFileTypes(&[Common::COMDLG_FILTERSPEC {
                    pszName: PCWSTR(name.as_ptr()),
                    pszSpec: PCWSTR(extensions.as_ptr()),
                }])
                .map_err(|error| error.to_string())?;
        }
        let events: IFileDialogEvents = DialogEvents {
            chosen: Arc::new(Mutex::new(None)),
            handle,
            cancelled,
        }
        .into();
        let cookie = dialog.Advise(&events).map_err(|error| error.to_string())?;
        let result = dialog.Show(Some(HWND(owner as *mut _)));
        let _ = dialog.Unadvise(cookie);
        match result {
            Err(error) if error.code() == CANCELLED => Ok(None),
            Err(error) => Err(error.to_string()),
            Ok(()) => {
                let items = dialog.GetResults().map_err(|error| error.to_string())?;
                let count = items.GetCount().map_err(|error| error.to_string())?;
                if count > 10000 {
                    return Err("一次最多导入 10000 项".into());
                }
                let mut paths = Vec::new();
                for index in 0..count {
                    paths.push(
                        filesystem_path(
                            &items.GetItemAt(index).map_err(|error| error.to_string())?,
                        )
                        .map_err(|error| error.to_string())?,
                    );
                }
                Ok(Some(paths))
            }
        }
    }
}

pub fn save_export(
    owner: isize,
    default_path: PathBuf,
    kind: super::ExportKind,
    handle: Arc<AtomicIsize>,
    cancelled: Arc<AtomicBool>,
) -> Result<Option<PathBuf>, String> {
    let _apartment = apartment()?;
    let _handle = DialogHandle(handle.clone());
    unsafe {
        let dialog: IFileSaveDialog = CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| error.to_string())?;
        let options = dialog.GetOptions().map_err(|error| error.to_string())?
            | FOS_FORCEFILESYSTEM
            | FOS_PATHMUSTEXIST
            | FOS_NOCHANGEDIR
            | FOS_DONTADDTORECENT
            | FOS_OVERWRITEPROMPT;
        dialog
            .SetOptions(options)
            .map_err(|error| error.to_string())?;
        let image_filter = match &kind {
            super::ExportKind::Images { extension, .. } if extension == "jpg" => {
                "*.jpg;*.jpeg".into()
            }
            super::ExportKind::Images { extension, .. } => format!("*.{extension}"),
            _ => String::new(),
        };
        let (first_name, first_extension, second_name, second_extension, extension, title) =
            match &kind {
                super::ExportKind::Projects => (
                    "Excel 工作簿",
                    "*.xlsx",
                    "CSV 文件",
                    "*.csv",
                    "xlsx",
                    "导出项目管理",
                ),
                super::ExportKind::Text => (
                    "文本",
                    "*.txt;*.json",
                    "所有文件",
                    "*.*",
                    "txt",
                    "导出 UTF-8 文本",
                ),
                super::ExportKind::Drafts => (
                    "草稿迁移包",
                    "*.json",
                    "JSON 文件",
                    "*.json",
                    "json",
                    "导出迁移草稿",
                ),
                super::ExportKind::Screenshots { extension, .. } => (
                    "PNG 图片",
                    "*.png",
                    "JPEG 图片",
                    "*.jpg;*.jpeg",
                    extension.as_str(),
                    "另存为截图",
                ),
                super::ExportKind::Images { extension, .. } => (
                    if extension == "zip" {
                        "ZIP 压缩包"
                    } else {
                        "图片"
                    },
                    image_filter.as_str(),
                    "所有文件",
                    "*.*",
                    extension.as_str(),
                    if extension == "zip" {
                        "保存图片压缩包"
                    } else {
                        "保存图片"
                    },
                ),
            };
        let first_name = wide(first_name);
        let first_extension = wide(first_extension);
        let second_name = wide(second_name);
        let second_extension = wide(second_extension);
        dialog
            .SetFileTypes(&[
                Common::COMDLG_FILTERSPEC {
                    pszName: PCWSTR(first_name.as_ptr()),
                    pszSpec: PCWSTR(first_extension.as_ptr()),
                },
                Common::COMDLG_FILTERSPEC {
                    pszName: PCWSTR(second_name.as_ptr()),
                    pszSpec: PCWSTR(second_extension.as_ptr()),
                },
            ])
            .map_err(|error| error.to_string())?;
        let extension = wide(extension);
        dialog
            .SetDefaultExtension(PCWSTR(extension.as_ptr()))
            .map_err(|error| error.to_string())?;
        if matches!(&kind,super::ExportKind::Screenshots {extension,..} if extension == "jpg") {
            dialog
                .SetFileTypeIndex(2)
                .map_err(|error| error.to_string())?;
        }
        let title = wide(title);
        dialog
            .SetTitle(PCWSTR(title.as_ptr()))
            .map_err(|error| error.to_string())?;
        if let Some(name) = default_path.file_name().and_then(|name| name.to_str()) {
            let name = wide(name);
            dialog
                .SetFileName(PCWSTR(name.as_ptr()))
                .map_err(|error| error.to_string())?;
        }
        let folder = if matches!(&kind, super::ExportKind::Screenshots { .. }) {
            default_path
                .ancestors()
                .skip(1)
                .find(|parent| parent.is_dir())
        } else {
            default_path.parent()
        };
        if let Some(parent) = folder.and_then(|parent| parent.to_str()) {
            let parent = wide(parent);
            let folder: IShellItem = SHCreateItemFromParsingName(PCWSTR(parent.as_ptr()), None)
                .map_err(|error| error.to_string())?;
            dialog
                .SetDefaultFolder(&folder)
                .map_err(|error| error.to_string())?;
        }
        let events: IFileDialogEvents = DialogEvents {
            chosen: Arc::new(Mutex::new(None)),
            handle,
            cancelled,
        }
        .into();
        let cookie = dialog.Advise(&events).map_err(|error| error.to_string())?;
        let result = dialog.Show(Some(HWND(owner as *mut _)));
        let _ = dialog.Unadvise(cookie);
        match result {
            Err(error) if error.code() == CANCELLED => Ok(None),
            Err(error) => Err(error.to_string()),
            Ok(()) => filesystem_path(&dialog.GetResult().map_err(|error| error.to_string())?)
                .map(Some)
                .map_err(|error| error.to_string()),
        }
    }
}

pub fn cancel(handle: isize) {
    if handle != 0 {
        unsafe {
            let _ = PostMessageW(
                Some(HWND(handle as *mut _)),
                WM_CLOSE,
                Default::default(),
                Default::default(),
            );
        }
    }
}

pub fn open(owner: isize, target: String) -> Result<(), String> {
    let _apartment = apartment()?;
    let target = wide(&target);
    let verb = wide("open");
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        hwnd: HWND(owner as *mut _),
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(target.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    unsafe { ShellExecuteExW(&mut info).map_err(|error| format!("无法打开资源：{error}")) }
}

pub fn reveal(target: &str) -> Result<(), String> {
    let _apartment = apartment()?;
    struct Item(*mut Common::ITEMIDLIST);
    impl Drop for Item {
        fn drop(&mut self) {
            unsafe {
                CoTaskMemFree(Some(self.0.cast()));
            }
        }
    }
    let name = wide(target);
    let mut item = Item(std::ptr::null_mut());
    unsafe {
        SHParseDisplayName(PCWSTR(name.as_ptr()), None, &mut item.0, 0, None)
            .map_err(|error| format!("无法定位资源：{error}"))?;
        SHOpenFolderAndSelectItems(item.0, None, 0)
            .map_err(|error| format!("无法在资源管理器中显示：{error}"))
    }
}
