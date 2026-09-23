//! The shipped GUI must link as a WINDOWS (GUI) subsystem binary, so launching
//! it does not also open a console window.
//!
//! THE INCIDENT. Found on the Windows Sandbox rig, 2026-09-22: without
//! `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` in
//! `src/main.rs`, rustc links the msvc binary as CONSOLE subsystem and Windows
//! allocates a console for it on every launch -- a black window titled with the
//! exe's full path, taking foreground focus, sitting in front of the installer
//! UI for the whole session. Tauri's own template ships that attribute; this
//! crate did not have it.
//!
//! WHY A TEST AND NOT JUST THE ATTRIBUTE. No gate could see the defect. The
//! cargo gate never launches a window, and the macOS acceptance structurally
//! cannot observe a Windows-only linker attribute -- the same blind spot as the
//! `VCRUNTIME140.dll` incident recorded in `../../.cargo/config.toml`, one layer
//! further out. It took a human looking at a screenshot.
//!
//! THIS TEST IS VACUOUS IN A DEBUG BUILD, ON PURPOSE, AND SAYS SO. The attribute
//! is scoped to `not(debug_assertions)` so `cargo run` keeps its terminal during
//! development, which means a debug binary is legitimately CONSOLE. `cargo test`
//! builds the debug profile by default, so this only asserts anything under
//! `cargo test --release`. That is a real limitation, not a hidden one: a check
//! that cannot fail must never look like one that passed. CI runs the release
//! form explicitly (see `.github/workflows/installer-ci.yml`).
#![cfg(windows)]

/// `IMAGE_SUBSYSTEM_WINDOWS_GUI`
const WINDOWS_GUI: u16 = 2;
/// `IMAGE_SUBSYSTEM_WINDOWS_CUI`
const WINDOWS_CUI: u16 = 3;

/// Read the PE optional header's `Subsystem` field.
///
/// Layout: `e_lfanew` is a u32 at 0x3C pointing at the `PE\0\0` signature;
/// the 20-byte COFF header follows it, then the optional header, whose
/// `Subsystem` sits at offset 68 in BOTH PE32 and PE32+. So the field is at
/// `e_lfanew + 4 + 20 + 68`.
fn pe_subsystem(bytes: &[u8]) -> u16 {
    let e_lfanew = u32::from_le_bytes(bytes[0x3C..0x40].try_into().unwrap()) as usize;
    assert_eq!(
        &bytes[e_lfanew..e_lfanew + 4],
        b"PE\0\0",
        "not a PE image: no PE signature at e_lfanew"
    );
    let off = e_lfanew + 4 + 20 + 68;
    u16::from_le_bytes(bytes[off..off + 2].try_into().unwrap())
}

#[test]
fn release_builds_link_as_a_gui_subsystem_binary() {
    let exe = env!("CARGO_BIN_EXE_blockless-installer-gui");
    let bytes = std::fs::read(exe).unwrap_or_else(|e| panic!("could not read {exe}: {e}"));
    let subsystem = pe_subsystem(&bytes);

    if cfg!(debug_assertions) {
        // Debug is legitimately a console binary. Assert only that the field
        // is one of the two we understand, so a garbled parse still fails
        // here rather than silently reporting a wrong number in release.
        assert!(
            subsystem == WINDOWS_GUI || subsystem == WINDOWS_CUI,
            "{exe} has an unexpected PE subsystem {subsystem}; the parse is \
             probably wrong, which would make the release assertion below \
             meaningless"
        );
        eprintln!(
            "note: debug build, subsystem={subsystem} (console is correct here). \
             Run `cargo test --release` to assert the shipped form."
        );
        return;
    }

    assert_eq!(
        subsystem, WINDOWS_GUI,
        "{exe} links as subsystem {subsystem} (3 = console), so every launch \
         opens a stray console window in front of the installer UI. Restore \
         `#![cfg_attr(not(debug_assertions), windows_subsystem = \"windows\")]` \
         at the top of src/main.rs."
    );
}
