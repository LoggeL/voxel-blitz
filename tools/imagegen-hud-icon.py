#!/usr/bin/env python3
"""Turn an ImageGen render into weapon-slot art (public/assets/weapons/hud/).

    python3 tools/imagegen-hud-icon.py <render.png> <out.png> [key]

Alpha under 24 is cut (the endpoint leaves a faint haze round the object);
with `key` an opaque render on a flat #ff00ff background is chroma-keyed and
its magenta fringe pulled back toward grey. The object is cropped to its alpha
box, fitted into the launchers' 446x188 box on a 480x240 canvas and quantized
to 256 colours. Used for the FPV drone and the M-81 mortar
(docs/design/conquest/fpv/icons/, docs/design/conquest/mortar/icons/).
"""
import sys

from PIL import Image

CANVAS = (480, 240)
BOX = (17, 26, 463, 214)


def clean(path, key=False):
    im = Image.open(path).convert('RGBA')
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if key:
                # Distance from #ff00ff: inside 60 is background, 60..120 fades out.
                d = max(255 - r, g, 255 - b)
                if d < 60:
                    a = 0
                elif d < 120:
                    a = int(a * (d - 60) / 60)
                if a and r > g + 60 and b > g + 60:
                    m = min(r, b)
                    r = b = max(g, m - (m - g) // 2)
            if a < 24:
                a = 0
            px[x, y] = (r, g, b, a)
    return im


def fit(im):
    im = im.crop(im.getchannel('A').getbbox())
    bw, bh = BOX[2] - BOX[0], BOX[3] - BOX[1]
    k = min(bw / im.width, bh / im.height)
    im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
    canvas = Image.new('RGBA', CANVAS, (0, 0, 0, 0))
    canvas.paste(im, ((CANVAS[0] - im.width) // 2, (CANVAS[1] - im.height) // 2), im)
    return canvas.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    fit(clean(sys.argv[1], len(sys.argv) > 3 and sys.argv[3] == 'key')).save(sys.argv[2], optimize=True)
