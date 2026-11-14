"""Builds every HorseMD icon / logo file from the rendered masters into
stage/<repo path>. python3 gen.py <repo>"""
import os, subprocess, sys, shutil
from PIL import Image, ImageDraw, ImageFilter

REPO = sys.argv[1]
OUT = 'stage'
SMALL_MAX = 48
shutil.rmtree(OUT, ignore_errors=True)
M = {k: Image.open(f'final/{k}.png').convert('RGBA') for k in ('sq', 'sq_small', 'tight', 'tight_small', 'bleed', 'bleed_small')}

def pick(kind, size):
    return M[kind + '_small'] if size <= SMALL_MAX else M[kind]

def sized(kind, size, fill=1.0):
    src = pick(kind, size)
    if fill == 1.0:
        return src.resize((size, size), Image.LANCZOS)
    inner = max(1, round(size * fill))
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ic = src.resize((inner, inner), Image.LANCZOS)
    canvas.alpha_composite(ic, ((size - inner) // 2, (size - inner) // 2))
    return canvas

def save(img, rel, rgb=False, **kw):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if rgb:
        bg = Image.new('RGB', img.size, (255, 255, 255)); bg.paste(img, mask=img.split()[3]); img = bg
    img.save(path, **kw)
    return path

# ---- macOS icns: Apple grid with shadow margin ----
iconset = os.path.join(OUT, 'icon.iconset'); os.makedirs(iconset)
for base in (16, 32, 128, 256, 512):
    sized('sq', base).save(f'{iconset}/icon_{base}x{base}.png')
    sized('sq', base * 2).save(f'{iconset}/icon_{base}x{base}@2x.png')
os.makedirs(f'{OUT}/build', exist_ok=True)
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', f'{OUT}/build/icon.icns'], check=True)
shutil.rmtree(iconset)

# ---- Windows / Linux: nearly full squircle (their icons fill more of the canvas) ----
WIN_FILL = 0.92
ico_sizes = [16, 24, 32, 48, 64, 128, 256]
frames = [sized('tight', s, WIN_FILL) for s in ico_sizes]
frames[-1].save(f'{OUT}/build/icon.ico', sizes=[(s, s) for s in ico_sizes], append_images=frames[:-1])
for s in (16, 24, 32, 48, 64, 128, 256, 512):
    save(sized('tight', s, WIN_FILL), f'build/icons/{s}x{s}.png')
save(sized('tight', 256, WIN_FILL), 'build/icons/icon.png')

# ---- repo / website / guide ----
save(sized('sq', 1024), 'icon.png')                      # README / repo display: the macOS look
save(sized('bleed', 1024), 'assets/logo.png', rgb=True)  # mobile asset source: full bleed
save(sized('bleed', 512), 'src/renderer/src/assets/logo.png', rgb=True)       # welcome (CSS rounds it)
save(sized('bleed', 96), 'src/renderer/src/assets/logo-small.png', rgb=True)  # activity bar, 24 px
save(sized('tight', 128), 'website/assets/icon.png')     # favicon + 24 px nav: bold small art
save(sized('tight', 256), 'guide/public/icon.png')
fav = [sized('tight', s) for s in (16, 32, 48, 64, 128, 256)]
fav[-1].save(f'{OUT}/guide/public/favicon.ico', sizes=[(s, s) for s in (16, 32, 48, 64, 128, 256)], append_images=fav[:-1])
for s in (48, 72, 96, 128, 192, 256, 512):
    save(sized('bleed', s), f'icons/icon-{s}.webp', rgb=False, quality=92)

# ---- iOS ----
save(sized('bleed', 1024), 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', rgb=True)

# ---- Android launcher ----
dens = {'ldpi': 0.75, 'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for d, f in dens.items():
    leg, fg = round(48 * f), round(108 * f)
    save(sized('tight', leg, WIN_FILL), f'android/app/src/main/res/mipmap-{d}/ic_launcher.png')
    full = sized('bleed', leg)
    mask = Image.new('L', (leg * 4, leg * 4), 0); ImageDraw.Draw(mask).ellipse((0, 0, leg * 4 - 1, leg * 4 - 1), fill=255)
    rnd = Image.new('RGBA', (leg, leg), (0, 0, 0, 0)); rnd.paste(full, mask=mask.resize((leg, leg), Image.LANCZOS))
    save(rnd, f'android/app/src/main/res/mipmap-{d}/ic_launcher_round.png')
    save(sized('bleed', fg), f'android/app/src/main/res/mipmap-{d}/ic_launcher_foreground.png')
    save(Image.new('RGBA', (fg, fg), (237, 237, 235, 255)), f'android/app/src/main/res/mipmap-{d}/ic_launcher_background.png')

# ---- splash: same backgrounds, the new icon (with its soft shadow) in the old logo's place ----
def splash(src_rel, logo_px):
    old = Image.open(os.path.join(REPO, src_rel)).convert('RGBA')
    bgc = old.getpixel((2, 2))
    out = Image.new('RGBA', old.size, bgc)
    full = round(logo_px / 0.805)            # the tile is 824/1024 of the macOS-grid image
    ic = sized('sq', full)
    out.alpha_composite(ic, ((old.width - full) // 2, (old.height - full) // 2))
    save(out.convert('RGB') if old.mode == 'RGB' else out, src_rel)

res = os.path.join(REPO, 'android/app/src/main/res')
for d in sorted(os.listdir(res)):
    p = f'android/app/src/main/res/{d}/splash.png'
    if d.startswith('drawable') and os.path.exists(os.path.join(REPO, p)):
        w = Image.open(os.path.join(REPO, p)).width
        splash(p, round(0.2 * w))
for n in ('Default@1x~universal~anyany', 'Default@2x~universal~anyany', 'Default@3x~universal~anyany'):
    for suf in ('', '-dark'):
        splash(f'ios/App/App/Assets.xcassets/Splash.imageset/{n}{suf}.png', 204)

for root, _, files in os.walk(OUT):
    for f in files:
        print(os.path.relpath(os.path.join(root, f), OUT))
