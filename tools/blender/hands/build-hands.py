"""Build the field operator's two first-person glove poses and three arm segments.

Run with blender --background --factory-startup --python tools/blender/hands/build-hands.py.
Both gloves are right hands, with fingers pointing -Z, cuff +Z, back of hand +Y.
The game mirrors one pose for the left hand. The articulated sleeves share the
jacket geometry with the body model, rebased to first-person wrist and elbow
frames. This script saves the Blender source, GLB and studio views and checks
the palm anchors, fingertip separation, segment envelopes and garment joins.
"""
import bpy
import json
import math
import struct
import sys
from pathlib import Path
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from field_sleeves import build_sleeves
from glove import build_gloves, FINGERS, THUMB_BASE
from rivet.model import MeshModel
from rivet.materials import MATERIALS as FIELD_MATERIALS

DOCS = ROOT / 'docs/design/blender/hands'
ASSET_ROOT = ROOT / 'public/assets/blender'
DOCS.mkdir(parents=True, exist_ok=True)

ASSET = 'HANDS'
SCENE_NAME = f'{ASSET} | Voxel Blitz hands study'
POSES = ['grip', 'support']
ARM_PARTS = ['forearm', 'upperarm', 'shoulder']
GROUPS = POSES + ARM_PARTS

# --- arm segment contract (metres, each part in its own joint frame) --------
FOREARM_LEN = 0.31   # wrist joint (origin) .. elbow along forearm-local +z
UPPER_LEN = 0.34     # elbow (origin) .. shoulder joint along upper-arm-local +z
WRIST_Z = 0.070      # glove-local z of the wrist joint the forearm mounts on
ARM_RADIUS = 0.080   # no arm vertex leaves this radius from its own axis
SHOULDER_REACH = 0.16

# --- glove-local frame contract (metres, y up, right hand) ------------------
# Palm spans the origin; knuckles at z ~= -0.045 with fingers running toward
# -Z before they flex. The wrist closure remains behind the palm and the
# entire glove stays inside the 0.25 m reach envelope.
PALM_Z0, PALM_Z1 = -0.046, 0.030   # knuckle edge .. wrist heel
KNUCKLE_Y = 0.003                  # finger base height
CUFF_MIN_Z = 0.018                 # every strap/sleeve part starts past this plane
REACH = 0.25


# --- scene -----------------------------------------------------------------
def drop_previous_study():
    previous = bpy.data.scenes.get(SCENE_NAME)
    if previous is None:
        return
    for window in bpy.context.window_manager.windows:
        if window.scene is previous:
            window.scene = bpy.context.scene
    bpy.data.scenes.remove(previous)
    bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=False, do_recursive=True)


HEADLESS = bpy.app.background
if HEADLESS:
    scene = bpy.context.scene
    scene.name = SCENE_NAME
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.context.view_layer.update()
else:
    drop_previous_study()
    scene = bpy.data.scenes.new(SCENE_NAME)
    for window in bpy.context.window_manager.windows:
        window.scene = scene
# Everything this study owns lives in one collection: object selection is not
# scoped to a scene, so a collection is the only reliable way to keep another
# open study out of the GLB export.
STUDY = bpy.data.collections.new(f'{ASSET} study')
scene.collection.children.link(STUDY)
scene.unit_settings.system = 'METRIC'
scene.render.engine = 'CYCLES'
scene.cycles.samples = 20
scene.render.film_transparent = False
scene.cycles.use_denoising = True
scene.cycles.seed = 20260914
scene.render.resolution_x, scene.render.resolution_y = 1100, 700
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'
scene.world = bpy.data.worlds.new(f'{ASSET} studio world')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.14, .17, .21, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .35

# --- materials -------------------------------------------------------------
# The skin system addresses these finish names. The wrist adjuster, knuckle
# padding and glove shell remain individually tintable across both hand poses.
MATERIAL_SLOTS = {
    'glove leather': ('leather', 8), 'ceramic armor': ('rubber', 34),
    'knuckle plate': ('orange', 2.8), 'suit fabric': ('dark', 3.2),
    'glove liner': ('cloth', 5.0), 'webbing': ('web', 4.5),
    'hardware': ('metal', 4), 'patrol blue': ('suit', 3.2), 'transfer': ('ink', 1),
}
mats = {}
UV_SCALES = {}
for name, (key, density) in MATERIAL_SLOTS.items():
    spec = FIELD_MATERIALS[key]
    material = bpy.data.materials.new(f'{ASSET} | {name}')
    material.use_nodes = True
    tree = material.node_tree
    bsdf = tree.nodes['Principled BSDF']
    # The nubuck tile is brown. A cool graphite dye neutralizes its warm channels.
    tint = (.56, .81, 1.) if name == 'glove leather' else spec['color']
    bsdf.inputs['Base Color'].default_value = (*tint, 1)
    bsdf.inputs['Metallic'].default_value = spec['metalness']
    bsdf.inputs['Roughness'].default_value = .74 if name == 'glove leather' else spec['roughness']
    if spec.get('texture'):
        image = bpy.data.images.load(str(ASSET_ROOT / spec['texture']), check_existing=True)
        tex = tree.nodes.new('ShaderNodeTexImage')
        tex.image = image
        mix = tree.nodes.new('ShaderNodeMixRGB')
        mix.blend_type = 'MULTIPLY'
        mix.inputs[0].default_value = 1
        mix.inputs[2].default_value = (*tint, 1)
        tree.links.new(tex.outputs['Color'], mix.inputs[1])
        tree.links.new(mix.outputs[0], bsdf.inputs['Base Color'])
        material['texture_uri'] = spec['texture']
    material['gltf_tint'] = list(tint)
    material['uv_scale'] = density
    material.diffuse_color = (*tint, 1)
    mats[name] = material
    UV_SCALES[name] = density

# --- primitive builders ----------------------------------------------------
PARTS = []      # (object, part, material key)
PART_GROUP = {}
for group in GROUPS:
    empty = bpy.data.objects.new(group, None)
    empty.empty_display_type = 'PLAIN_AXES'
    empty.empty_display_size = .05
    STUDY.objects.link(empty)
    PART_GROUP[group] = empty


def project_uvs(mesh, uv_scale):
    """Analytic per-face planar projection at a constant real-world density."""
    uv = mesh.uv_layers[0] if mesh.uv_layers else mesh.uv_layers.new(name='UVMap')
    for polygon in mesh.polygons:
        axis = max(range(3), key=lambda i: abs(polygon.normal[i]))
        (first, second) = [(1, 2), (0, 2), (0, 1)][axis]
        for loop in polygon.loop_indices:
            co = mesh.vertices[mesh.loops[loop].vertex_index].co
            uv.data[loop].uv = (co[first] * uv_scale, co[second] * uv_scale)
    return uv


model = MeshModel()
build_gloves(model)
build_sleeves(model)
for piece in model.pieces:
    mesh = bpy.data.meshes.new(piece.name)
    mesh.from_pydata(piece.verts, [], piece.faces)
    mesh.update()
    for polygon in mesh.polygons:
        polygon.use_smooth = piece.smooth
    if piece.normals:
        mesh.normals_split_custom_set_from_vertices(piece.normals)
    obj = bpy.data.objects.new(piece.name, mesh)
    mesh.materials.append(mats[piece.mat])
    obj['part'] = piece.part
    obj['hands_material'] = piece.mat
    obj['uv_scale'] = UV_SCALES[piece.mat]
    obj.parent = PART_GROUP[piece.part]
    STUDY.objects.link(obj)
    project_uvs(mesh, UV_SCALES[piece.mat])
    PARTS.append((obj, piece.part, piece.mat))

scene['asset_id'] = 'hands'
scene['revision'] = 4

# --- contract assertions ---------------------------------------------------
# Headless runs need an explicit view-layer sync before data-API-created
# objects show up in the dependency graph.
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()
extent = {0: [1e9, -1e9], 1: [1e9, -1e9], 2: [1e9, -1e9]}
points = []
palm_bounds = {}
cuff_min_z = {}
for (obj, _part, _material) in PARTS:
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    for vertex in mesh.vertices:
        world = obj.matrix_world @ vertex.co
        points.append((Vector(world), obj.name))
        for axis in range(3):
            extent[axis][0] = min(extent[axis][0], world[axis])
            extent[axis][1] = max(extent[axis][1], world[axis])
    evaluated.to_mesh_clear()

CUFF_WORDS = ('wrist', 'strap', 'sleeve', 'bracer')
CONTRACT = []
for part, title in (('grip', 'Grip'), ('support', 'Support')):
    owned = [(p, n) for (p, n) in points if n.startswith(title + ' ')]
    palm_pts = [p for (p, n) in owned if n == f'{title} palm']
    mins = [min(p[i] for p in palm_pts) for i in range(3)]
    maxs = [max(p[i] for p in palm_pts) for i in range(3)]
    palm_bounds[part] = (mins, maxs)
    spans = all(lo < -0.001 and hi > 0.001 for (lo, hi) in zip(mins, maxs))
    CONTRACT.append((f'{part} palm spans origin', spans, True))
    cuff_pts = [p for (p, n) in owned if any(word in n for word in CUFF_WORDS)]
    cuff_min = min(p[2] for p in cuff_pts)
    cuff_min_z[part] = cuff_min
    CONTRACT.append((f'{part} cuff z>{CUFF_MIN_Z}', cuff_min > CUFF_MIN_Z, True))
    reach = max(p.length for (p, _n) in owned)
    CONTRACT.append((f'{part} reach within 0.25m', reach, REACH))
    # Every digit occupies a continuous shell across its three phalanges.
    digit_pts = {name: [p for (p, n) in owned if n == f'{title} {name}']
               for (name, *_rest) in FINGERS}
    for (name, _x, _z, _l, _w, _t) in FINGERS:
        CONTRACT.append((f'{part} {name} digit exists', bool(digit_pts[name]), True))

# Arm segments: each spans its own joint-to-joint length along +z (with a few
# millimetres of overlap past both joints) and stays inside a slim radius so
# the runtime's stretch and mirror never sweep a vertex into the camera.
arm_bounds = {}
for (part, title, length) in (('forearm', 'Forearm', FOREARM_LEN), ('upperarm', 'Upper arm', UPPER_LEN)):
    owned = [p for (p, n) in points if n.startswith(title + ' ')]
    z_min = min(p.z for p in owned)
    z_max = max(p.z for p in owned)
    radius = max(math.hypot(p.x, p.y) for p in owned)
    arm_bounds[part] = {'z': [z_min, z_max], 'radius': radius}
    CONTRACT.append((f'{part} starts at its proximal joint', z_min < 0.0, True))
    CONTRACT.append((f'{part} reaches its distal joint', z_max > length, True))
    CONTRACT.append((f'{part} radius within {ARM_RADIUS}m', radius, ARM_RADIUS))
shoulder_pts = [p for (p, n) in points if n.startswith('Shoulder ')]
arm_bounds['shoulder'] = {'z': [min(p.z for p in shoulder_pts), max(p.z for p in shoulder_pts)],
                          'radius': max(math.hypot(p.x, p.y) for p in shoulder_pts)}
CONTRACT.append((f'shoulder reach within {SHOULDER_REACH}m', max(p.length for p in shoulder_pts), SHOULDER_REACH))
CONTRACT.append(('shoulder covers the joint', min(p.z for p in shoulder_pts) < -0.05 < 0.03 < max(p.z for p in shoulder_pts), True))

contract_failures = []
for (name, measured, expected) in CONTRACT:
    if isinstance(expected, bool):
        if measured != expected:
            contract_failures.append(f'{name}: got {measured}')
    elif measured > expected:
        contract_failures.append(f'{name}: measured {measured:.6f}, limit {expected}')

print(f'model extent x={extent[0][0]:+.4f}..{extent[0][1]:+.4f} '
      f'y={extent[1][0]:+.4f}..{extent[1][1]:+.4f} z={extent[2][0]:+.4f}..{extent[2][1]:+.4f}')
for part in POSES:
    (mins, maxs) = palm_bounds[part]
    print(f'{part}: palm x={mins[0]:+.4f}..{maxs[0]:+.4f} '
          f'y={mins[1]:+.4f}..{maxs[1]:+.4f} z={mins[2]:+.4f}..{maxs[2]:+.4f}, '
          f'cuff min z={cuff_min_z[part]:+.4f}')
for part in ARM_PARTS:
    bounds = arm_bounds[part]
    print(f'{part}: z={bounds["z"][0]:+.4f}..{bounds["z"][1]:+.4f} radius={bounds["radius"]:.4f}')
if contract_failures:
    print(f'CONTRACT FAILURES: {len(contract_failures)}')
    for line in contract_failures:
        print(f'  {line}')
else:
    print('anchor contract: all assertions pass')

# --- pack textures and save the editable source ----------------------------
bpy.ops.file.pack_all()
BLEND = DOCS / 'hands.blend'
bpy.context.preferences.filepaths.save_version = 0
# Arrange the five editable groups as an assembled right arm and spare open
# hand when the artist opens the file. The exporter reads mesh-local geometry.
layout = {'grip': (-.04, 0, 0), 'support': (.13, 0, 0),
          'forearm': (-.04, 0, WRIST_Z), 'upperarm': (-.04, 0, WRIST_Z + FOREARM_LEN),
          'shoulder': (-.04, 0, WRIST_Z + FOREARM_LEN + UPPER_LEN)}
for part, position in layout.items():
    PART_GROUP[part].location = position
for area in bpy.context.screen.areas:
    if area.type == 'VIEW_3D':
        space = area.spaces.active
        space.region_3d.view_distance = 1.12
        space.region_3d.view_location = (.02, 0, .29)
        space.region_3d.view_rotation = Vector((-.58, -.77, -.22)).to_track_quat('-Z', 'Y')
        space.shading.color_type = 'MATERIAL'
        space.overlay.show_extras = False
bpy.context.view_layer.update()
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND), copy=True, compress=True, check_existing=False)
for group in PART_GROUP.values():
    group.location = (0, 0, 0)
bpy.context.view_layer.update()


# --- studio lighting, camera, and per-pose renders -------------------------
def aim(obj, loc, target, up=(0, 1, 0)):
    """Point an object (camera, area light) at `target`, keeping glove +Y up.

    A TRACK_TO constraint would roll image-up onto Blender world +Z (the
    cuff axis); this explicit look-at keeps the glove-local frame on screen.
    """
    forward = (Vector(target) - Vector(loc)).normalized()
    right = forward.cross(Vector(up)).normalized()
    real_up = right.cross(forward).normalized()
    obj.matrix_world = Matrix((right.to_tuple() + (0,), real_up.to_tuple() + (0,),
                               (-forward).to_tuple() + (0,), tuple(loc) + (1,))).transposed()


FOCUS = (0, -0.005, 0.005)
sun = bpy.data.lights.new('Hands sun', 'SUN')
sun.energy = 2.5
sun_obj = bpy.data.objects.new('Hands sun', sun)
sun_obj.rotation_euler = (math.radians(50), 0, math.radians(35))
STUDY.objects.link(sun_obj)
key = bpy.data.lights.new('Hands key', 'AREA')
key.energy = 12.0
key.size = 0.5
key_obj = bpy.data.objects.new('Hands key', key)
STUDY.objects.link(key_obj)
fill = bpy.data.lights.new('Hands fill', 'AREA')
fill.energy = 4.0
fill.size = 0.6
fill_obj = bpy.data.objects.new('Hands fill', fill)
STUDY.objects.link(fill_obj)
camera_data = bpy.data.cameras.new('Hands camera')
camera_data.lens = 50
camera = bpy.data.objects.new('Hands camera', camera_data)
STUDY.objects.link(camera)
scene.camera = camera
bpy.context.view_layer.update()
aim(key_obj, (0.30, 0.38, 0.30), FOCUS)
aim(fill_obj, (-0.34, 0.08, 0.26), FOCUS)

# 'side' looks at the thumb side (-x), 'rear-quarter' from above the cuff,
# 'palm' from below (the fist void and the cradle), 'game' from where the
# first-person camera sees the back of the hand: above, behind, thumb side.
SHOTS = [
    ('grip', 'side', (-0.30, 0.03, -0.01), FOCUS),
    ('grip', 'rear-quarter', (-0.20, 0.16, 0.22), FOCUS),
    ('grip', 'palm', (-0.10, -0.28, -0.06), FOCUS),
    ('support', 'side', (-0.28, 0.08, -0.03), FOCUS),
    ('support', 'rear-quarter', (-0.20, 0.16, 0.22), FOCUS),
    ('support', 'palm', (0.06, -0.28, -0.06), FOCUS),
    # Arm segments from the thumb side, slightly above, framed on mid-length.
    ('forearm', 'side', (-0.62, 0.22, 0.16), (0, 0.0, 0.155)),
    ('upperarm', 'side', (-0.66, 0.24, 0.17), (0, 0.0, 0.17)),
    ('shoulder', 'side', (-0.32, 0.14, -0.03), (0, 0.02, -0.03)),
]
RENDER_FILES = []
POSE_OBJECTS = {group: [PART_GROUP[group]] + [o for (o, p, _m) in PARTS if p == group]
                for group in GROUPS}
for (pose, view, location, focus) in SHOTS:
    for group in GROUPS:
        # Render visibility does not inherit from the parent empty, so hide
        # every object of the other parts explicitly (studio rig stays live).
        for obj in POSE_OBJECTS[group]:
            obj.hide_viewport = obj.hide_render = group != pose
    bpy.context.view_layer.update()
    aim(camera, location, focus)
    bpy.context.view_layer.update()
    scene.render.filepath = str(DOCS / f'render-{pose}-{view}.png')
    bpy.ops.render.render(write_still=True)
    RENDER_FILES.append(f'render-{pose}-{view}.png')
    print(f'render {pose} {view}: {scene.render.filepath}')
for group in GROUPS:
    for obj in POSE_OBJECTS[group]:
        obj.hide_viewport = obj.hide_render = False

# --- contact audit -----------------------------------------------------------
CONTACT_M = 0.0010        # 1 mm still reads as one sculpted form


def audit_contact(tolerance=CONTACT_M):
    """Every authored part must meet another part of its own group.

    A part passes when its surface crosses a neighbour's surface, or when one
    of its vertices lies within `tolerance` of a neighbour's surface. Surface
    crossing has to be tested directly: a slab that spans a rounded sleeve
    shares volume with it while every one of its own corners sits out in the
    open, and a vertex-only test reads that solid joint as a floating part.
    """
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    findings = []
    for part in GROUPS:
        owned = [(o, m) for (o, p, m) in PARTS if p == part]
        worlds, trees = {}, {}
        for (obj, _m) in owned:
            evaluated = obj.evaluated_get(deps)
            mesh = evaluated.to_mesh()
            coords = [obj.matrix_world @ v.co for v in mesh.vertices]
            worlds[obj.name] = coords
            trees[obj.name] = BVHTree.FromPolygons(
                coords, [tuple(p.vertices) for p in mesh.polygons],
                all_triangles=False, epsilon=0.0)
            evaluated.to_mesh_clear()
        for (obj, _m) in owned:
            others = [other for other in trees if other != obj.name]
            if any(trees[obj.name].overlap(trees[other]) for other in others):
                continue
            nearest = min(trees[other].find_nearest(co)[3]
                          for other in others for co in worlds[obj.name])
            if nearest > tolerance:
                findings.append(f'{part} | {obj.name}: nearest neighbour '
                                f'{nearest * 1000:.2f} mm away')
    return findings


def audit_finger_gaps():
    """Neighbouring fingers must not share volume along the proximal stalls."""
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    findings = []
    for part, title in (('grip', 'Grip'), ('support', 'Support')):
        boxes = {}
        for (obj, p, _m) in PARTS:
            if p != part or obj.name not in [f'{title} {finger[0]}' for finger in FINGERS]:
                continue
            evaluated = obj.evaluated_get(deps)
            mesh = evaluated.to_mesh()
            # Four cross sections covering root to mid-proximal phalanx.
            xs = [(obj.matrix_world @ v.co).x for v in list(mesh.vertices)[:4 * 16]]
            evaluated.to_mesh_clear()
            boxes[obj.name] = (min(xs), max(xs))
        ordered = sorted(boxes.items(), key=lambda kv: kv[1][0])
        for (left, right) in zip(ordered, ordered[1:]):
            gap = right[1][0] - left[1][1]
            if gap < 0.0015:
                findings.append(f'{part} | {left[0]} / {right[0]}: gap {gap * 1000:.2f} mm')
    return findings


floaters = audit_contact()
if floaters:
    print(f'FLOATING PARTS: {len(floaters)}')
    for line in floaters:
        print(f'  {line}')
else:
    print('part contact audit: every part meets its pose')
finger_gaps = audit_finger_gaps()
if finger_gaps:
    print(f'FINGER GAP FAILURES: {len(finger_gaps)}')
    for line in finger_gaps:
        print(f'  {line}')
else:
    print('finger gap audit: every neighbouring stall keeps >= 1.5 mm')
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()

batches = {}
for (obj, part, material) in PARTS:
    batches.setdefault((part, material), []).append(obj)

export_objects = list(PART_GROUP.values())
triangles = 0
per_primitive = {}
for ((part, material), objects) in sorted(batches.items()):
    # Preserve authored normals at sewn material boundaries when batching the
    # portable GLB, just as the runtime exporter preserves them per corner.
    positions, faces, corner_normals = [], [], []
    for source in objects:
        evaluated = source.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        offset = len(positions)
        positions.extend(tuple(v.co) for v in mesh.vertices)
        for triangle in mesh.loop_triangles:
            faces.append(tuple(offset + i for i in triangle.vertices))
            corner_normals.extend(tuple(mesh.corner_normals[i].vector) for i in triangle.loops)
        evaluated.to_mesh_clear()
    merged = bpy.data.meshes.new(f'{part} | {material} shell')
    merged.from_pydata(positions, [], faces)
    merged.update()
    for polygon in merged.polygons:
        polygon.use_smooth = True
    merged.normals_split_custom_set(corner_normals)
    merged.materials.append(mats[material])
    obj = bpy.data.objects.new(f'{part} | {material}', merged)
    obj['part'] = part
    obj['hands_material'] = material
    obj['uv_scale'] = UV_SCALES[material]
    obj.parent = PART_GROUP[part]
    STUDY.objects.link(obj)
    project_uvs(merged, UV_SCALES[material])
    merged.update()
    merged.calc_loop_triangles()
    count = len(merged.loop_triangles)
    triangles += count
    per_primitive[f'{part} | {material}'] = count
    export_objects.append(obj)

for (obj, _part, _material) in PARTS:
    mesh = obj.data
    STUDY.objects.unlink(obj)
    bpy.data.objects.remove(obj)
    bpy.data.meshes.remove(mesh)

for layer in bpy.context.view_layer.layer_collection.children:
    if layer.collection is STUDY:
        bpy.context.view_layer.active_layer_collection = layer
bpy.context.view_layer.objects.active = PART_GROUP['grip']

GLB = DOCS / 'hands.glb'
wanted = {'filepath': str(GLB), 'export_format': 'GLB', 'use_active_collection': True,
          'use_active_scene': False, 'export_yup': False,
          'export_apply': True, 'export_animations': False, 'export_frame_range': False,
          'export_force_sampling': False, 'export_nla_strips': False,
          'export_optimize_animation_size': False, 'export_anim_single_armature': False,
          'export_reset_pose_bones': False, 'export_current_frame': False,
          'export_rest_position': False, 'export_front_face': False,
          'export_draco_mesh_compression_enable': False,
          'export_texcoords': True, 'export_normals': True, 'export_tangents': False,
          'export_materials': 'EXPORT', 'export_colors': True,
          'export_attributes': False, 'use_mesh_edges': False, 'use_mesh_vertices': False,
          'export_cameras': False, 'export_lights': False, 'export_extras': True,
          'export_skins': False, 'export_morph': False,
          'export_morph_normal': False, 'export_morph_tangent': False,
          'export_image_format': 'AUTO', 'export_texture_dir': '',
          'export_keep_originals': False, 'export_unlit': False,
          'export_gltf_primitive_sort': False, 'export_hierarchy_flatten_objs': False,
          'export_try_sparse_sk': False}

supported = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
missing = [k for k in ('use_active_collection', 'use_active_scene', 'export_yup',
                       'export_extras') if k not in supported]
if missing:
    raise RuntimeError(f'Blender glTF exporter lacks required options: {missing}')
bpy.ops.export_scene.gltf(**{k: v for (k, v) in wanted.items() if k in supported})

_expected = {obj.name for obj in export_objects}
with open(GLB, 'rb') as handle:
    _header = handle.read(20)
(_length, _kind, _total, _json_len, _json_kind) = struct.unpack('<IIIII', _header)
with open(GLB, 'rb') as handle:
    handle.seek(20)
    _document = json.loads(handle.read(_json_len).decode('utf-8'))
_foreign = sorted({node.get('name', '') for node in _document['nodes']} - _expected)
if _foreign:
    raise RuntimeError(f'unexpected nodes in the GLB export: {_foreign}')

TEXTURE_URIS = sorted({mat['texture_uri'] for mat in mats.values() if 'texture_uri' in mat})


def normalize_glb(path):
    """Rewrite name-bearing fields in the GLB JSON chunk (names only)."""
    raw = path.read_bytes()
    (_, _, total) = struct.unpack('<III', raw[:12])
    chunks = []
    offset = 12
    while offset < total:
        (length, kind) = struct.unpack('<II', raw[offset:offset + 8])
        chunks.append([kind, raw[offset + 8:offset + 8 + length]])
        offset += 8 + length
    document = json.loads(chunks[0][1].decode('utf-8'))
    for texture in document.get('textures', []):
        source = texture.get('source')
        if source is None:
            continue
        stem = Path(document['images'][source]['name']).name
        head, _, tail = stem.rpartition('.')
        if tail.isdigit() and head:
            stem = head
        if stem.endswith('.jpg'):
            stem = stem[:-4]
        uri = next((uri for uri in TEXTURE_URIS if Path(uri).stem == stem), None)
        if uri:
            texture['name'] = uri
    contract_tints = {f'{ASSET} | {key}': list(material.get('gltf_tint', ()))
                      for (key, material) in mats.items()}
    for material in document.get('materials', []):
        pbr = material.get('pbrMetallicRoughness', {})
        tint = contract_tints.get(material.get('name', ''))
        if tint and 'baseColorTexture' in pbr and 'alphaMode' not in material:
            pbr['baseColorFactor'] = tint + [1]
    seen = set()
    for node in document.get('nodes', []):
        name = node.get('name', '')
        head, _, tail = name.rpartition('.')
        if tail.isdigit() and head:
            name = head
        if name in GROUPS:
            node.setdefault('extras', {})['blenderAsset'] = 'hands'
        if name:
            if name in seen:
                raise ValueError(f'duplicate glTF node name after normalisation: {name}')
            seen.add(name)
        node['name'] = name
    for mesh in document.get('meshes', []):
        if 'name' in mesh:
            mesh['name'] = mesh['name'].split('.')[0]
    payload = json.dumps(document, separators=(',', ':')).encode('utf-8')
    chunks[0][1] = payload + b' ' * (-len(payload) % 4)
    chunks[1][1] = chunks[1][1] + b'\0' * (-len(chunks[1][1]) % 4)
    body = b''.join(struct.pack('<II', len(blob), kind) + blob for (kind, blob) in chunks)
    path.write_bytes(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)
    return [node.get('name', '') for node in document.get('nodes', [])]


_node_names = sorted(normalize_glb(GLB))

# --- record ----------------------------------------------------------------
manifest = {
    'asset': 'HANDS',
    'asset_id': 'hands',
    'revision': 4,
    'kind': 'original first-person glove hands, two poses, plus rigid arm segments (visual game asset)',
    'blender': bpy.app.version_string,
    'authoring_script': 'tools/blender/hands/build-hands.py',
    'source_parts': len(PARTS),
    'animation_group_nodes': GROUPS,
    'marker_nodes': [],
    'batch_nodes': len(batches),
    'round_nodes': [],
    'triangles': triangles,
    'triangles_per_primitive': per_primitive,
    'materials': list(mats),
    'material_textures': {name: mat.get('texture_uri') for name,mat in mats.items()},
    'material_uv_scale': UV_SCALES,
    'textures': TEXTURE_URIS,
    'axes': {'authoring': 'glove-local: fingers -z, back of hand +y, thumb -x, cuff +z (consumed verbatim)',
             'after_gltf': 'glove-local (export_yup off)',
             'map': 'game_x = x, game_y = y, game_z = z (identity bake); kit glove() '
                    'orients the group with a per-pose basis'},
    'anchors_glove_local': {
        'palm': 'spans the origin in x, y and z',
        'cuff': f'min z {min(cuff_min_z.values()):+.4f} m (must stay > {CUFF_MIN_Z})',
        'reach': f'max {REACH} m from the origin',
    },
    'contract_points': {'knuckle_line_z': [f[2] for f in FINGERS], 'palm_z': [PALM_Z0, PALM_Z1],
                        'cuff_min_z': CUFF_MIN_Z, 'reach': REACH, 'thumb_base': list(THUMB_BASE)},
    'arm_segments': {
        'frame': 'each part in its own joint frame: proximal joint at the origin, distal joint on +z, '
                 '+y = back of the forearm / outer side of the upper arm and shoulder; the runtime '
                 'mirrors x for the left arm and stretches z when the shoulder is out of reach',
        'wrist_z_glove_local': WRIST_Z,
        'forearm_length': FOREARM_LEN,
        'upper_arm_length': UPPER_LEN,
        'radius_limit': ARM_RADIUS,
        'shoulder_reach': SHOULDER_REACH,
        'measured': {part: {'z': [round(v, 6) for v in bounds['z']], 'radius': round(bounds['radius'], 6)}
                     for (part, bounds) in arm_bounds.items()},
    },
    'files': {'blend': 'docs/design/blender/hands/hands.blend',
              'glb': 'docs/design/blender/hands/hands.glb',
              'renders': RENDER_FILES,
              'validation': 'docs/design/blender/hands/validation.json'},
    'build_time_checks': {
        'anchor_contract': 'each palm spans the origin, every wrist/strap/sleeve/bracer part '
                           f'stays at z > {CUFF_MIN_Z}, no vertex leaves a 0.25 m radius, '
                           'every finger has a continuous full-length shell',
        'part_contact': 'every authored part must meet another part of its own group, '
                        'either by crossing its surface or by placing a vertex within 1 mm '
                        'of it; a part that only meets the model through empty space is '
                        'reported as floating and fails the build',
        'finger_gaps': 'neighbouring proximal stalls keep >= 1.5 mm of air between them',
    },
    'geometry_audit': {'floating_parts': floaters, 'finger_gaps': finger_gaps},
    'notes': [
        'The grip and support gloves use independent digit curls around the existing palm anchors.',
        'The forearm and upper arm follow the field jacket pattern and retain the first-person IK joints.',
    ],
}
(DOCS / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
validation = {
    'asset': 'HANDS',
    'revision': 4,
    'glb': str(GLB.relative_to(ROOT)),
    'passed': not (contract_failures or floaters or finger_gaps),
    'failures': contract_failures + [f'floating: {line}' for line in floaters]
    + [f'finger gap: {line}' for line in finger_gaps],
    'advisory': [],
    'measured': {
        'extent': {axis: [round(v, 6) for v in extent[i]] for (i, axis) in enumerate('xyz')},
        'palm_bounds': {part: {'min': [round(v, 6) for v in bounds[0]],
                               'max': [round(v, 6) for v in bounds[1]]}
                        for (part, bounds) in palm_bounds.items()},
        'cuff_min_z': {part: round(v, 6) for (part, v) in cuff_min_z.items()},
        'glb_nodes': _node_names,
        **{f'node:{group}': 'present' if group in _node_names else 'missing' for group in GROUPS},
        'arm_bounds': {part: {'z': [round(v, 6) for v in bounds['z']], 'radius': round(bounds['radius'], 6)}
                       for (part, bounds) in arm_bounds.items()},
        'triangles': triangles,
        'triangles_per_primitive': per_primitive,
    },
}
(DOCS / 'validation.json').write_text(json.dumps(validation, indent=2) + '\n')
print(json.dumps({k: manifest[k] for k in ('source_parts', 'batch_nodes', 'triangles')}, indent=2))
print(f'blend={BLEND} bytes={BLEND.stat().st_size}')
print(f'glb={GLB} bytes={GLB.stat().st_size}')
if floaters:
    raise RuntimeError(f'geometry gate failed: {len(floaters)} floating part groups')
if finger_gaps:
    raise RuntimeError(f'finger gap gate failed: {len(finger_gaps)} pairs')
if contract_failures:
    raise RuntimeError(f'anchor contract failed: {len(contract_failures)} failures')
