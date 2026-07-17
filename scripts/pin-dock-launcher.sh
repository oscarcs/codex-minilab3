#!/bin/zsh
set -euo pipefail

installed_app="$HOME/Applications/ChatGPT MiniLab.app"
launcher_identifier="com.codex-minilab3.launcher"
dock_preferences="$HOME/Library/Preferences/com.apple.dock.plist"
support_directory="$HOME/Library/Application Support/codex-minilab3"
backup="$support_directory/dock-before-minilab.plist"
working_copy=$(/usr/bin/mktemp -t codex-minilab3-dock)
trap '/usr/bin/trash --stopOnError "$working_copy"' EXIT

if [[ ! -d "$installed_app" ]]; then
  print -u2 "Install $installed_app first."
  exit 1
fi

mkdir -p "$support_directory"
if [[ ! -f "$backup" ]]; then
  /usr/bin/defaults export com.apple.dock "$backup"
fi
/usr/bin/defaults export com.apple.dock "$working_copy"

count=$(/usr/bin/plutil -extract persistent-apps raw -o - "$working_copy")
target_index=""
for (( index = 0; index < count; index += 1 )); do
  identifier=$(/usr/bin/plutil -extract "persistent-apps.$index.tile-data.bundle-identifier" raw -o - "$working_copy" 2>/dev/null || true)
  if [[ "$identifier" == "com.openai.codex" || "$identifier" == "$launcher_identifier" ]]; then
    target_index="$index"
    break
  fi
done

if [[ -z "$target_index" ]]; then
  print -u2 "Could not find the existing ChatGPT Dock item; leaving the Dock unchanged."
  exit 1
fi

prefix="persistent-apps.$target_index.tile-data"
installed_app_url="file://${installed_app// /%20}/"
/usr/bin/plutil -replace "$prefix.bundle-identifier" -string "$launcher_identifier" "$working_copy"
/usr/bin/plutil -replace "$prefix.file-data._CFURLString" -string "$installed_app_url" "$working_copy"
/usr/bin/plutil -replace "$prefix.file-data._CFURLStringType" -integer 15 "$working_copy"
/usr/bin/plutil -replace "$prefix.file-label" -string "ChatGPT" "$working_copy"
/usr/bin/plutil -replace "$prefix.dock-extra" -integer 0 "$working_copy"
/usr/bin/plutil -remove "$prefix.book" "$working_copy" 2>/dev/null || true

/usr/bin/defaults import com.apple.dock "$working_copy"
/usr/bin/killall Dock

print "Dock now launches $installed_app"
print "Previous Dock preferences backed up at $backup"
