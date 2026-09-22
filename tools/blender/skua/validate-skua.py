#!/usr/bin/env python3
"""Independently validate the SKUA delivery by re-importing it fresh.

Usage:
    blender --background --factory-startup --python tools/blender/skua/validate-skua.py

Checks the study GLB and the browser glTF against the frozen runtime contract:
node and marker names, anchor placement, group identity, the pivot-local
animated nodes (mag disc centre, bolt hub, horn hinges, spare disc, gauge
needle), UV references, palette images, the magenta razor-glow emissive,
budgets, no negative scale, no nonfinite coordinates, no inward-facing
surfaces, the spindle tip on the muzzle plane and the heat-band clearance.
Writes docs/design/blender/skua/validation.json with passed/failures/advisory.
"""
import json
import math
import re
import struct
import sys
from pathlib import Path

import bpy

HERE = Path(__file__).resolve()
ROOT = HERE.parents[3]
DEFAULT_GLB = ROOT / 'docs/design/blender/skua/skua.glb'
DEFAULT_GLTF = ROOT / 'public/assets/blender/skua.gltf'
DEFAULT_JSON = ROOT / 'docs/design/blender/skua/validation.json'

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
GLB = Path(argv[0]) if len(argv) > 0 else DEFAULT_GLB
GLTF = Path(argv[1]) if len(argv) > 1 else DEFAULT_GLTF
OUT = Path(argv[2]) if len(argv) > 2 else DEFAULT_JSON

PARTS = ('body', 'mag', 'bolt', 'trigger', 'extra')
MARKERS = ('muzzle', 'grip', 'support', 'sight')
ANCHORS = {  # authoring space: +Y forward, +Z up
    'muzzle': (0.0, 0.400, 0.0),
    'grip': (0.0, -0.040, -0.075),
    'support': (0.0, 0.300, -0.060),
    'sight': (0.0, 0.340, 0.150),
}
# Pivots in game space (the runtime glTF node translations).
PIVOTS = {
    'mag': (0.0, 0.042, -0.220),
    'bolt': (0.0, 0.0, 0.060),
    'horn left': (-0.050, 0.0, -0.335),
    'horn right': (0.050, 0.0, -0.335),
    'spare disc': (0.0, -0.072, -0.165),
    'gauge needle': (-0.0635, 0.0, 0.070),
}
EXTRA_LEAVES = {'horn left | orange paint', 'horn left | razor glow',
                'horn right | orange paint', 'horn right | razor glow',
                'spare disc | blade steel', 'spare disc | polished edge',
                'spare disc | razor glow', 'gauge needle | brass'}
HEAT_BAND = (0.340, 0.392)      # authoring y, the bare spindle (the tip chamfer follows)
HEAT_CLEAR = 0.030
BORE_R = 0.0155
MUZZLE_Y = 0.400
PALETTE_IMAGES = {'phosphated-steel', 'orange-paint', 'ivory-ceramic', 'molded-polymer',
                  'machined-steel', 'aged-brass'}
EXPECTED_MATERIALS = {'ivory coating', 'orange paint', 'gunmetal', 'dark polymer',
                      'blade steel', 'polished edge', 'brass', 'razor glow'}
GLOW_LINEAR = (1.0, 0.049707, 0.630757)   # #ff3fd0
TRIANGLE_BUDGET = (12000, 18000)

failures, advisory, measured = [], [], {}


def check(name, ok, detail):
    measured[name] = detail
    if not ok:
        failures.append(f'{name}: {detail}')


def read_document(path):
    raw = path.read_bytes()
    if raw[:4] == b'glTF':
        (length, kind) = struct.unpack('<II', raw[12:20])
        return json.loads(raw[20:20 + length].decode('utf-8'))
    return json.loads(raw.decode('utf-8'))


def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def import_gltf(path):
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(path))
    return list(bpy.context.scene.objects)


def world_translation(document, index):
    """Accumulate node translations from the root (the export has no rotations)."""
    parents = {child: i for (i, node) in enumerate(document['nodes'])
               for child in node.get('children', [])}
    total = [0.0, 0.0, 0.0]
    while index is not None:
        node = document['nodes'][index]
        for k, v in enumerate(node.get('translation', [0, 0, 0])):
            total[k] += v
        index = parents.get(index)
    return total


def document_checks(label, document, runtime):
    """Node-contract checks straight off the glTF JSON (the authoritative tree)."""
    nodes = document.get('nodes', [])
    names = [node.get('name', '') for node in nodes]
    check(f'{label}:node_names_unique', len(names) == len(set(names)),
          f'{len(names)} nodes: {sorted(names)}')
    by_name = {node.get('name', ''): node for node in nodes}
    index_of = {node.get('name', ''): i for (i, node) in enumerate(nodes)}
    for part in PARTS + MARKERS:
        check(f'{label}:node:{part}', part in by_name, 'present' if part in by_name else 'MISSING')
    for part in PARTS:
        extras = by_name.get(part, {}).get('extras', {})
        check(f'{label}:blenderAsset:{part}', extras.get('blenderAsset') == 'skua',
              f'extras.blenderAsset={extras.get("blenderAsset")!r}')
    for marker in MARKERS:
        want = ANCHORS[marker]
        want_game = (want[0], want[2], -want[1])
        got = world_translation(document, index_of[marker]) if marker in index_of else []
        delta = max((abs(a - b) for (a, b) in zip(got, want_game)), default=9e9)
        check(f'{label}:anchor:{marker}', len(got) == 3 and delta <= 1e-5,
              f'got {[round(v, 6) for v in got]} want {list(want_game)}')

    # The extra leaves: exactly the contract set, each at its pivot.
    leaves = [name for name in names if ' | ' in name and name.split(' | ')[0] in PIVOTS
              and name.split(' | ')[0] not in ('mag', 'bolt')]
    check(f'{label}:extra_leaves', set(leaves) == EXTRA_LEAVES,
          f'{sorted(leaves)} (contract {sorted(EXTRA_LEAVES)})')
    extra_descendants = set()
    stack = list(by_name.get('extra', {}).get('children', []))
    while stack:
        child = stack.pop()
        extra_descendants.add(names[child])
        stack += nodes[child].get('children', [])
    check(f'{label}:extra_children', EXTRA_LEAVES <= extra_descendants,
          f'{sorted(extra_descendants)}')
    for name in sorted(EXTRA_LEAVES | ({'mag', 'bolt'} if runtime else set())):
        if name not in index_of:
            continue
        pivot = PIVOTS[name.split(' | ')[0]]
        got = world_translation(document, index_of[name])
        delta = max(abs(a - b) for (a, b) in zip(got, pivot))
        check(f'{label}:pivot:{name}', delta <= 1e-5, f'got {[round(v, 6) for v in got]} want {list(pivot)}')
    if not runtime:
        # The Blender GLB nests `mag | <material>` under the group empty.
        for group in ('mag', 'bolt'):
            children = [names[i] for i in by_name.get(group, {}).get('children', [])]
            for child in children:
                got = world_translation(document, index_of[child])
                delta = max(abs(a - b) for (a, b) in zip(got, PIVOTS[group]))
                check(f'{label}:pivot:{child}', delta <= 1e-5,
                      f'got {[round(v, 6) for v in got]} want {list(PIVOTS[group])}')
    scales = [(node.get('name', ''), node.get('scale')) for node in nodes
              if node.get('scale') is not None]
    bad_scales = [f'{name}={scale}' for (name, scale) in scales
                  if any(component <= 0 for component in scale)]
    check(f'{label}:node_scales', not bad_scales,
          f'{len(scales)} explicit scales, negative: {bad_scales}')
    rotations = [node.get('name', '') for node in nodes
                 if node.get('rotation') not in (None, [0, 0, 0, 1], [0.0, 0.0, 0.0, 1.0])]
    check(f'{label}:node_rotations', not rotations,
          f'rotated nodes {rotations} (pivots are translation-only)')

    missing_uv, mismatched, nonfinite = [], [], []
    for mesh in document.get('meshes', []):
        for primitive in mesh.get('primitives', []):
            name = mesh.get('name', '?')
            attributes = primitive.get('attributes', {})
            if 'TEXCOORD_0' not in attributes:
                missing_uv.append(name)
                continue
            uv = document['accessors'][attributes['TEXCOORD_0']]
            position = document['accessors'][attributes['POSITION']]
            if uv['count'] != position['count']:
                mismatched.append(f'{name}: uv {uv["count"]} != position {position["count"]}')
            for accessor_index in attributes.values():
                accessor = document['accessors'][accessor_index]
                if 'min' in accessor and any(not math.isfinite(v)
                                             for v in accessor['min'] + accessor['max']):
                    nonfinite.append(f'{name}: accessor bounds')
    check(f'{label}:uv_references', not missing_uv and not mismatched,
          f'missing={missing_uv} mismatched={mismatched}')
    check(f'{label}:accessor_bounds_finite', not nonfinite, f'{nonfinite}')

    materials = document.get('materials', [])
    part_materials, mapped, textured = set(), {}, 0
    glow = None
    for material in materials:
        extras = material.get('extras', {})
        key = extras.get('partMaterial') or material.get('name', '').split(' | ')[-1]
        key = re.sub(r'\.\d+$', '', key)
        part_materials.add(key)
        if key == 'razor glow':
            glow = material
        library = extras.get('textureLibrary')
        if library:
            mapped[library] = extras.get('textureBumpScale', 0)
        if 'baseColorTexture' in material.get('pbrMetallicRoughness', {}):
            textured += 1
    check(f'{label}:material_names', part_materials == EXPECTED_MATERIALS,
          f'{sorted(part_materials)}')
    check(f'{label}:texture_library',
          set(mapped) == PALETTE_IMAGES and all(bump > 0 for bump in mapped.values()),
          f'{len(mapped)} palette maps {sorted(mapped.items())}')
    images = document.get('images', [])
    stems = {Path(image.get('uri', image.get('name', ''))).stem for image in images}
    check(f'{label}:images', PALETTE_IMAGES <= stems and textured == 7,
          f'{len(images)} images {sorted(stems)} for {textured} textured materials')
    for material in materials:
        texture = material.get('pbrMetallicRoughness', {}).get('baseColorTexture')
        if texture is not None:
            source = document['textures'][texture['index']]['source']
            check(f'{label}:image_reference:{material["name"]}',
                  source < len(images), f'texture source {source}')
    emissive = (glow or {}).get('emissiveFactor', [])
    check(f'{label}:razor_glow_emissive',
          glow is not None and len(emissive) == 3 and
          max(abs(a - b) for (a, b) in zip(emissive, GLOW_LINEAR)) < 2e-3 and
          glow.get('extras', {}).get('cosmeticGlow') is True and
          'baseColorTexture' not in glow.get('pbrMetallicRoughness', {}),
          f'emissiveFactor={emissive} extras={(glow or {}).get("extras")}')
    draws = sum(len(mesh.get('primitives', [])) for mesh in document.get('meshes', []))
    check(f'{label}:primitive_budget', draws <= 24, f'{draws} primitives (budget 24)')
    triangles = sum(document['accessors'][primitive['indices']]['count'] // 3
                    for mesh in document.get('meshes', []) for primitive in mesh['primitives'])
    check(f'{label}:triangle_budget', TRIANGLE_BUDGET[0] <= triangles <= TRIANGLE_BUDGET[1],
          f'{triangles} tris (budget {TRIANGLE_BUDGET[0]}-{TRIANGLE_BUDGET[1]})')
    measured[f'{label}:draws'] = draws
    measured[f'{label}:triangles'] = triangles


def import_checks(label, path):
    """Geometry checks on a fresh Blender import of the delivered file."""
    imported = import_gltf(path)
    measured[f'{label}:imported_objects'] = len(imported)
    by_name = {}
    for obj in imported:
        by_name.setdefault(obj.name.split('.')[0].split('_')[0], obj)
    for marker in MARKERS:
        obj = by_name.get(marker)
        check(f'{label}:import_marker:{marker}', obj is not None,
              'present' if obj is not None else 'MISSING')
        if obj is None:
            continue
        want = ANCHORS[marker]
        got = tuple(obj.matrix_world.translation)
        err = max(abs(a - b) for (a, b) in zip(got, want))
        check(f'{label}:import_anchor:{marker}', err < 2e-3,
              f'got {tuple(round(v, 5) for v in got)} want {want}')

    meshes = [o for o in imported if o.type == 'MESH']
    triangles = 0
    band_r, band_n, band_foreign = 0.0, 0, 0.0
    tip_y = -1e9
    extent = [[1e9, -1e9] for _ in range(3)]
    nonfinite, negative_volume = [], []
    for obj in meshes:
        mesh = obj.data
        mesh.calc_loop_triangles()
        triangles += len(mesh.loop_triangles)
        volume = 0.0
        spindle = obj.name.startswith('body') and any(
            m and m.name.split('.')[0] == 'SKUA | gunmetal' for m in mesh.materials)
        for vertex in mesh.vertices:
            point = obj.matrix_world @ vertex.co
            for axis in range(3):
                extent[axis][0] = min(extent[axis][0], point[axis])
                extent[axis][1] = max(extent[axis][1], point[axis])
                if not math.isfinite(point[axis]):
                    nonfinite.append(f'{obj.name}:{vertex.index}')
            radial = math.hypot(point[0], point[2])
            if radial < HEAT_CLEAR:
                tip_y = max(tip_y, point[1])
                if HEAT_BAND[0] - 1e-9 <= point[1] <= HEAT_BAND[1] + 1e-9:
                    if spindle:
                        band_n += 1
                        band_r = max(band_r, radial)
                    else:
                        band_foreign = max(band_foreign, 1.0)
        for triangle in mesh.loop_triangles:
            (a, b, c) = (obj.matrix_world @ mesh.vertices[i].co for i in triangle.vertices)
            volume += a.dot(b.cross(c)) / 6.0
        if volume < 0:
            negative_volume.append(f'{obj.name} ({volume * 1e6:.1f} cm3)')
    check(f'{label}:nonfinite_coordinates', not nonfinite, f'{nonfinite[:5]}')
    check(f'{label}:negative_scale', all(min(o.scale) > 0 for o in imported),
          f'scales {sorted({tuple(round(v, 4) for v in o.scale) for o in imported})}')
    check(f'{label}:inward_surfaces', not negative_volume,
          f'{negative_volume} (signed volume must face outward)')
    measured[f'{label}:triangles'] = triangles
    measured[f'{label}:bounds'] = [[round(v, 5) for v in axis] for axis in extent]
    check(f'{label}:muzzle_tip', abs(tip_y - MUZZLE_Y) < 1e-3,
          f'forward-most on-axis vertex y={tip_y:.5f} (spindle tip 0.400; horns are off-axis)')
    check(f'{label}:heat_band_radius', band_n > 0 and abs(band_r - BORE_R) < 1e-3,
          f'max spindle radius in band {band_r:.5f} over {band_n} verts (contract {BORE_R})')
    check(f'{label}:heat_band_clearance', band_foreign == 0.0,
          f'only the spindle within {HEAT_CLEAR} of the axis across the band')
    mats = {m for o in meshes for m in o.data.materials if m}
    check(f'{label}:material_budget', len(mats) <= 8,
          f'{len(mats)} materials: {sorted(m.name for m in mats)}')
    stems = {Path(i.name).stem for i in bpy.data.images
             if i.users and i.name not in {'Render Result', 'Viewer Node'}}
    check(f'{label}:material_images', PALETTE_IMAGES <= stems, f'{sorted(stems)}')


for (label, path, runtime) in (('glb', GLB, False), ('gltf', GLTF, True)):
    if not path.exists():
        check(f'{label}:file', False, f'{path} MISSING')
        continue
    check(f'{label}:file', True, f'{path.relative_to(ROOT)} ({path.stat().st_size} bytes)')
    document_checks(label, read_document(path), runtime)
    import_checks(label, path)

report = {'asset': 'SKUA', 'glb': str(GLB.relative_to(ROOT)), 'gltf': str(GLTF.relative_to(ROOT)),
          'passed': not failures, 'failures': failures, 'advisory': advisory,
          'measured': measured}
OUT.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': report['passed'], 'failures': failures,
                  'advisory': advisory}, indent=2))
if failures:
    raise SystemExit(f'SKUA validation failed: {len(failures)} failures')
print('SKUA-VALIDATION-PASSED')
