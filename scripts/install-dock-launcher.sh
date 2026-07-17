#!/bin/zsh
set -euo pipefail

script_directory="${0:A:h}"
project_root="${script_directory:h}"
info_template="$project_root/macos/Info.plist"
installed_app="$HOME/Applications/ChatGPT MiniLab.app"
official_icon="/Applications/ChatGPT.app/Contents/Resources/icon-chatgpt.icns"
menu_bar_source="$project_root/native/menu-bar-launcher.swift"

if [[ ! -f "$info_template" || ! -f "$official_icon" || ! -f "$menu_bar_source" ]]; then
  print -u2 "Launcher source or official ChatGPT icon is missing."
  exit 1
fi

if [[ -e "$installed_app" ]]; then
  /usr/bin/trash --stopOnError "$installed_app"
fi
mkdir -p "$installed_app/Contents/MacOS" "$installed_app/Contents/Resources"
/bin/cp "$info_template" "$installed_app/Contents/Info.plist"
/bin/cp "$official_icon" "$installed_app/Contents/Resources/icon-chatgpt.icns"
/usr/bin/plutil -insert CodexMiniLabProjectPath -string "$project_root" "$installed_app/Contents/Info.plist"
target_arch=$(/usr/bin/uname -m)
/usr/bin/xcrun swiftc -O -parse-as-library \
  -target "${target_arch}-apple-macosx12.0" \
  -framework AppKit \
  "$menu_bar_source" \
  -o "$installed_app/Contents/MacOS/codex-minilab3-launcher"
/usr/bin/codesign --force --deep --sign - "$installed_app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$installed_app"

print "Installed $installed_app"
"$script_directory/pin-dock-launcher.sh"
