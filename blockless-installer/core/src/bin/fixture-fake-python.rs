//! A real executable that stands in for `env/Scripts/python.exe` in the Windows
//! script-parity fixture. Not part of the product.
//!
//! It exists because Windows will not run a script placed at a `.exe` path.
//! The fixture originally wrote a batch file there, on the belief that Windows
//! resolves an executable by content rather than by extension. It does not: both
//! PowerShell's `&` and `Command::new` fail on such a file, which failed all nine
//! parity cases and, worse, hid a defect in `verify-blockless.ps1` that let it
//! report ALL PASS while silently dropping a check.
//!
//! The version is read from `mpremote-version.txt` beside this executable rather
//! than baked in or taken from the environment. Each fixture writes its own file,
//! so the `Mpremote` break can report a mismatched version while the other cases
//! report the pinned one, and nothing is shared between tests running in
//! parallel.
//!
//! Answers only `-m mpremote version`, which is the sole way both
//! `verify-blockless.ps1` and `RuntimeRunner::mpremote_version` invoke it.
//! Anything else exits non-zero, so a fixture that starts depending on some other
//! invocation fails loudly rather than silently reporting nothing.

use std::io::Write;

const VERSION_FILE: &str = "mpremote-version.txt";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args != ["-m", "mpremote", "version"] {
        let _ = writeln!(
            std::io::stderr(),
            "fixture-fake-python answers only `-m mpremote version`, got {args:?}"
        );
        std::process::exit(1);
    }

    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "cannot resolve current exe: {e}");
            std::process::exit(1);
        }
    };
    let version_path = exe.with_file_name(VERSION_FILE);
    let version = match std::fs::read_to_string(&version_path) {
        Ok(v) => v,
        Err(e) => {
            // Never fall back to a default: a fixture that forgot to write this
            // would otherwise report a plausible version it never asked for, and
            // the check it feeds would pass for the wrong reason.
            let _ = writeln!(std::io::stderr(), "missing {}: {e}", version_path.display());
            std::process::exit(1);
        }
    };

    println!("mpremote {}", version.trim());
}
