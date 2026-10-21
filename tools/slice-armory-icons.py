#!/usr/bin/env python3
"""Slice the generated ARMORY icon sheets into small transparent WebP icons.

The sheets in docs/design/armory-v2/icons/ are 3x3 grids that the image
endpoint already returns with a transparent background. Every opaque island is
assigned to the cell holding its centroid (so a wing that crosses a cell edge
stays with its icon and never leaks into the neighbour), the icon is trimmed,
centred on a square canvas and written to public/assets/ui/armory/icons/.

Usage: python3 tools/slice-armory-icons.py [--size 128]  (128 px, WebP quality 80)
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SHEETS = ROOT / 'docs/design/armory-v2/icons'
QUALITY = 80
OUT = ROOT / 'public/assets/ui/armory/icons'

# Row-major cell order; None marks an alternative design that is not shipped.
LAYOUT = {
    'compare-sheet-a-gpt-image-2.5-flare.webp': [
        'std-operator', 'std-signature', 'std-sound',
        'std-nameplate', 'sound-arcade', 'sound-high-noon',
        'sound-overdrive', 'title-armorer', 'title-armsmaster',
    ],
    'sheet-b-callsigns.webp': [
        'title-tactician', 'title-operator', 'title-sentinel',
        'title-warden', 'title-commander', 'title-legend',
        'title-immortal', 'title-weapon-master', None,
    ],
    'sheet-c-nameplates.webp': [
        'nameplate-ranger', 'nameplate-aegis', 'nameplate-eclipse',
        'nameplate-bulwark', 'nameplate-onyx', 'nameplate-centurion',
        'nameplate-zenith', 'nameplate-arsenal', None,
    ],
    'sheet-d-attachments.webp': [
        'part-reflex', 'part-angled', 'part-stattrak',
        'part-scope2', 'part-vertical', 'part-scope4',
        'part-precision', 'part-scope10', 'part-cyber',
    ],
    'sheet-e-tiers-classes.webp': [
        'tier-initiated', 'tier-specialist', 'tier-elite',
        'tier-master', 'class-pyro', 'class-grenadier',
        'class-raider', 'class-marksman', None,
    ],
}


def slice_sheet(path, names, size, margin):
    rgba = np.asarray(Image.open(path).convert('RGBA')).copy()
    height, width = rgba.shape[:2]
    alpha = rgba[..., 3].astype(np.float32)
    # The endpoint tops out at ~253; stretch so solid pixels are fully opaque.
    peak = np.percentile(alpha[alpha > 0], 99) if (alpha > 0).any() else 255
    alpha = np.clip(alpha * (255 / max(peak, 1)), 0, 255)
    alpha[alpha < 8] = 0
    rgba[..., 3] = alpha.astype(np.uint8)
    labels, count = ndimage.label(alpha > 24)
    centroids = ndimage.center_of_mass(np.ones_like(labels), labels, range(1, count + 1))
    cell_w, cell_h = width / 3, height / 3
    owner = np.zeros(count + 1, dtype=np.int16) - 1
    for index, (cy, cx) in enumerate(centroids, start=1):
        owner[index] = min(int(cy // cell_h), 2) * 3 + min(int(cx // cell_w), 2)
    # Soft edge pixels below the island threshold follow their nearest island.
    _, (near_y, near_x) = ndimage.distance_transform_edt(labels == 0, return_indices=True)
    pixel_owner = owner[labels[near_y, near_x]]
    results = []
    for cell, name in enumerate(names):
        if not name:
            continue
        mask = (pixel_owner == cell) & (alpha > 0)
        ys, xs = np.nonzero(mask)
        assert len(ys), f'{path.name} cell {cell + 1} is empty'
        top, bottom, left, right = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        icon = rgba[top:bottom, left:right].copy()
        icon[..., 3] = np.where(mask[top:bottom, left:right], icon[..., 3], 0)
        side = int(max(icon.shape[:2]) * (1 + 2 * margin))
        canvas = Image.new('RGBA', (side, side))
        canvas.paste(Image.fromarray(icon), ((side - icon.shape[1]) // 2, (side - icon.shape[0]) // 2))
        canvas = canvas.resize((size, size), Image.LANCZOS)
        target = OUT / f'{name}.webp'
        canvas.save(target, 'WEBP', quality=QUALITY, alpha_quality=85, method=6)
        results.append((name, target))
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--size', type=int, default=128)
    parser.add_argument('--margin', type=float, default=0.04)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {'tool': 'tools/slice-armory-icons.py', 'model': 'gpt-image-2.5-flare', 'size': args.size,
                'prompts': 'docs/design/armory-v2/icons/', 'icons': []}
    total = 0
    for sheet, names in LAYOUT.items():
        source = SHEETS / sheet
        for name, target in slice_sheet(source, names, args.size, args.margin):
            data = target.read_bytes()
            total += len(data)
            manifest['icons'].append({'file': target.name, 'sheet': sheet, 'cell': names.index(name) + 1,
                                      'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    (OUT / 'sources.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f"{len(manifest['icons'])} icons, {total / 1024:.1f} KB total in {OUT.relative_to(ROOT)}")


if __name__ == '__main__':
    main()
