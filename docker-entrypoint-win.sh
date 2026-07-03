#!/bin/bash
set -e

npm run build

npx electron-builder --win nsis --x64 \
  --config.win.artifactName='${productName}-Setup-${version}.exe' \
  --config.directories.output=/output

echo 'win built:' && ls -lh /output/*.exe
