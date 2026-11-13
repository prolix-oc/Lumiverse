//! Build-time checks shared with the native regression tests.
use serde_json::Value;

pub fn validate(config: &Value) -> Result<(), &'static str> {
    let bundled = config["bundle"]["externalBin"]
        .as_array()
        .is_some_and(|bins| {
            bins.iter()
                .any(|bin| bin.as_str() == Some("binaries/lumiverse-server"))
        });
    let diagnostic = config["version"]
        .as_str()
        .is_some_and(|version| version.contains("-diagnostic."));
    if bundled
        && !diagnostic
        && config["plugins"]["updater"]["pubkey"]
            .as_str()
            .is_none_or(|key| key.trim().is_empty())
    {
        return Err("Bundled desktop releases require plugins.updater.pubkey in the merged Tauri configuration.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bundled(version: &str, artifacts: bool, key: Value) -> Value {
        json!({
            "version": version,
            "bundle": { "externalBin": ["binaries/lumiverse-server"], "createUpdaterArtifacts": artifacts },
            "plugins": { "updater": { "pubkey": key } }
        })
    }

    #[test]
    fn hosted_and_private_releases_require_the_embedded_key() {
        for version in ["0.3.1", "0.3.2-nightly.20261029.42"] {
            for artifacts in [false, true] {
                for missing in [Value::Null, json!(""), json!(" \n\t"), json!(42)] {
                    assert!(validate(&bundled(version, artifacts, missing)).is_err());
                }
                assert!(
                    validate(&bundled(version, artifacts, json!("release-public-key"))).is_ok()
                );
            }
        }
    }

    #[test]
    fn unsigned_diagnostics_and_checkout_builds_remain_supported() {
        assert!(validate(&bundled("0.3.2-diagnostic.42", false, json!(""))).is_ok());
        let checkout: Value = serde_json::from_str(include_str!("tauri.conf.json")).unwrap();
        assert!(validate(&checkout).is_ok());
    }
}
