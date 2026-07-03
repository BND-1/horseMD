#!/bin/bash
set -e

# Remove our MIME type file
rm -f /usr/share/mime/packages/horsemd.xml

# Update MIME database to remove our types
if [ -f /usr/share/mime/packages ]; then
  update-mime-database /usr/share/mime || true
fi

# Update desktop database
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications || true
fi
