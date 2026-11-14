//! Explicit first identity creation, under StateStore's exclusive Rust owner.
//! No certificate store, persisted CNG key name, production path, or UI input.
use super::{
    files::{check_cancel, Directory, OwnedFile},
    protocol::fingerprint,
    storage::Identity,
};
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, PKCS_RSA_SHA256};
use rustls::pki_types::PrivatePkcs8KeyDer;
use serde::Serialize;
use std::{io, sync::Arc};
use tokio_util::sync::CancellationToken;
use windows::{
    core::PCWSTR,
    Win32::Security::Cryptography::{
        NCryptCreatePersistedKey, NCryptExportKey, NCryptFinalizeKey, NCryptFreeObject,
        NCryptOpenStorageProvider, NCryptSetProperty, BCRYPT_RSA_ALGORITHM, CERT_KEY_SPEC,
        MS_KEY_STORAGE_PROVIDER, NCRYPT_ALLOW_EXPORT_FLAG, NCRYPT_ALLOW_PLAINTEXT_EXPORT_FLAG,
        NCRYPT_EXPORT_POLICY_PROPERTY, NCRYPT_FLAGS, NCRYPT_HANDLE, NCRYPT_KEY_HANDLE,
        NCRYPT_LENGTH_PROPERTY, NCRYPT_PKCS8_PRIVATE_KEY_BLOB, NCRYPT_PROV_HANDLE,
    },
};
use zeroize::Zeroizing;

const IDENTITY_LIMIT: usize = 1024 * 1024;

struct NativeObject(usize);
impl Drop for NativeObject {
    fn drop(&mut self) {
        if self.0 != 0 {
            let _ = unsafe { NCryptFreeObject(NCRYPT_HANDLE(self.0)) };
        }
    }
}

/// All key material stays in memory until the atomic identity publication.
/// Null key name is documented CNG ephemeral storage, not a persisted key.
fn generate(cancel: &CancellationToken) -> Result<Zeroizing<Vec<u8>>, String> {
    check_cancel(cancel).map_err(|e| e.to_string())?;
    let crypto = |error: windows_core::Error| format!("无法创建本机设备密钥：{error}");
    let mut provider = NCRYPT_PROV_HANDLE::default();
    unsafe { NCryptOpenStorageProvider(&mut provider, MS_KEY_STORAGE_PROVIDER, 0) }
        .map_err(crypto)?;
    let _provider = NativeObject(provider.0);
    let mut key = NCRYPT_KEY_HANDLE::default();
    unsafe {
        NCryptCreatePersistedKey(
            provider,
            &mut key,
            BCRYPT_RSA_ALGORITHM,
            PCWSTR::null(),
            CERT_KEY_SPEC(0),
            NCRYPT_FLAGS(0),
        )
    }
    .map_err(crypto)?;
    let _key = NativeObject(key.0);
    unsafe {
        NCryptSetProperty(
            NCRYPT_HANDLE(key.0),
            NCRYPT_LENGTH_PROPERTY,
            &2048_u32.to_le_bytes(),
            NCRYPT_FLAGS(0),
        )
        .map_err(crypto)?;
        NCryptSetProperty(
            NCRYPT_HANDLE(key.0),
            NCRYPT_EXPORT_POLICY_PROPERTY,
            &(NCRYPT_ALLOW_EXPORT_FLAG | NCRYPT_ALLOW_PLAINTEXT_EXPORT_FLAG).to_le_bytes(),
            NCRYPT_FLAGS(0),
        )
        .map_err(crypto)?;
        NCryptFinalizeKey(key, NCRYPT_FLAGS(0)).map_err(crypto)?;
    }
    // CNG RSA generation itself is not cancellable. The supervisor must join
    // this blocking job even after cancellation; no file is published then.
    check_cancel(cancel).map_err(|e| e.to_string())?;
    let mut size = 0;
    unsafe {
        NCryptExportKey(
            key,
            None,
            NCRYPT_PKCS8_PRIVATE_KEY_BLOB,
            None,
            None,
            &mut size,
            NCRYPT_FLAGS(0),
        )
    }
    .map_err(crypto)?;
    if size == 0 || size > 64 * 1024 {
        return Err("本机设备密钥大小无效".into());
    }
    let mut der = Zeroizing::new(vec![0_u8; size as usize]);
    unsafe {
        NCryptExportKey(
            key,
            None,
            NCRYPT_PKCS8_PRIVATE_KEY_BLOB,
            None,
            Some(&mut der),
            &mut size,
            NCRYPT_FLAGS(0),
        )
    }
    .map_err(crypto)?;
    if size as usize > der.len() {
        return Err("本机设备密钥大小无效".into());
    }
    der.truncate(size as usize);
    let key = Zeroizing::new(
        KeyPair::from_pkcs8_der_and_sign_algo(
            &PrivatePkcs8KeyDer::from(der.as_slice()),
            &PKCS_RSA_SHA256,
        )
        .map_err(|_| "无法编码本机设备密钥")?,
    );
    let mut subject = DistinguishedName::new();
    subject.push(DnType::CommonName, "DustDesk Local Transfer");
    let now = time::OffsetDateTime::now_utc();
    let mut params = CertificateParams::default();
    params.distinguished_name = subject;
    params.not_before = now;
    params.not_after = now + time::Duration::days(3650);
    let cert = params
        .self_signed(&*key)
        .map_err(|_| "无法创建本机设备证书")?;
    let private = Zeroizing::new(key.serialize_pem());
    #[derive(Serialize)]
    struct Saved<'a> {
        id: String,
        cert: String,
        key: &'a str,
        fingerprint: String,
    }
    let saved = Saved {
        id: uuid::Uuid::new_v4().to_string(),
        cert: cert.pem(),
        key: &private,
        fingerprint: fingerprint(cert.der()),
    };
    check_cancel(cancel).map_err(|e| e.to_string())?;
    serde_json::to_vec(&saved)
        .map(Zeroizing::new)
        .map_err(|_| "无法编码本机设备身份".into())
}

pub(super) fn load(root: &Arc<Directory>) -> Result<Option<Identity>, String> {
    match root.read("identity.json") {
        Ok(mut file) => {
            let bytes = Zeroizing::new(
                file.read_bounded(IDENTITY_LIMIT)
                    .map_err(|e| e.to_string())?,
            );
            Identity::parse(&bytes).map(Some)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取设备身份：{error}")),
    }
}

struct Temporary(Option<OwnedFile>);
impl Drop for Temporary {
    fn drop(&mut self) {
        if let Some(file) = self.0.take() {
            let _ = file.remove(); // Exact open file; never deletes by path.
        }
    }
}

pub(super) fn ensure(
    root: &Arc<Directory>,
    cancel: &CancellationToken,
) -> Result<Identity, String> {
    ensure_with(root, cancel, generate)
}

fn ensure_with(
    root: &Arc<Directory>,
    cancel: &CancellationToken,
    generate: impl FnOnce(&CancellationToken) -> Result<Zeroizing<Vec<u8>>, String>,
) -> Result<Identity, String> {
    check_cancel(cancel).map_err(|e| e.to_string())?;
    if let Some(identity) = load(root)? {
        return Ok(identity);
    }
    // Any saved state without its identity requires explicit recovery. Even an
    // apparently empty state must not silently become a different device.
    match root.read("state.json") {
        Ok(_) => return Err("局域网状态存在但设备身份缺失，请先恢复原身份".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法核验首次设备身份状态：{error}")),
    }
    let bytes = generate(cancel)?;
    let identity = Identity::parse(&bytes)?;
    check_cancel(cancel).map_err(|e| e.to_string())?;
    // A racing external creator is never overwritten, even though this Rust
    // owner excludes other StateStores. Existing identities are validated.
    if let Some(winner) = load(root)? {
        return Ok(winner);
    }
    let mut temporary = Temporary(Some(
        root.create(&format!(".identity-{}.tmp", uuid::Uuid::new_v4()))
            .map_err(|e| format!("无法暂存设备身份：{e}"))?,
    ));
    let file = temporary.0.as_mut().unwrap();
    file.write_all(&bytes)
        .and_then(|()| file.sync())
        .and_then(|()| check_cancel(cancel))
        .and_then(|()| file.publish(root, "identity.json"))
        .map_err(|e| format!("无法保存设备身份：{e}"))?;
    // Publication is the commit point: cancellation afterwards must not erase
    // or replace a valid newly published device identity.
    temporary.0.take();
    Ok(identity)
}

#[cfg(test)]
#[path = "identity_tests.rs"]
mod tests;
