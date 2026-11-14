"""HorseMD icon renderer: the horse+MD mark as a thin film of wet ink on a
macOS-grid squircle (scripts/icon/build-icons.sh drives it).
Usage: python3 render.py <variant> <out.png> [size] [--key=value …]
Variants: ink (the shipped icon), glass, night. Renders at 2x and downsamples."""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage as nd

VARIANT = sys.argv[1]
OUT = sys.argv[2]
FINAL = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else 1024
FULL_BLEED = '--bleed' in sys.argv  # iOS / Android: no squircle, no shadow
TIGHT = '--tight' in sys.argv  # squircle filling the canvas, no drop shadow (favicons, splash)
S = 2048
HERE = __file__.rsplit('/', 1)[0]

def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)

def hexc(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])

# ---------- mark mask ----------
import os
raw = np.asarray(Image.open(os.environ.get('HM_ICON_MARK', f'{HERE}/mark4.pgm')).convert('L'), dtype=np.float32) / 255
m = 1 - raw
m = nd.gaussian_filter(m, 9) > 0.5          # round off the raster wobble
ys, xs = np.nonzero(m)
m = m[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(np.float32)
body = S if (FULL_BLEED or TIGHT) else 1648   # 824/1024 macOS body
target_h = int(body * float(next((x.split('=')[1] for x in sys.argv if x.startswith('--size=')), '0.74')))
scale = target_h / m.shape[0]
mw, mh = int(round(m.shape[1] * scale)), target_h
mimg = Image.fromarray((m * 255).astype(np.uint8)).resize((mw, mh), Image.LANCZOS)
mask = np.zeros((S, S), np.float32)
ox = (S - mw) // 2 + int(S * 0.01)
oy = (S - mh) // 2 + int(S * 0.005)
mask[oy:oy + mh, ox:ox + mw] = np.asarray(mimg, np.float32) / 255
hard = mask > 0.5
THICK = float(next((x.split('=')[1] for x in sys.argv if x.startswith('--thick=')), '3'))
if THICK > 0:
    hard = nd.distance_transform_edt(~hard) < THICK
    mask = np.clip(nd.gaussian_filter(hard.astype(np.float32), 0.8) * 1.0, 0, 1)

# ---------- height field: a rounded tube, softened like a liquid ----------
d = nd.distance_transform_edt(hard) - 0.5
w0 = 21.0 + 0.8 * THICK
def arg(name, default):
    return next((x.split('=')[1] for x in sys.argv if x.startswith('--' + name + '=')), default)
PROFILE = arg('profile', 'tube')
if PROFILE == 'puddle':
    # liquid on paper: a flat-ish top, the edge curving down (meniscus)
    edge = float(arg('edge', '15'))
    t = np.clip(d / edge, 0, 1)
    h = float(arg('height', '13')) * (1 - (1 - t) ** 2.2)
    h = h + 0.10 * d                              # a slight crown so the top still catches light
else:
    t = np.clip(d / w0, 0, 1)
    h = w0 * np.sqrt(np.clip(1 - (1 - t) ** 2, 0, 1))
h = nd.gaussian_filter(h, 3.2) * hard + 0.0
h = nd.gaussian_filter(h, 1.2)
gy, gx = np.gradient(h)
k = 1.15
n = np.dstack([-gx * k, -gy * k, np.ones_like(h)])
n /= np.linalg.norm(n, axis=2, keepdims=True)
nx, ny, nz = n[..., 0], n[..., 1], n[..., 2]

# reflection of the view ray (viewer along +z)
rx, ry, rz = 2 * nz * nx, 2 * nz * ny, 2 * nz * nz - 1
L = np.array([-0.45, -0.75, 0.55]); L /= np.linalg.norm(L)
diff = np.clip(nx * L[0] + ny * L[1] + nz * L[2], 0, 1)
H = L + np.array([0, 0, 1.0]); H /= np.linalg.norm(H)
ndh = np.clip(nx * H[0] + ny * H[1] + nz * H[2], 0, 1)
fres = (1 - nz) ** 4

def env(sky, ground, box=1.0):
    """Studio environment: a bright soft box up-left, sky above, floor below."""
    up = smoothstep(0.35, -0.6, ry)                # 1 looking up
    col = ground[None, None] * (1 - up[..., None]) + sky[None, None] * up[..., None]
    # soft box (a window) up-left
    wx = smoothstep(-0.95, -0.88, rx) * (1 - smoothstep(-0.22, -0.15, rx))
    wy = smoothstep(-1.0, -0.92, ry) * (1 - smoothstep(-0.38, -0.30, ry))
    sb = wx * wy
    return col + box * sb[..., None]

# ---------- background tile ----------
yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
cx = cy = (S - 1) / 2
if FULL_BLEED:
    tile = np.ones((S, S), np.float32)
    half = S / 2
else:
    half = body / 2 - (2 if TIGHT else 0)
    r = 0.235 * 2 * half                      # Apple grid: 185/824 ≈ 0.225, continuous
    qx = np.abs(xx - cx) - (half - r); qy = np.abs(yy - cy) - (half - r)
    sdf = np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qy, 0) ** 2) + np.minimum(np.maximum(qx, qy), 0) - r
    tile = np.clip(0.5 - sdf, 0, 1)
vy = (yy - (cy - half)) / (2 * half)               # 0 top .. 1 bottom
vx = (xx - (cx - half)) / (2 * half)

def tile_rim(tile):
    """thin glass edge: light on top, dark at the bottom"""
    inner = nd.gaussian_filter(tile, 6)
    edge = np.clip(tile - inner, 0, 1) * 3
    return edge

P = {
    'ink': dict(bg_top=arg('top', '#fffdf9'), bg_bot=arg('bot', '#ece4d6'), ink='#18212e', sky='#f6f1ea', ground='#4a3c30', glow='#3f5f8f', glow_amt=float(arg('glow', '0.4')), box=1.6,
                rim_light=0.55),
    'glass': dict(bg_top='#f3a35f', bg_bot='#c04e22', ink='#ffffff', sky='#ffffff', ground='#ffd9bf', glow='#ffffff', glow_amt=0,
                  rim_light=0.5),
    'night': dict(bg_top='#2d3747', bg_bot='#121821', ink='#e29a5e', sky='#fff3e6', ground='#3b2414', glow='#ffcf9a', glow_amt=0.45,
                  rim_light=0.35),
}[VARIANT]

top, bot = hexc(P['bg_top']), hexc(P['bg_bot'])
g = smoothstep(0, 1, vy)[..., None]
bg = top * (1 - g) + bot * g
# a soft light pool up-left on the tile
pool = np.exp(-(((xx - (cx - half * 0.35)) / (half * 0.9)) ** 2 + ((yy - (cy - half * 0.55)) / (half * 0.8)) ** 2))
bg = bg + (0.06 if VARIANT == 'ink' else 0.10) * pool[..., None]

# cast shadow + occlusion of the mark on the tile
SH = float(arg('shadow', '1'))
sh_off = nd.shift(mask, (14 * SH, 8 * SH), order=1)
cast = nd.gaussian_filter(sh_off, 12 * max(SH, 0.4))
ao = nd.gaussian_filter(mask, 40)
shade = 1 - (0.30 if VARIANT != 'night' else 0.55) * cast - 0.10 * ao
bg = bg * shade[..., None]
if VARIANT == 'glass':
    # light focused through the glass onto the tile (caustic), below-right
    caus = nd.gaussian_filter(nd.shift(mask, (26, 14), order=1), 7) * (1 - nd.gaussian_filter(mask, 2))
    bg = bg + 0.22 * caus[..., None] * np.array([1.0, 0.85, 0.65])

# ---------- the mark ----------
ink = hexc(P['ink'])
if VARIANT == 'glass':
    # frosted clear glass: refracted, brightened tile seen through it
    off_x = (nx * 38).astype(np.int32); off_y = (ny * 38).astype(np.int32)
    sx = np.clip(xx.astype(np.int32) - off_x, 0, S - 1); sy = np.clip(yy.astype(np.int32) - off_y, 0, S - 1)
    through = bg[sy, sx]
    through = nd.gaussian_filter(through, (6, 6, 0))      # frost
    body_col = through * 0.28 + 0.72 * np.array([1, 0.98, 0.96])
    band = smoothstep(0.25, 0.75, 1 - nz)
    body_col = body_col * (1 - 0.28 * band[..., None])
    body_col = body_col * (0.85 + 0.25 * diff[..., None])
    e = env(hexc(P['sky']), hexc(P['ground']), 0.6)
    F = 0.08 + 0.92 * fres
    col = body_col * (1 - F[..., None]) + e * F[..., None]
    col = col + (0.9 * ndh ** 160 + 0.18 * ndh ** 18)[..., None]
    # inner rim: thickness reads as a bright edge on the shadow side
    rimb = smoothstep(0.55, 0.95, -(nx * -0.6 + ny * -0.8)) * (1 - nz)
    col = col + 0.35 * rimb[..., None]
else:
    e = env(hexc(P['sky']), hexc(P['ground']), P.get('box', 0.9))
    base = ink * (0.55 + 0.6 * diff[..., None])
    F0 = 0.05
    F = F0 + (1 - F0) * fres
    col = base * (1 - F[..., None]) + e * F[..., None] * (0.75 if VARIANT == 'ink' else 0.7)
    # bounce light from the tile into the lower edges: liquid, not plastic
    bounce = smoothstep(0.2, 0.9, nx * 0.4 + ny * 0.9) * (1 - nz) ** 0.8
    col = col + P['rim_light'] * 0.35 * bounce[..., None] * (top * 0.6 + 0.4)
    col = col + (0.95 * ndh ** 220 + 0.16 * ndh ** 24)[..., None]
    inside = smoothstep(2.0, 7.0, nd.distance_transform_edt(hard))
    glow = smoothstep(0.15, 0.75, nx * 0.45 + ny * 0.9) * smoothstep(0.05, 0.5, 1 - nz) * inside
    col = col + P['glow_amt'] * glow[..., None] * hexc(P['glow'])[None, None]
col = np.clip(col, 0, 1.2)

a = mask[..., None]
img = bg * (1 - a) + col * a

# tile edge (thickness of the tile itself)
if not FULL_BLEED:
    inner = nd.gaussian_filter(tile, 4)
    edge = np.clip(tile - inner, 0, 1) * tile
    tone = (1 - vy) * 0.9 - vy * 0.5
    img = img + (edge * tone * (1.0 if VARIANT != 'ink' else 0.6))[..., None]
img = np.clip(img, 0, 1)

# tile drop shadow (macOS template: down ~12, blur ~16 at 1024)
alpha = tile
if not FULL_BLEED and not TIGHT:
    ds = nd.gaussian_filter(nd.shift(tile, (22, 0), order=1), 22) * 0.38
    out_a = alpha + ds * (1 - alpha)
    rgb = img * (alpha / np.maximum(out_a, 1e-6))[..., None]  # shadow is black
else:
    out_a = alpha
    rgb = img
rgba = np.dstack([np.clip(rgb, 0, 1), out_a])
im = Image.fromarray((rgba * 255 + 0.5).astype(np.uint8))
im = im.resize((FINAL, FINAL), Image.LANCZOS)
im.save(OUT)
print('saved', OUT)
