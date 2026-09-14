"""Write the browser-facing runtime glTF for GRENADES, plus .bin and manifest.

    blender --background --factory-startup --python tools/blender/grenades/export-game-assets.py
    (opens docs/design/blender/grenades/grenades.blend itself), or equivalently:
    blender --background docs/design/blender/grenades/grenades.blend \
        --python tools/blender/grenades/export-game-assets.py

The runtime file is not the Blender GLB: it is the compact delivery form the
game's loader (`public/js/engine/blender-assets.js`) expects.

    * buffer `grenades.bin`, referenced as a sibling URI
    * images referenced as `textures/<stem>.jpg`, never re-encoded - the game's
      map cache keys decoded maps on exactly that string, and GLTFLoader derives
      Texture.name from the image URI
    * node transforms are identity with all vertices baked into the held frame
      (y up, centre of mass at the origin): the authoring frame is already the
      consumed frame, so GAME is the identity and the flat normal matrix is the
      identity itself
    * one node per grenade type (`frag`, `limpet`, `pulse`, `molotov`, `smoke`),
      one primitive per material, so the loader can instance a single type
    * glow materials carry `emissiveFactor` (plus KHR_materials_emissive_strength
      when the authored strength is not 1); the bottle glass is alphaMode BLEND
      with the `glass` extra the loader turns into depthWrite=false
    * analytic UVs at each material's own real-world density (`uv_scale`
      custom property written by build-grenades.py), recomputed here on the
      final geometry so the GLB and the runtime file agree

This script also performs one piece of file hygiene it owns: the authoring
session holds other studies in the same Blender file, so the `copy=True`
save that protected the live session also carried them into grenades.blend.
Any scene that is not the GRENADES study is removed here and the .blend is
re-saved, so the delivered source holds exactly one scene. This runs in a
background process and never touches the live session.

Like the BISON exporter it maintains public/assets/blender/manifest.json
(its own `grenades` entry only). No study texture is written, re-encoded or
copied over.
"""
import bpy
import json
import struct
from collections import defaultdict
from pathlib import Path
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / 'docs/design/blender/grenades'
OUT = ROOT / 'public/assets/blender'
BLEND = DOCS / 'grenades.blend'
SLUG = 'grenades'
SCENE_PREFIX = 'GRENADES'
SCENE_NAME = f'{SCENE_PREFIX} | Voxel Blitz throwables study'

GROUPS = ['frag', 'limpet', 'pulse', 'molotov', 'smoke']
TEXTURES = ['worn-gunmetal', 'orange-painted-metal', 'ivory-armor',
            'petrol-ballistic-fabric', 'tan-webbing', 'worn-rubber']
UV_SCALE = 12.0  # tiles per metre, fallback only: parts carry `uv_scale`

# The held frame is consumed verbatim, so the game-space map is the identity.
GAME = Matrix.Identity(3)

if BLEND.exists() and not any(s.name.startswith(SCENE_PREFIX) for s in bpy.data.scenes):
    bpy.ops.wm.open_mainfile(filepath=str(BLEND))
scene = (bpy.data.scenes.get(SCENE_NAME)
         or next((s for s in bpy.data.scenes if s.name.startswith(SCENE_PREFIX)), None))
if scene is None:
    raise SystemExit(f'no {SCENE_PREFIX} scene in {BLEND}')

# --- drop foreign studies from the delivered source ------------------------
source_parts = sum(1 for obj in scene.objects if obj.type == 'MESH' and obj.get('part') in GROUPS)
removed = [s.name for s in bpy.data.scenes if s is not scene]
for name in removed:
    bpy.data.scenes.remove(bpy.data.scenes[name])
bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
scene.name = SCENE_NAME
# With the other studies gone the contract names are free again: a session
# that already owned 'frag' would have left this build's group empty as
# 'frag.001'.
for name in GROUPS:
    owner = next((o for o in scene.objects if o.type == 'EMPTY' and o.name.split('.')[0] == name), None)
    if owner is not None and owner.name != name:
        owner.name = name
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND), check_existing=False)

# --- gather authored parts -------------------------------------------------
depsgraph = bpy.context.evaluated_depsgraph_get()
batches = defaultdict(lambda: {'vertices': [], 'indices': [], 'lookup': {}})
part_batches = defaultdict(list)
material_order = []
material_index = {}


def stored_world(obj):
    """Compose the stored transform: a reopened file may not refresh matrix_world."""
    return obj.matrix_parent_inverse @ Matrix.LocRotScale(
        obj.location, obj.rotation_euler.to_quaternion(), obj.scale)


material_meta = []
for obj in sorted(scene.objects, key=lambda o: o.name):
    part = obj.get('part')
    if obj.type != 'MESH' or part not in GROUPS:
        continue
    key = obj['grenade_material']
    if key not in material_index:
        material_index[key] = len(material_order)
        material_order.append(key)
        material_meta.append(obj.data.materials[0])
    world = stored_world(obj)
    linear = GAME @ world.to_3x3()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    if mesh.uv_layers.active is None:
        raise SystemExit(f'{obj.name} has no UV layer')
    target = batches[(part, material_index[key])]
    uv_scale = float(obj.get('uv_scale', UV_SCALE))
    offset = GAME @ world.translation
    part_batches[part].append((part, material_index[key]))
    for triangle in mesh.loop_triangles:
        corners = [linear @ mesh.vertices[i].co + offset for i in triangle.vertices]
        rounded = [Vector(tuple(round(v, 6) for v in corner)) for corner in corners]
        if (rounded[1] - rounded[0]).cross(rounded[2] - rounded[0]).length <= 1e-12:
            raise RuntimeError(f'{obj.name}: triangle collapses at runtime precision')
        polygon = mesh.polygons[triangle.polygon_index]
        dominant = max(range(3), key=lambda i: abs(polygon.normal[i]))
        (first, second) = [(1, 2), (0, 2), (0, 1)][dominant]
        for loop_index in triangle.loops:
            loop = mesh.loops[loop_index]
            coordinate = mesh.vertices[loop.vertex_index].co
            position = linear @ coordinate + offset
            normal = (linear @ mesh.corner_normals[loop_index].vector).normalized()
            uv = (coordinate[first] * uv_scale, coordinate[second] * uv_scale)
            vertex = (round(position[0], 6), round(position[1], 6), round(position[2], 6),
                      round(normal[0], 5), round(normal[1], 5), round(normal[2], 5),
                      round(uv[0], 6), round(uv[1], 6))
            if vertex not in target['lookup']:
                target['lookup'][vertex] = len(target['vertices'])
                target['vertices'].append(vertex)
            target['indices'].append(target['lookup'][vertex])
    evaluated.to_mesh_clear()

# --- material descriptors --------------------------------------------------
extensions_used = set()


def material_desc(name, material):
    shader = material.node_tree.nodes['Principled BSDF']
    stem = material.get('imagegen_texture', '')
    tint = [float(v) for v in material.get('gltf_tint', (1, 1, 1))]
    alpha = float(material.get('gltf_alpha', 1.0))
    pbr = {'baseColorFactor': [round(v, 5) for v in tint] + [round(alpha, 4)],
           'metallicFactor': float(shader.inputs['Metallic'].default_value),
           'roughnessFactor': float(shader.inputs['Roughness'].default_value)}
    extras = {'partMaterial': name}
    if stem:
        pbr['baseColorTexture'] = {'index': TEXTURES.index(stem.replace('.jpg', ''))}
    else:
        pbr['baseColorFactor'] = [round(v, 4) for v in shader.inputs['Base Color'].default_value]
    result = {'name': f'{SCENE_PREFIX} | {name}', 'pbrMetallicRoughness': pbr, 'extras': extras}
    glow = material.get('gltf_emissive')
    if glow is not None:
        result['emissiveFactor'] = [round(float(v), 5) for v in glow]
        strength = float(material.get('gltf_emissive_strength', 1.0))
        if abs(strength - 1.0) > 1e-6:
            result['extensions'] = {'KHR_materials_emissive_strength': {'emissiveStrength': round(strength, 4)}}
            extensions_used.add('KHR_materials_emissive_strength')
        extras['glow'] = True
    if material.get('glass'):
        result['alphaMode'] = 'BLEND'
        result['doubleSided'] = True
        extras['glass'] = True
    return result


materials = [material_desc(name, material_meta[index])
             for name, index in sorted(material_index.items(), key=lambda kv: kv[1])]

# --- glTF document ---------------------------------------------------------
document = {
    'asset': {'version': '2.0', 'generator': 'Voxel Blitz Blender runtime export'},
    'scene': 0,
    'scenes': [{'nodes': []}],
    'nodes': [], 'meshes': [], 'materials': materials,
    'images': [{'uri': f'textures/{stem}.jpg'} for stem in TEXTURES],
    'textures': [{'source': index, 'sampler': 0} for index in range(len(TEXTURES))],
    'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}],
    'buffers': [], 'bufferViews': [], 'accessors': [],
}
if extensions_used:
    document['extensionsUsed'] = sorted(extensions_used)
binary = bytearray()


def accessor(values, size, component, kind, target, bounds=False):
    while len(binary) % 4:
        binary.append(0)
    start = len(binary)
    binary.extend(struct.pack('<' + ('f' if component == 5126 else 'I') * len(values), *values))
    view = len(document['bufferViews'])
    document['bufferViews'].append({'buffer': 0, 'byteOffset': start,
                                    'byteLength': len(binary) - start, 'target': target})
    entry = {'bufferView': view, 'componentType': component,
             'count': len(values) // size, 'type': kind}
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
    indices = accessor(batch['indices'], 1, 5125, 'SCALAR', 34963)
    return attributes, indices


def add_node(name, primitives, extras=None):
    index = len(document['nodes'])
    node = {'name': name, 'extras': extras or {}}
    if primitives is not None:
        node['mesh'] = len(document['meshes'])
        document['meshes'].append({'name': name, 'primitives': primitives})
    document['nodes'].append(node)
    document['scenes'][0]['nodes'].append(index)
    return index


draws = 0
triangles = 0
part_triangles = {}
type_triangles = {}
for part in GROUPS:
    primitives = []
    for (part_name, material) in sorted({(p, m) for (p, m) in part_batches[part]}):
        batch = batches[(part_name, material)]
        attributes, indices = build_mesh(batch)
        primitives.append({'attributes': attributes, 'indices': indices, 'material': material})
        draws += 1
        triangles += len(batch['indices']) // 3
        part_triangles[f'{part} | {material_order[material]}'] = len(batch['indices']) // 3
        type_triangles[part] = type_triangles.get(part, 0) + len(batch['indices']) // 3
    if not primitives:
        raise SystemExit(f'part {part} has no geometry')
    add_node(part, primitives, extras={'blenderAsset': SLUG, 'grenadeType': part})

document['buffers'] = [{'uri': f'{SLUG}.bin', 'byteLength': len(binary)}]
(OUT / f'{SLUG}.bin').write_bytes(binary)
(OUT / f'{SLUG}.gltf').write_text(json.dumps(document, separators=(',', ':')) + '\n')

# --- manifest --------------------------------------------------------------
manifest_path = OUT / 'manifest.json'
manifest = json.loads(manifest_path.read_text())
entry = {'asset': SLUG, 'source_parts': source_parts,
         'draws': draws, 'triangles': triangles, 'geometry_bytes': len(binary)}
assets = [a for a in manifest['assets'] if a['asset'] != SLUG]
assets.append(entry)
assets.sort(key=lambda a: a['asset'])
manifest['assets'] = assets
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')

print(json.dumps({
    'asset': SLUG,
    'scene': scene.name,
    'removed_scenes': removed,
    'source_parts': source_parts,
    'draws': draws,
    'triangles': triangles,
    'triangles_per_type': type_triangles,
    'triangles_per_primitive': part_triangles,
    'materials': [m['name'] for m in materials],
    'material_textures': {m['name']: m['pbrMetallicRoughness'].get('baseColorTexture', {}).get('index')
                          for m in materials},
    'glow_materials': [m['name'] for m in materials if 'emissiveFactor' in m],
    'images': [image['uri'] for image in document['images']],
    'geometry_bytes': len(binary),
    'bin_bytes': len(binary),
    'blend_bytes': BLEND.stat().st_size,
    'gltf_bytes': (OUT / f'{SLUG}.gltf').stat().st_size,
    'nodes': [node['name'] for node in document['nodes']],
}, indent=2))
