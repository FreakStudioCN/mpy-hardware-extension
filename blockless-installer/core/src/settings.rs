//! Step 4: the branded profile settings (mechanism A only -- the per-profile
//! `settings.json`, never the user's default settings.json; mechanism B was
//! removed after the fresh-VM A/B experiment settled it). Ports
//! `merge_settings`/`Merge-Settings` and `settings_already`/(the inline
//! PS equivalent), plus the profile-location resolution at the top of
//! `step4_settings`/`Step-Settings`.
//!
//! Reuses `profile.rs`'s resolver + both registration paths directly: step 4
//! can be what FINALLY registers the profile if steps 2/3 somehow left it
//! unregistered, so it needs the same seed-first/window-fallback-second
//! sequence available to it too.

use crate::manifest::ManifestSettings;
use crate::profile;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("could not resolve the '{0}' profile location")]
    ProfileNotResolved(String),
    /// An EXISTING settings.json we cannot parse (VS Code settings are
    /// JSONC, may carry comments) must never be clobbered down to just our
    /// four keys -- it may hold the user's own edits. Refuse loudly instead.
    #[error("refusing to overwrite an unreadable settings.json at {}", .0.display())]
    Unparseable(PathBuf),
    #[error("could not read {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not write {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not register the profile: {0}")]
    Profile(#[from] profile::ProfileError),
}

fn desired_entries(env_python: &Path, s: &ManifestSettings) -> Vec<(&'static str, Value)> {
    vec![
        (
            "mpyhw.pythonPath",
            Value::String(env_python.to_string_lossy().into_owned()),
        ),
        ("workbench.colorTheme", Value::String(s.color_theme.clone())),
        ("mpyhw.autoOpenPanel", Value::Bool(s.auto_open_panel)),
        (
            "workbench.secondarySideBar.defaultVisibility",
            Value::String(s.secondary_side_bar_default_visibility.clone()),
        ),
    ]
}

/// All FOUR installer-owned keys must match, not just `mpyhw.pythonPath`: a
/// repair run must re-apply the theme, `autoOpenPanel`, or secondary side
/// bar visibility if any was removed or changed, or the branded UI / panel
/// auto-open stays broken while this reports "already applied".
fn settings_already(target: &Path, env_python: &Path, s: &ManifestSettings) -> bool {
    let Ok(bytes) = std::fs::read(target) else {
        return false;
    };
    let Ok(existing) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    let Some(obj) = existing.as_object() else {
        return false;
    };
    desired_entries(env_python, s)
        .iter()
        .all(|(k, v)| obj.get(*k) == Some(v))
}

fn merge_settings(
    target: &Path,
    env_python: &Path,
    s: &ManifestSettings,
) -> Result<(), SettingsError> {
    let mut root = if target.exists() {
        let bytes = std::fs::read(target).map_err(|source| SettingsError::Read {
            path: target.to_path_buf(),
            source,
        })?;
        serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| SettingsError::Unparseable(target.to_path_buf()))?
    } else {
        Value::Object(Default::default())
    };
    let obj = root
        .as_object_mut()
        .ok_or_else(|| SettingsError::Unparseable(target.to_path_buf()))?;
    for (k, v) in desired_entries(env_python, s) {
        obj.insert(k.to_string(), v);
    }
    let body = serde_json::to_vec_pretty(&root).expect("Value always serializes");
    write_atomic(target, &body).map_err(|source| SettingsError::Write {
        path: target.to_path_buf(),
        source,
    })
}

fn write_atomic(dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let file_name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "settings.json".to_string());
    let tmp = parent.join(format!("{file_name}.tmp"));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, dest)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsStepOutcome {
    /// The RESOLVED on-disk id -- journal THIS, not the seed constant. Step
    /// 4 may be what finally registers the profile (via the same seed/
    /// window-fallback sequence `profile.rs` exposes), so this can differ
    /// from whatever location earlier steps assumed.
    pub profile_location: String,
    pub applied: bool,
}

#[allow(clippy::too_many_arguments)]
pub fn ensure_settings(
    command_runner: &dyn profile::CommandRunner,
    code_cli: &Path,
    storage_path: &Path,
    profiles_dir: &Path,
    profile_name: &str,
    seed_location: &str,
    env_python: &Path,
    manifest_settings: &ManifestSettings,
) -> Result<SettingsStepOutcome, SettingsError> {
    let mut loc = profile::resolve_profile_location(storage_path, profile_name);
    if loc.is_none() {
        profile::register_profile_offline(
            command_runner,
            storage_path,
            profiles_dir,
            profile_name,
            seed_location,
        )?;
        loc = profile::resolve_profile_location(storage_path, profile_name);
    }
    if loc.is_none() {
        profile::register_profile(command_runner, code_cli, storage_path, profile_name);
        loc = profile::resolve_profile_location(storage_path, profile_name);
    }
    let loc = loc.ok_or_else(|| SettingsError::ProfileNotResolved(profile_name.to_string()))?;

    let target = profiles_dir.join(&loc).join("settings.json");

    if settings_already(&target, env_python, manifest_settings) {
        return Ok(SettingsStepOutcome {
            profile_location: loc,
            applied: false,
        });
    }

    merge_settings(&target, env_python, manifest_settings)?;

    Ok(SettingsStepOutcome {
        profile_location: loc,
        applied: true,
    })
}

#[cfg(test)]
#[path = "tests/settings.rs"]
mod tests;
