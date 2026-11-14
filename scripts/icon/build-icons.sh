#!/bin/zsh
# Regenerates every HorseMD icon / logo file (desktop, mobile, website, guide,
# splash screens) from mark.pbm, the traced horse + MD mark.
# Needs: python3 with numpy, scipy, Pillow; potrace; macOS iconutil.
#   scripts/icon/build-icons.sh            write into the repo
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
potrace "$HERE/mark.pbm" -g -o "$WORK/mark4.pgm" --turdsize 20 --alphamax 1.0 --opttolerance 0.2 -x 4
export HM_ICON_MARK="$WORK/mark4.pgm"
# The shipped look: a thin film of ink, neutral light-gray tile.
A=(--profile=puddle --shadow=0.5 --top=#f7f7f6 --bot=#e4e4e2)
BIG=(--thick=3 --edge=8 --height=5 --glow=0.08)
SMALL=(--thick=12 --size=0.80 --edge=10 --height=6 --glow=0.06)   # 48 px and below
cd "$WORK" && mkdir final
for mode in "" --tight --bleed; do
  name=${${mode#--}:-sq}
  python3 "$HERE/render.py" ink "final/$name.png" $A $BIG $mode >/dev/null &
  python3 "$HERE/render.py" ink "final/${name}_small.png" $A $SMALL $mode >/dev/null &
done
wait
python3 "$HERE/gen.py" "$REPO" >/dev/null
rsync -a stage/ "$REPO/"
echo "icons written to $REPO"
