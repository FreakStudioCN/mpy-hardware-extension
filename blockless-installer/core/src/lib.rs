pub mod bootstrap;
pub mod extensions;
pub mod fetch;
pub mod manifest;
pub mod ops;
pub mod platform;
pub mod profile;
pub mod progress;
pub mod runtime;
pub mod settings;
pub mod state;
pub mod system;
pub mod uninstall;
pub mod verify;
pub mod vscode;
/// Windows-only: the GUI's own WebView2 runtime. Gated because macOS uses
/// in-box WKWebView and has nothing to provision.
#[cfg(windows)]
pub mod webview2;

/// This crate's version, for shells that must not drift from it.
///
/// `app/` is a separate cargo workspace (see `../Cargo.toml`'s `exclude`), so
/// its `Cargo.toml` carries its own literal `version` and CANNOT inherit
/// `[workspace.package]`. That is one more hand-maintained copy of the same
/// number, alongside the manifest's `installerVersion`. Exported so the GUI
/// can assert equality in a test rather than relying on someone noticing.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
