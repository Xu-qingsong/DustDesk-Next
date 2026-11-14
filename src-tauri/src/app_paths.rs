use std::path::{Path, PathBuf};

fn workspace_for(executable: &Path, project: Option<&Path>) -> Result<PathBuf, String> {
    let directory = match project {
        Some(directory) => directory,
        None => executable.parent().ok_or("无法确定程序所在目录")?,
    };
    if !directory.is_absolute() {
        return Err("数据目录必须为绝对路径".into());
    }
    Ok(directory.join("Data"))
}

pub fn workspace() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let project = cfg!(debug_assertions)
        .then(|| Path::new(env!("CARGO_MANIFEST_DIR")).parent())
        .flatten();
    workspace_for(&executable, project)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_data_follows_the_executable_including_a_moved_green_folder() {
        let root = std::env::temp_dir();
        for folder in ["installed", "green 中文", "moved green"] {
            let directory = root.join(folder);
            assert_eq!(
                workspace_for(&directory.join("DustDesk.exe"), None).unwrap(),
                directory.join("Data")
            );
        }
    }

    #[test]
    fn development_data_uses_the_project_instead_of_the_cargo_target_directory() {
        let project = std::env::temp_dir().join("dustdesk-project");
        let executable = project.join("src-tauri/target/debug/DustDesk.exe");
        assert_eq!(
            workspace_for(&executable, Some(&project)).unwrap(),
            project.join("Data")
        );
        assert!(workspace_for(Path::new("DustDesk.exe"), None).is_err());
    }
}
