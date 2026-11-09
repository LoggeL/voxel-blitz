#!/usr/bin/env python3
"""Independently validate the VANGUARD delivery by re-importing it fresh.

Run headless: Blender --background --factory-startup --python-exit-code 1
--python tools/blender/vanguard/validate-vanguard.py
Checks nodes/markers/anchors/bounds/UV/embedded images and budgets
(<=30k tris / <=25 draws / >60% textured) straight off the glTF JSON,
then re-imports GLB + glTF into Blender for geometry checks.
"""
import json
import math
import struct
import sys
from pathlib import Path

import bpy

HERE = Path(__file__).resolve()
ROOT = HERE.parents[3]
DEFAULT_GLB = ROOT / 'docs/design/blender/vanguard/vanguard.glb'
DEFAULT_GLTF = ROOT / 'public/assets/blender/vanguard.gltf'
DEFAULT_JSON = ROOT / 'docs/design/blender/vanguard/validation.json'

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
GLB = Path(argv[0]) if len(argv) > 0 else DEFAULT_GLB
GLTF = Path(argv[1]) if len(argv) > 1 else DEFAULT_GLTF
OUT = Path(argv[2]) if len(argv) > 2 else DEFAULT_JSON

PARTS = ('body', 'bolt', 'trigger', 'mag', 'optic')
MARKERS = ('muzzle', 'sight', 'grip', 'support')
EXPECTED_MUZZLE = [0.0, 0.041, -0.64]
EXPECTED_SIGHT_HEIGHT = 0.15
EXPECTED_TEXTURES = {'vanguard-graphite', 'vanguard-polymer', 'machined-steel', 'pebbled-rubber'}

failures, advisory, measured = [], [], {}


def check(name, ok, detail):
    measured[name] = detail
    if not ok:
        failures.append(f'{name}: {detail}')


def read_document(path):
    raw = path.read_bytes()
    if raw[:4] == b'glTF':
        chunk_len, chunk_type = struct.unpack('<II', raw[12:20])
        assert chunk_type == 0x4E4F534A, 'GLB JSON chunk missing'
        return json.loads(raw[20:20 + chunk_len].decode('utf-8'))
    return json.loads(raw.decode('utf-8'))


def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.cameras, bpy.data.lights):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def import_gltf(path):
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(path))
    return list(bpy.context.scene.objects)


def document_checks(label, document):
    nodes = document.get('nodes', [])
    names = [node.get('name', '') for node in nodes]
    check(f'{label}:node_names_unique', len(names) == len(set(names)),
          f'{len(names)} nodes: {sorted(names)}')
    by_name = {node.get('name', ''): node for node in nodes}
    for part in PARTS:
        check(f'{label}:node:{part}', part in by_name,
              'present' if part in by_name else 'MISSING')
        extras = by_name.get(part, {}).get('extras', {})
        check(f'{label}:blenderAsset:{part}', extras.get('blenderAsset') == 'vanguard',
              f'extras.blenderAsset={extras.get("blenderAsset")!r}')
        children = [names[i] for i in by_name.get(part, {}).get('children', [])]
        check(f'{label}:part_children:{part}', len(children) > 0, f'{children}')
    contract = document.get('asset', {}).get('extras', {}).get('contract', {})
    _mz = contract.get('muzzle') or []
    check(f'{label}:contract_muzzle', len(_mz) == 3 and max(abs(a - b) for a, b in zip(_mz, EXPECTED_MUZZLE)) < 1e-5,
          f'muzzle={contract.get("muzzle")} want={EXPECTED_MUZZLE}')
    check(f'{label}:contract_sightHeight', abs(contract.get('sightHeight', 0) - EXPECTED_SIGHT_HEIGHT) < 1e-6,
          f'sightHeight={contract.get("sightHeight")}')
    scales = [(node.get('name', ''), node.get('scale')) for node in nodes if node.get('scale') is not None]
    bad_scales = [f'{name}={scale}' for (name, scale) in scales if any(c <= 0 for c in scale)]
    check(f'{label}:node_scales', not bad_scales, f'{len(scales)} explicit scales, negative: {bad_scales}')

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
                if 'min' in accessor and any(not math.isfinite(v) for v in accessor['min'] + accessor['max']):
                    nonfinite.append(f'{name}: accessor bounds')
    check(f'{label}:uv_references', not missing_uv and not mismatched,
          f'missing={missing_uv} mismatched={mismatched}')
    check(f'{label}:accessor_bounds_finite', not nonfinite, f'{nonfinite}')

    draws = sum(len(mesh.get('primitives', [])) for mesh in document.get('meshes', []))
    triangles = 0
    textured_tris = 0
    for mesh in document.get('meshes', []):
        for primitive in mesh.get('primitives', []):
            count = document['accessors'][primitive['indices']]['count'] // 3
            triangles += count
            mat = document['materials'][primitive['material']]
            if 'baseColorTexture' in mat.get('pbrMetallicRoughness', {}):
                textured_tris += count
    check(f'{label}:draw_budget', draws <= 25, f'{draws} draws (budget 25)')
    check(f'{label}:triangle_budget', triangles <= 30000, f'{triangles} tris (budget 30000)')
    fraction = textured_tris / triangles if triangles else 0
    check(f'{label}:textured_fraction', fraction > 0.6, f'{textured_tris}/{triangles} = {fraction:.3f} (>0.6)')
    measured[f'{label}:draws'] = draws
    measured[f'{label}:triangles'] = triangles
    measured[f'{label}:textured_fraction'] = round(fraction, 4)

    materials = document.get('materials', [])
    textured = sum(1 for m in materials if 'baseColorTexture' in m.get('pbrMetallicRoughness', {}))
    libraries = {m.get('extras', {}).get('textureLibrary') for m in materials if m.get('extras', {}).get('textureLibrary')}
    check(f'{label}:texture_library_keys', EXPECTED_TEXTURES <= libraries,
          f'libraries={sorted(libraries)} for {textured} textured materials')
    images = document.get('images', [])
    stems = {Path(image.get('uri', image.get('name', ''))).stem for image in images}
    check(f'{label}:images_present', EXPECTED_TEXTURES <= stems,
          f'{len(images)} images {sorted(stems)}')
    embedded = sum(1 for image in images if 'bufferView' in image)
    if label == 'glb':
        check(f'{label}:images_embedded', embedded == len(images) and len(images) > 0,
              f'{embedded}/{len(images)} embedded')
    else:
        check(f'{label}:images_uri', all(image.get('uri') for image in images) and len(images) > 0,
              f'{len(images)} uri images')
    for material in materials:
        pbr = material.get('pbrMetallicRoughness', {})
        texture = pbr.get('baseColorTexture')
        if texture is not None:
            source = document['textures'][texture['index']]['source']
            check(f'{label}:image_reference:{material["name"]}', source < len(images),
                  f'texture source {source}')


def import_checks(label, path):
    imported = import_gltf(path)
    measured[f'{label}:imported_objects'] = sorted(o.name for o in imported)
    meshes = [o for o in imported if o.type == 'MESH']
    triangles = 0
    extent = [[1e9, -1e9] for _ in range(3)]
    nonfinite = []
    for obj in meshes:
        mesh = obj.data
        mesh.calc_loop_triangles()
        triangles += len(mesh.loop_triangles)
        for vertex in mesh.vertices:
            point = obj.matrix_world @ vertex.co
            for axis in range(3):
                extent[axis][0] = min(extent[axis][0], point[axis])
                extent[axis][1] = max(extent[axis][1], point[axis])
                if not math.isfinite(point[axis]):
                    nonfinite.append(f'{obj.name}:{vertex.index}')
    check(f'{label}:nonfinite_coordinates', not nonfinite, f'{nonfinite[:5]}')
    measured[f'{label}:import_triangles'] = triangles
    measured[f'{label}:import_bounds'] = [[round(v, 5) for v in axis] for axis in extent]
    check(f'{label}:import_triangles_budget', triangles <= 30000, f'{triangles} tris (budget 30000)')
    names = {o.name.split('.')[0].split('_')[0] for o in imported}
    for part in PARTS:
        present = any(o.name.split('.')[0].startswith(part) for o in imported)
        check(f'{label}:import_part:{part}', present, 'present' if present else 'MISSING')
    mats = {m for o in meshes for m in o.data.materials if m}
    check(f'{label}:material_budget', len(mats) <= 12, f'{len(mats)} materials: {sorted(m.name for m in mats)}')


for (label, path) in (('glb', GLB), ('gltf', GLTF)):
    if not path.exists():
        check(f'{label}:file', False, f'{path} MISSING')
        continue
    check(f'{label}:file', True, f'{path} ({path.stat().st_size} bytes)')
    document_checks(label, read_document(path))
    import_checks(label, path)

report = {'asset': 'VANGUARD', 'glb': str(GLB), 'gltf': str(GLTF),
          'passed': not failures, 'failures': failures, 'advisory': advisory,
          'measured': measured}
OUT.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': report['passed'], 'failures': failures,
                  'advisory': advisory}, indent=2))
if failures:
    raise SystemExit(f'VANGUARD validation failed: {len(failures)} failures')
print('VANGUARD-VALIDATION-PASSED')
