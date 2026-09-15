"""Author HANDS, original first-person glove hands for Voxel Blitz (revision 3).

Two right-hand poses in the glove-local frame the runtime consumes directly:
palm at origin, fingers toward -z, back of the hand toward +y, thumb toward
-x, cuff and forearm toward +z, metres. `grip` (fist wrapped around a pistol
grip, thumb laid over the fingers) and `support` (open cradle with relaxed
fingers and an extended thumb). Both poses live in one study as the two
top-level part nodes `grip` / `support`; no markers or rounds are needed.
kit glove() mirrors the same geometry for the left hand.

Revision 3 moves the sleeve off the glove and adds three rigid arm segments
as their own top-level part nodes so the runtime can pose a two-bone arm from
each glove back to the shoulder of the first-person body
(`public/js/guns/viewmodel-arms.js`):

    forearm   wrist joint at the origin, elbow at +z FOREARM_LEN
              (suit sleeve, webbing strap, ivory bracer with orange inset,
              leather elbow pad); +y is the back of the forearm and follows
              the back of the hand
    upperarm  elbow at the origin, shoulder joint at +z UPPER_LEN
              (leather elbow cap, suit sleeve, webbing band, ivory plate with
              orange inset); +y is the outer/upper side
    shoulder  shoulder joint at the origin, same axes as the upper arm
              (suit cap, orange pauldron on an ivory rim, gunmetal rivet)

The glove itself ends at the sleeve hem (glove-local z <= 0.076); the forearm
mounts at WRIST_Z on the glove's +z axis and is stretched along z by the
runtime when the shoulder is out of reach.

Frame note: gun studies author z-up and rotate into game space on export.
Hands skip that rotation on purpose: the runtime places the glove group with
an explicit basis (back-of-hand and knuckle directions per pose), so the
Blender geometry is authored in the consumed axes and the runtime exporter
bakes vertices verbatim (GAME = identity). The portable GLB is exported with
export_yup=False so it agrees with the runtime files.

Revision 2 replaces the first study, whose fingers left the palm straight
(no flexion at the base knuckle), wore ball joints that read as warts, and
whose cuff carried a 3.6 tiles/m weave that looked like wicker at first-person
size. The hand now matches the RIVET operator: graphite half-finger gloves
with exposed skin past the first knuckle, an orange knuckle plate and ivory
finger armor, a sand webbing wrist strap, the petrol suit sleeve and the
ivory forearm bracer with its orange inset. Every material carries its own
texture density (`uv_scale` custom property, read by the exporter).

Run headless (the repo's own convention for long Blender work):

    blender --background --factory-startup --python tools/blender/hands/build-hands.py

Geometry is closed convex primitives (no booleans, no negative scales),
chamfered by a bevel modifier; winding is repaired with recalc_face_normals
and UVs are an analytic per-face projection of the two non-dominant axes.
Every joint overlaps volumetrically by >= 2 mm: butt-jointed flush faces
z-fight once same-material parts merge into one draw call.

Outputs (owned by this task):
    docs/design/blender/hands/hands.blend   editable, textures packed
    docs/design/blender/hands/hands.glb     portable GLB, images embedded
    docs/design/blender/hands/manifest.json    machine-readable record
    docs/design/blender/hands/validation.json  build-time checks record
    docs/design/blender/hands/render-*.png  side + rear-quarter + game view per pose
"""
import bmesh
import bpy
import json
import math
import struct
from pathlib import Path
from mathutils import Euler, Matrix, Vector
from mathutils.bvhtree import BVHTree
ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / 'docs/design/blender/hands'
INK = ROOT / 'public/assets/blender/textures'
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
# -z before they flex; wrist, strap, sleeve and bracer at z > 0. Nothing may
# leave a 0.25 m radius: the longest reach is the sleeve flare (~0.245 m).
PALM_Z0, PALM_Z1 = -0.046, 0.030   # knuckle edge .. wrist heel
KNUCKLE_Y = 0.003                  # finger base height
CUFF_MIN_Z = 0.018                 # every strap/sleeve part starts past this plane
REACH = 0.25


def srgb_to_linear(triplet):
    """sRGB 0..1 triple to linear working space (matches THREE.Color)."""
    out = []
    for channel in triplet:
        if channel <= 0.04045:
            out.append(channel / 12.92)
        else:
            out.append(((channel + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def hex_rgb(value):
    return ((value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255)


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
scene.cycles.samples = 32
scene.cycles.use_denoising = True
scene.cycles.seed = 20260914
scene.render.resolution_x, scene.render.resolution_y = 1280, 800
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'
scene.world = bpy.data.worlds.new(f'{ASSET} studio world')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.14, .17, .21, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .35

# --- materials -------------------------------------------------------------
# RIVET's kit, on the delivered ImageGen maps with multiply tints (no new
# images). Tints are converted to linear space so the portable GLB and the
# runtime agree through baseColorFactor. The maps are mid-grey to dark, so
# the tints sit brighter than the intended on-screen colour: graphite leather
# reads ~0x22252a after the worn-rubber map multiplies in. kit glove() keys
# the character-skin palette on the material name, not on this tint.
#   (name, texture stem, metallic, roughness, tint sRGB, tiles per metre)
MATERIALS = [
    ('glove leather', 'worn-rubber', 0.0, .80, hex_rgb(0x7a8088), 7.0),
    ('ceramic armor', 'ivory-armor', .12, .40, hex_rgb(0xf4f2ea), 4.0),
    ('knuckle plate', 'orange-painted-metal', .22, .38, hex_rgb(0xffffff), 4.0),
    ('suit fabric', 'petrol-ballistic-fabric', 0.0, .88, hex_rgb(0xb4bec4), 9.0),
    ('webbing', 'tan-webbing', 0.0, .90, hex_rgb(0xb09a72), 15.0),
    ('hardware', 'worn-gunmetal', .70, .36, hex_rgb(0xd8dce0), 6.0),
    ('skin', 'ivory-armor', 0.0, .62, hex_rgb(0xd9a07c), 5.0),
]
mats = {}
UV_SCALES = {}
for name, stem, metal, rough, srgb, uv_scale in MATERIALS:
    tint = srgb_to_linear(srgb)
    material = bpy.data.materials.new(f'{ASSET} | {name}')
    material.use_nodes = True
    tree = material.node_tree
    bsdf = tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*tint, 1)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    image = bpy.data.images.load(str(INK / f'{stem}.jpg'), check_existing=False)
    image.name = f'textures/{stem}.jpg'
    image.colorspace_settings.name = 'sRGB'
    tex = tree.nodes.new('ShaderNodeTexImage')
    tex.image = image
    tex.location = (-420, 120)
    tex.interpolation = 'Smart'
    tint_node = tree.nodes.new('ShaderNodeMixRGB')
    tint_node.blend_type = 'MULTIPLY'
    tint_node.label = 'delivered map tint'
    tint_node.location = (-180, 120)
    tint_node.inputs['Factor'].default_value = 1.0
    tint_node.inputs['Color2'].default_value = (*tint, 1)
    tree.links.new(tex.outputs['Color'], tint_node.inputs['Color1'])
    tree.links.new(tint_node.outputs['Color'], bsdf.inputs['Base Color'])
    material['imagegen_texture'] = f'{stem}.jpg'
    material['gltf_tint'] = list(tint)
    material['uv_scale'] = uv_scale
    mats[name] = material
    UV_SCALES[name] = uv_scale

# --- primitive builders ----------------------------------------------------
PARTS = []      # (object, part, material key)
PART_GROUP = {}
for group in GROUPS:
    empty = bpy.data.objects.new(group, None)
    empty.empty_display_type = 'PLAIN_AXES'
    empty.empty_display_size = .05
    STUDY.objects.link(empty)
    PART_GROUP[group] = empty


def boxv(size):
    """Closed axis-aligned box of size (x, y, z) centred on the origin."""
    (hx, hy, hz) = (size[0] / 2, size[1] / 2, size[2] / 2)
    verts = [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz),
             (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]
    faces = [(3, 2, 1, 0), (4, 5, 6, 7),
             (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return verts, faces


def flared_box(hx0, hy0, hx1, hy1, z0, z1, y0=0.0, y1=0.0):
    """Closed tapered box along Z: half-extents (hx0, hy0) at z0, (hx1, hy1) at z1.

    `y0`/`y1` shift the section centres so a slab can climb or dip along its
    length (the back of the hand rises toward the knuckles).
    """
    verts = [(-hx0, y0 - hy0, z0), (hx0, y0 - hy0, z0), (hx0, y0 + hy0, z0), (-hx0, y0 + hy0, z0),
             (-hx1, y1 - hy1, z1), (hx1, y1 - hy1, z1), (hx1, y1 + hy1, z1), (-hx1, y1 + hy1, z1)]
    faces = [(3, 2, 1, 0), (4, 5, 6, 7),
             (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return verts, faces


def octagon_tube(rx, ry, length, z0, rx1=None, ry1=None):
    """Closed eight-sided prism along +Z from z0 (rounded sleeve section).

    `rx1`/`ry1` taper the far ring so a sleeve can widen toward the elbow.
    """
    rx1 = rx if rx1 is None else rx1
    ry1 = ry if ry1 is None else ry1
    ring, far = [], []
    for i in range(8):
        a = math.pi / 8 + i * math.pi / 4
        ring.append((rx * math.cos(a), ry * math.sin(a)))
        far.append((rx1 * math.cos(a), ry1 * math.sin(a)))
    verts = [(x, y, z0) for (x, y) in ring] + [(x, y, z0 + length) for (x, y) in far]
    faces = [tuple(range(7, -1, -1)), tuple(range(8, 16))]
    for i in range(8):
        j = (i + 1) % 8
        faces.append((i, j, 8 + j, 8 + i))
    return verts, faces


def z_to(direction):
    """Euler rotating local +Z onto `direction`."""
    return tuple(Vector((0, 0, 1)).rotation_difference(Vector(direction)).to_euler())


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


def add(name, part, material, shape, loc=(0, 0, 0), rot=(0, 0, 0), bevel=.003, segments=2):
    """Create one chamfered, UV-mapped part."""
    (base_verts, faces) = shape
    mesh = bpy.data.meshes.new(f'{name} shell')
    mesh.from_pydata(base_verts, [], faces)
    mesh.validate()
    matrix = Matrix.LocRotScale(Vector(loc), Euler(rot, 'XYZ'), None)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    mesh.materials.append(mats[material])
    obj['part'] = part
    obj['hands_material'] = material
    obj['uv_scale'] = UV_SCALES[material]
    obj.parent = PART_GROUP[part]
    STUDY.objects.link(obj)
    if bevel:
        modifier = obj.modifiers.new('Edge chamfer', 'BEVEL')
        modifier.width = bevel
        modifier.segments = segments
        modifier.limit_method = 'ANGLE'
        modifier.angle_limit = math.radians(30)
        modifier.use_clamp_overlap = True
    project_uvs(mesh, UV_SCALES[material])
    PARTS.append((obj, part, material))
    return obj


def segment(name, part, material, start, direction, length, width, thick,
            overlap=0.003, bevel=.004, segments=3, lift=0.0):
    """One phalanx: a rounded box from `start` along `direction`.

    The box runs `overlap` past both joints so neighbours share volume at the
    knuckle; the bevel turns that overlap into a rounded joint. `lift`
    offsets the box along its own +Y (the back of the finger).
    """
    d = Vector(direction).normalized()
    rot = z_to(-d)  # boxes run along local Z; fingers run along -Z
    frame = Euler(rot, 'XYZ').to_matrix()
    centre = Vector(start) + d * (length / 2) + frame @ Vector((0, lift, 0))
    return add(name, part, material, boxv((width, thick, length + 2 * overlap)),
               loc=tuple(centre), rot=rot, bevel=bevel, segments=segments)


# ===========================================================================
# POSES: the same palm, plate, strap, sleeve and bracer; only the digits differ
# ===========================================================================
FINGERS = [
    # (name, x, base z, (proximal, middle, distal), width, thick)
    ('index', -0.030, -0.046, (0.031, 0.021, 0.017), 0.0165, 0.0150),
    ('middle', -0.010, -0.049, (0.034, 0.024, 0.018), 0.0170, 0.0155),
    ('ring', 0.010, -0.047, (0.032, 0.022, 0.017), 0.0165, 0.0150),
    ('pinky', 0.030, -0.040, (0.025, 0.017, 0.014), 0.0145, 0.0135),
]
THUMB_BASE = (-0.036, -0.004, 0.012)


def build_common(part, title):
    """Palm, plates, strap, sleeve and bracer shared by both poses."""
    palm = add(f'{title} palm', part, 'glove leather',
               flared_box(0.041, 0.0135, 0.034, 0.0120, PALM_Z0, PALM_Z1, 0.0, -0.001),
               bevel=.006, segments=3)
    # Palm-side muscle pads: thumb mound on -x, hypothenar ridge on +x, heel.
    add(f'{title} thumb mound', part, 'glove leather',
        boxv((0.028, 0.016, 0.038)), loc=(-0.026, -0.010, 0.006), rot=(0, 0.12, 0), bevel=.006, segments=3)
    add(f'{title} hypothenar pad', part, 'glove leather',
        boxv((0.017, 0.013, 0.044)), loc=(0.031, -0.008, 0.002), bevel=.005, segments=3)
    add(f'{title} heel pad', part, 'glove leather',
        boxv((0.052, 0.008, 0.018)), loc=(0, -0.0135, 0.020), bevel=.003)
    # Back of the hand: raised leather pad, orange knuckle plate over the
    # metacarpal heads, ivory tendon plate behind it.
    add(f'{title} backhand pad', part, 'glove leather',
        flared_box(0.038, 0.0035, 0.031, 0.0035, -0.036, 0.024, 0.0130, 0.0115), bevel=.002)
    add(f'{title} knuckle plate', part, 'knuckle plate',
        flared_box(0.036, 0.0045, 0.039, 0.0045, -0.052, -0.026, 0.0165, 0.0180), bevel=.0025)
    for number, x in enumerate((-0.0225, -0.0075, 0.0075, 0.0225)):
        add(f'{title} knuckle rib {number + 1}', part, 'knuckle plate',
            boxv((0.010, 0.004, 0.018)), loc=(x, 0.0215, -0.040), bevel=.0018)
    add(f'{title} tendon plate', part, 'ceramic armor',
        flared_box(0.024, 0.0040, 0.020, 0.0040, -0.024, 0.014, 0.0180, 0.0165), bevel=.0025)
    # Wrist: strap with buckle, then the leather wrist and the suit sleeve.
    add(f'{title} wrist', part, 'glove leather',
        flared_box(0.034, 0.0125, 0.0345, 0.0155, 0.028, 0.070, -0.001, 0.0), bevel=.005, segments=3)
    add(f'{title} wrist strap', part, 'webbing',
        octagon_tube(0.0376, 0.0176, 0.016, 0.028), bevel=.002)
    add(f'{title} strap buckle', part, 'hardware',
        boxv((0.016, 0.005, 0.012)), loc=(-0.004, 0.0195, 0.036), bevel=.0012)
    add(f'{title} strap keeper', part, 'hardware',
        boxv((0.006, 0.006, 0.014)), loc=(0.030, 0.0165, 0.036), bevel=.0012)
    # The hem hugs the wrist end (its flats cut the wrist box corners) so the
    # glove stays one connected form now that the sleeve is its own part.
    add(f'{title} sleeve hem', part, 'glove leather',
        octagon_tube(0.0360, 0.0170, 0.012, 0.064), bevel=.003)
    return palm


def build_forearm(part='forearm', title='Forearm'):
    """Wrist joint at the origin, elbow at +z FOREARM_LEN; +y = back of the forearm."""
    # Leather cuff overlapping the glove's sleeve hem (glove-local 0.064..0.076
    # = forearm-local -0.006..0.006) so the seam never opens under stretch.
    add(f'{title} cuff', part, 'glove leather',
        octagon_tube(0.0395, 0.0245, 0.022, -0.010), bevel=.003)
    # Suit sleeve widening toward the elbow, a webbing strap at mid-length.
    add(f'{title} sleeve', part, 'suit fabric',
        octagon_tube(0.0385, 0.0235, 0.215, 0.008, 0.0470, 0.0330), bevel=.004, segments=3)
    add(f'{title} strap', part, 'webbing',
        octagon_tube(0.0445, 0.0295, 0.016, 0.118), bevel=.002)
    add(f'{title} sleeve flare', part, 'suit fabric',
        octagon_tube(0.0490, 0.0350, 0.060, 0.216, 0.0520, 0.0380), bevel=.004, segments=3)
    # Rounded leather elbow pad spanning the joint; the upper arm's cap meets it.
    add(f'{title} elbow pad', part, 'glove leather',
        boxv((0.096, 0.076, 0.060)), loc=(0, 0.004, FOREARM_LEN - 0.008), bevel=.014, segments=3)
    # Bracer: ivory plate along the back of the sleeve, orange inset.
    add(f'{title} bracer', part, 'ceramic armor',
        flared_box(0.026, 0.0065, 0.032, 0.0080, 0.030, 0.165, 0.0240, 0.0330), bevel=.004, segments=3)
    add(f'{title} bracer inset', part, 'knuckle plate',
        flared_box(0.012, 0.0030, 0.014, 0.0030, 0.046, 0.150, 0.0315, 0.0405), bevel=.0015)


def build_upperarm(part='upperarm', title='Upper arm'):
    """Elbow at the origin, shoulder joint at +z UPPER_LEN; +y = outer/upper side.

    The sleeve runs a little past the shoulder joint so the shoulder part
    always covers the seam, whatever the runtime stretches this segment to.
    """
    add(f'{title} elbow cap', part, 'glove leather',
        octagon_tube(0.0500, 0.0460, 0.048, -0.024), bevel=.005, segments=3)
    add(f'{title} sleeve', part, 'suit fabric',
        octagon_tube(0.0470, 0.0430, 0.350, 0.016, 0.0540, 0.0520), bevel=.005, segments=3)
    add(f'{title} band', part, 'webbing',
        octagon_tube(0.0510, 0.0470, 0.018, 0.070), bevel=.002)
    add(f'{title} plate', part, 'ceramic armor',
        flared_box(0.030, 0.0070, 0.037, 0.0085, 0.100, 0.290, 0.0455, 0.0520), bevel=.004, segments=3)
    add(f'{title} plate inset', part, 'knuckle plate',
        flared_box(0.014, 0.0030, 0.017, 0.0030, 0.116, 0.274, 0.0535, 0.0599), bevel=.0015)


def build_shoulder(part='shoulder', title='Shoulder'):
    """Shoulder joint at the origin, axes as the upper arm; the pauldron sits on +y."""
    add(f'{title} cap', part, 'suit fabric',
        octagon_tube(0.0560, 0.0540, 0.120, -0.095, 0.0500, 0.0480), bevel=.005, segments=3)
    add(f'{title} pauldron rim', part, 'ceramic armor',
        flared_box(0.058, 0.0055, 0.068, 0.0060, -0.108, 0.046, 0.0470, 0.0505), bevel=.003, segments=2)
    add(f'{title} pauldron', part, 'knuckle plate',
        flared_box(0.046, 0.011, 0.058, 0.013, -0.100, 0.040, 0.0555, 0.0610), bevel=.006, segments=3)
    add(f'{title} rivet', part, 'hardware',
        boxv((0.022, 0.008, 0.022)), loc=(0, 0.070, -0.030), bevel=.0015)


def build_finger(part, title, name, x, base_z, lengths, width, thick, angles, yaw):
    """One finger: leather proximal stall with an ivory plate, bare middle and
    distal phalanges. `angles` = (mcp, pip, dip) flexion in degrees toward the
    palm; `yaw` fans the whole finger sideways (degrees, +x = toward pinky).
    """
    start = Vector((x, KNUCKLE_Y, base_z))
    flex = 0.0
    spread = math.radians(yaw)
    for index, length in enumerate(lengths):
        flex += math.radians(angles[index])
        # Flexion rotates about the finger's own x axis; the fan is a yaw
        # about y applied to the straight finger direction first.
        direction = Vector((math.sin(spread) * math.cos(flex), -math.sin(flex), -math.cos(spread) * math.cos(flex)))
        label = ('proximal', 'middle', 'distal')[index]
        if index == 0:
            segment(f'{title} {name} {label}', part, 'glove leather', start, direction, length,
                    width, thick, overlap=0.004, bevel=.0045)
            segment(f'{title} {name} armor', part, 'ceramic armor',
                    Vector(start) + direction * 0.004, direction, length - 0.012,
                    width - 0.004, 0.0040, overlap=0.0, bevel=.0015, segments=2, lift=thick / 2 + 0.0008)
            # Stall hem: the leather ends in a raised ring at the first knuckle.
            segment(f'{title} {name} hem', part, 'glove leather',
                    Vector(start) + direction * (length - 0.006), direction, 0.006,
                    width + 0.0018, thick + 0.0018, overlap=0.001, bevel=.0015)
        elif index == 1:
            segment(f'{title} {name} {label}', part, 'skin', start, direction, length,
                    width - 0.0015, thick - 0.0015, overlap=0.0035, bevel=.0045)
        else:
            segment(f'{title} {name} {label}', part, 'skin', start, direction, length,
                    width - 0.0030, thick - 0.0030, overlap=0.003, bevel=.0050)
        start = start + direction * length


def build_thumb(part, title, base, chain, girth=1.0):
    """Metacarpal + proximal in leather, bare distal. `chain` = three
    (direction, length) pairs. The metacarpal root is buried in the thumb
    mound so the joint reads as one muscle."""
    start = Vector(base)
    sizes = [((0.021, 0.018), 'glove leather', 0.008), ((0.018, 0.016), 'glove leather', 0.004),
             ((0.016, 0.014), 'skin', 0.003)]
    for index, ((direction, length), ((w, t), material, overlap)) in enumerate(zip(chain, sizes)):
        d = Vector(direction).normalized()
        label = ('metacarpal', 'proximal', 'distal')[index]
        segment(f'{title} thumb {label}', part, material, start, d, length, w * girth, t * girth,
                overlap=overlap, bevel=.0045 if index < 2 else .005)
        if index == 0:
            segment(f'{title} thumb hem', part, 'glove leather', start + d * (length - 0.009), d, 0.005,
                    w * girth + 0.0012, t * girth + 0.0012, overlap=0.001, bevel=.0015)
        start = start + d * length


def build_hand(part, title, angles, yaws, thumb):
    build_common(part, title)
    for (name, x, base_z, lengths, width, thick) in FINGERS:
        build_finger(part, title, name, x, base_z, lengths, width, thick, angles[name], yaws[name])
    build_thumb(part, title, THUMB_BASE, thumb)


# Grip: fist around the pistol grip. The proximal phalanges drop away from the
# knuckles at once, the middle phalanges run back under the palm and the
# tips tuck toward the heel; the thumb lies across the index/middle stalls.
build_hand('grip', 'Grip', {
    'index': (72, 84, 42), 'middle': (76, 90, 46), 'ring': (78, 90, 46), 'pinky': (80, 86, 44),
}, {
    'index': -1.0, 'middle': 0.0, 'ring': 1.0, 'pinky': 2.5,
}, [((-0.20, -0.56, -0.80), 0.036), ((0.55, -0.28, -0.79), 0.028), ((0.82, -0.08, -0.56), 0.022)])

# Support: open cradle, fingers in a relaxed curl, thumb extended sideways.
build_hand('support', 'Support', {
    'index': (28, 42, 18), 'middle': (32, 46, 22), 'ring': (30, 46, 22), 'pinky': (36, 48, 24),
}, {
    'index': -6.0, 'middle': -2.0, 'ring': 2.0, 'pinky': 7.0,
}, [((-0.72, 0.04, -0.69), 0.040), ((-0.48, 0.02, -0.88), 0.028), ((-0.32, 0.0, -0.95), 0.022)])

build_forearm()
build_upperarm()
build_shoulder()

for (key, value) in {'asset_id': 'hands', 'revision': 3}.items():
    scene[key] = value

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
    # Fingers must separate: neighbouring proximal stalls may not share x.
    tip_pts = {name: [p for (p, n) in owned if n == f'{title} {name} distal']
               for (name, *_rest) in FINGERS}
    for (name, _x, _z, _l, _w, _t) in FINGERS:
        CONTRACT.append((f'{part} {name} tip exists', bool(tip_pts[name]), True))

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
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND), copy=True, check_existing=False)


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
            if p != part or not obj.name.endswith(' proximal') or 'thumb' in obj.name:
                continue
            evaluated = obj.evaluated_get(deps)
            mesh = evaluated.to_mesh()
            xs = [(obj.matrix_world @ v.co).x for v in mesh.vertices]
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
    bm = bmesh.new()
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        bm.from_mesh(mesh)
        evaluated.to_mesh_clear()
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    merged = bpy.data.meshes.new(f'{part} | {material} shell')
    bm.to_mesh(merged)
    bm.free()
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

STEMS = [m[1] for m in MATERIALS]


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
        if stem in STEMS:
            texture['name'] = f'textures/{stem}.jpg'
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
    'revision': 3,
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
    'materials': [m[0] for m in MATERIALS],
    'material_textures': {m[0]: f'{m[1]}.jpg' for m in MATERIALS},
    'material_uv_scale': {m[0]: m[5] for m in MATERIALS},
    'imagegen_textures': sorted({f'{m[1]}.jpg' for m in MATERIALS}),
    'texture_source': 'public/assets/blender/textures (the delivered 1024px JPEGs, '
                      'reused byte-identical; originals untouched)',
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
                           'every finger has a bare distal phalanx',
        'part_contact': 'every authored part must meet another part of its own group, '
                        'either by crossing its surface or by placing a vertex within 1 mm '
                        'of it; a part that only meets the model through empty space is '
                        'reported as floating and fails the build',
        'finger_gaps': 'neighbouring proximal stalls keep >= 1.5 mm of air between them',
    },
    'geometry_audit': {'floating_parts': floaters, 'finger_gaps': finger_gaps},
    'limitations': [
        'Scalar metallic/roughness only: no baked normal, occlusion or roughness maps.',
        'Single LOD; no mobile GPU profiling.',
        'Static poses: deliberately no rig or runtime IK.',
    ],
    'notes': ['Revision 2: base-knuckle flexion, rounded phalanx joints without ball bumps, '
              'half-finger glove with bare middle/distal phalanges, RIVET kit colours.',
              'Revision 3: the sleeve leaves the glove; forearm, upperarm and shoulder are '
              'separate rigid parts that viewmodel-arms.js poses with two-bone IK toward the '
              'first-person body, so the hands connect to the character.',
              'The runtime keeps these materials as delivered (no glove-map re-texture) and keys '
              'the character-skin palette on the material name.'],
}
(DOCS / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
validation = {
    'asset': 'HANDS',
    'revision': 3,
    'glb': str(GLB),
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
