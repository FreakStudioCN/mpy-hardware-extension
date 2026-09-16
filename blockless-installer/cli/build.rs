//! See `../build-support/crt_static_guard.rs` for the guard and the
//! incident it exists for. Shared with `app/build.rs` by `include!` so the
//! two build scripts cannot drift: a guard on one binary is not a guard on
//! the other, and the GUI is the one users run.
include!("../build-support/crt_static_guard.rs");

fn main() {
    println!("cargo:rerun-if-changed=../build-support/crt_static_guard.rs");
    require_crt_static();
}
