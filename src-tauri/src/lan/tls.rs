//! Self-signed device certificates use explicit DER fingerprints and proof of
//! key possession. CA/hostname trust cannot authenticate a DustDesk device.
//! Bootstrap accepts a certificate only for the transport's GET /hello path;
//! it does not add trust or authorize a transfer. Every other outgoing request
//! pins the observed fingerprint before any HTTP request bytes are written.
use super::{
    protocol::{fingerprint, valid_fingerprint},
    storage::Identity,
};
use rustls::{
    client::{
        danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
        ResolvesClientCert,
    },
    crypto::{ring, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, ServerName, UnixTime},
    server::{
        danger::{ClientCertVerified, ClientCertVerifier},
        ClientHello, ParsedCertificate, ResolvesServerCert,
    },
    sign::CertifiedKey,
    ClientConfig, DigitallySignedStruct, DistinguishedName, Error, ServerConfig, SignatureScheme,
};
use std::{fmt, sync::Arc};

struct DeviceKey(Arc<CertifiedKey>);
impl fmt::Debug for DeviceKey {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str("DustDeskDeviceKey(redacted)")
    }
}
impl ResolvesServerCert for DeviceKey {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        self.0
            .key
            .choose_scheme(hello.signature_schemes())
            .map(|_| self.0.clone())
    }
}
impl ResolvesClientCert for DeviceKey {
    fn resolve(&self, _roots: &[&[u8]], schemes: &[SignatureScheme]) -> Option<Arc<CertifiedKey>> {
        self.0.key.choose_scheme(schemes).map(|_| self.0.clone())
    }
    fn has_certs(&self) -> bool {
        true
    }
}

fn certificate_shape(
    cert: &CertificateDer<'_>,
    intermediates: &[CertificateDer<'_>],
) -> Result<(), Error> {
    if !intermediates.is_empty() || cert.len() > 64 * 1024 {
        return Err(Error::General("设备证书链无效".into()));
    }
    ParsedCertificate::try_from(cert)?;
    Ok(())
}

#[derive(Debug)]
struct DeviceServerVerifier {
    expected: Option<String>,
}
impl ServerCertVerifier for DeviceServerVerifier {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        certificate_shape(cert, intermediates)?;
        if self
            .expected
            .as_ref()
            .is_some_and(|expected| *expected != fingerprint(cert.as_ref()))
        {
            return Err(Error::General(
                "设备身份已变化，请重新连接并核对配对码".into(),
            ));
        }
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(
            message,
            cert,
            signature,
            &ring::default_provider().signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(
            message,
            cert,
            signature,
            &ring::default_provider().signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[derive(Debug)]
struct DeviceClientVerifier;
impl ClientCertVerifier for DeviceClientVerifier {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }
    fn verify_client_cert(
        &self,
        cert: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        certificate_shape(cert, intermediates)?;
        Ok(ClientCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(
            message,
            cert,
            signature,
            &ring::default_provider().signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(
            message,
            cert,
            signature,
            &ring::default_provider().signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

pub(crate) fn server_config(identity: &Identity) -> Result<Arc<ServerConfig>, String> {
    let mut config = ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|_| "TLS 协议配置无效")?
        .with_client_cert_verifier(Arc::new(DeviceClientVerifier))
        .with_cert_resolver(Arc::new(DeviceKey(identity.certified_key())));
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    // Fresh handshake per request: do not let session resumption bypass a
    // changed pin, client-certificate requirement, or per-request policy.
    config.session_storage = Arc::new(rustls::server::NoServerSessionStorage {});
    config.send_tls13_tickets = 0;
    Ok(Arc::new(config))
}

pub(crate) fn client_config(
    identity: &Identity,
    expected: Option<&str>,
) -> Result<Arc<ClientConfig>, String> {
    if expected.is_some_and(|pin| !valid_fingerprint(pin)) {
        return Err("设备证书指纹无效".into());
    }
    let mut config = ClientConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|_| "TLS 协议配置无效")?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(DeviceServerVerifier {
            expected: expected.map(str::to_owned),
        }))
        .with_client_cert_resolver(Arc::new(DeviceKey(identity.certified_key())));
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    config.resumption = rustls::client::Resumption::disabled();
    Ok(Arc::new(config))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_certificate_bytes_cannot_be_accepted_even_during_bootstrap() {
        let verifier = DeviceServerVerifier { expected: None };
        let cert = CertificateDer::from(vec![1, 2, 3]);
        assert!(verifier
            .verify_server_cert(
                &cert,
                &[],
                &ServerName::try_from("dustdesk.local").unwrap(),
                &[],
                UnixTime::since_unix_epoch(std::time::Duration::ZERO)
            )
            .is_err());
        assert!(DeviceClientVerifier
            .verify_client_cert(
                &cert,
                &[],
                UnixTime::since_unix_epoch(std::time::Duration::ZERO)
            )
            .is_err());
    }
}
