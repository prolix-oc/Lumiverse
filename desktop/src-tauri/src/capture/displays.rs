use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Deserialize)]
pub struct NativeDisplay {
    pub identity: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
    #[serde(skip)]
    pub identity: String,
}

pub fn snapshot(device_key: &str) -> Vec<Display> {
    scoped(super::platform::displays(), device_key)
}

fn scoped(displays: Vec<NativeDisplay>, device_key: &str) -> Vec<Display> {
    displays.into_iter().take(16).map(|display| {
        let bytes = serde_json::to_vec(&(device_key, &display.identity)).unwrap();
        Display {
            id: format!("{:x}", Sha256::digest(bytes)),
            name: display.name,
            width: display.width,
            height: display.height,
            primary: display.primary,
            identity: display.identity,
        }
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_ids_follow_native_identity_and_are_scoped_without_leaking_it() {
        let native = |identity: &str| NativeDisplay {
            identity: identity.into(), name: "Display 1".into(), width: 1920, height: 1080, primary: true,
        };
        let first = scoped(vec![native("private-monitor-a"), native("private-monitor-b")], "desktop-a");
        assert_ne!(first[0].id, first[1].id);
        assert_eq!(first[0].id, scoped(vec![native("private-monitor-a")], "desktop-a")[0].id);
        assert_ne!(first[0].id, scoped(vec![native("private-monitor-a")], "desktop-b")[0].id);
        assert!(!serde_json::to_string(&first).unwrap().contains("private-monitor"));
    }
}
