#!/usr/bin/env python3
"""Independently validate the SKIPJACK delivery by re-importing it fresh.

Usage:
    blender --background --factory-startup --python tools/blender/skipjack/validate-skipjack.py

Fresh-import checks of the portable GLB and the browser glTF against the frozen
GL-3 SKIPJACK runtime contract: exactly nine top-level nodes (the five runtime
groups plus the four gameplay mount markers at their frozen anchors), merged
`<part> | <key>` batches carrying blenderAsset/part/skipjack_material extras,
the three `mag | round N` batches with ammoRound 1..3 and runtime round names
(/round[ _-]*([1-3])(?:\\b|[ _|-])/i), UVs on every mesh, outward normals
(positive signed volume per batch), the muzzle tip at game (0, 0.075, -0.782),
translation-only node chains, finite coordinates, material key names, and the
draw / triangle / material budgets (fail above 32 draws, 26,000 triangles or 10
material batches; advisory above 26 draws / 20,000 triangles).

Writes docs/design/blender/skipjack/validation.json with the shared schema
{asset, glb, gltf, passed, failures, advisory, measured}. With
VB_SKIPJACK_SMOKE_ROOT set the report lands under that root (reads stay on the
delivered files) so development runs never touch delivered docs.

Exits non-zero when failures were found (run blender with --python-exit-code 1
to gate a pipeline on this).
"""
import json
import math
import os
import re
import struct
import sys
from pathlib import Path

import bpy

HERE = Path(__file__).resolve()
ROOT = HERE.parents[3]
SLUG = 'skipjack'
ASSET = 'SKIPJACK'
DEFAULT_GLB = ROOT / 'docs/design/blender/skipjack/skipjack.glb'
DEFAULT_GLTF = ROOT / 'public/assets/blender/skipjack.gltf'
DEFAULT_JSON = ROOT / 'docs/design/blender/skipjack/validation.json'

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
GLB = Path(argv[0]) if len(argv) > 0 else DEFAULT_GLB
GLTF = Path(argv[1]) if len(argv) > 1 else DEFAULT_GLTF
OUT = Path(argv[2]) if len(argv) > 2 else DEFAULT_JSON


def out_path(path):
    """Route writes under VB_SKIPJACK_SMOKE_ROOT when developing."""
    smoke = os.environ.get('VB_SKIPJACK_SMOKE_ROOT')
    if not smoke:
        return path
    root = Path(smoke)
    if not root.is_absolute():
        root = ROOT / root
    try:
        return root / path.relative_to(ROOT)
    except ValueError:
        return root / path.name


GROUP_NAMES = ('body', 'mag', 'bolt', 'trigger', 'extra')
MARKERS = ('muzzle', 'grip', 'support', 'sight')
TOP_LEVEL = set(GROUP_NAMES) | set(MARKERS)
MATERIAL_KEYS = ('gunmetal', 'machined steel', 'olive drab', 'dark polymer',
                 'rubber', 'orange paint', 'brass', 'phosphor', 'optic glass')
ROUND_MATERIAL = 'round colors'
EXPECTED_MATERIALS = set(MATERIAL_KEYS) | {ROUND_MATERIAL}
ANCHORS = {  # authoring space: +Y forward, +Z up
    'muzzle': (0.0, 0.782, 0.075),
    'grip': (0.047, 0.056, -0.203),
    'support': (-0.058, 0.373, -0.184),
    'sight': (0.0, 0.332, 0.291),
}
MUZZLE_GAME = (0.0, 0.075, -0.782)  # authoring (0, 0.782, 0.075) via game=(x, z, -y)
MARKER_ROLE = 'gameplay mount marker'
# Verbatim from public/js/guns/models/skipjack.js: the runtime maps rounds to
# the three round groups purely by mesh name, so delivered names must match.
ROUND_NAME = re.compile(r'round[ _-]*([1-3])(?:\b|[ _|-])', re.IGNORECASE)
ROUND_KEY = re.compile(r'round[ _-]*([1-3])$', re.IGNORECASE)
BATCH_NAME = re.compile(r'^([^|]+?) \| (.+)$')

MAX_DRAWS, MAX_TRIANGLES, MAX_MATERIALS = 32, 26000, 10
TARGET_DRAWS, TARGET_TRIANGLES = 26, 20000

failures, advisory, measured = [], [], {}


def check(name, ok, detail):
    measured[name] = detail
    if not ok:
        failures.append(f'{name}: {detail}')


def material_key(name):
    key = name.rsplit(' | ', 1)[-1].strip().lower()
    return re.sub(r'\.\d+$', '', key)


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


def node_children(document, node):
    nodes = document.get('nodes', [])
    return [nodes[i] for i in node.get('children', [])]


def mesh_material_keys(document, node):
    if 'mesh' not in node:
        return set()
    mesh = document.get('meshes', [])[node['mesh']]
    materials = document.get('materials', [])
    keys = set()
    for primitive in mesh.get('primitives', []):
        index = primitive.get('material')
        keys.add(material_key(materials[index].get('name', '')) if index is not None else '')
    return keys


def batch_checks(label, document, part, node):
    """Naming + extras contract for one merged batch under a runtime group."""
    name = node.get('name', '')
    match = BATCH_NAME.match(name)
    base, key = (match.group(1), match.group(2)) if match else ('', '')
    extras = node.get('extras', {})
    round_match = ROUND_KEY.match(key) if part == 'mag' else None

    if round_match:
        number = int(round_match.group(1))
        runtime_match = ROUND_NAME.search(name)
        check(f'{label}:round_name:{name}',
              runtime_match is not None and runtime_match.group(1) == str(number),
              f'{name!r} must match /round[ _-]*([1-3])(?:\\b|[ _|-])/i as round {number}')
        mesh = document.get('meshes', [])[node['mesh']] if 'mesh' in node else {}
        mesh_match = ROUND_NAME.search(mesh.get('name', ''))
        check(f'{label}:round_mesh_name:{name}',
              mesh_match is not None and mesh_match.group(1) == str(number),
              f'mesh {mesh.get("name")!r} must name round {number} for the runtime sorter')
        check(f'{label}:round_extras:{name}',
              extras.get('blenderAsset') == SLUG and extras.get('part') == 'mag'
              and extras.get('ammoRound') == number,
              f'extras={extras} (want blenderAsset={SLUG!r}, part="mag", ammoRound={number})')
        check(f'{label}:round_material:{name}',
              mesh_material_keys(document, node) == {ROUND_MATERIAL},
              f'material keys {sorted(mesh_material_keys(document, node))} '
              f'(want {ROUND_MATERIAL!r}; RoundColor layer rides this material)')
        return f'round {number}'

    check(f'{label}:batch_name:{name}', base == part and key in MATERIAL_KEYS,
          f'{name!r} (want "<{part}> | <material key>")')
    check(f'{label}:batch_extras:{name}',
          extras.get('blenderAsset') == SLUG and extras.get('part') == part
          and extras.get('skipjack_material') == key,
          f'extras={extras} (want blenderAsset={SLUG!r}, part={part!r}, '
          f'skipjack_material={key!r})')
    check(f'{label}:batch_material:{name}',
          mesh_material_keys(document, node) == {key},
          f'material keys {sorted(mesh_material_keys(document, node))} (want {key!r})')
    return key


def document_checks(label, document):
    """Node-contract checks straight off the glTF JSON (the authoritative tree)."""
    nodes = document.get('nodes', [])
    names = [node.get('name', '') for node in nodes]
    by_name = {node.get('name', ''): node for node in nodes}
    check(f'{label}:node_names_unique', len(names) == len(set(names)),
          f'{len(names)} nodes: {sorted(names)}')

    scenes = document.get('scenes', [])
    top = [nodes[i].get('name', '') for i in scenes[0].get('nodes', [])] if scenes else []
    check(f'{label}:top_level_nodes', set(top) == TOP_LEVEL and len(top) == 9,
          f'{len(top)} top-level nodes: {sorted(top)}')

    bad_transforms = [f'{node.get("name", "?")}:{key}={node[key]}'
                      for node in nodes for key in ('rotation', 'scale', 'matrix')
                      if key in node]
    check(f'{label}:translation_only_chain', not bad_transforms,
          f'{len(bad_transforms)} rotation/scale/matrix entries: {bad_transforms[:6]}')

    for marker in MARKERS:
        node = by_name.get(marker, {})
        want = ANCHORS[marker]
        want_game = (want[0], want[2], -want[1])  # node translations are game space
        got = node.get('translation', [])
        delta = max((abs(a - b) for (a, b) in zip(got, want_game)), default=9e9)
        check(f'{label}:anchor:{marker}', len(got) == 3 and delta <= 1e-5,
              f'translation={got} want={list(want_game)} (tol 1e-5)')
        check(f'{label}:marker_role:{marker}',
              node.get('extras', {}).get('role') == MARKER_ROLE,
              f'extras={node.get("extras", {})} (want role={MARKER_ROLE!r})')
        check(f'{label}:marker_empty:{marker}', 'mesh' not in node and not node.get('children'),
              f'mesh={node.get("mesh")} children={node.get("children", [])}')

    round_batches, batch_keys = {}, {}
    for part in GROUP_NAMES:
        node = by_name.get(part, {})
        check(f'{label}:group:{part}', node and 'mesh' not in node,
              'empty present' if node and 'mesh' not in node else f'node={node}')
        for child in node_children(document, node):
            resolved = batch_checks(label, document, part, child)
            if resolved.startswith('round '):
                round_batches[child.get('name', '')] = resolved
            else:
                batch_keys.setdefault(part, []).append(resolved)
    check(f'{label}:round_batches',
          set(round_batches) == {f'mag | round {n}' for n in (1, 2, 3)}
          and sorted(round_batches.values()) == ['round 1', 'round 2', 'round 3'],
          f'{dict(sorted(round_batches.items()))} (want mag | round 1..3 with ammoRound 1..3)')
    measured[f'{label}:batches'] = {part: sorted(keys)
                                    for part, keys in sorted(batch_keys.items())}

    materials = document.get('materials', [])
    keys = {material_key(material.get('name', '')) for material in materials}
    check(f'{label}:material_names', keys <= EXPECTED_MATERIALS,
          f'{sorted(keys)} (suffix must be one of {sorted(EXPECTED_MATERIALS)})')
    check(f'{label}:material_budget', len(materials) <= MAX_MATERIALS,
          f'{len(materials)} material batches (fail above {MAX_MATERIALS}: '
          f'nine palette keys + {ROUND_MATERIAL!r})')
    measured[f'{label}:materials'] = sorted(material.get('name', '') for material in materials)

    accessors = document.get('accessors', [])
    missing_uv, mismatched, nonfinite = [], [], []
    draws = 0
    triangles = 0
    for mesh in document.get('meshes', []):
        name = mesh.get('name', '?')
        for primitive in mesh.get('primitives', []):
            draws += 1
            attributes = primitive.get('attributes', {})
            position = accessors[attributes['POSITION']]
            indices = primitive.get('indices')
            triangles += (accessors[indices]['count'] if indices is not None
                          else position['count']) // 3
            if 'TEXCOORD_0' not in attributes:
                missing_uv.append(name)
            elif accessors[attributes['TEXCOORD_0']]['count'] != position['count']:
                mismatched.append(f'{name}: uv {accessors[attributes["TEXCOORD_0"]]["count"]}'
                                  f' != position {position["count"]}')
            for index in list(attributes.values()) + ([indices] if indices is not None else []):
                accessor = accessors[index]
                if 'min' in accessor and any(not math.isfinite(v)
                                             for v in accessor['min'] + accessor['max']):
                    nonfinite.append(f'{name}: accessor bounds')
    check(f'{label}:uv_references', not missing_uv and not mismatched,
          f'missing={sorted(set(missing_uv))} mismatched={mismatched}')
    check(f'{label}:accessor_bounds_finite', not nonfinite, f'{nonfinite[:5]}')

    check(f'{label}:draw_budget', draws <= MAX_DRAWS,
          f'{draws} draws (merged batches; fail above {MAX_DRAWS})')
    if draws > TARGET_DRAWS:
        advisory.append(f'{label}:draws {draws} above redo target {TARGET_DRAWS}')
    check(f'{label}:triangle_budget', triangles <= MAX_TRIANGLES,
          f'{triangles} triangles (fail above {MAX_TRIANGLES})')
    if triangles > TARGET_TRIANGLES:
        advisory.append(f'{label}:triangles {triangles} above redo target {TARGET_TRIANGLES}')
    measured[f'{label}:draws'] = draws
    measured[f'{label}:triangles'] = triangles


def import_checks(label, path):
    """Geometry checks on a fresh Blender import of the delivered file."""
    imported = import_gltf(path)
    measured[f'{label}:imported_objects'] = sorted(o.name for o in imported)
    by_name = {}
    for obj in imported:
        by_name.setdefault(obj.name.split('.')[0], obj)

    for marker in MARKERS:
        obj = by_name.get(marker)
        check(f'{label}:import_marker:{marker}', obj is not None,
              'present' if obj is not None else 'MISSING')
        if obj is None:
            continue
        want = ANCHORS[marker]  # the importer lands world translations in authoring space
        got = tuple(obj.matrix_world.translation)
        err = max(abs(a - b) for (a, b) in zip(got, want))
        check(f'{label}:import_anchor:{marker}', err < 2e-3,
              f'got {tuple(round(v, 5) for v in got)} want {want} (tol 2e-3)')

    # Translation-only chains import with one shared linear part (the axis
    # conversion) and no per-object scale or rotation.
    linears = [o.matrix_world.to_3x3() for o in imported]
    spread = 0.0
    if linears:
        for linear in linears[1:]:
            spread = max(spread, max(abs(linear[r][c] - linears[0][r][c])
                                     for r in range(3) for c in range(3)))
    scales = {tuple(round(v, 6) for v in o.scale) for o in imported}
    check(f'{label}:import_chain_translation_only',
          spread <= 1e-6 and scales == {(1.0, 1.0, 1.0)},
          f'linear-part spread {spread:.2e}, object scales {sorted(scales)}')

    meshes = [o for o in imported if o.type == 'MESH']
    triangles = 0
    nonfinite, negative_volume, missing_uv = [], [], []
    game_points = []
    extent = [[1e9, -1e9] for _ in range(3)]
    for obj in meshes:
        mesh = obj.data
        if not mesh.uv_layers:
            missing_uv.append(obj.name)
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
            game_points.append((point.x, point.z, -point.y))
        for triangle in mesh.loop_triangles:
            (a, b, c) = (obj.matrix_world @ mesh.vertices[i].co for i in triangle.vertices)
            volume += a.dot(b.cross(c)) / 6.0
        if volume <= 0:
            negative_volume.append(f'{obj.name} ({volume * 1e6:.1f} cm3)')
    check(f'{label}:import_uv_layers', not missing_uv,
          f'{len(meshes)} meshes, no UVs: {sorted(set(missing_uv))}')
    check(f'{label}:nonfinite_coordinates', not nonfinite, f'{nonfinite[:5]}')
    check(f'{label}:inward_surfaces', not negative_volume,
          f'{negative_volume} (signed volume must face outward)')

    if game_points:
        tip_z = min(p[2] for p in game_points)
        band = [p for p in game_points if p[2] <= tip_z + 2e-3]
        centre_x = sum(p[0] for p in band) / len(band)
        centre_y = sum(p[1] for p in band) / len(band)
        plane_err = abs(tip_z - MUZZLE_GAME[2])
        axis_err = max(abs(centre_x - MUZZLE_GAME[0]), abs(centre_y - MUZZLE_GAME[1]))
        check(f'{label}:muzzle_tip', max(plane_err, axis_err) <= 2e-3,
              f'forward-most geometry z={tip_z:.5f} (err {plane_err:.5f}), '
              f'tip centre ({centre_x:.5f}, {centre_y:.5f}) over {len(band)} verts '
              f'(axis err {axis_err:.5f}); want game {MUZZLE_GAME} within 2e-3')
    else:
        tip_z, (centre_x, centre_y), band = 0.0, (0.0, 0.0), []
        check(f'{label}:muzzle_tip', False, 'no geometry to locate a muzzle tip')

    mats = {m for o in meshes for m in o.data.materials if m}
    check(f'{label}:import_material_budget', len(mats) <= MAX_MATERIALS,
          f'{len(mats)} materials: {sorted(m.name for m in mats)}')
    measured[f'{label}:import_triangles'] = triangles
    measured[f'{label}:bounds_authoring'] = [[round(v, 5) for v in axis] for axis in extent]
    measured[f'{label}:muzzle_tip'] = {
        'forward_game_z': round(tip_z, 5),
        'tip_centre_xy': [round(centre_x, 5), round(centre_y, 5)],
        'band_vertices': len(band),
    }


for (label, path) in (('glb', GLB), ('gltf', GLTF)):
    if not path.exists():
        check(f'{label}:file', False, f'{path} MISSING')
        continue
    check(f'{label}:file', True, f'{path} ({path.stat().st_size} bytes)')
    document_checks(label, read_document(path))
    import_checks(label, path)

report = {'asset': ASSET, 'glb': str(GLB), 'gltf': str(GLTF),
          'passed': not failures, 'failures': failures, 'advisory': advisory,
          'measured': measured}
out_file = out_path(OUT)
out_file.parent.mkdir(parents=True, exist_ok=True)
out_file.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': report['passed'], 'failures': failures,
                  'advisory': advisory}, indent=2))
print(f'VALIDATION_REPORT {out_file}')
if failures:
    raise SystemExit(f'SKIPJACK validation failed: {len(failures)} failures')
print('SKIPJACK-VALIDATION-PASSED')
