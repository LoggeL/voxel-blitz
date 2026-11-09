"""Draw the SP-2 DOPPLER marking masks (white ink on black) with PIL.
python3 tools/blender/doppler/make-decals.py
The bake projects each mask onto a chassis wall; see DECALS in build-doppler.py.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'docs/design/doppler/decals'
OUT.mkdir(parents=True, exist_ok=True)
BOLD = '/System/Library/Fonts/Supplemental/DIN Alternate Bold.ttf'
COND = '/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf'


def font(path, size):
    return ImageFont.truetype(path, size)


def canvas(w, h):
    im = Image.new('L', (w, h), 0)
    return im, ImageDraw.Draw(im)


def spaced(d, xy, text, f, gap=0, fill=255):
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=f, fill=fill)
        x += d.textlength(ch, font=f) + gap
    return x


def slashes(d, x, y, h, n=3, w=12, gap=10, lean=0.45):
    for i in range(n):
        x0 = x + i * (w + gap)
        d.polygon([(x0 + h * lean, y), (x0 + h * lean + w, y), (x0 + w, y + h), (x0, y + h)], fill=255)


# 1. name plate: 56 x 40 mm at 16 px/mm
im, d = canvas(896, 640)
spaced(d, (40, 40), 'SP-2', font(BOLD, 300), gap=6)
slashes(d, 672, 120, 190, n=3, w=34, gap=22)
spaced(d, (48, 400), 'DOPPLER', font(BOLD, 150), gap=30)
d.rectangle((48, 372, 848, 380), fill=255)
spaced(d, (50, 566), 'SHIFTED PULSE  ·  2RD HYPERBURST', font(COND, 62), gap=5)
im.save(OUT / 'nameplate.png')

# 2. calibre and serial line: 112 x 8 mm at 16 px/mm
im, d = canvas(1792, 128)
x = spaced(d, (10, 14), '6.8×43', font(BOLD, 96), gap=6)
d.rectangle((x + 30, 30, x + 38, 100), fill=255)
x = spaced(d, (x + 70, 14), 'VB-26-00194', font(BOLD, 96), gap=6)
d.rectangle((x + 30, 30, x + 38, 100), fill=255)
spaced(d, (x + 70, 26), 'VOXEL BLITZ ARSENAL', font(COND, 96), gap=8)
im.save(OUT / 'serial.png')

# 3. warning line: 112 x 8 mm
im, d = canvas(1792, 128)
d.polygon([(14, 108), (64, 16), (114, 108)], outline=255, width=9)
d.rectangle((60, 46, 68, 82), fill=255)
d.ellipse((58, 88, 70, 100), fill=255)
spaced(d, (150, 24), 'KEEP CLEAR  ·  RECOILING UNIT  ·  16 MM TRAVEL', font(COND, 100), gap=9)
im.save(OUT / 'warning.png')

# 4. selector marks: 30 x 12 mm; S (safe) left, two rounds right
im, d = canvas(480, 192)
spaced(d, (22, 30), 'S', font(BOLD, 130))
for i in range(2):
    x0 = 330 + i * 56
    d.rounded_rectangle((x0, 40, x0 + 30, 152), radius=14, fill=255)
im.save(OUT / 'selector.png')

# 5. optic flank: 40 x 12 mm
im, d = canvas(640, 192)
slashes(d, 20, 40, 110, n=3, w=26, gap=18)
spaced(d, (200, 34), 'P-15', font(BOLD, 116), gap=6)
spaced(d, (520, 64), '1.5×', font(COND, 88), gap=4)
im.save(OUT / 'optic.png')

# 6. stock mark: 60 x 10 mm
im, d = canvas(960, 160)
x = spaced(d, (10, 22), 'SP-2 / FOLD', font(COND, 120), gap=10)
d.polygon([(x + 30, 40), (x + 96, 80), (x + 30, 120)], fill=255)
im.save(OUT / 'stock.png')
print('decals ->', OUT)
