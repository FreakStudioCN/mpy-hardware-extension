//! Refuses to build an msvc binary that will not link the CRT statically.
//!
//! `.cargo/config.toml` at the workspace root sets
//! `-C target-feature=+crt-static` for the msvc targets (see that file for
//! why: without it the shipped binary imports `VCRUNTIME140.dll` and dies
//! with `STATUS_DLL_NOT_FOUND` before `main`, on any machine without the
//! Visual C++ redistributable). Cargo discovers that file by walking up
//! from the CURRENT DIRECTORY, not from `--manifest-path` -- so
//! `cargo build --manifest-path blockless-installer/cli/Cargo.toml`, run
//! from anywhere above `blockless-installer/`, silently drops the flag and
//! ships the exact binary that cost a day on the Windows rig, with every
//! other gate green.
//!
//! `CARGO_CFG_TARGET_FEATURE` reflects the rustflags actually applied to
//! this compile (confirmed empirically: it contains `crt-static` when
//! invoked from `blockless-installer/`, where `.cargo/config.toml`
//! applies, and omits it when invoked from outside that directory tree via
//! `--manifest-path`, where the file is never discovered) -- so this is a
//! fact about how THIS crate is actually being compiled, not merely about
//! where `cargo` was invoked from.
fn main() {
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_env != "msvc" {
        // Non-msvc targets (macOS, Linux, `*-pc-windows-gnu`) never need
        // `+crt-static` and must never be blocked by this guard.
        return;
    }
    let target_feature = std::env::var("CARGO_CFG_TARGET_FEATURE").unwrap_or_default();
    let has_crt_static = target_feature.split(',').any(|f| f == "crt-static");
    if !has_crt_static {
        panic!(
            "msvc build is missing -C target-feature=+crt-static (saw \
             CARGO_CFG_TARGET_FEATURE=\"{target_feature}\"). \
             blockless-installer/.cargo/config.toml sets this, but Cargo \
             discovers that file by walking up from the CURRENT DIRECTORY, \
             not from --manifest-path -- build from inside \
             blockless-installer/, never via --manifest-path from an \
             ancestor directory. Without it the shipped binary imports \
             VCRUNTIME140.dll and exits 0xC0000135 before main, on any \
             machine without the Visual C++ redistributable."
        );
    }
}
