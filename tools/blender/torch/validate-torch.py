#!/usr/bin/env python3
"""Independently validate the TORCH delivery by re-importing it fresh.

Usage:
    blender --background --factory-startup --python tools/blender/torch/validate-torch.py

Checks the study GLB and the browser glTF against the frozen runtime contract:
node and marker names, anchor placement, group identity, bounds, UV references,
embedded material images, gate-leaf node translations exactly [-0.104, 0.075, -0.135],
no negative scale, no nonfinite coordinates, no inward-facing surfaces. Writes
docs/design/blender/torch/validation.json with passed/failures/advisory keys.
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
DEFAULT_GLB = ROOT / 'docs/design/blender/torch/torch.glb'
DEFAULT_GLTF = ROOT / 'public/assets/blender/torch.gltf'
DEFAULT_JSON = ROOT / 'docs/design/blender/torch/validation.json'

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
GLB = Path(argv[0]) if len(argv) > 0 else DEFAULT_GLB
GLTF = Path(argv[1]) if len(argv) > 1 else DEFAULT_GLTF
OUT = Path(argv[2]) if len(argv) > 2 else DEFAULT_JSON

PARTS = ('body', 'mag', 'bolt', 'trigger', 'extra')
MARKERS = ('muzzle', 'grip', 'support', 'sight')
GROUP_NAMES = set(PARTS)
GATE_PREFIX = 'gate | '
HINGE_GAME = (-0.104, 0.075, -0.135)  # vertical side pin, see build-torch.py HINGE
ANCHORS = {  # authoring space: +Y forward, +Z up
    'muzzle': (0.0, 0.780, 0.075),
    'grip': (0.045, 0.080, -0.020),
    'support': (-0.060, 0.400, -0.030),
    'sight': (0.0, 0.340, 0.175),
}
HEAT_BAND = (0.528, 0.752)
BORE_R = 0.0620
# Shared palette maps applied by tools/blender/material-library.py (six of the
# seven materials; cavity black stays untextured).
PALETTE_IMAGES = {'phosphated-steel', 'olive-paint', 'orange-paint',
                  'ivory-ceramic', 'molded-polymer', 'pebbled-rubber'}
EXPECTED_MATERIALS = {'gunmetal', 'olive drab', 'orange paint', 'ivory coating',
                      'polymer', 'rubber', 'cavity black'}

failures, advisory, measured = [], [], {}


def check(name, ok, detail):
    measured[name] = detail
    if not ok:
        failures.append(f'{name}: {detail}')


def read_document(path):
    raw = path.read_bytes()
    if raw[:4] == b'glTF':
        (_, _, total) = struct.unpack('<III', raw[:12])
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


def document_checks(label, document):
    """Node-contract checks straight off the glTF JSON (the authoritative tree)."""
    nodes = document.get('nodes', [])
    names = [node.get('name', '') for node in nodes]
    check(f'{label}:node_names_unique', len(names) == len(set(names)),
          f'{len(names)} nodes: {sorted(names)}')
    by_name = {node.get('name', ''): node for node in nodes}
    for part in PARTS:
        check(f'{label}:node:{part}', part in by_name,
              'present' if part in by_name else 'MISSING')
    for marker in MARKERS:
        check(f'{label}:marker:{marker}', marker in by_name,
              'present' if marker in by_name else 'MISSING')
    for part in PARTS:
        extras = by_name.get(part, {}).get('extras', {})
        check(f'{label}:blenderAsset:{part}', extras.get('blenderAsset') == 'torch',
              f'extras.blenderAsset={extras.get("blenderAsset")!r}')
    gates = sorted(name for name in names if name.startswith(GATE_PREFIX))
    check(f'{label}:gate_leaves', len(gates) >= 2, f'{gates}')
    for name in gates:
        node = by_name[name]
        translation = node.get('translation', [])
        delta = max((abs(a - b) for (a, b) in zip(translation, HINGE_GAME)), default=9e9)
        check(f'{label}:gate_translation:{name}',
              len(translation) == 3 and delta <= 1e-6,
              f'translation={translation} want={list(HINGE_GAME)}')
        # hinge-local geometry: the mesh must NOT be centred on the world origin
        mesh = document['meshes'][node['mesh']]
        bounds = mesh['primitives'][0]['attributes']['POSITION']
        low = document['accessors'][bounds]['min']
        high = document['accessors'][bounds]['max']
        centre = [(a + b) / 2 for (a, b) in zip(low, high)]
        check(f'{label}:gate_hinge_local:{name}',
              max(abs(c - h) for (c, h) in zip(centre, HINGE_GAME)) < 0.35,
              f'mesh centre {centre} (hinge-relative)')
    extra_children = [names[i] for i in by_name.get('extra', {}).get('children', [])]
    check(f'{label}:extra_children',
          len(extra_children) == len(gates) and set(extra_children) == set(gates),
          f'{extra_children} (contract: the breech gate leaves only)')
    for marker in MARKERS:
        node = by_name.get(marker, {})
        want = ANCHORS[marker]
        # node translation is game space; ANCHORS are authoring space
        want_game = (want[0], want[2], -want[1])
        got = node.get('translation', [])
        delta = max((abs(a - b) for (a, b) in zip(got, want_game)), default=9e9)
        check(f'{label}:anchor:{marker}', len(got) == 3 and delta <= 1e-5,
              f'got {got} want {list(want_game)}')
    scales = [(node.get('name', ''), node.get('scale')) for node in nodes
              if node.get('scale') is not None]
    bad_scales = [f'{name}={scale}' for (name, scale) in scales
                  if any(component <= 0 for component in scale)]
    check(f'{label}:node_scales', not bad_scales, f'{len(scales)} explicit scales, negative: {bad_scales}')

    # UV references and accessor sanity on every primitive.
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
    part_materials = set()
    textured = 0
    mapped = {}
    for material in materials:
        extras = material.get('extras', {})
        key = extras.get('partMaterial') or material.get('name', '').split(' | ')[-1]
        if key:
            part_materials.add(re.sub(r'\.\d+$', '', key))
        library = extras.get('textureLibrary')
        if library:
            bump = extras.get('textureBumpScale', 0)
            mapped[library] = bump
        if 'baseColorTexture' in material.get('pbrMetallicRoughness', {}):
            textured += 1
    check(f'{label}:material_names', part_materials == EXPECTED_MATERIALS,
          f'{sorted(part_materials)}')
    check(f'{label}:texture_library',
          set(mapped) == PALETTE_IMAGES and all(bump > 0 for bump in mapped.values()),
          f'{len(mapped)} palette materials {sorted(mapped.items())}')
    images = document.get('images', [])
    stems = {Path(image.get('uri', image.get('name', ''))).stem for image in images}
    check(f'{label}:images_embedded', PALETTE_IMAGES <= stems and textured == 6,
          f'{len(images)} images {sorted(stems)} for {textured} textured materials')
    for material in materials:
        pbr = material.get('pbrMetallicRoughness', {})
        texture = pbr.get('baseColorTexture')
        if texture is not None:
            source = document['textures'][texture['index']]['source']
            check(f'{label}:image_reference:{material["name"]}',
                  source < len(images), f'texture source {source}')
    draws = sum(len(mesh.get('primitives', [])) for mesh in document.get('meshes', []))
    check(f'{label}:primitive_budget', draws <= 24, f'{draws} primitives (budget 24)')
    triangles = 0
    for mesh in document.get('meshes', []):
        for primitive in mesh.get('primitives', []):
            triangles += document['accessors'][primitive['indices']]['count'] // 3
    check(f'{label}:triangle_budget', 8000 <= triangles <= 20000,
          f'{triangles} tris (budget 8k-20k)')
    measured[f'{label}:draws'] = draws
    measured[f'{label}:triangles'] = triangles


def import_checks(label, path):
    """Geometry checks on a fresh Blender import of the delivered file."""
    imported = import_gltf(path)
    measured[f'{label}:imported_objects'] = sorted(o.name for o in imported)
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
    band_r, band_n = 0.0, 0
    tip_y = -1e9
    extent = [[1e9, -1e9] for _ in range(3)]
    nonfinite, negative_volume = [], []
    for obj in meshes:
        mesh = obj.data
        mesh.calc_loop_triangles()
        triangles += len(mesh.loop_triangles)
        volume = 0.0
        for vertex in mesh.vertices:
            point = obj.matrix_world @ vertex.co
            for axis in range(3):
                extent[axis][0] = min(extent[axis][0], point[axis])
                extent[axis][1] = max(extent[axis][1], point[axis])
                if not math.isfinite(point[axis]):
                    nonfinite.append(f'{obj.name}:{vertex.index}')
            tip_y = max(tip_y, point[1])
            if HEAT_BAND[0] - 1e-9 <= point[1] <= HEAT_BAND[1] + 1e-9:
                band_n += 1
                band_r = max(band_r, math.hypot(point[0], point[2] - 0.075))
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
    check(f'{label}:muzzle_tip', 0.778 <= tip_y <= 0.800,
          f'forward-most vertex y={tip_y:.5f} (muzzle plane 0.780, seated nose <= 0.02 proud)')
    check(f'{label}:heat_band_radius', band_n > 0 and abs(band_r - BORE_R) < 1e-3,
          f'max radius in band {band_r:.5f} over {band_n} verts (contract 0.0620)')
    mats = {m for o in meshes for m in o.data.materials if m}
    check(f'{label}:material_budget', len(mats) <= 8,
          f'{len(mats)} materials: {sorted(m.name for m in mats)}')
    images = {i.name for i in bpy.data.images
              if i.users and i.name not in {'Render Result', 'Viewer Node'}}
    stems = {Path(name).stem for name in images}
    check(f'{label}:material_images', PALETTE_IMAGES <= stems,
          f'{len(images)} images: {sorted(images)}')


for (label, path) in (('glb', GLB), ('gltf', GLTF)):
    if not path.exists():
        check(f'{label}:file', False, f'{path} MISSING')
        continue
    check(f'{label}:file', True, f'{path} ({path.stat().st_size} bytes)')
    document_checks(label, read_document(path))
    import_checks(label, path)

report = {'asset': 'TORCH', 'glb': str(GLB), 'gltf': str(GLTF),
          'passed': not failures, 'failures': failures, 'advisory': advisory,
          'measured': measured}
OUT.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': report['passed'], 'failures': failures,
                  'advisory': advisory}, indent=2))
if failures:
    raise SystemExit(f'TORCH validation failed: {len(failures)} failures')
print('TORCH-VALIDATION-PASSED')
