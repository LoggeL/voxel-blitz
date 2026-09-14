"""Author TALON, an original tanto fighting knife prop for Voxel Blitz.

Fresh design, built from scratch: no geometry, file or mesh is loaded from the
older PEREGRINE study. Only the low-level authoring technique (closed convex
primitives, analytic planar UVs, shared ImageGen maps) and the frozen runtime
interface (anchors, part nodes, markers) are shared, because the game slot
demands them.

Run headless (the repo's own convention for long Blender work; the MCP bridge
runs the same Blender Python underneath):

    blender --background --factory-startup --python build-talon.py

or through the live Blender MCP session (protocol 5) on 127.0.0.1:9876:

    from pathlib import Path
    p = Path('.../tools/blender/talon/build-talon.py')
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

    muzzle   (0, 0.020, -0.420)   -> y = 0.420, x = 0, z = 0.020 (blade tip)
    grip     (0.020, -0.225, -0.035) -> y = 0.035, x = 0.020, z = -0.225
    sight    blade spine top      -> z = 0.020 (models/knife.js sight line)
    guard    barrelLen 0.40 base   -> y = 0.020, blade spans guard -> tip
    no bore, no heat band, no support hand, no glass: a blade carries this slot

Design intent: a K-7 RIPPER-style tanto fighting knife. A flat-ground blade
with an angular clipped point rides spine-on the 0.02 sight line from the
oval guard to the tip at y = 0.42; a dark fuller rib stands proud of both
flats, the tang runs through a cord-wrapped handle built around the low grip
palm, and a parting ring, pommel cap, rubber boot and lanyard loop close the
butt. mag / bolt / trigger / extra export as empty identity nodes, because
the knife slot never reloads, cycles or feeds cartridges.

Geometry is closed convex primitives (no booleans, no negative scales), then
chamfered by a bevel modifier; winding is repaired with recalc_face_normals and
UVs are an analytic per-face projection of the two non-dominant axes so the six
ImageGen maps tile at a constant real-world density. Every joint overlaps
volumetrically by >= 1 mm: butt-jointed flush faces z-fight once same-material
parts merge into one draw call.

Outputs (owned by this task):
    docs/design/blender/talon/talon.blend   editable, textures packed
    docs/design/blender/talon/talon.glb     portable GLB, images embedded
    docs/design/blender/talon/manifest.json    machine-readable record
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
DOCS = ROOT / 'docs/design/blender/talon'
INK = ROOT / 'public/assets/blender/textures'
DOCS.mkdir(parents=True, exist_ok=True)

ASSET = 'TALON'
SCENE_NAME = f'{ASSET} | Voxel Blitz tanto knife study'
UV_SCALE = 3.6  # texture tiles per metre, constant across the whole model
GROUPS = ['body', 'mag', 'bolt', 'trigger', 'extra']

# --- frozen runtime anchors, in Blender authoring space --------------------
# knife/TALON per the weapon brief: NO bore, NO heat band, NO support hand,
# NO glass. The blade tip is the muzzle; the spine top is the 0.02 sight line.
MUZZLE = (0.000, 0.420, 0.020)     # game (0.000, 0.020, -0.420), TIMERS.knife.muzzle
GRIP = (0.020, 0.035, -0.225)      # game (0.020, -0.225, -0.035), HANDS.knife.grip
SIGHT = (0.000, 0.220, 0.020)      # blade-spine sight line, game y = 0.020
MARKERS = {'muzzle': MUZZLE, 'grip': GRIP, 'sight': SIGHT}

SPINE_Z = 0.020                # blade spine top = the 0.02 sight line (models/knife.js)
GUARD_Y = 0.020                # guard plane: barrelLen 0.40 spans guard -> tip
TIP_Y = 0.420                  # TIMERS.knife.muzzle forward extent
BLADE_BASE_Y = 0.008           # tang buried behind the guard plane
HANDLE_TILT = 0.0693           # handle lean (rad about X): top y=0.010 -> bottom y=0.027

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
# Tanto palette: bright flat-ground blade over blackened furniture, cord wrap
# and grip scales. All six delivered maps are reused with multiply tints (no
# new images); the worn-gunmetal map serves twice, so the portable GLB and
# the runtime stay in agreement through baseColorFactor. NO glass on a knife.
MATERIALS = [
    ('blade steel', 'worn-gunmetal', .85, .30, (.88, .92, .98)),
    ('polished edge', 'worn-gunmetal', .95, .22, (.92, .95, 1.0)),
    ('blackened', 'worn-gunmetal', .55, .45, (.23, .24, .27)),
    ('orange paint', 'orange-painted-metal', .12, .50, (.95, .93, .90)),
    ('ivory coating', 'ivory-armor', .04, .45, (.96, .95, .92)),
    ('petrol grip', 'petrol-ballistic-fabric', 0, .82, (.90, .91, .93)),
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

    Plain tube() only carries vertices at its end caps, which leaves long
    spans with nothing to measure. Rings every `step` keep every audit
    honest while the silhouette stays a perfect cylinder. `radius1`
    tapers the rings from `radius` to a second end radius. (Kept from the
    shared template; the knife build does not call it.)
    """
    count = max(2, int(round((y1 - y0) / step)) + 1)
    verts, faces = [], []
    for k in range(count):
        y = y0 + (y1 - y0) * k / (count - 1)
        rr = radius if radius1 is None else radius + (radius1 - radius) * k / (count - 1)
        base = len(verts)
        for i in range(segments):
            angle = 2 * math.pi * i / segments
            verts.append((rr * math.cos(angle), y, rr * math.sin(angle)))
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
        obj['talon_material'] = material
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
    obj['talon_material'] = material
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
    label.data.resolution_u = 2
    label.data.align_x = 'CENTER'
    label.data.align_y = 'CENTER'
    bpy.ops.object.convert(target='MESH')
    label = bpy.context.active_object
    label.name = name
    label.data.name = f'{name} mesh'
    label.data.materials.append(mats[material])
    label['part'] = part
    label['talon_material'] = material
    label.parent = PART_GROUP[part]
    project_uvs(label.data)
    PARTS.append((label, part, material))
    return label


# ===========================================================================
# BODY: tanto fighting knife — flat-ground blade on the 0.02 spine line,
# oval guard, cord-wrapped handle around the grip marker, pommel cap.
# mag / bolt / trigger / extra stay EMPTY at identity: the knife never
# reloads (magSize 0), never cycles (boltTravel 0) and feeds no cartridges,
# so every moving owner is an honest empty node.
# ===========================================================================
# Blade flat: the main slab. Spine top rides exactly on SPINE_Z (the 0.02
# sight line); the tang base starts behind the guard plane, buried in it.
add('Blade flat', 'body', 'blade steel', prism([
    (BLADE_BASE_Y, -0.008), (0.370, -0.008),
    (0.370, SPINE_Z), (BLADE_BASE_Y, SPINE_Z)], .0084), bevel=.0012)
# Edge bevel: the flat grind hanging below the slab, polished bright so the
# single cutting edge reads against the dark flat. Ends 1 mm shy of the
# flat so no two end caps share a plane.
add('Edge bevel', 'body', 'polished edge', prism([
    (0.006, -0.0145), (0.369, -0.0145),
    (0.369, -0.004), (0.006, -0.004)], .0064), bevel=.001)
# Tanto point: ONE clean angular clip. Its lower edge starts exactly on the
# cutting-edge line so edge flows into point with a single yokote step, and
# the slab is lapped 10 mm back so the joint is volumetric, never a butt
# face. Thinner in X than flat and bevel, so its buried base cap hides fully
# inside them. Bevel is OFF so the tip edge carrying the muzzle contract
# stays exactly on the authored point.
TIP_OBJECT = add('Tanto point', 'body', 'polished edge', prism([
    (0.360, -0.0145), (TIP_Y, SPINE_Z), (0.360, 0.0195)], .0060), bevel=0)
# Fuller inlay: one dark panel 0.3 mm proud of the flats. No booleans anywhere
# on this model, so the fuller reads as a dark recessed channel by shade,
# not by depth; the offset plane can never z-fight the steel.
add('Fuller inlay', 'body', 'blackened', boxv((.0090, .290, .016)),
    loc=(0, 0.205, 0.006), bevel=.001)
# Oval guard: an extruded 16-gon ellipse straddling the guard plane, top
# 3 mm under the spine so the sight line stays clean. Blade, bevel and
# point all pass through it.
def oval(a, b, n=16):
    return [(a * math.cos(2 * math.pi * i / n),
             b * math.sin(2 * math.pi * i / n)) for i in range(n)]
add('Guard', 'body', 'blackened', solid(oval(.036, .021), .018, 'Y'),
    loc=(0, GUARD_Y, -0.004), bevel=.004)
add('Guard collar', 'body', 'blackened', tube(.008, .020, 12),
    loc=(0, GUARD_Y, -0.002))
# Handle core: the tapered tang-to-pommel beam. Its quad is solved so the
# grip marker (0.020, 0.035, -0.225) sits strictly inside the evaluated
# volume (asserted below), and its head is buried in the guard.
HANDLE_OBJECT = add('Handle core', 'body', 'blackened', prism([
    (0.030, -0.002), (-0.010, -0.010),
    (0.002, -0.250), (0.052, -0.244)], .040),
    loc=(0.010, 0, 0), bevel=.006)
# Ferrule: the orange parting collar where the handle meets the guard.
add('Ferrule', 'body', 'orange paint', boxv((.044, .046, .016)),
    loc=(0.010, 0.0117, -0.030), rot=(HANDLE_TILT, 0, 0), bevel=.002)
# Steel liners: one thin plate per flank between core and scale, faces on
# unique planes throughout.
pair('Handle liner', 'body', 'blade steel', boxv((.003, .036, .210)),
     loc=(0.0295, 0.0185, -0.1265), rot=(HANDLE_TILT, 0, 0), bevel=.001)
# Grip scales: one slab per flank over the liners, backs buried in the liner
# and faces on unique planes, tilted with the handle lean.
pair('Grip scale', 'body', 'petrol grip', boxv((.004, .030, .200)),
     loc=(0.0325, 0.0185, -0.1265), rot=(HANDLE_TILT, 0, 0), bevel=.0015)
# Cord-wrap ribs: seven collars visibly circling the scales, 2.5 mm proud of
# each flank, riding the handle centreline y(z) = 0.010 + (z + 0.006) * -0.0705.
for index, (y, z) in enumerate(((0.0138, -0.060), (0.0152, -0.080),
                                (0.0166, -0.100), (0.0194, -0.140),
                                (0.0209, -0.160), (0.0223, -0.180),
                                (0.0247, -0.215))):
    add(f'Wrap rib {index + 1}', 'body', 'tan webbing', boxv((.074, .050, .011)),
        loc=(0, y, z), rot=(HANDLE_TILT, 0, 0), bevel=.002)
# Pommel stack: orange parting ring between handle and cap, rubber boot at
# the butt, and a lanyard loop frame with a cord and knot below it all.
add('Pommel ring', 'body', 'orange paint', boxv((.048, .052, .008)),
    loc=(0.010, 0.0268, -0.2435), rot=(HANDLE_TILT, 0, 0), bevel=.0015)
add('Pommel cap', 'body', 'blackened', boxv((.046, .056, .024)),
    loc=(0.010, 0.0275, -0.253), rot=(HANDLE_TILT, 0, 0), bevel=.003)
add('Pommel boot', 'body', 'rubber', boxv((.040, .050, .010)),
    loc=(0.010, 0.028, -0.266), rot=(HANDLE_TILT, 0, 0), bevel=.003)
add('Lanyard loop', 'body', 'blackened', solid(recty(-0.004, 0.060, -0.298, -0.268), .008, 'X',
                                               recty(0.008, 0.048, -0.290, -0.272)),
    loc=(0.010, 0, 0), bevel=.001)
add('Lanyard cord', 'body', 'tan webbing', tube(.004, .030, 10, axis='Z'),
    loc=(0.010, 0.028, -0.310))
add('Lanyard knot', 'body', 'tan webbing', boxv((.014, .014, .014)),
    loc=(0.010, 0.028, -0.328), bevel=.003)
add('Pommel peen', 'body', 'blade steel', tube(.006, .008, 12, axis='Z'),
    loc=(0.010, 0.028, -0.274))
# Corby-bolt scale pins: buried ends, unique planes, honest cutlery detail.
add('Scale pin front', 'body', 'blade steel', tube(.0035, .066, 10, axis='X'),
    loc=(0, 0.0180, -0.120))
add('Scale pin rear', 'body', 'blade steel', tube(.0035, .066, 10, axis='X'),
    loc=(0, 0.0237, -0.200))
# Identity markings, modelled as geometry on the blade flats, backs buried
# 0.7 mm inside the flat so no cap face sits coplanar with the steel.
add_text('TALON', 'Marking TALON left', 'body', 'ivory coating',
         (-0.0035, 0.200, 0.006), (math.pi / 2, 0, -math.pi / 2), .013)
add_text('TALON', 'Marking TALON right', 'body', 'ivory coating',
         (0.0035, 0.200, 0.006), (math.pi / 2, 0, math.pi / 2), .013)
add_text('K-7', 'Marking K-7 left', 'body', 'ivory coating',
         (-0.0035, 0.055, 0.008), (math.pi / 2, 0, -math.pi / 2), .008)
add_text('K-7', 'Marking K-7 right', 'body', 'ivory coating',
         (0.0035, 0.055, 0.008), (math.pi / 2, 0, math.pi / 2), .008)

# Blade part names the contract assertions measure below.
BLADE_PART_NAMES = ('Blade flat', 'Edge bevel', 'Tanto point')

# No cartridges on a melee slot: actions.js never consumes extra.userData
# cartridges for the knife, so ROUND_OBJECTS stays empty and `extra` exports
# as an honest empty node.

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

for (key, value) in {'asset_id': 'talon',
                     'asset_name': 'TALON',
                     'game_forward': '-Z after glTF export',
                     'sight_height': SPINE_Z,
                     'blade_tip': list(MUZZLE)}.items():
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

tip_object = TIP_OBJECT
tip_points = [p for (p, n) in points if n == tip_object.name]
tip_y = max(p[1] for p in tip_points)
# The tanto tip is an edge across the blade thickness: the contract point is
# the centre of the forward-most row, which must sit on the spine line.
tip_row = [p for p in tip_points if abs(p[1] - tip_y) < 1e-9]
tip = max(tip_row, key=lambda p: p[1])
tip_cx = sum(p[0] for p in tip_row) / len(tip_row)
tip_cz = sum(p[2] for p in tip_row) / len(tip_row)
tip_plane = sorted({round(p[1], 9) for (p, n) in points
                   if n == tip_object.name and p[1] > 0.40})
blade_points = [p for (p, n) in points
               if n in {o.name for (o, _p, _m) in PARTS
                        if o.name.split('.')[0] in BLADE_PART_NAMES}]
blade_base = min(p[1] for p in blade_points)
# Nothing forward of the guard may rise above the spine sight line.
forward = [p for (p, _n) in points if p[1] > GUARD_Y + 0.03]
spine_top = max(p[2] for p in forward)
# The grip marker must sit strictly inside the evaluated handle volume.
handle_points = [p for (p, n) in points if n == HANDLE_OBJECT.name]
handle_low = [min(p[i] for p in handle_points) for i in range(3)]
handle_high = [max(p[i] for p in handle_points) for i in range(3)]
grip_inside = all(handle_low[i] + 1e-3 < GRIP[i] < handle_high[i] - 1e-3
                 for i in range(3))

CONTRACT = [
    ('blade_tip_y', tip_y, TIP_Y, 1e-6),
    ('blade_tip_center_x', tip_cx, 0.000, 1e-6),
    ('blade_tip_center_z', tip_cz, SPINE_Z, 1e-6),
    ('muzzle_marker_x', MUZZLE[0], 0.000, 1e-9),
    ('muzzle_marker_y', MUZZLE[1], TIP_Y, 1e-9),
    ('muzzle_marker_z', MUZZLE[2], SPINE_Z, 1e-9),
    ('grip_marker_x', GRIP[0], 0.020, 1e-9),
    ('grip_marker_y', GRIP[1], 0.035, 1e-9),
    ('grip_marker_z', GRIP[2], -0.225, 1e-9),
    ('sight_line_x', SIGHT[0], 0.000, 1e-9),
    ('sight_line_y', SIGHT[1], 0.220, 1e-9),
    ('sight_line_z', SIGHT[2], SPINE_Z, 1e-9),
    ('spine_top_z', spine_top, SPINE_Z, 1e-6),
    ('blade_base_y', blade_base, None, None),
]
contract_failures = []
for (name, measured, expected, tolerance) in CONTRACT:
    if expected is None or tolerance is None:
        continue
    if abs(measured - expected) > tolerance:
        contract_failures.append(f'{name}: measured {measured:.9f}, contract {expected} +/- {tolerance}')
if blade_base >= GUARD_Y:
    contract_failures.append(
        f'blade starts at y={blade_base}, forward of the {GUARD_Y} guard plane')
if not grip_inside:
    contract_failures.append(
        f'grip marker {GRIP} outside handle volume '
        f'x={handle_low[0]:+.4f}..{handle_high[0]:+.4f} '
        f'y={handle_low[1]:+.4f}..{handle_high[1]:+.4f} '
        f'z={handle_low[2]:+.4f}..{handle_high[2]:+.4f}')

print(f'model extent x={extent[0][0]:+.4f}..{extent[0][1]:+.4f} '
      f'y={extent[1][0]:+.4f}..{extent[1][1]:+.4f} z={extent[2][0]:+.4f}..{extent[2][1]:+.4f}')
print(f'blade tip ({tip[0]:+.6f}, {tip[1]:+.6f}, {tip[2]:+.6f}), tip plane rows {tip_plane}')
print(f'spine top z={spine_top:.6f} over {len(forward)} forward vertices; '
      f'blade base y={blade_base:.6f}')
print(f'grip marker inside handle: {grip_inside}')
if contract_failures:
    print(f'CONTRACT FAILURES: {len(contract_failures)}')
    for line in contract_failures:
        print(f'  {line}')
else:
    print('anchor contract: all assertions pass')

# --- pack textures and save the editable source ----------------------------
bpy.ops.file.pack_all()
BLEND = DOCS / 'talon.blend'
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
CONTACT_ANCHOR = 'Handle core'


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

GLB = DOCS / 'talon.glb'
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
            node.setdefault('extras', {})['blenderAsset'] = 'talon'
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
    'asset': 'TALON',
    'asset_id': 'talon',
    'kind': 'original tanto fighting knife prop (visual game asset)',
    'blender': bpy.app.version_string,
    'authoring_script': 'tools/blender/talon/build-talon.py',
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
        'sight': [SIGHT[0], SIGHT[2], -SIGHT[1]],
    },
    'contract_points': {'guard_plane_y': GUARD_Y, 'blade_tip_y': TIP_Y,
                        'blade_base_y': BLADE_BASE_Y, 'spine_z': SPINE_Z,
                        'blade_span_y': [GUARD_Y, TIP_Y],
                        'sight_height': SPINE_Z},
    'files': {'blend': 'docs/design/blender/talon/talon.blend',
              'glb': 'docs/design/blender/talon/talon.glb',
              'renders': ['render-hero.png', 'render-side.png', 'render-left.png',
                          'render-ads.png', 'render-rear.png'],
              'validation': 'docs/design/blender/talon/validation.json'},
    'build_time_checks': {
        'anchor_contract': 'blade tip on the muzzle point, spine top on the 0.02 '
                           'sight line, blade base buried behind the guard plane, '
                           'grip marker inside the handle volume, all three '
                           'markers are asserted against the runtime contract '
                           'every build',
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
        'Hand fit is unverified: the grip palm sits on the contract point and '
        'the handle is built around it, but no third-person pose test was run.',
        'mag / bolt / trigger / extra export as empty identity nodes: the knife '
        'slot never reloads, cycles or feeds cartridges.',
    ],
    'notes': ['Fresh design: no geometry reused from any gun study.',
              'No bore, no heat band, no glass: a blade carries the muzzle contract.',
              'Markings are modelled geometry, not a texture decal.',
              'The fuller is a dark inlay panel 0.3 mm proud, not a boolean groove.'],
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
