"""Toolchain compatibility version.

The API serves skills (SKILL.md) live, but the scripts those skills invoke
(init_scaffold, validate_json, render_wiring/diagram, download_drivers) are frozen
into the installed VSIX at package time. Bump this — together with the extension's
BUNDLED_TOOLCHAIN_VERSION (src/core/toolchain-version.ts) — whenever a bundled
script's contract changes. The extension warns (non-blocking) when its bundled
version is older than what the live API advertises.
"""

TOOLCHAIN_VERSION = "1"
