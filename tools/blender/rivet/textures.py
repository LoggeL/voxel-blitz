"""Rebuild RIVET's small color maps with NumPy and Pillow."""

from pathlib import Path

import numpy as np
from PIL import Image


OUT = Path(__file__).resolve().parents[3] / "public/assets/blender/textures/rivet"


def write_jpeg(name, rgb):
    image = Image.fromarray(np.uint8(np.clip(np.rint(rgb), 0, 255)))
    image.save(OUT / name, quality=92, subsampling=0, optimize=True)


def ripstop():
    size = 512
    rng = np.random.default_rng(707)
    y, x = np.mgrid[0:size, 0:size]
    tau = 2 * np.pi

    # The twill alternates raised and shaded yarn at each crossing. Coarser
    # double threads repeat every eight crossings along the warp and weft.
    warp = np.cos(tau * x / 4)
    weft = np.cos(tau * y / 4)
    over = np.sin(tau * (x + y) / 16)
    weave = (warp * (1 + over) + weft * (1 - over)) * 4.5
    guard = np.exp(-((x % 32 - 2) / 1.2) ** 2) + np.exp(-((y % 32 - 2) / 1.2) ** 2)
    shadow = np.exp(-((x % 32 - 4) / 1.4) ** 2) + np.exp(-((y % 32 - 4) / 1.4) ** 2)

    # Periodic noise gives the individual yarns a little variation in the dye.
    dye = np.zeros((size, size))
    for fx, fy in ((2, 3), (4, -5), (9, 2), (6, 11), (19, -9), (23, 14)):
        phase = rng.uniform(0, tau)
        dye += 1.9 * np.sin(tau * (x * fx + y * fy) / size + phase)
    yarn = 173 + dye + weave + 9 * guard - 7 * shadow + rng.normal(0, 2.8, dye.shape)
    write_jpeg("ripstop.jpg", np.stack((yarn * 0.968, yarn, yarn * 1.009), axis=2))


def field_webbing():
    size = 512
    rng = np.random.default_rng(1707)
    y, x = np.mgrid[0:size, 0:size]
    tau = 2 * np.pi
    # Fine warp-faced nylon, about two millimetres to a raised thread at the
    # authored UV scale. Only the exposed crowns of the warp take light wear.
    wander = 0.1 * np.sin(tau * y / 64) + 0.12 * np.cos(tau * (x + y) / 128)
    warp = (0.5 + 0.5 * np.cos(tau * (x / 4 + wander))) ** 2
    binding = np.sin(tau * (y / 8 + x / 16))
    crowns = warp * (3.6 + 1.4 * binding)
    dye = np.zeros((size, size))
    for fx, fy, amplitude in ((3, 1, 1.4), (17, 2, .8), (1, 5, 1.5), (7, -3, 1.8), (6, 11, .8)):
        dye += amplitude * np.sin(tau * (x * fx + y * fy) / size + rng.uniform(0, tau))
    # Long, softly bleached fibres keep the worn areas quieter than the
    # flat buckles, snaps and binding around them.
    rubbed = (0.5 + 0.5 * np.cos(tau * (x / 32 + np.sin(tau * y / 128) * .08))) ** 8
    worn = rubbed * (0.5 + 0.5 * np.sin(tau * (x + y) / 128))
    grain = crowns + dye + 2.4 * worn + rng.normal(0, 1.4, dye.shape)
    write_jpeg("field-webbing.jpg", np.stack((117 + grain, 106 + grain, 84 + grain), axis=2))


def nubuck():
    size = 512
    rng = np.random.default_rng(7107)
    y, x = np.mgrid[0:size, 0:size]
    # The margins between nearby grain centres form shallow, irregular
    # furrows. Wrap the neighbours so the hide tiles across the boot panels.
    cells = 80
    gx, gy = x * cells / size, y * cells / size
    col, row = gx.astype(int), gy.astype(int)
    jitter = rng.uniform(0.1, 0.9, (cells, cells, 2))
    nearest = np.full(x.shape, np.inf)
    second = nearest.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            centre = jitter[(row + dy) % cells, (col + dx) % cells]
            dist = np.hypot((col + dx + centre[:, :, 0] - gx) * .85,
                            row + dy + centre[:, :, 1] - gy)
            second = np.minimum(second, np.maximum(dist, nearest))
            nearest = np.minimum(nearest, dist)
    furrows = np.exp(-((second - nearest) / .12) ** 2)
    # Brushing the short nap in different directions exposes lighter fibres.
    nap = np.zeros(x.shape)
    for fx, fy, strength in ((2, 1, 3.5), (1, -3, 2.5), (3, 5, 2), (11, 4, 1.4), (20, -3, 1.2)):
        nap += strength * np.sin(2 * np.pi * (x * fx + y * fy) / size + rng.uniform(0, 2 * np.pi))
    nap += rng.normal(0, 2.2, x.shape)
    finish = nap + 1.4 - 5 * furrows
    write_jpeg("nubuck.jpg", np.stack((81 + finish, 66 + finish, 56 + finish), axis=2))


def visor_lenses():
    height, width = 192, 512
    v, u = np.mgrid[0:height, 0:width]
    u = (u + 0.5) / width
    v = (v + 0.5) / height
    x = 2 * u - 1

    # Alpine daylight in a convex copper mirror. Compress and bend the reflected
    # horizon into the curved outer wings. The live material supplies specular.
    horizon = 0.51 + 0.15 * (1 - x ** 2) + 0.045 * x
    elevation = v - horizon
    stops = (-0.9, -0.53, -0.31, -0.12, -0.04, 0.04, 0.19, 0.43, 0.78)
    colors = ((68, 38, 29), (106, 65, 42), (153, 100, 58), (209, 151, 88),
              (228, 176, 112), (157, 103, 62), (85, 52, 38), (58, 36, 32), (40, 31, 32))
    rgb = np.stack([np.interp(elevation, stops, [c[i] for c in colors]) for i in range(3)], axis=2)

    ridge = np.interp(u, (0, .10, .17, .28, .38, .49, .59, .71, .76, .88, 1),
                     (.028, -.025, .004, -.065, -.018, -.035, .013, -.045, -.028, .029, -.021))
    ridge += .005 * np.sin(u * 137) + .003 * np.sin(u * 263)
    foothills = np.clip(0.5 + (elevation - ridge) / .035, 0, 1) * np.exp(-((elevation - ridge) / .12) ** 2)
    rgb -= foothills[:, :, None] * (30, 32, 26)

    # Long soft streak on the upper left collapses as the surface turns away.
    sheen = np.exp(-((u - .24) / .29) ** 4 - ((v - .20 - .12 * x ** 2) / .038) ** 2)
    glint = np.exp(-((u - .71) / .06) ** 2 - ((elevation + .085) / .05) ** 2)
    rgb += sheen[:, :, None] * (29, 32, 31) + glint[:, :, None] * (19, 21, 18)
    rgb += ((np.abs(x) ** 3)[:, :, None]) * (14, 15, 17)
    write_jpeg("copper-lens.jpg", rgb)
    # Cosmetic dyes retain the same sky and ridgeline through a neutral mirror.
    luma = rgb @ np.array((0.2126, 0.7152, 0.0722))
    silver = 26 + luma * 1.10
    write_jpeg("silver-lens.jpg", np.stack((silver, silver, silver), axis=2))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    ripstop()
    field_webbing()
    nubuck()
    visor_lenses()
