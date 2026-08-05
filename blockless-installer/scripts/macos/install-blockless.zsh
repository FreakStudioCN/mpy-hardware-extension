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
PROFILE_LOCATION="blockless"          # the on-disk profiles/<loc> id we seed for our profile
EXT_ID="blockless.mpy-hardware-extension"
PY_EXT_ID="ms-python.python"
# Pylance ships as an extensionDependency of ms-python.python (VS Code auto-installs it). verify asserts
# all three, so the install idempotency check must require all three too, else a re-run skips step 2
# forever while verify fails permanently (no repair path).
PYLANCE_ID="ms-python.vscode-pylance"
UV_VERSION="0.11.29"
# sha256 of the version-pinned uv install script. We download it to a file, verify this digest, then
# run it, rather than piping curl straight to sh: a compromised astral.sh response would otherwise be
# arbitrary code execution as the installing user. (The Rust installer-core pins the uv BINARY itself
# with a checksum; this is the script-level equivalent.)
UV_INSTALL_SHA256="504a79fd2ed0dcd47e7f04f0792cfd0871f62e24a7fe40fa8ae0f563a369f2bd"
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
# Did THIS installer create the branded profile (vs adopt a user's pre-existing profile of the same
# name)? The uninstaller only deletes the profile dir when this is true, so it never destroys a user's
# own "Blockless" profile. PROFILE_LOCATION is journaled so uninstall need not re-read storage.json.
PROFILE_CREATED_BY_US=false
# sha256 of the VSIX our extension was installed from. Recorded so a re-run reinstalls when the bundled
# build changes, and so a stale Marketplace build of the same version number is never mistaken for ours.
EXT_VSIX_SHA256=""; VSIX_SHA256=""; PRIOR_EXT_VSIX_SHA256=""
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
  "profileCreatedByUs": $PROFILE_CREATED_BY_US,
  "profileLocation": "$PROFILE_LOCATION",
  "steps": { "vscode": $STEP_VSCODE, "extension": $STEP_EXT, "python": $STEP_PY, "settings": $STEP_SETTINGS },
  "mpremoteVersion": "$MPREMOTE_VERSION",
  "envPython": "$ENVPY",
  "extVsixSha256": "$EXT_VSIX_SHA256",
  "settingsMechanism": "$SETTINGS_MECHANISM",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
}

# Preserve "we installed VS Code" across idempotent re-runs. On a re-run where step 1 SKIPS (VS Code
# already present, possibly because a PRIOR run of THIS installer put it there), the skip branch
# leaves VSCODE_INSTALLED_BY_US at its false default -- clobbering a true recorded earlier and making
# the uninstaller refuse to remove a VS Code we installed. Seed the flag from any existing state.json.
read_prior_state() {
  [[ -f "$STATE" ]] || return 0
  grep -q '"vscodeInstalledByUs"[[:space:]]*:[[:space:]]*true' "$STATE" && VSCODE_INSTALLED_BY_US=true
  # Preserve "we created the profile" across re-runs: on a repair run the profile already exists (WE
  # made it last time), so without this the current run would record false and the uninstaller would
  # then refuse to remove a profile it should own.
  grep -q '"profileCreatedByUs"[[:space:]]*:[[:space:]]*true' "$STATE" && PROFILE_CREATED_BY_US=true
  PRIOR_EXT_VSIX_SHA256="$(get_json extVsixSha256 "$STATE" || true)"
  # Carry the recorded sha forward so the incremental write_state before step 2 does not transiently
  # blank it (a crash mid-run would otherwise force one redundant reinstall on the next run).
  EXT_VSIX_SHA256="$PRIOR_EXT_VSIX_SHA256"
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
  # `|| true`: get_json is a grep|head|sed pipeline; under `set -o pipefail` a missing field would
  # make the assignment exit non-zero and errexit would kill the script BEFORE the die below.
  url="$(get_json url "$meta" || true)"; sha="$(get_json sha256hash "$meta" || true)"; ver="$(get_json productVersion "$meta" || true)"
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

has_ext() {
  local id="$1" list
  list="$("$CODE" --profile "$PROFILE_NAME" --list-extensions 2>/dev/null)" || return 1
  print -r -- "$list" | grep -qi "^${id}\$"
}

# Our extension is "current" only if it is present AND was installed from the exact VSIX we bundle now
# (matched by the sha256 journaled in state.json). Presence alone is not enough: a Marketplace build
# with the SAME version number but built before mpyhw.autoOpenPanel would pass an id/version check yet
# break auto-open, and verify (which checks the SETTING we write, not the build) would not catch it.
our_ext_is_bundled_build() {
  has_ext "$EXT_ID" && [[ -n "$VSIX_SHA256" && "$PRIOR_EXT_VSIX_SHA256" == "$VSIX_SHA256" ]]
}

all_ext_current() {
  our_ext_is_bundled_build && has_ext "$PY_EXT_ID" && has_ext "$PYLANCE_ID"
}

# Install one extension id. For OUR extension, install ONLY the bundled vsix (the exact build this
# installer ships + verifies). We deliberately do NOT fall back to the Marketplace: its 0.4.2 is an
# OLDER build (same version number, built before mpyhw.autoOpenPanel existed), so installing it
# produces a broken auto-open that verify cannot catch (verify checks the SETTING we write, not the
# extension build). A missing/failed vsix must fail loudly, not silently install a broken build.
# Other ids (ms-python.python -> also pulls Pylance) come from the Marketplace.
install_ext() {
  local id="$1"
  if [[ "$id" == "$EXT_ID" ]]; then
    [[ -n "$VSIX_PATH" && -f "$VSIX_PATH" ]] || { log "step2: no bundled vsix (--vsix) for $id; refusing the stale Marketplace build"; return 1; }
    log "step2: installing $id from the bundled vsix"
    "$CODE" --profile "$PROFILE_NAME" --install-extension "$VSIX_PATH" --force >/dev/null 2>&1 && return 0
    return 1
  fi
  "$CODE" --profile "$PROFILE_NAME" --install-extension "$id" --force >/dev/null 2>&1 && return 0
  return 1
}

# A brand-new VS Code profile only appears in storage.json after VS Code is launched with it
# (a headless --install-extension into a missing profile fails). This is a python-free check —
# step 2 runs before the interpreter exists — so it greps storage.json for the profile entry.
profile_registered() {
  [[ -f "$STORAGE" ]] && grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$PROFILE_NAME\"" "$STORAGE"
}

# Register the profile WITHOUT launching VS Code, by seeding storage.json's userDataProfiles entry
# ourselves (the internal name->location mapping mechanism A already reads).
# WHY (root cause of "panel never auto-opens", found + fixed on Windows): registering via a live
# window then quitting VS Code mid-startup leaves half-written window state, so the final cold launch
# resolves the window's INITIAL extension list against the DEFAULT profile, fires onStartupFinished
# with built-ins only, and delta-adds the profile's extensions moments later -- too late:
# onStartupFinished never re-fires, so the extension's activate()/auto-open never runs (even though
# the icon still works via onView). Seeding storage.json means NO window ever exists before the final
# launch: the CLI installs straight into profiles/blockless/, and open_blockless opens the profile's
# FIRST-ever window with the extension present. If a VS Code is running it owns storage.json in memory
# and would clobber our edit, so skip -- register_profile's window fallback covers that.
# The JSON edit uses JXA (osascript -l JavaScript): python-free (step 2 runs before $ENVPY exists,
# and system python3 would trigger the Xcode CLT prompt on a fresh Mac) and macOS-native.
register_profile_offline() {
  if profile_registered; then return 0; fi
  if pgrep -f "Visual Studio Code.app/Contents/MacOS/Electron" >/dev/null 2>&1; then return 0; fi
  mkdir -p "$(dirname "$STORAGE")" "$CODE_USER/profiles/blockless"
  osascript -l JavaScript - "$STORAGE" "$PROFILE_NAME" "blockless" >/dev/null 2>&1 <<'JXA' || true
ObjC.import('Foundation');
function run(argv) {
  var path = argv[0], name = argv[1], loc = argv[2];
  var fm = $.NSFileManager.defaultManager;
  var obj = {};
  if (fm.fileExistsAtPath(path)) {
    var raw = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, $()).js;
    // An EXISTING storage.json we can't parse must NOT be replaced (that would wipe every other
    // profile + window state). Skip the offline seed; register_profile's window fallback covers it.
    try { obj = JSON.parse(raw); } catch (e) { return; }
  }
  if (Object.prototype.toString.call(obj.userDataProfiles) !== '[object Array]') obj.userDataProfiles = [];
  var found = false;
  for (var i = 0; i < obj.userDataProfiles.length; i++) { if (obj.userDataProfiles[i] && obj.userDataProfiles[i].name === name) found = true; }
  if (!found) obj.userDataProfiles.push({ location: loc, name: name });
  $(JSON.stringify(obj)).writeToFileAtomicallyEncodingError($(path), true, $.NSUTF8StringEncoding, $());
}
JXA
  if profile_registered; then log "step2: profile '$PROFILE_NAME' registered offline (no VS Code launch)"; fi
}

# Graceful close + WAIT for every VS Code process to exit. Graceful (osascript quit), not a hard kill,
# so VS Code saves its window/profile state; then wait to zero so the next launch is a FRESH instance
# (a running extension host won't load a newly-installed extension). Hard kill only as a last resort.
stop_code_and_wait() {
  osascript -e 'tell application "Visual Studio Code" to quit' >/dev/null 2>&1 || true
  local i
  for i in {1..60}; do
    if ! pgrep -f "Visual Studio Code.app/Contents/MacOS/Electron" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  if pgrep -f "Visual Studio Code.app/Contents/MacOS/Electron" >/dev/null 2>&1; then
    pkill -f "Visual Studio Code.app/Contents/MacOS/Electron" 2>/dev/null || true
    for i in {1..20}; do
      if ! pgrep -f "Visual Studio Code.app/Contents/MacOS/Electron" >/dev/null 2>&1; then break; fi
      sleep 0.25
    done
  fi
}

# Fallback only (a live VS Code owns storage.json, or a future VS Code stops honoring the seeded
# entry): a new profile also appears after VS Code is launched with it. Launch it, poll for
# registration, then close it if we were the ones who started it (never quit a user's session). NOTE:
# this path re-creates the half-written-state race described above -- keep it a last resort.
register_profile() {
  if profile_registered; then return 0; fi
  local was_running=0
  if pgrep -f "Visual Studio Code.app/Contents/MacOS/Electron" >/dev/null 2>&1; then was_running=1; fi
  "$CODE" --profile "$PROFILE_NAME" --new-window >/dev/null 2>&1 &
  local i
  for i in {1..60}; do
    if profile_registered; then break; fi
    sleep 0.5
  done
  if [[ "$was_running" -eq 0 ]]; then stop_code_and_wait; fi
}

step2_extension() {
  [[ -n "$VSIX_PATH" && -f "$VSIX_PATH" ]] && VSIX_SHA256="$(shasum -a 256 "$VSIX_PATH" | awk '{print $1}')"
  # Record whether WE create the profile (vs adopt a user's pre-existing profile of the same name),
  # BEFORE we seed it. read_prior_state may have already set this true from an earlier run of ours.
  if [[ "$PROFILE_CREATED_BY_US" == false ]] && ! profile_registered; then PROFILE_CREATED_BY_US=true; fi

  if all_ext_current; then
    STEP_EXT=true; EXT_VSIX_SHA256="$VSIX_SHA256"
    log "step2 extension: present (matching bundled build), skip"; return
  fi
  log "step2 extension: installing into profile '$PROFILE_NAME'"
  # Headless registration FIRST: no VS Code window may exist before the final launch (see
  # register_profile_offline for why -- it is the panel-auto-open fix).
  register_profile_offline
  if ! install_ext "$EXT_ID" || ! install_ext "$PY_EXT_ID"; then
    # Fallback: a never-launched VS Code (or one that ignored the seeded entry) may still lack the
    # profile, and a headless --install-extension into a missing profile fails. Register via a window.
    log "step2: first attempt failed, registering the profile then retrying"
    register_profile
    install_ext "$EXT_ID" || die "failed to install $EXT_ID"
    install_ext "$PY_EXT_ID" || die "failed to install $PY_EXT_ID"
  fi
  # Pylance ships as a dependency of ms-python.python; if it did not resolve, install it explicitly so
  # verify (which requires it) has a repair path instead of failing forever.
  has_ext "$PYLANCE_ID" || install_ext "$PYLANCE_ID" || die "failed to install $PYLANCE_ID"
  { has_ext "$EXT_ID" && has_ext "$PY_EXT_ID" && has_ext "$PYLANCE_ID"; } || die "extensions missing after install"
  EXT_VSIX_SHA256="$VSIX_SHA256"
  STEP_EXT=true; log "step2 extension: installed"
}

step3_python() {
  if [[ -x "$ENVPY" ]] && "$ENVPY" -m mpremote version 2>/dev/null | grep -q "$MPREMOTE_VERSION"; then
    STEP_PY=true; log "step3 python: mpremote $MPREMOTE_VERSION present, skip"; return
  fi
  local uv="$BLK/uv/uv"
  if [[ ! -x "$uv" ]] || ! "$uv" --version 2>/dev/null | grep -q "$UV_VERSION"; then
    log "step3 python: installing uv $UV_VERSION (contained, no PATH edits)"
    local uv_ivs="$DL/uv-install.sh"
    curl -fsSL --retry 3 "https://astral.sh/uv/${UV_VERSION}/install.sh" -o "$uv_ivs" || die "uv install script download failed"
    print -r -- "$UV_INSTALL_SHA256  $uv_ivs" | shasum -a 256 -c - >/dev/null 2>&1 || die "uv install script sha256 mismatch (refusing to run)"
    env UV_UNMANAGED_INSTALL="$BLK/uv" sh "$uv_ivs" || die "uv install failed"
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

# --- step 4: branded profile settings ---
# The fresh-VM check settled the A/B experiment: Mechanism A (the per-profile settings.json, the
# documented location for a profile's settings) is what VS Code reads, so it is the only path shipped.
# Mechanism B (the user's default settings.json) was removed, we never write there (see step4_settings).
# SETTINGS_MECHANISM stays "A", recorded in state.json for the record.

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

# Merge our four keys into a settings.json without clobbering existing keys.
merge_settings() {
  "$ENVPY" - "$1" "$ENVPY" "$CANARY_THEME" <<'PY'
import json, os, sys
target, pypath, theme = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(os.path.dirname(target), exist_ok=True)
if os.path.exists(target):
    try:
        data = json.load(open(target))
    except Exception:
        # An EXISTING settings.json we cannot parse (VS Code settings are JSONC, may carry comments).
        # Refuse to clobber it rather than overwrite the user's edits with just our keys.
        sys.exit(2)
else:
    data = {}
data["mpyhw.pythonPath"] = pypath
data["workbench.colorTheme"] = theme
# Opt this dedicated Blockless profile into auto-opening the panel on every startup (the
# extension reads this; off by default so Marketplace users are unaffected).
data["mpyhw.autoOpenPanel"] = True
# Hide the secondary (chat) side bar for the branded kiosk look (matches the Windows installer).
data["workbench.secondarySideBar.defaultVisibility"] = "hidden"
json.dump(data, open(target, "w"), indent=2)
PY
}

settings_already() {
  [[ -f "$1" && -x "$ENVPY" ]] || return 1
  "$ENVPY" - "$1" "$ENVPY" "$CANARY_THEME" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
# All FOUR installer-owned keys must match, not just pythonPath: a repair run must re-apply the theme,
# autoOpenPanel, or secondarySideBar visibility if any was removed/changed, otherwise the branded UI /
# panel auto-open stays broken while the step reports "already applied".
ok = (d.get("mpyhw.pythonPath") == sys.argv[2]
      and d.get("workbench.colorTheme") == sys.argv[3]
      and d.get("mpyhw.autoOpenPanel") is True
      and d.get("workbench.secondarySideBar.defaultVisibility") == "hidden")
sys.exit(0 if ok else 1)
PY
}

step4_settings() {
  local loc; loc="$(profile_dir || true)"
  if [[ -z "$loc" ]]; then
    log "step4: profile not registered yet, registering"
    register_profile_offline
    profile_registered || register_profile
    loc="$(profile_dir || true)"
  fi
  # Mechanism A ONLY: write the PROFILE's own settings.json. We deliberately do NOT fall back to the
  # user's default settings.json (the old "mechanism B"): the theme + autoOpenPanel are a kiosk choice
  # for THIS profile, and the default settings.json is the user's own file (JSONC, likely with
  # comments) that we must never own or overwrite. If the profile still can't be resolved, fail loudly.
  [[ -n "$loc" ]] || die "could not resolve the '$PROFILE_NAME' profile settings location"
  local target="$CODE_USER/profiles/$loc/settings.json"
  if settings_already "$target"; then
    STEP_SETTINGS=true; log "step4 settings: already applied, skip"; return
  fi
  merge_settings "$target" || die "could not write settings ($target)"
  STEP_SETTINGS=true
  log "step4 settings: applied -> $target"
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
  read_prior_state
  # Our extension is only ever installed from the bundled VSIX (never the Marketplace, see install_ext),
  # so --vsix is required on every run, including repairs. Fail fast here rather than after downloading
  # VS Code and launching a throwaway window in step 2.
  [[ -n "$VSIX_PATH" && -f "$VSIX_PATH" ]] || die "--vsix <path> to the bundled Blockless extension is required; re-run with: --vsix /path/to/mpy-hardware-extension.vsix"
  step1_vscode;    write_state
  step2_extension; write_state
  step3_python;    write_state
  step4_settings;  write_state
  log "setup complete. run verify-blockless.zsh to check."
  open_blockless
}
main "$@"
