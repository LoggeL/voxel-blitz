"""Author SKUA, the GV-4 RIPTIDE forearm-braced disc launcher prop for Voxel Blitz.

Design study "FORK" (alternative 1 of docs/design/blender/skua/concepts/): a
toothed blade disc lies flat on a forward launch spindle, tilted 6 degrees
front-edge-up toward the eye, in front of an open flywheel cage; an orange fork
bridge carries the ring sight and two hinged catch horns that sweep forward
like mandibles, with magenta razor-glow prongs at their tips. A skeletal
cassette under the receiver holds the spare disc, and a strapped brace cuff
behind the pistol grip takes the forearm.

Run headless:

    blender --background --factory-startup --python tools/blender/skua/build-skua.py

or exec this file in the live Blender MCP session (execute_code, with a
`__file__` wrapper); it builds in its own scene and saves the source with
copy=True, never touching other studies. Writes
docs/design/blender/skua/{skua.blend,skua.glb,manifest.json} and fails the
build on any contract or geometry-audit violation.

Authoring space: +Y forward (muzzle), +Z up, +X right. The game maps it as
game_x = x, game_y = z, game_z = -y (Blender glTF export_yup does the same).

Animated parts carry their own pivot (the runtime spins and translates them
about it, so export-game-assets.py ships them pivot-local with the pivot as
node translation):
    mag    seated disc      pivot = disc centre, spin axis = the tilted normal
    bolt   flywheel         pivot = hub on the bore axis at BOLT_HOME
    extra  horn left/right  pivot = the vertical hinge pin (game +y axis)
           spare disc       pivot = its own centre in the cassette (round node)
           gauge needle     pivot = the gauge centre (spins about game x)
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
DOCS = ROOT / 'docs/design/blender/skua'
DOCS.mkdir(parents=True, exist_ok=True)

ASSET = 'SKUA'
SCENE_NAME = f'{ASSET} | Voxel Blitz disc launcher study'
UV_SCALE = 3.6  # texture tiles per metre, constant across the whole model
GROUPS = ['body', 'mag', 'bolt', 'trigger', 'extra']

# --- frozen runtime anchors, in Blender authoring space --------------------
MUZZLE = (0.000, 0.400, 0.000)     # game (0, 0, -0.40): TIMERS.glaive.muzzle, spindle tip
GRIP = (0.000, -0.040, -0.075)     # game (0, -0.075, 0.04): HANDS.glaive.grip
SUPPORT = (0.000, 0.300, -0.060)   # game (0, -0.06, -0.30): HANDS.glaive.support
SIGHT = (0.000, 0.340, 0.150)      # ring sight centre, game y = 0.150 (SIGHT_HEIGHT.glaive)
MARKERS = {'muzzle': MUZZLE, 'grip': GRIP, 'support': SUPPORT, 'sight': SIGHT}

BORE_X, BORE_Z = 0.000, 0.000   # bore axis
BORE_R = 0.0155                 # launch spindle radius (BARREL_R.glaive 0.016 - clearance)
BORE_START = 0.098              # spindle tail, buried in the receiver face
BREECH_Y = 0.100                # BREACH_Z.glaive -0.10
# heat band: BREACH_Z - heatLen * barrelLen = -0.10 - [0.80, 1.0] * 0.30
HEAT_BAND = (0.340, 0.400)      # game z -0.34 .. -0.40: the spindle tip only
HEAT_CLEAR = 0.030              # nothing but the spindle within this radius in the band
SIGHT_Z = 0.150                 # body.userData.sightHeight
REAR_POST_Y, RING_POST_Y = -0.070, 0.340
# Rear notch floor: low enough that, from the ADS eye, the whole ring aperture sits
# above it (a floor on the sight line would hide the aperture's lower half).
RING_INNER_R = 0.0105
REAR_NOTCH_TOP = SIGHT_Z - 0.0055
TRIGGER_Y, TRIGGER_TIP_Z = 0.005, -0.066   # TRIGGER_Z.glaive -0.005
BOLT_HOME_GAME_Z = 0.060        # BOLT_HOME.glaive: flywheel hub
BOLT_HOME_Y = -BOLT_HOME_GAME_Z

# Pivots (authoring space) of the parts the runtime moves.
DISC_TILT = math.radians(6)     # seated disc: front edge up, face toward the eye
DISC_C = (0.000, 0.220, 0.042)  # seated disc centre (game (0, 0.042, -0.22))
DISC_R = 0.110                  # tooth tip radius: 0.22 m disc
SPARE_C = (0.000, 0.165, -0.072)  # cassette spare disc centre (game (0, -0.072, -0.165))
FLYWHEEL_C = (0.000, BOLT_HOME_Y, 0.000)
HINGE_X, HINGE_Y = 0.050, 0.335  # catch horn pins: vertical, game (+-0.05, *, -0.335)
HORN_FLARE = math.radians(22)   # audited flare range (0, 11, 22 degrees)
GAUGE_C = (-0.0635, -0.070, 0.000)  # needle hub on the left drum face
EYE = (0.000, -0.350, 0.150)    # ADS eye point, game (0, 0.150, +0.35)


# --- scene -----------------------------------------------------------------
def drop_previous_study():
    previous = bpy.data.scenes.get(SCENE_NAME)
    if previous is not None:
        for obj in list(previous.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.scenes.remove(previous)
    for collection in list(bpy.data.collections):
        if collection.name.split('.')[0] == f'{ASSET} study' and not collection.users:
            bpy.data.collections.remove(collection)
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
# Frozen skin palette: exactly eight material names. Seven sample the shared
# 1024px palette JPEGs per docs/design/blender/material-library/materials.json;
# razor glow is the single untextured emissive accent (magenta #ff3fd0).
MATERIAL_KEYS = ['ivory coating', 'orange paint', 'gunmetal', 'dark polymer',
                 'blade steel', 'polished edge', 'brass', 'razor glow']
LIBRARY = json.loads((ROOT / 'docs/design/blender/material-library/materials.json').read_text())
ASSIGNMENT = LIBRARY['assignment']
BASE_COLOURS = {'ivory coating': (.72, .69, .62), 'orange paint': (.80, .30, .06),
                'gunmetal': (.16, .17, .19), 'dark polymer': (.05, .05, .055),
                'blade steel': (.55, .57, .60), 'polished edge': (.80, .81, .83),
                'brass': (.62, .44, .16)}


def srgb_to_linear(value):
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


GLOW_HEX = 0xff3fd0
GLOW_LINEAR = tuple(srgb_to_linear(((GLOW_HEX >> shift) & 0xff) / 255) for shift in (16, 8, 0))
GLOW_STRENGTH = 6.0

mats = {}
for name in MATERIAL_KEYS:
    material = bpy.data.materials.get(f'{ASSET} | {name}') \
        or bpy.data.materials.new(f'{ASSET} | {name}')
    material.use_nodes = True
    bsdf = material.node_tree.nodes['Principled BSDF']
    if name in BASE_COLOURS:
        bsdf.inputs['Base Color'].default_value = (*BASE_COLOURS[name], 1)
    mats[name] = material

glow = mats['razor glow']
gbsdf = glow.node_tree.nodes['Principled BSDF']
gbsdf.inputs['Base Color'].default_value = (.30, .01, .19, 1)
gbsdf.inputs['Metallic'].default_value = 0
gbsdf.inputs['Roughness'].default_value = .35
gbsdf.inputs['Emission Color'].default_value = (*GLOW_LINEAR, 1)
gbsdf.inputs['Emission Strength'].default_value = GLOW_STRENGTH
glow['emissive_coil'] = True
glow['glass'] = False


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


def prism(profile, depth):
    """Close a (y, z) outline and extrude it along X (the lateral axis)."""
    return solid(profile, depth, 'X')


def boxv(size):
    (sy, sz) = (size[1] / 2, size[2] / 2)
    return solid([(-sy, -sz), (sy, -sz), (sy, sz), (-sy, sz)], size[0], 'X')


def recty(y0, y1, z0, z1):
    """A (y, z) rectangle for prism()/solid() profiles."""
    return [(y0, z0), (y1, z0), (y1, z1), (y0, z1)]


def tube(radius, length, segments=12, axis='Y', phase=0.0):
    """Closed cylinder along an axis, centred on the origin."""
    return solid(circle(radius, segments, phase), length, axis)


def washer(outer, inner, length, segments=12, axis='Y', phase=0.0):
    """Closed annulus: the primitive whose hole is meant to be seen through."""
    return solid(circle(outer, segments, phase), length, axis, circle(inner, segments, phase))


def lathe(profile, segments=16):
    """Closed solid of revolution about Y from a [(y, r), ...] profile."""
    verts, faces = [], []
    rings = []
    for (y, r) in profile:
        base = len(verts)
        for i in range(segments):
            angle = 2 * math.pi * i / segments
            verts.append((r * math.cos(angle), y, r * math.sin(angle)))
        rings.append(list(range(base, base + segments)))
    for k in range(len(rings) - 1):
        for i in range(segments):
            j = (i + 1) % segments
            faces.append((rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]))
    faces.append(tuple(reversed(rings[0])))
    faces.append(tuple(rings[-1]))
    return verts, faces


def shell(r_out, r_in, y0, y1, a0, a1, segments=8):
    """Annular sector along Y (angles in the x/z plane) with side caps."""
    angles = [a0 + (a1 - a0) * i / segments for i in range(segments + 1)]
    outer = [(r_out * math.cos(a), r_out * math.sin(a)) for a in angles]
    inner = [(r_in * math.cos(a), r_in * math.sin(a)) for a in reversed(angles)]
    profile = [(x, z) for (x, z) in outer + inner]
    verts, faces = [], []
    n = len(profile)
    for y in (y0, y1):
        for (x, z) in profile:
            verts.append((x, y, z))
    faces.append(tuple(range(n - 1, -1, -1)))
    faces.append(tuple(range(n, 2 * n)))
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    return verts, faces


def sector_z(r_out, r_in, a0, a1, depth, segments=6):
    """Annular sector in the x/y plane extruded along Z (disc spokes, arcs)."""
    angles = [a0 + (a1 - a0) * i / segments for i in range(segments + 1)]
    profile = [(r_out * math.cos(a), r_out * math.sin(a)) for a in angles] + \
              [(r_in * math.cos(a), r_in * math.sin(a)) for a in reversed(angles)]
    return solid(profile, depth, 'Z')


def bezier(p0, p1, p2, t):
    u = 1 - t
    return tuple(u * u * a + 2 * u * t * b + t * t * c for (a, b, c) in zip(p0, p1, p2))


def sweep(points, thickness, heights):
    """Box-section blade along an x/y polyline; heights[i] = (z0, z1) per station."""
    verts, faces = [], []
    n = len(points)
    for i, (x, y) in enumerate(points):
        (ax, ay) = points[max(0, i - 1)]
        (bx, by) = points[min(n - 1, i + 1)]
        (tx, ty) = (bx - ax, by - ay)
        length = math.hypot(tx, ty)
        (nx, ny) = (ty / length, -tx / length)
        (z0, z1) = heights[i]
        half = thickness / 2
        verts += [(x - nx * half, y - ny * half, z0), (x + nx * half, y + ny * half, z0),
                  (x + nx * half, y + ny * half, z1), (x - nx * half, y - ny * half, z1)]
    for i in range(n - 1):
        a, b = 4 * i, 4 * (i + 1)
        for k in range(4):
            m = (k + 1) % 4
            faces.append((a + k, a + m, b + m, b + k))
    faces.append((0, 1, 2, 3))
    last = 4 * (n - 1)
    faces.append((last + 3, last + 2, last + 1, last))
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
        bevel=.0025, uv_scale=UV_SCALE, sight=False, node=None, pivot=None):
    """Create one chamfered, UV-mapped part with its placement baked in.

    `node`/`pivot` mark an `extra` leaf: the exporter batches it into
    `<node> | <material>` with geometry relative to `pivot` (authoring space).
    """
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
    obj['skua_material'] = material
    if sight:
        obj['sight_piece'] = True
    if node:
        obj['node'] = node
        obj['pivot'] = list(pivot)
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
    curve = bpy.data.curves.new(f'{name} curve', 'FONT')
    curve.body = text
    curve.size = size
    curve.extrude = extrude
    curve.resolution_u = 1
    curve.align_x = 'CENTER'
    curve.align_y = 'CENTER'
    holder = bpy.data.objects.new(f'{name} text', curve)
    STUDY.objects.link(holder)
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(holder.evaluated_get(depsgraph))
    bpy.data.objects.remove(holder, do_unlink=True)
    bpy.data.curves.remove(curve)
    mesh.name = f'{name} mesh'
    matrix = Matrix.LocRotScale(Vector(loc), Euler(rot, 'XYZ'), None)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.clear()
    mesh.materials.append(mats[material])
    label = bpy.data.objects.new(name, mesh)
    label['part'] = part
    label['skua_material'] = material
    label.parent = PART_GROUP[part]
    STUDY.objects.link(label)
    project_uvs(mesh)
    PARTS.append((label, part, material))
    return label


# ===========================================================================
# BODY 1: the launch spindle (the bore assembly), its rail and the fork
# ===========================================================================
# The measured bore: a bare 0.0155 rod from the receiver face to a chamfered
# tip at the muzzle plane, with rows on the heat-band edges so the audit sees
# the real surface there.
SPINDLE = add('Launch spindle', 'body', 'gunmetal', lathe([
    (BORE_START, BORE_R), (0.200, BORE_R), (0.300, BORE_R), (HEAT_BAND[0], BORE_R),
    (0.392, BORE_R), (MUZZLE[1], 0.0095)], 16), bevel=0)
BORE_ASSEMBLY = {SPINDLE.name}
add('Spindle collar', 'body', 'gunmetal', washer(.024, .0150, .014, 16),
    loc=(0, 0.106, 0), bevel=.0015)
add('Spindle collar band', 'body', 'orange paint', washer(.0255, .0225, .006, 16),
    loc=(0, 0.108, 0), bevel=.001)
# Arbor pin: rises out of the spindle into the seated disc's hub bore.
add('Disc arbor', 'body', 'gunmetal', tube(.0094, .028, 12, axis='Z'),
    loc=(0, DISC_C[1], 0.022), bevel=.001)

# Flat rail under the disc plane with two guide lips; it stops short of the
# heat band, where the fork plate takes over off-axis.
add('Rail', 'body', 'gunmetal', boxv((.060, .204, .018)),
    loc=(0, 0.2005, -0.021), bevel=.002)
pair('Rail guide lip', 'body', 'gunmetal', boxv((.006, .170, .007)),
     loc=(.026, 0.205, -0.0095), bevel=.001)
for index, y in enumerate((0.140, 0.260)):
    add(f'Rail rivet {index + 1}', 'body', 'brass', tube(.004, .004, 8, axis='Z'),
        loc=(0.019, y, -0.0115), bevel=0)
# Fork plate: the rail widens to carry the two horn pins, U-cut around the
# spindle tip so nothing sits inside the heat-band clearance radius.
add('Fork plate', 'body', 'gunmetal', solid([
    (-0.068, 0.294), (0.068, 0.294), (0.068, 0.338), (0.034, 0.338),
    (0.030, 0.310), (-0.030, 0.310), (-0.034, 0.338), (-0.068, 0.338)], .016, 'Z'),
    loc=(0, 0, -0.0215), bevel=.002)
for side in (1, -1):
    label = 'right' if side > 0 else 'left'
    add(f'Horn pin {label}', 'body', 'gunmetal', tube(.0055, .108, 12, axis='Z'),
        loc=(side * HINGE_X, HINGE_Y, 0.033), bevel=0)
    add(f'Horn pin cap {label}', 'body', 'brass', tube(.0080, .005, 12, axis='Z'),
        loc=(side * HINGE_X, HINGE_Y, 0.0985), bevel=.001)
    add(f'Horn pin foot {label}', 'body', 'gunmetal', tube(.0090, .006, 12, axis='Z'),
        loc=(side * HINGE_X, HINGE_Y, -0.0160), bevel=.001)

# Fork bridge: an orange cross-beam over the disc path, carrying the ring
# sight on a post (the support stub hangs under the rail below it).
add('Fork bridge', 'body', 'orange paint', prism([
    (0.3255, 0.079), (0.3445, 0.079), (0.3445, 0.092), (0.339, 0.0975),
    (0.331, 0.0975), (0.3255, 0.092)], .128), bevel=.0015)
pair('Bridge boss', 'body', 'orange paint', tube(.0115, .022, 12, axis='Z'),
     loc=(HINGE_X, HINGE_Y, 0.087), bevel=.0015)
add('Ring sight post', 'body', 'orange paint', boxv((.007, .008, .044)),
    loc=(0, RING_POST_Y, 0.116), bevel=0, sight=True)
add('Ring sight', 'body', 'orange paint', washer(.0165, .0105, .006, 20),
    loc=(0, RING_POST_Y, SIGHT_Z), bevel=.001, sight=True)
pair('Ring sight gusset', 'body', 'orange paint', boxv((.004, .006, .018)),
     loc=(.0050, RING_POST_Y, 0.104), bevel=0, sight=True)
pair('Ring sight wing', 'body', 'orange paint', boxv((.004, .008, .066)),
     loc=(.0235, RING_POST_Y, 0.129), bevel=.001, sight=True)

# Support-hand stub under the fork (support palm at game (0, -0.06, -0.30)).
add('Support stub', 'body', 'dark polymer', prism([
    (0.284, -0.026), (0.318, -0.026), (0.320, -0.064), (0.314, -0.100),
    (0.290, -0.100), (0.282, -0.064)], .032), bevel=.004)
for index, z in enumerate((-0.046, -0.062, -0.078)):
    add(f'Support stub rib {index + 1}', 'body', 'dark polymer', boxv((.034, .040, .004)),
        loc=(0, 0.301, z), bevel=.001)
add('Support stub cap', 'body', 'gunmetal', boxv((.036, .038, .008)),
    loc=(0, 0.302, -0.101), bevel=.002)

# ===========================================================================
# BODY 2: receiver slab, flywheel cage, gauge, rear notch post
# ===========================================================================
add('Receiver slab', 'body', 'ivory coating', prism([
    (-0.030, -0.051), (0.100, -0.051), (0.100, 0.012), (0.086, 0.029),
    (-0.030, 0.029)], .084), bevel=.004)
add('Receiver top stripe', 'body', 'orange paint', boxv((.050, .070, .004)),
    loc=(0, 0.030, 0.0295), bevel=.001)
pair('Receiver side rail', 'body', 'gunmetal', boxv((.006, .120, .010)),
     loc=(.0425, 0.038, -0.034), bevel=.0015)
pair('Receiver screw', 'body', 'brass', tube(.0035, .004, 8, axis='X'),
     loc=(.0425, 0.080, 0.016), bevel=0)
add_text('GV-4', 'Marking GV-4 right', 'body', 'gunmetal',
         (0.0425, 0.036, 0.013), (math.pi / 2, 0, math.pi / 2), .016)
add_text('RIPTIDE', 'Marking RIPTIDE right', 'body', 'gunmetal',
         (0.0425, 0.036, -0.008), (math.pi / 2, 0, math.pi / 2), .0105)
# Lower frame: carries the grip and the cuff mount under the flywheel cage.
# Its top stays under the flywheel sweep (weights reach r 0.044 about the axis).
add('Lower frame', 'body', 'ivory coating', boxv((.060, .126, .0215)),
    loc=(0, -0.063, -0.05775), bevel=.003)

# Flywheel cage: end plates + a ring of fins, open between them so the
# polished drive wheel (bolt) reads as it whirls.
add('Flywheel rear plate', 'body', 'gunmetal', tube(.055, .012, 24),
    loc=(0, -0.114, 0), bevel=.002)
add('Flywheel front plate', 'body', 'gunmetal', washer(.055, .020, .012, 24),
    loc=(0, -0.026, 0), bevel=.002)
add('Flywheel axle', 'body', 'gunmetal', tube(.0065, .086, 12),
    loc=(0, -0.069, 0), bevel=0)
FIN_ANGLES = [math.radians(15 + 30 * k) for k in range(12)]
for index, angle in enumerate(FIN_ANGLES):
    add(f'Flywheel fin {index + 1}', 'body', 'gunmetal', boxv((.010, .078, .011)),
        loc=(0.0495 * math.cos(angle), -0.070, 0.0495 * math.sin(angle)),
        rot=(0, -angle, 0), bevel=.0015)
add('Flywheel rear hub', 'body', 'brass', tube(.014, .006, 16),
    loc=(0, -0.1215, 0), bevel=.001)

# Brass RPM / fabricate gauge on the left drum face; the needle is an `extra`
# node so the runtime can sweep it about game x.
add('Gauge plate', 'body', 'gunmetal', boxv((.006, .060, .044)),
    loc=(-0.0555, -0.070, 0), bevel=.0015)
add('Gauge bezel', 'body', 'brass', washer(.020, .0160, .006, 20, axis='X'),
    loc=(-0.0612, -0.070, 0), bevel=.001)
add('Gauge face', 'body', 'ivory coating', tube(.0165, .004, 20, axis='X'),
    loc=(-0.0600, -0.070, 0), bevel=0)
for index, angle in enumerate((-1.1, -0.55, 0.0, 0.55, 1.1)):
    add(f'Gauge tick {index + 1}', 'body', 'gunmetal', boxv((.0012, .0016, .004)),
        loc=(-0.0625, -0.070 + 0.0125 * math.sin(angle), 0.0125 * math.cos(angle)),
        rot=(-angle, 0, 0), bevel=0)

# Rear notch post: rises from the cage top; its floor sits just under the 0.150 sight
# line so the ring aperture shows whole between the ears.
add('Rear sight saddle', 'body', 'gunmetal', boxv((.022, .030, .010)),
    loc=(0, REAR_POST_Y, 0.056), bevel=.0015)
add('Rear sight tower', 'body', 'gunmetal', prism([
    (REAR_POST_Y - 0.024, 0.052), (REAR_POST_Y + 0.024, 0.052),
    (REAR_POST_Y + 0.006, 0.144), (REAR_POST_Y - 0.006, 0.144)], .006),
    bevel=.0012, sight=True)
add('Rear sight notch bar', 'body', 'gunmetal', boxv((.030, .012, .008)),
    loc=(0, REAR_POST_Y, REAR_NOTCH_TOP - 0.004), bevel=0, sight=True)
pair('Rear sight ear', 'body', 'gunmetal', boxv((.006, .010, .018)),
     loc=(.0115, REAR_POST_Y, REAR_NOTCH_TOP + 0.0045), bevel=0, sight=True)
pair('Rear sight dot', 'body', 'orange paint', boxv((.004, .002, .004)),
     loc=(.0115, REAR_POST_Y - 0.0058, REAR_NOTCH_TOP + 0.0085), bevel=0, sight=True)

# ===========================================================================
# BODY 3: pistol grip, brace cuff, spare-disc cassette
# ===========================================================================
GRIP_PROFILE = [(-0.010, -0.050), (-0.070, -0.050), (-0.074, -0.080), (-0.086, -0.130),
                (-0.026, -0.130), (-0.016, -0.080)]
add('Pistol grip', 'body', 'dark polymer', prism(GRIP_PROFILE, .034), bevel=.006)


def grip_span(z):
    """Front and back edge of the grip profile at height z (linear)."""
    def lerp(top, bottom):
        (y0, z0), (y1, z1) = top, bottom
        return y0 + (y1 - y0) * (z - z0) / (z1 - z0)
    if z >= -0.080:
        return lerp((-0.010, -0.050), (-0.016, -0.080)), lerp((-0.070, -0.050), (-0.074, -0.080))
    return lerp((-0.016, -0.080), (-0.026, -0.130)), lerp((-0.074, -0.080), (-0.086, -0.130))


# Finger swells on the front strap and a ribbed backstrap wrap.
for index, z in enumerate((-0.066, -0.088, -0.110)):
    (front, back) = grip_span(z)
    add(f'Grip finger swell {index + 1}', 'body', 'dark polymer', boxv((.032, .010, .012)),
        loc=(0, front - 0.002, z), bevel=.003)
for index, z in enumerate((-0.062, -0.074, -0.086, -0.098, -0.110)):
    (front, back) = grip_span(z)
    add(f'Grip wrap rib {index + 1}', 'body', 'dark polymer', boxv((.0355, .014, .0035)),
        loc=(0, back + 0.0055, z), bevel=.001)
add('Grip base plate', 'body', 'gunmetal', boxv((.038, .066, .009)),
    loc=(0, -0.056, -0.1335), bevel=.002)

# Brace cuff: a half-ring over the forearm behind the grip (game z +0.10 ..
# +0.16), strap segments on a liner, a brass buckle on the right flank.
CUFF_Z = -0.108
add('Cuff mount', 'body', 'gunmetal', boxv((.030, .0434, .024)),
    loc=(0, -0.1295, -0.054), bevel=.002)
add('Cuff liner', 'body', 'dark polymer',
    offset(shell(.0435, .0395, -0.158, -0.102, math.radians(12), math.radians(168), 14),
           dz=CUFF_Z), bevel=.001)
for index in range(7):
    a0 = math.radians(14 + 22 * index)
    # Alternate strap widths by 0.8 mm so neighbouring end faces never share a plane.
    (y0, y1) = (-0.154, -0.106) if index % 2 == 0 else (-0.1532, -0.1068)
    add(f'Cuff strap segment {index + 1}', 'body', 'dark polymer',
        offset(shell(.0500, .0430, y0, y1, a0, a0 + math.radians(20), 3), dz=CUFF_Z),
        bevel=.001)
for (label, y) in (('rear', -0.1575), ('front', -0.1025)):
    add(f'Cuff rim {label}', 'body', 'gunmetal',
        offset(shell(.0510, .0420, y - 0.003, y + 0.003, math.radians(10), math.radians(170), 14),
               dz=CUFF_Z), bevel=.001)
BUCKLE = (0.0478, -0.130, CUFF_Z + 0.0085)
add('Cuff buckle', 'body', 'brass',
    solid(recty(-0.014, 0.014, -0.010, 0.010), .004, 'X', recty(-0.009, 0.009, -0.005, 0.005)),
    loc=BUCKLE, rot=(0, math.radians(-10), 0), bevel=.0008)
add('Cuff buckle pin', 'body', 'brass', tube(.0015, .020, 8, axis='Z'),
    loc=(BUCKLE[0], BUCKLE[1], BUCKLE[2]), bevel=0)
add('Cuff strap tail', 'body', 'dark polymer', boxv((.005, .022, .040)),
    loc=(0.0475, -0.130, CUFF_Z - 0.012), rot=(0, math.radians(-8), 0), bevel=.001)

# Cassette: a skeletal holder under the receiver around the spare disc, open
# between its hoop arcs so the spare's teeth show, with a glow progress strip.
(SX, SY, SZ) = SPARE_C
add('Cassette spine', 'body', 'dark polymer', boxv((.040, .240, .028)),
    loc=(0, SY, -0.0445), bevel=.002)
add('Cassette yoke', 'body', 'dark polymer', boxv((.236, .022, .008)),
    loc=(0, SY, -0.0550), bevel=.0015)
for index, centre in enumerate((0, 90, 180, 270)):
    a = math.radians(centre)
    add(f'Cassette hoop arc {index + 1}', 'body', 'dark polymer',
        sector_z(.1215, .1135, a - math.radians(24), a + math.radians(24), .036, 6),
        loc=(SX, SY, SZ), bevel=.001)
add('Cassette floor bar x', 'body', 'dark polymer', boxv((.236, .012, .006)),
    loc=(SX, SY, -0.089), bevel=.001)
add('Cassette floor bar y', 'body', 'dark polymer', boxv((.012, .236, .006)),
    loc=(SX, SY, -0.0888), bevel=.001)
add('Cassette floor boss', 'body', 'gunmetal', tube(.022, .009, 16, axis='Z'),
    loc=(SX, SY, -0.0895), bevel=.001)
add('Cassette glow strip', 'body', 'razor glow',
    sector_z(.1245, .1205, math.radians(-16), math.radians(16), .007, 6),
    loc=(SX, SY, SZ - 0.004), bevel=0)
add('Cassette latch', 'body', 'brass', boxv((.010, .014, .012)),
    loc=(-0.1225, SY, SZ), bevel=.001)

# ===========================================================================
# MAG: the seated disc, built flat about its own centre, then tilted 6 deg
# front-edge-up and placed at DISC_C. The spare disc reuses the same forms.
# ===========================================================================
TOOTH_COUNT = 24


def disc_parts(prefix, part, loc, rot, node=None, pivot=None):
    """Blade disc: hub, three spokes, rim, razor-glow inlay ring and 24 teeth."""
    kw = {'loc': loc, 'rot': rot, 'node': node, 'pivot': pivot}
    add(f'{prefix} hub', part, 'blade steel', washer(.030, .0100, .024, 20, axis='Z'),
        bevel=.0012, **kw)
    for index in range(3):
        a = math.radians(90 + 120 * index)
        add(f'{prefix} spoke {index + 1}', part, 'blade steel',
            sector_z(.0705, .0285, a - math.radians(24), a + math.radians(24), .016, 5),
            bevel=.001, **kw)
    add(f'{prefix} rim', part, 'blade steel', washer(.1000, .0690, .020, 48, axis='Z'),
        bevel=.0012, **kw)
    add(f'{prefix} razor ring', part, 'razor glow', washer(.0930, .0860, .0235, 48, axis='Z'),
        bevel=0, **kw)
    step = 2 * math.pi / TOOTH_COUNT
    for index in range(TOOTH_COUNT):
        a = index * step
        half = step * 0.42
        profile = [(0.0955 * math.cos(a), 0.0955 * math.sin(a)),
                   (0.0990 * math.cos(a - half), 0.0990 * math.sin(a - half)),
                   (DISC_R * math.cos(a + half * 0.55), DISC_R * math.sin(a + half * 0.55)),
                   (0.0990 * math.cos(a + half), 0.0990 * math.sin(a + half))]
        add(f'{prefix} tooth {index + 1}', part, 'polished edge', solid(profile, .010, 'Z'),
            bevel=0, **kw)


disc_parts('Seated disc', 'mag', DISC_C, (DISC_TILT, 0, 0))

# ===========================================================================
# BOLT: the polished flywheel drive wheel on the axle; hub at BOLT_HOME. The
# runtime whirls it about the bore axis and kicks it back 0.012.
# ===========================================================================
(FX, FY, FZ) = FLYWHEEL_C
BOLT_HUB = add('Flywheel hub', 'bolt', 'polished edge', washer(.013, .0072, .028, 16),
               loc=FLYWHEEL_C, bevel=.001)
add('Flywheel rim', 'bolt', 'polished edge', washer(.0415, .0330, .024, 32),
    loc=FLYWHEEL_C, bevel=.0012)
for index in range(6):
    angle = math.radians(60 * index)
    add(f'Flywheel spoke {index + 1}', 'bolt', 'polished edge', boxv((.023, .012, .006)),
        loc=(0.0225 * math.cos(angle), FY, 0.0225 * math.sin(angle)), rot=(0, -angle, 0),
        bevel=0)
for index in range(6):
    angle = math.radians(30 + 60 * index)
    add(f'Flywheel weight {index + 1}', 'bolt', 'polished edge', boxv((.004, .018, .010)),
        loc=(0.0420 * math.cos(angle), FY, 0.0420 * math.sin(angle)), rot=(0, -angle, 0),
        bevel=0)

# ===========================================================================
# TRIGGER: blade at game z -0.005 (tip z -0.066) and its guard
# ===========================================================================
TRIGGER_OBJECT = add('Trigger blade', 'trigger', 'gunmetal', prism([
    (0.000, -0.036), (0.010, -0.036), (0.008, -0.052), (0.011, -0.063),
    (0.006, TRIGGER_TIP_Z), (0.001, -0.052)], .007), bevel=0)
add('Trigger guard', 'trigger', 'gunmetal',
    solid(recty(-0.016, 0.049, -0.088, -0.037), .014, 'X',
          recty(-0.008, 0.041, -0.080, -0.043)), bevel=.002)

# ===========================================================================
# EXTRA 1: the catch horns. Each is a hinge leaf about its vertical pin; the
# exporter ships every leaf piece `horn <side> | <material>` with the pin as
# node translation. Runtime: right horn rotation.y = -flare, left = +flare.
# ===========================================================================
HORN_STATIONS = 11


def horn_heights(t):
    """Blade section (z0, z1) along the sweep: deep at the root, a low point at the tip."""
    return (-0.006 + 0.022 * t, 0.064 - 0.032 * t * t)



def horn(side):
    label = 'right' if side > 0 else 'left'
    node = f'horn {label}'
    pivot = (side * HINGE_X, HINGE_Y, 0.0)
    kw = {'node': node, 'pivot': pivot}
    x = lambda value: side * value
    for (tag, z) in (('bottom', -0.004), ('top', 0.060)):
        add(f'Horn knuckle {tag} {label}', 'extra', 'orange paint',
            washer(.0110, .0062, .014, 12, axis='Z'), loc=(x(HINGE_X), HINGE_Y, z), bevel=0,
            **kw)
    add(f'Horn root web {label}', 'extra', 'orange paint', boxv((.010, .020, .074)),
        loc=(x(0.0612), HINGE_Y + 0.004, 0.028), bevel=.0015, **kw)
    # The blade: a mandible that sweeps out and forward, tapering to the tip.
    p0, p1, p2 = (0.060, 0.346), (0.104, 0.384), (0.100, 0.452)
    points, heights = [], []
    for i in range(HORN_STATIONS):
        t = i / (HORN_STATIONS - 1)
        (bx, by) = bezier(p0, p1, p2, t)
        points.append((x(bx), by))
        heights.append(horn_heights(t))
    add(f'Horn blade {label}', 'extra', 'orange paint', sweep(points, .009, heights),
        bevel=.0015, **kw)
    # Spine rib along the blade top edge, stopping short of the tip hook.
    rib_points, rib_heights = [], []
    for i in range(HORN_STATIONS - 2):
        t = 0.08 + 0.78 * i / (HORN_STATIONS - 3)
        (bx, by) = bezier(p0, p1, p2, t)
        rib_points.append((x(bx), by))
        top = horn_heights(t)[1]
        rib_heights.append((top - 0.006, top + 0.003))
    add(f'Horn spine rib {label}', 'extra', 'orange paint', sweep(rib_points, .013, rib_heights),
        bevel=.001, **kw)
    for index, t in enumerate((0.30, 0.52, 0.74)):
        (bx, by) = bezier(p0, p1, p2, t)
        (z0, z1) = horn_heights(t)
        add(f'Horn strake {index + 1} {label}', 'extra', 'orange paint',
            boxv((.004, .008, (z1 - z0) * 0.55)),
            loc=(x(bx + 0.0055), by, (z0 + z1) / 2), bevel=0, **kw)
    # Tip hook turning inward, carrying the magnetic prong.
    add(f'Horn tip hook {label}', 'extra', 'orange paint', boxv((.024, .016, .018)),
        loc=(x(0.091), 0.456, 0.024), rot=(0, 0, side * math.radians(-18)),
        bevel=.0015, **kw)
    add(f'Horn prong {label}', 'extra', 'razor glow', tube(.0055, .014, 12, axis='X'),
        loc=(x(0.076), 0.459, 0.024), bevel=0, **kw)
    add(f'Horn prong collar {label}', 'extra', 'orange paint', washer(.0075, .0050, .004, 12,
                                                                        axis='X'),
        loc=(x(0.0815), 0.458, 0.024), bevel=0, **kw)


horn(1)
horn(-1)

# ===========================================================================
# EXTRA 2: the cassette's spare disc (round node, centred on its own origin)
# and the gauge needle (spins about game x at the gauge centre).
# ===========================================================================
disc_parts('Spare disc', 'extra', SPARE_C, (0, 0, 0), node='spare disc', pivot=SPARE_C)
for obj in [o for (o, _p, _m) in PARTS if o.get('node') == 'spare disc']:
    obj['round'] = True
add('Gauge needle', 'extra', 'brass', boxv((.0015, .0024, .0100)),
    loc=(GAUGE_C[0], GAUGE_C[1], GAUGE_C[2] + 0.0045), bevel=0,
    node='gauge needle', pivot=GAUGE_C)
add('Gauge needle hub', 'extra', 'brass', tube(.0022, .0034, 10, axis='X'),
    loc=GAUGE_C, bevel=0, node='gauge needle', pivot=GAUGE_C)

EXTRA_NODES = ['horn left', 'horn right', 'spare disc', 'gauge needle']
NODE_PIVOTS = {'mag': DISC_C, 'bolt': FLYWHEEL_C,
               'horn left': (-HINGE_X, HINGE_Y, 0.0), 'horn right': (HINGE_X, HINGE_Y, 0.0),
               'spare disc': SPARE_C, 'gauge needle': GAUGE_C}


def node_of(obj, part):
    return obj.get('node') or part


# Node names the delivered files must use verbatim.
CONTRACT_NODE_NAMES = set(GROUPS) | set(MARKERS) | {
    f'{node} | {material}' for (obj, part, material) in PARTS for node in [node_of(obj, part)]}


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

for (key, value) in {'asset_id': 'skua',
                     'display_name': 'GV-4 RIPTIDE',
                     'design_study': 'FORK',
                     'sight_height': SIGHT_Z,
                     'bore_radius': BORE_R}.items():
    scene[key] = value

# ===========================================================================
# build-time checks (all must pass or the build fails)
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


def radial(p):
    return math.hypot(p[0] - BORE_X, p[2] - BORE_Z)


# --- check 1: anchor contract ----------------------------------------------
band = [(p, n) for (p, n) in points if HEAT_BAND[0] - 1e-9 <= p[1] <= HEAT_BAND[1] + 1e-9]
bore_points = [p for (p, n) in points if n in BORE_ASSEMBLY]
bore_band = [p for p in bore_points if HEAT_BAND[0] - 1e-9 <= p[1] <= HEAT_BAND[1] - 0.008]
bore_band_radius = max(radial(p) for p in bore_band)
bore_x = (min(p[0] for p in bore_points) + max(p[0] for p in bore_points)) / 2
bore_z = (min(p[2] for p in bore_points) + max(p[2] for p in bore_points)) / 2
tip = max(bore_points, key=lambda p: p[1])
past_muzzle = sorted({n for (p, n) in points if p[1] > MUZZLE[1] + 1e-6 and abs(p[0]) < 0.06})
trigger_low = min((TRIGGER_OBJECT.matrix_world @ v.co)[2] for v in TRIGGER_OBJECT.data.vertices)
trigger_y = sum((TRIGGER_OBJECT.matrix_world @ v.co)[1] for v in TRIGGER_OBJECT.data.vertices) \
    / len(TRIGGER_OBJECT.data.vertices)
hub_y = sum((BOLT_HUB.matrix_world @ v.co)[1] for v in BOLT_HUB.data.vertices) \
    / len(BOLT_HUB.data.vertices)
by_name = {o.name: o for (o, _p, _m) in PARTS}


def centre_of(name, axis):
    obj = by_name[name]
    values = [(obj.matrix_world @ v.co)[axis] for v in obj.data.vertices]
    return (min(values) + max(values)) / 2


sight_names = {o.name for (o, _p, _m) in PARTS if o.get('sight_piece')}
sight_line_hits = sorted({n for (p, n) in points
                          if n not in sight_names and abs(p[0]) < 0.02 and p[2] >= SIGHT_Z - 1e-9})
ring = by_name['Ring sight']
ring_top = max((ring.matrix_world @ v.co)[2] for v in ring.data.vertices)
notch_top = max((by_name['Rear sight notch bar'].matrix_world @ v.co)[2]
                for v in by_name['Rear sight notch bar'].data.vertices)
horn_tips = [(p, n) for (p, n) in points if n.startswith('Horn') and p[1] > MUZZLE[1]]

CONTRACT = [
    ('muzzle_forward_bore_vertex_y', tip[1], MUZZLE[1], 1e-6),
    ('bore_axis_x', bore_x, BORE_X, 1e-6),
    ('bore_axis_z', bore_z, BORE_Z, 1e-6),
    ('spindle_radius_in_heat_band', bore_band_radius, BORE_R, 1e-6),
    ('spindle_starts_behind_breech', min(p[1] for p in bore_points), BORE_START, 1e-6),
    ('grip_marker', GRIP, (0.000, -0.040, -0.075), 1e-9),
    ('support_marker', SUPPORT, (0.000, 0.300, -0.060), 1e-9),
    ('sight_marker', SIGHT, (0.000, 0.340, 0.150), 1e-9),
    ('ring_sight_centre_z', centre_of('Ring sight', 2), SIGHT_Z, 1e-6),
    ('ring_sight_y', centre_of('Ring sight', 1), RING_POST_Y, 1e-6),
    ('rear_notch_floor_z', notch_top, REAR_NOTCH_TOP, 1e-6),
    ('rear_notch_y', centre_of('Rear sight notch bar', 1), REAR_POST_Y, 1e-6),
    ('trigger_blade_y', trigger_y, TRIGGER_Y, 3e-3),
    ('trigger_blade_tip_z', trigger_low, TRIGGER_TIP_Z, 1e-6),
    ('bolt_hub_home_y', hub_y, BOLT_HOME_Y, 1e-6),
    ('seated_disc_centre_y', centre_of('Seated disc hub', 1), DISC_C[1], 1e-4),
]
contract_failures = []
for (name, measured, expected, tolerance) in CONTRACT:
    if isinstance(expected, tuple):
        bad = max(abs(a - b) for (a, b) in zip(measured, expected)) > tolerance
    else:
        bad = abs(measured - expected) > tolerance
    if bad:
        contract_failures.append(f'{name}: measured {measured}, contract {expected} +/- {tolerance}')
if past_muzzle:
    contract_failures.append(f'on-axis geometry forward of the muzzle plane (|x| < 0.06): '
                             f'{", ".join(past_muzzle)}')
if not horn_tips or min(abs(p[0]) for (p, _n) in horn_tips) < 0.06:
    contract_failures.append('horn tips must sit off-axis at |x| >= 0.06 past the muzzle plane')
# From the ADS eye the notch floor must fall below the ring aperture's lower edge.
notch_drop = (SIGHT_Z - notch_top) / (REAR_POST_Y - EYE[1])
ring_drop = RING_INNER_R / (RING_POST_Y - EYE[1])
if notch_drop <= ring_drop:
    contract_failures.append(f'rear notch floor hides the ring aperture: {notch_drop:.5f} rad '
                             f'below the sight line, aperture needs > {ring_drop:.5f}')
if sight_line_hits:
    contract_failures.append(f'non-sight geometry touches the {SIGHT_Z} sight line inside '
                             f'|x| < 0.02: {", ".join(sight_line_hits)}')

print(f'model extent x={extent[0][0]:+.4f}..{extent[0][1]:+.4f} '
      f'y={extent[1][0]:+.4f}..{extent[1][1]:+.4f} z={extent[2][0]:+.4f}..{extent[2][1]:+.4f}')
print(f'forward-most bore vertex ({tip[0]:+.6f}, {tip[1]:+.6f}, {tip[2]:+.6f}); '
      f'ring sight top {ring_top:.4f}')
print(f'bore axis measured ({bore_x:+.9f}, {bore_z:+.9f}); spindle radius in band {bore_band_radius:.6f}')
if contract_failures:
    print(f'CONTRACT FAILURES: {len(contract_failures)}')
    for line in contract_failures:
        print(f'  {line}')
else:
    print('anchor contract: all assertions pass')

# --- check 2: heat-band clearance ------------------------------------------
# Only the spindle may come within HEAT_CLEAR of the bore axis across the
# band (the runtime glow sleeve sits at BARREL_R there); the horns and the
# fork pass the band off-axis.
heat_band_failures = sorted({f'{n} enters the heat band clearance '
                             f'(radius {radial(p):.4f} < {HEAT_CLEAR})'
                             for (p, n) in band if n not in BORE_ASSEMBLY and radial(p) < HEAT_CLEAR})
band_off_axis = min((radial(p) for (p, n) in band if n not in BORE_ASSEMBLY), default=None)
if heat_band_failures:
    print(f'HEAT BAND CLEARANCE: {len(heat_band_failures)} violations')
    for line in heat_band_failures:
        print(f'  {line}')
else:
    print(f'heat-band clearance: the spindle alone within {HEAT_CLEAR} of the axis '
          f'(nearest other part {band_off_axis:.4f})')


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
CONTACT_ANCHOR = SPINDLE.name


def mesh_geometry(obj, matrix=None):
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    matrix = matrix if matrix is not None else obj.matrix_world
    verts = [matrix @ v.co for v in mesh.vertices]
    polys = [tuple(p.vertices) for p in mesh.polygons]
    centres = [matrix @ p.center for p in mesh.polygons]
    evaluated.to_mesh_clear()
    return verts, polys, centres


def audit_contact(tolerance=CONTACT_M):
    """Clusters of authored parts that do not reach the spindle."""
    geometry = {}
    for (obj, _part, _material) in PARTS:
        (verts, polys, centres) = mesh_geometry(obj)
        low = [min(v[i] for v in verts) for i in range(3)]
        high = [max(v[i] for v in verts) for i in range(3)]
        probes = verts[::max(1, len(verts) // 8)][:8] + centres[::max(1, len(centres) // 4)][:4]
        geometry[obj.name] = {'verts': verts, 'probes': probes, 'low': low, 'high': high,
                              'tree': BVHTree.FromPolygons(verts, polys, all_triangles=False)}

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
            origin, direction = point.copy(), Vector((0.0173, 0.0091, 1.0)).normalized()
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
            if root(first) == root(second):
                continue
            attached = bool(geometry[first]['tree'].overlap(geometry[second]['tree']))
            if not attached:
                attached = inside(first, second) or inside(second, first)
            if not attached:
                attached = surface_gap(first, second) <= tolerance
            if attached:
                parent[root(second)] = root(first)

    clusters = {}
    for name in names:
        clusters.setdefault(root(name), []).append(name)
    anchor = clusters.get(root(CONTACT_ANCHOR), [])
    findings = []
    for members in clusters.values():
        if root(members[0]) == root(CONTACT_ANCHOR):
            continue
        gaps = [(surface_gap(member, other), member, other)
                for member in members for other in anchor
                if overlapping(member, other, 0.06)]
        if gaps:
            (gap, member, other) = min(gaps)
            findings.append(f'floating group of {len(members)} next to {other}: '
                            f'{", ".join(sorted(members)[:6])} (closest {gap * 1000:.2f} mm)')
        else:
            findings.append(f'floating group of {len(members)}: {", ".join(sorted(members)[:6])}')
    return findings


floaters = audit_contact()
if floaters:
    print(f'FLOATING PARTS: {len(floaters)}')
    for line in floaters:
        print(f'  {line}')
else:
    print('part contact audit: every part meets the spindle cluster')

# --- check 5: horn sweep audit ---------------------------------------------
# Each horn leaf swings about its vertical pin. The runtime drives
# rotation.y = -side * flare in game space; the game map is a proper rotation,
# so that is the same rotation about authoring +Z. At 0, 11 and 22 degrees no
# horn vertex may enter a body/mag/bolt/trigger/spare volume, and every horn
# vertex must stay below SIGHT_Z - 0.03.
RAYS = [Vector(v).normalized() for v in ((1.0, 0.0173, 0.0091), (0.0091, 1.0, 0.0173),
                                         (0.0173, 0.0091, 1.0))]


def inside_tree(tree, point):
    votes = 0
    for ray in RAYS:
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


def audit_horn_sweep():
    findings = []
    statics = []
    for (obj, part, _material) in PARTS:
        if part == 'extra' and obj.get('node', '').startswith('horn'):
            continue
        (verts, polys, _c) = mesh_geometry(obj)
        statics.append({'name': obj.name,
                        'low': [min(v[i] for v in verts) for i in range(3)],
                        'high': [max(v[i] for v in verts) for i in range(3)],
                        'tree': BVHTree.FromPolygons(verts, polys, all_triangles=False)})
    measured = {}
    for side in (1, -1):
        label = 'right' if side > 0 else 'left'
        hinge = Vector((side * HINGE_X, HINGE_Y, 0.0))
        leaf = []
        for (obj, _part, _material) in PARTS:
            if obj.get('node') != f'horn {label}':
                continue
            (verts, _p, _c) = mesh_geometry(obj)
            leaf += [(v - hinge, obj.name) for v in verts]
        top, gap = -1e9, (1e9, None, None)
        for degrees in (0, 11, 22):
            theta = -side * math.radians(degrees)
            rotation = Matrix.Rotation(theta, 3, 'Z')
            swept = [(rotation @ rel + hinge, name) for (rel, name) in leaf]
            for (point, name) in swept:
                top = max(top, point.z)
                for static in statics:
                    if not all(static['low'][k] - 0.01 <= point[k] <= static['high'][k] + 0.01
                               for k in range(3)):
                        continue
                    hit = static['tree'].find_nearest(point)
                    if hit[3] is not None and hit[3] < gap[0] and not name.startswith('Horn knuckle'):
                        gap = (hit[3], degrees, f'{name} vs {static["name"]}')
                    if all(static['low'][k] <= point[k] <= static['high'][k] for k in range(3)) \
                            and inside_tree(static['tree'], point):
                        findings.append(f'{name} enters {static["name"]} at {degrees} deg')
        if top > SIGHT_Z - 0.03:
            findings.append(f'horn {label} reaches z {top:.4f} above {SIGHT_Z - 0.03:.3f}')
        measured[label] = {'top_z': round(top, 5), 'min_gap_m': round(gap[0], 5),
                           'min_gap_at_deg': gap[1], 'min_gap_pair': gap[2]}
        print(f'horn sweep {label}: top z {top:.4f}, min gap {gap[0] * 1000:.2f} mm '
              f'at {gap[1]} deg ({gap[2]})')
    return sorted(set(findings)), measured


# --- check 5b: animated disc paths (glaive-presentation.js) ----------------
# The throw/catch slide moves the seated disc 0.18 along its tilted plane while it
# shrinks to 0.25 (scale = 1 - 0.75 * min(1, 2.4 * slide)); the cassette lift shrinks
# the spare in place, then grows the next disc on the seat. No posed disc may cut a
# part it does not already touch at rest (the seat's own arbor contact is allowed).
THROW_M, SLIDE_SCALE_END, SLIDE_SHRINK_RATE = 0.18, 0.25, 2.4


def audit_disc_paths(steps=24):
    statics = []
    for (obj, part, _material) in PARTS:
        if part == 'mag' or obj.get('node') == 'spare disc':
            continue
        (verts, polys, _c) = mesh_geometry(obj)
        statics.append((obj.name, BVHTree.FromPolygons(verts, polys, all_triangles=False)))
    tilt = Matrix.Rotation(DISC_TILT, 3, 'X')
    forward = tilt @ Vector((0, 1, 0))
    moving = {
        'seated disc': (Vector(DISC_C), [o for (o, part, _m) in PARTS if part == 'mag']),
        'spare disc': (Vector(SPARE_C), [o for (o, _p, _m) in PARTS if o.get('node') == 'spare disc']),
    }

    def cuts(label, matrix):
        (centre, objs) = moving[label]
        hit = set()
        for obj in objs:
            (verts, polys, _c) = mesh_geometry(obj, matrix @ obj.matrix_world)
            tree = BVHTree.FromPolygons(verts, polys, all_triangles=False)
            hit |= {name for (name, static) in statics if tree.overlap(static)}
        return hit

    def scaled(centre, scale, offset=Vector()):
        return Matrix.Translation(centre + offset) @ Matrix.Scale(scale, 4) @ Matrix.Translation(-centre)

    findings = []
    rest = {label: cuts(label, Matrix.Identity(4)) for label in moving}
    for i in range(1, steps + 1):
        slide = i / steps
        scale = 1 - (1 - SLIDE_SCALE_END) * min(1.0, slide * SLIDE_SHRINK_RATE)
        pose = scaled(Vector(DISC_C), scale, forward * THROW_M * slide)
        findings += [f'seated disc slide {slide:.2f} (scale {scale:.2f}) cuts {name}'
                     for name in sorted(cuts('seated disc', pose) - rest['seated disc'])]
        grow = max(0.05, slide)
        findings += [f'{label} lift at scale {grow:.2f} cuts {name}' for label in moving
                     for name in sorted(cuts(label, scaled(moving[label][0], grow)) - rest[label])]
    return sorted(set(findings))


path_failures = audit_disc_paths()
if path_failures:
    print(f'DISC PATHS: {len(path_failures)} violations')
    for line in path_failures[:20]:
        print(f'  {line}')
else:
    print('disc path audit: throw/catch slide and cassette lift clear every part')

(sweep_failures, sweep_measured) = audit_horn_sweep()
if sweep_failures:
    print(f'HORN SWEEP: {len(sweep_failures)} violations')
    for line in sweep_failures[:20]:
        print(f'  {line}')
else:
    print('horn sweep audit: both horns swing 0..22 deg clear of every part')


# --- check 6: seated-disc visibility from the ADS eye ----------------------
# Ray-cast a 50 x 50 degree frame from the eye point down the sight line; the
# seated disc must own >= 4 % of the frame and show its top face.
def audit_disc_visibility(grid=160, fov=math.radians(50)):
    verts, polys, owner = [], [], []
    for (obj, part, _material) in PARTS:
        (v, p, _c) = mesh_geometry(obj)
        base = len(verts)
        verts += v
        polys += [tuple(i + base for i in poly) for poly in p]
        owner += [part] * len(p)
    tree = BVHTree.FromPolygons(verts, polys, all_triangles=False)
    eye = Vector(EYE)
    half = math.tan(fov / 2)
    disc_hits = top_hits = 0
    for i in range(grid):
        for j in range(grid):
            u = -half + 2 * half * (i + 0.5) / grid
            v = -half + 2 * half * (j + 0.5) / grid
            direction = Vector((u, 1.0, v)).normalized()
            hit = tree.ray_cast(eye, direction, 2.0)
            if hit[0] is None or owner[hit[2]] != 'mag':
                continue
            disc_hits += 1
            if hit[1].z > 0.5 and hit[1].dot(direction) < 0:
                top_hits += 1
    fraction = disc_hits / (grid * grid)
    return fraction, top_hits / (grid * grid)


(disc_fraction, disc_top_fraction) = audit_disc_visibility()
visibility_failures = []
if disc_fraction < 0.04 or disc_top_fraction <= 0:
    visibility_failures.append(f'seated disc covers {disc_fraction:.4f} of the 50 deg ADS frame '
                               f'(top face {disc_top_fraction:.4f}); need >= 0.04 and a visible top')
print(f'disc visibility: {disc_fraction * 100:.2f} % of the ADS frame, top face '
      f'{disc_top_fraction * 100:.2f} %')

if contract_failures or heat_band_failures or collisions or floaters or sweep_failures \
        or visibility_failures or path_failures:
    raise RuntimeError(
        f'build gate failed: {len(contract_failures)} contract, {len(heat_band_failures)} '
        f'heat-band, {len(collisions)} coplanar, {len(floaters)} floating, '
        f'{len(sweep_failures)} horn sweep, {len(visibility_failures)} disc visibility, '
        f'{len(path_failures)} disc path')

# --- shared material-library pass, then pack and save the editable source ---
import runpy
apply_scene = runpy.run_path(str(ROOT / 'tools/blender/material-library.py'))['apply_scene']
print(json.dumps({'material_library': apply_scene(scene)}, indent=2))
bpy.ops.file.pack_all()
BLEND = DOCS / 'skua.blend'
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND), copy=True, check_existing=False)

# --- batch to material draw calls and export -------------------------------
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()

batches = {}
for (obj, part, material) in PARTS:
    batches.setdefault((part, node_of(obj, part), material), []).append(obj)

export_objects = list(PART_GROUP.values())
triangles = 0
per_primitive = {}
node_objects = {}
for ((part, node, material), objects) in sorted(batches.items()):
    bm = bmesh.new()
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        bm.from_mesh(mesh)
        evaluated.to_mesh_clear()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    pivot = NODE_PIVOTS.get(node)
    if pivot is not None:
        bmesh.ops.transform(bm, matrix=Matrix.Translation(-Vector(pivot)), verts=bm.verts)
    name = f'{node} | {material}'
    merged = bpy.data.meshes.new(f'{name} merged')
    bm.to_mesh(merged)
    bm.free()
    merged.materials.append(mats[material])
    project_uvs(merged)
    merged.calc_loop_triangles()
    triangles += len(merged.loop_triangles)
    per_primitive[name] = len(merged.loop_triangles)
    obj = bpy.data.objects.new(name, merged)
    obj.parent = PART_GROUP[part]
    if pivot is not None:
        obj.location = pivot
    STUDY.objects.link(obj)
    export_objects.append(obj)
    node_objects[name] = obj

export_objects += [MARKER_OBJECTS[name] for name in sorted(MARKERS)]

source_parts = len(PARTS)
for (obj, _part, _material) in PARTS:
    mesh = obj.data
    bpy.data.objects.remove(obj, do_unlink=True)
    if mesh.users == 0:
        bpy.data.meshes.remove(mesh)

for layer in bpy.context.view_layer.layer_collection.children:
    if layer.collection is STUDY:
        bpy.context.view_layer.active_layer_collection = layer
bpy.context.view_layer.objects.active = PART_GROUP['body']

GLB = DOCS / 'skua.glb'
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
    offset_ = 12
    while offset_ < total:
        (length, kind) = struct.unpack('<II', raw[offset_:offset_ + 8])
        chunks.append([kind, raw[offset_ + 8:offset_ + 8 + length]])
        offset_ += 8 + length
    document = json.loads(chunks[0][1].decode('utf-8'))
    seen = set()
    for node in document.get('nodes', []):
        name = contract_node_name(node.get('name', ''))
        if name in GROUPS:
            node.setdefault('extras', {})['blenderAsset'] = 'skua'
        if name:
            if name in seen:
                raise ValueError(f'duplicate glTF node name after normalisation: {name}')
            seen.add(name)
        node['name'] = name
    for material in document.get('materials', []):
        if material.get('name', '').split('.')[0] == f'{ASSET} | razor glow':
            material['emissiveFactor'] = [round(v, 6) for v in GLOW_LINEAR]
            material.setdefault('extras', {}).update({'cosmeticGlow': True,
                                                      'emissiveStrength': GLOW_STRENGTH})
            material.pop('extensions', None)
    used = [e for e in document.get('extensionsUsed', [])
            if e != 'KHR_materials_emissive_strength']
    document.pop('extensionsUsed', None)
    if used:
        document['extensionsUsed'] = used
    payload = json.dumps(document, separators=(',', ':')).encode('utf-8')
    chunks[0][1] = payload + b' ' * (-len(payload) % 4)
    chunks[1][1] = chunks[1][1] + b'\0' * (-len(chunks[1][1]) % 4)
    body = b''.join(struct.pack('<II', len(blob), kind) + blob for (kind, blob) in chunks)
    path.write_bytes(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)


normalize_glb(GLB)
_patch = runpy.run_path(str(ROOT / 'tools/blender/material-library.py'))
print(json.dumps({'glb_materials': _patch['patch_glb'](GLB)}, indent=2))


# --- record ----------------------------------------------------------------
def game(point):
    return [round(point[0], 6), round(point[2], 6), round(-point[1], 6)]


manifest = {
    'asset': 'SKUA',
    'asset_id': 'skua',
    'kind': 'original forearm-braced disc launcher prop (visual game asset)',
    'blender': bpy.app.version_string,
    'authoring_script': 'tools/blender/skua/build-skua.py',
    'source_parts': source_parts,
    'animation_group_nodes': GROUPS,
    'marker_nodes': sorted(MARKERS),
    'batch_nodes': len(batches),
    'round_nodes': ['spare disc'],
    'extra_nodes': EXTRA_NODES,
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
    'anchors_game_space': {name: game(point) for (name, point) in MARKERS.items()},
    'pivots_game_space': {name: game(point) for (name, point) in NODE_PIVOTS.items()},
    'runtime_motion': {
        'mag': {'pivot': game(DISC_C), 'tilt_deg': 6,
                'spin_axis': [0, round(math.cos(DISC_TILT), 6), round(math.sin(DISC_TILT), 6)]},
        'bolt': {'pivot': game(FLYWHEEL_C), 'spin_axis': [0, 0, 1], 'kick_m': 0.012},
        'horns': {'axis': 'game +y through the pin', 'flare_deg': [0, 11, 22],
                  'runtime': 'right rotation.y = -flare, left rotation.y = +flare'},
        'spare disc': {'pivot': game(SPARE_C), 'lift_to': game(DISC_C)},
        'gauge needle': {'pivot': game(GAUGE_C), 'spin_axis': [1, 0, 0]},
    },
    'contract_points': {'breech_y': BREECH_Y, 'bore_axis': [BORE_X, BORE_Z],
                        'spindle_radius': BORE_R,
                        'heat_band': [-HEAT_BAND[1], -HEAT_BAND[0]],
                        'heat_band_clearance_radius': HEAT_CLEAR,
                        'sight_height': SIGHT_Z,
                        'sight_posts_game_z': [-REAR_POST_Y, -RING_POST_Y]},
    'files': {'blend': 'docs/design/blender/skua/skua.blend',
              'glb': 'docs/design/blender/skua/skua.glb',
              'renders': ['render-hero.png', 'render-side.png', 'render-left.png',
                          'render-ads.png', 'render-rear.png'],
              'validation': 'docs/design/blender/skua/validation.json'},
    'build_time_checks': {
        'anchor_contract': 'spindle tip on the muzzle plane, bore axis, spindle radius over '
                           'the heat band, all four markers, the ring sight and rear notch on '
                           'the 0.150 sight line, trigger tip, flywheel hub at BOLT_HOME, '
                           'nothing on-axis forward of the muzzle (horn tips |x| >= 0.06)',
        'heat_band_clearance': f'only the spindle within {HEAT_CLEAR} of the axis across the band',
        'coplanar_face_audit': 'rejects flush faces between parts',
        'part_contact': 'every part within 1 mm of the spindle cluster',
        'horn_sweep': 'horns at 0/11/22 deg clear of every other part and below SIGHT_Z - 0.03',
        'disc_paths': 'throw/catch slide (shrinking to 0.25) and the in-place cassette lift '
                      'cut nothing the disc does not touch at rest',
        'rear_notch': 'notch floor below the ring aperture as seen from the ADS eye',
        'disc_visibility': 'seated disc >= 4 % of a 50 deg ADS frame from the eye, top face seen',
    },
    'geometry_audit': {'coplanar_faces': collisions, 'floating_parts': floaters,
                       'horn_sweep': sweep_failures, 'horn_sweep_measured': sweep_measured,
                       'disc_paths': path_failures,
                       'disc_visibility': {'frame_fraction': round(disc_fraction, 5),
                                           'top_face_fraction': round(disc_top_fraction, 5)},
                       'heat_band_nearest_off_axis': round(band_off_axis or 0, 5)},
    'limitations': [
        'Scalar metallic/roughness only: no baked normal, occlusion or roughness maps.',
        'Single LOD; no mobile GPU profiling.',
        'blade steel and polished edge share the machined-steel palette map, so they differ '
        'only by name after the material-library pass.',
        'The cassette glow strip shares the razor glow material with the discs and prongs.',
        'The throw path of the seated disc passes the horn pins: the runtime hides the disc '
        'during the slide-out.',
    ],
    'notes': ['Fresh design (study FORK): flat toothed disc on a forward spindle, orange fork '
              'bridge with ring sight, hinged catch horns, open flywheel cage, strapped brace '
              'cuff, skeletal spare-disc cassette.',
              'Markings are modelled geometry, not a texture decal.'],
}
(DOCS / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({k: manifest[k] for k in ('source_parts', 'batch_nodes', 'triangles')}, indent=2))
print(f'blend={BLEND} bytes={BLEND.stat().st_size}')
print(f'glb={GLB} bytes={GLB.stat().st_size}')
print('SKUA-BUILD-DONE')
