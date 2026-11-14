//! Recover only the old link -> state-save -> unlink publication interval.
//! No directory is authorized here: the receiver must obtain fresh approval.
use super::*;

fn staging(root: &Arc<Directory>, task: &Task) -> io::Result<Arc<Directory>> {
    root.child(&format!(".dustdesk-part-{}", task.manifest.id), false)
}

fn target(
    root: &Arc<Directory>,
    relative: &str,
    identity: &FileIdentity,
) -> Result<Option<OwnedFile>, String> {
    let (parent, name) = match root.parent_for(relative, false) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    match parent.legacy_target(&name) {
        Ok(actual) if actual.identity() == identity => Ok(Some(actual)),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法核验旧版发布目标：{error}")),
    }
}

pub(super) fn recover_intent(
    store: &mut StateStore,
    id: &str,
    root: Arc<Directory>,
    intent: Intent,
    cancel: &CancellationToken,
) -> Result<String, String> {
    check_cancel(cancel).map_err(|e| e.to_string())?;
    let task = task(store.state(), id, &root)?;
    validate(&intent, task)?;
    let part = match staging(&root, task) {
        Ok(directory) => directory.legacy_part(&format!("{}.part", intent.index)),
        Err(error) => Err(error),
    };
    let target_pin = match part {
        Ok(Some(mut part)) => {
            let pin = target(&root, &intent.candidate, &intent.identity)?
                .ok_or("旧版发布目标身份不一致，保留暂存链接")?;
            if part.identity() != &intent.identity
                || part.hash(intent.size, cancel).map_err(|e| e.to_string())? != intent.hash
            {
                return Err("旧版发布链接身份或校验值不一致，保留原文件".into());
            }
            check_cancel(cancel).map_err(|e| e.to_string())?;
            // The durable intent already names the exact native identity.
            // A crash after this unlink can adopt only that existing target.
            part.remove().map_err(|e| e.to_string())?;
            Some(pin)
        }
        Ok(None) => return Err("旧版发布链接已变化，保留原文件".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("无法恢复旧版暂存链接：{error}")),
    };
    let (parent, name) = root
        .parent_for(&intent.candidate, false)
        .map_err(|e| e.to_string())?;
    let verified_before_unlink = target_pin.is_some();
    let mut file = match target_pin {
        Some(file) => file,
        None => parent.read(&name).map_err(|e| e.to_string())?,
    };
    file.require_single_link().map_err(|e| e.to_string())?;
    if file.identity() != &intent.identity
        || (!verified_before_unlink
            && file.hash(intent.size, cancel).map_err(|e| e.to_string())? != intent.hash)
    {
        return Err("旧版已发布文件身份或校验值变化，保留恢复记录".into());
    }
    // After unlink, finish the mapping even if cancellation arrives; its
    // already-published bytes must remain accounted for, as for native rename.
    Prepared {
        file,
        root,
        task_id: id.to_owned(),
        intent,
        renamed: true,
    }
    .commit(store)
}

pub(super) fn recover_links(
    store: &mut StateStore,
    id: &str,
    root: Arc<Directory>,
    cancel: &CancellationToken,
) -> Result<Option<String>, String> {
    let initial = task(store.state(), id, &root)?;
    let directory = match staging(&root, initial) {
        Ok(directory) => directory,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法核验旧版暂存目录：{error}")),
    };
    let count = initial.manifest.entries.len();
    let mut recovered = None;
    for index in 0..count {
        check_cancel(cancel).map_err(|e| e.to_string())?;
        let task = task(store.state(), id, &root)?;
        let mut part = match directory.legacy_part(&format!("{index}.part")) {
            Ok(Some(part)) => part,
            Ok(None) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("无法核验旧版暂存链接：{error}")),
        };
        let entry = &task.manifest.entries[index];
        if part.hash(entry.size, cancel).map_err(|e| e.to_string())? != entry.hash {
            return Err("旧版暂存链接校验失败，保留原文件".into());
        }
        let mut found = None;
        for collision in 0..10_000 {
            check_cancel(cancel).map_err(|e| e.to_string())?;
            let relative = candidate(entry, collision)?;
            if target(&root, &relative, part.identity())?.is_some() {
                found = Some((relative, collision));
                break;
            }
        }
        let (candidate, collision) = found.ok_or("未找到同一身份的旧版发布目标，保留暂存链接")?;
        let intent = Intent {
            index,
            identity: part.identity().clone(),
            size: entry.size,
            hash: entry.hash.clone(),
            candidate,
            collision,
            legacy_link: true,
        };
        validate(&intent, task)?;
        save_intent(store, id, &intent, cancel)?;
        drop(part);
        recovered = Some(recover_intent(store, id, root.clone(), intent, cancel)?);
    }
    Ok(recovered)
}
