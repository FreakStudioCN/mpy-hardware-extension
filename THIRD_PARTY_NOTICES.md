# Third-party notices

The root MIT license covers project-owned Blockless code. The extension package uses the same MIT text in `mpy-hardware-extension/LICENSE.txt`. The pre-existing `blockless` attribution is retained; the root's former `<COPYRIGHT HOLDER>` placeholder was not evidence of a different owner. Contributors retain their own rights.

| Material | Location | Applicable terms |
| --- | --- | --- |
| MicroPython Skills | `third_party/MicroPython_Skills/` submodule | Its own MIT LICENSE, copyright 2026 leezisheng; the pinned commit is controlled by the parent repository |
| GraftSense drivers | `third_party/GraftSense-Drivers-MicroPython/` submodule | Driver-level LICENSE files and headers; many carry FreakStudio MIT attribution. There is no blanket replacement by this repository's MIT license |
| Copied driver context/source and metadata | `mpyhw-api/content/packages/` | Retain source references, copyright and embedded license text per record. A context record is not a grant to relicense upstream driver code |
| OWASP-derived security reference material | `.agents/skills/security-review/` and `.claude/skills/security-review/` | CC BY-SA 4.0, OWASP Cheat Sheet Series; retain each directory's LICENSE and attribution |
| Imported research/reference documents | `docs/research/pitch-archive/`, imported excerpts and `dev/extracted/` | Original authors' terms; excluded from root MIT. Some imported items have no explicit redistribution license in the checkout; do not interpret inclusion as an MIT grant |
| Partner/vendor marks | `mpy-hardware-extension/src/webview/assets/partners/` | Respective owners' trademarks and artwork rights; no trademark grant is made |
| Node, Rust and Python dependencies | Package/Cargo locks and dependency manifests | Each dependency's own license; dependency license fields were not changed |

The GraftSense driver and workflow submodules remain separate upstream works. Installers or extension redistributions that bundle their contents must preserve their notices. Firmware downloads, `mip` packages and external driver repositories remain governed by their original licenses.

The README screenshot is a capture of the actual shipped webview rendered locally with checked-in board data. [Asset notes](docs/assets/readme/README.md) explain the environment and limits; it does not show a successful hardware deployment.

This file documents the boundaries found during a focused documentation/license pass. It is not a complete dependency bill of materials or a clearance of imported reference material lacking an explicit license.
