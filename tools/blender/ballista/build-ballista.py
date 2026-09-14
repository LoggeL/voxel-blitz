"""Author BALLISTA, an original high-spine siege rifle prop for Voxel Blitz.

Fresh design, built from scratch: no geometry, file or mesh is loaded from the
older PEREGRINE study. Only the low-level authoring technique (closed convex
primitives, analytic planar UVs, shared ImageGen maps) and the frozen runtime
interface (anchors, part nodes, markers) are shared, because the game slot
demands them.

Run headless (the repo's own convention for long Blender work; the MCP bridge
runs the same Blender Python underneath):

    blender --background --factory-startup --python build-ballista.py

or through the live Blender MCP session (protocol 5) on 127.0.0.1:9876:

    from pathlib import Path
    p = Path('.../tools/blender/ballista/build-ballista.py')
    exec(compile(p.read_text(), str(p), 'exec'), {'__file__': str(p)})

The script is deterministic and self-contained. It creates its own scene,
builds there, and writes the .blend with `copy=True` so a live session keeps
pointing at whatever was open.

Authoring space is Blender's own: +Y is the barrel/forward axis, +Z is up, +X
is right, which the glTF exporter turns into the game's -Z forward / +Y up /
+X right convention. Game-local coordinates therefore relate to authoring
coordinates by

    game_x = x,  game_y = z,  game_z = -y

Every frozen runtime anchor is written as a literal next to the geometry that
has to reach it, and asserted at build time:

    muzzle   (0, 0.055, -0.760)   -> y = 0.760, x = 0, z = 0.055
    bore axis x = 0, y = 0.055    -> x = 0, z = 0.055, exposed radius 0.0210
    grip     (0.045, 0.020, -0.13)-> y = 0.130, x = 0.045, z = 0.020
    support  (-0.055, -0.010, -0.48) -> y = 0.480, x = -0.055, z = -0.010
    sight    optical axis 0.205   -> z = 0.205
    breech   sniper -0.260        -> y = 0.260
    trigger  sniper -0.165        -> y = 0.165, blade tip z = -0.020
    bolt home sniper -0.010       -> y = 0.010, handle to -x
    heat band -0.560 .. -0.720    -> y = 0.560 .. 0.720

Design intent: a high-spine siege rifle. A tall enclosed monolithic receiver
carries the bolt in a top trough between high walls, a full-length HIGH rail
spine on two riser blocks, an octagonal barrel shroud over the rear barrel
half, a smooth heavy bull barrel across the heat band, a recessed target
crown, a closed thumbhole stock with a genuine opening, and a wide flat-bottom
benchrest fore-end with a folded bipod. Twin-ring cantilever optic with a long
sunshade-free objective bell. It reads as the opposite of PEREGRINE: armored,
high and shut, rather than low, open and skeletal.

Geometry is closed convex primitives (no booleans, no negative scales), then
chamfered by a bevel modifier; winding is repaired with recalc_face_normals and
UVs are an analytic per-face projection of the two non-dominant axes so the six
ImageGen maps tile at a constant real-world density. Every joint overlaps
volumetrically by >= 1 mm: butt-jointed flush faces z-fight once same-material
parts merge into one draw call.

Outputs (owned by this task):
    docs/design/blender/ballista/ballista.blend   editable, textures packed
    docs/design/blender/ballista/ballista.glb     portable GLB, images embedded
    docs/design/blender/ballista/manifest.json    machine-readable record
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
DOCS = ROOT / 'docs/design/blender/ballista'
INK = ROOT / 'public/assets/blender/textures'
DOCS.mkdir(parents=True, exist_ok=True)

ASSET = 'BALLISTA'
SCENE_NAME = f'{ASSET} | Voxel Blitz sniper study'
UV_SCALE = 3.6  # texture tiles per metre, constant across the whole model
GROUPS = ['body', 'mag', 'bolt', 'trigger', 'factory-optic', 'extra']

# --- frozen runtime anchors, in Blender authoring space --------------------
MUZZLE = (0.000, 0.760, 0.055)     # game (0.000, 0.055, -0.760)
GRIP = (0.045, 0.130, 0.020)       # game (0.045, 0.020, -0.130)
SUPPORT = (-0.055, 0.480, -0.010)  # game (-0.055, -0.010, -0.480)
SIGHT = (0.000, 0.250, 0.205)      # optical axis, game y = 0.205
MARKERS = {'muzzle': MUZZLE, 'grip': GRIP, 'support': SUPPORT, 'sight': SIGHT}

BORE_X, BORE_Z = 0.000, 0.055   # bore axis
BORE_R = 0.0210                 # exposed bore radius
BORE_IN = 0.0080                # muzzle mouth recess radius
BORE_START = 0.200              # buried in the receiver
SHROUD_END = 0.540              # octagonal shroud ends: bare bull barrel begins
HEAT_BAND = (0.560, 0.720)      # game z -0.56 .. -0.72
BREECH_Y = 0.260                # BREACH_Z.sniper -0.26
OPTIC_Z = 0.205                 # body.userData.sightHeight
LENS_REAR_Y = -0.035            # rear eyepiece lens plane, game z +0.035 (moved per user override)
LENS_FRONT_Y = 0.475            # front objective lens plane, game z -0.475 (moved per user override)
TRIGGER_Y, TRIGGER_TIP_Z = 0.165, -0.020   # TRIGGER_Z.sniper -0.165
BOLT_HOME_GAME_Z = -0.010       # BOLT_HOME.sniper
BOLT_HOME_Y = -BOLT_HOME_GAME_Z  # the same point in authoring space

# --- scene -----------------------------------------------------------------
def drop_previous_study():
    previous = bpy.data.scenes.get(SCENE_NAME)
    if previous is not None:
        for obj in list(previous.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.scenes.remove(previous)
    for collection in (bpy.data.meshes, bpy.data.curves):
        for block in list(collection):
            if block.users == 0 and (block.name.startswith(ASSET) or
                                     block.name.endswith((' shell', ' merged', ' mesh'))):
                collection.remove(block)
    for collection in (bpy.data.materials, bpy.data.worlds, bpy.data.images):
        for block in list(collection):
            if block.users == 0 and (block.name.startswith(ASSET) or
                                     block.name.startswith('textures/')):
                collection.remove(block)
    bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=False, do_recursive=True)


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
scene.cycles.seed = 20260914
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'
scene.world = bpy.data.worlds.new(f'{ASSET} studio world')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.14, .17, .21, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .35

# --- materials -------------------------------------------------------------
# AWM two-tone: olive-drab furniture over blackened metal. Both reuse the
# delivered worn-gunmetal map with different multiply tints (no new images),
# so the portable GLB and the runtime stay in agreement through baseColorFactor.
MATERIALS = [
    ('gunmetal', 'worn-gunmetal', .50, .35, (.34, .34, .36)),
    ('olive drab', 'worn-gunmetal', .08, .68, (.62, .63, .47)),
    ('orange paint', 'orange-painted-metal', .12, .50, (.95, .93, .90)),
    ('ivory coating', 'ivory-armor', .04, .45, (.96, .95, .92)),
    ('petrol fabric', 'petrol-ballistic-fabric', 0, .82, (.90, .91, .93)),
    ('tan webbing', 'tan-webbing', 0, .88, (.94, .93, .91)),
    ('rubber', 'worn-rubber', 0, .90, (.62, .63, .65)),
]
mats = {}
for name, stem, metal, rough, tint in MATERIALS:
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
    mats[name] = material

glass = bpy.data.materials.new(f'{ASSET} | optic glass')
glass.use_nodes = True
gbsdf = glass.node_tree.nodes['Principled BSDF']
gbsdf.inputs['Base Color'].default_value = (.18, .58, .65, 1)
gbsdf.inputs['Metallic'].default_value = 0
gbsdf.inputs['Roughness'].default_value = .10
gbsdf.inputs['Alpha'].default_value = .16
gbsdf.inputs['Emission Color'].default_value = (.10, .35, .40, 1)
gbsdf.inputs['Emission Strength'].default_value = .25
glass.surface_render_method = 'BLENDED' if hasattr(glass, 'surface_render_method') else None
glass['glass'] = True
mats['optic glass'] = glass

# --- primitive builders ----------------------------------------------------
PARTS = []      # (object, part, material key)
ROUND_OBJECTS = []  # stripper rounds: never merged, each its own node
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


def tube_stacked(radius, y0, y1, step=0.02, segments=24, radius1=None):
    """Closed Y-cylinder with lengthwise ring subdivisions.

    Plain tube() only carries vertices at its end caps, which leaves spans
    like the heat band with nothing to measure. Rings every `step` keep every
    audit honest while the silhouette stays a perfect cylinder. `radius1`
    tapers the rings from `radius` to a second end radius (a muzzle taper:
    keep it off the heat band, which must stay exactly 0.0210).
    """
    count = max(2, int(round((y1 - y0) / step)) + 1)
    verts, faces = [], []
    for k in range(count):
        y = y0 + (y1 - y0) * k / (count - 1)
        rr = radius if radius1 is None else radius + (radius1 - radius) * k / (count - 1)
        base = len(verts)
        for i in range(segments):
            angle = 2 * math.pi * i / segments
            verts.append((rr * math.cos(angle), y, BORE_Z + rr * math.sin(angle)))
        ring = tuple(range(base, base + segments))
        if k == 0:
            faces.append(tuple(reversed(ring)))
        if k == count - 1:
            faces.append(ring)
        if k:
            prev = base - segments
            for i in range(segments):
                j = (i + 1) % segments
                faces.append((prev + i, prev + j, base + j, base + i))
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
        bevel=.0025, mirror=False, uv_scale=UV_SCALE):
    """Create one chamfered, UV-mapped part."""
    (base_verts, faces) = shape
    for side in ((1, -1) if mirror else (1,)):
        mesh = bpy.data.meshes.new(f'{name}{" left" if side < 0 else ""} shell')
        verts = [(side * v[0], v[1], v[2]) if side < 0 else v for v in base_verts]
        mesh.from_pydata(verts, [], faces)
        mesh.validate()
        if side < 0:
            placed, turned = (-loc[0], loc[1], loc[2]), (rot[0], -rot[1], -rot[2])
        else:
            placed, turned = loc, rot
        matrix = Matrix.LocRotScale(Vector(placed), Euler(turned, 'XYZ'), None)
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(f'{name}{" left" if side < 0 else ""}'
                                   if mirror else name, mesh)
        mesh.materials.append(mats[material])
        obj['part'] = part
        obj['ballista_material'] = material
        obj.parent = PART_GROUP[part]
        STUDY.objects.link(obj)
        if bevel:
            modifier = obj.modifiers.new('Edge chamfer', 'BEVEL')
            modifier.width = bevel
            modifier.segments = 2
            modifier.limit_method = 'ANGLE'
            modifier.angle_limit = math.radians(30)
            modifier.use_clamp_overlap = True
        project_uvs(mesh, uv_scale)
        PARTS.append((obj, part, material))
    return obj


def pair(name, part, material, shape, loc=(0, 0, 0), rot=(0, 0, 0), bevel=.0025):
    """Mirror a part across X."""
    add(name, part, material, shape, loc=loc, rot=rot, bevel=bevel)
    add(name, part, material, shape,
        loc=(-loc[0], loc[1], loc[2]), rot=(rot[0], -rot[1], -rot[2]), bevel=bevel)


def add_local(name, part, material, shapes, loc):
    """A multi-primitive part whose vertices stay centred on the object origin."""
    (verts, faces) = merge_shapes(shapes)
    mesh = bpy.data.meshes.new(f'{name} shell')
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    mesh.materials.append(mats[material])
    obj['part'] = part
    obj['ballista_material'] = material
    obj['round'] = True
    obj.parent = PART_GROUP[part]
    obj.location = loc
    STUDY.objects.link(obj)
    ROUND_OBJECTS.append(obj)
    project_uvs(mesh)
    return obj


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
    label.data.materials.append(mats[material])
    label['part'] = part
    label['ballista_material'] = material
    label.parent = PART_GROUP[part]
    project_uvs(label.data)
    PARTS.append((label, part, material))
    return label


# ===========================================================================
# BODY: tall enclosed receiver, high rail spine, shrouded bull barrel,
# closed thumbhole stock, benchrest fore-end with folded bipod
# ===========================================================================
# Monolithic high-wall receiver. The bolt rides in the open trough between the
# walls on two guide rails: armored, but the action stays readable.
add('Monolithic receiver', 'body', 'gunmetal', prism([
    (-0.100, -0.034), (-0.100, 0.030), (0.260, 0.030),
    (0.300, 0.010), (0.300, -0.030), (0.100, -0.038)], .056), bevel=.005)
pair('Receiver trough wall', 'body', 'gunmetal', boxv((.009, .360, .0525)),
     loc=(.0265, 0.085, 0.05375), bevel=.004)
pair('Bolt guide rail', 'body', 'gunmetal', boxv((.008, .200, .010)),
     loc=(.0175, 0.050, 0.044), bevel=0)
add('Receiver rear cap', 'body', 'gunmetal', boxv((.060, .014, .120)),
    loc=(0, -0.103, 0.020), bevel=.002)

# Full-length HIGH rail spine on two riser blocks spanning both trough walls.
add('Rail riser rear', 'body', 'gunmetal', boxv((.066, .050, .080)),
    loc=(0, -0.020, 0.115), bevel=.002)
add('Rail riser front', 'body', 'gunmetal', boxv((.066, .050, .080)),
    loc=(0, 0.200, 0.115), bevel=.002)
add('High rail spine', 'body', 'gunmetal', boxv((.046, .340, .014)),
    loc=(0, 0.120, 0.160), bevel=.0015)
for index, y in enumerate((-0.030, 0.070, 0.170)):
    add(f'Rail lug {index + 1}', 'body', 'gunmetal', boxv((.030, .014, .005)),
        loc=(0, y, 0.1685), bevel=.0012)

# Armored flank detail, 1+ mm proud or embedded: never flush.
add('Ejection port inset', 'body', 'rubber', boxv((.010, .090, .020)),
    loc=(.028, 0.100, 0.068))
add('Ejection port lip', 'body', 'gunmetal', boxv((.006, .100, .006)),
    loc=(.029, 0.100, 0.080), bevel=.0012)
pair('Side armor panel', 'body', 'olive drab', boxv((.004, .180, .040)),
     loc=(.0315, 0.060, 0.020))
add('Safety selector', 'body', 'orange paint', boxv((.012, .030, .010)),
    loc=(-.035, 0.100, 0.030), bevel=.0015)

# Short octagonal barrel shroud; ahead of it the fluted barrel runs exposed
# to the band, AWM-style, with an open channel between the forend sidewalls.
add('Octagonal barrel shroud', 'body', 'olive drab',
    solid(circle(.036, 8, phase=math.pi / 8), .130, 'Y'), loc=(0, 0.355, 0.055),
    bevel=.0015)
for index, y in enumerate((0.330, 0.395)):
    add(f'Shroud rib {index + 1}', 'body', 'gunmetal',
        washer(.039, .0330, .014, 16), loc=(0, y, 0.055))
for index, y in enumerate((0.345, 0.390)):
    pair(f'Shroud vent bar {index + 1}', 'body', 'rubber', boxv((.004, .030, .008)),
         loc=(.0345, y, 0.055))

add('Fore-end beam', 'body', 'olive drab', boxv((.064, .250, .038)),
    loc=(0, 0.415, -0.021), bevel=.002)
add('Forend tip cap', 'body', 'olive drab', boxv((.068, .012, .042)),
    loc=(0, 0.540, -0.021), bevel=.002)
for index, y in enumerate((0.335, 0.395)):
    add(f'Shroud saddle {index + 1}', 'body', 'olive drab', boxv((.030, .040, .025)),
        loc=(0, y, 0.008), bevel=.0015)
# Barrel channel sidewalls: the exposed barrel runs free between them.
pair('Channel sidewall', 'body', 'olive drab', boxv((.008, .100, .030)),
     loc=(.032, 0.485, 0.011), bevel=.0015)
# Fluted-barrel read: six dark fins standing proud ahead of the shroud.
for index in range(6):
    angle = math.pi / 6 + index * math.pi / 3
    add(f'Barrel flute {index + 1}', 'body', 'rubber', boxv((.002, .130, .003)),
        loc=(.0205 * math.cos(angle), 0.490, BORE_Z + .0205 * math.sin(angle)),
        rot=(0, -angle, 0), bevel=0)
# Forend accessory rails with slot ribs.
add('Accessory rail', 'body', 'gunmetal', boxv((.022, .120, .010)),
    loc=(0, 0.470, -0.0425), bevel=.0015)
pair('Forend side rail', 'body', 'gunmetal', boxv((.004, .140, .014)),
     loc=(.033, 0.420, -0.021), bevel=0)
for index, y in enumerate((0.375, 0.420, 0.465)):
    pair(f'Forend rail slot {index + 1}', 'body', 'rubber', boxv((.006, .008, .016)),
         loc=(.0335, y, -0.021), bevel=0)
# Slim bipod folded back against the beam, clear of the support palm and of
# the heat-band span the contract reserves for bare metal.
pair('Bipod hinge', 'body', 'gunmetal', boxv((.010, .040, .027)),
     loc=(.032, 0.515, -0.026), bevel=.0015)
pair('Bipod leg', 'body', 'gunmetal', boxv((.008, .160, .007)),
     loc=(.040, 0.440, -0.030), bevel=.0015)
pair('Bipod foot', 'body', 'rubber', boxv((.010, .022, .010)),
     loc=(.0415, 0.350, -0.030), bevel=.002)

# Raked pistol grip wrapping the grip marker; the x = 0.045 palm sits just
# outboard of the half-width 0.0305 panel.
add('Pistol grip', 'body', 'olive drab', prism([
    (0.170, 0.010), (0.090, 0.010), (0.052, -0.055), (0.045, -0.120),
    (0.105, -0.128), (0.135, -0.060)], .061), bevel=.008)
for index, (y, z) in enumerate(((0.120, -0.094), (0.1525, -0.025))):
    add(f'Grip finger rib {index + 1}', 'body', 'gunmetal', boxv((.063, .010, .010)),
        loc=(0, y, z), bevel=.002)
add('Grip base cap', 'body', 'gunmetal', boxv((.064, .060, .012)),
    loc=(0, 0.075, -0.130), rot=(math.radians(-7), 0, 0), bevel=.003)
add('Grip palm swell', 'body', 'olive drab', boxv((.070, .016, .040)),
    loc=(0, 0.0485, -0.0875), bevel=.004)
# Thumbhole lower web: closes the loop between grip heel and toe bar, so the
# opening reads as one continuous AWM-style thumbhole instead of a gap.
add('Thumbhole lower web', 'body', 'olive drab', prism([
    (0.080, -0.095), (0.050, -0.115), (-0.115, -0.052), (-0.115, -0.032)], .026),
    bevel=.004)

# Closed thumbhole stock: comb bar, toe bar and butt plate leave a genuine
# opening between them. No booleans anywhere on this model.
add('Stock comb bar', 'body', 'olive drab', boxv((.040, .210, .040)),
    loc=(0, -0.190, 0.065), bevel=.005)
add('Stock toe bar', 'body', 'olive drab', boxv((.036, .200, .036)),
    loc=(0, -0.205, -0.037), bevel=.005)
add('Stock butt plate', 'body', 'olive drab', boxv((.042, .016, .150)),
    loc=(0, -0.308, 0.007), bevel=.004)
add('Recoil pad upper', 'body', 'rubber', boxv((.044, .016, .090)),
    loc=(0, -0.3215, 0.040), bevel=.006)
add('Recoil pad lower', 'body', 'rubber', boxv((.040, .016, .075)),
    loc=(0, -0.3195, -0.0375), rot=(math.radians(6), 0, 0), bevel=.006)
# Buttpad spacer lines and the folded rear monopod.
add('Buttpad spacer front', 'body', 'rubber', boxv((.046, .003, .088)),
    loc=(0, -0.3225, 0.040), bevel=0)
add('Buttpad spacer rear', 'body', 'rubber', boxv((.046, .003, .088)),
    loc=(0, -0.3185, 0.040), bevel=0)
add('Rear monopod leg', 'body', 'gunmetal', boxv((.016, .100, .014)),
    loc=(0, -0.2475, -0.056), bevel=0)
add('Rear monopod foot', 'body', 'rubber', boxv((.018, .016, .016)),
    loc=(0, -0.295, -0.058), bevel=0)
for index, y in enumerate((-0.260, -0.160)):
    add(f'Cheek riser post {index + 1}', 'body', 'olive drab', boxv((.020, .014, .020)),
        loc=(0, y, 0.092), bevel=.002)
add('Cheek riser plate', 'body', 'olive drab', boxv((.036, .120, .010)),
    loc=(0, -0.210, 0.108), bevel=.002)
add('Cheek pad', 'body', 'olive drab', boxv((.034, .110, .010)),
    loc=(0, -0.210, 0.1175), bevel=.003)
add('Buttstock ammo sleeve front', 'body', 'tan webbing', boxv((.020, .008, .044)),
    loc=(0.026, -0.255, 0.084), bevel=.002)
add('Buttstock ammo sleeve rear', 'body', 'tan webbing', boxv((.020, .008, .044)),
    loc=(0.026, -0.215, 0.084), bevel=.002)
add('Toe QD socket', 'body', 'gunmetal', tube(.007, .012, 8, axis='X'),
    loc=(-0.020, -0.270, -0.042))
add('Toe sling loop', 'body', 'gunmetal', solid(recty(-0.012, 0.012, -0.014, 0.014), .008, 'X',
                                                recty(-0.005, 0.005, -0.006, 0.006)),
    loc=(-0.017, -0.190, -0.042), bevel=.001)

# Heavy bull barrel: bare gunmetal of exactly 0.0210 across the whole heat
# band, tapering to 0.0190 ahead of it, with milled brake ports and a
# recessed target crown; nothing wider than 0.0210 at the muzzle.
BORE_OBJECT = add('Bull barrel', 'body', 'gunmetal', merge_shapes([
    tube_stacked(BORE_R, BORE_START, HEAT_BAND[1]),
    tube_stacked(BORE_R, HEAT_BAND[1], MUZZLE[1], step=0.01, radius1=0.0190)]),
    loc=(BORE_X, 0, 0), bevel=0)
add('Bore breech collar', 'body', 'gunmetal', tube(.023, .010, 16),
    loc=(BORE_X, 0.206, BORE_Z))
add('Target crown', 'body', 'gunmetal', washer(.0205, .014, .006, 24),
    loc=(BORE_X, 0.7565, BORE_Z), bevel=0)
add('Brake collar', 'body', 'gunmetal', washer(.0205, .0185, .006, 24),
    loc=(BORE_X, 0.741, BORE_Z), bevel=0)
add('Muzzle mouth', 'body', 'rubber', tube(.011, .002, 16),
    loc=(BORE_X, 0.758, BORE_Z), bevel=0)
# Milled brake ports: two staggered rows of dark blocks ringing the tapered
# crown, all at or under the 0.0210 muzzle ceiling the contract demands.
for index, angle in enumerate((math.pi / 4, 3 * math.pi / 4,
                               5 * math.pi / 4, 7 * math.pi / 4)):
    add(f'Crown port {index + 1}', 'body', 'rubber', boxv((.0045, .012, .0045)),
        loc=(.0178 * math.cos(angle), 0.7515, BORE_Z + .0178 * math.sin(angle)),
        rot=(0, -angle, 0), bevel=0)
for index, angle in enumerate((0.0, math.pi / 2, math.pi, 3 * math.pi / 2)):
    add(f'Brake port {index + 1}', 'body', 'rubber', boxv((.0045, .012, .0045)),
        loc=(.0184 * math.cos(angle), 0.7365, BORE_Z + .0184 * math.sin(angle)),
        rot=(0, -angle, 0), bevel=0)
# Identity markings, modelled as geometry on the receiver flanks.
add_text(ASSET, 'Marking BALLISTA left', 'body', 'ivory coating',
         (-0.0305, 0.200, 0.032), (math.pi / 2, 0, -math.pi / 2), .014)
add_text(ASSET, 'Marking BALLISTA right', 'body', 'ivory coating',
         (0.0305, 0.200, 0.032), (math.pi / 2, 0, math.pi / 2), .014)
add_text('VB 91', 'Marking VB 91 left', 'body', 'ivory coating',
         (-0.0305, -0.058, 0.032), (math.pi / 2, 0, -math.pi / 2), .010)
add_text('VB 91', 'Marking VB 91 right', 'body', 'ivory coating',
         (0.0305, -0.058, 0.032), (math.pi / 2, 0, math.pi / 2), .010)

# ===========================================================================
# MAGAZINE: short curved 5-rounder, obviously not a second grip
# ===========================================================================
add('Magwell collar', 'mag', 'olive drab', boxv((.060, .050, .040)),
    loc=(0, 0.235, -0.015), bevel=.002)
add('Magazine body', 'mag', 'gunmetal', prism([
    (0.255, 0.000), (0.215, 0.000), (0.205, -0.075),
    (0.208, -0.100), (0.248, -0.100), (0.252, -0.072)], .052), bevel=.004)
add('Magazine floor plate', 'mag', 'orange paint', prism([
    (0.203, -0.098), (0.253, -0.098), (0.257, -0.112), (0.199, -0.112)], .060),
    bevel=.003)
add('Magazine witness stripe', 'mag', 'orange paint', boxv((.054, .006, .030)),
    loc=(0, 0.230, -0.040), bevel=.0015)
add('Magazine feed lip', 'mag', 'rubber', boxv((.036, .030, .010)),
    loc=(0, 0.242, 0.002), bevel=.002)
add('Magazine front rib upper', 'mag', 'gunmetal', boxv((.054, .010, .060)),
    loc=(0, 0.2117, -0.040), bevel=0)
add('Magazine front rib lower', 'mag', 'gunmetal', boxv((.058, .010, .060)),
    loc=(0, 0.2087, -0.062), bevel=0)
add('Magwell flare lip', 'mag', 'olive drab', boxv((.048, .014, .010)),
    loc=(0, 0.209, -0.032), bevel=0)

# ===========================================================================
# BOLT and TRIGGER: the two small moving owners
# ===========================================================================
add('Bolt body', 'bolt', 'gunmetal', tube(.0135, .180, 12), loc=(0, 0.050, 0.058))
add('Bolt body collar', 'bolt', 'gunmetal', tube(.0165, .012, 12), loc=(0, 0.120, 0.058))
add('Bolt shroud', 'bolt', 'gunmetal', tube(.017, .026, 12), loc=(0, -0.060, 0.058))
add('Bolt cocking piece', 'bolt', 'gunmetal', tube(.008, .012, 10), loc=(0, -0.078, 0.058))
add('Bolt handle root', 'bolt', 'gunmetal', tube(.016, .014, 10, axis='X'),
    loc=(-0.020, BOLT_HOME_Y, 0.058))
add('Bolt handle arm', 'bolt', 'gunmetal', boxv((.050, .016, .018)),
    loc=(-0.048, BOLT_HOME_Y, 0.058), bevel=.003)
BOLT_KNOB_OBJECT = add('Bolt knob', 'bolt', 'gunmetal',
                       taper(.014, .005, 0.0, 0.032, 12),
                       loc=(-0.071, BOLT_HOME_Y, 0.058), rot=(0, 0, math.pi / 2), bevel=0)
add('Bolt knob collar', 'bolt', 'gunmetal', washer(.0145, .0120, .004, 10, axis='X'),
    loc=(-0.074, BOLT_HOME_Y, 0.058), bevel=0)

TRIGGER_OBJECT = add('Trigger blade', 'trigger', 'gunmetal', boxv((.010, .014, .024)),
                     loc=(0, TRIGGER_Y, -0.006967), rot=(math.radians(10), 0, 0), bevel=.002)
add('Trigger shoe', 'trigger', 'orange paint', boxv((.012, .008, .014)),
    loc=(0, TRIGGER_Y + 0.005, -0.014), rot=(math.radians(10), 0, 0), bevel=.0015)
add('Trigger guard', 'trigger', 'gunmetal', solid(recty(0.120, 0.205, -0.070, 0.008), .030, 'X',
                                                  recty(0.130, 0.196, -0.056, -0.006)), bevel=.003)

# ===========================================================================
# FACTORY OPTIC: twin-ring cantilever mount, axis exactly on the sight line
# ===========================================================================
add('Optic tube', 'factory-optic', 'gunmetal', tube(.020, .460, 16), loc=(0, 0.240, OPTIC_Z))
add('Optic coating band', 'factory-optic', 'gunmetal', washer(.0212, .0199, .020, 16),
    loc=(0, 0.307, OPTIC_Z))
add('Optic power ring', 'factory-optic', 'gunmetal', tube(.022, .026, 16), loc=(0, 0.082, OPTIC_Z))
for index in range(8):
    angle = 2 * math.pi * index / 8
    add(f'Optic power rib {index + 1}', 'factory-optic', 'gunmetal', boxv((.004, .008, .004)),
        loc=(.0220 * math.cos(angle), 0.082, OPTIC_Z + .0220 * math.sin(angle)),
        rot=(0, 0, angle), bevel=0)
add('Optic cant bar', 'factory-optic', 'gunmetal', boxv((.040, .400, .020)),
    loc=(0, 0.211, 0.1755), bevel=.003)
pair('Mount cheek', 'factory-optic', 'gunmetal', boxv((.006, .360, .024)),
     loc=(.0215, 0.211, 0.176), bevel=.0015)
for index, y in enumerate((0.050, 0.330)):
    add(f'Optic cradle {index + 1}', 'factory-optic', 'gunmetal',
        solid(recty(y - 0.014, y + 0.014, 0.178, 0.200), .034, 'X'), bevel=.001)
    add(f'Optic ring {index + 1}', 'factory-optic', 'gunmetal', washer(.0275, .0202, .016, 16),
        loc=(0, y, OPTIC_Z))
    for side in (-1, 1):
        tag = 'left' if side < 0 else 'right'
        add(f'Optic ring ear {index + 1} {tag}', 'factory-optic', 'gunmetal',
            boxv((.012, .020, .010)), loc=(side * .030, y, OPTIC_Z), bevel=0)
        add(f'Optic ring screw {index + 1} {tag}', 'factory-optic', 'gunmetal',
            tube(.0028, .014, 8, axis='Z'), loc=(side * .030, y, OPTIC_Z), bevel=0)
        add(f'Optic screw head {index + 1} {tag}', 'factory-optic', 'gunmetal',
            tube(.0040, .0035, 8, axis='Z'), loc=(side * .030, y, 0.2115), bevel=0)
    add(f'Optic cross bolt {index + 1}', 'factory-optic', 'gunmetal',
        tube(.005, .052, 10, axis='X'), loc=(0, y, 0.168), bevel=0)
    add(f'Optic cross bolt nut {index + 1}', 'factory-optic', 'gunmetal',
        boxv((.006, .010, .010)), loc=(.0285, y, 0.168), bevel=0)
add('Optic elevation turret', 'factory-optic', 'gunmetal', tube(.014, .020, 12, axis='Z'),
    loc=(0, 0.130, 0.2255))
add('Optic elevation dial', 'factory-optic', 'orange paint', washer(.0148, .0120, .006, 12, axis='Z'),
    loc=(0, 0.130, 0.233), bevel=0)
add('Optic elevation cap', 'factory-optic', 'gunmetal', tube(.0148, .006, 12, axis='Z'),
    loc=(0, 0.130, 0.2375))
add('Optic windage turret', 'factory-optic', 'gunmetal', tube(.014, .020, 12, axis='X'),
    loc=(0.025, 0.130, OPTIC_Z))
add('Optic windage cap', 'factory-optic', 'gunmetal', tube(.0148, .006, 12, axis='X'),
    loc=(0.037, 0.130, OPTIC_Z))
add('Optic parallax turret', 'factory-optic', 'gunmetal', tube(.012, .018, 12, axis='X'),
    loc=(-0.023, 0.130, OPTIC_Z))
add('Optic eyepiece bell', 'factory-optic', 'gunmetal', taper(.019, .026, 0.020, -0.028, 16),
    loc=(0, 0, OPTIC_Z))
add('Optic eyepiece rim', 'factory-optic', 'gunmetal', washer(.0285, .0245, .012, 16),
    loc=(0, -0.024, OPTIC_Z))
add('Optic eye lens', 'factory-optic', 'optic glass', tube(.0260, .008, 16),
    loc=(0, -0.031, OPTIC_Z), bevel=0)
add('Optic objective cone', 'factory-optic', 'gunmetal', taper(.019, .043, 0.400, 0.442, 16),
    loc=(0, 0, OPTIC_Z))
add('Optic objective bell', 'factory-optic', 'gunmetal', washer(.044, .0405, .032, 16),
    loc=(0, 0.456, OPTIC_Z))
add('Optic objective lens', 'factory-optic', 'optic glass', tube(.0415, .008, 16),
    loc=(0, 0.471, OPTIC_Z), bevel=0)

# ===========================================================================
# EXTRA: three stripper rounds, direct children of `extra`.
# Geometry is centred on each round's own origin (12 x 12 x 50 mm, pointing
# along the bore axis) and the authored placement is carried by the object
# transform alone. They ride in the buttstock ammo sleeve between its loops.
ROUND_SHAPES = [
    offset(tube(.0058, .034, 12), dy=-0.0080),          # case body  y -0.025 .. 0.009
    offset(tube(.0060, .005, 12), dy=-0.0225),          # rim        y -0.025 .. -0.020
    taper(.0058, .0036, 0.009, 0.014, 12),              # shoulder
    offset(tube(.0036, .004, 12), dy=0.0140),           # neck       y  0.012 .. 0.016
    taper(.0036, .0008, 0.016, 0.025, 12),              # bullet     y  0.016 .. 0.025
]
for index, z in enumerate((0.070, 0.084, 0.098)):
    add_local(f'Round {index + 1}', 'extra', 'orange paint', ROUND_SHAPES,
              (0.028, -0.235, z))

# Node names the delivered files must use verbatim.
CONTRACT_NODE_NAMES = set(GROUPS) | set(MARKERS) | {obj.name for obj in ROUND_OBJECTS}


def contract_node_name(name):
    head, _, tail = name.rpartition('.')
    if tail.isdigit() and len(tail) == 3 and head in CONTRACT_NODE_NAMES:
        return head
    return name

# --- marker empties --------------------------------------------------------
MARKER_OBJECTS = {}
for (name, position) in MARKERS.items():
    marker = bpy.data.objects.new(name, None)
    marker.empty_display_type = 'ARROWS'
    marker.empty_display_size = .03
    marker.location = position
    marker['purpose'] = 'gameplay mount marker'
    STUDY.objects.link(marker)
    MARKER_OBJECTS[name] = marker

for (key, value) in {'asset_id': 'ballista',
                     'asset_name': 'BALLISTA',
                     'game_forward': '-Z after glTF export',
                     'sight_height': OPTIC_Z,
                     'bore_radius': BORE_R}.items():
    scene[key] = value

# --- contract assertions ---------------------------------------------------
# Headless runs need an explicit view-layer sync before data-API-created
# objects show up in the dependency graph.
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()
extent = {0: [1e9, -1e9], 1: [1e9, -1e9], 2: [1e9, -1e9]}
points = []
for (obj, _part, _material) in PARTS + [(o, 'extra', 'orange paint') for o in ROUND_OBJECTS]:
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    for vertex in mesh.vertices:
        point = obj.matrix_world @ vertex.co
        points.append((point, obj.name))
        for axis in range(3):
            extent[axis][0] = min(extent[axis][0], point[axis])
            extent[axis][1] = max(extent[axis][1], point[axis])
    evaluated.to_mesh_clear()

bore_object = BORE_OBJECT
band = [(p, n) for (p, n) in points if HEAT_BAND[0] - 1e-9 <= p[1] <= HEAT_BAND[1] + 1e-9]
band_radius = max(math.hypot(p[0] - BORE_X, p[2] - BORE_Z) for (p, _n) in band)
band_foreign = sorted({n for (p, n) in band if n != bore_object.name
                       and math.hypot(p[0] - BORE_X, p[2] - BORE_Z) > BORE_R + 1e-6})
bore_points = [p for (p, n) in points if n == bore_object.name]
bore_x = (min(p[0] for p in bore_points) + max(p[0] for p in bore_points)) / 2
bore_z = (min(p[2] for p in bore_points) + max(p[2] for p in bore_points)) / 2
tip = max(bore_points, key=lambda p: p[1])
tip_plane = sorted({round(p[1], 9) for (p, n) in points if n == bore_object.name and p[1] > 0.75})
trigger_object = TRIGGER_OBJECT
trigger_low = min((trigger_object.matrix_world @ v.co)[2] for v in trigger_object.data.vertices)
bolt_handle = BOLT_KNOB_OBJECT
knob_far = min((bolt_handle.matrix_world @ v.co)[0] for v in bolt_handle.data.vertices)

CONTRACT = [
    ('muzzle_forward_vertex_y', tip[1], MUZZLE[1], 1e-6),
    ('muzzle_marker', MUZZLE[1], 0.760, 1e-9),
    ('bore_axis_x', bore_x, BORE_X, 1e-9),
    ('bore_axis_z', bore_z, BORE_Z, 1e-9),
    ('exposed_bore_radius_in_heat_band', band_radius, BORE_R, 1e-6),
    ('grip_marker_x', GRIP[0], 0.045, 1e-9),
    ('grip_marker_y', GRIP[1], 0.130, 1e-9),
    ('grip_marker_z', GRIP[2], 0.020, 1e-9),
    ('support_marker_x', SUPPORT[0], -0.055, 1e-9),
    ('support_marker_y', SUPPORT[1], 0.480, 1e-9),
    ('support_marker_z', SUPPORT[2], -0.010, 1e-9),
    ('sight_axis_z', SIGHT[2], OPTIC_Z, 1e-9),
    ('trigger_blade_y', TRIGGER_Y, 0.165, 1e-9),
    ('trigger_blade_tip_z', trigger_low, TRIGGER_TIP_Z, 1e-6),
    ('bolt_handle_home_y', BOLT_HOME_Y, -BOLT_HOME_GAME_Z, 1e-9),
    ('bolt_knob_reach_x', knob_far, None, None),
    ('rear_eyepiece_lens_plane_y', LENS_REAR_Y, -0.035, 1e-9),
    ('front_objective_lens_plane_y', LENS_FRONT_Y, 0.475, 1e-9),
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
if knob_far >= 0:
    contract_failures.append(f'bolt handle does not protrude to -x: reaches {knob_far:.4f}')

print(f'model extent x={extent[0][0]:+.4f}..{extent[0][1]:+.4f} '
      f'y={extent[1][0]:+.4f}..{extent[1][1]:+.4f} z={extent[2][0]:+.4f}..{extent[2][1]:+.4f}')
print(f'forward-most vertex ({tip[0]:+.6f}, {tip[1]:+.6f}, {tip[2]:+.6f}), muzzle plane rows {tip_plane}')
print(f'heat band z-radius max {band_radius:.6f} over {len(band)} vertices, '
      f'foreign geometry {band_foreign or "none"}')
print(f'bore axis measured ({bore_x:+.9f}, {bore_z:+.9f}); bolt knob reaches x={knob_far:+.4f}')
if contract_failures:
    print(f'CONTRACT FAILURES: {len(contract_failures)}')
    for line in contract_failures:
        print(f'  {line}')
else:
    print('anchor contract: all assertions pass')

# --- pack textures and save the editable source ----------------------------
bpy.ops.file.pack_all()
BLEND = DOCS / 'ballista.blend'
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND), copy=True, check_existing=False)

# --- batch to material draw calls and export -------------------------------
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()


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

CONTACT_M = 0.0010        # 1 mm still reads as one machined form
CONTACT_ANCHOR = 'Monolithic receiver'


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
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    merged = bpy.data.meshes.new(f'{part} | {material} merged')
    bm.to_mesh(merged)
    bm.free()
    merged.materials.append(mats[material])
    project_uvs(merged)
    merged.calc_loop_triangles()
    triangles += len(merged.loop_triangles)
    per_primitive[f'{part} | {material}'] = len(merged.loop_triangles)
    obj = bpy.data.objects.new(f'{part} | {material}', merged)
    obj.parent = PART_GROUP[part]
    STUDY.objects.link(obj)
    export_objects.append(obj)

round_objects = ROUND_OBJECTS
for obj in round_objects:
    project_uvs(obj.data)
    obj.data.calc_loop_triangles()
    triangles += len(obj.data.loop_triangles)
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

GLB = DOCS / 'ballista.glb'
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
        name = contract_node_name(node.get('name', ''))
        if name in GROUPS:
            node.setdefault('extras', {})['blenderAsset'] = 'ballista'
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

# --- record ----------------------------------------------------------------
for obj in round_objects:
    per_primitive[f'extra | {obj.name}'] = len(obj.data.loop_triangles)

manifest = {
    'asset': 'BALLISTA',
    'asset_id': 'ballista',
    'kind': 'original high-spine siege rifle prop (visual game asset)',
    'blender': bpy.app.version_string,
    'authoring_script': 'tools/blender/ballista/build-ballista.py',
    'source_parts': len(PARTS),
    'animation_group_nodes': GROUPS,
    'marker_nodes': sorted(MARKERS),
    'batch_nodes': len(batches),
    'round_nodes': [obj.name for obj in round_objects],
    'triangles': triangles,
    'triangles_per_primitive': per_primitive,
    'materials': [m[0] for m in MATERIALS] + ['optic glass'],
    'material_textures': {m[0]: f'{m[1]}.jpg' for m in MATERIALS},
    'imagegen_textures': [f'{m[1]}.jpg' for m in MATERIALS],
    'texture_source': 'public/assets/blender/textures (the delivered 1024px JPEGs, '
                      'reused byte-identical; originals untouched)',
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
                        'exposed_bore': [SHROUD_END, MUZZLE[1]],
                        'heat_band': [-HEAT_BAND[1], -HEAT_BAND[0]],
                        'sight_height': OPTIC_Z,
                        'lens_planes': [-LENS_REAR_Y, -LENS_FRONT_Y]},
    'files': {'blend': 'docs/design/blender/ballista/ballista.blend',
              'glb': 'docs/design/blender/ballista/ballista.glb',
              'renders': ['render-hero.png', 'render-side.png', 'render-ads.png',
                          'render-rear.png'],
              'validation': 'docs/design/blender/ballista/validation.json'},
    'build_time_checks': {
        'anchor_contract': 'muzzle plane, bore axis and exposed 0.0210 radius across '
                           'the whole heat band, all four markers, the 0.205 sight '
                           'line, the trigger blade and the bolt handle home position '
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
    'notes': ['Fresh design: no geometry reused from the older PEREGRINE study.',
              'Tapered muzzle with milled brake ports instead of flutes; the heat band stays bare metal.',
              'Markings are modelled geometry, not a texture decal.',
              'The stripper rounds are hidden by the reload choreography; their '
              'authored placement is the contract default only.',
              'Optic glass is alpha-blended and flagged for depthWrite off.'],
}
(DOCS / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({k: manifest[k] for k in ('source_parts', 'batch_nodes', 'triangles')}, indent=2))
print(f'blend={BLEND} bytes={BLEND.stat().st_size}')
print(f'glb={GLB} bytes={GLB.stat().st_size}')
if collisions or floaters:
    raise RuntimeError(f'geometry gate failed: {len(collisions)} coplanar face pairs, '
                       f'{len(floaters)} floating part groups')
if contract_failures:
    raise RuntimeError(f'anchor contract failed: {len(contract_failures)} failures')
