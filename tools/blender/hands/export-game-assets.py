"""Write the browser-facing HANDS glTF, geometry buffer and asset statistics.

    blender --background --factory-startup --python tools/blender/hands/export-game-assets.py
    (opens docs/design/blender/hands/hands.blend itself), or equivalently:
    blender --background docs/design/blender/hands/hands.blend \
        --python tools/blender/hands/export-game-assets.py

The runtime file is not the Blender GLB: it is the compact delivery form the
game's loader (`public/js/engine/blender-assets.js`) expects.

    * buffer `hands.bin`, referenced as a sibling URI
    * images referenced as `textures/<stem>.jpg`, never re-encoded - the game's
      map cache keys decoded maps on exactly that string, and GLTFLoader derives
      Texture.name from the image URI
    * node transforms are identity with all vertices baked into glove-local
      space (palm at origin, fingers -z, cuff +z, y up): the authoring frame
      is already the consumed frame, so GAME is the identity rotation and the
      flat normal matrix is the identity itself
    * five joint-local nodes, one primitive per material
    * analytic UVs at each material's own real-world density (`uv_scale`
      custom property written by build-hands.py), recomputed here on the
      final geometry so the GLB and the runtime file agree

Only the selected HANDS scene's editable mesh parts are exported.
"""
import bpy
import json
import struct
from collections import defaultdict
from pathlib import Path
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / 'docs/design/blender/hands'
OUT = ROOT / 'public/assets/blender'
BLEND = DOCS / 'hands.blend'
SLUG = 'hands'
SCENE_PREFIX = 'HANDS'

GROUPS = ['grip', 'support', 'forearm', 'upperarm', 'shoulder']
MARKERS = []
textures = []
UV_SCALE = 3.6  # texture tiles per metre, fallback only: parts carry `uv_scale`

# The glove-local authoring frame is consumed verbatim by kit glove(), so the
# game-space map is the identity: a proper rotation, and the flat normal
# matrix is this rotation itself.
GAME = Matrix.Identity(3)

if BLEND.exists() and not any(s.name.startswith(SCENE_PREFIX) for s in bpy.data.scenes):
    bpy.ops.wm.open_mainfile(filepath=str(BLEND))
scene = next((s for s in bpy.data.scenes if s.name == f'{SCENE_PREFIX} | Voxel Blitz hands study'),
             None) or next((s for s in bpy.data.scenes if s.name.startswith(SCENE_PREFIX)), None)
if scene is None:
    raise SystemExit(f'no {SCENE_PREFIX} scene in {BLEND}')

source_parts = sum(1 for obj in scene.objects if obj.type == 'MESH' and obj.get('part') in GROUPS)

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
    key = obj['hands_material']
    if key not in material_index:
        material_index[key] = len(material_order)
        material_order.append(key)
        # Authoring can leave a numeric suffix on the datablock name; match on
        # the base name so the exporter does not depend on it.
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
            # Analytic projection on final geometry, at the same per-material
            # density the authoring script uses: the runtime glTF and the GLB
            # must agree, and neither may depend on modifier UV interpolation.
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
def material_desc(name, material):
    shader = material.node_tree.nodes['Principled BSDF']
    uri = material.get('texture_uri')
    tint = list(material.get('gltf_tint', (1, 1, 1)))
    pbr = {'baseColorFactor': tint + [1],
           'metallicFactor': float(shader.inputs['Metallic'].default_value),
           'roughnessFactor': float(shader.inputs['Roughness'].default_value)}
    extras = {'partMaterial': name}
    if uri:
        if uri not in textures:
            textures.append(uri)
        pbr['baseColorTexture'] = {'index': textures.index(uri)}
    return {'name': f'HANDS | {name}', 'pbrMetallicRoughness': pbr, 'extras': extras}


materials = [material_desc(name, material_meta[index])
             for name, index in sorted(material_index.items(), key=lambda kv: kv[1])]

# --- glTF document ---------------------------------------------------------
document = {
    'asset': {'version': '2.0', 'generator': 'Voxel Blitz Blender runtime export'},
    'scene': 0,
    'scenes': [{'nodes': []}],
    'nodes': [], 'meshes': [], 'materials': materials,
    'images': [{'uri': uri, 'name': uri} for uri in textures],
    'textures': [{'source': index, 'sampler': 0, 'name': uri} for index, uri in enumerate(textures)],
    'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}],
    'buffers': [], 'bufferViews': [], 'accessors': [],
}
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


def add_node(name, primitives, extras=None, translation=None, children=None):
    index = len(document['nodes'])
    node = {'name': name}
    if primitives is not None:
        node['mesh'] = len(document['meshes'])
        document['meshes'].append({'name': name, 'primitives': primitives})
        node['extras'] = extras or {}
    else:
        node['extras'] = extras or {}
    if translation is not None:
        node['translation'] = [round(float(v), 6) for v in translation]
    if children is not None:
        node['children'] = children
    document['nodes'].append(node)
    document['scenes'][0]['nodes'].append(index)
    return index


draws = 0
triangles = 0
part_triangles = {}
for part in GROUPS:
    primitives = []
    for (part_name, material) in sorted({(p, m) for (p, m) in part_batches[part]}):
        batch = batches[(part_name, material)]
        attributes, indices = build_mesh(batch)
        primitives.append({'attributes': attributes, 'indices': indices, 'material': material})
        draws += 1
        triangles += len(batch['indices']) // 3
        part_triangles[f'{part} | {material_order[material]}'] = len(batch['indices']) // 3
    if not primitives:
        raise SystemExit(f'part {part} has no geometry')
    add_node(part, primitives, extras={'blenderAsset': SLUG})

document['buffers'] = [{'uri': f'{SLUG}.bin', 'byteLength': len(binary)}]
(OUT / f'{SLUG}.bin').write_bytes(binary)
(OUT / f'{SLUG}.gltf').write_text(json.dumps(document, separators=(',', ':')) + '\n')

stats = {'asset': SLUG, 'source_parts': source_parts, 'draws': draws,
         'triangles': triangles, 'geometry_bytes': len(binary)}
manifest_path = OUT / 'manifest.json'
library = json.loads(manifest_path.read_text())
for index, item in enumerate(library['assets']):
    if item['asset'] == SLUG:
        library['assets'][index] = stats
        break
else:
    library['assets'].append(stats)
manifest_path.write_text(json.dumps(library, indent=2) + '\n')

print(json.dumps({
    **stats,
    'triangles_per_primitive': part_triangles,
    'materials': [m['name'] for m in materials],
    'material_textures': {m['name']: m['pbrMetallicRoughness'].get('baseColorTexture', {}).get('index')
                          for m in materials},
    'images': [image['uri'] for image in document['images']],
    'bin_bytes': len(binary),
    'blend_bytes': BLEND.stat().st_size,
    'gltf_bytes': (OUT / f'{SLUG}.gltf').stat().st_size,
    'nodes': [node['name'] for node in document['nodes']],
    'scene': scene.name,

}, indent=2))
