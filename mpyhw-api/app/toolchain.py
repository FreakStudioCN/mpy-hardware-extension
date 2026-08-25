"""Toolchain compatibility version.

The API serves skills (SKILL.md) live, but the scripts those skills invoke
(init_scaffold, validate_json, render_wiring/diagram, download_drivers) are frozen
into the installed VSIX at package time. Bump this — together with the extension's
BUNDLED_TOOLCHAIN_VERSION (src/core/toolchain-version.ts) — whenever a bundled
script's contract changes. The extension warns (non-blocking) when its bundled
version is older than what the live API advertises.
"""

# 2: init_scaffold and its firmware templates changed across TWO skills pin moves and
# this constant was not bumped for either, so v1 covers 65bef88 through 5ab8e9c. The
# change that matters to an installed extension is that the templates now print
# MPYHW_READY after hardware init: an older bundled scaffold renders firmware that never
# prints it, while the live deploy skill stop-matches on it, so the capture stalls and
# the phase fails with nothing naming the cause.
TOOLCHAIN_VERSION = "2"
