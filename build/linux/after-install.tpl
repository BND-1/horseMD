#!/bin/bash

# HorseMD deb postinst. Based on electron-builder's default
# app-builder-lib/templates/linux/after-install.tpl, with one change (#143):
# chrome-sandbox is ALWAYS installed as root:root 4755.
#
# The default template probes `unshare --user true` and only sets the SUID bit
# when that fails. postinst runs as root, and root can still create user
# namespaces on Ubuntu 24.04+ where AppArmor sets
# kernel.apparmor_restrict_unprivileged_userns=1 — so the probe "succeeds",
# the sandbox is left 0755, and an ordinary user's launch dies with a FATAL
# sandbox error and no window. Chromium only falls back to the SUID helper
# when namespaces are unavailable, so a correctly configured SUID binary is
# harmless everywhere else and also survives later sysctl/kernel changes.

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

chown root:root '/opt/${sanitizedProductName}/chrome-sandbox' || true
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
