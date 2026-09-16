//! See `../build-support/crt_static_guard.rs` for the guard and the
//! incident it exists for; `cli/build.rs` includes the same file. The
//! guard runs BEFORE `tauri_build::build()`, so a build from the wrong
//! directory fails on the CRT flag, not after a minute of Tauri codegen.
include!("../build-support/crt_static_guard.rs");

fn main() {
    println!("cargo:rerun-if-changed=../build-support/crt_static_guard.rs");
    require_crt_static();
    tauri_build::build()
}
