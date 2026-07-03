#!/bin/bash
set -e

cat > /usr/share/mime/packages/horsemd.xml << 'XMLEOF'
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="text/markdown">
    <comment>Markdown document</comment>
    <comment xml:lang="zh_CN">Markdown 文档</comment>
    <glob pattern="*.md"/>
    <glob pattern="*.markdown"/>
    <glob pattern="*.mdx"/>
  </mime-type>
</mime-info>
XMLEOF

update-mime-database /usr/share/mime || true

ICONS_DIR="/opt/HorseMD/resources/linux-icons/hicolor"
if [ -d "$ICONS_DIR" ]; then
  cp -rn "$ICONS_DIR"/* /usr/share/icons/hicolor/
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache /usr/share/icons/hicolor || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications || true
fi
