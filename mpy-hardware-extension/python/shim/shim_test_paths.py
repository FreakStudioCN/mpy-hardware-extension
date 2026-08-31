"""Where the tests resolve upstream files from -- NOT serve.scripts_root().

serve.scripts_root() answers a RUNTIME question ("where did the VSIX put the scripts?"), and its
first candidate is <ext>/third_party, the vendored snapshot `npm run package` writes. That snapshot
is the wrong source for a test twice over:

  * it is a SNAPSHOT. It is gitignored and only rewritten by a packaging run, so after the submodule
    pin moves it still holds the previous pin's files. A test asserting a shared cross-repo contract
    against it asserts the contract as it was the last time somebody packaged -- which is exactly
    the drift such a test exists to catch.
  * it is a SUBSET. vendor-plugin-subset.mjs drops .md, test/ and the maintenance scripts by design,
    so files that genuinely exist upstream are missing from it.

Both bit us: on a machine that had ever run `npm run package`, `npm run baseline` failed in
test_serve.py on a maintenance script the packager had deliberately stripped, and the shared
descriptorless-port fixture was read from the frozen copy. CI never saw either, because its checkout
runs pytest without a packaging step, so <ext>/third_party does not exist there and scripts_root()
falls through to the submodule. Tests asking about upstream must ask the submodule directly.
"""

import os

# <repo>/mpy-hardware-extension/python/shim/ -> <repo>
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))


def submodule_root() -> str:
    """The MicroPython_Skills submodule checkout: the source of truth for upstream files."""
    return os.path.join(_REPO_ROOT, "third_party", "MicroPython_Skills")
