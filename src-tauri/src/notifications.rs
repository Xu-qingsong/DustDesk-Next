use crate::workspace::productivity::Notification;

pub fn show(app: &tauri::AppHandle, notification: &Notification) -> Result<(), String> {
    // Isolated regression runs must not send notifications to the user's desktop.
    if std::env::var_os("DUSTDESK_TEST_USER_DATA_DIR").is_some() {
        eprintln!(
            "DustDesk test notification: {}",
            serde_json::to_string(notification).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    let title = notification.title;
    let body = notification.body.clone();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = native::show(&handle, title, &body) {
            eprintln!("系统通知失败：{error}");
        }
    })
    .map_err(|error| error.to_string())
}

#[cfg(windows)]
mod native {
    use std::sync::OnceLock;
    use tauri::Manager;
    use windows::{
        core::{HSTRING, PCWSTR},
        Data::Xml::Dom::XmlDocument,
        Foundation::TypedEventHandler,
        Win32::System::Registry::{
            RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
            REG_OPTION_NON_VOLATILE, REG_SZ,
        },
        UI::Notifications::{ToastFailedEventArgs, ToastNotification, ToastNotificationManager},
    };

    const APP_ID: &str = "com.dustdesk.next";
    static REGISTERED: OnceLock<()> = OnceLock::new();

    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }

    fn register(app: &tauri::AppHandle) -> Result<(), String> {
        let directory = app
            .path()
            .config_dir()
            .map_err(|e| e.to_string())?
            .join("DustDesk.Next")
            .join("Notifications");
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let icon = directory.join("DustDesk.ico");
        std::fs::write(&icon, include_bytes!("../../Assets/DustDesk.ico"))
            .map_err(|e| e.to_string())?;
        let path = HSTRING::from(format!("Software\\Classes\\AppUserModelId\\{APP_ID}"));
        let mut handle = HKEY::default();
        unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                &path,
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                None,
                &mut handle,
                None,
            )
            .ok()
        }
        .map_err(|e| e.to_string())?;
        let key = Key(handle);
        for (name, value) in [
            ("DisplayName", "DustDesk".to_owned()),
            ("IconUri", icon.to_string_lossy().into_owned()),
        ] {
            let bytes = value
                .encode_utf16()
                .chain(Some(0))
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>();
            unsafe { RegSetValueExW(key.0, &HSTRING::from(name), None, REG_SZ, Some(&bytes)).ok() }
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn document(title: &str, body: &str) -> windows::core::Result<XmlDocument> {
        let document = XmlDocument::new()?;
        document.LoadXml(&HSTRING::from(
            "<toast><visual><binding template=\"ToastGeneric\"/></visual></toast>",
        ))?;
        let binding = document
            .GetElementsByTagName(&HSTRING::from("binding"))?
            .Item(0)?;
        for value in [title, body] {
            let text = document.CreateElement(&HSTRING::from("text"))?;
            text.AppendChild(&document.CreateTextNode(&HSTRING::from(value))?)?;
            binding.AppendChild(&text)?;
        }
        Ok(document)
    }

    pub fn show(app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
        if REGISTERED.get().is_none() {
            register(app)?;
            let _ = REGISTERED.set(());
        }
        let send = || -> windows::core::Result<()> {
            let toast = ToastNotification::CreateToastNotification(&document(title, body)?)?;
            let handle = app.clone();
            toast.Activated(&TypedEventHandler::new(move |_, _| {
                crate::main_window::request_show(&handle);
                Ok(())
            }))?;
            toast.Failed(
                &TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(|_, args| {
                    if let Some(args) = args.as_ref() {
                        eprintln!("系统通知未显示：{:?}", args.ErrorCode());
                    }
                    Ok(())
                }),
            )?;
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))?
                .Show(&toast)
        };
        send().map_err(|e| e.to_string())
    }

    #[test]
    fn task_titles_are_text_not_toast_markup() {
        use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED).unwrap();
        }
        let document = document("DustDesk 任务提醒", "<任务>&\"中文🪶").unwrap();
        let xml = document.GetXml().unwrap().to_string();
        assert!(xml.contains("&lt;任务&gt;&amp;"), "{xml}");
        assert_eq!(
            document
                .GetElementsByTagName(&HSTRING::from("text"))
                .unwrap()
                .Length()
                .unwrap(),
            2
        );
        drop(document);
        unsafe {
            RoUninitialize();
        }
    }
}

#[cfg(not(windows))]
mod native {
    pub fn show(_: &tauri::AppHandle, _: &str, _: &str) -> Result<(), String> {
        Err("当前平台不支持系统通知".into())
    }
}
