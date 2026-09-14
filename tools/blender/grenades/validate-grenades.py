#!/usr/bin/env python3
"""Independently validate the GRENADES delivery by re-importing it fresh.

Loads docs/design/blender/grenades/grenades.glb into a brand-new empty
factory scene and measures it against the frozen held-frame contract that
`public/js/guns/throwable-hands.js` and `public/js/weapons/projectiles.js`
consume (pin socket, wick flame anchor, claymore wall plane, per-type
footprints). It then reads the runtime `public/assets/blender/grenades.gltf`
as JSON and checks that the same five nodes, the shared texture URIs and the
glow/glass material extras survived the runtime export.

    blender --background --factory-startup --python validate-grenades.py -- \\
        [<grenades.glb> <validation.json>]

Exit codes: 0 report written (pass or fail), 1 bad usage, 2 import/report error.
"""
import bpy
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
ROOT = HERE.parents[3]
DEFAULT_GLB = ROOT / 'docs/design/blender/grenades/grenades.glb'
DEFAULT_JSON = ROOT / 'docs/design/blender/grenades/validation.json'
RUNTIME_GLTF = ROOT / 'public/assets/blender/grenades.gltf'

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
GLB = Path(argv[0]) if len(argv) > 0 else DEFAULT_GLB
OUT = Path(argv[1]) if len(argv) > 1 else DEFAULT_JSON

TYPES = ('frag', 'limpet', 'pulse', 'molotov', 'smoke')
FUZE_TYPES = ('frag', 'pulse', 'smoke')
PIN_SOCKET = (-0.024, 0.088, 0.019)
WICK_TIP = (-0.037, 0.303, 0.0)
WALL_Z = -0.041
BOUNDS = {
    'frag': ((-0.085, -0.090, -0.085), (0.085, 0.115, 0.085)),
    'limpet': ((-0.105, -0.075, -0.046), (0.105, 0.075, 0.036)),
    'pulse': ((-0.095, -0.095, -0.095), (0.095, 0.115, 0.095)),
    'smoke': ((-0.070, -0.090, -0.070), (0.070, 0.115, 0.070)),
    'molotov': ((-0.060, -0.090, -0.060), (0.060, 0.320, 0.060)),
}
TEXTURES = ['worn-gunmetal', 'orange-painted-metal', 'ivory-armor',
            'petrol-ballistic-fabric', 'tan-webbing', 'worn-rubber']

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

for kind in TYPES:
    check(f'node:{kind}', kind in by_name, 'present' if kind in by_name else 'MISSING')
    obj = by_name.get(kind)
    if obj is None:
        continue
    loc = tuple(obj.location)
    check(f'identity:{kind}', all(abs(v) < 1e-6 for v in loc), f'translation {loc}')

meshes = [o for o in imported if o.type == 'MESH']
check('primitive_budget', len(meshes) <= 32, f'{len(meshes)} mesh primitives (budget 32)')

triangles = 0
per_type = {}
points = {kind: [] for kind in TYPES}
for obj in meshes:
    mesh = obj.data
    mesh.calc_loop_triangles()
    triangles += len(mesh.loop_triangles)
    kind = obj.name.split(' | ')[0]
    parent = obj.parent.name if obj.parent else None
    check(f'parent:{obj.name}', parent == kind, f'parent {parent} (want {kind})')
    per_type[kind] = per_type.get(kind, 0) + len(mesh.loop_triangles)
    mw = obj.matrix_world
    for v in mesh.vertices:
        p = mw @ v.co
        # The study GLB is written verbatim in the held frame (export_yup off);
        # Blender's importer still applies its y-up to z-up conversion, so map
        # the imported vertex back: held (x, y, z) = blender (x, z, -y).
        points[kind].append((obj.name, (p[0], p[2], -p[1])))
measured['triangles'] = triangles
measured['triangles_per_type'] = per_type
check('triangle_budget', 4000 <= triangles <= 24000, f'{triangles} tris (budget 4k-24k)')

for kind in TYPES:
    owned = points[kind]
    if not owned:
        failures.append(f'geometry:{kind}: no vertices')
        continue
    mins = [min(p[i] for (_n, p) in owned) for i in range(3)]
    maxs = [max(p[i] for (_n, p) in owned) for i in range(3)]
    (lo, hi) = BOUNDS[kind]
    inside = all(mins[i] >= lo[i] - 1e-4 and maxs[i] <= hi[i] + 1e-4 for i in range(3))
    check(f'footprint:{kind}', inside,
          f'x={mins[0]:+.4f}..{maxs[0]:+.4f} y={mins[1]:+.4f}..{maxs[1]:+.4f} '
          f'z={mins[2]:+.4f}..{maxs[2]:+.4f} (limit {lo}..{hi})')
    spans = all(mins[i] < -0.001 and maxs[i] > 0.001 for i in range(3))
    check(f'origin:{kind}', spans, 'spans the origin' if spans else 'does not span the origin')
    if kind in FUZE_TYPES:
        # The hardware primitive carries the fuze block, lever and pin lug.
        hardware = [p for (n, p) in owned if n == f'{kind} | hardware']
        check(f'fuze_top:{kind}', max(p[1] for p in hardware) >= 0.095,
              f'hardware top y={max(p[1] for p in hardware):.4f} (want >= 0.095)')
        lug = [p for p in hardware if p[0] < -0.015 and abs(p[1] - PIN_SOCKET[1]) < 0.012 and p[2] > 0.008]
        check(f'pin_lug:{kind}', len(lug) >= 4, f'{len(lug)} hardware vertices at the pin socket (want >= 4)')
        lever = max(p[0] for p in hardware)
        check(f'lever:{kind}', lever > 0.050, f'lever reaches x={lever:.4f} (want > 0.050)')
    if kind == 'limpet':
        check('wall_plane:limpet', abs(mins[2] - (WALL_Z - 0.003)) < 0.002,
              f'min z {mins[2]:.4f} (want {WALL_Z - 0.003:.3f})')
        lens = [p for (n, p) in owned if n == 'limpet | sensor lens']
        check('sensor:limpet', bool(lens) and max(p[2] for p in lens) >= 0.030,
              f'sensor lens max z {max((p[2] for p in lens), default=-1):.4f} (want >= 0.030)')
    if kind == 'molotov':
        rag = [p for (n, p) in owned if n == 'molotov | rag']
        top = max(p[1] for p in rag)
        crown = [p for p in rag if p[1] > top - 0.012]
        tip = [sum(p[i] for p in crown) / len(crown) for i in range(3)]
        check('wick_tip:molotov', math.dist(tip, WICK_TIP) < 0.012,
              f'wick crown centre {tuple(round(v, 4) for v in tip)} (want {WICK_TIP})')
        check('stands:molotov', abs(mins[1] + 0.083) < 0.004, f'base y {mins[1]:.4f} (want -0.083)')

mats = {m for o in meshes for m in o.data.materials if m}
check('material_budget', len(mats) <= 16, f'{len(mats)} materials: {sorted(m.name for m in mats)}')
images = {i.name for i in bpy.data.images if i.users}
check('images_embedded', len(images) >= 6, f'{len(images)} images: {sorted(images)}')

# --- runtime delivery -------------------------------------------------------
if RUNTIME_GLTF.exists():
    document = json.loads(RUNTIME_GLTF.read_text())
    names = [node.get('name') for node in document.get('nodes', [])]
    check('runtime:nodes', names == list(TYPES), f'{names} (want {list(TYPES)})')
    uris = [image.get('uri') for image in document.get('images', [])]
    check('runtime:textures', uris == [f'textures/{s}.jpg' for s in TEXTURES], f'{uris}')
    glow = [m['name'] for m in document.get('materials', []) if 'emissiveFactor' in m]
    check('runtime:glow_materials', len(glow) >= 4, f'{glow}')
    glass = [m['name'] for m in document.get('materials', []) if m.get('extras', {}).get('glass')]
    check('runtime:glass', glass == ['GRENADES | glass'], f'{glass}')
    for node in document.get('nodes', []):
        check(f'runtime:asset_tag:{node.get("name")}', node.get('extras', {}).get('blenderAsset') == 'grenades',
              str(node.get('extras')))
    binary = RUNTIME_GLTF.with_suffix('.bin')
    size = document['buffers'][0]['byteLength']
    check('runtime:bin', binary.exists() and binary.stat().st_size == size,
          f'{binary.name} {binary.stat().st_size if binary.exists() else "missing"} bytes (declared {size})')
else:
    advisory.append(f'runtime file missing: {RUNTIME_GLTF}')

report = {'asset': 'GRENADES', 'glb': str(GLB), 'passed': not failures,
          'failures': failures, 'advisory': advisory, 'measured': measured}
OUT.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': report['passed'], 'failures': failures,
                  'triangles': triangles, 'prims': len(meshes)}, indent=2))
