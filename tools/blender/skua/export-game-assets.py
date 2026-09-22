"""Write the browser-facing runtime glTF for SKUA, plus .bin and manifest row.

Run headless from the saved study source:

    blender --background --factory-startup docs/design/blender/skua/skua.blend \
        --python tools/blender/skua/export-game-assets.py

Produces public/assets/blender/skua.gltf + skua.bin against the frozen node
contract (extras.blenderAsset = "skua" on every group node):

    body, trigger   identity nodes, one primitive per material, gun-local
    mag             the seated disc, geometry relative to the disc centre and
                    the centre as node translation (game (0, 0.042, -0.22));
                    the disc is baked with its 6 degree tilt, so the runtime
                    spins it about the tilted normal (0, cos 6, sin 6)
    bolt            the flywheel, relative to its hub on the bore axis at
                    BOLT_HOME (game (0, 0, 0.06)); it whirls about game z
    extra           an identity node whose children are `<leaf> | <material>`
                    nodes, each pivot-local with its pivot as translation:
                      horn left | *    vertical pin at game (-0.05, 0, -0.335)
                      horn right | *   vertical pin at game (+0.05, 0, -0.335)
                      spare disc | *   round node, cassette centre (0, -0.072, -0.165)
                      gauge needle | * gauge centre (-0.0635, 0, 0.07), spins about x
    grip, muzzle, sight, support   marker nodes at the frozen anchors

Textures are the shared palette files under public/assets/blender/textures,
applied by tools/blender/material-library.py `finish_asset`; nothing is
generated. This script also drops any foreign scene the authoring session
carried into skua.blend, so the delivered source holds exactly one scene.
"""
import bpy
import json
import math
import struct
from collections import defaultdict
from pathlib import Path
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / 'docs/design/blender/skua'
OUT = ROOT / 'public/assets/blender'
BLEND = DOCS / 'skua.blend'
SLUG = 'skua'
SCENE_PREFIX = 'SKUA'
SCENE_NAME = f'{SCENE_PREFIX} | Voxel Blitz disc launcher study'

GROUPS = ['body', 'mag', 'bolt', 'trigger', 'extra']
MARKERS = ['grip', 'muzzle', 'sight', 'support']
UV_SCALE = 3.6  # texture tiles per metre; must match build-skua.py

# game_x = x, game_y = z, game_z = -y: a proper rotation, so normals map like
# positions and the flat normal matrix is this rotation itself.
GAME = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))

# Pivots in game space; they must match NODE_PIVOTS in build-skua.py.
DISC_TILT = math.radians(6)
PIVOTS = {
    'mag': Vector((0.0, 0.042, -0.220)),
    'bolt': Vector((0.0, 0.0, 0.060)),
    'horn left': Vector((-0.050, 0.0, -0.335)),
    'horn right': Vector((0.050, 0.0, -0.335)),
    'spare disc': Vector((0.0, -0.072, -0.165)),
    'gauge needle': Vector((-0.0635, 0.0, 0.070)),
}
NODE_EXTRAS = {
    'mag': {'role': 'seated disc', 'spinAxis': [0, round(math.cos(DISC_TILT), 6),
                                                round(math.sin(DISC_TILT), 6)], 'tiltDeg': 6},
    'bolt': {'role': 'flywheel', 'spinAxis': [0, 0, 1]},
    'horn left': {'role': 'catch horn', 'hingeAxis': [0, 1, 0], 'flareSign': 1},
    'horn right': {'role': 'catch horn', 'hingeAxis': [0, 1, 0], 'flareSign': -1},
    'spare disc': {'role': 'spare disc round'},
    'gauge needle': {'role': 'gauge needle', 'spinAxis': [1, 0, 0]},
}
EXTRA_ORDER = ['horn left', 'horn right', 'spare disc', 'gauge needle']

scene = next((s for s in bpy.data.scenes if s.name == SCENE_NAME), None) \
    or next((s for s in bpy.data.scenes if s.name.startswith(SCENE_PREFIX)), None)
if scene is None:
    raise SystemExit(f'no {SCENE_PREFIX} scene in {BLEND}')

# --- drop foreign studies from the delivered source ------------------------
source_parts = sum(1 for obj in scene.objects if obj.type == 'MESH' and obj.get('part') in GROUPS)
if source_parts < 80:
    raise SystemExit(f'{source_parts} source parts in {BLEND}; expected the authored study')
removed = [s.name for s in bpy.data.scenes if s is not scene]
for name in removed:
    bpy.data.scenes.remove(bpy.data.scenes[name])
bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
scene.name = SCENE_NAME
# With the other studies gone the contract names are free again: an authoring
# session that already owned 'muzzle' left this build's marker as 'muzzle.001'.
for name in MARKERS:
    marker = next((o for o in scene.objects if o.name.split('.')[0] == name), None)
    if marker is not None and marker.name != name:
        marker.name = name
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND), check_existing=False)

# --- anchor contract -------------------------------------------------------
muzzle_obj = next((o for o in scene.objects if o.name.split('.')[0] == 'muzzle'), None)
if muzzle_obj is None:
    raise SystemExit('SKUA scene has no muzzle marker')
muzzle_game = GAME @ muzzle_obj.location
if max(abs(a - b) for (a, b) in zip(muzzle_game, (0.0, 0.0, -0.40))) > 1e-6:
    raise SystemExit(f'muzzle marker drifted off the glaive contract: {list(muzzle_game)}')

# --- gather authored parts -------------------------------------------------
depsgraph = bpy.context.evaluated_depsgraph_get()
batches = defaultdict(lambda: {'vertices': [], 'indices': [], 'lookup': {}})
material_order = []
material_index = {}
material_meta = []


def stored_world(obj):
    """Compose the stored transform: a reopened file may not refresh matrix_world."""
    return obj.matrix_parent_inverse @ Matrix.LocRotScale(
        obj.location, obj.rotation_euler.to_quaternion(), obj.scale)


node_sources = defaultdict(int)
for obj in sorted(scene.objects, key=lambda o: o.name):
    part = obj.get('part')
    if obj.type != 'MESH' or part not in GROUPS:
        continue
    key = obj.get('skua_material')
    if not key:
        raise SystemExit(f'{obj.name} has no skua_material prop')
    node = obj.get('node') or part
    if part == 'extra' and node not in EXTRA_ORDER:
        raise SystemExit(f'{obj.name}: extra part without a known leaf node ({node!r})')
    if key not in material_index:
        material_index[key] = len(material_order)
        material_order.append(key)
        # Authoring can leave a numeric suffix on the datablock name; match on
        # the base name so the exporter does not depend on it.
        material_meta.append(next(m for m in bpy.data.materials
                                  if m.name.split('.')[0] == f'{SCENE_PREFIX} | {key}'))
    world = stored_world(obj)
    linear = GAME @ world.to_3x3()
    offset = GAME @ world.translation - PIVOTS.get(node, Vector((0.0, 0.0, 0.0)))
    target = batches[(part, node, material_index[key])]
    node_sources[node] += 1
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    if mesh.uv_layers.active is None:
        raise SystemExit(f'{obj.name} has no UV layer')
    for triangle in mesh.loop_triangles:
        polygon = mesh.polygons[triangle.polygon_index]
        dominant = max(range(3), key=lambda i: abs(polygon.normal[i]))
        (first, second) = [(1, 2), (0, 2), (0, 1)][dominant]
        for loop_index in triangle.loops:
            loop = mesh.loops[loop_index]
            coordinate = mesh.vertices[loop.vertex_index].co
            position = linear @ coordinate + offset
            normal = (linear @ mesh.corner_normals[loop_index].vector).normalized()
            # Analytic projection on final geometry, at the same constant
            # density the authoring script uses.
            uv = (coordinate[first] * UV_SCALE, coordinate[second] * UV_SCALE)
            vertex = (round(position[0], 6), round(position[1], 6), round(position[2], 6),
                      round(normal[0], 5), round(normal[1], 5), round(normal[2], 5),
                      round(uv[0], 6), round(uv[1], 6))
            if vertex not in target['lookup']:
                target['lookup'][vertex] = len(target['vertices'])
                target['vertices'].append(vertex)
            target['indices'].append(target['lookup'][vertex])
    evaluated.to_mesh_clear()

for part in ('body', 'mag', 'bolt', 'trigger'):
    if not node_sources[part]:
        raise SystemExit(f'part {part} has no geometry')
for node in EXTRA_ORDER:
    if not node_sources[node]:
        raise SystemExit(f'extra leaf {node} has no geometry')


# --- material descriptors --------------------------------------------------
def material_desc(name, material):
    shader = next(n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    pbr = {'baseColorFactor': [round(v, 4) for v in shader.inputs['Base Color'].default_value],
           'metallicFactor': float(shader.inputs['Metallic'].default_value),
           'roughnessFactor': float(shader.inputs['Roughness'].default_value)}
    extras = {'partMaterial': name}
    result = {'name': f'{SCENE_PREFIX} | {name}', 'pbrMetallicRoughness': pbr, 'extras': extras}
    strength = float(shader.inputs['Emission Strength'].default_value)
    if strength and material.get('emissive_coil'):
        # The magenta accent ships as its linear colour; the strength stays an
        # extra so the runtime owns the intensity (discs in hand, return flare).
        emission = shader.inputs['Emission Color'].default_value
        result['emissiveFactor'] = [round(float(v), 6) for v in emission[:3]]
        extras['cosmeticGlow'] = True
        extras['emissiveStrength'] = strength
    return result


materials = [material_desc(name, material_meta[index])
             for name, index in sorted(material_index.items(), key=lambda kv: kv[1])]

# --- glTF document ---------------------------------------------------------
document = {
    'asset': {'version': '2.0', 'generator': 'Voxel Blitz Blender runtime export'},
    'scene': 0,
    'scenes': [{'nodes': []}],
    'nodes': [], 'meshes': [], 'materials': materials,
    'images': [], 'textures': [],
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


def new_node(name, primitives, extras, translation=None, children=None, root=True):
    index = len(document['nodes'])
    node = {'name': name, 'extras': extras}
    if primitives is not None:
        node['mesh'] = len(document['meshes'])
        document['meshes'].append({'name': name, 'primitives': primitives})
    if translation is not None:
        node['translation'] = [round(float(v), 6) for v in translation]
    if children is not None:
        node['children'] = children
    document['nodes'].append(node)
    if root:
        document['scenes'][0]['nodes'].append(index)
    return index


draws = 0
triangles = 0
part_triangles = {}


def primitives_for(part, node):
    global draws, triangles
    primitives = []
    for material in sorted(m for (p, n, m) in batches if p == part and n == node):
        batch = batches[(part, node, material)]
        attributes, indices = build_mesh(batch)
        primitives.append({'attributes': attributes, 'indices': indices, 'material': material})
        draws += 1
        triangles += len(batch['indices']) // 3
        part_triangles[f'{node} | {material_order[material]}'] = len(batch['indices']) // 3
    return primitives


for part in ('body', 'mag', 'bolt', 'trigger'):
    extras = {'blenderAsset': SLUG, **NODE_EXTRAS.get(part, {})}
    new_node(part, primitives_for(part, part), extras, translation=PIVOTS.get(part))

# `extra`: one pivot-local node per (leaf, material), the pivot as translation.
leaf_children = []
for node in EXTRA_ORDER:
    for material in sorted(m for (p, n, m) in batches if p == 'extra' and n == node):
        batch = batches[('extra', node, material)]
        attributes, indices = build_mesh(batch)
        name = f'{node} | {material_order[material]}'
        leaf_children.append(new_node(
            name, [{'attributes': attributes, 'indices': indices, 'material': material}],
            {'blenderAsset': SLUG, **NODE_EXTRAS[node]}, translation=PIVOTS[node], root=False))
        draws += 1
        triangles += len(batch['indices']) // 3
        part_triangles[f'extra | {name}'] = len(batch['indices']) // 3
new_node('extra', None, {'blenderAsset': SLUG}, children=leaf_children)

for name in MARKERS:
    marker = next((o for o in scene.objects
                   if o.name == name or o.name.split('.')[0] == name), None)
    if marker is None:
        raise SystemExit(f'marker {name} missing from the SKUA scene')
    new_node(name, None, {'role': 'gameplay mount marker'}, translation=GAME @ marker.location)

document['buffers'] = [{'uri': f'{SLUG}.bin', 'byteLength': len(binary)}]
(OUT / f'{SLUG}.bin').write_bytes(binary)
(OUT / f'{SLUG}.gltf').write_text(json.dumps(document, separators=(',', ':')) + '\n')

# --- manifest row (the skua entry only) -------------------------------------
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
    'scene': scene.name,
    'removed_scenes': removed,
    'source_parts': source_parts,
    'nodes': [(node['name'], node.get('translation')) for node in document['nodes']],
    'draws': draws,
    'triangles': triangles,
    'triangles_per_primitive': part_triangles,
    'materials': [m['name'] for m in materials],
    'bin_bytes': len(binary),
    'blend_bytes': BLEND.stat().st_size,
    'gltf_bytes': (OUT / f'{SLUG}.gltf').stat().st_size,
}, indent=2))
print('SKUA-EXPORT-DONE')

# Apply the shared palette after the weapon-specific export (the
# material-library pass every weapon delivery goes through; it adds the
# textureLibrary/textureBumpScale extras and the shared palette maps).
import runpy
runpy.run_path(str(ROOT / 'tools/blender/material-library.py'))['finish_asset'](SLUG, scene=scene)
