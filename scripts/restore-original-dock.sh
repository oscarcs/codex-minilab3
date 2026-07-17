#!/bin/zsh
set -euo pipefail

backup="$HOME/Library/Application Support/codex-minilab3/dock-before-minilab.plist"

if [[ ! -f "$backup" ]]; then
  print -u2 "No saved Dock preferences found at $backup"
  exit 1
fi

/usr/bin/defaults import com.apple.dock "$backup"
/usr/bin/killall Dock
print "Restored the Dock preferences saved before the MiniLab launcher was pinned."
