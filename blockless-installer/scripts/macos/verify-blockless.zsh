#!/usr/bin/env zsh
# Blockless installer -- M0 acceptance check (macOS).
#
# Read-only. Prints one PASS/FAIL line per assertion and exits non-zero if any fail.
# This is both the M0 acceptance test and the seed for later CI.
set -uo pipefail

BLK="$HOME/Library/Application Support/Blockless"
STATE="$BLK/state.json"
CODE_USER="$HOME/Library/Application Support/Code/User"
STORAGE="$CODE_USER/globalStorage/storage.json"
PROFILE_NAME="Blockless"
EXT_ID="blockless.mpy-hardware-extension"
PY_EXT_ID="ms-python.python"
# Pylance ships as an extensionDependency of ms-python.python (VS Code auto-installs it); assert
# it landed rather than trusting the dependency resolved.
PYLANCE_ID="ms-python.vscode-pylance"
MPREMOTE_VERSION="1.28.0"

fails=0
pass() { print -r -- "PASS: $*"; }
fail() { print -r -- "FAIL: $*"; fails=$((fails + 1)); }

get_json() { grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$STATE" 2>/dev/null | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'; }

resolve_code() {
  local a="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  local b="$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  [[ -x "$a" ]] && { CODE="$a"; return 0; }
  [[ -x "$b" ]] && { CODE="$b"; return 0; }
  return 1
}

CODE=""
ENVPY="$(get_json envPython)"

# 1. VS Code CLI runnable
if resolve_code && "$CODE" --version >/dev/null 2>&1; then
  pass "VS Code CLI ($("$CODE" --version | head -1))"
else
  fail "VS Code CLI not runnable"; CODE=""
fi

# 2. both extensions in the branded profile
if [[ -n "$CODE" ]]; then
  list="$("$CODE" --profile "$PROFILE_NAME" --list-extensions 2>/dev/null)"
  if print -r -- "$list" | grep -qi "^${EXT_ID}\$" && print -r -- "$list" | grep -qi "^${PY_EXT_ID}\$" && print -r -- "$list" | grep -qi "^${PYLANCE_ID}\$"; then
    pass "extensions in profile '$PROFILE_NAME' (blockless + python + pylance)"
  else
    fail "extensions missing in profile '$PROFILE_NAME' (need blockless + python + pylance)"
  fi
else
  fail "extension check skipped (no code CLI)"
fi

# 3. python env has the pinned mpremote
if [[ -n "$ENVPY" && -x "$ENVPY" ]] && "$ENVPY" -m mpremote version 2>/dev/null | grep -q "$MPREMOTE_VERSION"; then
  pass "mpremote $MPREMOTE_VERSION in env"
else
  fail "mpremote $MPREMOTE_VERSION not found (envPython='$ENVPY')"
fi

# 3b. the env's BASE interpreter is contained under $BLK, not a system/Anaconda python.
# pyvenv.cfg's `home` is the dir of the base interpreter the venv was built on; if step 3
# built off /opt/anaconda3 or /usr, uninstall-by-deleting-one-folder breaks and the env
# depends on software we do not own. This is the guard for the --managed-python pin.
BASE_HOME="$(grep -E '^home[[:space:]]*=' "$BLK/env/pyvenv.cfg" 2>/dev/null | head -1 | sed -E 's/^home[[:space:]]*=[[:space:]]*//')"
# Require an exact match or a real path boundary ($BLK/...), not a bare prefix (which would also accept
# a sibling like "${BLK}-foreign/python"). Compare case-folded: APFS is case-insensitive by default, so
# a casing difference between the resolved home and $BLK is the same directory, not a containment breach.
base_l="${BASE_HOME:l}"; blk_l="${BLK:l}"
if [[ -n "$BASE_HOME" && ( "$base_l" == "$blk_l" || "$base_l" == "$blk_l/"* ) ]]; then
  pass "env base interpreter is contained ($BASE_HOME)"
else
  fail "env base interpreter NOT contained (home='$BASE_HOME', expected under $BLK)"
fi

# 4. the profile's settings.json has our pythonPath -> a real exe. Mechanism A is the only shipped
# path; the profile's on-disk location is journaled in state.json (no storage.json re-read needed).
loc="$(get_json profileLocation)"
target=""
[[ -n "$loc" ]] && target="$CODE_USER/profiles/$loc/settings.json"
if [[ -n "$target" && -f "$target" && -n "$ENVPY" && -x "$ENVPY" ]] && "$ENVPY" - "$target" "$ENVPY" <<'PY'
import json, os, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
p = d.get("mpyhw.pythonPath")
sys.exit(0 if p == sys.argv[2] and os.path.exists(p) else 1)
PY
then
  pass "mpyhw.pythonPath set in the profile settings and points at a real exe"
else
  fail "mpyhw.pythonPath wrong/missing (target='$target')"
fi

# 4b. the profile opts into auto-opening the panel (the extension reads mpyhw.autoOpenPanel on
# onStartupFinished and focuses the panel only when this is true).
if [[ -n "$target" && -f "$target" && -n "$ENVPY" && -x "$ENVPY" ]] && "$ENVPY" - "$target" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
sys.exit(0 if d.get("mpyhw.autoOpenPanel") is True else 1)
PY
then
  pass "mpyhw.autoOpenPanel enabled in the profile settings"
else
  fail "mpyhw.autoOpenPanel not enabled (target='$target')"
fi

# 5. state.json records every step ok
if [[ -f "$STATE" ]] && ! grep -Eq '"(vscode|extension|python|settings)":[[:space:]]*false' "$STATE"; then
  pass "state.json marks all four steps ok"
else
  fail "state.json missing or a step is not ok"
fi

print -r -- "----"
if [[ $fails -eq 0 ]]; then print -r -- "ALL PASS"; exit 0; else print -r -- "$fails FAILED"; exit 1; fi
