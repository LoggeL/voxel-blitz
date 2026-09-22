"""Author TORCH, the RX-8 HAVOC heavy rocket launcher prop for Voxel Blitz.

Revision 2 is a from-scratch redo of the launcher (design study "BULWARK", see
docs/design/blender/torch/build-report.md). The old AT4-style study is gone:
revision 2 is a heavy sci-fi launcher with a squared breech housing, a
half-cage of braces, industrial panels and handles, a tilting back-blast
venturi gate at the rear and a fat warhead seated proud of the muzzle.

Run headless:

    blender --background --factory-startup --python tools/blender/torch/build-torch.py

or paste this file into the live Blender MCP session (execute_code); it builds
in its own scene and saves the source with copy=True, never touching other
studies. Writes docs/design/blender/torch/{torch.blend,torch.glb,manifest.json}
and fails the build on any contract or geometry-audit violation.

Authoring space: +Y forward (muzzle), +Z up, +X right. The game maps it as
game_x = x, game_y = z, game_z = -y (Blender glTF export_yup does the same).
"""
import bmesh
import bpy
import json
import math
import struct
import sys
from collections import defaultdict
from pathlib import Path
from mathutils import Euler, Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / 'docs/design/blender/torch'
INK = ROOT / 'public/assets/blender/textures'
DOCS.mkdir(parents=True, exist_ok=True)

ASSET = 'TORCH'
SCENE_NAME = f'{ASSET} | Voxel Blitz rocket study'
UV_SCALE = 3.6  # texture tiles per metre, constant across the whole model
GROUPS = ['body', 'mag', 'bolt', 'trigger', 'extra']

# --- frozen runtime anchors, in Blender authoring space --------------------
MUZZLE = (0.000, 0.780, 0.075)     # game (0.000, 0.075, -0.780)
GRIP = (0.045, 0.080, -0.020)      # game (0.045, -0.020, -0.080)
SUPPORT = (-0.060, 0.400, -0.030)  # game (-0.060, -0.030, -0.400)
SIGHT = (0.000, 0.340, 0.175)      # ladder sight axis, game y = 0.175
MARKERS = {'muzzle': MUZZLE, 'grip': GRIP, 'support': SUPPORT, 'sight': SIGHT}

BORE_X, BORE_Z = 0.000, 0.075   # bore axis
BORE_R = 0.0620                 # exposed bore radius (BARREL_R.rocket - clearance)
BORE_IN = 0.0555                # clear bore: the runtime reload round needs >= 0.055
BORE_START = 0.155              # tube tail, buried in the breech block
SLEEVE_END = 0.525              # cage front collar: bare sleeve begins after it
HEAT_BAND = (0.528, 0.752)      # game z -0.528 .. -0.752; runtime glow sleeve 0.0625
BREECH_Y = 0.220                # BREACH_Z.rocket -0.22
HINGE = (0.000, 0.060, 0.075)   # game (0, 0.075, -0.06); gate pivot on the bore axis
SIGHT_Z = 0.175                 # body.userData.sightHeight
REAR_POST_Y, FRONT_POST_Y = 0.020, 0.768
TRIGGER_Y, TRIGGER_TIP_Z = 0.110, -0.055   # TRIGGER_Z.rocket -0.11
BOLT_HOME_GAME_Z = -0.040       # BOLT_HOME.rocket
BOLT_HOME_Y = -BOLT_HOME_GAME_Z  # the same point in authoring space

# --- scene -----------------------------------------------------------------
def drop_previous_study():
    previous = bpy.data.scenes.get(SCENE_NAME)
    if previous is not None:
        for obj in list(previous.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.scenes.remove(previous)
    # A live MCP session keeps datablocks between runs; purge this study's
    # materials so names never pick up .001 suffixes.
    for material in list(bpy.data.materials):
        if material.name.split('.')[0].startswith(f'{ASSET} |'):
            bpy.data.materials.remove(material)


HEADLESS = bpy.app.background
if HEADLESS:
    scene = bpy.context.scene
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    scene.name = SCENE_NAME
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
scene.cycles.samples = 64
scene.cycles.use_denoising = True
scene.cycles.seed = 20260922
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'
scene.world = bpy.data.worlds.new(f'{ASSET} studio world')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.14, .17, .21, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .35

# --- materials -------------------------------------------------------------
# Frozen skin palette: exactly seven material names. The six mapped names
# sample the shared 1024px palette JPEGs per
# docs/design/blender/material-library/materials.json (the same pass every
# other weapon went through); cavity black stays untextured. No new images.
MATERIAL_KEYS = ['gunmetal', 'olive drab', 'orange paint', 'ivory coating',
                 'polymer', 'rubber', 'cavity black']
LIBRARY = json.loads((ROOT / 'docs/design/blender/material-library/materials.json').read_text())
ASSIGNMENT = LIBRARY['assignment']

mats = {}
for name in MATERIAL_KEYS:
    material = bpy.data.materials.get(f'{ASSET} | {name}') \
        or bpy.data.materials.new(f'{ASSET} | {name}')
    material.use_nodes = True
    mats[name] = material

# Void-black cavity faces (bore liner, seams, warhead tip): plain untextured
# BSDF so openings render as true voids instead of lit textured discs.
void = mats['cavity black']
vbsdf = void.node_tree.nodes['Principled BSDF']
vbsdf.inputs['Base Color'].default_value = (.015, .015, .016, 1)
vbsdf.inputs['Metallic'].default_value = 0
vbsdf.inputs['Roughness'].default_value = 1.0


# --- primitive builders ----------------------------------------------------
PARTS = []      # (object, part, material key)
PART_GROUP = {}
for group in GROUPS:
    empty = bpy.data.objects.new(group, None)
    empty.empty_display_type = 'PLAIN_AXES'
    empty.empty_display_size = .05
    STUDY.objects.link(empty)
    PART_GROUP[group] = empty


def solid(outer, depth, axis='X', inner=None):
    """Extrude a closed 2D profile along an axis. `inner` cuts a through-hole."""
    n = len(outer)
    half = depth / 2
    verts, faces = [], []

    def place(a, b, t):
        if axis == 'X':
            return (t, a, b)
        if axis == 'Y':
            return (a, t, b)
        return (a, b, t)

    if inner is None:
        for t in (-half, half):
            for (a, b) in outer:
                verts.append(place(a, b, t))
        faces.append(tuple(range(n - 1, -1, -1)))
        faces.append(tuple(range(n, 2 * n)))
        for i in range(n):
            j = (i + 1) % n
            faces.append((i, j, n + j, n + i))
        return verts, faces
    if len(inner) != n:
        raise ValueError('inner profile must have the same point count as outer')
    for t in (-half, half):
        for (a, b) in outer:
            verts.append(place(a, b, t))
    for t in (-half, half):
        for (a, b) in inner:
            verts.append(place(a, b, t))
    back = 2 * n
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
        faces.append((back + i, back + n + i, back + n + j, back + j))
        faces.append((n + i, n + j, back + n + j, back + n + i))
        faces.append((back + i, back + j, j, i))
    return verts, faces


def circle(radius, segments, phase=0.0):
    return [(radius * math.cos(phase + 2 * math.pi * i / segments),
             radius * math.sin(phase + 2 * math.pi * i / segments))
            for i in range(segments)]


def polygon(radius, sides, phase=0.0):
    """Regular polygon whose FLATS sit at `radius` (inscribed circle)."""
    return circle(radius / math.cos(math.pi / sides), sides, phase + math.pi / sides)


def prism(profile, depth):
    """Close a (y, z) outline and extrude it along X (the lateral axis)."""
    return solid(profile, depth, 'X')


def boxv(size):
    (sy, sz) = (size[1] / 2, size[2] / 2)
    return solid([(-sy, -sz), (sy, -sz), (sy, sz), (-sy, sz)], size[0], 'X')


def recty(y0, y1, z0, z1):
    """A (y, z) rectangle for prism()/ring() profiles."""
    return [(y0, z0), (y1, z0), (y1, z1), (y0, z1)]


def tube(radius, length, segments=12, axis='Y'):
    """Closed cylinder along an axis, centred on the origin."""
    return solid(circle(radius, segments), length, axis)


def washer(outer, inner, length, segments=12, axis='Y'):
    """Closed annulus: the primitive whose hole is meant to be seen through."""
    return solid(circle(outer, segments), length, axis, circle(inner, segments))


def taper(r0, r1, y0, y1, segments=12):
    """Closed truncated cone along Y, caps included."""
    verts, faces = [], []
    for (y, r) in ((y0, r0), (y1, r1)):
        base = len(verts)
        for i in range(segments):
            angle = 2 * math.pi * i / segments
            verts.append((r * math.cos(angle), y, r * math.sin(angle)))
        ring = tuple(range(base, base + segments))
        faces.append(ring if y == y0 else tuple(reversed(ring)))
    for i in range(segments):
        j = (i + 1) % segments
        faces.append((i, j, segments + j, segments + i))
    return verts, faces


def shell(r_out0, r_out1, r_in0, r_in1, y0, y1, segments=24, a0=None, a1=None):
    """Hollow frustum ring along Y with annular end caps.

    a0/a1 carve an angular sector (with side caps); the default is a closed
    ring. Angles follow (x, z) = (r cos a, r sin a) around the local origin.
    """
    closed = a0 is None
    if closed:
        a0, a1 = 0.0, 2 * math.pi
    steps = segments if closed else segments + 1
    angles = [a0 + (a1 - a0) * i / segments for i in range(steps)]

    verts, faces = [], []

    def ring(radius, y):
        base = len(verts)
        for angle in angles:
            verts.append((radius * math.cos(angle), y, radius * math.sin(angle)))
        return [base + i for i in range(steps)]

    verts, faces = [], []
    outer0 = ring(r_out0, y0)
    outer1 = ring(r_out1, y1)
    inner0 = ring(r_in0, y0)
    inner1 = ring(r_in1, y1)

    def quads(first, second, flip=False):
        span = segments if closed else segments
        for i in range(span):
            j = (i + 1) % steps
            quad = (first[i], first[j], second[j], second[i])
            faces.append(tuple(reversed(quad)) if flip else quad)

    quads(outer0, outer1)
    quads(inner0, inner1, flip=True)
    quads(outer0, inner0, flip=True)
    quads(outer1, inner1)
    if not closed:
        for chain in ((outer0[0], outer1[0], inner1[0], inner0[0]),
                      (inner0[-1], inner1[-1], outer1[-1], outer0[-1])):
            faces.append(chain)
    return verts, faces


def hollow_stacked(r_out, r_in, y0, y1, step, segments=24, rows=()):
    """Hollow cylinder with lengthwise ring subdivisions and forced rows.

    Plain end caps alone leave spans like the heat band with nothing to
    measure; forced rows put vertices exactly on the band edges so every
    audit sees the real surface.
    """
    count = max(2, int(round((y1 - y0) / step)) + 1)
    stations = {y0 + (y1 - y0) * k / (count - 1) for k in range(count)}
    stations |= {y for y in rows if min(y0, y1) <= y <= max(y0, y1)}
    stations = sorted(stations, reverse=y1 < y0)
    verts, faces = [], []

    def ring(radius, y):
        base = len(verts)
        for i in range(segments):
            angle = 2 * math.pi * i / segments
            verts.append((radius * math.cos(angle), y, radius * math.sin(angle)))
        return [base + i for i in range(segments)]

    outer = [ring(r_out, y) for y in stations]
    inner = [ring(r_in, y) for y in stations]
    for k in range(len(stations) - 1):
        for i in range(segments):
            j = (i + 1) % segments
            faces.append((outer[k][i], outer[k][j], outer[k + 1][j], outer[k + 1][i]))
            faces.append((inner[k][i], inner[k + 1][i], inner[k + 1][j], inner[k][j]))
    for i in range(segments):
        j = (i + 1) % segments
        faces.append((outer[0][i], inner[0][i], inner[0][j], outer[0][j]))
        faces.append((outer[-1][i], outer[-1][j], inner[-1][j], inner[-1][i]))
    return verts, faces


def project_uvs(mesh, uv_scale=UV_SCALE):
    """Analytic per-face planar projection at a constant real-world density."""
    uv = mesh.uv_layers[0] if mesh.uv_layers else mesh.uv_layers.new(name='UVMap')
    for polygon in mesh.polygons:
        axis = max(range(3), key=lambda i: abs(polygon.normal[i]))
        (first, second) = [(1, 2), (0, 2), (0, 1)][axis]
        for loop in polygon.loop_indices:
            co = mesh.vertices[mesh.loops[loop].vertex_index].co
            uv.data[loop].uv = (co[first] * uv_scale, co[second] * uv_scale)
    return uv


def offset(shape, dx=0.0, dy=0.0, dz=0.0):
    """Translate one primitive definition without touching its winding."""
    (verts, faces) = shape
    return ([(v[0] + dx, v[1] + dy, v[2] + dz) for v in verts], faces)


def merge_shapes(shapes):
    """Concatenate primitive vertex/face lists into one mesh definition."""
    verts, faces = [], []
    for (shape_verts, shape_faces) in shapes:
        base = len(verts)
        verts.extend(shape_verts)
        faces.extend(tuple(i + base for i in face) for face in shape_faces)
    return verts, faces


def add(name, part, material, shape, loc=(0, 0, 0), rot=(0, 0, 0),
        bevel=.0025, uv_scale=UV_SCALE, sight=False):
    """Create one chamfered, UV-mapped part with its placement baked in."""
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
    obj['torch_material'] = material
    obj['ballista_material'] = material
    if sight:
        obj['sight_piece'] = True
    obj.parent = PART_GROUP[part]
    STUDY.objects.link(obj)
    if bevel:
        modifier = obj.modifiers.new('Edge chamfer', 'BEVEL')
        modifier.width = bevel
        modifier.segments = 1 if bevel <= .002 else 2
        modifier.limit_method = 'ANGLE'
        modifier.angle_limit = math.radians(30)
        modifier.use_clamp_overlap = True
    project_uvs(mesh, uv_scale)
    PARTS.append((obj, part, material))
    return obj


def pair(name, part, material, shape, loc=(0, 0, 0), rot=(0, 0, 0),
         bevel=.0025, sight=False):
    """Mirror a part across X (two named parts, not one mirrored object)."""
    for side in (1, -1):
        add(f'{name} {"right" if side > 0 else "left"}', part, material, shape,
            loc=(side * loc[0], loc[1], loc[2]),
            rot=(rot[0], side * rot[1], side * rot[2]), bevel=bevel, sight=sight)


def add_text(text, name, part, material, loc, rot, size, extrude=.0012):
    """Modelled markings: real geometry, not a texture decal."""
    bpy.ops.object.text_add(location=loc, rotation=rot)
    label = bpy.context.active_object
    label.data.body = text
    label.data.size = size
    label.data.extrude = extrude
    label.data.resolution_u = 1
    label.data.align_x = 'CENTER'
    label.data.align_y = 'CENTER'
    bpy.ops.object.convert(target='MESH')
    label = bpy.context.active_object
    label.name = name
    label.data.name = f'{name} mesh'
    mesh = label.data
    # Bake the placement like add() does so the merged batches are world-true.
    matrix = label.matrix_world.copy()
    label.matrix_world = Matrix.Identity(4)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(mats[material])
    label['part'] = part
    label['torch_material'] = material
    label['ballista_material'] = material
    label.parent = PART_GROUP[part]
    project_uvs(mesh)
    PARTS.append((label, part, material))
    return label


def bevel_size(x):
    return x


# ===========================================================================
# BODY: launch tube core + bore liner, squared breech housing, half-cage,
# muzzle collar and the seated warhead, spine deck, ladder sights, furniture
# ===========================================================================
# The measured bore: bare at exactly 0.0620 across the whole heat band, hollow
# (>= 0.0555 clear) so the runtime reload round slides through.
BORE_OBJECT = add('Launch tube core', 'body', 'olive drab',
                  offset(hollow_stacked(BORE_R, 0.0570, BORE_START, MUZZLE[1], .025,
                                        24, rows=(*HEAT_BAND, MUZZLE[1])), dz=BORE_Z),
                  bevel=0)
BORE_LINER_OBJECT = add('Bore liner', 'body', 'cavity black',
                        offset(hollow_stacked(0.0572, BORE_IN, 0.158, 0.778, .08, 20), dz=BORE_Z),
                        bevel=0)
# "The bore" in the heat-band rule is the tube assembly: core + liner.
BORE_ASSEMBLY = {BORE_OBJECT.name, BORE_LINER_OBJECT.name}
# Muzzle collar (the bare sleeve's front furniture) and its index tabs.
add('Muzzle collar', 'body', 'gunmetal',
    offset(shell(0.072, 0.072, 0.057, 0.057, 0.754, 0.782), dz=BORE_Z), bevel=.002)
add('Muzzle warning ring', 'body', 'orange paint',
    offset(shell(0.0735, 0.0735, 0.070, 0.070, 0.756, 0.766), dz=BORE_Z), bevel=.0015)
pair('Muzzle index tab', 'body', 'gunmetal', boxv((.010, .016, .024)),
     loc=(.070, 0.767, BORE_Z), bevel=.0015)

# --- seated warhead: rocket nose peeking out of the tube mouth --------------
# Baked body geometry per the runtime owner: tip at most ~0.02 past the muzzle
# plane (the flash and the flying rocket spawn there), radius <= ~0.045, the
# boom seated INSIDE the mouth. The runtime reload round's seat nose stops at
# y ~0.58, so this nose keeps the mouth region alone.
add('Warhead boom', 'body', 'gunmetal',
    offset(taper(.034, .045, 0.620, 0.706, 20), dz=BORE_Z), bevel=0)
add('Warhead ogive', 'body', 'ivory coating',
    offset(taper(.0455, .036, 0.700, 0.786, 20), dz=BORE_Z), bevel=.0015)
add('Warhead band', 'body', 'orange paint',
    offset(shell(.0465, .0465, .041, .041, 0.686, 0.704), dz=BORE_Z), bevel=.001)
add('Warhead tip', 'body', 'cavity black',
    offset(taper(.037, .026, 0.784, 0.798, 16), dz=BORE_Z), bevel=0)
add('Warhead obturator', 'body', 'rubber',
    offset(shell(.0575, .0575, .038, .031, 0.7535, 0.774), dz=BORE_Z), bevel=.0015)

# --- squared breech housing and the rear assembly ---------------------------
# Octagonal receiver block: squared across the flats, chamfered corners.
add('Breech block', 'body', 'gunmetal',
    offset(solid(polygon(.085, 8), .147, 'Y', polygon(.060, 8)), dz=BORE_Z),
    loc=(0, 0.1915, 0), bevel=.003)
add('Breech block rib', 'body', 'gunmetal',
    offset(solid(polygon(.089, 8), .018, 'Y', polygon(.0615, 8)), dz=BORE_Z),
    loc=(0, 0.254, 0), bevel=.002)
add('Breech collar', 'body', 'gunmetal',
    offset(shell(.080, .078, .057, .057, 0.264, 0.292), dz=BORE_Z), bevel=.002)
add('Breech collar band', 'body', 'orange paint',
    offset(shell(.0815, .0815, .075, .075, 0.268, 0.278), dz=BORE_Z), bevel=.0015)

# Hinge yoke: two jaws + stub pins carry the gate knuckles at bore height.
pair('Hinge yoke arm', 'body', 'gunmetal', boxv((.026, .048, .042)),
     loc=(.070, 0.132, BORE_Z), bevel=.002)
pair('Hinge yoke jaw', 'body', 'gunmetal', boxv((.008, .052, .048)),
     loc=(.060, 0.062, BORE_Z), bevel=.0015)
pair('Hinge pin', 'body', 'gunmetal', tube(.010, .038, 10, axis='X'),
     loc=(.073, HINGE[1], BORE_Z), bevel=0)
pair('Hinge pin cap', 'body', 'orange paint', tube(.013, .004, 10, axis='X'),
     loc=(.093, HINGE[1], BORE_Z), bevel=.001)

# Arming-lever boss and flank rib (body): where the bolt group's shoe rides.
add('Lever boss', 'body', 'gunmetal', boxv((.024, .032, .044)),
    loc=(.084, 0.039, 0.026), bevel=.002)
add('Flank rib right', 'body', 'gunmetal', boxv((.016, .084, .036)),
    loc=(.082, 0.087, 0.032), bevel=.002)
add('Flank rib left', 'body', 'gunmetal', boxv((.016, .084, .036)),
    loc=(-.082, 0.087, 0.032), bevel=.002)

# Pistol grip wrapping the grip marker, with finger ribs and a base plate.
add('Pistol grip', 'body', 'polymer', prism([
    (0.156, 0.006), (0.064, 0.006), (0.034, -0.056), (0.040, -0.112),
    (0.102, -0.120), (0.126, -0.058)], .056), bevel=.008)
for index, (y, z) in enumerate(((0.104, -0.072), (0.126, -0.018), (0.080, -0.108))):
    add(f'Grip finger rib {index + 1}', 'body', 'rubber', boxv((.066, .008, .009)),
        loc=(0, y, z), bevel=.0015)
add('Grip base plate', 'body', 'gunmetal', boxv((.060, .056, .014)),
    loc=(0, 0.072, -0.122), bevel=.003)
add('Grip palm swell', 'body', 'polymer', boxv((.062, .018, .042)),
    loc=(0, 0.046, -0.082), bevel=.004)

# Shoulder rest: padded brace on the left flank (gate sweep stays |x| <= 0.102).
add('Shoulder brace arm', 'body', 'gunmetal', boxv((.030, .100, .052)),
    loc=(-.084, 0.176, 0.038), bevel=.003)
add('Shoulder brace drop', 'body', 'gunmetal', boxv((.026, .052, .080)),
    loc=(-.100, 0.108, 0.014), bevel=.003)
add('Shoulder pad plate', 'body', 'gunmetal', boxv((.020, .130, .110)),
    loc=(-.108, 0.082, 0.012), bevel=.003)
add('Shoulder pad', 'body', 'rubber', boxv((.024, .124, .104)),
    loc=(-.122, 0.082, 0.012), bevel=.006)
for index, z in enumerate((-0.022, 0.046)):
    add(f'Pad rib {index + 1}', 'body', 'gunmetal', boxv((.028, .112, .010)),
        loc=(-.122, 0.082, z), bevel=.0015)

# --- squared housing shell with bolted cheek panels (industrial cladding) ----
add('Housing shell', 'body', 'olive drab',
    offset(solid(polygon(.076, 8), .164, 'Y', polygon(.0615, 8)), dz=BORE_Z),
    loc=(0, 0.372, 0), bevel=.003)
add('Housing rear band', 'body', 'gunmetal',
    offset(shell(.080, .080, .060, .060, 0.294, 0.312), dz=BORE_Z), bevel=.002)
add('Housing front band', 'body', 'gunmetal',
    offset(shell(.080, .080, .060, .060, 0.434, 0.452), dz=BORE_Z), bevel=.002)
pair('Housing cheek panel', 'body', 'gunmetal', boxv((.014, .118, .104)),
     loc=(.082, 0.372, 0.052), bevel=.002)
pair('Cheek bolt front', 'body', 'orange paint', tube(.008, .006, 8, axis='X'),
     loc=(.090, 0.418, 0.086), bevel=0)
pair('Cheek bolt rear', 'body', 'orange paint', tube(.008, .006, 8, axis='X'),
     loc=(.090, 0.326, 0.086), bevel=0)
pair('Cheek latch', 'body', 'gunmetal', boxv((.010, .030, .016)),
     loc=(.090, 0.372, 0.014), bevel=.0015)
add('Housing vent', 'body', 'cavity black', boxv((.100, .056, .004)),
    loc=(0, 0.372, 0.150), bevel=0)

# --- forward half-cage and the front collar over the bare sleeve ------------
add('Cage front collar', 'body', 'gunmetal',
    offset(shell(.074, .072, .061, .061, 0.506, 0.524), dz=BORE_Z), bevel=.002)
pair('Cage strut top', 'body', 'gunmetal', boxv((.018, .084, .022)),
     loc=(.052, 0.480, 0.128), rot=(math.radians(-8), 0, math.radians(16)), bevel=.002)
pair('Cage strut low', 'body', 'gunmetal', boxv((.018, .084, .022)),
     loc=(.050, 0.480, 0.018), rot=(math.radians(8), 0, math.radians(16)), bevel=.002)
pair('Cage collar bolt', 'body', 'gunmetal', tube(.006, .006, 8, axis='X'),
     loc=(.070, 0.515, BORE_Z), bevel=0)

# Forward hand hold around the support marker (left palm at x = -0.060).
add('Fore grip mount', 'body', 'polymer', boxv((.052, .062, .052)),
    loc=(-.028, 0.404, -0.004), bevel=.003)
add('Fore grip', 'body', 'polymer', prism([
    (0.444, -0.010), (0.384, -0.010), (0.368, -0.058), (0.376, -0.092),
    (0.428, -0.096), (0.446, -0.060)], .052), loc=(-.032, 0, 0), bevel=.005)
for index, (y, z) in enumerate(((0.372, -0.040), (0.370, -0.062), (0.374, -0.082))):
    add(f'Fore grip groove {index + 1}', 'body', 'rubber', boxv((.046, .008, .008)),
        loc=(-.032, y, z), bevel=0)
add('Fore grip collar', 'body', 'orange paint', boxv((.058, .020, .056)),
    loc=(-.032, 0.432, -0.026), bevel=.0015)

# --- spine deck and flip-up ladder sights on the 0.175 sight line -----------
add('Spine deck', 'body', 'ivory coating', boxv((.076, .535, .010)),
    loc=(0, 0.2575, 0.167), bevel=.002)
for index, y in enumerate((0.220, 0.300, 0.380, 0.460)):
    add(f'Rail slot {index + 1}', 'body', 'rubber', boxv((.078, .024, .004)),
        loc=(0, y, 0.1705), bevel=0)
add('Deck foot rear', 'body', 'gunmetal', boxv((.052, .040, .022)),
    loc=(0, 0.040, 0.155), bevel=.002)
add('Deck foot front', 'body', 'gunmetal', boxv((.052, .036, .022)),
    loc=(0, 0.500, 0.155), bevel=.002)

# Rear ladder sight over the venturi (game z -0.02): twin ears, notch at 0.175.
add('Rear sight base', 'body', 'gunmetal', boxv((.044, .040, .010)),
    loc=(0, REAR_POST_Y, 0.176), bevel=.0015, sight=True)
pair('Rear sight ear', 'body', 'gunmetal', boxv((.008, .032, .030)),
     loc=(.017, REAR_POST_Y, 0.192), bevel=.0015, sight=True)
add('Rear sight notch bar', 'body', 'gunmetal', boxv((.028, .028, .008)),
    loc=(0, REAR_POST_Y, 0.171), bevel=.0015, sight=True)
add('Rear sight pip', 'body', 'orange paint', boxv((.008, .005, .004)),
    loc=(0, REAR_POST_Y, 0.1755), bevel=0, sight=True)
for index, z in enumerate((0.198, 0.206)):
    add(f'Rear sight rung {index + 1}', 'body', 'gunmetal',
        tube(.003, .036, 8, axis='X'), loc=(0, REAR_POST_Y, z), bevel=0, sight=True)

# Front ladder sight (game z -0.768): hooded post whose tip touches the line.
add('Front sight riser', 'body', 'gunmetal', boxv((.024, .018, .028)),
    loc=(0, FRONT_POST_Y, 0.154), bevel=.0015, sight=True)
add('Front sight post', 'body', 'gunmetal', boxv((.006, .007, .018)),
    loc=(0, FRONT_POST_Y, 0.166), bevel=0, sight=True)
add('Front sight tip', 'body', 'orange paint', boxv((.007, .008, .005)),
    loc=(0, FRONT_POST_Y, 0.175), bevel=0, sight=True)
pair('Front sight hood wall', 'body', 'gunmetal', boxv((.005, .016, .030)),
     loc=(.012, FRONT_POST_Y, 0.172), bevel=.0015, sight=True)
add('Front sight hood bar', 'body', 'gunmetal', boxv((.030, .020, .005)),
    loc=(0, FRONT_POST_Y, 0.1885), bevel=.0015, sight=True)

# Identity markings, modelled as geometry on the housing cheeks.
add_text('RX-8', 'Marking RX-8 left', 'body', 'ivory coating',
         (-0.0885, 0.372, 0.052), (math.pi / 2, 0, -math.pi / 2), .017)
add_text('HAVOC', 'Marking HAVOC right', 'body', 'ivory coating',
         (0.0885, 0.372, 0.052), (math.pi / 2, 0, math.pi / 2), .014)

# ===========================================================================
# MAG: the fixed underslung control canister (stays put during the reload)
# ===========================================================================
add('Control canister', 'mag', 'polymer', boxv((.072, .104, .080)),
    loc=(0, 0.296, -0.064), bevel=.004)
add('Canister face panel', 'mag', 'gunmetal', boxv((.010, .084, .058)),
    loc=(.040, 0.296, -0.064), bevel=.002)
add('Canister stripe', 'mag', 'orange paint', boxv((.078, .022, .086)),
    loc=(0, 0.332, -0.064), bevel=.0015)
add('Canister connector', 'mag', 'gunmetal', boxv((.026, .030, .040)),
    loc=(0, 0.246, -0.020), bevel=.0015)
add('Canister rib front', 'mag', 'polymer', boxv((.076, .010, .084)),
    loc=(0, 0.252, -0.064), bevel=.0015)
add('Canister rib rear', 'mag', 'polymer', boxv((.076, .010, .084)),
    loc=(0, 0.310, -0.064), bevel=.0015)

# ===========================================================================
# BOLT: side arming lever, home at game z -0.040; the runtime rotates the
# whole group about the gun origin, so it stays compact near the bore axis.
# ===========================================================================
BOLT_KNOB_OBJECT = add('Arming lever knob', 'bolt', 'orange paint',
                       tube(.013, .020, 12, axis='X'),
                       loc=(.112, 0.037, 0.021), bevel=.0015)
add('Arming lever shoe', 'bolt', 'gunmetal', boxv((.024, .030, .034)),
    loc=(.082, 0.037, 0.023), bevel=.002)
add('Arming lever arm', 'bolt', 'gunmetal', boxv((.018, .038, .024)),
    loc=(.098, 0.037, 0.021), bevel=.002)
add('Arming lever pivot', 'bolt', 'gunmetal', tube(.008, .016, 8, axis='X'),
    loc=(.085, 0.058, 0.036), bevel=0)

# ===========================================================================
# TRIGGER: blade + shoe + guard at game z -0.11, blade tip at z -0.055
# ===========================================================================
TRIGGER_OBJECT = add('Trigger blade', 'trigger', 'gunmetal', boxv((.010, .016, .045)),
                     loc=(0, TRIGGER_Y, -0.0316), rot=(math.radians(8), 0, 0), bevel=.002)
add('Trigger shoe', 'trigger', 'orange paint', boxv((.012, .008, .014)),
    loc=(0, TRIGGER_Y + 0.003, -0.048), rot=(math.radians(8), 0, 0), bevel=.0015)
add('Trigger guard', 'trigger', 'gunmetal',
    solid(recty(0.060, 0.170, -0.078, 0.002), .030, 'X',
          recty(0.072, 0.156, -0.064, -0.012)), bevel=.003)

# ===========================================================================
# EXTRA: the breech gate = the tilting back-blast venturi tail. Every part
# below is a gate leaf piece; the export batches them per material with
# hinge-local geometry and node translation at the hinge.
# ===========================================================================
GATE_FRONT_Y, GATE_REAR_Y = 0.112, -0.048
SEAM = 0.06  # radians of seam gap either side of the top/bottom splits


def gate(name, material, shape, loc=(0, 0, 0), rot=(0, 0, 0), bevel=.002):
    return add(name, 'extra', material, shape, loc=loc, rot=rot, bevel=bevel)


gate('Gate leaf right', 'gunmetal',
     offset(shell(.0705, .0985, .0570, .0640, GATE_FRONT_Y, GATE_REAR_Y,
                  14, a0=-math.pi / 2 + SEAM, a1=math.pi / 2 - SEAM), dz=BORE_Z), bevel=.0015)
gate('Gate leaf left', 'gunmetal',
     offset(shell(.0705, .0985, .0570, .0640, GATE_FRONT_Y, GATE_REAR_Y,
                  14, a0=math.pi / 2 + SEAM, a1=3 * math.pi / 2 - SEAM), dz=BORE_Z), bevel=.0015)
gate('Gate throat collar', 'gunmetal',
     offset(shell(.075, .074, .057, .057, 0.110, 0.090), dz=BORE_Z), bevel=.0015)
gate('Gate rim ring', 'gunmetal',
     offset(shell(.099, .095, .062, .062, -0.028, -0.052), dz=BORE_Z), bevel=.0015)
gate('Gate warning band', 'orange paint',
     offset(shell(.0915, .0965, .084, .086, 0.010, -0.020), dz=BORE_Z), bevel=.0015)
gate('Gate clamp ring', 'gunmetal',
     offset(shell(.0825, .0855, .072, .073, 0.058, 0.038), dz=BORE_Z), bevel=.0015)
gate('Gate throat liner', 'cavity black',
     offset(shell(.0575, .0645, BORE_IN, .0565, 0.106, -0.044), dz=BORE_Z), bevel=0)
gate('Gate knuckle right', 'gunmetal', washer(.0155, .0105, .024, 12, axis='X'),
     loc=(.070, HINGE[1], BORE_Z), bevel=0)
gate('Gate knuckle left', 'gunmetal', washer(.0155, .0105, .024, 12, axis='X'),
     loc=(-.070, HINGE[1], BORE_Z), bevel=0)
gate('Gate latch', 'orange paint', boxv((.032, .032, .024)),
     loc=(0, 0.100, -0.004), bevel=.002)

# Node names the delivered files must use verbatim.
CONTRACT_NODE_NAMES = set(GROUPS) | set(MARKERS) | {
    'gate | gunmetal', 'gate | orange paint', 'gate | cavity black'}


def contract_node_name(name):
    head, _, tail = name.rpartition('.')
    if tail.isdigit() and len(tail) == 3 and head in CONTRACT_NODE_NAMES:
        return head
    return name


# --- marker empties --------------------------------------------------------
MARKER_OBJECTS = {}
for (name, position) in MARKERS.items():
    marker = bpy.data.objects.new(name, None)
    marker.empty_display_type = 'SPHERE'
    marker.empty_display_size = .012
    marker.location = position
    marker.parent = PART_GROUP['body']
    STUDY.objects.link(marker)
    MARKER_OBJECTS[name] = marker

for (key, value) in {'asset_id': 'torch',
                     'display_name': 'RX-8 HAVOC',
                     'design_study': 'BULWARK',
                     'sight_height': SIGHT_Z,
                     'bore_radius': BORE_R}.items():
    scene[key] = value

# ===========================================================================
# build-time checks (all four must pass or the build fails)
# ===========================================================================
# Headless runs need an explicit view-layer sync before data-API-created
# objects show up in the dependency graph.
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()
extent = {0: [1e9, -1e9], 1: [1e9, -1e9], 2: [1e9, -1e9]}
points = []
for (obj, _part, _material) in PARTS:
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    for vertex in mesh.vertices:
        point = obj.matrix_world @ vertex.co
        points.append((point, obj.name))
        for axis in range(3):
            extent[axis][0] = min(extent[axis][0], point[axis])
            extent[axis][1] = max(extent[axis][1], point[axis])
    evaluated.to_mesh_clear()

# --- check 1: anchor contract ----------------------------------------------
bore_object = BORE_OBJECT
band = [(p, n) for (p, n) in points if HEAT_BAND[0] - 1e-9 <= p[1] <= HEAT_BAND[1] + 1e-9]
band_radius = max(math.hypot(p[0] - BORE_X, p[2] - BORE_Z) for (p, _n) in band)
band_foreign = sorted({n for (p, n) in band
                       if n not in BORE_ASSEMBLY
                       and math.hypot(p[0] - BORE_X, p[2] - BORE_Z) > BORE_R + 1e-6})
bore_points = [p for (p, n) in points if n == bore_object.name]
bore_band = [p for p in bore_points if HEAT_BAND[0] - 1e-9 <= p[1] <= HEAT_BAND[1] + 1e-9]
bore_band_radius = max(math.hypot(p[0] - BORE_X, p[2] - BORE_Z) for p in bore_band)
bore_x = (min(p[0] for p in bore_points) + max(p[0] for p in bore_points)) / 2
bore_z = (min(p[2] for p in bore_points) + max(p[2] for p in bore_points)) / 2
tip = max(bore_points, key=lambda p: p[1])
tip_plane = sorted({round(p[1], 9) for p in bore_points if p[1] > 0.75})
trigger_object = TRIGGER_OBJECT
trigger_low = min((trigger_object.matrix_world @ v.co)[2] for v in trigger_object.data.vertices)
bolt_handle = BOLT_KNOB_OBJECT
knob_far = max((bolt_handle.matrix_world @ v.co)[0] for v in bolt_handle.data.vertices)
rear_sight = next(o for (o, _p, _m) in PARTS if o.name == 'Rear sight base')
rear_post_y = sum((rear_sight.matrix_world @ v.co)[1] for v in rear_sight.data.vertices) \
    / len(rear_sight.data.vertices)
front_sight = next(o for (o, _p, _m) in PARTS if o.name == 'Front sight riser')
front_post_y = sum((front_sight.matrix_world @ v.co)[1] for v in front_sight.data.vertices) \
    / len(front_sight.data.vertices)
sight_names = {o.name for (o, _p, _m) in PARTS if o.get('sight_piece')}
sight_line_hits = sorted({n for (p, n) in points
                          if n not in sight_names and abs(p[0]) < 0.02 and p[2] >= SIGHT_Z - 1e-9})

CONTRACT = [
    ('muzzle_forward_vertex_y', tip[1], MUZZLE[1], 1e-6),
    ('muzzle_marker', MUZZLE[1], 0.780, 1e-9),
    ('bore_axis_x', bore_x, BORE_X, 1e-6),
    ('bore_axis_z', bore_z, BORE_Z, 1e-6),
    ('exposed_bore_radius_in_heat_band', bore_band_radius, BORE_R, 1e-6),
    ('grip_marker_x', GRIP[0], 0.045, 1e-9),
    ('grip_marker_y', GRIP[1], 0.080, 1e-9),
    ('grip_marker_z', GRIP[2], -0.020, 1e-9),
    ('support_marker_x', SUPPORT[0], -0.060, 1e-9),
    ('support_marker_y', SUPPORT[1], 0.400, 1e-9),
    ('support_marker_z', SUPPORT[2], -0.030, 1e-9),
    ('sight_marker_x', SIGHT[0], 0.000, 1e-9),
    ('sight_marker_y', SIGHT[1], 0.340, 1e-9),
    ('sight_axis_z', SIGHT[2], SIGHT_Z, 1e-9),
    ('trigger_blade_y', TRIGGER_Y, 0.110, 1e-9),
    ('trigger_blade_tip_z', trigger_low, TRIGGER_TIP_Z, 1e-4),
    ('bolt_handle_home_y', BOLT_HOME_Y, -BOLT_HOME_GAME_Z, 1e-9),
    ('bolt_knob_reach_x', knob_far, None, None),
    ('rear_sight_base_y', rear_post_y, REAR_POST_Y, 1e-6),
    ('front_sight_post_y', front_post_y, FRONT_POST_Y, 1e-6),
]
contract_failures = []
for (name, measured, expected, tolerance) in CONTRACT:
    if expected is None or tolerance is None:
        continue
    if abs(measured - expected) > tolerance:
        contract_failures.append(f'{name}: measured {measured:.9f}, contract {expected} +/- {tolerance}')
if band_foreign:
    contract_failures.append(f'geometry inside the heat band radius: {", ".join(band_foreign)}')
if BORE_START > BREECH_Y:
    contract_failures.append(
        f'bore starts at y={BORE_START}, forward of the {BREECH_Y} breech point')
if knob_far <= 0.100:
    contract_failures.append(f'arming lever does not protrude to +x: reaches {knob_far:.4f}')
if sight_line_hits:
    contract_failures.append(
        f'non-sight geometry touches the 0.175 sight line inside |x| < 0.02: '
        f'{", ".join(sight_line_hits)}')

print(f'model extent x={extent[0][0]:+.4f}..{extent[0][1]:+.4f} '
      f'y={extent[1][0]:+.4f}..{extent[1][1]:+.4f} z={extent[2][0]:+.4f}..{extent[2][1]:+.4f}')
print(f'forward-most bore vertex ({tip[0]:+.6f}, {tip[1]:+.6f}, {tip[2]:+.6f}), muzzle plane rows {tip_plane}')
print(f'heat band z-radius max {band_radius:.6f} over {len(band)} vertices, '
      f'foreign geometry {band_foreign or "none"}')
print(f'bore axis measured ({bore_x:+.9f}, {bore_z:+.9f}); bolt knob reaches x={knob_far:+.4f}')
if contract_failures:
    print(f'CONTRACT FAILURES: {len(contract_failures)}')
    for line in contract_failures:
        print(f'  {line}')
else:
    print('anchor contract: all assertions pass')

# --- check 2: heat-band clearance ------------------------------------------
# "No vertex other than the bore may enter the heat band": the runtime's
# 0.0625 glow sleeve and the support hand own that span. The seated warhead
# nose nests INSIDE the bore there (runtime owner's spec) and is the single
# exception; nothing may stand proud of the 0.0620 sleeve.
heat_band_failures = []
for name in band_foreign:
    heat_band_failures.append(f'{name} stands proud of the sleeve inside the heat band')
for name in sorted({n for (p, n) in band
                    if n not in BORE_ASSEMBLY and not n.startswith('Warhead')}):
    heat_band_failures.append(f'{name} enters the heat band')
for (p, n) in band:
    if n.startswith('Warhead') and math.hypot(p[0] - BORE_X, p[2] - BORE_Z) > 0.050:
        heat_band_failures.append(f'{n} leaves the bore nest inside the heat band')
        break
if heat_band_failures:
    print(f'HEAT BAND CLEARANCE: {len(heat_band_failures)} violations')
    for line in heat_band_failures:
        print(f'  {line}')
else:
    print('heat-band clearance: the band holds the bore and the seated nose alone')

# --- check 3: coplanar-face audit ------------------------------------------
def audit_coplanar_faces(tolerance=1e-6):
    """Flag faces from different parts that occupy the same plane and overlap."""
    planes = {}
    for (obj, _part, _material) in PARTS:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        low = [min((obj.matrix_world @ v.co)[i] for v in mesh.vertices) for i in range(3)]
        high = [max((obj.matrix_world @ v.co)[i] for v in mesh.vertices) for i in range(3)]
        faces = set()
        for polygon in mesh.polygons:
            normal = (obj.matrix_world.to_3x3() @ polygon.normal).normalized()
            axis = max(range(3), key=lambda i: abs(normal[i]))
            if abs(normal[axis]) < 0.999:
                continue
            centre = obj.matrix_world @ polygon.center
            if polygon.area > 1e-8:
                faces.add((axis, round(centre[axis], 5)))
        planes[obj.name] = {'bounds': (low, high), 'faces': faces}
        evaluated.to_mesh_clear()
    findings = []
    names = sorted(planes)
    for i, first in enumerate(names):
        for second in names[i + 1:]:
            for axis in range(3):
                other = [k for k in range(3) if k != axis]
                a, b = planes[first], planes[second]
                if any(a['bounds'][1][k] <= b['bounds'][0][k] + tolerance or
                       b['bounds'][1][k] <= a['bounds'][0][k] + tolerance for k in other):
                    continue
                for (face_axis, coordinate) in a['faces'] & b['faces']:
                    if face_axis != axis:
                        continue
                    findings.append(f'{first} / {second} share plane {axis}={coordinate}')
    return findings


collisions = audit_coplanar_faces()
if collisions:
    print(f'COPLANAR FACES: {len(collisions)}')
    for line in collisions:
        print(f'  {line}')
else:
    print('coplanar face audit: clean')

# --- check 4: floating-part audit ------------------------------------------
CONTACT_M = 0.0010        # 1 mm still reads as one machined form
CONTACT_ANCHOR = 'Launch tube core'


def audit_contact(tolerance=CONTACT_M):
    """Clusters of authored parts that do not reach the receiver."""
    geometry = {}
    for (obj, _part, _material) in PARTS:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        matrix = obj.matrix_world
        verts = [matrix @ v.co for v in mesh.vertices]
        polys = [tuple(p.vertices) for p in mesh.polygons]
        centres = [matrix @ p.center for p in mesh.polygons]
        low = [min(v[i] for v in verts) for i in range(3)]
        high = [max(v[i] for v in verts) for i in range(3)]
        probes = verts[::max(1, len(verts) // 8)][:8] + centres[::max(1, len(centres) // 4)][:4]
        geometry[obj.name] = {'verts': verts, 'probes': probes, 'low': low, 'high': high,
                              'tree': BVHTree.FromPolygons(verts, polys, all_triangles=False)}
        evaluated.to_mesh_clear()

    def overlapping(first, second, slack):
        return all(geometry[first]['low'][k] <= geometry[second]['high'][k] + slack and
                   geometry[second]['low'][k] <= geometry[first]['high'][k] + slack
                   for k in range(3))

    def surface_gap(first, second):
        best = 1e9
        for name, other in ((first, second), (second, first)):
            for point in geometry[name]['verts']:
                hit = geometry[other]['tree'].find_nearest(point)
                if hit[3] is not None and hit[3] < best:
                    best = hit[3]
        return best

    def inside(first, second):
        """Any probe of `first` inside the closed volume of `second`?"""
        tree = geometry[second]['tree']
        for point in geometry[first]['probes']:
            crossings = 0
            origin, direction = point.copy(), Vector((0.0, 0.0, 1.0))
            for _step in range(32):
                hit = tree.ray_cast(origin + direction * 1e-6, direction, 4.0)
                if hit[3] is None:
                    break
                crossings += 1
                origin = hit[0]
            if crossings % 2:
                return True
        return False

    parent = {name: name for name in geometry}

    def root(name):
        while parent[name] != name:
            parent[name] = parent[parent[name]]
            name = parent[name]
        return name

    names = sorted(geometry)
    for index, first in enumerate(names):
        for second in names[index + 1:]:
            if not overlapping(first, second, tolerance):
                continue
            attached = bool(geometry[first]['tree'].overlap(geometry[second]['tree']))
            if not attached:
                attached = inside(first, second) or inside(second, first)
            if not attached:
                attached = surface_gap(first, second) <= tolerance
            if attached:
                head, tail = root(first), root(second)
                if head != tail:
                    parent[tail] = head

    clusters = {}
    for name in names:
        clusters.setdefault(root(name), []).append(name)
    anchor = clusters.get(root(CONTACT_ANCHOR), []) if CONTACT_ANCHOR in parent else []
    findings = []
    for members in clusters.values():
        if anchor and root(members[0]) == root(CONTACT_ANCHOR):
            continue
        gaps = [(surface_gap(member, other), member, other)
                for member in members for other in anchor
                if overlapping(member, other, 0.06)]
        if gaps:
            (gap, member, other) = min(gaps)
            findings.append(f'floating group of {len(members)} next to {other}: '
                            f'{", ".join(sorted(members))} (closest {gap * 1000:.2f} mm)')
        else:
            findings.append(f'floating group of {len(members)}: {", ".join(sorted(members))}')
    return findings


floaters = audit_contact()
if floaters:
    print(f'FLOATING PARTS: {len(floaters)}')
    for line in floaters:
        print(f'  {line}')
else:
    print('part contact audit: every part meets the receiver')

if contract_failures or heat_band_failures or collisions or floaters:
    raise RuntimeError(
        f'build gate failed: {len(contract_failures)} contract, {len(heat_band_failures)} '
        f'heat-band, {len(collisions)} coplanar, {len(floaters)} floating')

# --- shared material-library pass, then pack and save the editable source ---
# apply_scene styles the six mapped materials onto their shared palette
# textures (the pass every other weapon went through; cavity black untouched).
import runpy
apply_scene = runpy.run_path(str(ROOT / 'tools/blender/material-library.py'))['apply_scene']
print(json.dumps({'material_library': apply_scene(scene)}, indent=2))
bpy.ops.file.pack_all()
BLEND = DOCS / 'torch.blend'
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND), copy=True, check_existing=False)

# --- batch to material draw calls and export -------------------------------
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()

batches = {}
gate_batches = {}
for (obj, part, material) in PARTS:
    (gate_batches if part == 'extra' else batches).setdefault((part, material), []).append(obj)

export_objects = list(PART_GROUP.values())
triangles = 0
per_primitive = {}
merged_batches = {**batches, **gate_batches}

for ((part, material), objects) in sorted(merged_batches.items()):
    bm = bmesh.new()
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        bm.from_mesh(mesh)
        evaluated.to_mesh_clear()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if part == 'extra':
        # Gate leaves ship hinge-local with the hinge travelling as the node
        # translation (BISON cover-leaf convention).
        bmesh.ops.transform(bm, matrix=Matrix.Translation(-Vector(HINGE)), verts=bm.verts)
    merged = bpy.data.meshes.new(f'{part} | {material} merged')
    bm.to_mesh(merged)
    bm.free()
    merged.materials.append(mats[material])
    project_uvs(merged)
    merged.calc_loop_triangles()
    triangles += len(merged.loop_triangles)
    per_primitive[f'{part} | {material}'] = len(merged.loop_triangles)
    node_name = f'gate | {material}' if part == 'extra' else f'{part} | {material}'
    obj = bpy.data.objects.new(node_name, merged)
    obj.parent = PART_GROUP[part]
    if part == 'extra':
        obj.location = HINGE
    STUDY.objects.link(obj)
    export_objects.append(obj)

export_objects += [MARKER_OBJECTS[name] for name in sorted(MARKERS)]

for (obj, _part, _material) in PARTS:
    mesh = obj.data
    bpy.data.objects.remove(obj, do_unlink=True)
    if mesh.users == 0:
        bpy.data.meshes.remove(mesh)

for layer in bpy.context.view_layer.layer_collection.children:
    if layer.collection is STUDY:
        bpy.context.view_layer.active_layer_collection = layer
bpy.context.view_layer.objects.active = PART_GROUP['body']

GLB = DOCS / 'torch.glb'
wanted = {'filepath': str(GLB), 'export_format': 'GLB', 'use_active_collection': True,
          'use_active_collection_with_nested': False, 'use_active_scene': True,
          'use_selection': False, 'use_visible': False, 'use_renderable': False,
          'export_apply': True,
          'export_yup': True, 'export_extras': True, 'export_cameras': False,
          'export_lights': False, 'export_animations': False, 'export_skins': False,
          'export_morph': False, 'export_image_format': 'AUTO', 'export_materials': 'EXPORT',
          'export_normals': True, 'export_texcoords': True, 'export_tangents': False,
          'export_def_bones': False, 'export_all_influences': False,
          'export_hierarchy_flatten_objs': False, 'export_try_sparse_sk': False}

supported = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
missing = [k for k in ('use_active_collection', 'use_active_scene', 'export_yup',
                       'export_extras') if k not in supported]
if missing:
    raise RuntimeError(f'Blender glTF exporter lacks required options: {missing}')
bpy.ops.export_scene.gltf(**{k: v for (k, v) in wanted.items() if k in supported})

_expected = {contract_node_name(obj.name) for obj in export_objects}
with open(GLB, 'rb') as handle:
    _header = handle.read(20)
(_length, _kind, _total, _json_len, _json_kind) = struct.unpack('<IIIII', _header)
with open(GLB, 'rb') as handle:
    handle.seek(20)
    _document = json.loads(handle.read(_json_len).decode('utf-8'))
_foreign = sorted({contract_node_name(node.get('name', '')) for node in _document['nodes']}
                  - _expected)
if _foreign:
    raise RuntimeError(f'unexpected nodes in the GLB export: {_foreign}')

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
    contract_tints = {f'{ASSET} | {key}': list(material.get('gltf_tint', ()))
                      for (key, material) in mats.items()}
    for material in document.get('materials', []):
        pbr = material.get('pbrMetallicRoughness', {})
        tint = contract_tints.get(material.get('name', ''))
        if tint and 'baseColorTexture' in pbr and 'alphaMode' not in material:
            pbr['baseColorFactor'] = tint + [1]
    seen = set()
    for node in document.get('nodes', []):
        name = contract_node_name(node.get('name', ''))
        if name in GROUPS:
            node.setdefault('extras', {})['blenderAsset'] = 'torch'
        if name.startswith('gate | '):
            node.setdefault('extras', {})['role'] = 'breech gate'
        if name:
            if name in seen:
                raise ValueError(f'duplicate glTF node name after normalisation: {name}')
            seen.add(name)
        node['name'] = name
    payload = json.dumps(document, separators=(',', ':')).encode('utf-8')
    chunks[0][1] = payload + b' ' * (-len(payload) % 4)
    chunks[1][1] = chunks[1][1] + b'\0' * (-len(chunks[1][1]) % 4)
    body = b''.join(struct.pack('<II', len(blob), kind) + blob for (kind, blob) in chunks)
    path.write_bytes(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)


normalize_glb(GLB)

# The shared material-library pass finishes the portable GLB too: palette maps
# and the textureLibrary/textureBumpScale extras every delivery carries.
_patch = runpy.run_path(str(ROOT / 'tools/blender/material-library.py'))
print(json.dumps({'glb_materials': _patch['patch_glb'](GLB)}, indent=2))

# --- record ----------------------------------------------------------------
manifest = {
    'asset': 'TORCH',
    'asset_id': 'torch',
    'kind': 'original heavy sci-fi shoulder-fired rocket launcher prop (visual game asset)',
    'blender': bpy.app.version_string,
    'authoring_script': 'tools/blender/torch/build-torch.py',
    'source_parts': len(PARTS),
    'animation_group_nodes': GROUPS,
    'marker_nodes': sorted(MARKERS),
    'batch_nodes': len(merged_batches),
    'round_nodes': [],
    'triangles': triangles,
    'triangles_per_primitive': per_primitive,
    'materials': MATERIAL_KEYS,
    'material_textures': {name: f'palette/{ASSIGNMENT[name]}.jpg'
                          for name in MATERIAL_KEYS if name in ASSIGNMENT},
    'texture_source': 'public/assets/blender/textures/palette (the shared 1024px palette '
                      'JPEGs applied by tools/blender/material-library.py; originals untouched)',
    'uv_density_tiles_per_metre': UV_SCALE,
    'axes': {'authoring': '+Y forward, +Z up, +X right',
             'after_gltf': '-Z forward, +Y up, +X right',
             'map': 'game_x = x, game_y = z, game_z = -y'},
    'anchors_game_space': {
        'muzzle': [MUZZLE[0], MUZZLE[2], -MUZZLE[1]],
        'grip': [GRIP[0], GRIP[2], -GRIP[1]],
        'support': [SUPPORT[0], SUPPORT[2], -SUPPORT[1]],
        'sight': [SIGHT[0], SIGHT[2], -SIGHT[1]],
    },
    'contract_points': {'breech_y': BREECH_Y, 'bore_axis': [BORE_X, BORE_Z],
                        'exposed_bore_radius': BORE_R,
                        'exposed_bore': [SLEEVE_END, MUZZLE[1]],
                        'heat_band': [-HEAT_BAND[1], -HEAT_BAND[0]],
                        'sight_height': SIGHT_Z,
                        'sight_posts': [REAR_POST_Y, FRONT_POST_Y]},
    'files': {'blend': 'docs/design/blender/torch/torch.blend',
              'glb': 'docs/design/blender/torch/torch.glb',
              'renders': ['render-hero.png', 'render-side.png', 'render-left.png',
                          'render-ads.png', 'render-rear.png'],
              'validation': 'docs/design/blender/torch/validation.json'},
    'build_time_checks': {
        'anchor_contract': 'muzzle plane, bore axis and exposed 0.0620 radius across '
                           'the whole heat band, all four markers, the 0.175 sight '
                           'line, the trigger blade and the arming lever home position '
                           'are asserted against the runtime contract every build',
        'heat_band_clearance': 'no vertex other than the bore may enter the heat band',
        'coplanar_face_audit': 'rejects flush faces between parts, which z-fight once '
                               'same-material parts merge into one draw call',
        'part_contact': 'every authored part must cross, nearly touch or sit inside '
                        'another part; a group that only meets the model through '
                        'empty space is reported as floating and fails the build',
    },
    'geometry_audit': {'coplanar_faces': collisions, 'floating_parts': floaters},
    'limitations': [
        'Scalar metallic/roughness only: no baked normal, occlusion or roughness maps.',
        'Single LOD; no mobile GPU profiling.',
        'Hand fit is unverified: the grip and support palms sit on the contract '
        'points and the geometry is built around them, but no third-person pose test '
        'was run.',
    ],
    'notes': ['Fresh design (study BULWARK): squared breech housing, half-cage braces, '
              'industrial panels and handles, a rocket nose peeking from the tube mouth.',
              'The heat band stays bare 0.0620 tube: the runtime glow sleeve at 0.0625 '
              'and the support hand own that span.',
              'The breech gate (venturi leaves) pivots at the frozen hinge; gate nodes '
              'ship hinge-local with the hinge as node translation.',
              'Markings are modelled geometry, not a texture decal.',
              'No loose rounds: the reload rocket is spawned procedurally by the runtime.',
              'Flip-up ladder sights bracket the shared 0.175 sight line.'],
}
(DOCS / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({k: manifest[k] for k in ('source_parts', 'batch_nodes', 'triangles')}, indent=2))
print(f'blend={BLEND} bytes={BLEND.stat().st_size}')
print(f'glb={GLB} bytes={GLB.stat().st_size}')
