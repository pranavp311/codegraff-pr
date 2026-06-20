#!/bin/bash
# Build the Graff iOS app and run it on a simulator — no Xcode project required.
#   ./build-sim.sh            # uses "iPhone 17 Pro"
#   SIM="iPhone Air" ./build-sim.sh
set -euo pipefail
cd "$(dirname "$0")"

APP=Graff
BUNDLE=com.codegraff.graff
SIM="${SIM:-iPhone 17 Pro}"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
TARGET=arm64-apple-ios26.0-simulator
OUT="build/${APP}.app"

echo "==> compiling ($TARGET)"
rm -rf build && mkdir -p "$OUT"
xcrun -sdk iphonesimulator swiftc \
  -target "$TARGET" -sdk "$SDK" \
  -emit-executable \
  -o "$OUT/$APP" \
  Graff/Sources/*.swift
cp Graff/Info.plist "$OUT/Info.plist"

echo "==> booting $SIM"
xcrun simctl boot "$SIM" 2>/dev/null || true
open -a Simulator >/dev/null 2>&1 || true

echo "==> installing + launching"
xcrun simctl install "$SIM" "$OUT"
xcrun simctl launch "$SIM" "$BUNDLE" || true
sleep 4
xcrun simctl io "$SIM" screenshot build/launch.png >/dev/null 2>&1 || true
echo "==> done — screenshot: $(pwd)/build/launch.png"
