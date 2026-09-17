//! The shipped Windows binary must not depend on the Visual C++
//! redistributable.
//!
//! `#![cfg(windows)]` for the whole file, like `verify_parity_windows.rs`:
//! every other target compiles it to zero tests, and the assertion is only
//! meaningful for an msvc artifact anyway.
//!
//! ## Why this test exists
//!
//! On 2026-09-10 the release binary was copied into a fresh Windows Sandbox
//! -- the first time any `blockless-installer` subcommand had run on a
//! Windows machine outside a test fixture -- and every invocation exited
//! `-1073741515` (`0xC0000135`, `STATUS_DLL_NOT_FOUND`) with nothing on
//! stdout or stderr. The process died in the loader, before `main`, so it
//! could not report, log, or fail readably. `dumpbin /DEPENDENTS` named the
//! cause: `VCRUNTIME140.dll`, which rustc's default dynamically-linked CRT
//! requires and which is NOT an in-box Windows component -- it arrives with
//! Visual Studio, VS Build Tools, or another app's installer.
//!
//! Nothing in the existing ladder could see this. Rung 1 runs on a box that
//! must have Build Tools installed to link the crate at all; `windows-latest`
//! ships the redistributable preinstalled, so rung 2 cannot see it either.
//! Both were answering about the machine they ran on rather than about a
//! user's machine -- the same shape as the `/Applications` literal and the
//! case-insensitive fixture path before it, and the same shape as the
//! `link.exe` prerequisite one layer further out.
//!
//! The fix is `blockless-installer/.cargo/config.toml`, which sets
//! `-C target-feature=+crt-static` for the msvc targets. Deleting that file
//! reintroduces the defect and is invisible on every machine capable of
//! building this crate, which is precisely why the guard has to assert
//! against the built artifact rather than against a developer's environment.
#![cfg(windows)]

/// The build configuration, asserted directly. This fails the moment
/// `.cargo/config.toml` stops applying to this target -- deleted, renamed,
/// or shadowed by a config closer to the invocation directory.
///
/// `clippy::assertions_on_constants` fires here because `cfg!` folds to a
/// literal. That is exactly what is being asserted: the value is a fact
/// about how this crate was compiled, and a constant is the only form it
/// could take. Clippy suggests `const { assert!(..) }`, which would make
/// this a compile error instead -- but it would fail to compile only this
/// TEST target, not the binary, so it buys no extra protection over a
/// failing test and reports it less clearly. Kept as a runtime assertion so
/// both guards in this file fail the same way, with their reasons attached.
#[allow(clippy::assertions_on_constants)]
#[test]
fn windows_builds_link_the_crt_statically() {
    assert!(
        cfg!(target_feature = "crt-static"),
        "the msvc build must set -C target-feature=+crt-static (see \
         blockless-installer/.cargo/config.toml). Without it the binary \
         imports VCRUNTIME140.dll and dies with STATUS_DLL_NOT_FOUND, before \
         main and without output, on any machine that has never had the \
         Visual C++ redistributable installed -- i.e. exactly the machine a \
         one-click installer exists to serve."
    );
}

/// The artifact itself, which is what actually ships. The build-config
/// assertion above proves what the compiler was told; this proves what came
/// out. A `[target.<triple>] rustflags` entry applies to both, but they are
/// separate claims and only this one inspects the file a user would run.
///
/// Scanning the raw image for the DLL *name* rather than parsing the PE
/// import directory is deliberate: import names are stored as plain
/// null-terminated ASCII, a scan cannot silently mis-parse a malformed
/// header, and it fails closed. It is not merely "no false negatives" --
/// after the fix these substrings do not occur anywhere in the image at all
/// (verified on the 4.9 MB release binary: zero hits for every needle
/// below), so a hit means a real dependency came back rather than an
/// unrelated string drifting into the binary.
#[test]
fn shipped_binary_imports_no_visual_cpp_redistributable() {
    let exe = env!("CARGO_BIN_EXE_blockless-installer");
    let bytes = std::fs::read(exe).unwrap_or_else(|e| panic!("could not read {exe}: {e}"));
    assert!(
        bytes.len() > 100_000,
        "{exe} is {} bytes -- too small to be the real binary; the scan below \
         would pass vacuously",
        bytes.len()
    );

    // Lowercased once so the search is case-insensitive: the linker's casing
    // of an import name is not something this test should depend on.
    let image: Vec<u8> = bytes.iter().map(u8::to_ascii_lowercase).collect();

    // Each of these means a dynamically-linked CRT: the first two are the
    // redistributable's own DLLs (release and debug spellings), the third is
    // the Universal CRT's api-set stubs, which a static build resolves at
    // link time instead.
    for needle in ["vcruntime", "msvcp", "api-ms-win-crt"] {
        let hit = image
            .windows(needle.len())
            .position(|w| w == needle.as_bytes());
        assert!(
            hit.is_none(),
            "{exe} references '{needle}' (at offset {}), so it links the CRT \
             dynamically and needs the Visual C++ redistributable to start. \
             On a machine without it every subcommand exits 0xC0000135 in the \
             loader, printing nothing. Restore \
             -C target-feature=+crt-static in blockless-installer/.cargo/config.toml.",
            hit.unwrap()
        );
    }
}
