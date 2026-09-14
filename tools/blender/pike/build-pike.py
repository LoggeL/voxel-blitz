"""Author PIKE, an original twin-rail charge lance prop for Voxel Blitz.
Fresh design, built from scratch: no geometry, file or mesh is loaded from the
older BALLISTA study. Only the low-level authoring technique (closed convex
primitives, analytic planar UVs, shared ImageGen maps) and the frozen runtime
interface (anchors, part nodes, markers) are shared, because the game slot
demands them.
Run headless (the repo's own convention for long Blender work; the MCP bridge
runs the same Blender Python underneath):
    blender --background --factory-startup --python build-pike.py
or through the live Blender MCP session (protocol 5) on 127.0.0.1:9876:
    from pathlib import Path
    p = Path('.../tools/blender/pike/build-pike.py')
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
    muzzle   (0, 0.055, -0.720)   -> y = 0.720, x = 0, z = 0.055
    bore axis x = 0, y = 0.055    -> x = 0, z = 0.055, exposed radius 0.0195
    grip     (0.045, 0.015, -0.10)-> y = 0.100, x = 0.045, z = 0.015
    support  (-0.055, 0.005, -0.42) -> y = 0.420, x = -0.055, z = 0.005
    sight    optical axis 0.155   -> z = 0.155
    breech   lance -0.300         -> y = 0.300
    trigger  lance -0.140         -> y = 0.140, blade tip z = -0.020
    bolt home lance -0.032        -> y = 0.032, handle to -x
    heat band -0.447 .. -0.678    -> y = 0.447 .. 0.678
Design intent: a long thin twin-rail charge lance. A slim stepped receiver
feeds a compact capacitor-bank shroud with two exposed violet arc cells; ahead
of the bank an open rail lane leaves the bore bare across the whole heat band,
flanked by long thin conductor rails and crowned by a floating emissive spine
strip; a four-tine emitter cage closes the tip; an angled foregrip cups the
support palm; a slim buffer-tube stock with cheek riser and buttpad finishes
the rear; a rail optic (rear aperture + glowing front post) frames the 0.155
sight line. It reads as the opposite of HALO: a pike, not a DMR — longer,
thinner, violet-veined and caged at the tip.
Geometry is closed convex primitives (no booleans, no negative scales), then
chamfered by a bevel modifier; winding is repaired with recalc_face_normals and
UVs are an analytic per-face projection of the two non-dominant axes so the six
ImageGen maps tile at a constant real-world density. Every joint overlaps
volumetrically by >= 1 mm: butt-jointed flush faces z-fight once same-material
parts merge into one draw call.
Outputs (owned by this task):
    docs/design/blender/pike/pike.blend   editable, textures packed
    docs/design/blender/pike/pike.glb     portable GLB, images embedded
    docs/design/blender/pike/manifest.json    machine-readable record
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
DOCS = ROOT / 'docs/design/blender/pike'
INK = ROOT / 'public/assets/blender/textures'
DOCS.mkdir(parents=True, exist_ok=True)

ASSET = 'PIKE'
SCENE_NAME = f'{ASSET} | Voxel Blitz rail-lance study'
UV_SCALE = 3.6  # texture tiles per metre, constant across the whole model
GROUPS = ['body', 'mag', 'bolt', 'trigger', 'factory-optic', 'extra']

# --- frozen runtime anchors, in Blender authoring space --------------------
MUZZLE = (0.000, 0.720, 0.055)     # game (0.000, 0.055, -0.720)
GRIP = (0.045, 0.100, 0.015)       # game (0.045, 0.015, -0.100)
SUPPORT = (-0.055, 0.420, 0.005)   # game (-0.055, 0.005, -0.420)
SIGHT = (0.000, 0.100, 0.155)      # optical axis, game y = 0.155
MARKERS = {'muzzle': MUZZLE, 'grip': GRIP, 'support': SUPPORT, 'sight': SIGHT}
BORE_X, BORE_Z = 0.000, 0.055   # bore axis
BORE_R = 0.0195                  # exposed bore radius (BARREL_R.lance - 0.0005)
BORE_IN = 0.0080                 # muzzle mouth recess radius
BORE_START = 0.250               # buried in the receiver
SHROUD_END = 0.400               # arc bank ends: open rail lane begins
HEAT_BAND = (0.4470, 0.6780)     # game z -0.447 .. -0.678
BREECH_Y = 0.300                 # BREACH_Z.lance -0.30
OPTIC_Z = 0.155                  # body.userData.sightHeight
REAR_SIGHT_Y = -0.060            # rear aperture plane, game z +0.060
FRONT_SIGHT_Y = 0.692            # front post plane, game z -0.692
TRIGGER_Y, TRIGGER_TIP_Z = 0.140, -0.020   # TRIGGER_Z.lance -0.140
BOLT_HOME_GAME_Z = -0.032        # BOLT_HOME.lance
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
# Rail-lance two-tone: dark polymer furniture over blackened gunmetal, bright
# conductor rails, rubber grips. Both dark metals reuse the delivered
# worn-gunmetal map with different multiply tints (no new images), so the
# portable GLB and the runtime stay in agreement through baseColorFactor.
MATERIALS = [
    ('gunmetal', 'worn-gunmetal', .55, .38, (.32, .33, .36)),
    ('blued steel', 'worn-gunmetal', .70, .30, (.55, .58, .63)),
    ('copper rail', 'orange-painted-metal', 1.0, 1.0, (.09, .055, .035)),
    ('dark marking', 'ivory-armor', .60, .50, (.45, .47, .52)),
    ('dark polymer', 'petrol-ballistic-fabric', 0, .80, (.18, .19, .22)),
    ('rubber', 'worn-rubber', 0, .90, (.28, .29, .31)),
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

arc = bpy.data.materials.new(f'{ASSET} | arc glow')
arc.use_nodes = True
absdf = arc.node_tree.nodes['Principled BSDF']
absdf.inputs['Base Color'].default_value = (0.10, 0.05, 0.16, 1)
absdf.inputs['Metallic'].default_value = 0
absdf.inputs['Roughness'].default_value = 0.35
absdf.inputs['Emission Color'].default_value = (0.45, 0.25, 1.0, 1)
absdf.inputs['Emission Strength'].default_value = 2.5
arc['glass'] = False
arc['emissive_coil'] = True
mats['arc glow'] = arc

# --- primitive builders ----------------------------------------------------
PARTS = []      # (object, part, material key)
ROUND_OBJECTS = []  # lance reloads swap the cell: no loose rounds, each its own node
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
        obj['pike_material'] = material
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
    obj['pike_material'] = material
    obj['round'] = True
    obj.parent = PART_GROUP[part]
    obj.location = loc
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
    label['pike_material'] = material
    label.parent = PART_GROUP[part]
    project_uvs(label.data)
    PARTS.append((label, part, material))

# ===========================================================================
# BODY: slim stepped receiver, compact arc-cell shroud, open twin-rail lane,
# floating emissive spine, four-tine emitter cage, angled foregrip, slim stock
# ===========================================================================
# Slim stepped receiver, longer and lower than a DMR's. The charging sled rides
# on its top face; the bore passes through the upper half into the arc bank.
add('Pike receiver', 'body', 'dark polymer', prism([
    (-0.070, -0.018), (-0.070, 0.026), (0.230, 0.026),
    (0.270, 0.006), (0.270, -0.020), (0.030, -0.034)], .080), bevel=.005)
pair('Receiver side plate', 'body', 'gunmetal', boxv((.008, .220, .046)),
     loc=(.042, 0.080, 0.000), bevel=.002)
add('Charge port cover', 'body', 'blued steel', boxv((.008, .064, .026)),
    loc=(.0435, 0.175, -0.002), bevel=.002)
add('Status strip', 'body', 'arc glow', boxv((.008, .046, .008)),
    loc=(-.045, 0.165, 0.008), bevel=0)
for index, y in enumerate((0.090, 0.220)):
    add(f'Receiver pin {index + 1}', 'body', 'copper rail', tube(.006, .088, 8, axis='X'),
        loc=(0, y, -0.008), bevel=0)
# Lance bore: bare gunmetal of exactly 0.0195 across the whole heat
# band, tapering to 0.0150 ahead of it; the tip face lands exactly on y=0.720.
BORE_OBJECT = add('Lance bore', 'body', 'gunmetal', merge_shapes([
    tube_stacked(BORE_R, BORE_START, HEAT_BAND[1], segments=28),
    tube_stacked(BORE_R, HEAT_BAND[1], MUZZLE[1], step=0.01, radius1=0.0150, segments=28)]),
    loc=(BORE_X, 0, 0), bevel=0)
add('Bore breech collar', 'body', 'gunmetal', tube(.023, .010, 16),
    loc=(BORE_X, 0.246, BORE_Z))
add('Bore guide block', 'body', 'gunmetal', boxv((.034, .056, .024)),
    loc=(0, 0.246, 0.026), bevel=.002)
# Compact arc bank: a low beam overlapping the receiver nose carries the root
# yoke, two exposed violet arc cells and the glow slits; the side fins vent it.
add('Arc bank beam', 'body', 'dark polymer', boxv((.066, .140, .060)),
    loc=(0, 0.330, 0.020), bevel=.002)
add('Rail root yoke', 'body', 'rubber', boxv((.124, .024, .052)),
    loc=(0, 0.292, 0.036), bevel=.002)
for index, y in enumerate((0.312, 0.356)):
    add(f'Arc cell {index + 1}', 'body', 'arc glow', tube(.030, .034, 24),
        loc=(0, y, BORE_Z), bevel=.0015)
    add(f'Arc cell separator {index + 1}', 'body', 'rubber',
        washer(.0315, .0295, .006, 20), loc=(0, y, BORE_Z), bevel=0)
    add(f'Arc cell end ring {index + 1}', 'body', 'copper rail',
        washer(.0318, .0285, .007, 20), loc=(0, y + 0.0195, BORE_Z), bevel=0)
pair('Bank glow slit', 'body', 'arc glow', boxv((.006, .088, .010)),
     loc=(.0335, 0.330, 0.030), bevel=0)
for index, y in enumerate((0.312, 0.345, 0.378)):
    pair(f'Bank vent fin {index + 1}', 'body', 'rubber', boxv((.010, .008, .020)),
         loc=(.034, y, 0.012), bevel=0)
# Long thin twin cage rails at bore height, outboard of the body on three
# stand-offs: the near rail reads as an unbroken copper line in side profile,
# with a violet energy strip set into its inner face. Both stop short of the
# heat band, which stays bare bore, landing in the aft anchors and the yokes.
pair('Cage rail', 'body', 'copper rail', tube(.007, .460, 12),
     loc=(.042, 0.210, 0.055), bevel=0)
pair('Cage energy strip', 'body', 'arc glow', boxv((.004, .270, .008)),
     loc=(.0345, 0.200, 0.055), bevel=0)
pair('Rail aft anchor', 'body', 'rubber', boxv((.020, .024, .047)),
     loc=(.043, -0.016, 0.0435), bevel=.0015)
for index, y in enumerate((0.044, 0.196, 0.340)):
    pair(f'Rail stand-off {index + 1}', 'body', 'gunmetal', boxv((.024, .020, .040)),
         loc=(.040, y, 0.040), bevel=.0015)
add('Rail fore yoke', 'body', 'rubber', boxv((.124, .024, .048)),
    loc=(0, 0.402, 0.030), bevel=.002)
add('Rail convergence collar', 'body', 'copper rail', washer(.034, .020, .012, 16),
    loc=(0, 0.688, BORE_Z), bevel=0)
# Floating emissive spine above the lane on one riser aft and the collar fore;
# the riser stops 2 mm short of the heat band so the lane itself stays bare.
add('Arc spine', 'body', 'arc glow', boxv((.010, .267, .008)),
    loc=(0, 0.5585, 0.082), bevel=0)
add('Spine riser', 'body', 'gunmetal', boxv((.018, .025, .034)),
    loc=(0, 0.4325, 0.064), bevel=.0015)
# Low picatinny spine across the receiver on two short risers; the tall iron
# sights stand on it and frame the 0.155 line above.
add('Spine rail bar', 'body', 'gunmetal', boxv((.030, .230, .012)),
    loc=(0, 0.038, 0.094), bevel=.0015)
for index, y in enumerate((-0.060, 0.120)):
    add(f'Spine post {index + 1}', 'body', 'gunmetal', boxv((.026, .036, .062)),
        loc=(0, y, 0.059), bevel=.002)
for index, y in enumerate((-0.060, 0.000, 0.060, 0.120)):
    add(f'Spine rib {index + 1}', 'body', 'blued steel', boxv((.040, .014, .006)),
        loc=(0, y, 0.100), bevel=0)
# Eight-tine copper emitter cage entirely fore of the heat band, continuing the
# rail lines into the tip: straight plus diagonal tines land in the collar aft
# and the tip ring fore; the tapered bore tip stands proud with a recessed dark
# mouth exactly on y=0.720.
add('Emitter tine top', 'body', 'copper rail', boxv((.009, .036, .009)),
    loc=(0, 0.698, 0.079), bevel=0)
add('Emitter tine bottom', 'body', 'copper rail', boxv((.009, .036, .009)),
    loc=(0, 0.698, 0.031), bevel=0)
pair('Emitter tine side', 'body', 'copper rail', boxv((.009, .036, .009)),
     loc=(.024, 0.698, BORE_Z), bevel=0)
pair('Emitter tine diagonal upper', 'body', 'copper rail', boxv((.006, .038, .006)),
     loc=(.017, 0.700, 0.072), bevel=0)
pair('Emitter tine diagonal lower', 'body', 'copper rail', boxv((.006, .038, .006)),
     loc=(.017, 0.700, 0.038), bevel=0)
add('Emitter tip ring', 'body', 'gunmetal', washer(.026, .018, .012, 16),
    loc=(BORE_X, 0.712, BORE_Z), bevel=0)
add('Emitter mouth', 'body', 'rubber', tube(.010, .003, 12),
    loc=(BORE_X, 0.7175, BORE_Z), bevel=0)
# Steep raking pistol grip wrapping the grip marker; side panels stand proud.
add('Pistol grip', 'body', 'dark polymer', prism([
    (0.165, 0.012), (0.080, 0.012), (0.048, -0.058), (0.044, -0.122),
    (0.102, -0.130), (0.132, -0.052)], .058), bevel=.008)
pair('Grip side panel', 'body', 'rubber', boxv((.004, .066, .046)),
     loc=(.030, 0.095, -0.048), bevel=.002)
for index, (y, z) in enumerate(((0.112, -0.045), (0.128, -0.030))):
    add(f'Grip finger rib {index + 1}', 'body', 'rubber', boxv((.062, .010, .010)),
        loc=(0, y, z), bevel=.002)
add('Grip base cap', 'body', 'gunmetal', boxv((.060, .056, .012)),
    loc=(0, 0.073, -0.132), rot=(math.radians(-7), 0, 0), bevel=.003)
# Angled foregrip under the bank nose, its top face exactly on the support
# marker height; the support palm cups it from outboard.
add('Foregrip', 'body', 'dark polymer', boxv((.048, .036, .100)),
    loc=(0, 0.412, -0.045), rot=(math.radians(9), 0, 0), bevel=.003)
for index, z in enumerate((-0.052, -0.068, -0.084)):
    add(f'Foregrip rib {index + 1}', 'body', 'rubber', boxv((.052, .008, .010)),
        loc=(0, 0.420, z), bevel=.0015)
pair('Foregrip palm swell', 'body', 'rubber', boxv((.010, .030, .050)),
     loc=(.027, 0.426, -0.050), bevel=.003)
# Slim buffer-tube stock: the tube alone ties the tapered body back to the
# receiver, with a cheek riser on two posts and a rubber buttpad.
add('Buffer tube', 'body', 'blued steel', tube(.016, .200, 12),
    loc=(0, -0.150, 0.036), bevel=0)
add('Stock body', 'body', 'dark polymer', prism([
    (-0.100, 0.052), (-0.100, 0.000), (-0.250, -0.040),
    (-0.245, 0.012)], .050), bevel=.004)
pair('Riser post', 'body', 'gunmetal', boxv((.010, .014, .030)),
     loc=(.015, -0.170, 0.042), bevel=.0015)
add('Cheek riser', 'body', 'dark polymer', boxv((.044, .110, .014)),
    loc=(0, -0.170, 0.058), bevel=.003)
add('Buttplate', 'body', 'dark polymer', boxv((.052, .014, .110)),
    loc=(0, -0.256, 0.000), bevel=.003)
add('Recoil pad', 'body', 'rubber', boxv((.054, .014, .100)),
    loc=(0, -0.268, -0.002), bevel=.004)
add('QD socket', 'body', 'blued steel', tube(.007, .012, 8, axis='X'),
    loc=(-0.024, -0.150, -0.010))
# Identity markings, modelled as geometry on the receiver flanks.
add_text(ASSET, 'Marking PIKE left', 'body', 'dark marking',
         (-0.0465, 0.080, 0.000), (math.pi / 2, 0, -math.pi / 2), .0105)
add_text(ASSET, 'Marking PIKE right', 'body', 'dark marking',
         (0.0465, 0.080, 0.000), (math.pi / 2, 0, math.pi / 2), .0105)
add_text('CL-9', 'Marking CL-9 left', 'body', 'dark marking',
         (-0.0465, -0.005, 0.000), (math.pi / 2, 0, -math.pi / 2), .009)
add_text('CL-9', 'Marking CL-9 right', 'body', 'dark marking',
         (0.0465, -0.005, 0.000), (math.pi / 2, 0, math.pi / 2), .009)
# ===========================================================================
# MAG: canted lance cell in the magwell (the reload timeline slides this group)
# ===========================================================================
add('Lance cell', 'mag', 'dark polymer', boxv((.060, .075, .095)),
    loc=(0, 0.135, -0.072), rot=(math.radians(4.6), 0, 0), bevel=.003)
add('Cell base plate', 'mag', 'copper rail', boxv((.052, .014, .058)),
    loc=(0, 0.129, -0.122), rot=(math.radians(4.6), 0, 0), bevel=.002)
for index, z in enumerate((-0.055, -0.075, -0.095)):
    add(f'Cell charge window {index + 1}', 'mag', 'arc glow', boxv((.044, .004, .010)),
        loc=(0, 0.1735, z), rot=(math.radians(4.6), 0, 0), bevel=0)
pair('Cell contact', 'mag', 'copper rail', boxv((.012, .014, .012)),
     loc=(.022, 0.135, -0.022), bevel=.0015)
# ===========================================================================
# BOLT and TRIGGER: the two small moving owners
# ===========================================================================
add('Charging sled', 'bolt', 'blued steel', boxv((.052, .050, .040)),
    loc=(0, BOLT_HOME_Y, 0.044), bevel=.003)
pair('Sled wing', 'bolt', 'copper rail', boxv((.014, .020, .056)),
     loc=(.027, BOLT_HOME_Y, 0.046), bevel=.0015)
add('Sled arc strip', 'bolt', 'arc glow', boxv((.030, .008, .010)),
    loc=(0, BOLT_HOME_Y + 0.004, 0.066), bevel=0)
add('Bolt handle root', 'bolt', 'gunmetal', tube(.016, .014, 10, axis='X'),
    loc=(-0.020, BOLT_HOME_Y, 0.046))
add('Bolt handle arm', 'bolt', 'gunmetal', boxv((.054, .016, .018)),
    loc=(-0.046, BOLT_HOME_Y, 0.046), bevel=.003)
BOLT_KNOB_OBJECT = add('Bolt knob', 'bolt', 'gunmetal',
                       taper(.014, .005, 0.0, 0.032, 12),
                       loc=(-0.071, BOLT_HOME_Y, 0.046), rot=(0, 0, math.pi / 2), bevel=0)
add('Bolt knob collar', 'bolt', 'gunmetal', washer(.0145, .0120, .004, 10, axis='X'),
    loc=(-0.074, BOLT_HOME_Y, 0.046), bevel=0)
TRIGGER_OBJECT = add('Trigger blade', 'trigger', 'gunmetal', boxv((.010, .014, .024)),
                     loc=(0, TRIGGER_Y, -0.006967), rot=(math.radians(10), 0, 0), bevel=.002)
add('Trigger shoe', 'trigger', 'copper rail', boxv((.012, .008, .014)),
    loc=(0, TRIGGER_Y + 0.005, -0.014), rot=(math.radians(10), 0, 0), bevel=.0015)
add('Trigger guard', 'trigger', 'gunmetal', solid(recty(0.095, 0.180, -0.070, 0.008), .030, 'X',
                                                  recty(0.105, 0.171, -0.056, -0.006)), bevel=.003)
# ===========================================================================
# FACTORY OPTIC: rail iron sights framing the 0.155 line (rear aperture plus
# a glowing front post carried by the convergence collar)
# ===========================================================================
pair('Rear sight ear', 'factory-optic', 'gunmetal', boxv((.006, .040, .056)),
     loc=(.0145, REAR_SIGHT_Y, 0.127), bevel=.0015)
add('Rear aperture', 'factory-optic', 'gunmetal', washer(.020, .006, .006, 16, axis='Y'),
    loc=(0, REAR_SIGHT_Y, OPTIC_Z), bevel=0)
add('Rear sight bridge', 'factory-optic', 'dark polymer', boxv((.048, .008, .008)),
    loc=(0, REAR_SIGHT_Y, 0.164), bevel=.0015)
add('Front sight base', 'factory-optic', 'gunmetal', boxv((.030, .020, .030)),
    loc=(0, 0.694, 0.096), bevel=.0015)
FRONT_POST_OBJECT = add('Front sight post', 'factory-optic', 'gunmetal', boxv((.006, .006, .060)),
    loc=(0, FRONT_SIGHT_Y, 0.125), bevel=0)
add('Front sight dot', 'factory-optic', 'arc glow', boxv((.008, .008, .008)),
    loc=(0, FRONT_SIGHT_Y, 0.155), bevel=0)
# ===========================================================================
# EXTRA: the lance reload swaps the lance cell, so no cartridges ride
# here; `extra` stays an empty identity node for the choreography to own.
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

for (key, value) in {'asset_id': 'pike',
                     'asset_name': 'PIKE',
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
tip_plane = sorted({round(p[1], 9) for (p, n) in points if n == bore_object.name and p[1] > 0.71})
trigger_object = TRIGGER_OBJECT
trigger_low = min((trigger_object.matrix_world @ v.co)[2] for v in trigger_object.data.vertices)
bolt_handle = BOLT_KNOB_OBJECT
knob_far = min((bolt_handle.matrix_world @ v.co)[0] for v in bolt_handle.data.vertices)
front_post = FRONT_POST_OBJECT
front_post_tip = max((front_post.matrix_world @ v.co)[2] for v in front_post.data.vertices)
aperture = bpy.data.objects.get('Rear aperture')
aperture_z = ((min((aperture.matrix_world @ v.co)[2] for v in aperture.data.vertices)
               + max((aperture.matrix_world @ v.co)[2] for v in aperture.data.vertices)) / 2)
CONTRACT = [
    ('muzzle_forward_vertex_y', tip[1], MUZZLE[1], 1e-6),
    ('muzzle_marker', MUZZLE[1], 0.720, 1e-9),
    ('bore_axis_x', bore_x, BORE_X, 1e-6),
    ('bore_axis_z', bore_z, BORE_Z, 1e-6),
    ('exposed_bore_radius_in_heat_band', band_radius, BORE_R, 1e-6),
    ('grip_marker_x', GRIP[0], 0.045, 1e-9),
    ('grip_marker_y', GRIP[1], 0.100, 1e-9),
    ('grip_marker_z', GRIP[2], 0.015, 1e-9),
    ('support_marker_x', SUPPORT[0], -0.055, 1e-9),
    ('support_marker_y', SUPPORT[1], 0.420, 1e-9),
    ('support_marker_z', SUPPORT[2], 0.005, 1e-9),
    ('sight_axis_z', SIGHT[2], OPTIC_Z, 1e-9),
    ('rear_aperture_axis_z', aperture_z, OPTIC_Z, 1e-6),
    ('front_post_tip_z', front_post_tip, OPTIC_Z, 2e-3),
    ('trigger_blade_y', TRIGGER_Y, 0.140, 1e-9),
    ('trigger_blade_tip_z', trigger_low, TRIGGER_TIP_Z, 1e-6),
    ('bolt_handle_home_y', BOLT_HOME_Y, -BOLT_HOME_GAME_Z, 1e-9),
    ('bolt_knob_reach_x', knob_far, None, None),
    ('rear_sight_plane_y', REAR_SIGHT_Y, -0.060, 1e-9),
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
BLEND = DOCS / 'pike.blend'
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
CONTACT_ANCHOR = 'Pike receiver'


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

GLB = DOCS / 'pike.glb'
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
            node.setdefault('extras', {})['blenderAsset'] = 'pike'
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
    'asset': 'PIKE',
    'asset_id': 'pike',
    'kind': 'original twin-rail charge lance prop (visual game asset)',
    'blender': bpy.app.version_string,
    'authoring_script': 'tools/blender/pike/build-pike.py',
    'source_parts': len(PARTS),
    'animation_group_nodes': GROUPS,
    'marker_nodes': sorted(MARKERS),
    'batch_nodes': len(batches),
    'round_nodes': [obj.name for obj in round_objects],
    'triangles': triangles,
    'triangles_per_primitive': per_primitive,
    'materials': [m[0] for m in MATERIALS] + ['arc glow'],
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
                        'sight_planes': [REAR_SIGHT_Y, 0.692]},
    'files': {'blend': 'docs/design/blender/pike/pike.blend',
              'glb': 'docs/design/blender/pike/pike.glb',
              'renders': ['render-hero.png', 'render-side.png', 'render-left.png',
                          'render-ads.png', 'render-rear.png'],
              'validation': 'docs/design/blender/pike/validation.json'},
    'build_time_checks': {
        'anchor_contract': 'muzzle plane, bore axis and exposed 0.0195 radius across '
                           'the whole heat band, all four markers, the 0.155 sight '
                           'line, the rear aperture, the front post tip, the trigger '
                           'blade and the bolt handle home position are asserted '
                           'against the runtime contract every build',
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
    'notes': ['Fresh design: no geometry reused from the older HALO study.',
              'Long thin twin conductor rails and a floating violet emissive spine over '
              'an open bare-metal rail lane; the heat band stays clear.',
              'Markings are modelled geometry, not a texture decal.',
              'The lance reload swaps the lance cell, so `extra` stays an empty '
              'identity node for the choreography to own.',
              'Arc glow is an emission material (violet, strength 2.0) with no map.'],
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
