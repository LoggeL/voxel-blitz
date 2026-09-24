"""Write the browser-facing runtime glTF for SKIPJACK, plus .bin, portable GLB and manifests.

Run headless from the saved study source:

    blender --background --factory-startup docs/design/blender/skipjack/skipjack.blend \
        --python tools/blender/skipjack/export-game-assets.py

Produces public/assets/blender/skipjack.gltf + skipjack.bin against the frozen
node contract: exactly nine top-level nodes — the body/mag/bolt/trigger/extra
group empties and the muzzle/grip/support/sight gameplay mount markers — with
per-(part, material) merged batches named `<part> | <key>` and the three
vertex-coloured rounds merged as `mag | round 1..3` (the RoundColor layer is
preserved as COLOR_0; extras ammoRound = 1..3). Geometry is baked in game
space (game (x, y, z) = authoring (x, z, -y)); node chains stay
translation-only so the loader's "sum ancestor positions" flattening is exact.

Also writes docs/design/blender/skipjack/skipjack.glb (portable twin of the
same geometry), the public/assets/blender/manifest.json inventory row, and
docs/design/blender/skipjack/manifest.json at revision 13, then runs the shared
material finalizer (finish_asset) and the SKIPJACK ASSET_TINTS gltfTint pass
on both documents before re-saving the .blend.

Set VB_SKIPJACK_SMOKE_ROOT=<dir> to develop against a delivered study safely:
every output is written at <dir>/<repo-relative path> instead, finish_asset is
skipped (no shared material-library state is touched) and the .blend is not
re-saved.
"""
import json
import os
import re
import struct
import sys
from pathlib import Path
from mathutils import Matrix, Vector

import bpy

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / 'docs/design/blender/skipjack'
OUT = ROOT / 'public/assets/blender'
BLEND = DOCS / 'skipjack.blend'
SLUG = 'skipjack'
ASSET = 'SKIPJACK'

GROUPS = ['body', 'mag', 'bolt', 'trigger', 'extra']
MARKERS = ['muzzle', 'grip', 'support', 'sight']
MATERIAL_KEYS = ('gunmetal', 'machined steel', 'olive drab', 'dark polymer',
                 'rubber', 'orange paint', 'brass', 'phosphor', 'optic glass')
ROUND_MATERIAL = 'round colors'
UV_SCALE = 7.5  # texture tiles per metre; matches the authoring UV projection

# Frozen gameplay anchors in authoring space. The runtime reads them back from
# the marker node translations in game space (muzzle must sit on T.mgl.muzzle),
# so drift here must fail the export rather than ship a mis-aimed launcher.
ANCHORS = {'muzzle': (0, 0.782, 0.075),
           'grip': (0.041, 0.332, -0.112),
           'support': (-0.052, 0.478, 0.006),
           'sight': (0, 0.342, 0.216)}

# game_x = x, game_y = z, game_z = -y: a proper rotation, so normals map like
# positions and the flat normal matrix is this rotation itself.
GAME = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))

# Preserve surface detail and material contrast at first-person distance.
ASSET_TINTS = {
    'gunmetal': (.29, .31, .34), 'machined steel': (.42, .45, .48),
    'olive drab': (.34, .44, .29), 'dark polymer': (.48, .52, .56),
    'rubber': (.55, .57, .57), 'orange paint': (.82, .55, .34),
    'brass': (.76, .70, .50), 'phosphor': (.38, .78, .38),
}

REVIEW_VIEWS = ('right-side', 'muzzle', 'rear', 'top', 'ads', 'front-quarter', 'rear-quarter')

SMOKE_ROOT = None
_smoke = os.environ.get('VB_SKIPJACK_SMOKE_ROOT')
if _smoke:
    SMOKE_ROOT = Path(_smoke) if os.path.isabs(_smoke) else ROOT / _smoke


def out_path(relative):
    """Delivered path, redirected under VB_SKIPJACK_SMOKE_ROOT when set."""
    path = (SMOKE_ROOT / relative) if SMOKE_ROOT else (ROOT / relative)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


warnings = []


def warn(message):
    print(f'[skipjack-export] {message}', file=sys.stderr)
    warnings.append(message)


scene = next((s for s in bpy.data.scenes if s.name == f'{ASSET} | GL-3 grenade launcher study'),
             None) or next((s for s in bpy.data.scenes if s.name.startswith(ASSET)), None)
if scene is None:
    raise SystemExit(f'no {ASSET} scene in {BLEND}')


def stored_world(obj):
    """True world matrix from stored transforms: a reopened file may not
    refresh matrix_world, and authored parts ride translated group empties."""
    chain = []
    node = obj
    while node is not None:
        chain.append(node)
        node = node.parent
    world = Matrix.Identity(4)
    for node in reversed(chain):
        world = world @ node.matrix_parent_inverse @ Matrix.LocRotScale(
            node.location, node.rotation_euler.to_quaternion(), node.scale)
    return world


def find_empty(name):
    # A marker owned by another study in the same file would have picked up a
    # .001 suffix at authoring time; match the exact contract name first.
    return (next((o for o in scene.objects if o.name == name), None)
            or next((o for o in scene.objects if o.name.split('.')[0] == name), None))


def find_material(key):
    material = next((m for m in bpy.data.materials
                     if m.name.split('.')[0] == f'{ASSET} | {key}'), None)
    if material is None:
        raise SystemExit(f'missing material {ASSET} | {key}')
    return material


# --- anchor and group contracts ---------------------------------------------
marker_authoring = {}
marker_game = {}
for name in MARKERS:
    marker = find_empty(name)
    if marker is None:
        raise SystemExit(f'marker {name} missing from the {ASSET} scene')
    if marker.name != name:
        warn(f'marker {marker.name} exported under the contract name {name}')
    authoring = stored_world(marker).translation
    marker_authoring[name] = [round(float(v), 6) for v in authoring]
    game = GAME @ authoring
    expected = GAME @ Vector(ANCHORS[name])
    if any(abs(game[i] - expected[i]) > 1e-6 for i in range(3)):
        raise SystemExit(f'marker {name} drifted off the anchor contract: {list(game)}')
    marker_game[name] = game

for name in GROUPS:
    if find_empty(name) is None:
        warn(f'group empty {name} missing from the {ASSET} scene')


# --- gather authored parts ---------------------------------------------------
depsgraph = bpy.context.evaluated_depsgraph_get()
batches = {}
material_index = {}
material_order = []
material_meta = {}
source_parts = 0
stamped = []
uncolored = []
off_material = []
odd_round_names = []


def get_batch(bucket, colored):
    batch = batches.get(bucket)
    if batch is None:
        batch = {'vertices': [], 'indices': [], 'lookup': {}, 'colors': [] if colored else None}
        batches[bucket] = batch
    return batch


for obj in sorted(scene.objects, key=lambda o: o.name):
    if obj.type != 'MESH':
        continue
    if obj.get('blenderAsset') is not None:
        # Runtime-stamped duplicates from legacy/transitional builds (the old
        # Khronos-export merges); the frozen authoring input has no such meshes.
        stamped.append(obj.name)
        continue
    part = obj.get('part')
    if part not in GROUPS:
        continue
    key = obj.get('skipjack_material')
    if not isinstance(key, str) or not key:
        raise SystemExit(f'{obj.name} has no skipjack_material prop')
    source_parts += 1
    head, sep, _ = obj.name.partition(' | ')
    if sep and head in ('round 1', 'round 2', 'round 3'):
        round_number = int(head[-1])
    else:
        round_number = None
        if head.startswith('round '):
            odd_round_names.append(obj.name)
        if key not in MATERIAL_KEYS:
            raise SystemExit(f'{obj.name} uses unknown skipjack_material {key!r}')
    if round_number is not None:
        mat_key = ROUND_MATERIAL
        slot = obj.data.materials[0] if obj.data.materials else None
        if slot is None or slot.name.split('.')[0] != f'{ASSET} | {ROUND_MATERIAL}':
            off_material.append(obj.name)
    else:
        mat_key = key
    if mat_key not in material_index:
        material_index[mat_key] = len(material_order)
        material_meta[mat_key] = find_material(mat_key)
        material_order.append(mat_key)
    world = stored_world(obj)
    linear = GAME @ world.to_3x3()
    normal_matrix = linear.inverted().transposed()
    offset = GAME @ world.translation
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    if mesh.uv_layers.active is None:
        raise SystemExit(f'{obj.name} has no UV layer')
    if round_number is not None:
        target = get_batch(('rnd', round_number), True)
        colors = mesh.color_attributes.get('RoundColor')
        if colors is None:
            uncolored.append(obj.name)
        corner_colors = colors is not None and colors.domain == 'CORNER'
    else:
        target = get_batch(('mat', part, material_index[mat_key]), False)
        colors = None
        corner_colors = False
    for triangle in mesh.loop_triangles:
        polygon = mesh.polygons[triangle.polygon_index]
        dominant = max(range(3), key=lambda i: abs(polygon.normal[i]))
        (first, second) = [(1, 2), (0, 2), (0, 1)][dominant]
        for loop_index in triangle.loops:
            loop = mesh.loops[loop_index]
            coordinate = mesh.vertices[loop.vertex_index].co
            position = linear @ coordinate + offset
            normal = (normal_matrix @ mesh.corner_normals[loop_index].vector).normalized()
            # Analytic projection on final geometry, at the same constant
            # density the authoring script uses: the runtime glTF and the GLB
            # must agree, and neither may depend on modifier UV interpolation.
            uv = (coordinate[first] * UV_SCALE, coordinate[second] * UV_SCALE)
            vertex = (round(position[0], 6), round(position[1], 6), round(position[2], 6),
                      round(normal[0], 5), round(normal[1], 5), round(normal[2], 5),
                      round(uv[0], 6), round(uv[1], 6))
            if round_number is not None:
                if colors is None:
                    vertex += (255, 255, 255, 255)
                else:
                    entry = colors.data[loop_index if corner_colors else loop.vertex_index]
                    vertex += tuple(max(0, min(255, round(c * 255))) for c in entry.color)
            if vertex not in target['lookup']:
                target['lookup'][vertex] = len(target['vertices'])
                target['vertices'].append(vertex)
                if round_number is not None:
                    target['colors'].append(vertex[-4:])
            target['indices'].append(target['lookup'][vertex])
    evaluated.to_mesh_clear()

for part in GROUPS:
    if part != 'extra' and not any(b[0] == 'mat' and b[1] == part for b in batches):
        raise SystemExit(f'part {part} has no geometry')
for number in (1, 2, 3):
    if not batches.get(('rnd', number), {}).get('indices'):
        raise RuntimeError(f'missing geometry for round {number}')
if stamped:
    warn(f'excluding {len(stamped)} runtime-stamped meshes outside the authoring '
         f'contract ({", ".join(stamped[:3])}, ...)')
if uncolored:
    warn(f'{len(uncolored)} round parts carry no RoundColor layer '
         f'({"; ".join(uncolored[:3])}, ...); exporting white vertex colors')
if off_material:
    warn(f'{len(off_material)} round parts are not staged on {ASSET} | {ROUND_MATERIAL}')
if odd_round_names:
    warn(f'round names outside `round N | <finish>`: {", ".join(odd_round_names)}')


# --- material descriptors ----------------------------------------------------
def material_desc(key, material):
    shader = material.node_tree.nodes['Principled BSDF']
    base = shader.inputs['Base Color']
    tint = list(material.get('gltf_tint', ()))
    if tint:
        factor = [round(v, 4) for v in tint] + [1.0]
    elif base.is_linked:
        # Driven base colour (per-round RoundColor vertex colours): let COLOR_0
        # pass through untouched.
        factor = [1.0, 1.0, 1.0, 1.0]
    else:
        factor = [round(v, 4) for v in base.default_value]
    if 'Alpha' in shader.inputs and not shader.inputs['Alpha'].is_linked:
        factor[3] = round(float(shader.inputs['Alpha'].default_value), 4)
    pbr = {'baseColorFactor': factor,
           'metallicFactor': float(shader.inputs['Metallic'].default_value),
           'roughnessFactor': float(shader.inputs['Roughness'].default_value)}
    extras = {}
    if key == 'optic glass':
        # The loader disables depthWrite for lens materials flagged userData.glass.
        extras['glass'] = True
    entry = {'name': f'{ASSET} | {key}', 'pbrMetallicRoughness': pbr, 'extras': extras}
    if factor[3] < 1.0:
        entry['alphaMode'] = 'BLEND'
    return entry


materials = [material_desc(key, material_meta[key])
             for key in sorted(material_index, key=material_index.get)]

# --- glTF document -----------------------------------------------------------
document = {
    'asset': {'version': '2.0', 'generator': 'Voxel Blitz Blender runtime export'},
    'scene': 0,
    'scenes': [{'nodes': []}],
    'nodes': [], 'meshes': [], 'materials': materials,
    'buffers': [], 'bufferViews': [], 'accessors': [],
}
binary = bytearray()

PACK = {5126: 'f', 5125: 'I', 5121: 'B'}


def accessor(values, size, component, kind, target, bounds=False):
    while len(binary) % 4:
        binary.append(0)
    start = len(binary)
    binary.extend(struct.pack('<' + PACK[component] * len(values), *values))
    view = len(document['bufferViews'])
    document['bufferViews'].append({'buffer': 0, 'byteOffset': start,
                                    'byteLength': len(binary) - start, 'target': target})
    entry = {'bufferView': view, 'componentType': component,
             'count': len(values) // size, 'type': kind}
    if component != 5126:
        entry['normalized'] = component == 5121
    if bounds:
        entry['min'] = [min(values[i::size]) for i in range(size)]
        entry['max'] = [max(values[i::size]) for i in range(size)]
    document['accessors'].append(entry)
    return len(document['accessors']) - 1


def build_mesh(batch):
    attributes = {}
    for (key, low, high) in (('POSITION', 0, 3), ('NORMAL', 3, 6), ('TEXCOORD_0', 6, 8)):
        attributes[key] = accessor([value for vertex in batch['vertices']
                                    for value in vertex[low:high]],
                                   high - low, 5126, f'VEC{high - low}', 34962,
                                   key == 'POSITION')
    if batch['colors'] is not None:
        attributes['COLOR_0'] = accessor([value for color in batch['colors']
                                          for value in color],
                                         4, 5121, 'VEC4', 34962)
    indices = accessor(batch['indices'], 1, 5125, 'SCALAR', 34963)
    return attributes, indices


def add_node(name, primitives, extras=None, translation=None, children=None):
    index = len(document['nodes'])
    node = {'name': name, 'extras': extras or {}}
    if primitives is not None:
        node['mesh'] = len(document['meshes'])
        document['meshes'].append({'name': name, 'primitives': primitives})
    if translation is not None:
        node['translation'] = [round(float(v), 6) for v in translation]
    if children is not None:
        node['children'] = children
    document['nodes'].append(node)
    document['scenes'][0]['nodes'].append(index)
    return index


def pack_glb(doc, chunk):
    payload = json.dumps(doc, separators=(',', ':')).encode()
    while len(payload) % 4:
        payload += b' '
    chunk = bytes(chunk)
    while len(chunk) % 4:
        chunk += b'\x00'
    body = (struct.pack('<II', len(payload), 0x4E4F534A) + payload +
            struct.pack('<II', len(chunk), 0x004E4942) + chunk)
    return struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body


def unpack_glb(raw):
    offset = 12
    chunks = {}
    while offset < len(raw):
        length, kind = struct.unpack_from('<II', raw, offset)
        offset += 8
        chunks[kind] = raw[offset:offset + length]
        offset += length
    return json.loads(chunks[0x4E4F534A]), bytearray(chunks[0x004E4942])


draws = 0
triangles = 0
batch_rows = {}
for part in GROUPS:
    plan = [(f'{part} | {material_order[bucket[2]]}', bucket, bucket[2],
             {'blenderAsset': SLUG, 'part': part, 'skipjack_material': material_order[bucket[2]]})
            for bucket in sorted((b for b in batches if b[0] == 'mat' and b[1] == part),
                                 key=lambda b: b[2])]
    if part == 'mag':
        plan += [(f'mag | round {number}', ('rnd', number), material_index[ROUND_MATERIAL],
                  {'blenderAsset': SLUG, 'part': 'mag', 'ammoRound': number})
                 for number in (1, 2, 3)]
    children = []
    for name, bucket, material, extras in plan:
        batch = batches[bucket]
        attributes, indices = build_mesh(batch)
        document['meshes'].append({'name': name,
                                   'primitives': [{'attributes': attributes, 'indices': indices,
                                                   'material': material}]})
        document['nodes'].append({'name': name, 'mesh': len(document['meshes']) - 1,
                                  'extras': extras})
        children.append(len(document['nodes']) - 1)
        draws += 1
        count = len(batch['indices']) // 3
        triangles += count
        batch_rows[name] = count
    add_node(part, None, extras={'blenderAsset': SLUG}, children=children)

for name in MARKERS:
    # Marker nodes carry the only non-identity translations: game-space anchors
    # for the muzzle flash, hands and sight line.
    add_node(name, None, extras={'role': 'gameplay mount marker'}, translation=marker_game[name])

# Hard runtime gates first (fail before anything ships), then the redo targets.
if draws > 32:
    raise RuntimeError(f'{draws} material batches exceed the 32-draw asset budget')
if triangles > 26000:
    raise RuntimeError(f'{triangles} triangles exceed the 26k asset budget')
if draws > 26:
    warn(f'{draws} draws exceed the 26-draw redo target')
if triangles > 20000:
    warn(f'{triangles} triangles exceed the 20000-triangle redo target')

# --- runtime gltf + bin ------------------------------------------------------
document['buffers'] = [{'uri': f'{SLUG}.bin', 'byteLength': len(binary)}]
bin_path = out_path(f'public/assets/blender/{SLUG}.bin')
gltf_path = out_path(f'public/assets/blender/{SLUG}.gltf')
bin_path.write_bytes(binary)
gltf_path.write_text(json.dumps(document, separators=(',', ':')) + '\n')

# --- manifest row (the skipjack entry only) ----------------------------------
manifest_path = out_path('public/assets/blender/manifest.json')
manifest = json.loads((OUT / 'manifest.json').read_text())
entry = {'asset': SLUG, 'source_parts': source_parts,
         'draws': draws, 'triangles': triangles, 'geometry_bytes': len(binary)}
assets = [a for a in manifest['assets'] if a['asset'] != SLUG]
assets.append(entry)
assets.sort(key=lambda a: a['asset'])
manifest['assets'] = assets
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')

# --- portable all-in-one GLB of the same geometry ----------------------------
glb_path = out_path(f'docs/design/blender/{SLUG}/{SLUG}.glb')
portable = json.loads(json.dumps(document))
portable['buffers'] = [{'byteLength': len(binary)}]
glb_path.write_bytes(pack_glb(portable, binary))


def smoke_material_record():
    """Read-only stand-in for finish_asset's material-library.json record; smoke
    mode must never touch shared material-library state."""
    config = json.loads(
        (ROOT / 'docs/design/blender/material-library/materials.json').read_text())
    applied = []
    for material in sorted({m for obj in scene.objects if obj.type == 'MESH'
                            for m in obj.data.materials if m}, key=lambda m: m.name):
        label = re.sub(r'\.\d+$', '', material.name.split(' | ')[-1]).strip().lower()
        key = ({'olive drab': 'skipjack-olive-armor',
                'gunmetal': 'skipjack-dark-steel'}.get(label)
               or config['assignment'].get(label))
        if key:
            applied.append({'material': material.name, 'texture': key})
    return {'version': config['version'], 'asset': SLUG, 'materials': applied}, applied


# --- shared material finalizer (skipped under the smoke root) ----------------
if SMOKE_ROOT:
    record, applied = smoke_material_record()
    out_path(f'docs/design/blender/{SLUG}/material-library.json').write_text(
        json.dumps(record, indent=2) + '\n')
    textured_materials = len(applied)
else:
    import runpy
    finish_asset = runpy.run_path(str(ROOT / 'tools/blender/material-library.py'))['finish_asset']
    textured_materials = finish_asset(SLUG, scene=scene)['textured_materials']

# --- ASSET_TINTS: darker graphite/olive/orange values over the palette maps --
for key, tint in ASSET_TINTS.items():
    material = material_meta.get(key)
    if material is None:
        continue
    shader = next((n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if shader is None:
        continue
    base = shader.inputs['Base Color']
    incoming = base.links[0].from_socket if base.is_linked else None
    for link in list(base.links):
        material.node_tree.links.remove(link)
    mix = material.node_tree.nodes.new('ShaderNodeMixRGB')
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Fac'].default_value = 1.0
    mix.inputs['Color2'].default_value = (*tint, 1)
    mix.location = (-250, 180)
    if incoming:
        material.node_tree.links.new(incoming, mix.inputs['Color1'])
    else:
        mix.inputs['Color1'].default_value = material.diffuse_color
    material.node_tree.links.new(mix.outputs['Color'], base)
    material['gltf_tint'] = list(tint)


def tint_gltf_doc(doc):
    for entry in doc.get('materials', []):
        key = entry.get('name', '').split(' | ')[-1].strip().lower()
        tint = ASSET_TINTS.get(key)
        if tint is None:
            continue
        pbr = entry.setdefault('pbrMetallicRoughness', {})
        pbr['baseColorFactor'] = [*tint, 1.0]
        entry.setdefault('extras', {})['gltfTint'] = list(tint)


runtime_doc = json.loads(gltf_path.read_text())
tint_gltf_doc(runtime_doc)
gltf_path.write_text(json.dumps(runtime_doc, separators=(',', ':')) + '\n')

portable_doc, portable_binary = unpack_glb(glb_path.read_bytes())
tint_gltf_doc(portable_doc)
glb_path.write_bytes(pack_glb(portable_doc, portable_binary))

# Persist the finished materials/texture extras into the delivered study.
if not SMOKE_ROOT:
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND), check_existing=False)

# --- docs manifest (revision 13) ---------------------------------------------
review_dir = f'docs/design/blender/{SLUG}/review/final'
docs_manifest = {
    'asset': 'GL-3 SKIPJACK', 'asset_id': SLUG, 'weapon_id': 'mgl', 'revision': 13,
    'axis_contract': {'authoring_forward': '+Y', 'authoring_up': '+Z', 'authoring_right': '+X',
                      'game_mapping': 'x=x, y=z, z=-y'},
    'anchors_authoring': {name: marker_authoring[name] for name in MARKERS},
    'source_parts': source_parts, 'runtime_draws': draws, 'triangles': triangles,
    'runtime_gltf': f'public/assets/blender/{SLUG}.gltf',
    'portable_glb': f'docs/design/blender/{SLUG}/{SLUG}.glb',
    'blend': f'docs/design/blender/{SLUG}/{SLUG}.blend',
    'hero_render': f'docs/design/blender/{SLUG}/{SLUG}-hero.png',
    'hero_view': 'orthographic front-left three-quarter; muzzle to image left',
    'side_render': f'docs/design/blender/{SLUG}/{SLUG}-side.png',
    'review_views': {name: f'{review_dir}/{name}.png' for name in REVIEW_VIEWS},
    'material_tints': {key: list(tint) for key, tint in ASSET_TINTS.items()},
    'textured_materials': textured_materials,
}
docs_manifest_path = out_path(f'docs/design/blender/{SLUG}/manifest.json')
docs_manifest_path.write_text(json.dumps(docs_manifest, indent=2) + '\n')

print(json.dumps({
    'scene': scene.name,
    'mode': f'smoke ({SMOKE_ROOT})' if SMOKE_ROOT else 'full',
    'source_parts': source_parts,
    'top_level_nodes': [document['nodes'][i]['name'] for i in document['scenes'][0]['nodes']],
    'draws': draws,
    'triangles': triangles,
    'batches': batch_rows,
    'round_extras': {f'mag | round {n}': {'blenderAsset': SLUG, 'part': 'mag', 'ammoRound': n}
                     for n in (1, 2, 3)},
    'materials': [m['name'] for m in materials],
    'textured_materials': textured_materials,
    'uncolored_round_parts': uncolored,
    'warnings': warnings,
    'bin_bytes': len(binary),
    'gltf_bytes': gltf_path.stat().st_size,
    'glb_bytes': glb_path.stat().st_size,
}, indent=2))
print('SKIPJACK-EXPORT-DONE')
