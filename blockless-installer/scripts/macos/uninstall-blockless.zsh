#!/usr/bin/env zsh
# Blockless uninstaller (macOS). Removes everything the installer created:
#   1. the branded "Blockless" VS Code profile (dir + its storage.json entry) -- ONLY when the
#      installer recorded creating it (state.json profileCreatedByUs), never a user's pre-existing
#      profile that merely shares the name
#   2. the contained runtime under ~/Library/Application Support/Blockless (uv, python, env,
#      downloads, logs, state.json)
# VS Code itself and its OTHER profiles are left untouched by default. VS Code is removed ONLY when
# the installer recorded that it installed it (state.json vscodeInstalledByUs) — never a user's
# pre-existing editor. --all forces removal, --keep-vscode prevents it. The shared VS Code user
# data (~/Library/Application Support/Code) is never touched. Requires VS Code to be closed.
#
# Doubles as the test reset: run this in the VM to get back to a clean slate without re-cloning
# (use --all for a true cold reset so a re-run exercises the VS Code install path again).
set -uo pipefail

PROFILE_NAME="Blockless"
BLK="$HOME/Library/Application Support/Blockless"
CODE_USER="$HOME/Library/Application Support/Code/User"
STORAGE="$CODE_USER/globalStorage/storage.json"
STATE="$BLK/state.json"

log() { print -r -- "[blockless-uninstall] $*"; }
get_json() { grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$STATE" 2>/dev/null | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'; }

# --- options ---
FORCE_VSCODE=false; KEEP_VSCODE=false
for arg in "$@"; do
  case "$arg" in
    --all) FORCE_VSCODE=true ;;
    --keep-vscode) KEEP_VSCODE=true ;;
    *) print -ru2 -- "unknown arg: $arg (use --all or --keep-vscode)"; exit 2 ;;
  esac
done

# Read state BEFORE any deletion ($BLK holds state.json). We only remove what the installer recorded
# creating: VS Code iff vscodeInstalledByUs, the profile iff profileCreatedByUs -- never a user's
# pre-existing editor or a "Blockless" profile that already existed when we ran. profileLocation is the
# installer-journaled on-disk id, so the delete target is never derived from user-writable storage.json.
INSTALLED_BY_US=false; PROFILE_CREATED_BY_US=false; PROFILE_LOCATION=""
if [[ -f "$STATE" ]]; then
  grep -Eq '"vscodeInstalledByUs"[[:space:]]*:[[:space:]]*true' "$STATE" && INSTALLED_BY_US=true
  grep -Eq '"profileCreatedByUs"[[:space:]]*:[[:space:]]*true' "$STATE" && PROFILE_CREATED_BY_US=true
  PROFILE_LOCATION="$(get_json profileLocation)"
fi

# A running VS Code holds storage.json in memory and would clobber our edit; removing $BLK now would
# also drop state.json before a re-run could finish the profile cleanup. So if VS Code is running, do
# NOTHING and ask the user to quit it and re-run -- a clean all-or-nothing uninstall.
if pgrep -f "Visual Studio Code.app/Contents/MacOS/Electron" >/dev/null 2>&1; then
  log "VS Code is running; quit it and re-run to uninstall. Nothing was removed."
  exit 0
fi

# 1. Remove the branded profile -- ONLY if this installer created it (never a user's own). All
# storage.json editing uses JXA (osascript -l JavaScript): no Python, so a stock Mac's /usr/bin/python3
# stub can never pop the Xcode CLT dialog, and the write is atomic (writeToFileAtomicallyEncodingError).
if [[ "$PROFILE_CREATED_BY_US" != true ]]; then
  log "leaving the '$PROFILE_NAME' profile in place (not created by this installer, or state.json already gone); remove it from VS Code's picker manually if you want it gone"
else
  if [[ -f "$STORAGE" ]]; then
    osascript -l JavaScript - "$STORAGE" "$PROFILE_NAME" >/dev/null 2>&1 <<'JXA' || true
ObjC.import('Foundation');
function run(argv) {
  var path = argv[0], name = argv[1];
  var raw = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, $()).js;
  var obj;
  try { obj = JSON.parse(raw); } catch (e) { return; }   // never clobber an unparseable storage.json
  if (Object.prototype.toString.call(obj.userDataProfiles) !== '[object Array]') return;
  obj.userDataProfiles = obj.userDataProfiles.filter(function (p) { return !(p && p.name === name); });
  $(JSON.stringify(obj)).writeToFileAtomicallyEncodingError($(path), true, $.NSUTF8StringEncoding, $());
}
JXA
    # The JXA ends in `|| true` (it skips a corrupt/unreadable storage.json rather than clobber it), so
    # confirm the entry is actually gone before claiming success -- don't report a skip as a removal.
    if grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$PROFILE_NAME\"" "$STORAGE" 2>/dev/null; then
      log "could not remove '$PROFILE_NAME' from storage.json (unparseable/locked?); the entry may remain in the picker"
    else
      log "removed '$PROFILE_NAME' from storage.json"
    fi
  fi

  # profileLocation is installer-journaled, still allowlisted to VS Code's id shape before a recursive delete.
  loc="$PROFILE_LOCATION"
  if [[ -n "$loc" && "$loc" =~ '^[A-Za-z0-9_-]+$' && -d "$CODE_USER/profiles/$loc" ]]; then
    rm -rf "$CODE_USER/profiles/$loc"
    log "removed profile directory ($loc)"
  elif [[ -n "$loc" ]]; then
    log "refusing to delete a suspicious profile location ($loc); remove it manually if needed"
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
