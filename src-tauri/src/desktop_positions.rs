//! Explorer desktop coordinates. File moves remain authoritative if Explorer is unavailable.
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct DesktopPosition {
    pub desktop: String,
    pub x: i32,
    pub y: i32,
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{
        path::PathBuf,
        time::{Duration, Instant},
    };
    use windows::{
        core::Interface,
        Win32::{
            Foundation::POINT,
            System::{
                Com::{
                    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                    IServiceProvider, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED,
                },
                Variant::VARIANT,
            },
            UI::Shell::{Common::ITEMIDLIST, *},
        },
    };

    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    struct Item(*mut ITEMIDLIST);
    impl Drop for Item {
        fn drop(&mut self) {
            unsafe { CoTaskMemFree(Some(self.0.cast())) };
        }
    }
    fn key(path: &Path) -> Option<String> {
        crate::system::path_key(path.to_str()?).ok()
    }
    pub(super) fn actual_desktop(desktop: &Path) -> bool {
        unsafe {
            let Ok(value) = SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DEFAULT, None) else {
                return false;
            };
            let path = value.to_string().ok().map(PathBuf::from);
            CoTaskMemFree(Some(value.0.cast()));
            path.as_deref().and_then(key) == key(desktop)
        }
    }
    fn view() -> windows::core::Result<IFolderView2> {
        unsafe {
            let shell: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER)?;
            let empty = VARIANT::default();
            let dispatch =
                shell.FindWindowSW(&empty, &empty, SWC_DESKTOP, &mut 0, SWFO_NEEDDISPATCH)?;
            let provider: IServiceProvider = dispatch.cast()?;
            let browser: IShellBrowser = provider.QueryService(&SID_STopLevelBrowser)?;
            browser.QueryActiveShellView()?.cast()
        }
    }
    fn item(view: &IFolderView2, path: &Path) -> windows::core::Result<Option<Item>> {
        unsafe {
            let folder: IShellFolder = view.GetFolder()?;
            for index in 0..view.ItemCount(SVGIO_ALLVIEW)? {
                let pidl = Item(view.Item(index)?);
                let Ok(shell_item): windows::core::Result<IShellItem> =
                    SHCreateItemWithParent(None, &folder, pidl.0)
                else {
                    continue;
                };
                if let Ok(value) = shell_item.GetDisplayName(SIGDN_FILESYSPATH) {
                    let candidate = value.to_string().ok().map(PathBuf::from);
                    CoTaskMemFree(Some(value.0.cast()));
                    if candidate.as_deref().and_then(key) == key(path) {
                        return Ok(Some(pidl));
                    }
                }
            }
            Ok(None)
        }
    }
    fn run<T: Send + 'static>(
        action: impl FnOnce() -> windows::core::Result<T> + Send + 'static,
    ) -> Option<T> {
        std::thread::spawn(move || {
            unsafe {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
            }
            let _apartment = Apartment;
            action()
        })
        .join()
        .ok()?
        .ok()
    }
    pub(super) fn capture(desktop: &Path, path: &Path) -> Option<DesktopPosition> {
        if !actual_desktop(desktop) {
            return None;
        }
        let desktop = key(desktop)?;
        let path = path.to_owned();
        run(move || unsafe {
            let view = view()?;
            let Some(item) = item(&view, &path)? else {
                return Ok(None);
            };
            let point = view.GetItemPosition(item.0)?;
            Ok(Some(DesktopPosition {
                desktop,
                x: point.x,
                y: point.y,
            }))
        })
        .flatten()
    }
    pub(super) fn restore(desktop: &Path, path: &Path, position: &DesktopPosition) {
        if key(desktop).as_deref() != Some(position.desktop.as_str()) || !actual_desktop(desktop) {
            return;
        }
        let path = path.to_owned();
        let position = position.clone();
        let result = run(move || unsafe {
            let view = view()?;
            // Respect the user's Explorer layout settings; auto-arrange owns positions.
            if view.GetCurrentFolderFlags()? & FWF_AUTOARRANGE.0 as u32 != 0 {
                return Ok(false);
            }
            let end = Instant::now() + Duration::from_secs(2);
            loop {
                if let Some(item) = item(&view, &path)? {
                    let point = POINT {
                        x: position.x,
                        y: position.y,
                    };
                    let pidl = item.0 as *const ITEMIDLIST;
                    view.SelectAndPositionItems(
                        1,
                        &pidl,
                        Some(&point),
                        SVSI_POSITIONITEM.0 as u32,
                    )?;
                    let actual = view.GetItemPosition(item.0)?;
                    if actual.x == point.x && actual.y == point.y {
                        return Ok(true);
                    }
                }
                if Instant::now() >= end {
                    return Ok(false);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        if result != Some(true) {
            eprintln!("文件已恢复，Explorer 未能还原桌面图标位置（可能启用了自动排列）");
        }
    }
}

pub(crate) fn capture(desktop: &Path, path: &Path) -> Option<DesktopPosition> {
    #[cfg(windows)]
    {
        native::capture(desktop, path)
    }
    #[cfg(not(windows))]
    {
        let _ = (desktop, path);
        None
    }
}
pub(crate) fn restore(desktop: &Path, path: &Path, position: &DesktopPosition) {
    #[cfg(windows)]
    native::restore(desktop, path, position);
    #[cfg(not(windows))]
    let _ = (desktop, path, position);
}
