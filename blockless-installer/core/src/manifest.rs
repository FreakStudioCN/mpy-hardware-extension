//! The manifest (`manifest/installer.manifest.json`), §2 of `ARCHITECTURE.md`.
//!
//! The manifest is the sole source of version literals and checksums; nothing
//! in this crate hardcodes a version number outside of test/fixture data. Each
//! component declares a `source` (`download` | `bundled` | `managed` | `pip` |
//! `marketplace`); [`Manifest::parse`] both deserializes and validates that
//! every component's declared source matches what that slot expects, so a
//! hand-edited manifest with a component in the wrong "channel" is rejected
//! loudly rather than silently misinterpreted downstream.

use crate::platform::{Arch, Os};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("could not parse manifest JSON: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("unsupported schemaVersion {0} (expected 1)")]
    UnsupportedSchemaVersion(u32),
    #[error("component '{component}' has source '{got}', expected '{expected}'")]
    UnexpectedSource {
        component: &'static str,
        expected: &'static str,
        got: &'static str,
    },
    #[error("{field} is not 64 lowercase hex characters: '{value}'")]
    InvalidSha256 { field: &'static str, value: String },
}

/// The five channels a component can be sourced from. Validated per-component
/// slot in [`Manifest::validate`] -- e.g. `extension` must always be `bundled`,
/// enforcing the pinned-VSIX-only policy (`/scope.md` "Artifact authentication"
/// + ARCHITECTURE §6) at the manifest layer, not just in `extensions.rs`.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Download,
    Bundled,
    Managed,
    Pip,
    Marketplace,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::Download => "download",
            Source::Bundled => "bundled",
            Source::Managed => "managed",
            Source::Pip => "pip",
            Source::Marketplace => "marketplace",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Resolver {
    VscodeUpdateApi,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct VscodePlatformMap {
    pub darwin: String,
    #[serde(rename = "win32-x64")]
    pub win32_x64: String,
    #[serde(rename = "win32-arm64")]
    pub win32_arm64: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct VscodeComponent {
    pub source: Source,
    pub resolver: Resolver,
    pub channel: String,
    pub platform: VscodePlatformMap,
}

impl VscodeComponent {
    /// The update-API platform slug for this machine (e.g. `darwin-universal`,
    /// `win32-arm64-user`). macOS ships one universal build regardless of arch;
    /// Windows splits by arch (ports `$VSCODE_PLATFORM` from the M0 scripts).
    pub fn platform_slug(&self, os: Os, arch: Arch) -> &str {
        match os {
            Os::MacOs => &self.platform.darwin,
            Os::Windows => match arch {
                Arch::X64 => &self.platform.win32_x64,
                Arch::Arm64 => &self.platform.win32_arm64,
            },
        }
    }

    /// The update-API URL to resolve VS Code's download from (ports the URL
    /// the M0 scripts build: `.../api/update/<platform>/<channel>/latest`).
    pub fn update_api_url(&self, os: Os, arch: Arch) -> String {
        format!(
            "https://update.code.visualstudio.com/api/update/{}/{}/latest",
            self.platform_slug(os, arch),
            self.channel
        )
    }
}

/// The subset of the real update-API response this installer reads (ports
/// `get_json url/sha256hash/productVersion`). Extra fields (`name`, `hash`,
/// `timestamp`, `supportsFastUpdate`, ...) are ignored, not rejected, so a
/// harmless API addition never breaks parsing.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct VscodeUpdateApiResponse {
    pub url: String,
    #[serde(rename = "sha256hash")]
    pub sha256_hash: String,
    #[serde(rename = "productVersion")]
    pub product_version: String,
}

impl VscodeUpdateApiResponse {
    pub fn parse(body: &str) -> Result<VscodeUpdateApiResponse, ManifestError> {
        Ok(serde_json::from_str(body)?)
    }
}

/// The four uv release targets the manifest pins a checksum for. macOS splits
/// by arch (uv ships separate arm64/x64 binaries, unlike VS Code's universal
/// build); Windows likewise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UvPlatformKey {
    DarwinAarch64,
    DarwinX8664,
    Win32X64,
    Win32Arm64,
}

impl UvPlatformKey {
    pub fn for_target(os: Os, arch: Arch) -> UvPlatformKey {
        match (os, arch) {
            (Os::MacOs, Arch::Arm64) => UvPlatformKey::DarwinAarch64,
            (Os::MacOs, Arch::X64) => UvPlatformKey::DarwinX8664,
            (Os::Windows, Arch::X64) => UvPlatformKey::Win32X64,
            (Os::Windows, Arch::Arm64) => UvPlatformKey::Win32Arm64,
        }
    }

    /// The exact asset filename astral-sh/uv publishes per release (confirmed
    /// against the live 0.11.29 release listing), used to build the download
    /// URL -- never guessed at fetch time.
    fn asset_name(self) -> &'static str {
        match self {
            UvPlatformKey::DarwinAarch64 => "uv-aarch64-apple-darwin.tar.gz",
            UvPlatformKey::DarwinX8664 => "uv-x86_64-apple-darwin.tar.gz",
            UvPlatformKey::Win32X64 => "uv-x86_64-pc-windows-msvc.zip",
            UvPlatformKey::Win32Arm64 => "uv-aarch64-pc-windows-msvc.zip",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct UvSha256Map {
    #[serde(rename = "darwin-aarch64")]
    pub darwin_aarch64: String,
    #[serde(rename = "darwin-x86_64")]
    pub darwin_x86_64: String,
    #[serde(rename = "win32-x64")]
    pub win32_x64: String,
    #[serde(rename = "win32-arm64")]
    pub win32_arm64: String,
}

impl UvSha256Map {
    fn get(&self, key: UvPlatformKey) -> &str {
        match key {
            UvPlatformKey::DarwinAarch64 => &self.darwin_aarch64,
            UvPlatformKey::DarwinX8664 => &self.darwin_x86_64,
            UvPlatformKey::Win32X64 => &self.win32_x64,
            UvPlatformKey::Win32Arm64 => &self.win32_arm64,
        }
    }

    fn iter(&self) -> [(&'static str, &str); 4] {
        [
            ("uv.sha256.darwin-aarch64", &self.darwin_aarch64),
            ("uv.sha256.darwin-x86_64", &self.darwin_x86_64),
            ("uv.sha256.win32-x64", &self.win32_x64),
            ("uv.sha256.win32-arm64", &self.win32_arm64),
        ]
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct UvComponent {
    pub source: Source,
    pub version: String,
    pub sha256: UvSha256Map,
}

impl UvComponent {
    /// GitHub release download URL for this target, built from the manifest's
    /// pinned version (never a literal in code) and uv's known asset-naming
    /// scheme.
    pub fn download_url(&self, key: UvPlatformKey) -> String {
        format!(
            "https://github.com/astral-sh/uv/releases/download/{}/{}",
            self.version,
            key.asset_name()
        )
    }

    pub fn sha256_for(&self, key: UvPlatformKey) -> &str {
        self.sha256.get(key)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct PythonComponent {
    pub source: Source,
    pub manager: String,
    pub series: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct MpremoteComponent {
    pub source: Source,
    pub version: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ExtensionComponent {
    pub source: Source,
    pub id: String,
    pub version: String,
    pub sha256: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct PythonExtensionComponent {
    pub source: Source,
    pub id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Components {
    pub vscode: VscodeComponent,
    pub uv: UvComponent,
    pub python: PythonComponent,
    pub mpremote: MpremoteComponent,
    pub extension: ExtensionComponent,
    pub python_extension: PythonExtensionComponent,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ManifestSettings {
    #[serde(rename = "workbench.colorTheme")]
    pub color_theme: String,
    #[serde(rename = "mpyhw.autoOpenPanel")]
    pub auto_open_panel: bool,
    #[serde(rename = "workbench.secondarySideBar.defaultVisibility")]
    pub secondary_side_bar_default_visibility: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    pub installer_version: String,
    pub profile_name: String,
    pub settings: ManifestSettings,
    pub components: Components,
}

impl Manifest {
    /// Parse AND validate: a `Manifest` returned from here is always safe to
    /// hand to the rest of the core (correct schema version, every component
    /// in its expected channel, every sha256 field well-formed).
    pub fn parse(json: &str) -> Result<Manifest, ManifestError> {
        let manifest: Manifest = serde_json::from_str(json)?;
        manifest.validate()?;
        Ok(manifest)
    }

    fn validate(&self) -> Result<(), ManifestError> {
        if self.schema_version != 1 {
            return Err(ManifestError::UnsupportedSchemaVersion(self.schema_version));
        }
        check_source("vscode", self.components.vscode.source, Source::Download)?;
        check_source("uv", self.components.uv.source, Source::Download)?;
        check_source("python", self.components.python.source, Source::Managed)?;
        check_source("mpremote", self.components.mpremote.source, Source::Pip)?;
        check_source(
            "extension",
            self.components.extension.source,
            Source::Bundled,
        )?;
        check_source(
            "pythonExtension",
            self.components.python_extension.source,
            Source::Marketplace,
        )?;
        for (field, value) in self.components.uv.sha256.iter() {
            validate_sha256(field, value)?;
        }
        validate_sha256("extension.sha256", &self.components.extension.sha256)?;
        Ok(())
    }
}

fn check_source(
    component: &'static str,
    got: Source,
    expected: Source,
) -> Result<(), ManifestError> {
    if got != expected {
        return Err(ManifestError::UnexpectedSource {
            component,
            expected: expected.as_str(),
            got: got.as_str(),
        });
    }
    Ok(())
}

fn validate_sha256(field: &'static str, value: &str) -> Result<(), ManifestError> {
    let ok = value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());
    if !ok {
        return Err(ManifestError::InvalidSha256 {
            field,
            value: value.to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
#[path = "tests/manifest.rs"]
mod tests;
