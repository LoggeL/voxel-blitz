"""Author TORCH, the RX-8 HAVOC heavy rocket launcher prop for Voxel Blitz.

Revision 4 ("RIDGEBACK") rebuilds the RX-8 HAVOC from the GPT Image 2.5
concept study in docs/design/havoc-rev4/concept-ridgeback.png:
  - Sculpted super-elliptic olive-drab receiver with a low dorsal spine,
    recessed polymer service pockets, gunmetal collar bands with orange
    accent rings, and modelled RX-8 / HAVOC ivory stencil markings.
  - Long perforated forward shroud: sixteen gunmetal hexagonal frames over a
    cavity-black sleeve, four longitudinal rails, and orange warning collars.
    The open hex cells read as cooling ports without a boolean pass.
  - Left-flank carry handle / sight-protection loop with an orange data plate,
    clear of the 0.175 m sight channel and the reload gate sweep.
  - Internal cavity-black bore blast baffle and a castellated muzzle crown that
    cradles the seated warhead nose.
  - Low-profile gunmetal sight bridge with an open U-notch rear sight and a
    hooded orange front post at z = 0.175.
  - Ergonomic raked pistol grip, angled foregrip, left-flank shoulder pad,
    underslung cylindrical ignition canister (`mag`), right-flank arming lever
    (`bolt`), and trigger assembly (`trigger`).
  - Compact four-port blast-brake breech gate (`extra`, role `gate`) on the
    vertical left-flank hinge pin: four tapered lobes with dark port shadows
    inside the same 0.083 m envelope as revision 3.
  - Complete fin-stabilized HAVOC rocket round (`extra`, role `round`) authored
    around ROUND_SEAT = (0.0, 0.550, 0.075).

Run headless:

    blender --background --factory-startup --python tools/blender/torch/build-torch.py

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
SIGHT = (0.000, 0.340, 0.175)      # sight axis, game y = 0.175
MARKERS = {'muzzle': MUZZLE, 'grip': GRIP, 'support': SUPPORT, 'sight': SIGHT}

BORE_X, BORE_Z = 0.000, 0.075   # bore axis
BORE_R = 0.0620                 # exposed bore radius (BARREL_R.rocket - clearance)
BORE_IN = 0.0555                # clear bore: the runtime reload round needs >= 0.055
BORE_START = 0.145              # tube tail, seated in the rear receiver collar
SLEEVE_END = 0.525              # forward jacket collar: bare sleeve begins after it
HEAT_BAND = (0.528, 0.752)      # game z -0.528 .. -0.752; runtime glow sleeve 0.0625
BREECH_Y = 0.220                # BREACH_Z.rocket -0.22

# Gate pivot: vertical pin on the left flank at game (-0.104, 0.075, -0.135)
HINGE = (-0.104, 0.135, 0.075)
HINGE_PIN_Z = (0.018, 0.132)    # the pin spans authoring z 0.018..0.132 (game y)
GATE_SWING = 1.75               # rad, runtime gate.rotation.y = -GATE_SWING * open
GATE_SWEEP_MAX = 1.85           # audited swing range (runtime overshoot included)
GATE_AXIS_CLEARANCE = 0.055     # open gate must stay this far from the bore axis
GATE_REAR_Z_GAME = -0.060       # rocketReload.rearZ = BREACH_Z.rocket + 0.16 (round path)

# Seated rocket round origin: game (0.0, 0.075, -0.55)
ROUND_SEAT = (0.000, 0.550, 0.075)

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
MATERIAL_KEYS = ['gunmetal', 'olive drab', 'orange paint', 'ivory coating',
                 'polymer', 'rubber', 'cavity black', 'machined steel']
LIBRARY = json.loads((ROOT / 'docs/design/blender/material-library/materials.json').read_text())
ASSIGNMENT = LIBRARY['assignment']

mats = {}
for name in MATERIAL_KEYS:
    material = bpy.data.materials.get(f'{ASSET} | {name}') \
        or bpy.data.materials.new(f'{ASSET} | {name}')
    material.use_nodes = True
    mats[name] = material

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


def superellipse(rx, rz, power=4.0, segments=24, phase=-math.pi / 2):
    """Rounded-rectangle cross-section for the lofted receiver shells."""
    points = []
    for index in range(segments):
        angle = phase + 2 * math.pi * index / segments
        cosine, sine = math.cos(angle), math.sin(angle)
        points.append((rx * math.copysign(abs(cosine) ** (2 / power), cosine),
                       rz * math.copysign(abs(sine) ** (2 / power), sine)))
    return points


def hex_ring(outer, inner, depth):
    """A hexagonal window frame extruded along X, for the perforated shroud."""
    return solid(polygon(outer, 6, math.pi / 6), depth, 'X', polygon(inner, 6, math.pi / 6))


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
    """Hollow frustum ring along Y with annular end caps."""
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

    outer0 = ring(r_out0, y0)
    outer1 = ring(r_out1, y1)
    inner0 = ring(r_in0, y0)
    inner1 = ring(r_in1, y1)

    def quads(first, second, flip=False):
        span = segments
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
    """Hollow cylinder with lengthwise ring subdivisions and forced rows."""
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


def add(name, part, material, shape, loc=(0, 0, 0), rot=(0, 0, 0),
        bevel=.0025, uv_scale=UV_SCALE, sight=False, extra_role=None):
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
    if extra_role:
        obj['extra_role'] = extra_role
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
         bevel=.0025, sight=False, extra_role=None):
    """Mirror a part across X (two named parts, not one mirrored object)."""
    for side in (1, -1):
        add(f'{name} {"right" if side > 0 else "left"}', part, material, shape,
            loc=(side * loc[0], loc[1], loc[2]),
            rot=(rot[0], side * rot[1], side * rot[2]),
            bevel=bevel, sight=sight, extra_role=extra_role)


def add_text(text, name, part, material, loc, rot, size, extrude=.0014):
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


# ===========================================================================
# BODY: Launch tube core, bore liner + blast baffle, castellated muzzle crown,
# super-elliptic receiver shell, perforated forward shroud, low-profile
# sight bridge, U-notch & hooded sights, raked pistol grip, foregrip, shoulder pad
# ===========================================================================
# 1. Launch tube core + Bore liner + Internal Bore Blast Baffle
BORE_OBJECT = add('Launch tube core', 'body', 'gunmetal',
                  offset(hollow_stacked(BORE_R, 0.0570, BORE_START, MUZZLE[1], .025,
                                        24, rows=(*HEAT_BAND, MUZZLE[1])), dz=BORE_Z),
                  bevel=0)
BORE_LINER_OBJECT = add('Bore liner', 'body', 'cavity black',
                        offset(hollow_stacked(0.0572, BORE_IN, 0.149, 0.778, .08, 20), dz=BORE_Z),
                        bevel=0)
BORE_BAFFLE_OBJECT = add('Bore blast baffle', 'body', 'cavity black',
                         tube(0.0560, 0.008, 20, axis='Y'),
                         loc=(0.0, 0.215, BORE_Z), bevel=0)
BORE_ASSEMBLY = {BORE_OBJECT.name, BORE_LINER_OBJECT.name, BORE_BAFFLE_OBJECT.name}

# 2. Castellated Muzzle Crown (y = 0.753..0.780)
add('Muzzle blast collar', 'body', 'machined steel',
    offset(shell(0.0750, 0.0760, 0.0600, 0.0600, 0.753, 0.7785, 24), dz=BORE_Z), bevel=.0018)
add('Muzzle collar rear taper', 'body', 'gunmetal',
    offset(shell(0.0615, 0.0735, 0.0595, 0.0595, 0.7522, 0.756, 24), dz=BORE_Z), bevel=.001)
add('Muzzle warning band', 'body', 'orange paint',
    offset(shell(0.0772, 0.0772, 0.0730, 0.0730, 0.7555, 0.7665, 24), dz=BORE_Z), bevel=.0012)
# 6 radial castellated crown lugs around the circumference (skipping top 90 deg for sight riser)
for idx, angle_deg in enumerate((25, 155, 205, 250, 290, 335)):
    ang = math.radians(angle_deg)
    lx = 0.0745 * math.cos(ang)
    lz = BORE_Z + 0.0745 * math.sin(ang)
    add(f'Muzzle crown lug {idx + 1}', 'body', 'gunmetal',
        boxv((.014, .021, .016)),
        loc=(lx, 0.7685, lz),
        rot=(0, -ang + math.pi / 2, 0), bevel=.0015)

# 3. Sculpted Super-Elliptic Armored Receiver Shell (y = 0.143..0.365)
# A lofted rounded-rectangle monocoque replaces the revision-3 octagonal slab.
RECEIVER_PROFILE = superellipse(.087, .084, 4.0, 24)
RECEIVER_FORWARD_PROFILE = superellipse(.084, .082, 4.0, 24)
RECEIVER_BORE = superellipse(.0605, .0600, 4.0, 24)
RECEIVER_BORE_FORWARD = superellipse(.0610, .0605, 4.0, 24)
add('Receiver rear shell', 'body', 'olive drab',
    offset(solid(RECEIVER_PROFILE, .158, 'Y', RECEIVER_BORE), dz=BORE_Z),
    loc=(0, 0.222, 0), bevel=.0035)
add('Receiver forward shell', 'body', 'olive drab',
    offset(solid(RECEIVER_FORWARD_PROFILE, .078, 'Y', RECEIVER_BORE_FORWARD), dz=BORE_Z),
    loc=(0, 0.326, 0), bevel=.003)

# Upper chamfered shoulder fairings along receiver flanks
pair('Receiver upper shoulder', 'body', 'olive drab',
     boxv((.022, .238, .022)),
     loc=(.060, 0.274, 0.137), rot=(0, math.radians(-32), 0), bevel=.0025)
# Lower receiver belly housing fairness
add('Receiver lower belly', 'body', 'olive drab',
    boxv((.100, .229, .030)),
    loc=(0, 0.2495, -0.008), bevel=.003)

# Low dorsal spine: the carry handle and sight bridge land on it.
add('Receiver dorsal spine', 'body', 'gunmetal',
    boxv((.040, .214, .014)),
    loc=(0, 0.253, 0.1505), bevel=.002)
add('Receiver spine accent', 'body', 'orange paint',
    boxv((.024, .058, .004)),
    loc=(0, 0.329, 0.1575), bevel=.001)

# Gunmetal structural collar bands with orange accent rings
# Rear collar band (y = 0.148..0.182)
add('Receiver collar rear', 'body', 'gunmetal',
    offset(shell(.0900, .0880, .0600, .0600, 0.148, 0.182, 20), dz=BORE_Z), bevel=.002)
add('Receiver collar rear accent', 'body', 'orange paint',
    offset(shell(.0915, .0915, .0845, .0845, 0.154, 0.166, 24), dz=BORE_Z), bevel=.0012)

# Mid collar band (y = 0.292..0.316)
add('Receiver collar mid', 'body', 'gunmetal',
    offset(shell(.0905, .0890, .0600, .0600, 0.292, 0.316, 20), dz=BORE_Z), bevel=.002)
add('Receiver collar mid accent', 'body', 'orange paint',
    offset(shell(.0918, .0918, .0845, .0845, 0.298, 0.308, 24), dz=BORE_Z), bevel=.0012)

# Front collar band (y = 0.356..0.376)
add('Receiver collar front', 'body', 'gunmetal',
    offset(shell(.0890, .0870, .0600, .0600, 0.356, 0.376, 20), dz=BORE_Z), bevel=.002)
add('Receiver collar front accent', 'body', 'orange paint',
    offset(shell(.0900, .0900, .0830, .0830, 0.362, 0.371, 24), dz=BORE_Z), bevel=.0012)

# Recessed dark polymer side service pockets & armored flank panels
pair('Receiver flank armor', 'body', 'olive drab',
     boxv((.016, .128, .090)),
     loc=(.0805, 0.300, 0.073), bevel=.0025)
pair('Service pocket rear frame', 'body', 'polymer',
     boxv((.012, .070, .042)),
     loc=(.0875, 0.205, 0.082), bevel=.002)
pair('Service pocket rear recess', 'body', 'cavity black',
     boxv((.006, .058, .030)),
     loc=(.0915, 0.205, 0.082), bevel=0)
pair('Service pocket front frame', 'body', 'polymer',
     boxv((.012, .064, .038)),
     loc=(.0875, 0.300, 0.070), bevel=.002)
pair('Service pocket front recess', 'body', 'cavity black',
     boxv((.006, .052, .026)),
     loc=(.0918, 0.300, 0.070), bevel=0)
pair('Receiver lower rail trim', 'body', 'gunmetal',
     boxv((.016, .100, .022)),
     loc=(.076, 0.230, 0.018), bevel=.002)

# Modelled stencil markings on raised flank plates
pair('Marking plate', 'body', 'olive drab',
     boxv((.005, .082, .044)),
     loc=(.0865, 0.300, 0.087), bevel=.001)
add_text('RX-8', 'Marking RX-8 left', 'body', 'ivory coating',
         (-0.0895, 0.300, 0.096), (math.pi / 2, 0, -math.pi / 2), .015)
add_text('HAVOC', 'Marking HAVOC left', 'body', 'ivory coating',
         (-0.0895, 0.300, 0.074), (math.pi / 2, 0, -math.pi / 2), .013)
add_text('RX-8', 'Marking RX-8 right', 'body', 'ivory coating',
         (0.0895, 0.300, 0.096), (math.pi / 2, 0, math.pi / 2), .015)
add_text('HAVOC', 'Marking HAVOC right', 'body', 'ivory coating',
         (0.0895, 0.300, 0.074), (math.pi / 2, 0, math.pi / 2), .013)

# Left-flank carry handle / sight-protection loop. It lives outside |x| < 0.02
# so the 0.175 m sight channel stays completely open.
# Left-flank ballistic computer, low enough to stay out of the ADS silhouette.
add('Ballistic computer', 'body', 'polymer',
    boxv((.020, .108, .040)),
    loc=(-.092, 0.309, 0.135), bevel=.002)
add('Ballistic computer lens', 'body', 'orange paint',
    boxv((.005, .060, .020)),
    loc=(-.1035, 0.310, 0.140), bevel=.001)

# 4. Perforated Forward Shroud (y = 0.372..0.527)
# A cavity-black sleeve carries sixteen gunmetal hexagonal frames. The frames
# are real rings, so each cell reads as a cooling port without a boolean pass.
SHROUD_Y0, SHROUD_Y1 = 0.372, 0.527
add('Shroud inner sleeve', 'body', 'cavity black',
    offset(shell(.0640, .0640, .0623, .0623, SHROUD_Y0 - .0005, SHROUD_Y1, 24), dz=BORE_Z), bevel=0)
add('Shroud rear collar', 'body', 'gunmetal',
    offset(shell(.0810, .0810, .0623, .0623, SHROUD_Y0, SHROUD_Y0 + .016, 24), dz=BORE_Z),
    bevel=.002)
add('Shroud front collar', 'body', 'gunmetal',
    offset(shell(.0800, .0800, .0623, .0623, SHROUD_Y1 - .016, SHROUD_Y1 - .001, 24), dz=BORE_Z),
    bevel=.002)
add('Shroud rear warning band', 'body', 'orange paint',
    offset(shell(.0818, .0818, .0770, .0770, SHROUD_Y0 + .002, SHROUD_Y0 + .009, 24),
           dz=BORE_Z), bevel=.001)
add('Shroud front warning band', 'body', 'orange paint',
    offset(shell(.0808, .0808, .0760, .0760, SHROUD_Y1 - .010, SHROUD_Y1 - .003, 24),
           dz=BORE_Z), bevel=.001)

# Two staggered rows of eight hex frames around the sleeve.
for (row, (frame_y, phase_deg)) in enumerate(((0.404, 0.0), (0.476, 22.5))):
    for index in range(8):
        angle = math.radians(phase_deg + index * 45)
        add(f'Shroud hex frame {row + 1}-{index + 1}', 'body', 'gunmetal',
            hex_ring(.0205, .0125, .020),
            loc=(.0730 * math.cos(angle), frame_y, BORE_Z + .0730 * math.sin(angle)),
            rot=(0, -angle, 0), bevel=0)

# Four longitudinal rails tie the frame rows to the end collars.
for index, angle_deg in enumerate((0, 90, 180, 270)):
    angle = math.radians(angle_deg)
    add(f'Shroud longitudinal rail {index + 1}', 'body', 'gunmetal',
        boxv((.012, .150, .022)),
        loc=(.0740 * math.cos(angle), 0.4495, BORE_Z + .0740 * math.sin(angle)),
        rot=(0, -angle, 0), bevel=.0015)

# The support-hand bracket wraps the shroud underside.
add('Fore grip shroud bracket', 'body', 'gunmetal',
    boxv((.054, .068, .030)),
    loc=(-.028, 0.412, -0.002), bevel=.0025)

# 5. Breech Hinge Hardware & Right-Flank Latch Keeper / Lever Boss
PIN_LENGTH = HINGE_PIN_Z[1] - HINGE_PIN_Z[0]
add('Hinge lug', 'body', 'gunmetal', boxv((.032, .028, .050)),
    loc=(-.100, HINGE[1], HINGE[2]), bevel=.002)
add('Hinge pin', 'body', 'gunmetal', tube(.010, PIN_LENGTH, 12, axis='Z'),
    loc=(HINGE[0], HINGE[1], (HINGE_PIN_Z[0] + HINGE_PIN_Z[1]) / 2), bevel=0)
add('Hinge pin cap top', 'body', 'orange paint', tube(.013, .005, 12, axis='Z'),
    loc=(HINGE[0], HINGE[1], HINGE_PIN_Z[1] + 0.0015), bevel=.001)
add('Hinge pin cap bottom', 'body', 'orange paint', tube(.013, .005, 12, axis='Z'),
    loc=(HINGE[0], HINGE[1], HINGE_PIN_Z[0] - 0.0015), bevel=.001)

add('Latch keeper', 'body', 'gunmetal',
    solid([(0.072, 0.149), (0.090, 0.149), (0.090, 0.086), (0.102, 0.086),
           (0.102, 0.168), (0.072, 0.168)], .040, 'Z'),
    loc=(0, 0, BORE_Z), bevel=.0015)

add('Lever boss', 'body', 'gunmetal', boxv((.021, .032, .042)),
    loc=(.0865, 0.039, 0.025), bevel=.002)
add('Flank rib right', 'body', 'gunmetal', boxv((.016, .118, .034)),
    loc=(.0825, 0.102, 0.028), bevel=.002)

# 6. Low-Profile Sight Bridge & Open U-Notch / Hooded Post Sights (z = 0.175)
# Low-profile gunmetal structural sight bridge spanning y = 0.045..0.480,
# sitting at z = 0.156..0.166 so the venturi gate sweeps cleanly underneath!
add('Sight bridge rail', 'body', 'gunmetal',
    boxv((.036, .435, .009)),
    loc=(0, 0.2625, 0.1615), bevel=.0018)
add('Sight bridge rear stanchion', 'body', 'gunmetal',
    boxv((.042, .034, .016)),
    loc=(0, 0.164, 0.151), bevel=.002)
add('Sight bridge mid stanchion', 'body', 'gunmetal',
    boxv((.042, .044, .016)),
    loc=(0, 0.300, 0.151), bevel=.002)
add('Sight bridge front stanchion', 'body', 'gunmetal',
    boxv((.040, .038, .018)),
    loc=(0, 0.456, 0.150), bevel=.002)
add('Sight bridge rear foot', 'body', 'gunmetal',
    boxv((.038, .062, .009)),
    loc=(0, 0.036, 0.1645), bevel=.0015)
for idx, y_slot in enumerate((0.228, 0.378)):
    pair(f'Sight bridge cutout trim {idx + 1}', 'body', 'polymer',
         boxv((.006, .064, .006)),
         loc=(.018, y_slot, 0.1615), bevel=.001)

# Rear sight assembly centered at y = REAR_POST_Y (0.020) (sight=True)
# Wide open U-notch with Rear sight ear left/right at |x| = 0.018, z = 0.172..0.196
# and orange paint rear notch pip below the line (z = 0.171..0.175), NO crossbar blocking center!
add('Rear sight base', 'body', 'gunmetal', boxv((.046, .034, .009)),
    loc=(0, REAR_POST_Y, 0.1700), bevel=.0015, sight=True)
add('Rear sight base orange trim', 'body', 'orange paint', boxv((.048, .022, .004)),
    loc=(0, REAR_POST_Y, 0.1655), bevel=.001, sight=True)
pair('Rear sight ear', 'body', 'gunmetal', boxv((.008, .024, .024)),
     loc=(.018, REAR_POST_Y, 0.184), bevel=.0015, sight=True)
pair('Rear sight ear guard', 'body', 'polymer', boxv((.006, .018, .018)),
     loc=(.022, REAR_POST_Y, 0.182), bevel=.001, sight=True)
add('Rear sight pip', 'body', 'orange paint', boxv((.007, .006, .0035)),
    loc=(0, REAR_POST_Y, 0.1730), bevel=0, sight=True)

# Front sight assembly centered at y = FRONT_POST_Y (0.768) (sight=True)
# Protective side hood walls (|x| = 0.013), gunmetal post, orange front sight tip at z = 0.175
add('Front sight riser', 'body', 'gunmetal', boxv((.030, .020, .024)),
    loc=(0, FRONT_POST_Y, 0.155), bevel=.0015, sight=True)
add('Front sight post', 'body', 'gunmetal', boxv((.005, .007, .016)),
    loc=(0, FRONT_POST_Y, 0.166), bevel=0, sight=True)
add('Front sight tip', 'body', 'orange paint', boxv((.0055, .0075, .005)),
    loc=(0, FRONT_POST_Y, 0.175), bevel=0, sight=True)
pair('Front sight hood wall', 'body', 'gunmetal', boxv((.005, .016, .026)),
     loc=(.013, FRONT_POST_Y, 0.176), bevel=.0015, sight=True)

# 7. Ergonomic Furniture: Raked Pistol Grip, Foregrip, Left-Flank Shoulder Pad
# Pistol grip around GRIP = (0.045, 0.080, -0.020), top <= -0.008 to clear gate sweep
add('Pistol grip', 'body', 'polymer', prism([
    (0.156, -0.007), (0.064, -0.007), (0.034, -0.056), (0.040, -0.114),
    (0.104, -0.122), (0.128, -0.058)], .054), bevel=.006)
pair('Pistol grip rubber panel', 'body', 'rubber', prism([
    (0.132, -0.022), (0.072, -0.022), (0.050, -0.098), (0.098, -0.104)], .008),
    loc=(.027, 0, 0), bevel=.002)
for index, (y, z) in enumerate(((0.126, -0.018), (0.104, -0.072), (0.080, -0.108))):
    add(f'Grip finger swell {index + 1}', 'body', 'rubber', boxv((.060, .009, .010)),
        loc=(0, y, z), bevel=.0015)
add('Grip heel cap', 'body', 'gunmetal', boxv((.060, .062, .014)),
    loc=(0, 0.072, -0.124), bevel=.003)
add('Grip backstrap', 'body', 'rubber', boxv((.042, .016, .052)),
    loc=(0, 0.046, -0.082), bevel=.004)

# Forward grip around SUPPORT = (-0.060, 0.400, -0.030), keeping z <= 0.010
add('Fore grip collar', 'body', 'orange paint', boxv((.058, .058, .014)),
    loc=(-.032, 0.412, -0.020), bevel=.0015)
add('Fore grip body', 'body', 'polymer', prism([
    (0.438, -0.024), (0.382, -0.024), (0.374, -0.118),
    (0.432, -0.120), (0.440, -0.060)], .050), loc=(-.032, 0, 0), bevel=.005)
add('Fore grip rubber insert right', 'body', 'rubber', boxv((.008, .038, .074)),
    loc=(-.007, 0.408, -0.072), bevel=.002)
add('Fore grip rubber insert left', 'body', 'rubber', boxv((.008, .038, .074)),
    loc=(-.057, 0.408, -0.072), bevel=.002)
for index, z in enumerate((-0.044, -0.064, -0.084, -0.104)):
    add(f'Fore grip rib {index + 1}', 'body', 'rubber', boxv((.054, .056, .007)),
        loc=(-.032, 0.407, z), bevel=.0015)
add('Fore grip pommel', 'body', 'gunmetal', boxv((.056, .062, .012)),
    loc=(-.032, 0.404, -0.123), bevel=.0025)

# Contoured left-flank shoulder pad at y = 0.227 (clear of gate sweep)
BRACE_Y = 0.227
add('Shoulder bracket arm', 'body', 'gunmetal', boxv((.028, .062, .048)),
    loc=(-.083, BRACE_Y + 0.028, 0.038), bevel=.003)
add('Shoulder bracket drop', 'body', 'gunmetal', boxv((.024, .048, .068)),
    loc=(-.098, BRACE_Y + 0.024, 0.015), bevel=.003)
add('Shoulder backing plate', 'body', 'gunmetal', boxv((.018, .106, .088)),
    loc=(-.1055, BRACE_Y, 0.010), bevel=.003)
add('Shoulder pad cushion', 'body', 'rubber', boxv((.022, .100, .082)),
    loc=(-.118, BRACE_Y, 0.010), bevel=.006)
for index, z in enumerate((-0.020, 0.040)):
    add(f'Shoulder pad strap {index + 1}', 'body', 'gunmetal', boxv((.026, .090, .009)),
        loc=(-.118, BRACE_Y, z), bevel=.0015)

# ===========================================================================
# MAG: Underslung Cylindrical Ignition Canister (y = 0.240..0.355, z = -0.062)
# ===========================================================================
add('Ignition canister body', 'mag', 'polymer',
    tube(0.034, 0.102, 16, axis='Y'),
    loc=(0.0, 0.298, -0.062), bevel=.0025)
add('Ignition canister front cap', 'mag', 'gunmetal',
    tube(0.0365, 0.018, 16, axis='Y'),
    loc=(0.0, 0.344, -0.062), bevel=.002)
add('Ignition canister rear cap', 'mag', 'gunmetal',
    tube(0.0365, 0.018, 16, axis='Y'),
    loc=(0.0, 0.250, -0.062), bevel=.002)
add('Ignition canister band', 'mag', 'orange paint',
    tube(0.0372, 0.016, 16, axis='Y'),
    loc=(0.0, 0.312, -0.062), bevel=.0012)
add('Ignition bracket front', 'mag', 'gunmetal',
    boxv((.034, .022, .046)),
    loc=(0.0, 0.328, -0.026), bevel=.002)
add('Ignition bracket rear', 'mag', 'gunmetal',
    boxv((.034, .022, .046)),
    loc=(0.0, 0.268, -0.026), bevel=.002)

# ===========================================================================
# BOLT: Right-Flank Mechanical Arming Lever (home y = 0.040, knob x = 0.114)
# ===========================================================================
BOLT_KNOB_OBJECT = add('Arming lever knob', 'bolt', 'orange paint',
                       tube(.013, .022, 12, axis='X'),
                       loc=(.103, BOLT_HOME_Y, 0.021), bevel=.0015)
add('Arming lever shoe', 'bolt', 'gunmetal', boxv((.022, .028, .034)),
    loc=(.089, BOLT_HOME_Y, 0.023), bevel=.002)
add('Arming lever arm', 'bolt', 'gunmetal', boxv((.018, .036, .024)),
    loc=(.097, BOLT_HOME_Y, 0.021), bevel=.002)
add('Arming lever pivot', 'bolt', 'gunmetal', tube(.008, .016, 10, axis='X'),
    loc=(.085, 0.058, 0.036), bevel=0)

# ===========================================================================
# TRIGGER: Curved/angled trigger blade (tip y = 0.110, z = -0.055), orange shoe, guard
# ===========================================================================
TRIGGER_OBJECT = add('Trigger blade', 'trigger', 'gunmetal', boxv((.010, .016, .045)),
                     loc=(0, TRIGGER_Y, -0.0316), rot=(math.radians(8), 0, 0), bevel=.002)
add('Trigger shoe', 'trigger', 'orange paint', boxv((.012, .009, .016)),
    loc=(0, TRIGGER_Y + 0.003, -0.047), rot=(math.radians(8), 0, 0), bevel=.0015)
add('Trigger guard', 'trigger', 'gunmetal',
    solid(recty(0.060, 0.170, -0.078, -0.006), .030, 'X',
          recty(0.072, 0.156, -0.064, -0.020)), bevel=.003)

# ===========================================================================
# EXTRA (role = 'gate'): Tapered Fluted De Laval Venturi Breech Gate
# ===========================================================================
GATE_FRONT_Y, GATE_REAR_Y = 0.112, -0.048
GATE_LOBE_SPANS = ((18, 72), (108, 162), (198, 252), (288, 342))
GATE_CORE_NAMES = [
    'Gate lobe 1', 'Gate lobe 2', 'Gate lobe 3', 'Gate lobe 4',
    'Gate front collar', 'Gate front lip',
    'Gate rear rim 1', 'Gate rear rim 2', 'Gate rear rim 3', 'Gate rear rim 4',
    'Gate warning band 1', 'Gate warning band 2', 'Gate warning band 3', 'Gate warning band 4',
    'Gate port shadow 1', 'Gate port shadow 2', 'Gate port shadow 3', 'Gate port shadow 4',
    'Gate blast hub', 'Gate blast hub cap'
]
GATE_CORE_BOUNDS = ((-0.079889, 0.079889), (-0.048, 0.112), (BORE_Z - 0.079889, BORE_Z + 0.079889))


def gate(name, material, shape, loc=(0, 0, 0), rot=(0, 0, 0), bevel=.002):
    return add(name, 'extra', material, shape, loc=loc, rot=rot,
               bevel=bevel, extra_role='gate')


# Compact four-port blast brake: four tapered lobes with 18-degree gaps read as
# open ports from behind. Front collar and rear rim keep the 0.083 m envelope.
for index, (a0_deg, a1_deg) in enumerate(GATE_LOBE_SPANS):
    a0, a1 = math.radians(a0_deg), math.radians(a1_deg)
    gate(f'Gate lobe {index + 1}', 'gunmetal',
         offset(shell(.0680, .0800, .0570, .0640, GATE_FRONT_Y, -0.030,
                      8, a0=a0, a1=a1), dz=BORE_Z), bevel=.0015)
    gate(f'Gate rear rim {index + 1}', 'gunmetal',
         offset(shell(.0830, .0820, .0640, .0640, -0.029, GATE_REAR_Y,
                      8, a0=a0, a1=a1), dz=BORE_Z), bevel=.0015)
    gate(f'Gate warning band {index + 1}', 'orange paint',
         offset(shell(.0840, .0840, .0770, .0770, -0.020, -0.031,
                      8, a0=a0, a1=a1), dz=BORE_Z), bevel=.001)
# The front collar stays inside the revision-3 0.0715 envelope: it sits beside
# the trigger guard and must clear it through the whole swing.
gate('Gate front collar', 'gunmetal',
     offset(shell(.0715, .0705, .0570, .0570, 0.110, 0.090, 24), dz=BORE_Z), bevel=.0015)
gate('Gate front lip', 'gunmetal',
     offset(shell(.0715, .0715, .0700, .0700, 0.112, 0.108, 24), dz=BORE_Z), bevel=.001)
# Dark port floors fill the four gaps between the lobes.
for index, angle_deg in enumerate((0, 90, 180, 270)):
    angle = math.radians(angle_deg)
    gate(f'Gate port shadow {index + 1}', 'cavity black',
         boxv((.039, .100, .030)),
         loc=(.0445 * math.cos(angle), 0.0055, BORE_Z + .0445 * math.sin(angle)),
         rot=(0, -angle, 0), bevel=0)
gate('Gate blast hub', 'gunmetal',
     offset(taper(0.0250, 0.0550, -0.046, 0.108, 24), dz=BORE_Z), bevel=.0015)
gate('Gate blast hub cap', 'cavity black',
     offset(taper(0.0120, 0.0100, -0.047, -0.043, 16), dz=BORE_Z), bevel=0)

# External flutes on the four lobes (short enough to stay on the taper).
for index, angle_deg in enumerate((35, 55, 125, 145, 215, 235, 305, 325)):
    angle = math.radians(angle_deg)
    gate(f'Gate flute rib {index + 1}', 'gunmetal',
         boxv((.006, .080, .007)),
         loc=(.0745 * math.cos(angle), 0.030, BORE_Z + .0745 * math.sin(angle)),
         rot=(0, -angle, 0), bevel=.001)
# Twin hinge knuckles at HINGE = (-0.104, 0.135, 0.075)
for (label, z) in (('top', 0.1155), ('bottom', 0.0345)):
    gate(f'Gate knuckle {label}', 'gunmetal', washer(.0155, .0105, .025, 12, axis='Z'),
         loc=(HINGE[0], HINGE[1], z), bevel=0)
    # The arm runs into its knuckle eye, stopping 2.5 mm short of the pin.
    gate(f'Gate knuckle arm {label}', 'gunmetal', boxv((.054, .0265, .021)),
         loc=(-.083, 0.10925, z), bevel=.0015)

# Right-flank orange paint cam latch
gate('Gate latch', 'orange paint', boxv((.023, .026, .034)),
     loc=(0.0775, 0.101, BORE_Z), bevel=.002)

# ===========================================================================
# EXTRA (role = 'round'): Authored Fin-Stabilized HAVOC Rocket Round
# Centered around ROUND_SEAT = (0.0, 0.550, 0.075) -> game (0.0, 0.075, -0.55)
# Spanning y = 0.400 .. 0.795 in authoring space:
#   - Nose tip at y = 0.795 (relative +0.245 -> game z = -0.245)
#   - Tail nozzle at y = 0.400 (relative -0.150 -> game z = +0.150)
# ===========================================================================
def round_part(name, material, shape, loc=(0, 0, 0), rot=(0, 0, 0), bevel=.0015):
    return add(name, 'extra', material, shape, loc=loc, rot=rot,
               bevel=bevel, extra_role='round')


# 1. Nose tip (y = 0.782..0.795, radius 0.018 -> 0.004)
round_part('Round nose tip', 'orange paint',
           offset(taper(0.0180, 0.0040, 0.781, 0.795, 20), dz=BORE_Z), bevel=0)
# 2. Ogive (y = 0.710..0.782, radius 0.044 -> 0.018)
round_part('Round ogive', 'ivory coating',
           offset(taper(0.0440, 0.0175, 0.708, 0.782, 24), dz=BORE_Z), bevel=.001)
# 3. Warhead band (y = 0.684..0.710, radius 0.045)
round_part('Round warhead band', 'orange paint',
           offset(taper(0.0448, 0.0445, 0.684, 0.710, 24), dz=BORE_Z), bevel=.001)
# 4. Warhead shoulder (y = 0.640..0.684, radius 0.039 -> 0.0445)
round_part('Round warhead shoulder', 'olive drab',
           offset(taper(0.0390, 0.0445, 0.638, 0.686, 24), dz=BORE_Z), bevel=.001)
# 5. Motor body (y = 0.435..0.640, radius 0.039)
round_part('Round motor body', 'olive drab',
           offset(taper(0.0390, 0.0390, 0.433, 0.640, 24), dz=BORE_Z), bevel=0)
# 6. Aft ring (y = 0.425..0.435, radius 0.0395)
round_part('Round aft ring', 'orange paint',
           offset(taper(0.0395, 0.0395, 0.424, 0.435, 24), dz=BORE_Z), bevel=.001)
# 7. Nozzle shell (y = 0.400..0.425, radius 0.036 -> 0.041) + cavity black core
round_part('Round nozzle', 'gunmetal',
           offset(taper(0.0410, 0.0360, 0.401, 0.426, 24), dz=BORE_Z), bevel=.001)
round_part('Round nozzle core', 'cavity black',
           offset(taper(0.0310, 0.0240, 0.400, 0.418, 20), dz=BORE_Z), bevel=0)
# 8. Four swept stabilizer fins (y = 0.408..0.468, max radial reach <= 0.051)
FIN_PROFILE = [
    (0.408, 0.034),
    (0.468, 0.034),
    (0.452, 0.0495),
    (0.412, 0.0505),
]
for idx, angle_deg in enumerate((45, 135, 225, 315)):
    ang = math.radians(angle_deg)
    round_part(f'Round fin {idx + 1}', 'gunmetal',
               prism(FIN_PROFILE, 0.0045),
               loc=(0.0, 0.0, BORE_Z),
               rot=(0.0, ang, 0.0), bevel=.0008)

# Node names the delivered files must use verbatim.
CONTRACT_NODE_NAMES = (
    set(GROUPS)
    | set(MARKERS)
    | {f'gate | {m}' for m in MATERIAL_KEYS}
    | {f'round | {m}' for m in MATERIAL_KEYS}
)


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
                     'design_study': 'RIDGEBACK',
                     'sight_height': SIGHT_Z,
                     'bore_radius': BORE_R}.items():
    scene[key] = value

# ===========================================================================
# build-time checks (all five must pass or the build fails)
# ===========================================================================
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
round_names = {o.name for (o, _p, _m) in PARTS if o.get('extra_role') == 'round'}
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

# Rocket round bounds check
round_pts = [p for (p, n) in points if n in round_names]
round_min_y = min(p[1] for p in round_pts)
round_max_y = max(p[1] for p in round_pts)
round_max_r = max(math.hypot(p[0] - BORE_X, p[2] - BORE_Z) for p in round_pts)

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
    ('round_tail_y', round_min_y, 0.400, 1e-3),
    ('round_nose_y', round_max_y, 0.795, 1e-3),
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
if round_max_r > 0.052:
    contract_failures.append(f'rocket round radial reach {round_max_r:.4f} exceeds 0.052 bore clearance')

print(f'model extent x={extent[0][0]:+.4f}..{extent[0][1]:+.4f} '
      f'y={extent[1][0]:+.4f}..{extent[1][1]:+.4f} z={extent[2][0]:+.4f}..{extent[2][1]:+.4f}')
print(f'forward-most bore vertex ({tip[0]:+.6f}, {tip[1]:+.6f}, {tip[2]:+.6f}), muzzle plane rows {tip_plane}')
print(f'heat band z-radius max {band_radius:.6f} over {len(band)} vertices, '
      f'foreign geometry {band_foreign or "none"}')
print(f'bore axis measured ({bore_x:+.9f}, {bore_z:+.9f}); bolt knob reaches x={knob_far:+.4f}')
print(f'authored rocket round y={round_min_y:+.4f}..{round_max_y:+.4f}, max radial reach={round_max_r:.4f}')
if contract_failures:
    print(f'CONTRACT FAILURES: {len(contract_failures)}')
    for line in contract_failures:
        print(f'  {line}')
else:
    print('anchor contract: all assertions pass')

# --- check 2: heat-band clearance ------------------------------------------
heat_band_failures = []
for name in band_foreign:
    heat_band_failures.append(f'{name} stands proud of the sleeve inside the heat band')
for name in sorted({n for (p, n) in band
                    if n not in BORE_ASSEMBLY and n not in round_names}):
    heat_band_failures.append(f'{name} enters the heat band')
for (p, n) in band:
    if n in round_names and math.hypot(p[0] - BORE_X, p[2] - BORE_Z) > 0.046:
        heat_band_failures.append(f'{n} exceeds radius 0.046 inside the heat band')
        break
if heat_band_failures:
    print(f'HEAT BAND CLEARANCE: {len(heat_band_failures)} violations')
    for line in heat_band_failures:
        print(f'  {line}')
else:
    print('heat-band clearance: the band holds the bore and the seated round nose alone')


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
ROUND_ANCHOR = 'Round motor body'


def audit_contact(tolerance=CONTACT_M):
    """Clusters of authored parts that do not reach the receiver or round assembly."""
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
    valid_roots = set()
    if CONTACT_ANCHOR in parent:
        valid_roots.add(root(CONTACT_ANCHOR))
    if ROUND_ANCHOR in parent:
        valid_roots.add(root(ROUND_ANCHOR))
    anchor = clusters.get(root(CONTACT_ANCHOR), []) if CONTACT_ANCHOR in parent else []
    findings = []
    for members in clusters.values():
        if root(members[0]) in valid_roots:
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
    print('part contact audit: every part meets the receiver or rocket round assembly')

# --- check 5: gate sweep audit ---------------------------------------------
SWEEP_STEP = 0.05
SWEEP_OPEN_FROM = 1.55


def audit_gate_sweep():
    findings = []
    hinge = Vector(HINGE)
    core = {name: None for name in GATE_CORE_NAMES}
    low, high = [1e9] * 3, [-1e9] * 3
    for (obj, part, _material) in PARTS:
        if part != 'extra' or obj.get('extra_role') != 'gate' or obj.name not in core:
            continue
        core[obj.name] = obj
        for vertex in obj.data.vertices:
            point = obj.matrix_world @ vertex.co
            for axis in range(3):
                low[axis] = min(low[axis], point[axis])
                high[axis] = max(high[axis], point[axis])
    missing = sorted(name for (name, obj) in core.items() if obj is None)
    if missing:
        findings.append(f'closed pose: blast-brake pieces missing: {", ".join(missing)}')
    core_bounds = (tuple(low), tuple(high))
    for axis, (want_low, want_high) in enumerate(GATE_CORE_BOUNDS):
        if abs(low[axis] - want_low) > 1e-6 or abs(high[axis] - want_high) > 1e-6:
            findings.append(f'closed pose: venturi bounds on axis {axis} are '
                            f'{low[axis]:+.6f}..{high[axis]:+.6f}, frozen {want_low:+.6f}..{want_high:+.6f}')

    statics = []
    for (obj, part, _material) in PARTS:
        if part == 'extra':
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        verts = [obj.matrix_world @ v.co for v in mesh.vertices]
        polys = [tuple(p.vertices) for p in mesh.polygons]
        statics.append({'name': obj.name,
                        'low': [min(v[i] for v in verts) for i in range(3)],
                        'high': [max(v[i] for v in verts) for i in range(3)],
                        'tree': BVHTree.FromPolygons(verts, polys, all_triangles=False)})
        evaluated.to_mesh_clear()
    gate_points = []
    for (obj, part, _material) in PARTS:
        if part != 'extra' or obj.get('extra_role') != 'gate':
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        gate_points.extend(((obj.matrix_world @ v.co) - hinge, obj.name) for v in mesh.vertices)
        evaluated.to_mesh_clear()

    rays = [Vector(v).normalized() for v in ((1.0, 0.0173, 0.0091),
                                             (0.0091, 1.0, 0.0173),
                                             (0.0173, 0.0091, 1.0))]

    def inside(tree, point):
        votes = 0
        for ray in rays:
            crossings = 0
            origin = point.copy()
            for _step in range(64):
                hit = tree.ray_cast(origin + ray * 1e-6, ray, 4.0)
                if hit[3] is None:
                    break
                crossings += 1
                origin = hit[0]
            votes += crossings % 2
        return votes >= 2

    def contains(static, point, slack=0.0):
        return all(static['low'][k] - slack <= point[k] <= static['high'][k] + slack
                   for k in range(3))

    steps = int(round(GATE_SWEEP_MAX / SWEEP_STEP)) + 1
    axis_clearance = (1e9, None, None)
    part_gap = (1e9, None, None, None)
    open_gap = (1e9, None, None, None)
    buried = {}
    for step in range(steps):
        theta = round(step * SWEEP_STEP, 2)
        cos_t, sin_t = math.cos(theta), math.sin(theta)
        swept = [(Vector((rel.x * cos_t + rel.y * sin_t, -rel.x * sin_t + rel.y * cos_t, rel.z)) + hinge,
                  name) for (rel, name) in gate_points]
        low = [min(p[i] for (p, _n) in swept) for i in range(3)]
        high = [max(p[i] for (p, _n) in swept) for i in range(3)]
        nearby = [s for s in statics
                  if all(s['low'][k] <= high[k] + 0.03 and low[k] <= s['high'][k] + 0.03
                         for k in range(3))]
        for (point, name) in swept:
            if theta >= SWEEP_OPEN_FROM - 1e-9:
                distance = math.hypot(point.x - BORE_X, point.z - BORE_Z)
                if distance < axis_clearance[0]:
                    axis_clearance = (distance, theta, name)
                if distance < GATE_AXIS_CLEARANCE - 1e-9:
                    key = ('axis', name)
                    buried.setdefault(key, []).append((theta, distance))
            for static in nearby:
                if contains(static, point, 0.03):
                    hit = static['tree'].find_nearest(point)
                    if hit[3] is not None and hit[3] < part_gap[0]:
                        part_gap = (hit[3], theta, name, static['name'])
                    if hit[3] is not None and hit[3] < open_gap[0] and theta >= 0.3 \
                            and not name.startswith('Gate knuckle'):
                        open_gap = (hit[3], theta, name, static['name'])
                if contains(static, point) and inside(static['tree'], point):
                    key = ('inside', name, static['name'])
                    buried.setdefault(key, []).append((theta, 0.0))
    for (key, hits) in sorted(buried.items()):
        thetas = sorted({round(t, 2) for (t, _d) in hits})
        if key[0] == 'axis':
            closest = min(d for (_t, d) in hits)
            findings.append(f'{key[1]} comes within {closest:.4f} of the bore axis while open '
                            f'(theta {thetas[0]}..{thetas[-1]}, need >= {GATE_AXIS_CLEARANCE})')
        else:
            findings.append(f'{key[1]} enters {key[2]} at theta {thetas[0]}..{thetas[-1]} '
                            f'({len(hits)} vertex hits)')
    print(f'gate sweep: {len(gate_points)} gate vertices x {steps} angles (0..{GATE_SWEEP_MAX} rad) '
          f'against {len(statics)} static parts')
    print(f'  closed venturi bounds x={core_bounds[0][0]:+.4f}..{core_bounds[1][0]:+.4f} '
          f'y={core_bounds[0][1]:+.4f}..{core_bounds[1][1]:+.4f} (frozen, checked at theta 0)')
    print(f'  min bore-axis clearance while open (theta >= {SWEEP_OPEN_FROM}): '
          f'{axis_clearance[0]:.4f} at theta {axis_clearance[1]} ({axis_clearance[2]}); need {GATE_AXIS_CLEARANCE}')
    print(f'  min gate-to-part surface gap over the sweep: {part_gap[0] * 1000:.2f} mm at theta '
          f'{part_gap[1]} ({part_gap[2]} vs {part_gap[3]})')
    print(f'  min swing clearance (theta >= 0.3, knuckle/pin running fit excluded): '
          f'{open_gap[0] * 1000:.2f} mm at theta {open_gap[1]} ({open_gap[2]} vs {open_gap[3]})')
    return findings, {'axis_clearance_open': [round(axis_clearance[0], 6), axis_clearance[1], axis_clearance[2]],
                      'min_part_gap': [round(part_gap[0], 6), part_gap[1], part_gap[2], part_gap[3]],
                      'min_swing_gap': [round(open_gap[0], 6), open_gap[1], open_gap[2], open_gap[3]]}


(sweep_failures, sweep_measured) = audit_gate_sweep()
if sweep_failures:
    print(f'GATE SWEEP: {len(sweep_failures)} violations')
    for line in sweep_failures:
        print(f'  {line}')
else:
    print('gate sweep audit: the venturi swings clear of every part and the bore axis')

if contract_failures or heat_band_failures or collisions or floaters or sweep_failures:
    raise RuntimeError(
        f'build gate failed: {len(contract_failures)} contract, {len(heat_band_failures)} '
        f'heat-band, {len(collisions)} coplanar, {len(floaters)} floating, '
        f'{len(sweep_failures)} gate sweep')

# --- shared material-library pass, then pack and save the editable source ---
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
round_batches = {}
for (obj, part, material) in PARTS:
    if part == 'extra':
        role = obj.get('extra_role', 'gate')
        if role == 'round':
            round_batches.setdefault(('round', material), []).append(obj)
        else:
            gate_batches.setdefault(('gate', material), []).append(obj)
    else:
        batches.setdefault((part, material), []).append(obj)

export_objects = list(PART_GROUP.values())
triangles = 0
per_primitive = {}
merged_batches = {**batches, **gate_batches, **round_batches}

for ((kind, material), objects) in sorted(merged_batches.items()):
    bm = bmesh.new()
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        bm.from_mesh(mesh)
        evaluated.to_mesh_clear()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if kind == 'gate':
        bmesh.ops.transform(bm, matrix=Matrix.Translation(-Vector(HINGE)), verts=bm.verts)
        parent_group = PART_GROUP['extra']
        node_name = f'gate | {material}'
        node_loc = HINGE
    elif kind == 'round':
        bmesh.ops.transform(bm, matrix=Matrix.Translation(-Vector(ROUND_SEAT)), verts=bm.verts)
        parent_group = PART_GROUP['extra']
        node_name = f'round | {material}'
        node_loc = ROUND_SEAT
    else:
        parent_group = PART_GROUP[kind]
        node_name = f'{kind} | {material}'
        node_loc = (0.0, 0.0, 0.0)
    merged = bpy.data.meshes.new(f'{node_name} merged')
    bm.to_mesh(merged)
    bm.free()
    merged.materials.append(mats[material])
    project_uvs(merged)
    merged.calc_loop_triangles()
    triangles += len(merged.loop_triangles)
    per_primitive[node_name] = len(merged.loop_triangles)
    obj = bpy.data.objects.new(node_name, merged)
    obj.parent = parent_group
    if kind in ('gate', 'round'):
        obj.location = node_loc
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
            node.setdefault('extras', {})['blenderAsset'] = 'torch'
            node.setdefault('extras', {})['role'] = 'breech gate'
        if name.startswith('round | '):
            node.setdefault('extras', {})['blenderAsset'] = 'torch'
            node.setdefault('extras', {})['role'] = 'rocket round'
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

_patch = runpy.run_path(str(ROOT / 'tools/blender/material-library.py'))
print(json.dumps({'glb_materials': _patch['patch_glb'](GLB)}, indent=2))

# --- record ----------------------------------------------------------------
manifest = {
    'asset': 'TORCH',
    'asset_id': 'torch',
    'kind': 'original heavy sci-fi shoulder-fired rocket launcher prop (visual game asset)',
    'design_study': 'RIDGEBACK',
    'blender': bpy.app.version_string,
    'authoring_script': 'tools/blender/torch/build-torch.py',
    'source_parts': len(PARTS),
    'animation_group_nodes': GROUPS,
    'marker_nodes': sorted(MARKERS),
    'batch_nodes': len(merged_batches),
    'round_nodes': sorted(f'round | {m}' for (_k, m) in round_batches),
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
                        'sight_posts': [REAR_POST_Y, FRONT_POST_Y],
                        'round_seat_game': [ROUND_SEAT[0], ROUND_SEAT[2], -ROUND_SEAT[1]]},
    'hinge': {'game': [HINGE[0], HINGE[2], -HINGE[1]],
              'authoring': list(HINGE),
              'axis': 'vertical pin (game +y) on the left flank; the gate node '
                      'translation in torch.gltf is the single runtime source',
              'pin_game_y': list(HINGE_PIN_Z),
              'swing_rad': GATE_SWING,
              'runtime': 'gate.rotation.y = -swing_rad * open; no slide',
              'round_path_rear_z_game': GATE_REAR_Z_GAME,
              'sweep_audit': sweep_measured},
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
        'heat_band_clearance': 'no vertex other than the bore and seated round nose may enter the heat band',
        'coplanar_face_audit': 'rejects flush faces between parts, which z-fight once '
                               'same-material parts merge into one draw call',
        'part_contact': 'every authored part must cross, nearly touch or sit inside '
                        'another part; a group that only meets the model through '
                        'empty space is reported as floating and fails the build',
        'gate_sweep': f'every evaluated gate vertex is swung about the vertical hinge '
                      f'line for theta 0..{GATE_SWEEP_MAX} rad step {SWEEP_STEP}: none may '
                      f'enter a body/mag/bolt/trigger volume, for theta >= {SWEEP_OPEN_FROM} '
                      f'all must keep {GATE_AXIS_CLEARANCE} from the bore axis, and at theta 0 '
                      f'the frozen blast-brake pieces must occupy their closed-pose bounds',
    },
    'geometry_audit': {'coplanar_faces': collisions, 'floating_parts': floaters,
                       'gate_sweep': sweep_failures},
    'limitations': [
        'Scalar metallic/roughness only: no baked normal, occlusion or roughness maps.',
        'Single LOD; no mobile GPU profiling.',
    ],
    'notes': [
        'RIDGEBACK design study (GPT Image 2.5 concept, docs/design/havoc-rev4): lofted '
        'super-elliptic olive-drab receiver, sixteen-frame perforated forward shroud with '
        'cavity-black sleeve, low left-flank ballistic computer, castellated muzzle crown, '
        'low-profile sight bridge with open U-notch rear sight and hooded front sight, '
        'underslung ignition canister, four-port blast-brake breech gate, and full '
        'fin-stabilized HAVOC rocket round under extra.',
    ],
}
(DOCS / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({k: manifest[k] for k in ('source_parts', 'batch_nodes', 'round_nodes', 'triangles')}, indent=2))
print(f'blend={BLEND} bytes={BLEND.stat().st_size}')
print(f'glb={GLB} bytes={GLB.stat().st_size}')
