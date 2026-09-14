#!/usr/bin/env python3
"""Independently validate the KESTREL revision 2 delivery by re-importing it fresh.

Loads docs/design/blender/kestrel/kestrel.glb into a brand-new empty factory
scene and measures it against the frozen rifle runtime contract (TIMERS.rifle
in public/js/guns/defs.js, BREACH_Z/BARREL_R/BOLT_HOME/TRIGGER_Z in
public/js/guns/models/common.js, HANDS.rifle in shared/avatar-hands.js,
sightHeight in public/js/guns/models/kestrel.js). The runtime glTF JSON is
parsed alongside (node names, image URIs, part materials).

    blender --background --factory-startup --python validate-kestrel.py -- \\
        [<kestrel.glb> <kestrel.gltf> <validation.json>]

Exit codes: 0 report written (pass or fail), 1 bad usage, 2 import/report error.
"""
import bpy
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
ROOT = HERE.parents[3]
DEFAULT_GLB = ROOT / 'docs/design/blender/kestrel/kestrel.glb'
DEFAULT_GLTF = ROOT / 'public/assets/blender/kestrel.gltf'
DEFAULT_JSON = ROOT / 'docs/design/blender/kestrel/validation.json'

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
GLB = Path(argv[0]) if len(argv) > 0 else DEFAULT_GLB
GLTF = Path(argv[1]) if len(argv) > 1 else DEFAULT_GLTF
OUT = Path(argv[2]) if len(argv) > 2 else DEFAULT_JSON

PARTS = ('body', 'mag', 'bolt', 'trigger', 'factory-optic', 'extra')
MARKERS = ('muzzle', 'grip', 'support', 'sight')
ANCHORS = {  # authoring space: +Y forward, +Z up
    'muzzle': (-0.012, 0.598, 0.045),
    'grip': (0.045, 0.090, 0.015),
    'support': (-0.055, 0.400, 0.005),
    'sight': (0.000, 0.187, 0.145),
}
BORE_X, BORE_Z = -0.012, 0.045
HEAT_BAND = (0.460, 0.572)
BORE_R = 0.0170
SIGHT_Z = 0.145

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
band_r, band_n = 0.0, 0
tip_y = -1e9
forward_y = -1e9
channel = set()
optic_bottom = 1e9
lens_span = None
for obj in meshes:
    mesh = obj.data
    mesh.calc_loop_triangles()
    triangles += len(mesh.loop_triangles)
    mw = obj.matrix_world
    group = obj.parent.name if obj.parent else obj.name.split(' | ')[0]
    is_lens = 'optic glass' in obj.name
    for v in mesh.vertices:
        p = mw @ v.co
        forward_y = max(forward_y, p[1])
        if abs(p[0] - BORE_X) < 0.03 and abs(p[2] - BORE_Z) < 0.03:
            tip_y = max(tip_y, p[1])
        if HEAT_BAND[0] <= p[1] <= HEAT_BAND[1]:
            band_n += 1
            band_r = max(band_r, math.hypot(p[0] - BORE_X, p[2] - BORE_Z))
        if abs(p[0]) < 0.018 and SIGHT_Z - 0.0005 <= p[2] <= SIGHT_Z + 0.004 and -0.05 < p[1] < 0.6:
            # Allowed on the line: the reflex lens (optic glass) and the front
            # sight post/wings, which live at y ~0.436 on the gas block.
            if not is_lens and not (0.42 < p[1] < 0.45):
                channel.add(obj.name)
        if group == 'factory-optic':
            optic_bottom = min(optic_bottom, p[2])
            if is_lens:
                lens_span = (min(lens_span[0], p[2]) if lens_span else p[2],
                             max(lens_span[1], p[2]) if lens_span else p[2])
measured['triangles'] = triangles
check('triangle_budget', 10000 <= triangles <= 30000, f'{triangles} tris (budget 10k-30k)')
check('muzzle_tip', abs(tip_y - 0.598) < 2e-3, f'forward-most bore vertex y={tip_y:.5f}')
check('nothing_past_muzzle', forward_y <= 0.598 + 1e-4, f'forward-most vertex y={forward_y:.5f}')
check('heat_band_radius', abs(band_r - BORE_R) < 1e-3,
      f'max radius in band {band_r:.5f} over {band_n} verts (contract 0.0170)')
if band_n == 0:
    failures.append('heat_band_radius: no vertices in the heat band span')
check('sight_channel_clear', not channel,
      'only the lens and front sight touch the 0.145 line' if not channel
      else f'geometry on the sight line: {sorted(channel)}')
check('optic_above_rail', optic_bottom >= 0.095, f'factory-optic lowest vertex z={optic_bottom:.4f}')
check('lens_spans_sight_line', lens_span is not None and lens_span[0] < SIGHT_Z < lens_span[1],
      f'reflex lens z-span {lens_span}')

mats = {m for o in meshes for m in o.data.materials if m}
check('material_budget', len(mats) <= 8, f'{len(mats)} materials: {sorted(m.name for m in mats)}')
images = {i.name for i in bpy.data.images if i.users}
check('images_embedded', len(images) >= 5, f'{len(images)} images: {sorted(images)}')
extra = by_name.get('extra')
check('extra_empty', extra is not None and not extra.children,
      'extra carries no loose parts (mag reload)' if extra is not None and not extra.children
      else f'extra children: {[c.name for c in extra.children] if extra else None}')
optic_prims = [o for o in meshes if o.parent and o.parent.name == 'factory-optic']
check('factory_optic_primitives', len(optic_prims) >= 2,
      f'{len(optic_prims)} factory-optic primitives: {sorted(o.name for o in optic_prims)}')

# --- runtime glTF: the browser delivery -----------------------------------
try:
    document = json.loads(GLTF.read_text())
    names = [node.get('name') for node in document['nodes']]
    check('runtime:nodes', all(p in names for p in PARTS) and all(m in names for m in MARKERS),
          f'nodes {names}')
    uris = [image.get('uri') for image in document.get('images', [])]
    check('runtime:images', all(u and u.startswith('textures/') and u.endswith('.jpg') for u in uris),
          f'images {uris}')
    used = {}
    for mesh in document['meshes']:
        for primitive in mesh['primitives']:
            used[mesh['name']] = used.get(mesh['name'], 0) + 1
    check('runtime:draws', sum(used.values()) <= 24, f'primitives per node {used}')
    tagged = [node['name'] for node in document['nodes']
              if node.get('extras', {}).get('blenderAsset') == 'kestrel']
    check('runtime:blenderAsset', set(PARTS) <= set(tagged), f'tagged {tagged}')
    glass = [m['name'] for m in document['materials'] if m.get('alphaMode') == 'BLEND']
    check('runtime:glass', len(glass) == 1, f'blend materials {glass}')
    textured = [m['name'] for m in document['materials']
                if 'baseColorTexture' in m.get('pbrMetallicRoughness', {})]
    check('runtime:textured', len(textured) >= 7, f'textured materials {textured}')
    check('runtime:buffer', document['buffers'][0]['uri'] == 'kestrel.bin',
          f"buffer {document['buffers'][0]}")
except Exception as error:  # noqa: BLE001 - report, never crash the validator
    failures.append(f'runtime glTF unreadable: {error!r}')

report = {'asset': 'KESTREL', 'revision': 2, 'glb': str(GLB), 'gltf': str(GLTF),
          'passed': not failures, 'failures': failures, 'advisory': advisory, 'measured': measured}
OUT.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': report['passed'], 'failures': failures,
                  'triangles': triangles, 'prims': prims}, indent=2))
