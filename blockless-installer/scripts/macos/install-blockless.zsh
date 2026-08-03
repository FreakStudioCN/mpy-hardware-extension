#!/usr/bin/env zsh
# Blockless one-click installer -- M0 script spike (macOS).
#
# Runs the full flow on a fresh Mac: install VS Code, install the extension into a
# branded profile, provision Python + mpremote inside a contained uv, apply branded
# profile settings. Each step is detect -> skip-or-do -> verify, so re-running is a
# repair, not a corruption.
#
# No system Python is ever invoked (that would trigger the Xcode CLT prompt on a
# fresh machine); the VS Code metadata is parsed with grep/sed, and everything from
# step 3 onward uses the interpreter we provision ($ENVPY).
set -euo pipefail

# --- pins (the executable spec the Rust installer-core will mirror) ---
PROFILE_NAME="Blockless"
EXT_ID="blockless.mpy-hardware-extension"
PY_EXT_ID="ms-python.python"
UV_VERSION="0.11.29"
PYTHON_SERIES="3.12"
MPREMOTE_VERSION="1.28.0"
VSCODE_PLATFORM="darwin-universal"
CANARY_THEME="Default Dark Modern"   # visual canary: proves VS Code read our settings (dark; Blockless has no light mode)

# --- paths ---
BLK="$HOME/Library/Application Support/Blockless"
DL="$BLK/downloads"; LOGS="$BLK/logs"; STATE="$BLK/state.json"
CODE_USER="$HOME/Library/Application Support/Code/User"
STORAGE="$CODE_USER/globalStorage/storage.json"
ENVPY="$BLK/env/bin/python"

# --- mutable state (written to state.json as we go; strings are JSON booleans) ---
STEP_VSCODE=false; STEP_EXT=false; STEP_PY=false; STEP_SETTINGS=false
VSCODE_PRODUCT_VERSION=""; SETTINGS_MECHANISM="A"; VSIX_PATH=""; CODE=""
# "We installed VS Code" (step 1 ran) vs "it was already present" (skipped). The uninstaller reads
# this so it only removes VS Code when WE put it there, never a user's pre-existing editor.
VSCODE_INSTALLED_BY_US=false

# --- args: --vsix <path> supplies a bundled fallback for our own extension ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --vsix) VSIX_PATH="${2:-}"; shift 2 ;;
    *) print -u2 -- "unknown arg: $1"; exit 2 ;;
  esac
done

log() { print -r -- "[blockless] $*"; }
die() { print -ru2 -- "[blockless] ERROR: $*"; exit 1; }

# Parse one "key": "value" string field from a flat JSON file (tolerates spaces).
get_json() { grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$2" | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'; }

write_state() {
  cat > "$STATE" <<EOF
{
  "productVersion": "$VSCODE_PRODUCT_VERSION",
  "vscodeInstalledByUs": $VSCODE_INSTALLED_BY_US,
  "steps": { "vscode": $STEP_VSCODE, "extension": $STEP_EXT, "python": $STEP_PY, "settings": $STEP_SETTINGS },
  "mpremoteVersion": "$MPREMOTE_VERSION",
  "envPython": "$ENVPY",
  "settingsMechanism": "$SETTINGS_MECHANISM",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
}

# Resolve the `code` CLI explicitly -- never trust PATH on a fresh machine.
resolve_code() {
  local a="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  local b="$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  [[ -x "$a" ]] && { CODE="$a"; return 0; }
  [[ -x "$b" ]] && { CODE="$b"; return 0; }
  return 1
}

step1_vscode() {
  if resolve_code && "$CODE" --version >/dev/null 2>&1; then
    VSCODE_PRODUCT_VERSION="$("$CODE" --version | head -1)"
    STEP_VSCODE=true; log "step1 VS Code: present ($VSCODE_PRODUCT_VERSION), skip"; return
  fi
  log "step1 VS Code: installing"
  mkdir -p "$DL"
  local meta="$DL/vscode-meta.json"
  curl -fsSL --retry 3 "https://update.code.visualstudio.com/api/update/${VSCODE_PLATFORM}/stable/latest" -o "$meta" \
    || die "could not reach the VS Code update API"
  local url sha ver
  url="$(get_json url "$meta")"; sha="$(get_json sha256hash "$meta")"; ver="$(get_json productVersion "$meta")"
  [[ -n "$url" && -n "$sha" ]] || die "could not parse VS Code download metadata"
  local zip="$DL/VSCode-darwin-universal.zip"
  curl -fL --retry 3 -o "$zip" "$url" || die "VS Code download failed"
  print -r -- "$sha  $zip" | shasum -a 256 -c - >/dev/null 2>&1 || die "VS Code sha256 mismatch (corrupt download)"
  local target="/Applications"
  [[ -w "$target" ]] || { target="$HOME/Applications"; mkdir -p "$target"; }
  ditto -x -k "$zip" "$target" || die "VS Code extract failed"
  xattr -dr com.apple.quarantine "$target/Visual Studio Code.app" 2>/dev/null || true
  resolve_code || die "VS Code CLI not found after install"
  "$CODE" --version >/dev/null 2>&1 || die "VS Code CLI not runnable after install"
  VSCODE_PRODUCT_VERSION="$("$CODE" --version | head -1)"
  [[ "$VSCODE_PRODUCT_VERSION" == "$ver" ]] || log "note: installed $VSCODE_PRODUCT_VERSION, API reported $ver"
  VSCODE_INSTALLED_BY_US=true; STEP_VSCODE=true; log "step1 VS Code: installed ($VSCODE_PRODUCT_VERSION)"
}

has_both_ext() {
  local list; list="$("$CODE" --profile "$PROFILE_NAME" --list-extensions 2>/dev/null)" || return 1
  print -r -- "$list" | grep -qi "^${EXT_ID}\$" && print -r -- "$list" | grep -qi "^${PY_EXT_ID}\$"
}

# Install one extension id; fall back to the bundled .vsix for our own extension if
# the Marketplace is unreachable (restricted school networks).
install_ext() {
  local id="$1"
  "$CODE" --profile "$PROFILE_NAME" --install-extension "$id" --force >/dev/null 2>&1 && return 0
  if [[ "$id" == "$EXT_ID" && -n "$VSIX_PATH" && -f "$VSIX_PATH" ]]; then
    log "step2: marketplace failed for $id, using bundled vsix"
    "$CODE" --profile "$PROFILE_NAME" --install-extension "$VSIX_PATH" --force >/dev/null 2>&1 && return 0
  fi
  return 1
}

# A brand-new VS Code profile only appears in storage.json after VS Code is launched with it
# (a headless --install-extension into a missing profile fails). This is a python-free check —
# step 2 runs before the interpreter exists — so it greps storage.json for the profile entry.
profile_registered() {
  [[ -f "$STORAGE" ]] && grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$PROFILE_NAME\"" "$STORAGE"
}

# Register the profile with the least UI possible. If VS Code is NOT already running, launch it
# hidden and in the background (no focus steal) and quit it the moment the profile registers. If
# the user already has VS Code open, open a normal window and leave their session alone (never
# quit it). Polls for registration instead of a blind sleep so nothing lingers.
register_profile() {
  if profile_registered; then return 0; fi
  local was_running=0
  if pgrep -f "Visual Studio Code.app/Contents/MacOS/Electron" >/dev/null 2>&1; then was_running=1; fi
  if [[ "$was_running" -eq 0 ]]; then
    open -gj -a "Visual Studio Code" --args --profile "$PROFILE_NAME" --new-window >/dev/null 2>&1 || true
  else
    "$CODE" --profile "$PROFILE_NAME" --new-window >/dev/null 2>&1 || true
  fi
  local i
  for i in {1..60}; do
    if profile_registered; then break; fi
    sleep 0.5
  done
  if [[ "$was_running" -eq 0 ]]; then
    osascript -e 'tell application "Visual Studio Code" to quit' >/dev/null 2>&1 || true
  fi
}

step2_extension() {
  if has_both_ext; then STEP_EXT=true; log "step2 extension: present, skip"; return; fi
  log "step2 extension: installing into profile '$PROFILE_NAME'"
  if ! install_ext "$EXT_ID" || ! install_ext "$PY_EXT_ID"; then
    # Fresh-machine guard: a never-launched VS Code has no registered profile, and a headless
    # --install-extension into a missing profile fails. Register it with the least UI possible.
    log "step2: first attempt failed, registering the profile then retrying"
    register_profile
    install_ext "$EXT_ID" || die "failed to install $EXT_ID"
    install_ext "$PY_EXT_ID" || die "failed to install $PY_EXT_ID"
  fi
  has_both_ext || die "extensions missing after install"
  STEP_EXT=true; log "step2 extension: installed"
}

step3_python() {
  if [[ -x "$ENVPY" ]] && "$ENVPY" -m mpremote version 2>/dev/null | grep -q "$MPREMOTE_VERSION"; then
    STEP_PY=true; log "step3 python: mpremote $MPREMOTE_VERSION present, skip"; return
  fi
  local uv="$BLK/uv/uv"
  if [[ ! -x "$uv" ]] || ! "$uv" --version 2>/dev/null | grep -q "$UV_VERSION"; then
    log "step3 python: installing uv $UV_VERSION (contained, no PATH edits)"
    curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | env UV_UNMANAGED_INSTALL="$BLK/uv" sh \
      || die "uv install failed"
  fi
  [[ -x "$uv" ]] || die "uv binary missing after install"
  export UV_PYTHON_INSTALL_DIR="$BLK/python"
  log "step3 python: provisioning Python $PYTHON_SERIES + mpremote $MPREMOTE_VERSION"
  # Contained on purpose: the interpreter installs under $BLK/python (UV_PYTHON_INSTALL_DIR),
  # --no-bin keeps uv from symlinking shims into ~/.local/bin, and --managed-python forces the
  # venv to build on THAT interpreter. Without --managed-python, `uv venv --python 3.12` matches
  # any discoverable 3.12 (e.g. a dev's Anaconda) and the env silently depends on it.
  "$uv" python install --no-bin "$PYTHON_SERIES" || die "uv python install failed"
  "$uv" venv "$BLK/env" --managed-python --python "$PYTHON_SERIES" || die "uv venv failed"
  "$uv" pip install --python "$ENVPY" "mpremote==$MPREMOTE_VERSION" || die "mpremote install failed"
  "$ENVPY" -m mpremote version 2>/dev/null | grep -q "$MPREMOTE_VERSION" || die "mpremote verify failed"
  STEP_PY=true; log "step3 python: ready ($ENVPY)"
}

# --- step 4: branded profile settings + the A/B experiment ---
# ponytail: M0 ships Mechanism A (the per-profile settings.json, which is the
# documented location for a profile's settings). Mechanism B (default settings.json)
# is the insurance path. If the on-camera fresh-VM check shows A is ignored, set
# SETTINGS_MECHANISM=B at the top and re-run; the winner gets recorded in NOTES.md.

# Look up the profile's on-disk directory id from VS Code global storage.
profile_dir() {
  [[ -f "$STORAGE" && -x "$ENVPY" ]] || return 1
  "$ENVPY" - "$STORAGE" "$PROFILE_NAME" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for p in d.get("userDataProfiles", []):
    if p.get("name") == sys.argv[2]:
        print(p.get("location", "")); break
PY
}

# Merge our two keys into a settings.json without clobbering existing keys.
merge_settings() {
  "$ENVPY" - "$1" "$ENVPY" "$CANARY_THEME" <<'PY'
import json, os, sys
target, pypath, theme = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(os.path.dirname(target), exist_ok=True)
try:
    data = json.load(open(target))
except Exception:
    data = {}
data["mpyhw.pythonPath"] = pypath
data["workbench.colorTheme"] = theme
# Opt this dedicated Blockless profile into auto-opening the panel on every startup (the
# extension reads this; off by default so Marketplace users are unaffected).
data["mpyhw.autoOpenPanel"] = True
json.dump(data, open(target, "w"), indent=2)
PY
}

settings_already() {
  [[ -f "$1" && -x "$ENVPY" ]] || return 1
  "$ENVPY" - "$1" "$ENVPY" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
sys.exit(0 if d.get("mpyhw.pythonPath") == sys.argv[2] else 1)
PY
}

step4_settings() {
  local loc; loc="$(profile_dir || true)"
  if [[ -z "$loc" && "$SETTINGS_MECHANISM" == "A" ]]; then
    log "step4: profile not registered yet, registering"
    register_profile
    loc="$(profile_dir || true)"
  fi
  local target
  if [[ "$SETTINGS_MECHANISM" == "A" && -n "$loc" ]]; then
    target="$CODE_USER/profiles/$loc/settings.json"
  else
    SETTINGS_MECHANISM="B"; target="$CODE_USER/settings.json"
  fi
  if settings_already "$target"; then
    STEP_SETTINGS=true; log "step4 settings: already applied ($SETTINGS_MECHANISM), skip"; return
  fi
  merge_settings "$target" || die "could not write settings ($target)"
  STEP_SETTINGS=true
  log "step4 settings: applied via mechanism $SETTINGS_MECHANISM -> $target"
  log "step4: run 'code --profile $PROFILE_NAME' to confirm profile + canary theme + pythonPath on camera"
}

# Final launch: drop the user straight INTO the Blockless profile so the extension is right
# there when setup finishes. Unlike register_profile's hidden registration, this one is
# intentional and visible (foreground) — it is the "you're ready, here's Blockless" moment.
open_blockless() {
  log "opening the Blockless profile"
  "$CODE" --profile "$PROFILE_NAME" --new-window >/dev/null 2>&1 \
    || open -a "Visual Studio Code" --args --profile "$PROFILE_NAME" --new-window >/dev/null 2>&1 \
    || true
}

main() {
  mkdir -p "$DL" "$LOGS"
  step1_vscode;    write_state
  step2_extension; write_state
  step3_python;    write_state
  step4_settings;  write_state
  log "setup complete. run verify-blockless.zsh to check."
  open_blockless
}
main "$@"
