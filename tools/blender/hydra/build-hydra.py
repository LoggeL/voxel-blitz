"""Author HYDRA, an original M134-style rotary gun prop for Voxel Blitz.

Fresh design, built from scratch: no geometry, file or mesh is loaded from the
older PEREGRINE study. Only the low-level authoring technique (closed convex
primitives, analytic planar UVs, shared ImageGen maps) and the frozen runtime
interface (anchors, part nodes, markers) are shared, because the game slot
demands them.

Run headless (the repo's own convention for long Blender work; the MCP bridge
runs the same Blender Python underneath):

    blender --background --factory-startup --python build-hydra.py

or through the live Blender MCP session (protocol 5) on 127.0.0.1:9876:

    from pathlib import Path
    p = Path('.../tools/blender/hydra/build-hydra.py')
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

    muzzle   (0, 0.055, -0.880)    -> y = 0.880, x = 0, z = 0.055
    bore axis x = 0, y = 0.055    -> x = 0, z = 0.055, exposed radius 0.0290
    grip     (0.050, 0.000, -0.10) -> y = 0.100, x = 0.050, z = 0.000
    support  (-0.060, -0.012, -0.47) -> y = 0.470, x = -0.060, z = -0.012
    sight    optical axis 0.155   -> z = 0.155
    breech   minigun -0.340       -> y = 0.340
    trigger  minigun -0.130       -> y = 0.130, blade tip z = -0.020
    bolt home minigun -0.025      -> y = 0.025, handle to -x
    heat band -0.499 .. -0.8382   -> y = 0.499 .. 0.8382

Design intent: a squat M134-style rotary gun. A low enclosed receiver with a
ribbed drive housing carries a static triple barrel bundle on the bore axis
(the runtime spins its own rotor group, so the study bakes the cluster into
the body), clamped by a rear collar and a front collar ring, with three open
muzzle mouths ahead of the front collar. A top cover housing, left-side feed
tray with a climbing ammo chute from a deep belly drum, a left-side carry
handle, post-and-notch iron sights on the 0.155 line, a vertical foregrip at
the support point, and a solid sporter stock close the silhouette. It reads
as the opposite of BALLISTA: low, hungry and rotary, rather than tall, shut
and single-tube.

Geometry is closed convex primitives (no booleans, no negative scales), then
chamfered by a bevel modifier; winding is repaired with recalc_face_normals and
UVs are an analytic per-face projection of the two non-dominant axes so the six
ImageGen maps tile at a constant real-world density. Every joint overlaps
volumetrically by >= 1 mm: butt-jointed flush faces z-fight once same-material
parts merge into one draw call.

Outputs (owned by this task):
    docs/design/blender/hydra/hydra.blend   editable, textures packed
    docs/design/blender/hydra/hydra.glb     portable GLB, images embedded
    docs/design/blender/hydra/manifest.json    machine-readable record
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
DOCS = ROOT / 'docs/design/blender/hydra'
INK = ROOT / 'public/assets/blender/textures'
DOCS.mkdir(parents=True, exist_ok=True)

ASSET = 'HYDRA'
SCENE_NAME = f'{ASSET} | Voxel Blitz minigun study'
UV_SCALE = 3.6  # texture tiles per metre, constant across the whole model
GROUPS = ['body', 'mag', 'bolt', 'trigger', 'extra']

# --- frozen runtime anchors, in Blender authoring space --------------------
MUZZLE = (0.000, 0.880, 0.055)     # game (0.000, 0.055, -0.880)
GRIP = (0.050, 0.100, 0.000)       # game (0.050, 0.000, -0.100)
SUPPORT = (-0.060, 0.470, -0.012)  # game (-0.060, -0.012, -0.470)
SIGHT = (0.000, 0.200, 0.155)      # optical axis, game y = 0.155
MARKERS = {'muzzle': MUZZLE, 'grip': GRIP, 'support': SUPPORT, 'sight': SIGHT}

BORE_X, BORE_Z = 0.000, 0.055   # bore axis
BORE_R = 0.0290                 # exposed bore envelope radius (BARREL_R.minigun - clearance)
BORE_IN = 0.0085                # muzzle mouth recess radius per tube
BORE_START = 0.300              # buried in the receiver
# Triple bundle: three tubes r=TUBE_R at cluster radius CLUSTER_R, 120 degrees
# apart (upper-left, upper-right, bottom: the top centre stays a sight gap).
# Tube envelope is CLUSTER_R + TUBE_R = BORE_R; polygon crowns stop a hair
# short, and a diamond top rib supplies the exact-BORE_R vertex line.
TUBE_R = 0.0135
CLUSTER_R = 0.0155
SPINDLE_R = 0.014
COLLAR_FRONT_Y = 0.850          # front collar centre, clear of the band
COLLAR_REAR_Y = 0.475           # rear collar centre, clear of the band
HEAT_BAND = (0.499, 0.8382)     # -BREACH_Z + heatLen * barrelLen: game z -0.499 .. -0.8382
BREECH_Y = 0.340                # BREACH_Z.minigun -0.34
SIGHT_Z = 0.155                 # body.userData.sightHeight (-adsOffset.y)
SIGHT_REAR_Y = 0.085            # rear notch plane (game z -0.085, cf ironSights rearZ)
SIGHT_FRONT_Y = 0.327           # front post plane (game z -0.327, cf ironSights frontZ)
TRIGGER_Y, TRIGGER_TIP_Z = 0.130, -0.020   # TRIGGER_Z.minigun -0.130
BOLT_HOME_GAME_Z = -0.025       # BOLT_HOME.minigun
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
# M134 two-tone: blackened rotary steel over olive-drab furniture. Gunmetal
# and dark steel reuse the delivered worn-gunmetal map with different multiply
# tints (no new images), so the portable GLB and the runtime stay in agreement
# through baseColorFactor. No optic glass: HYDRA wears iron sights.
MATERIALS = [
    ('gunmetal', 'worn-gunmetal', .55, .38, (.32, .32, .35)),
    ('dark steel', 'worn-gunmetal', .78, .30, (.20, .21, .24)),
    ('olive drab', 'worn-gunmetal', .08, .68, (.66, .66, .53)),
    ('orange paint', 'orange-painted-metal', .12, .50, (.95, .93, .90)),
    ('ivory coating', 'ivory-armor', .04, .45, (.96, .95, .92)),
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


# --- primitive builders ----------------------------------------------------
PARTS = []      # (object, part, material key)
ROUND_OBJECTS = []  # belt-fed slot: no loose rounds; the belt lives in `mag`
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
        obj['hydra_material'] = material
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
    obj['hydra_material'] = material
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
    label['hydra_material'] = material
    label.parent = PART_GROUP[part]
    project_uvs(label.data)
    PARTS.append((label, part, material))
    return label


# ===========================================================================
# BODY: low enclosed receiver, ribbed drive housing, static triple barrel
# bundle with collar rings, top cover, feed tray + ammo chute, foregrip,
# post-and-notch iron sights, left-side carry handle, sporter stock
# ===========================================================================
# Runtime note (read from public/js/guns/models/minigun.js): the game builds
# its own `minigun_rotor` group as a child of `body` and spins it every frame
# (heavy-weapon-animation.js: rotor.rotation.z += dt * spin * 42). The study
# therefore bakes the 3-barrel cluster STATIC into the body node: no separate
# spinning node exists in the GLB, and the body owns every barrel vertex.
# The triple bundle is three tangent tubes (r=0.0136 at cluster radius 0.0154,
# 120 degrees apart) whose outer envelope is exactly BORE_R, so the heat band
# reads as bare metal across its whole span.
# Low enclosed receiver with a tapered bottom-front cut: the mechanism rides
# visibly over the dropping top edge ahead of the breech. The triple bundle
# roots deep inside it; the bolt body hides in the same volume.
add('Main receiver', 'body', 'gunmetal', prism([
    (-0.100, -0.055), (-0.100, 0.075), (0.300, 0.075),
    (0.360, 0.045), (0.360, -0.015), (0.310, -0.045),
    (0.100, -0.060)], .110), bevel=.005)
add('Receiver rear cap', 'body', 'gunmetal', boxv((.100, .014, .110)),
    loc=(0, -0.1045, 0.010), bevel=.002)
# Ribbed electric drive housing slung under the receiver rear, M134-style.
add('Drive housing', 'body', 'dark steel', tube(.060, .160, 20),
    loc=(0, 0.020, 0.008), bevel=.002)
for index, y in enumerate((-0.030, 0.005, 0.040)):
    add(f'Drive cooling rib {index + 1}', 'body', 'dark steel',
        washer(.064, .058, .012, 20), loc=(0, y, 0.008), bevel=0)
# External drive gearbox bulging off the right flank: the offset M134 motor.
add('Drive gearbox', 'body', 'dark steel', tube(.045, .160, 12),
    loc=(0.075, 0.050, -0.010), bevel=.002)
for index, y in enumerate((0.000, 0.100)):
    add(f'Gearbox rib {index + 1}', 'body', 'dark steel',
        washer(.048, .043, .012, 12), loc=(0.075, y, -0.010), bevel=0)
add('Gearbox end boss', 'body', 'gunmetal', tube(.020, .020, 10),
    loc=(0.075, -0.035, -0.010), bevel=0)
# Stepped top cover over the breech, dropping toward the muzzle so it reads
# as furniture rather than a second receiver. Its crown stops 20 mm under
# the sight line so the aim channel stays open; the slope still dives to the
add('Top cover', 'body', 'olive drab', merge_shapes([
    offset(boxv((.070, .160, .045)), dy=0.080, dz=0.1125),
    offset(boxv((.070, .150, .025)), dy=0.235, dz=0.1025),
    offset(prism([(0.310, 0.085), (0.310, 0.112),
                  (0.470, 0.070), (0.470, 0.045)], .070))]), bevel=.003)
for index, y in enumerate((0.050, 0.100)):
    add(f'Cover fin rear {index + 1}', 'body', 'dark steel', boxv((.072, .012, .006)),
        loc=(0, y, 0.1335), bevel=.0015)
for index, y in enumerate((0.200, 0.250)):
    add(f'Cover fin front {index + 1}', 'body', 'dark steel', boxv((.072, .012, .006)),
        loc=(0, y, 0.1135), bevel=.0015)
# Flank furniture, 1+ mm proud or embedded: never flush.
add('Ejection port inset', 'body', 'rubber', boxv((.008, .090, .022)),
    loc=(.055, 0.100, 0.055), bevel=0)
add('Ejection port lip', 'body', 'gunmetal', boxv((.010, .100, .006)),
    loc=(.0565, 0.100, 0.0675), bevel=.0012)
pair('Side armor panel', 'body', 'olive drab', boxv((.005, .170, .045)),
     loc=(.0565, 0.020, 0.010))
add('Safety selector', 'body', 'orange paint', boxv((.012, .028, .010)),
    loc=(-.0575, 0.090, 0.020), bevel=.0015)
add('Heat indicator strip', 'body', 'dark steel', boxv((.006, .100, .014)),
    loc=(.056, 0.022, 0.075), bevel=.0012)
for index, y in enumerate((-0.016, 0.014, 0.044)):
    add(f'Heat cell {index + 1}', 'body', 'orange paint', boxv((.008, .018, .008)),
        loc=(.0575, y, 0.075), bevel=0)
# Static triple barrel bundle on the bore axis: three tubes 120 degrees apart
# around a centre spindle, merged into ONE mesh so the whole cluster is the
# bore object the heat-band gate reasons about. Polygon tube crowns stop a
# hair short of the envelope, so a diamond-section top rib (a square bar spun
# 45 degrees about the bore) runs the bundle length with its crown vertex
# line exactly on BORE_R; its root stays buried in the tubes and spindle.
# (tube_stacked bakes BORE_Z into its rings; boxv/washer shapes do not.)
_ANGLES120 = (math.pi / 6, 5 * math.pi / 6, 3 * math.pi / 2)
_TUBES = [(CLUSTER_R * math.cos(a), CLUSTER_R * math.sin(a)) for a in _ANGLES120]
_BUNDLE = [offset(tube_stacked(TUBE_R, BORE_START, MUZZLE[1], step=0.02, segments=20),
                  dx=cx, dz=cz)
           for (cx, cz) in _TUBES]
_BUNDLE.append(offset(tube(SPINDLE_R, MUZZLE[1] - BORE_START - 0.004, 16),
                      dy=(BORE_START + MUZZLE[1] - 0.004) / 2, dz=BORE_Z))
_RIB_WIDTH = 0.017
_RIB_DIAG = _RIB_WIDTH / math.sqrt(2)
_RIB = boxv((_RIB_WIDTH, MUZZLE[1] - BORE_START, _RIB_WIDTH))
_RIB = ([((x - z) / math.sqrt(2), y, (x + z) / math.sqrt(2)) for (x, y, z) in _RIB[0]],
        _RIB[1])
_BUNDLE.append(offset(_RIB, dy=(BORE_START + MUZZLE[1]) / 2,
                      dz=BORE_Z + BORE_R - _RIB_DIAG))
BORE_OBJECT = add('Rotor barrel bundle', 'body', 'gunmetal', merge_shapes(_BUNDLE),
                   loc=(BORE_X, 0, 0), bevel=0)
# Dark mouth discs recessed 1.5 mm behind each tube cap, template-style.
for index, (cx, cz) in enumerate(_TUBES):
    add(f'Muzzle mouth {index + 1}', 'body', 'rubber', tube(BORE_IN, .002, 16),
        loc=(BORE_X + cx, MUZZLE[1] - 0.0015, BORE_Z + cz), bevel=0)
# Per-tube brake collars just ahead of the heat band (band ends at 0.8382),
# merged into one object so their shared end planes never audit against
# each other.
_BRAKES = [offset(washer(0.0175, 0.0130, 0.018, 16), dx=cx, dy=0.854, dz=cz)
           for (cx, cz) in _TUBES]
add('Muzzle brakes', 'body', 'dark steel', merge_shapes(_BRAKES),
    loc=(BORE_X, 0, BORE_Z), bevel=0)
# Faceted rotor housing shrouding the bundle root: the round M134 core the
# rectangular receiver otherwise hides. Ends clear of the heat band.
add('Rotor housing', 'body', 'gunmetal', tube(.055, .100, 12),
    loc=(BORE_X, 0.412, BORE_Z), bevel=.002)
for index, y in enumerate((0.378, 0.446)):
    add(f'Housing ring {index + 1}', 'body', 'dark steel',
        washer(.059, .054, .012, 12), loc=(BORE_X, y, BORE_Z), bevel=0)
# Faceted transition flange stepping the boxy receiver front down to the
add('Receiver flange', 'body', 'dark steel', washer(.075, .056, .030, 12),
    loc=(BORE_X, 0.356, BORE_Z), bevel=0)
# Diamond chamfer bars on the receiver's front vertical edges, merged into
# one object. (Top rails were cut: they read as decoration, not structure.)
_ZBARS = boxv((.020, .020, .055))
_ZBARS = ([((x - y) / math.sqrt(2), (x + y) / math.sqrt(2), z)
           for (x, y, z) in _ZBARS[0]], _ZBARS[1])
_CHAMFERS = [offset(_ZBARS, dx=sx * 0.055, dy=0.360, dz=0.012) for sx in (-1, 1)]
add('Receiver chamfers', 'body', 'dark steel', merge_shapes(_CHAMFERS),
    loc=(0, 0, 0), bevel=0)
# their shared planes never audit against each other.
_LUGS = []
for _cy in (COLLAR_REAR_Y, COLLAR_FRONT_Y):
    for _a in (math.pi / 6, 5 * math.pi / 6, 3 * math.pi / 2):
        _LUGS.append(offset(boxv((.012, .018, .012)),
                           dx=0.033 * math.cos(_a), dy=_cy,
                           dz=0.033 * math.sin(_a)))
add('Collar lugs', 'body', 'gunmetal', merge_shapes(_LUGS),
    loc=(BORE_X, 0, BORE_Z), bevel=.0015)
add('Front collar ring', 'body', 'dark steel', washer(.034, .028, .016, 20),
    loc=(BORE_X, COLLAR_FRONT_Y, BORE_Z), bevel=0)
add('Front collar band', 'body', 'orange paint', washer(.0345, .0335, .006, 20),
    loc=(BORE_X, COLLAR_FRONT_Y, BORE_Z), bevel=0)
# Rear clamp collar (band starts at 0.499).
add('Rear collar', 'body', 'dark steel', washer(.036, .028, .020, 20),
    loc=(BORE_X, COLLAR_REAR_Y, BORE_Z), bevel=0)
add('Rear collar band', 'body', 'orange paint', washer(.0365, .0355, .008, 20),
    loc=(BORE_X, COLLAR_REAR_Y, BORE_Z), bevel=0)
# Feed tray as an open notch: rear block, full-height side walls and a low
# front lip leave a genuine U-shaped mouth (open above the lip, backed by the
# rear block) that the ladder visibly plugs into. Merged into one object.
add('Feed cover open', 'body', 'olive drab', boxv((.055, .012, .060)),
    loc=(-0.075, 0.352, 0.115), bevel=.002)
add('Feed cover latch', 'body', 'orange paint', boxv((.020, .014, .010)),
    loc=(-0.075, 0.352, 0.148), bevel=.0015)

add('Feed tray', 'body', 'dark steel', merge_shapes([
    offset(boxv((.044, .040, .030)), dx=-0.076, dy=0.330, dz=0.075),
    offset(boxv((.008, .100, .030)), dx=-0.097, dy=0.300, dz=0.075),
    offset(boxv((.008, .100, .030)), dx=-0.055, dy=0.300, dz=0.075),
    offset(boxv((.035, .040, .010)), dx=-0.076, dy=0.265, dz=0.060)]), bevel=.002)
_CHUTE = [(-0.093, 0.190, -0.095), (-0.092, 0.205, -0.075),
          (-0.090, 0.225, -0.045), (-0.088, 0.245, -0.015),
          (-0.085, 0.265, 0.015), (-0.0805, 0.285, 0.045),
          (-0.0765, 0.300, 0.065)]
_RAILS, _STRAPS, _ROUNDS = [], [], []
for (x, y, z) in _CHUTE:
    _RAILS.append(offset(boxv((.006, .012, .016)), dx=x - 0.017, dy=y, dz=z))
    _RAILS.append(offset(boxv((.006, .012, .016)), dx=x + 0.017, dy=y, dz=z))
    _STRAPS.append(offset(boxv((.030, .020, .028)), dx=x, dy=y - 0.009, dz=z))
    _ROUNDS.append(offset(tube(.0105, .034, 10), dx=x, dy=y + 0.0065, dz=z))
# Rails, straps and the cavity mouth merge into ONE tan ladder (unbeveled:
# exact authored planes), so neighboring stations never audit against each
# ladder plane. Cavity floor sits 3.5 mm under the rim step.
_CAVITY = [
    offset(boxv((.052, .006, .006)), dx=-0.0755, dy=0.289, dz=0.089),
    offset(boxv((.052, .006, .006)), dx=-0.0755, dy=0.341, dz=0.089),
    offset(boxv((.006, .054, .006)), dx=-0.099, dy=0.315, dz=0.089),
    offset(boxv((.006, .054, .006)), dx=-0.053, dy=0.315, dz=0.089)]
add('Belt ladder', 'mag', 'tan webbing', merge_shapes(_RAILS + _STRAPS + _CAVITY), bevel=0)
add('Belt rounds', 'mag', 'orange paint', merge_shapes(_ROUNDS),
    loc=(0, 0, 0), bevel=0)
# ===========================================================================
add('Ammo drum', 'mag', 'olive drab', tube(.112, .170, 24),
    loc=(0.002, 0.225, -0.154), bevel=.002)
for index, y in enumerate((0.146, 0.304)):
    add(f'Drum band {index + 1}', 'mag', 'dark steel', tube(.116, .018, 24),
        loc=(0.002, y, -0.154), bevel=.0015)
add('Drum axle', 'mag', 'dark steel', tube(.030, .190, 16),
    loc=(0.002, 0.225, -0.154), bevel=0)
add('Drum hub cap', 'mag', 'dark steel', tube(.032, .012, 16),
    loc=(0.002, 0.322, -0.154), bevel=0)
add('Drum ammo window', 'mag', 'tan webbing', boxv((.050, .060, .004)),
    loc=(0.002, 0.225, -0.0405), bevel=.0015)
add('Drum ammo stripe', 'mag', 'orange paint', boxv((.052, .010, .004)),
    loc=(0.002, 0.225, -0.0400), bevel=0)

# ===========================================================================
# BOLT and TRIGGER: the two small moving owners
# ===========================================================================
add('Bolt body', 'bolt', 'gunmetal', tube(.0135, .180, 12), loc=(0, 0.000, 0.058))
add('Bolt body collar', 'bolt', 'gunmetal', tube(.0165, .012, 12), loc=(0, 0.060, 0.058))
add('Feed throat', 'body', 'rubber', boxv((.036, .030, .020)),
    loc=(-0.070, 0.335, 0.0435), bevel=.002)
add('Bolt handle root', 'bolt', 'gunmetal', tube(.016, .014, 10, axis='X'),
    loc=(-0.058, BOLT_HOME_Y, 0.058))
add('Bolt handle arm', 'bolt', 'gunmetal', boxv((.050, .014, .016)),
    loc=(-0.085, BOLT_HOME_Y, 0.058), bevel=.003)
BOLT_KNOB_OBJECT = add('Bolt knob', 'bolt', 'gunmetal',
                       taper(.013, .005, 0.0, 0.030, 12),
                       loc=(-0.108, BOLT_HOME_Y, 0.058), rot=(0, 0, math.pi / 2), bevel=0)
add('Bolt knob collar', 'bolt', 'gunmetal', washer(.0135, .011, .004, 10, axis='X'),
    loc=(-0.109, BOLT_HOME_Y, 0.058), bevel=0)

TRIGGER_OBJECT = add('Trigger blade', 'trigger', 'gunmetal', boxv((.010, .014, .024)),
                     loc=(0, TRIGGER_Y, -0.006967), rot=(math.radians(10), 0, 0), bevel=.002)
# Raked pistol grip wrapping the grip marker; the x = 0.050 palm sits just
# outboard of the half-width 0.030 panel.
add('Pistol grip', 'body', 'olive drab', prism([
    (0.160, 0.005), (0.100, 0.005), (0.055, -0.050), (0.045, -0.115),
    (0.100, -0.120), (0.130, -0.055)], .060), bevel=.008)
for index, (y, z) in enumerate(((0.115, -0.0875), (0.150, -0.015))):
    add(f'Grip finger rib {index + 1}', 'body', 'gunmetal', boxv((.062, .010, .010)),
        loc=(0, y, z), bevel=.002)
add('Grip base cap', 'body', 'dark steel', boxv((.063, .060, .012)),
    loc=(0, 0.073, -0.120), rot=(math.radians(-7), 0, 0), bevel=.003)

# Fore-end beam and vertical foregrip at the support marker. The beam caps at
# y = 0.495, 4 mm shy of the heat band; the grip hangs below it.
add('Fore-end beam', 'body', 'olive drab', boxv((.070, .240, .052)),
    loc=(0, 0.375, -0.004), bevel=.002)
add('Vertical foregrip', 'body', 'rubber', prism([
    (0.425, -0.020), (0.475, -0.020), (0.485, -0.100),
    (0.435, -0.115), (0.415, -0.060)], .045),
    loc=(-0.020, 0, 0), bevel=.006)
add('Foregrip base cap', 'body', 'dark steel', boxv((.047, .055, .014)),
    loc=(-0.020, 0.4525, -0.112), bevel=.002)

# Post-and-notch iron sights on the 0.155 line. Rear notch sits on the top
# cover; the front post rides a riser clamped between the upper tubes, ahead
# of the receiver but behind the heat band (game frontZ -0.327 -> y = 0.327).
add('Rear sight base', 'body', 'dark steel', boxv((.036, .030, .012)),
    loc=(0, SIGHT_REAR_Y, 0.138), bevel=.0015)
pair('Rear sight ear', 'body', 'gunmetal', boxv((.006, .020, .024)),
     loc=(.013, SIGHT_REAR_Y, 0.150), bevel=.0012)
add('Front sight riser', 'body', 'dark steel', boxv((.024, .024, .080)),
    loc=(0, SIGHT_FRONT_Y, 0.090), bevel=.0015)
add('Front sight block', 'body', 'dark steel', boxv((.030, .030, .014)),
    loc=(0, SIGHT_FRONT_Y, 0.132), bevel=.0015)
add('Front sight post', 'body', 'gunmetal', boxv((.006, .012, .020)),
    loc=(0, SIGHT_FRONT_Y, 0.146), bevel=0)
pair('Front sight wing', 'body', 'gunmetal', boxv((.006, .020, .022)),
     loc=(.014, SIGHT_FRONT_Y, 0.144), bevel=.0012)

# Left-side carry handle, outboard of the rotor like the runtime rig, leaving
# the aim channel over the top cover open.
for z in (0.080, 0.280):
    add(f'Handle post {z}', 'body', 'dark steel', boxv((.024, .020, .060)),
        loc=(-0.069, z, 0.075), bevel=.0015)
add('Carry handle bar', 'body', 'olive drab', boxv((.028, .240, .026)),
    loc=(-0.065, 0.180, 0.115), bevel=.003)
for index, y in enumerate((0.130, 0.167, 0.204)):
    add(f'Handle grip rib {index + 1}', 'body', 'rubber', boxv((.026, .012, .028)),
        loc=(-0.065, y, 0.115), bevel=.0015)

# Solid sporter stock closing the rear: spine, toe, web and plate merged into
# one form so their shared planes never audit against each other, capped by
# the recoil pad.
add('Stock body', 'body', 'olive drab', merge_shapes([
    offset(boxv((.042, .204, .055)), dy=-0.198, dz=0.025),
    offset(boxv((.038, .190, .040)), dy=-0.205, dz=-0.045),
    offset(boxv((.038, .190, .030)), dy=-0.205, dz=-0.015),
    offset(boxv((.046, .016, .130)), dy=-0.305, dz=-0.010)]), bevel=.004)
add('Recoil pad', 'body', 'rubber', boxv((.048, .014, .110)),
    loc=(0, -0.318, -0.009), bevel=.006)
add('Cheek riser', 'body', 'olive drab', boxv((.036, .120, .012)),
    loc=(0, -0.210, 0.058), bevel=.002)
# Identity markings, modelled as geometry on the receiver flanks.
add_text('HYDRA', 'Marking HYDRA left', 'body', 'ivory coating',
         (-0.0545, 0.150, 0.030), (math.pi / 2, 0, -math.pi / 2), .014)
add_text('HYDRA', 'Marking HYDRA right', 'body', 'ivory coating',
         (0.0545, 0.150, 0.030), (math.pi / 2, 0, math.pi / 2), .014)
add_text('VB 134', 'Marking VB 134 left', 'body', 'ivory coating',
         (-0.0545, -0.040, 0.020), (math.pi / 2, 0, -math.pi / 2), .010)
add_text('VB 134', 'Marking VB 134 right', 'body', 'ivory coating',
         (0.0545, -0.040, 0.020), (math.pi / 2, 0, math.pi / 2), .010)

# ===========================================================================
# EXTRA: belt-fed slot. The runtime (models/minigun.js) registers no
# extra.userData.cartridges for the minigun — the belt lives in `mag` and the
# reload choreography hinges the feed cover — so `extra` ships empty at
# identity, exactly like the runtime group before attachments mount.
# ===========================================================================



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

for (key, value) in {'asset_id': 'hydra',
                     'asset_name': 'HYDRA',
                     'game_forward': '-Z after glTF export',
                     'sight_height': SIGHT_Z,
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
tip_plane = sorted({round(p[1], 9) for (p, n) in points if n == bore_object.name and p[1] > 0.872})
trigger_object = TRIGGER_OBJECT
trigger_low = min((trigger_object.matrix_world @ v.co)[2] for v in trigger_object.data.vertices)
bolt_handle = BOLT_KNOB_OBJECT
knob_far = min((bolt_handle.matrix_world @ v.co)[0] for v in bolt_handle.data.vertices)
sight_base = (SIGHT_REAR_Y, SIGHT_FRONT_Y)

CONTRACT = [
    ('muzzle_forward_vertex_y', tip[1], MUZZLE[1], 1e-6),
    ('muzzle_marker', MUZZLE[1], 0.880, 1e-9),
    ('bore_axis_x', bore_x, BORE_X, 1e-9),
    ('bore_axis_z', bore_z, BORE_Z, 1e-9),
    ('exposed_bore_radius_in_heat_band', band_radius, BORE_R, 1e-6),
    ('grip_marker_x', GRIP[0], 0.050, 1e-9),
    ('grip_marker_y', GRIP[1], 0.100, 1e-9),
    ('grip_marker_z', GRIP[2], 0.000, 1e-9),
    ('support_marker_x', SUPPORT[0], -0.060, 1e-9),
    ('support_marker_y', SUPPORT[1], 0.470, 1e-9),
    ('support_marker_z', SUPPORT[2], -0.012, 1e-9),
    ('sight_axis_z', SIGHT[2], SIGHT_Z, 1e-9),
    ('trigger_blade_y', TRIGGER_Y, 0.130, 1e-9),
    ('trigger_blade_tip_z', trigger_low, TRIGGER_TIP_Z, 1e-6),
    ('bolt_handle_home_y', BOLT_HOME_Y, -BOLT_HOME_GAME_Z, 1e-9),
    ('bolt_knob_reach_x', knob_far, None, None),
    ('rear_sight_plane_y', sight_base[0], SIGHT_REAR_Y, 1e-9),
    ('front_sight_plane_y', sight_base[1], SIGHT_FRONT_Y, 1e-9),
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
BLEND = DOCS / 'hydra.blend'
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
CONTACT_ANCHOR = 'Main receiver'


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

GLB = DOCS / 'hydra.glb'
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
            node.setdefault('extras', {})['blenderAsset'] = 'hydra'
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
    'asset': 'HYDRA',
    'asset_id': 'hydra',
    'kind': 'original M134-style rotary gun prop (visual game asset)',
    'blender': bpy.app.version_string,
    'authoring_script': 'tools/blender/hydra/build-hydra.py',
    'source_parts': len(PARTS),
    'animation_group_nodes': GROUPS,
    'marker_nodes': sorted(MARKERS),
    'batch_nodes': len(batches),
    'round_nodes': [obj.name for obj in round_objects],
    'triangles': triangles,
    'triangles_per_primitive': per_primitive,
    'materials': [m[0] for m in MATERIALS],
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
                        'exposed_bore': [0.360, MUZZLE[1]],
                        'heat_band': [-HEAT_BAND[1], -HEAT_BAND[0]],
                        'sight_height': SIGHT_Z,
                        'sight_planes': [-SIGHT_REAR_Y, -SIGHT_FRONT_Y]},
    'files': {'blend': 'docs/design/blender/hydra/hydra.blend',
              'glb': 'docs/design/blender/hydra/hydra.glb',
              'renders': ['render-hero.png', 'render-side.png', 'render-left.png',
                          'render-ads.png', 'render-rear.png'],
              'validation': 'docs/design/blender/hydra/validation.json'},
    'build_time_checks': {
        'anchor_contract': 'muzzle plane, bore axis and exposed 0.0290 envelope across '
                           'the whole heat band, all four markers, the 0.155 sight '
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
    'notes': ['Fresh design: no geometry reused from older studies.',
              'Static triple barrel bundle baked into the body node: the runtime '
              'spins its own minigun_rotor group, so the GLB carries no rotor.',
              'Markings are modelled geometry, not a texture decal.',
              'Belt-fed slot: the belt links and drum live in the mag group and '
              'extra ships empty; no cartridges are registered for the minigun.',
              'Iron sights only: no optic glass on this asset.'],
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
