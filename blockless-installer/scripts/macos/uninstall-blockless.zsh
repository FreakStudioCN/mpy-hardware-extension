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
  # Fail CLOSED: state.json exists, so it must be readable AND complete or we cannot know what we own.
  # An unreadable (EACCES) or truncated/corrupt journal must NOT read as "not ours" -- section 2 would
  # then delete $BLK and destroy a recoverable ownership journal while the profile survives. Require the
  # profileCreatedByUs key to be present (any value); its absence means the file is incomplete.
  if [[ ! -r "$STATE" ]] || ! grep -q '"profileCreatedByUs"' "$STATE" 2>/dev/null; then
    die "state.json exists but is unreadable or incomplete; cannot determine what to remove. Fix its permissions, or delete '$BLK' manually, then re-run. Nothing was removed."
  fi
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
  # Attempt both removals (storage.json entry, then the profile dir) best-effort, then apply ONE
  # invariant guard before section 2 removes $BLK (which holds state.json, the ownership journal):
  # never destroy the journal while any owned profile artifact survives, or a re-run loses ownership
  # and can never finish. The guard checks what actually REMAINS rather than trusting each command's
  # exit code, so a single check covers every failure mode -- a corrupt/locked/unwritable storage.json
  # the JXA skipped, a dir rm that could not complete, or a command that "succeeded" without doing the
  # work. All storage.json editing is JXA (no Python -> no Xcode CLT stub; atomic write).
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
  fi
  # profileLocation is installer-journaled, still allowlisted to VS Code's id shape before a recursive
  # delete (so "." / "*" / traversal from a tampered journal cannot escape).
  loc="$PROFILE_LOCATION"
  if [[ -n "$loc" && "$loc" =~ '^[A-Za-z0-9_-]+$' ]]; then
    [[ -d "$CODE_USER/profiles/$loc" ]] && rm -rf "$CODE_USER/profiles/$loc" 2>/dev/null
  elif [[ -n "$loc" ]]; then
    log "refusing to delete a suspicious profile location ($loc); remove it manually if needed"
  fi

  # Invariant guard: is any owned artifact still present? If so, stop before touching the journal.
  # grep exits: 0 = entry found, 1 = confirmed absent, 2+ = could not read. Fail CLOSED: only a
  # confirmed-absent (1) counts as gone; found OR unreadable both mean "still present" (do not delete
  # the journal on a storage.json we could not verify is clean).
  entry_present=0
  if [[ -f "$STORAGE" ]]; then
    grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$PROFILE_NAME\"" "$STORAGE" 2>/dev/null
    (( $? != 1 )) && entry_present=1
  fi
  dir_present=0;   [[ "$loc" =~ '^[A-Za-z0-9_-]+$' && -d "$CODE_USER/profiles/$loc" ]] && dir_present=1
  if (( entry_present || dir_present )); then
    log "could not fully remove the '$PROFILE_NAME' profile (storage.json entry present=$entry_present, directory present=$dir_present); it is likely corrupt, locked, or unwritable. Leaving the contained runtime and the ownership journal (state.json) intact so a re-run can finish. Nothing else was removed."
    exit 1
  fi
  log "removed the '$PROFILE_NAME' profile (storage.json entry + directory)"
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
