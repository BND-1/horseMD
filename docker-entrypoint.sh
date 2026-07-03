#!/bin/bash
set -e

convert icon.png -resize 512x512 build/icon-linux.png

for size in 16 24 32 48 64 128 256; do
  d="build/linux-icons/hicolor/${size}x${size}/apps"
  mkdir -p "$d"
  convert build/icon-linux.png -resize "${size}x${size}" "$d/horsemd.png"
done

npm run build

npx electron-builder --linux deb --x64 \
  --config.linux.artifactName='${productName}-${version}-linux-amd64.deb' \
  --config.directories.output=/output

echo 'deb built:' && ls -lh /output/*.deb
