#!/usr/bin/env python3
"""Independently validate the TALON delivery by re-importing it fresh.

Usage:
    blender --background --factory-startup --python tools/blender/talon/validate-talon.py
"""
import bpy
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
ROOT = HERE.parents[3]
DEFAULT_GLB = ROOT / 'docs/design/blender/talon/talon.glb'
DEFAULT_JSON = ROOT / 'docs/design/blender/talon/validation.json'

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
GLB = Path(argv[0]) if len(argv) > 0 else DEFAULT_GLB
OUT = Path(argv[1]) if len(argv) > 1 else DEFAULT_JSON

PARTS = ('body', 'mag', 'bolt', 'trigger', 'extra')
MARKERS = ('muzzle', 'grip', 'sight')
ROUNDS = ()
ANCHORS = {  # authoring space: +Y forward, +Z up
    'muzzle': (0.000, 0.420, 0.020),
    'grip': (0.020, 0.035, -0.225),
    'sight': (0.000, 0.220, 0.020),
}
TIP_Y = 0.420
SPINE_Z = 0.020

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

for part in PARTS:
    obj = by_name.get(part)
    if obj is None:
        continue
    loc = tuple(obj.location)
    check(f'identity:{part}', all(abs(v) < 1e-6 for v in loc), f'translation {loc}')

meshes = [o for o in imported if o.type == 'MESH']
prims = len(meshes)
check('primitive_budget', prims <= 24, f'{prims} mesh primitives (budget 24)')

triangles = 0
tip_y = -1e9
spine_z = -1e9
for obj in meshes:
    mesh = obj.data
    mesh.calc_loop_triangles()
    triangles += len(mesh.loop_triangles)
    mw = obj.matrix_world
    for v in mesh.vertices:
        p = mw @ v.co
        if abs(p[0]) < 0.03 and abs(p[2] - SPINE_Z) < 0.03:
            tip_y = max(tip_y, p[1])
        if p[1] > 0.05:
            spine_z = max(spine_z, p[2])
measured['triangles'] = triangles
check('triangle_budget', 4000 <= triangles <= 10000, f'{triangles} tris (budget 4k-10k)')
check('blade_tip', abs(tip_y - TIP_Y) < 2e-3, f'forward-most blade vertex y={tip_y:.5f}')
check('spine_line', abs(spine_z - SPINE_Z) < 2e-3,
      f'max z forward of the guard {spine_z:.5f} (contract 0.020)')

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

report = {'asset': 'TALON', 'glb': str(GLB), 'passed': not failures,
          'failures': failures, 'advisory': advisory, 'measured': measured}
OUT.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': report['passed'], 'failures': failures,
                  'triangles': triangles, 'prims': prims}, indent=2))
