"""Author GRENADES, the five Voxel Blitz throwables as one Blender study.

One study, five top-level part groups named by the shared roster ids from
`shared/grenade-rules.js` (`frag`, `limpet`, `pulse`, `molotov`, `smoke`).
Each group is authored in the frame the runtime already consumes for the
first-person held model (`public/js/guns/throwable-hands.js`): metres, y up,
the grenade's centre of mass at the origin, fuze block on top with its
safety lever on +x and the pin lug on -x at the procedural pin socket
(-0.024, 0.088, 0.019). The CLAYMORE (`limpet`) faces +z: its magnetic
feet sit on the wall at z = -0.041 and the sensor looks down the laser.
The bottle stands on the origin plane with its wick tip at (-0.037, 0.303, 0),
where the runtime hangs the wick flame. The in-world projectile
(`public/js/weapons/projectiles.js`) instances the same node scaled per
type to the footprint of the procedural model it replaces, so flight, bounce,
sticking and the hand pose are untouched.

Looks (from the shop illustrations, `public/assets/grenades/SOURCES.md`):

    frag     M-4 FRAG: dark faceted steel body, two rows of raised blocks,
             three bronze rib bands with amber slots, amber fuse cap.
    limpet   LIMPET CHARGE / CLAYMORE: copper magnetic disc, four steel feet
             on rubber pads, orange rim, red sensor lens in a dark inset.
    pulse    PULSE SHOCK: cyan faceted energy core in a dark three-meridian
             cage with an equator band and hub bosses, cyan cap.
    smoke    M-18 SMOKE: satin steel canister, pale band, six vents, fuze.
    molotov  bottle of petrol with a paper label, rag plug and hanging wick.

Materials are the six delivered ImageGen maps with multiply tints (no new
images). Glow parts (fuse cap, sensor lens, orange rim, pulse core) carry a
plain emissive colour that the runtime exporter writes as glTF
`emissiveFactor`; the runtime strobes the fuse cap / lens material clone.

Run through the live MCP session (see docs/design/blender/README.md) or
headless:

    blender --background --factory-startup --python tools/blender/grenades/build-grenades.py

The script creates its own scene and collection, never touches objects it
did not create, saves with `copy=True` and restores the window's previous
scene when it ran inside the live session.

Outputs (owned by this task):
    docs/design/blender/grenades/grenades.blend   editable, textures packed
    docs/design/blender/grenades/grenades.glb     portable GLB, images embedded
    docs/design/blender/grenades/manifest.json    machine-readable record
    docs/design/blender/grenades/validation.json  build-time gates record
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
DOCS = ROOT / 'docs/design/blender/grenades'
INK = ROOT / 'public/assets/blender/textures'
DOCS.mkdir(parents=True, exist_ok=True)

ASSET = 'GRENADES'
SCENE_NAME = f'{ASSET} | Voxel Blitz throwables study'
GROUPS = ['frag', 'limpet', 'pulse', 'molotov', 'smoke']
REVISION = 1

# --- held-frame contract (metres, y up) -------------------------------------
PIN_SOCKET = (-0.024, 0.088, 0.019)   # throwable-hands.js pin ring rest point
WICK_TIP = (-0.037, 0.303, 0.0)       # throwable-hands.js wickFlame position
WALL_Z = -0.041                       # limpet: magnetic feet plane
BOUNDS = {                            # per type: (min xyz, max xyz)
    'frag': ((-0.085, -0.090, -0.085), (0.085, 0.115, 0.085)),
    'limpet': ((-0.105, -0.075, -0.046), (0.105, 0.075, 0.036)),
    'pulse': ((-0.095, -0.095, -0.095), (0.095, 0.115, 0.095)),
    'smoke': ((-0.070, -0.090, -0.070), (0.070, 0.115, 0.070)),
    'molotov': ((-0.060, -0.090, -0.060), (0.060, 0.320, 0.060)),
}
FUZE_TYPES = ('frag', 'pulse', 'smoke')   # types with a fuze block, lever and pin lug
CONTACT_M = 0.0010
TRIANGLE_BUDGET = (4000, 24000)
TYPE_TRIANGLE_BUDGET = 8000


def srgb_to_linear(triplet):
    out = []
    for channel in triplet:
        out.append(channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4)
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
            window.scene = next(s for s in bpy.data.scenes if s is not previous)
    for obj in list(previous.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.scenes.remove(previous)
    bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=False, do_recursive=True)


HEADLESS = bpy.app.background
PREVIOUS_WINDOW_SCENES = []
if HEADLESS:
    scene = bpy.context.scene
    scene.name = SCENE_NAME
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.context.view_layer.update()
else:
    drop_previous_study()
    scene = bpy.data.scenes.new(SCENE_NAME)
    # The live session is shared with other studies: switch the window to
    # this scene only for the duration of the build (restored at the end).
    for window in bpy.context.window_manager.windows:
        PREVIOUS_WINDOW_SCENES.append((window, window.scene))
        window.scene = scene
STUDY = bpy.data.collections.new(f'{ASSET} study')
scene.collection.children.link(STUDY)


def restore_window():
    """Give the live window back to whatever study it showed before."""
    for (window, previous) in PREVIOUS_WINDOW_SCENES:
        if previous is not None and previous.name in bpy.data.scenes:
            window.scene = previous


scene.unit_settings.system = 'METRIC'
scene.render.engine = 'CYCLES'
scene.cycles.samples = 48
scene.cycles.use_denoising = True
scene.cycles.seed = 20260915
scene.render.resolution_x, scene.render.resolution_y = 900, 900
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'
scene.world = bpy.data.worlds.new(f'{ASSET} studio world')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.14, .17, .21, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .35

# --- materials -------------------------------------------------------------
# (name, texture stem, metallic, roughness, tint sRGB, tiles per metre,
#  emissive sRGB or None, emissive strength, alpha)
MATERIALS = [
    ('grenade steel', 'worn-gunmetal', .75, .45, hex_rgb(0x7a8290), 12.0, None, 0.0, 1.0),
    ('hardware', 'ivory-armor', .85, .32, hex_rgb(0x788088), 12.0, None, 0.0, 1.0),
    ('bronze', 'ivory-armor', .90, .38, hex_rgb(0xb8783a), 12.0, None, 0.0, 1.0),
    ('copper', 'ivory-armor', .90, .34, hex_rgb(0xb0602e), 10.0, None, 0.0, 1.0),
    ('orange rim', 'orange-painted-metal', .30, .45, hex_rgb(0xffffff), 12.0, hex_rgb(0xff5a3c), 0.6, 1.0),
    ('sensor lens', 'ivory-armor', .00, .25, hex_rgb(0xff4a2a), 12.0, hex_rgb(0xff3428), 1.5, 1.0),
    ('fuse cap', 'ivory-armor', .00, .35, hex_rgb(0xffa020), 12.0, hex_rgb(0xffb347), 1.2, 1.0),
    ('pulse core', 'ivory-armor', .00, .30, hex_rgb(0x30c8e8), 8.0, hex_rgb(0x59e8ff), 1.5, 1.0),
    ('smoke shell', 'ivory-armor', .75, .42, hex_rgb(0x8a9498), 12.0, None, 0.0, 1.0),
    ('smoke band', 'ivory-armor', .20, .55, hex_rgb(0xd8ecec), 12.0, None, 0.0, 1.0),
    ('glass', 'ivory-armor', .10, .15, hex_rgb(0x3e7030), 6.0, None, 0.0, 0.55),
    ('fuel', 'ivory-armor', .00, .30, hex_rgb(0xc07a20), 8.0, None, 0.0, 1.0),
    ('label', 'ivory-armor', .00, .70, hex_rgb(0xe0c890), 14.0, None, 0.0, 1.0),
    ('rag', 'tan-webbing', .00, .90, hex_rgb(0xd8c8a0), 20.0, None, 0.0, 1.0),
    ('rubber', 'worn-rubber', .00, .85, hex_rgb(0x9a9ea4), 14.0, None, 0.0, 1.0),
]
mats = {}
UV_SCALES = {}
IMAGES = []
for name, stem, metal, rough, srgb, uv_scale, glow, glow_strength, alpha in MATERIALS:
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
    IMAGES.append(image)
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
    if glow is not None:
        glow_linear = srgb_to_linear(glow)
        bsdf.inputs['Emission Color'].default_value = (*glow_linear, 1)
        bsdf.inputs['Emission Strength'].default_value = glow_strength
        material['gltf_emissive'] = list(glow_linear)
        material['gltf_emissive_strength'] = glow_strength
    if alpha < 1.0:
        bsdf.inputs['Alpha'].default_value = alpha
        material['gltf_alpha'] = alpha
        material['glass'] = True
        if hasattr(material, 'surface_render_method'):
            material.surface_render_method = 'BLENDED'
        material.use_backface_culling = False
    mats[name] = material
    UV_SCALES[name] = uv_scale

# --- part groups ------------------------------------------------------------
PARTS = []      # (object, part, material key)
PART_GROUP = {}
for group in GROUPS:
    empty = bpy.data.objects.new(group, None)
    empty.empty_display_type = 'PLAIN_AXES'
    empty.empty_display_size = .05
    STUDY.objects.link(empty)
    PART_GROUP[group] = empty


# --- primitive generators (closed convex shells, origin-centred) -------------
def boxv(size):
    (hx, hy, hz) = (size[0] / 2, size[1] / 2, size[2] / 2)
    verts = [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz),
             (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]
    faces = [(3, 2, 1, 0), (4, 5, 6, 7),
             (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return verts, faces


def prism(n, r0, r1, height, axis='y', phase=None):
    """Closed n-gon frustum along `axis`: radius r0 at the bottom, r1 at the top."""
    phase = math.pi / n if phase is None else phase
    ring0, ring1 = [], []
    for i in range(n):
        a = phase + i * 2 * math.pi / n
        ring0.append((r0 * math.cos(a), r0 * math.sin(a)))
        ring1.append((r1 * math.cos(a), r1 * math.sin(a)))
    h = height / 2
    if axis == 'y':
        verts = [(x, -h, z) for (x, z) in ring0] + [(x, h, z) for (x, z) in ring1]
    elif axis == 'z':
        verts = [(x, y, -h) for (x, y) in ring0] + [(x, y, h) for (x, y) in ring1]
    else:
        verts = [(-h, y, z) for (y, z) in ring0] + [(h, y, z) for (y, z) in ring1]
    faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    return verts, faces


def torus(major, minor, segments=24, rings=6):
    """Closed torus in the xz plane (axis y)."""
    verts, faces = [], []
    for i in range(segments):
        a = i * 2 * math.pi / segments
        cx, cz = math.cos(a), math.sin(a)
        for j in range(rings):
            b = j * 2 * math.pi / rings
            r = major + minor * math.cos(b)
            verts.append((cx * r, minor * math.sin(b), cz * r))
    for i in range(segments):
        i2 = (i + 1) % segments
        for j in range(rings):
            j2 = (j + 1) % rings
            faces.append((i * rings + j, i * rings + j2, i2 * rings + j2, i2 * rings + j))
    return verts, faces


def bmesh_shape(build):
    bm = bmesh.new()
    build(bm)
    bm.verts.ensure_lookup_table()
    verts = [tuple(v.co) for v in bm.verts]
    faces = [tuple(v.index for v in f.verts) for f in bm.faces]
    bm.free()
    return verts, faces


def uvsphere(u, v, radius):
    return bmesh_shape(lambda bm: bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=radius))


def icosphere(subdivisions, radius):
    return bmesh_shape(lambda bm: bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=radius))


def project_uvs(mesh, uv_scale):
    uv = mesh.uv_layers[0] if mesh.uv_layers else mesh.uv_layers.new(name='UVMap')
    for polygon in mesh.polygons:
        axis = max(range(3), key=lambda i: abs(polygon.normal[i]))
        (first, second) = [(1, 2), (0, 2), (0, 1)][axis]
        for loop in polygon.loop_indices:
            co = mesh.vertices[mesh.loops[loop].vertex_index].co
            uv.data[loop].uv = (co[first] * uv_scale, co[second] * uv_scale)
    return uv


def add(name, part, material, shape, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1),
        bevel=.002, segments=1):
    (base_verts, faces) = shape
    mesh = bpy.data.meshes.new(f'{name} shell')
    mesh.from_pydata(base_verts, [], faces)
    mesh.validate()
    matrix = Matrix.LocRotScale(Vector(loc), Euler(rot, 'XYZ'), Vector(scale))
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(f'{part} {name}', mesh)
    mesh.materials.append(mats[material])
    obj['part'] = part
    obj['grenade_material'] = material
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


def ring_of(n, radius, y):
    """(angle, position) pairs around the y axis at `radius`."""
    for i in range(n):
        a = i * 2 * math.pi / n
        yield a, (math.sin(a) * radius, y, math.cos(a) * radius)


def fuze_head(part, cap_material, y=0.083, lever_lean=0.22, lever_length=0.075):
    """Shared fuze block, cap, pin lug and safety lever (lever on +x, lug on -x)."""
    add('fuze block', part, 'hardware', boxv((0.040, 0.032, 0.032)), loc=(0, y, 0), bevel=.0025)
    add('cap', part, cap_material, boxv((0.026, 0.010, 0.026)), loc=(0, y + 0.020, 0), bevel=.0015)
    add('pin lug', part, 'hardware', boxv((0.010, 0.008, 0.008)),
        loc=(-0.022, PIN_SOCKET[1], 0.016), bevel=.001)
    add('lever pivot', part, 'hardware', boxv((0.032, 0.010, 0.012)), loc=(0.030, y + 0.009, 0), bevel=.0015)
    add('lever upper', part, 'hardware', boxv((0.014, 0.040, 0.020)),
        loc=(0.047, y - 0.007, 0), rot=(0, 0, 0.06), bevel=.002)
    add('lever lower', part, 'hardware', boxv((0.013, lever_length, 0.018)),
        loc=(0.058, y - 0.057, 0), rot=(0, 0, lever_lean), bevel=.002)


# ===========================================================================
# FRAG: dark faceted body, raised blocks, bronze ribs with amber slots
# ===========================================================================
add('body', 'frag', 'grenade steel', uvsphere(16, 10, 0.066), scale=(1, 1.15, 1), bevel=0)
for y in (-0.036, 0.0, 0.036):
    add(f'rib {y:+.3f}', 'frag', 'bronze', prism(16, 0.0705, 0.0705, 0.012), loc=(0, y, 0), bevel=.0015)
for row, y in enumerate((-0.018, 0.018)):
    for i, (a, pos) in enumerate(ring_of(8, 0.060, y)):
        add(f'block {row + 1}-{i + 1}', 'frag', 'grenade steel', boxv((0.026, 0.020, 0.016)),
            loc=pos, rot=(0, a, 0), bevel=.002)
for i, (a, pos) in enumerate(ring_of(8, 0.0705, 0.0)):
    add(f'amber slot {i + 1}', 'frag', 'fuse cap', boxv((0.012, 0.006, 0.006)),
        loc=pos, rot=(0, a + math.pi / 8, 0), bevel=.0008)
add('base cap', 'frag', 'bronze', prism(8, 0.024, 0.030, 0.012), loc=(0, -0.079, 0), bevel=.0015)
add('collar', 'frag', 'grenade steel', prism(8, 0.034, 0.030, 0.014), loc=(0, 0.072, 0), bevel=.0015)
fuze_head('frag', 'fuse cap')

# ===========================================================================
# LIMPET (CLAYMORE): copper disc facing +z, feet on the wall plane at -z
# ===========================================================================
DISC = (1, 0.68, 1)
add('disc', 'limpet', 'copper', prism(8, 0.095, 0.095, 0.040, axis='z'),
    loc=(0, 0, -0.010), scale=DISC, bevel=.004, segments=2)
add('rim', 'limpet', 'orange rim', prism(8, 0.100, 0.100, 0.010, axis='z'),
    loc=(0, 0, -0.008), scale=(1, 0.70, 1), bevel=.0015)
add('dome', 'limpet', 'copper', prism(8, 0.072, 0.066, 0.014, axis='z'),
    loc=(0, 0, 0.016), scale=(1, 0.70, 1), bevel=.003)
add('inset', 'limpet', 'grenade steel', prism(8, 0.046, 0.044, 0.006, axis='z'),
    loc=(0, 0, 0.024), scale=(1, 0.72, 1), bevel=.001)
add('sensor', 'limpet', 'sensor lens', prism(8, 0.011, 0.010, 0.010, axis='z'), loc=(0, 0, 0.028), bevel=.0015)
add('magnet plate', 'limpet', 'grenade steel', prism(8, 0.082, 0.082, 0.014, axis='z'),
    loc=(0, 0, -0.034), scale=DISC, bevel=.002)
for sx in (-1, 1):
    for sy in (-1, 1):
        tag = f'{"+" if sx > 0 else "-"}x{"+" if sy > 0 else "-"}y'
        add(f'foot {tag}', 'limpet', 'hardware', boxv((0.034, 0.030, 0.032)),
            loc=(sx * 0.076, sy * 0.046, -0.026), bevel=.003)
        add(f'pad {tag}', 'limpet', 'rubber', boxv((0.024, 0.020, 0.006)),
            loc=(sx * 0.078, sy * 0.048, WALL_Z), bevel=.001)
add('latch', 'limpet', 'hardware', boxv((0.030, 0.010, 0.014)), loc=(0, 0.060, -0.004), bevel=.0015)
for sx in (-1, 1):
    add(f'vent {"+" if sx > 0 else "-"}x', 'limpet', 'grenade steel', boxv((0.006, 0.020, 0.012)),
        loc=(sx * 0.088, 0, 0.004), bevel=.001)

# ===========================================================================
# PULSE: cyan faceted core in a three-meridian cage with an equator band
# ===========================================================================
add('core', 'pulse', 'pulse core', icosphere(1, 0.076), bevel=0)
for k in range(3):
    add(f'meridian {k + 1}', 'pulse', 'grenade steel', torus(0.078, 0.0065, 24, 6),
        rot=(math.pi / 2, k * math.pi / 3, 0), bevel=0)
add('equator', 'pulse', 'grenade steel', torus(0.079, 0.0065, 24, 6), bevel=0)
for i, (a, pos) in enumerate(ring_of(6, 0.079, 0.0)):
    add(f'hub {i + 1}', 'pulse', 'hardware', boxv((0.016, 0.018, 0.012)), loc=pos, rot=(0, a, 0), bevel=.0015)
    add(f'pip {i + 1}', 'pulse', 'pulse core', boxv((0.006, 0.010, 0.004)),
        loc=(math.sin(a) * 0.086, 0, math.cos(a) * 0.086), rot=(0, a, 0), bevel=.0006)
add('base', 'pulse', 'grenade steel', prism(8, 0.022, 0.026, 0.012), loc=(0, -0.078, 0), bevel=.0015)
add('collar', 'pulse', 'grenade steel', prism(8, 0.034, 0.028, 0.014), loc=(0, 0.072, 0), bevel=.0015)
fuze_head('pulse', 'pulse core')

# ===========================================================================
# SMOKE: satin steel canister with a pale band, vents and the fuze
# ===========================================================================
add('can', 'smoke', 'smoke shell', prism(12, 0.057, 0.057, 0.160), bevel=.002)
add('band', 'smoke', 'smoke band', prism(12, 0.0585, 0.0585, 0.040), loc=(0, 0.015, 0), bevel=.001)
add('stripe', 'smoke', 'smoke band', prism(12, 0.0583, 0.0583, 0.008), loc=(0, -0.045, 0), bevel=.0008)
add('top rim', 'smoke', 'grenade steel', prism(12, 0.059, 0.059, 0.010), loc=(0, 0.077, 0), bevel=.0015)
add('bottom rim', 'smoke', 'grenade steel', prism(12, 0.059, 0.059, 0.010), loc=(0, -0.077, 0), bevel=.0015)
for i, (a, pos) in enumerate(ring_of(6, 0.057, 0.064)):
    add(f'vent {i + 1}', 'smoke', 'grenade steel', boxv((0.010, 0.010, 0.006)), loc=pos, rot=(0, a, 0), bevel=.0008)
add('label plate', 'smoke', 'grenade steel', boxv((0.036, 0.014, 0.005)), loc=(0, -0.012, 0.057), bevel=.001)
add('top plate', 'smoke', 'hardware', prism(8, 0.030, 0.030, 0.010), loc=(0, 0.084, 0), bevel=.0015)
fuze_head('smoke', 'fuse cap', y=0.086, lever_lean=0.10, lever_length=0.080)

# ===========================================================================
# MOLOTOV: glass bottle, fuel, label, rag plug, hanging wick
# ===========================================================================
# The wick leans out of the plug so that the centre of its top face is the
# runtime flame anchor.
WICK_LEAN = 0.43
WICK_CENTRE = (WICK_TIP[0] + math.sin(WICK_LEAN) * 0.042, WICK_TIP[1] - math.cos(WICK_LEAN) * 0.042, 0.0)
add('body', 'molotov', 'glass', prism(12, 0.054, 0.053, 0.180), loc=(0, 0.015, 0), bevel=.002)
add('foot', 'molotov', 'glass', prism(12, 0.050, 0.054, 0.010), loc=(0, -0.078, 0), bevel=.0015)
add('shoulder', 'molotov', 'glass', prism(12, 0.053, 0.024, 0.055), loc=(0, 0.1325, 0), bevel=.002)
add('neck', 'molotov', 'glass', prism(12, 0.023, 0.022, 0.085), loc=(0, 0.200, 0), bevel=.0015)
add('lip', 'molotov', 'glass', prism(12, 0.026, 0.026, 0.010), loc=(0, 0.245, 0), bevel=.0015)
add('fuel', 'molotov', 'fuel', prism(12, 0.049, 0.049, 0.145), loc=(0, 0.005, 0), bevel=0)
add('label', 'molotov', 'label', prism(12, 0.0555, 0.0555, 0.062), loc=(0, 0.012, 0), bevel=.0008)
add('print upper', 'molotov', 'grenade steel', boxv((0.034, 0.010, 0.004)), loc=(0, 0.022, 0.0545), bevel=.0006)
add('print lower', 'molotov', 'grenade steel', boxv((0.024, 0.010, 0.004)), loc=(0, 0.000, 0.0545), bevel=.0006)
add('rag plug', 'molotov', 'rag', boxv((0.032, 0.036, 0.034)), loc=(0, 0.248, 0), bevel=.004, segments=2)
add('wick', 'molotov', 'rag', boxv((0.020, 0.084, 0.018)), loc=WICK_CENTRE, rot=(0, 0, WICK_LEAN),
    bevel=.004, segments=2)
add('rag tail', 'molotov', 'rag', boxv((0.016, 0.055, 0.014)), loc=(0.024, 0.222, 0.010), rot=(0, 0, -0.35),
    bevel=.003, segments=2)

for (key, value) in {'asset_id': 'grenades', 'revision': REVISION}.items():
    scene[key] = value

# --- contract assertions ---------------------------------------------------
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()
points = {group: [] for group in GROUPS}
extents = {}
for (obj, part, _material) in PARTS:
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    for vertex in mesh.vertices:
        points[part].append((Vector(obj.matrix_world @ vertex.co), obj.name))
    evaluated.to_mesh_clear()

CONTRACT = []
for group in GROUPS:
    owned = points[group]
    mins = [min(p[i] for (p, _n) in owned) for i in range(3)]
    maxs = [max(p[i] for (p, _n) in owned) for i in range(3)]
    extents[group] = (mins, maxs)
    (lo, hi) = BOUNDS[group]
    inside = all(mins[i] >= lo[i] - 1e-6 and maxs[i] <= hi[i] + 1e-6 for i in range(3))
    CONTRACT.append((f'{group} inside its footprint {lo}..{hi}', inside, True))
    spans = all(mins[i] < -0.001 and maxs[i] > 0.001 for i in range(3))
    CONTRACT.append((f'{group} spans the origin', spans, True))
    if group in FUZE_TYPES:
        lug = [p for (p, n) in owned if n == f'{group} pin lug']
        centre = sum(lug, Vector()) / len(lug)
        CONTRACT.append((f'{group} pin lug at the pin socket', (centre - Vector(PIN_SOCKET)).length, 0.012))
        cap = [p for (p, n) in owned if n == f'{group} cap']
        CONTRACT.append((f'{group} cap tops the fuze', max(p.y for p in cap) >= 0.100, True))
        lever = [p for (p, n) in owned if n.startswith(f'{group} lever')]
        CONTRACT.append((f'{group} lever on +x', min(p.x for p in lever) > 0.010, True))
    if group == 'limpet':
        CONTRACT.append(('limpet feet reach the wall plane', abs(mins[2] - (WALL_Z - 0.003)) < 0.002, True))
        sensor = [p for (p, n) in owned if n == 'limpet sensor']
        CONTRACT.append(('limpet sensor faces +z', max(p.z for p in sensor) >= 0.030, True))
    if group == 'molotov':
        wick = [p for (p, n) in owned if n == 'molotov wick']
        top = max(p.y for p in wick)
        crown = [p for p in wick if p.y > top - 0.012]
        tip = sum(crown, Vector()) / len(crown)
        CONTRACT.append(('molotov wick tip at the flame anchor', (tip - Vector(WICK_TIP)).length, 0.012))
        CONTRACT.append(('molotov stands on the origin plane', abs(mins[1] + 0.083) < 0.004, True))

contract_failures = []
for (name, measured, expected) in CONTRACT:
    if isinstance(expected, bool):
        if measured != expected:
            contract_failures.append(f'{name}: got {measured}')
    elif measured > expected:
        contract_failures.append(f'{name}: measured {measured:.6f}, limit {expected}')

for group in GROUPS:
    (mins, maxs) = extents[group]
    print(f'{group}: x={mins[0]:+.4f}..{maxs[0]:+.4f} y={mins[1]:+.4f}..{maxs[1]:+.4f} '
          f'z={mins[2]:+.4f}..{maxs[2]:+.4f}')
if contract_failures:
    print(f'CONTRACT FAILURES: {len(contract_failures)}')
    for line in contract_failures:
        print(f'  {line}')
else:
    print('held-frame contract: all assertions pass')


# --- contact audit -----------------------------------------------------------
def audit_contact(tolerance=CONTACT_M):
    """Every authored part must meet another part of its type.

    Parts meet when their surfaces cross (BVH overlap), when one lies inside
    the other (a rib band around the body, the fuel inside the glass) or when
    a vertex comes within `tolerance` of the other surface. A part that only
    meets its grenade through empty space is reported as floating.
    """
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    findings = []

    def inside(tree, co):
        (location, normal, _index, distance) = tree.find_nearest(co)
        return location is not None and (location - co).dot(normal) > 0

    def near(tree, coords):
        return any(tree.find_nearest(co)[3] <= tolerance or inside(tree, co) for co in coords)

    for part in GROUPS:
        owned = [o for (o, p, _m) in PARTS if p == part]
        worlds, trees = {}, {}
        for obj in owned:
            evaluated = obj.evaluated_get(deps)
            mesh = evaluated.to_mesh()
            coords = [obj.matrix_world @ v.co for v in mesh.vertices]
            worlds[obj.name] = coords
            trees[obj.name] = BVHTree.FromPolygons(
                coords, [tuple(p.vertices) for p in mesh.polygons],
                all_triangles=False, epsilon=0.0)
            evaluated.to_mesh_clear()
        names = [o.name for o in owned]
        touching = {name: False for name in names}
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                if touching[a] and touching[b]:
                    continue
                if (trees[a].overlap(trees[b]) or near(trees[b], worlds[a]) or near(trees[a], worlds[b])):
                    touching[a] = touching[b] = True
        for name in names:
            if not touching[name]:
                nearest = min(trees[other].find_nearest(co)[3]
                              for other in names if other != name for co in worlds[name])
                findings.append(f'{part} | {name}: nearest neighbour {nearest * 1000:.2f} mm away')
    return findings


floaters = audit_contact()
if floaters:
    print(f'FLOATING PARTS: {len(floaters)}')
    for line in floaters:
        print(f'  {line}')
else:
    print('part contact audit: every part meets its grenade')

# --- pack this study's textures and save the editable source ----------------
for image in IMAGES:
    image.pack()
BLEND = DOCS / 'grenades.blend'
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND), copy=True, check_existing=False)

# --- portable GLB: merge per (type, material), export, then restore parts ----
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()
batches = {}
for (obj, part, material) in PARTS:
    batches.setdefault((part, material), []).append(obj)

merged_objects = []
triangles = 0
per_primitive = {}
per_type = {group: 0 for group in GROUPS}
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
    obj['grenade_material'] = material
    obj['uv_scale'] = UV_SCALES[material]
    obj.parent = PART_GROUP[part]
    STUDY.objects.link(obj)
    project_uvs(merged, UV_SCALES[material])
    merged.update()
    merged.calc_loop_triangles()
    count = len(merged.loop_triangles)
    triangles += count
    per_type[part] += count
    per_primitive[f'{part} | {material}'] = count
    merged_objects.append(obj)

# The authored parts leave the collection for the export only: the glTF
# exporter walks the active collection, so the merged shells are the
# only meshes it sees. They are relinked right after.
for (obj, _part, _material) in PARTS:
    STUDY.objects.unlink(obj)

for layer in bpy.context.view_layer.layer_collection.children:
    if layer.collection is STUDY:
        bpy.context.view_layer.active_layer_collection = layer
bpy.context.view_layer.objects.active = PART_GROUP['frag']

GLB = DOCS / 'grenades.glb'
wanted = {'filepath': str(GLB), 'export_format': 'GLB', 'use_active_collection': True,
          'use_active_scene': True, 'export_yup': False,
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
    restore_window()
    raise RuntimeError(f'Blender glTF exporter lacks required options: {missing}')
try:
    bpy.ops.export_scene.gltf(**{k: v for (k, v) in wanted.items() if k in supported})
except Exception:
    restore_window()
    raise
finally:
    for obj in merged_objects:
        mesh = obj.data
        STUDY.objects.unlink(obj)
        bpy.data.objects.remove(obj)
        bpy.data.meshes.remove(mesh)
    for (obj, _part, _material) in PARTS:
        STUDY.objects.link(obj)

_expected = set(GROUPS) | {f'{p} | {m}' for (p, m) in batches}
with open(GLB, 'rb') as handle:
    _header = handle.read(20)
(_length, _kind, _total, _json_len, _json_kind) = struct.unpack('<IIIII', _header)
with open(GLB, 'rb') as handle:
    handle.seek(20)
    _document = json.loads(handle.read(_json_len).decode('utf-8'))
_foreign = sorted({node.get('name', '').split('.')[0] for node in _document['nodes']} - _expected)
if _foreign:
    restore_window()
    raise RuntimeError(f'unexpected nodes in the GLB export: {_foreign}')

STEMS = sorted({m[1] for m in MATERIALS})


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
        base = material.get('name', '')
        head, _, tail = base.rpartition('.')
        if tail.isdigit() and head:
            base = head
        material['name'] = base
        tint = contract_tints.get(base)
        if tint and 'baseColorTexture' in pbr and 'alphaMode' not in material:
            pbr['baseColorFactor'] = tint + [1]
    seen = set()
    for node in document.get('nodes', []):
        name = node.get('name', '')
        head, _, tail = name.rpartition('.')
        if tail.isdigit() and head:
            name = head
        if name in GROUPS:
            node.setdefault('extras', {})['blenderAsset'] = 'grenades'
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

budget_failures = []
if not (TRIANGLE_BUDGET[0] <= triangles <= TRIANGLE_BUDGET[1]):
    budget_failures.append(f'total triangles {triangles} outside {TRIANGLE_BUDGET}')
for group, count in per_type.items():
    if count > TYPE_TRIANGLE_BUDGET:
        budget_failures.append(f'{group} triangles {count} over {TYPE_TRIANGLE_BUDGET}')

# --- record ----------------------------------------------------------------
manifest = {
    'asset': ASSET,
    'asset_id': 'grenades',
    'revision': REVISION,
    'kind': 'five throwable grenade models in one study (visual game asset)',
    'blender': bpy.app.version_string,
    'authoring_script': 'tools/blender/grenades/build-grenades.py',
    'source_parts': len(PARTS),
    'source_parts_per_type': {group: sum(1 for (_o, p, _m) in PARTS if p == group) for group in GROUPS},
    'part_nodes': GROUPS,
    'batch_nodes': len(batches),
    'triangles': triangles,
    'triangles_per_type': per_type,
    'triangles_per_primitive': per_primitive,
    'materials': [m[0] for m in MATERIALS],
    'material_textures': {m[0]: f'{m[1]}.jpg' for m in MATERIALS},
    'material_uv_scale': {m[0]: m[5] for m in MATERIALS},
    'material_emissive': {m[0]: {'srgb': [round(v, 4) for v in m[6]], 'strength': m[7]}
                          for m in MATERIALS if m[6] is not None},
    'imagegen_textures': [f'{stem}.jpg' for stem in STEMS],
    'texture_source': 'public/assets/blender/textures (the delivered 1024px JPEGs, '
                      'reused byte-identical; originals untouched)',
    'axes': {'authoring': 'held frame: y up, centre of mass at the origin, lever +x, pin lug -x; '
                          'limpet faces +z with its feet on z = -0.041 (consumed verbatim)',
             'after_gltf': 'held frame (export_yup off)',
             'map': 'game_x = x, game_y = y, game_z = z (identity bake); projectiles.js scales '
                    'each node to the procedural footprint'},
    'contract_points': {'pin_socket': list(PIN_SOCKET), 'wick_tip': list(WICK_TIP), 'wall_z': WALL_Z,
                        'bounds': {k: [list(v[0]), list(v[1])] for (k, v) in BOUNDS.items()}},
    'extents': {group: {'min': [round(v, 6) for v in extents[group][0]],
                        'max': [round(v, 6) for v in extents[group][1]]} for group in GROUPS},
    'files': {'blend': 'docs/design/blender/grenades/grenades.blend',
              'glb': 'docs/design/blender/grenades/grenades.glb',
              'validation': 'docs/design/blender/grenades/validation.json'},
    'build_time_checks': {
        'held_frame_contract': 'every type spans the origin inside its footprint; fuze types keep '
                               'the pin lug on the procedural pin socket, the cap above y 0.100 '
                               'and the lever on +x; the limpet feet reach the wall plane and the '
                               'sensor faces +z; the bottle stands on the origin plane with its '
                               'wick tip on the flame anchor',
        'part_contact': 'every authored part must touch or nearly touch another part of its own '
                        'type (1 mm BVH audit); a floating group fails the build',
        'triangle_budget': f'{TRIANGLE_BUDGET[0]}..{TRIANGLE_BUDGET[1]} total, '
                           f'<= {TYPE_TRIANGLE_BUDGET} per type',
    },
    'geometry_audit': {'floating_parts': floaters, 'budget': budget_failures},
    'limitations': [
        'Scalar metallic/roughness only: no baked normal, occlusion or roughness maps.',
        'Single LOD; the same node is scaled for the in-world projectile.',
        'The safety pin ring, wick flame, pulse halo and claymore laser stay runtime procedural.',
    ],
}
(DOCS / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
validation = {
    'asset': ASSET,
    'revision': REVISION,
    'glb': str(GLB),
    'passed': not (contract_failures or floaters or budget_failures),
    'failures': contract_failures + [f'floating: {line}' for line in floaters] + budget_failures,
    'advisory': [],
    'measured': {
        'extents': manifest['extents'],
        'glb_nodes': _node_names,
        **{f'node:{group}': 'present' if group in _node_names else 'missing' for group in GROUPS},
        'triangles': triangles,
        'triangles_per_type': per_type,
        'triangles_per_primitive': per_primitive,
    },
}
(DOCS / 'validation.json').write_text(json.dumps(validation, indent=2) + '\n')
print(json.dumps({k: manifest[k] for k in ('source_parts', 'batch_nodes', 'triangles', 'triangles_per_type')},
                 indent=2))
print(f'blend={BLEND} bytes={BLEND.stat().st_size}')
print(f'glb={GLB} bytes={GLB.stat().st_size}')

restore_window()

if floaters:
    raise RuntimeError(f'geometry gate failed: {len(floaters)} floating parts')
if contract_failures:
    raise RuntimeError(f'held-frame contract failed: {len(contract_failures)} failures')
if budget_failures:
    raise RuntimeError(f'triangle budget failed: {budget_failures}')
