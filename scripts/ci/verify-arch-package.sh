#!/usr/bin/env bash
# Installs the HorseMD pacman package in a clean Arch Linux container and
# launches it (#153). Run by release.yml:
#   docker run --rm --shm-size=1g -v "$PWD/dist:/dist:ro" -v "$PWD/scripts/ci:/ci:ro" \
#     archlinux:latest bash /ci/verify-arch-package.sh /dist/horse-X-x86_64.pkg.tar.xz
set -euo pipefail
PKG="$1"

pacman -Syu --noconfirm --needed xorg-server-xvfb xorg-xauth curl >/dev/null
# Fails here if a declared dependency is not in the Arch repos.
pacman -U --noconfirm "$PKG"
pacman -Qi horse

# Same sandbox contract as the deb (#143): root-owned SUID helper.
test "$(stat -c '%U:%G %a' /opt/HorseMD/chrome-sandbox)" = "root:root 4755"
test "$(readlink -f /usr/bin/horse)" = /opt/HorseMD/horse
if ldd /opt/HorseMD/horse | grep 'not found'; then
  echo "::error::missing shared libraries"
  exit 1
fi

# Launch as an ordinary user (Chromium refuses root without --no-sandbox) and
# wait for the renderer page to load.
useradd -m tester
printf '# Arch smoke test\n\nHello from Arch.\n' > /home/tester/hello.md
chown tester /home/tester/hello.md
su tester -c 'cd ~ && nohup xvfb-run -a /usr/bin/horse --horsemd-input-trace --remote-debugging-port=9333 ~/hello.md > ~/horse.log 2>&1 &'

ok=0
for _ in $(seq 60); do
  if curl -fsS http://127.0.0.1:9333/json/list 2>/dev/null | grep -q 'index.html'; then
    ok=1
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:9333/json/list 2>/dev/null || true
echo "--- app log"
cat /home/tester/horse.log || true
echo "--- input trace (tail)"
tail -n 5 /tmp/horsemd-input-trace-*.jsonl 2>/dev/null || true
pkill -f /opt/HorseMD/horse || true

if [ "$ok" != 1 ]; then
  echo "::error::HorseMD did not open a window on Arch"
  exit 1
fi
echo "✅ Arch package installs and launches"
