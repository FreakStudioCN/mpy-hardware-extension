//! Mirrors `cli/tests/windows_crt_static.rs`'s two guards for the GUI exe:
//! the shipped Windows binary must not depend on the Visual C++
//! redistributable either. See that file's own doc comment for the full
//! incident writeup (`STATUS_DLL_NOT_FOUND` on a fresh Windows Sandbox) --
//! the risk and the fix (`.cargo/config.toml`'s `-C target-feature=+crt-static`
//! via ancestor discovery from `blockless-installer/`) are identical for
//! this crate, just for a second binary.
#![cfg(windows)]

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

/// Same raw-image scan as the CLI's guard, against the GUI's own exe. A hit
/// here on a WebView2-loader string would be a plausible false positive --
/// investigate with dumpbin before touching the needle list; weakening this
/// guard to pass is the exact failure the CLI test's doc comment warns
/// against.
#[test]
fn shipped_binary_imports_no_visual_cpp_redistributable() {
    let exe = env!("CARGO_BIN_EXE_blockless-installer-gui");
    let bytes = std::fs::read(exe).unwrap_or_else(|e| panic!("could not read {exe}: {e}"));
    assert!(
        bytes.len() > 100_000,
        "{exe} is {} bytes -- too small to be the real binary; the scan below \
         would pass vacuously",
        bytes.len()
    );

    let image: Vec<u8> = bytes.iter().map(u8::to_ascii_lowercase).collect();

    for needle in ["vcruntime", "msvcp", "api-ms-win-crt"] {
        let hit = image
            .windows(needle.len())
            .position(|w| w == needle.as_bytes());
        assert!(
            hit.is_none(),
            "{exe} references '{needle}' (at offset {}), so it links the CRT \
             dynamically and needs the Visual C++ redistributable to start. \
             On a machine without it every launch exits 0xC0000135 in the \
             loader, printing nothing. Restore \
             -C target-feature=+crt-static in blockless-installer/.cargo/config.toml.",
            hit.unwrap()
        );
    }
}
