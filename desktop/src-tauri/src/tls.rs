/// Reqwest and the updater enable different Rustls providers. Select one
/// before background WebSocket connections construct their TLS config.
pub fn initialize_provider() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

#[cfg(test)]
mod tests {
    #[test]
    fn websocket_tls_config_has_an_unambiguous_provider() {
        super::initialize_provider();
        // Reinitialization must also tolerate a provider installed by another
        // library. The builder otherwise panics with both provider features.
        super::initialize_provider();
        let _config = rustls::ClientConfig::builder()
            .with_root_certificates(rustls::RootCertStore::empty())
            .with_no_client_auth();
    }
}
