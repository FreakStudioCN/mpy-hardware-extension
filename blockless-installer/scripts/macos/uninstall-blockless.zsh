#!/usr/bin/env zsh
# Blockless uninstaller (macOS). Removes everything the installer created:
#   1. the branded "Blockless" VS Code profile (profile dir + its storage.json entry)
#   2. the contained runtime under ~/Library/Application Support/Blockless (uv, python, env,
#      downloads, logs, state.json)
# VS Code itself and its OTHER profiles are left untouched by default. VS Code is removed ONLY when
# the installer recorded that it installed it (state.json vscodeInstalledByUs) — never a user's
# pre-existing editor. --all forces removal, --keep-vscode prevents it. The shared VS Code user
# data (~/Library/Application Support/Code) is never touched.
#
# Doubles as the test reset: run this in the VM to get back to a clean slate without re-cloning
# (use --all for a true cold reset so a re-run exercises the VS Code install path again).
set -uo pipefail

PROFILE_NAME="Blockless"
BLK="$HOME/Library/Application Support/Blockless"
CODE_USER="$HOME/Library/Application Support/Code/User"
STORAGE="$CODE_USER/globalStorage/storage.json"
ENVPY="$BLK/env/bin/python"

log() { print -r -- "[blockless-uninstall] $*"; }

# --- options ---
FORCE_VSCODE=false; KEEP_VSCODE=false
for arg in "$@"; do
  case "$arg" in
    --all) FORCE_VSCODE=true ;;
    --keep-vscode) KEEP_VSCODE=true ;;
    *) print -ru2 -- "unknown arg: $arg (use --all or --keep-vscode)"; exit 2 ;;
  esac
done

# Read BEFORE we delete $BLK: did the installer put VS Code here? Default is to remove VS Code only
# when we installed it.
INSTALLED_BY_US=false
[[ -f "$BLK/state.json" ]] && grep -Eq '"vscodeInstalledByUs"[[:space:]]*:[[:space:]]*true' "$BLK/state.json" && INSTALLED_BY_US=true

# A running VS Code holds storage.json in memory and will clobber our edit: it can restore the
# deleted Blockless entry after we remove the profile dir, or overwrite concurrently-changed shared
# state. So skip the profile removal entirely while VS Code is running and tell the user to close it.
vscode_running=0
if pgrep -f "Visual Studio Code.app/Contents/MacOS/Electron" >/dev/null 2>&1; then vscode_running=1; fi

# 1. Remove the Blockless profile FIRST (uses the provisioned python to rewrite storage.json, which
# only exists until step 2 deletes $BLK). Fall back to python3 if the env is already gone.
py=""
[[ -x "$ENVPY" ]] && py="$ENVPY"
[[ -z "$py" ]] && command -v python3 >/dev/null 2>&1 && py="python3"

if [[ "$vscode_running" -eq 1 ]]; then
  log "VS Code is running; leaving the '$PROFILE_NAME' profile untouched to avoid racing storage.json (quit VS Code and re-run to remove the profile). Removing the contained runtime only."
else
  loc=""
  if [[ -n "$py" && -f "$STORAGE" ]]; then
    loc="$("$py" - "$STORAGE" "$PROFILE_NAME" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
print(next((p.get("location", "") for p in d.get("userDataProfiles", []) if p.get("name") == sys.argv[2]), ""))
PY
)"
    # Drop the profile's entry so no orphan is left behind in the picker.
    "$py" - "$STORAGE" "$PROFILE_NAME" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(path))
except Exception:
    sys.exit(0)
before = d.get("userDataProfiles", [])
d["userDataProfiles"] = [x for x in before if x.get("name") != name]
json.dump(d, open(path, "w"))
PY
    log "removed '$PROFILE_NAME' from storage.json"
  else
    log "no python available to edit storage.json; the profile entry may remain in the picker"
  fi

  if [[ -n "$loc" && -d "$CODE_USER/profiles/$loc" ]]; then
    rm -rf "$CODE_USER/profiles/$loc"
    log "removed profile directory ($loc)"
  fi
fi

# 2. Remove the whole contained runtime.
if [[ -d "$BLK" ]]; then
  rm -rf "$BLK"
  log "removed $BLK"
else
  log "$BLK not present"
fi

# 3. Remove the VS Code app only when appropriate: --keep-vscode never; otherwise forced (--all) or
#    because we installed it. Never remove a pre-existing editor, and never the shared user data.
remove_vscode=false
if [[ "$KEEP_VSCODE" == true ]]; then
  remove_vscode=false
elif [[ "$FORCE_VSCODE" == true || "$INSTALLED_BY_US" == true ]]; then
  remove_vscode=true
fi
if [[ "$remove_vscode" == true ]]; then
  for app in "/Applications/Visual Studio Code.app" "$HOME/Applications/Visual Studio Code.app"; do
    [[ -d "$app" ]] && { rm -rf "$app"; log "removed $app"; }
  done
  log "note: VS Code user data ($CODE_USER) is left intact; delete it manually for a total wipe"
else
  log "left VS Code in place (installed-by-us=$INSTALLED_BY_US, --all=$FORCE_VSCODE, --keep-vscode=$KEEP_VSCODE)"
fi

log "done. re-run install-blockless.zsh for a fresh setup."
