#!/usr/bin/env python3
"""Independently validate the BALLISTA delivery by re-importing it fresh.

Loads docs/design/blender/ballista/ballista.glb into a brand-new empty
factory scene and measures it against the frozen sniper runtime contract
(same anchors PEREGRINE was held to):

    blender --background --factory-startup --python validate-ballista.py -- \\
        [<ballista.glb> <validation.json>]

Exit codes: 0 report written (pass or fail), 1 bad usage, 2 import/report error.
"""
import bpy
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
ROOT = HERE.parents[3]
DEFAULT_GLB = ROOT / 'docs/design/blender/ballista/ballista.glb'
DEFAULT_JSON = ROOT / 'docs/design/blender/ballista/validation.json'

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
GLB = Path(argv[0]) if len(argv) > 0 else DEFAULT_GLB
OUT = Path(argv[1]) if len(argv) > 1 else DEFAULT_JSON

PARTS = ('body', 'mag', 'bolt', 'trigger', 'factory-optic', 'extra')
MARKERS = ('muzzle', 'grip', 'support', 'sight')
ROUNDS = ('Round 1', 'Round 2', 'Round 3')
ANCHORS = {  # authoring space: +Y forward, +Z up
    'muzzle': (0.000, 0.760, 0.055),
    'grip': (0.045, 0.130, 0.020),
    'support': (-0.055, 0.480, -0.010),
    'sight': (0.000, 0.250, 0.205),
}
HEAT_BAND = (0.560, 0.720)
BORE_R = 0.0210

failures, advisory, measured = [], [], {}


def check(name, ok, detail):
    measured[name] = detail
    if not ok:
        failures.append(f'{name}: {detail}')

# Fresh context: factory-startup holds only default Cube/Light/Camera.
scene = bpy.context.scene
for obj in list(scene.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
scene.render.engine = 'BLENDER_WORKBENCH'
bpy.ops.import_scene.gltf(filepath=str(GLB))
imported = list(scene.objects)
measured['imported_objects'] = sorted(o.name for o in imported)

by_name = {o.name: o for o in imported}
for part in PARTS:
    check(f'node:{part}', part in by_name, 'present' if part in by_name else 'MISSING')
for marker in MARKERS:
    check(f'marker:{marker}', marker in by_name, 'present' if marker in by_name else 'MISSING')

for marker, want in ANCHORS.items():
    obj = by_name.get(marker)
    if obj is None:
        continue
    got = tuple(obj.location)
    err = math.dist(got, want)
    check(f'anchor:{marker}', err < 2e-3, f'got {tuple(round(v, 5) for v in got)} want {want}')

for part in ('body', 'mag', 'bolt', 'trigger', 'factory-optic'):
    obj = by_name.get(part)
    if obj is None:
        continue
    loc = tuple(obj.location)
    check(f'identity:{part}', all(abs(v) < 1e-6 for v in loc), f'translation {loc}')

meshes = [o for o in imported if o.type == 'MESH']
prims = len(meshes)
check('primitive_budget', prims <= 24, f'{prims} mesh primitives (budget 24)')

triangles = 0
band_r, band_n = 0.0, 0
tip_y = -1e9
for obj in meshes:
    mesh = obj.data
    mesh.calc_loop_triangles()
    triangles += len(mesh.loop_triangles)
    mw = obj.matrix_world
    for v in mesh.vertices:
        p = mw @ v.co
        tip_y = max(tip_y, p[1]) if abs(p[0]) < 0.03 and abs(p[2] - 0.055) < 0.03 else tip_y
        if HEAT_BAND[0] <= p[1] <= HEAT_BAND[1]:
            band_n += 1
            band_r = max(band_r, math.hypot(p[0], p[2] - 0.055))
measured['triangles'] = triangles
check('triangle_budget', 10000 <= triangles <= 20000, f'{triangles} tris (budget 10k-20k)')
check('muzzle_tip', abs(tip_y - 0.760) < 2e-3, f'forward-most bore vertex y={tip_y:.5f}')
check('heat_band_radius', abs(band_r - BORE_R) < 1e-3,
      f'max radius in band {band_r:.5f} over {band_n} verts (contract 0.0210)')
if band_n == 0:
    failures.append('heat_band_radius: no vertices in the heat band span')

mats = {m for o in meshes for m in o.data.materials if m}
check('material_budget', len(mats) <= 8, f'{len(mats)} materials: {sorted(m.name for m in mats)}')
images = {i.name for i in bpy.data.images if i.users}
check('images_embedded', len(images) >= 6, f'{len(images)} images: {sorted(images)}')

for rnd in ROUNDS:
    obj = by_name.get(rnd)
    if obj is None:
        continue
    xs = [v.co[0] for v in obj.data.vertices]
    ys = [v.co[1] for v in obj.data.vertices]
    zs = [v.co[2] for v in obj.data.vertices]
    size = (max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))
    centre = ((max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2, (max(zs) + min(zs)) / 2)
    ok_size = abs(size[0] - 0.012) < 0.003 and abs(size[2] - 0.012) < 0.003 \
        and abs(size[1] - 0.050) < 0.003
    ok_centre = all(abs(c) < 0.002 for c in centre)
    check(f'round:{rnd}', ok_size and ok_centre,
          f'size=({size[0]:.4f},{size[1]:.4f},{size[2]:.4f}) centre=({centre[0]:.4f},{centre[1]:.4f},{centre[2]:.4f})')
    parent = obj.parent.name if obj.parent else None
    check(f'round_parent:{rnd}', parent == 'extra', f'parent={parent}')

report = {'asset': 'BALLISTA', 'glb': str(GLB), 'passed': not failures,
          'failures': failures, 'advisory': advisory, 'measured': measured}
OUT.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': report['passed'], 'failures': failures,
                  'triangles': triangles, 'prims': prims}, indent=2))
