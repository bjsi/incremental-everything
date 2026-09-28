#!/bin/bash
# Builds LogosBridge.app into ~/.incremental-remnote/logos-bridge and (re)starts it
# as a LaunchAgent, so it runs at login.
#
# First run: macOS asks for Accessibility for LogosBridge (needed to press Logos's
# Edit ▸ Copy and the highlighter key).
#
# Signing: with a code-signing certificate named "LogosBridge Code Signing" in the
# login keychain (Keychain Access ▸ Certificate Assistant ▸ Create a Certificate,
# type "Code Signing"; or set LOGOS_BRIDGE_SIGN_IDENTITY), the app keeps its
# Accessibility permission across rebuilds. Without one it is ad-hoc signed, and
# every rebuild is a new app to macOS: remove LogosBridge from System Settings ▸
# Privacy & Security ▸ Accessibility and add it again (toggling the old entry is
# not enough — it still points at the previous build).
#
# Then turn on "Logos Bible Software Bridge" in the plugin's settings.
# Config (read on every hotkey): ~/.incremental-remnote/logos-bridge/config.json
# Log: ~/.incremental-remnote/logos-bridge/bridge.log
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.incremental-remnote/logos-bridge"
APP="$DEST/LogosBridge.app"
LABEL="com.incrementalremnote.logos-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$APP/Contents/MacOS"
swiftc -O -swift-version 5 -o "$APP/Contents/MacOS/LogosBridge" "$HERE/LogosBridge.swift"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key><string>$LABEL</string>
    <key>CFBundleName</key><string>LogosBridge</string>
    <key>CFBundleExecutable</key><string>LogosBridge</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>LSUIElement</key><true/>
</dict>
</plist>
EOF
IDENTITY="${LOGOS_BRIDGE_SIGN_IDENTITY:-LogosBridge Code Signing}"
if security find-identity -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\"" \
   && codesign --force --sign "$IDENTITY" --identifier "$LABEL" "$APP" 2>/dev/null; then
  echo "Signed with \"$IDENTITY\" — Accessibility survives rebuilds."
else
  codesign --force --sign - --identifier "$LABEL" "$APP"
  echo "Ad-hoc signed: re-add LogosBridge in System Settings ▸ Privacy & Security ▸ Accessibility."
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array><string>$APP/Contents/MacOS/LogosBridge</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$DEST/bridge.log</string>
    <key>StandardErrorPath</key><string>$DEST/bridge.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout returns before the old instance is gone; bootstrapping too early fails with EIO.
for _ in $(seq 1 50); do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.1
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "LogosBridge installed and started. Log: $DEST/bridge.log"
