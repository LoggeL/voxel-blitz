"""Author BISON, an original belt-fed squad support prop for Voxel Blitz.

Second study revision. Fresh design, built from scratch: no geometry, file or
mesh is loaded from any other study. Only the low-level authoring technique
(closed convex primitives, analytic planar UVs, shared ImageGen maps) and the
frozen runtime interface (anchors, part nodes, markers) are shared, because the
game slot demands them.

Run headless (the repo's own convention for long Blender work; the MCP bridge
runs the same Blender Python underneath):

    blender --background --factory-startup --python build-bison.py

or through the live Blender MCP session (protocol 5) on 127.0.0.1:9876:

    from pathlib import Path
    p = Path('.../tools/blender/bison/build-bison.py')
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
    bore axis x = 0, z = 0.055    -> x = 0, z = 0.055, exposed radius 0.0290
    grip     (0.050, 0.000, -0.10)-> y = 0.100, x = 0.050, z = 0.000
    support  (-0.060, -0.012, -0.47) -> y = 0.470, x = -0.060, z = -0.012
    sight    aperture axis 0.155  -> z = 0.155
    breech   lmg -0.340           -> y = 0.340
    trigger  lmg -0.130           -> y = 0.130, blade tip z = -0.068
    heat band -0.454 .. -0.6972   -> y = 0.454 .. 0.6972

Design intent: an M249-class light machine gun. A deep riveted slab receiver
carries an open feed tray under a hinged feed cover, a ghost-ring rear sight
and a hooded front post on the 0.155 line, a slotted handguard with side rails
over the gas system, a folding barrel-change handle, a heavy barrel left bare
across the heat band with a six-prong birdcage, an under-hung 200-round box in
a fabric pouch with webbing straps, a contoured pistol grip, a skeletonised
stock on a buffer tube with a cheek riser, and a bipod folded back along the
handguard.

Animated parts follow the runtime contract in public/js/guns/models/bison.js
and public/js/guns/actions.js:

    body     static forms
    mag      ammunition box, its bracket and the hanging belt (leaves with the box)
    bolt     charging handle assembly (racked after the cover slams shut)
    trigger  blade and guard
    extra    the feed cover leaves (custom prop `cover`, re-hung on the authored
             'Feed cover hinge' pin by the builder) and the belt lead (custom
             prop `belt_lead`, a short run of linked rounds lying across the
             feed tray that the reload lifts out with the spent box and lays
             back in from the fresh one)

Geometry is closed convex primitives (no booleans, no negative scales), then
chamfered by a bevel modifier; winding is repaired with recalc_face_normals and
UVs are an analytic per-face projection of the two non-dominant axes so the six
ImageGen maps tile at a constant real-world density. Every joint overlaps
volumetrically by >= 1 mm: butt-jointed flush faces z-fight once same-material
parts merge into one draw call.

Outputs (owned by this task):
    docs/design/blender/bison/bison.blend   editable, textures packed
    docs/design/blender/bison/bison.glb     portable GLB, images embedded
    docs/design/blender/bison/manifest.json    machine-readable record
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
DOCS = ROOT / 'docs/design/blender/bison'
INK = ROOT / 'public/assets/blender/textures'
DOCS.mkdir(parents=True, exist_ok=True)

ASSET = 'BISON'
SCENE_NAME = f'{ASSET} | Voxel Blitz lmg study'
UV_SCALE = 3.6  # texture tiles per metre, constant across the whole model
GROUPS = ['body', 'mag', 'bolt', 'trigger', 'extra']

# --- frozen runtime anchors, in Blender authoring space --------------------
# Verified against public/js/guns/defs.js TIMERS.lmg (muzzle [0, 0.055, -0.720],
# barrelLen 0.38, heatLen [0.30, 0.94]) and public/js/guns/models/lmg.js
# (sightHeight 0.155): authoring y = -game_z, authoring z = game_y.
MUZZLE = (0.000, 0.720, 0.055)      # game (0.000, 0.055, -0.720)
GRIP = (0.050, 0.100, 0.000)        # game (0.050, 0.000, -0.100)
SUPPORT = (-0.060, 0.470, -0.012)   # game (-0.060, -0.012, -0.470)
SIGHT = (0.000, -0.060, 0.155)      # iron-sight axis at the rear aperture, game y = 0.155
MARKERS = {'muzzle': MUZZLE, 'grip': GRIP, 'support': SUPPORT, 'sight': SIGHT}

BORE_X, BORE_Z = 0.000, 0.055   # bore axis
BORE_R = 0.0290                 # exposed bore radius = BARREL_R.lmg - 0.0005
BORE_IN = 0.0110                # muzzle mouth recess radius
BORE_START = 0.280              # buried in the receiver
GUARD_END = 0.453               # handguard ends: bare barrel visible past here
HEAT_BAND = (0.454, 0.6972)     # game z -0.454 .. -0.6972 (breech 0.34 + heatLen * 0.38)
BREECH_Y = 0.340                # BREACH_Z.lmg -0.34
SIGHT_Z = 0.155                 # body aperture sight height (lmg.js sightHeight)
TRIGGER_Y, TRIGGER_TIP_Z = 0.130, -0.068   # TRIGGER_Z.lmg -0.13
BOLT_HOME_GAME_Z = -0.025       # BOLT_HOME.lmg
BOLT_HOME_Y = -BOLT_HOME_GAME_Z  # the same point in authoring space

# Feed cover hinge pin (authoring). The runtime builder re-hangs the cover on
# this point: public/js/guns/models/bison.js COVER_HINGE = (0, 0.145, -0.206).
COVER_HINGE = (0.000, 0.206, 0.145)
COVER_TOP = 0.152               # nothing on the closed cover may cross the 0.155 line
# Belt lead home (authoring). Runtime: bison.js reads the node translation.
BELT_LEAD_HOME = (-0.010, 0.105, 0.130)

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
# Squad-support two-tone: olive-drab furniture over blackened metal. Both reuse
# the delivered worn-gunmetal map with different multiply tints (no new images),
# so the portable GLB and the runtime stay in agreement through baseColorFactor.
MATERIALS = [
    ('gunmetal', 'worn-gunmetal', .50, .35, (.34, .34, .36)),
    ('olive drab', 'worn-gunmetal', .08, .68, (.62, .63, .47)),
    ('orange paint', 'orange-painted-metal', .12, .50, (.95, .93, .90)),
    ('ivory coating', 'ivory-armor', .04, .45, (.96, .95, .92)),
    ('petrol fabric', 'petrol-ballistic-fabric', 0, .82, (.90, .91, .93)),
    ('tan webbing', 'tan-webbing', 0, .88, (.94, .93, .91)),
    ('brass', 'worn-gunmetal', .65, .45, (.72, .58, .30)),
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
ROUND_OBJECTS = []  # origin-centred nodes under extra (the belt lead)
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
    keep it off the heat band, which must stay exactly 0.0290).
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


def rotated(shape, rot):
    """Rotate one primitive definition (XYZ Euler, radians) about the origin."""
    (verts, faces) = shape
    matrix = Euler(rot, 'XYZ').to_matrix()
    return ([tuple(matrix @ Vector(v)) for v in verts], faces)


def merge_shapes(shapes):
    """Concatenate primitive vertex/face lists into one mesh definition."""
    verts, faces = [], []
    for (shape_verts, shape_faces) in shapes:
        base = len(verts)
        verts.extend(shape_verts)
        faces.extend(tuple(i + base for i in face) for face in shape_faces)
    return verts, faces


def add(name, part, material, shape, loc=(0, 0, 0), rot=(0, 0, 0),
        bevel=.0025, mirror=False, uv_scale=UV_SCALE, props=None):
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
        obj['bison_material'] = material
        for (key, value) in (props or {}).items():
            obj[key] = value
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


def cover(name, material, shape, loc=(0, 0, 0), rot=(0, 0, 0), bevel=.0025):
    """A feed-cover leaf: lives under extra and rides the runtime hinge."""
    return add(name, 'extra', material, shape, loc=loc, rot=rot, bevel=bevel,
               props={'cover': True})


def add_local(name, part, material, shapes, loc, props=None):
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
    obj['bison_material'] = material
    obj['round'] = True
    for (key, value) in (props or {}).items():
        obj[key] = value
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
    label['bison_material'] = material
    label.parent = PART_GROUP[part]
    project_uvs(label.data)
    PARTS.append((label, part, material))
    return label


def rivet_row(name, x, stations, z, radius=.0035, length=.006):
    """Domed fastener heads along one side rib."""
    for index, y in enumerate(stations):
        add(f'{name} {index + 1}', 'body', 'gunmetal', tube(radius, length, 8, axis='X'),
            loc=(x, y, z), bevel=0)


# ===========================================================================
# BODY: riveted slab receiver with an open feed tray, ghost-ring rear sight,
# slotted handguard with side rails, gas system, bare barrel across the heat
# band, birdcage hider with hooded post, folding barrel handle, contoured grip,
# skeleton stock on a buffer tube, and a folded bipod
# ===========================================================================
# Deep slab receiver. The barrel root buries inside it ahead of the breech.
add('Receiver body', 'body', 'gunmetal', boxv((.120, .460, .150)),
    loc=(0, 0.090, 0.030), bevel=.005)
# Thinner top housing whose upper face is the feed tray floor. The tray lips,
# rear wall and front stop frame the belt lead; the cover closes over them.
add('Receiver top housing', 'body', 'gunmetal', boxv((.104, .400, .022)),
    loc=(0, 0.100, 0.111), bevel=.002)
pair('Feed tray lip', 'body', 'gunmetal', boxv((.008, .212, .014)),
     loc=(.052, 0.100, 0.128), bevel=.001)
add('Feed tray rear wall', 'body', 'gunmetal', boxv((.100, .008, .011)),
    loc=(0, -0.006, 0.127), bevel=.001)
add('Feed tray front stop', 'body', 'gunmetal', boxv((.100, .008, .011)),
    loc=(0, 0.208, 0.127), bevel=.001)
for index, y in enumerate((0.060, 0.100, 0.140)):
    add(f'Feed tray pawl ridge {index + 1}', 'body', 'gunmetal', boxv((.060, .006, .005)),
        loc=(0, y, 0.1235), bevel=0)
# Hinge brackets rise from the housing to the pin; the pin runs through the
# cover's front edge. The cover leaves themselves are extra-group parts below.
pair('Feed cover hinge bracket', 'body', 'gunmetal', boxv((.014, .020, .034)),
     loc=(.0585, COVER_HINGE[1], 0.119), bevel=.0015)
pair('Feed cover hinge', 'body', 'gunmetal', boxv((.012, .024, .024)),
     loc=(.059, COVER_HINGE[1], COVER_HINGE[2]), bevel=.0015)
add('Feed cover hinge pin', 'body', 'gunmetal', tube(.006, .134, 10, axis='X'),
    loc=(0, COVER_HINGE[1], COVER_HINGE[2]), bevel=0)
add('Feed cover latch catch', 'body', 'gunmetal', boxv((.012, .030, .012)),
    loc=(-0.060, 0.020, 0.128), bevel=.001)

# Riveted side ribs: two horizontal stiffeners per side with fastener rows.
pair('Side rib upper', 'body', 'gunmetal', boxv((.006, .380, .012)),
     loc=(.061, 0.080, 0.088), bevel=.0015)
pair('Side rib lower', 'body', 'gunmetal', boxv((.006, .300, .012)),
     loc=(.061, 0.040, -0.028), bevel=.0015)
rivet_row('Rivet upper right', 0.064, (-0.090, -0.030, 0.030, 0.090, 0.150, 0.210), 0.088)
rivet_row('Rivet upper left', -0.064, (-0.090, -0.030, 0.030, 0.090, 0.210), 0.088)
rivet_row('Rivet lower right', 0.064, (-0.080, 0.000, 0.080, 0.160), -0.028)
rivet_row('Rivet lower left', -0.064, (-0.080, 0.000, 0.080, 0.160), -0.028)

# Split top rail: the feed cover opens between the two segments.
add('Top rail rear', 'body', 'gunmetal', boxv((.046, .108, .014)),
    loc=(0, -0.066, 0.128), bevel=.0015)
for index, y in enumerate((-0.100, -0.060, -0.020)):
    add(f'Rail rib rear {index + 1}', 'body', 'gunmetal', boxv((.048, .014, .007)),
        loc=(0, y, 0.137), bevel=0)
add('Top rail front', 'body', 'gunmetal', boxv((.046, .066, .014)),
    loc=(0, 0.247, 0.128), bevel=.0015)
for index, y in enumerate((0.230, 0.260)):
    add(f'Rail rib front {index + 1}', 'body', 'gunmetal', boxv((.048, .014, .006)),
        loc=(0, y, 0.137), bevel=0)

# Ghost-ring rear sight: base on the rail, ring centred on the 0.155 axis with
# a 10 mm aperture, protective wings outboard of the ring, windage knob.
add('Rear sight base', 'body', 'gunmetal', boxv((.054, .034, .009)),
    loc=(0, -0.060, 0.1385), bevel=.0015)
add('Rear ghost ring', 'body', 'gunmetal', washer(.016, .010, .006, 16, axis='Y'),
    loc=(0, -0.060, SIGHT_Z), bevel=0)
pair('Rear sight wing', 'body', 'gunmetal', boxv((.006, .020, .030)),
     loc=(.0215, -0.060, 0.152), bevel=.001)
add('Windage knob', 'body', 'gunmetal', tube(.008, .016, 10, axis='X'),
    loc=(0.034, -0.060, 0.142))
add('Windage knob cap', 'body', 'orange paint', tube(.006, .004, 10, axis='X'),
    loc=(0.043, -0.060, 0.142), bevel=0)

# Ejection port (right): a proud four-bar frame around a dark recessed panel,
# hinge pin for the dust cover along its lower edge.
for (label, size, loc) in (
        ('Ejection port frame top', (.010, .112, .008), (0.061, 0.120, 0.061)),
        ('Ejection port frame bottom', (.010, .112, .008), (0.061, 0.120, 0.029)),
        ('Ejection port frame front', (.008, .010, .042), (0.0615, 0.170, 0.045)),
        ('Ejection port frame rear', (.008, .010, .042), (0.0615, 0.070, 0.045))):
    add(label, 'body', 'gunmetal', boxv(size), loc=loc, bevel=.0015)
add('Ejection port recess', 'body', 'rubber', boxv((.004, .100, .030)),
    loc=(0.059, 0.120, 0.045), bevel=0)
add('Dust cover hinge pin', 'body', 'gunmetal', tube(.003, .116, 8, axis='Y'),
    loc=(0.064, 0.120, 0.027), bevel=0)

# Charging-handle slot (left): the stem rides y 0.025 (home) to -0.050 (full
# 0.075 boltTravel); a four-bar frame with a dark inset spans the whole throw.
for (label, size, loc) in (
        ('Bolt slot frame top', (.010, .126, .006), (-0.061, -0.0125, 0.073)),
        ('Bolt slot frame bottom', (.010, .126, .006), (-0.061, -0.0125, 0.043)),
        ('Bolt slot frame front', (.008, .008, .038), (-0.0615, 0.0455, 0.058)),
        ('Bolt slot frame rear', (.008, .008, .038), (-0.0615, -0.0705, 0.058))):
    add(label, 'body', 'gunmetal', boxv(size), loc=loc, bevel=.0015)
add('Bolt slot recess', 'body', 'rubber', boxv((.004, .110, .026)),
    loc=(-0.059, -0.0125, 0.058), bevel=0)

pair('Side panel', 'body', 'olive drab', boxv((.004, .200, .050)),
     loc=(.061, 0.060, 0.000))
add('Selector switch', 'body', 'orange paint', boxv((.012, .030, .012)),
    loc=(-0.064, 0.020, 0.010), bevel=.0015)
add('Selector pivot', 'body', 'gunmetal', tube(.006, .009, 10, axis='X'),
    loc=(-0.0665, 0.008, 0.010), bevel=0)
add('Sear pin', 'body', 'gunmetal', tube(.006, .130, 10, axis='X'),
    loc=(0, 0.160, 0.040))
add('Trigger pin', 'body', 'gunmetal', tube(.005, .126, 10, axis='X'),
    loc=(0, 0.060, -0.030))
add('Barrel release latch', 'body', 'orange paint', boxv((.020, .030, .016)),
    loc=(0.055, 0.300, 0.075), bevel=.0015)
add('Barrel latch lever', 'body', 'gunmetal', boxv((.006, .050, .012)),
    loc=(0.064, 0.285, 0.075), bevel=.001)
add('Serial plate', 'body', 'ivory coating', boxv((.004, .046, .016)),
    loc=(0.0615, -0.080, 0.060), bevel=0)
# Belt feed port on the left: the hanging belt climbs into this housing.
add('Feed port housing', 'body', 'gunmetal', boxv((.026, .090, .040)),
    loc=(-0.064, 0.140, 0.100), bevel=.002)
add('Feed port roller', 'body', 'gunmetal', tube(.006, .080, 10, axis='Y'),
    loc=(-0.070, 0.140, 0.078), bevel=0)
add('Feed port lip', 'body', 'orange paint', boxv((.028, .006, .010)),
    loc=(-0.064, 0.187, 0.101), bevel=.001)

# Skeleton stock on a buffer tube, rubber buttpad, cheek riser with posts.
add('Stock adapter', 'body', 'gunmetal', boxv((.096, .030, .120)),
    loc=(0, -0.150, 0.025), bevel=.002)
add('Buffer tube', 'body', 'gunmetal', tube(.021, .200, 16), loc=(0, -0.250, 0.060))
add('Buffer tube collar', 'body', 'gunmetal', tube(.024, .012, 16), loc=(0, -0.162, 0.060))
add('Stock spine', 'body', 'olive drab', boxv((.040, .190, .030)),
    loc=(0, -0.250, 0.030), bevel=.003)
add('Stock frame', 'body', 'olive drab', solid(recty(-0.340, -0.160, -0.070, 0.020), .044, 'X',
                                              recty(-0.310, -0.200, -0.048, -0.008)), bevel=.004)
add('Buttpad', 'body', 'rubber', boxv((.056, .022, .150)),
    loc=(0, -0.350, 0.010), bevel=.004)
for index, z in enumerate((-0.030, 0.010, 0.050)):
    add(f'Buttpad rib {index + 1}', 'body', 'rubber', boxv((.058, .006, .006)),
        loc=(0, -0.362, z), bevel=0)
add('Cheek riser', 'body', 'rubber', boxv((.048, .110, .018)),
    loc=(0, -0.255, 0.085), bevel=.003)
pair('Cheek riser post', 'body', 'gunmetal', tube(.005, .030, 10, axis='Z'),
     loc=(.012, -0.230, 0.085), bevel=0)
pair('Cheek riser post rear', 'body', 'gunmetal', tube(.005, .030, 10, axis='Z'),
     loc=(.012, -0.280, 0.085), bevel=0)
add('Rear sling swivel', 'body', 'gunmetal', washer(.010, .006, .007, 12, axis='X'),
    loc=(-0.0265, -0.330, -0.050), bevel=0)
add('Rear sling stud', 'body', 'gunmetal', tube(.004, .014, 8, axis='X'),
    loc=(-0.024, -0.330, -0.050), bevel=0)
add('QD socket', 'body', 'gunmetal', washer(.009, .005, .005, 12, axis='X'),
    loc=(0.0495, -0.150, 0.000), bevel=0)

# Contoured pistol grip wrapping the grip marker; the x = 0.050 palm sits just
# outboard of the 0.058 grip. Finger grooves, backstrap and screw are separate.
add('Pistol grip', 'body', 'olive drab', prism([
    (0.140, 0.005), (0.075, 0.005), (0.055, -0.020), (0.036, -0.060),
    (0.026, -0.100), (0.030, -0.130), (0.082, -0.136), (0.098, -0.100),
    (0.112, -0.050), (0.126, -0.015)], .058), bevel=.006)
add('Grip backstrap', 'body', 'rubber', boxv((.040, .014, .090)),
    loc=(0, 0.113, -0.065), rot=(-0.39, 0, 0), bevel=.003)
for index, (y, z) in enumerate(((0.052, -0.030), (0.037, -0.062), (0.029, -0.095))):
    add(f'Grip finger groove {index + 1}', 'body', 'gunmetal', boxv((.062, .010, .006)),
        loc=(0, y, z), bevel=.0015)
add('Grip screw', 'body', 'gunmetal', tube(.005, .062, 10, axis='X'),
    loc=(0, 0.090, -0.040), bevel=0)
add('Grip base cap', 'body', 'gunmetal', boxv((.062, .058, .010)),
    loc=(0, 0.056, -0.134), rot=(-0.115, 0, 0), bevel=.003)

# Slotted handguard with front/rear caps, side accessory rails, a hand stop on
# the support side and a sling swivel. Every face keeps clear of the heat band.
add('Handguard top cover', 'body', 'olive drab', boxv((.110, .153, .030)),
    loc=(0, 0.3705, 0.103), bevel=.002)
pair('Handguard side wall', 'body', 'olive drab', boxv((.022, .154, .110)),
     loc=(.051, 0.375, 0.035), bevel=.002)
add('Handguard bottom cover', 'body', 'olive drab', boxv((.104, .155, .014)),
    loc=(0, 0.3735, -0.025), bevel=.002)
add('Handguard front cap', 'body', 'gunmetal', boxv((.116, .010, .140)),
    loc=(0, 0.448, 0.043), bevel=.002)
add('Handguard rear cap', 'body', 'gunmetal', boxv((.118, .010, .142)),
    loc=(0, 0.298, 0.043), bevel=.002)
for index, y in enumerate((0.318, 0.343, 0.368, 0.393, 0.418)):
    pair(f'Handguard side slot {index + 1}', 'body', 'rubber', boxv((.004, .018, .040)),
         loc=(.0615, y, 0.020), bevel=0)
    add(f'Handguard top slot {index + 1}', 'body', 'rubber', boxv((.050, .018, .003)),
        loc=(0, y, 0.1175), bevel=0)
pair('Handguard side rail', 'body', 'gunmetal', boxv((.010, .080, .016)),
     loc=(.065, 0.360, 0.062), bevel=.001)
for index in range(5):
    pair(f'Side rail rib {index + 1}', 'body', 'gunmetal', boxv((.012, .008, .018)),
         loc=(.065, 0.330 + index * 0.015, 0.062), bevel=0)
add('Hand stop', 'body', 'olive drab', boxv((.018, .028, .036)),
    loc=(-0.052, 0.438, -0.040), bevel=.002)
add('Hand stop screw', 'body', 'gunmetal', tube(.004, .022, 8, axis='X'),
    loc=(-0.052, 0.438, -0.046), bevel=0)
add('Front sling swivel', 'body', 'gunmetal', washer(.010, .006, .005, 12, axis='X'),
    loc=(0.0525, 0.305, -0.028), bevel=0)

# Gas system tucked under the barrel, ahead of the heat band start.
add('Gas tube', 'body', 'gunmetal', tube(.014, .146, 12), loc=(0, 0.373, 0.008))
add('Gas block', 'body', 'gunmetal', boxv((.050, .025, .050)),
    loc=(0, 0.4325, 0.030), bevel=.0015)
add('Gas regulator', 'body', 'gunmetal', tube(.010, .024, 10, axis='Z'),
    loc=(0, 0.4325, -0.002))
add('Gas regulator lever', 'body', 'orange paint', boxv((.006, .030, .008)),
    loc=(0, 0.4325, -0.016), bevel=.001)

# Folding barrel-change handle on the right of the guard, stowed along the
# top cover. Offset from the bore so the 0.155 line at x = 0 stays clear.
add('Barrel handle post', 'body', 'gunmetal', boxv((.014, .024, .036)),
    loc=(0.036, 0.405, 0.133), bevel=.0015)
add('Barrel handle bar', 'body', 'gunmetal', boxv((.012, .110, .010)),
    loc=(0.036, 0.365, 0.150), bevel=.0015)
add('Barrel handle grip', 'body', 'rubber', boxv((.016, .060, .012)),
    loc=(0.036, 0.350, 0.150), bevel=.002)

# Heavy barrel: fat root inside the guard stepping to exactly 0.0290 where the
# guard ends, bare gunmetal across the whole heat band, recessed target crown.
BORE_OBJECT = add('Heavy barrel', 'body', 'gunmetal', merge_shapes([
    tube_stacked(0.034, 0.280, 0.450, step=0.02, segments=24),
    tube_stacked(BORE_R, 0.450, 0.714, step=0.02, segments=24),
    offset(washer(0.0290, 0.0200, 0.006, 24), dy=0.717, dz=BORE_Z),
]), loc=(BORE_X, 0, 0), bevel=0)
add('Muzzle mouth', 'body', 'rubber', tube(BORE_IN, .010, 16),
    loc=(BORE_X, 0.7145, BORE_Z), bevel=0)

# Six-prong birdcage past the band end: base ring bitten 1 mm into the barrel,
# prongs, and a front ring stopping 0.5 mm shy of the crown plane.
add('Hider base ring', 'body', 'gunmetal',
    offset(washer(0.040, 0.028, 0.008, 16), dy=0.702, dz=BORE_Z), bevel=0)
for index in range(6):
    angle = math.pi / 6 + index * math.pi / 3
    add(f'Hider prong {index + 1}', 'body', 'gunmetal', boxv((.010, .018, .010)),
        loc=(.034 * math.cos(angle), 0.7105, BORE_Z + .034 * math.sin(angle)),
        rot=(angle - math.pi / 2, 0, 0), bevel=0)
add('Hider front ring', 'body', 'gunmetal',
    offset(washer(0.040, 0.031, 0.004, 16), dy=0.717, dz=BORE_Z), bevel=0)

# Hooded front post on the hider ring: stalk, blade and hood stop under 0.155.
add('Front sight stalk', 'body', 'gunmetal', boxv((.024, .012, .034)),
    loc=(0, 0.706, 0.108), bevel=.0015)
add('Front sight blade', 'body', 'orange paint', boxv((.008, .008, .022)),
    loc=(0, 0.706, 0.134), bevel=0)
add('Front sight hood', 'body', 'gunmetal', washer(.019, .015, .010, 16, axis='Y'),
    loc=(0, 0.706, 0.133), bevel=0)

# Bipod folded back under the guard: hinge blocks on the walls, legs canted
# outward and down, spring collars, inner extensions and rubber feet.
LEG_ROT = (0.22, 0, 0.16)
LEG_DIR = Euler(LEG_ROT, 'XYZ').to_matrix() @ Vector((0, 1, 0))
LEG_CENTRE = Vector((0.080, 0.371, -0.014))
pair('Bipod hinge', 'body', 'gunmetal', boxv((.022, .036, .026)),
     loc=(.068, 0.430, -0.010), bevel=.0015)
pair('Bipod leg', 'body', 'gunmetal', boxv((.008, .150, .008)),
     loc=tuple(LEG_CENTRE), rot=LEG_ROT, bevel=.0015)
pair('Bipod leg collar', 'body', 'orange paint', boxv((.014, .020, .014)),
     loc=tuple(LEG_CENTRE + LEG_DIR * 0.060), rot=LEG_ROT, bevel=.001)
pair('Bipod leg extension', 'body', 'gunmetal', tube(.0035, .080, 8, axis='Y'),
     loc=tuple(LEG_CENTRE - LEG_DIR * 0.105), rot=LEG_ROT, bevel=0)
pair('Bipod foot', 'body', 'rubber', boxv((.020, .030, .016)),
     loc=tuple(LEG_CENTRE - LEG_DIR * 0.150), rot=LEG_ROT, bevel=.002)

add_text(ASSET, 'Marking BISON left', 'body', 'ivory coating',
         (-0.061, 0.200, 0.032), (math.pi / 2, 0, -math.pi / 2), .014)
add_text(ASSET, 'Marking BISON right', 'body', 'ivory coating',
         (0.061, 0.200, 0.032), (math.pi / 2, 0, math.pi / 2), .014)
add_text('VB 25', 'Marking VB 25 left', 'body', 'ivory coating',
         (-0.061, -0.080, 0.032), (math.pi / 2, 0, -math.pi / 2), .010)
add_text('VB 25', 'Marking VB 25 right', 'body', 'gunmetal',
         (0.0635, -0.080, 0.060), (math.pi / 2, 0, math.pi / 2), .009)

# ===========================================================================
# MAGAZINE: under-hung 200-round box in a fabric pouch with webbing straps,
# lid with front latch and wire handle, belt exit mouth, and the hanging belt
# that climbs into the feed port. The whole assembly leaves with the box.
# ===========================================================================
add('Magwell collar', 'mag', 'gunmetal', boxv((.100, .060, .030)),
    loc=(0, 0.170, -0.052), bevel=.002)
add('Ammo box', 'mag', 'olive drab', boxv((.150, .150, .140)),
    loc=(-0.010, 0.225, -0.130), bevel=.004)
add('Ammo pouch', 'mag', 'petrol fabric', boxv((.156, .110, .108)),
    loc=(-0.010, 0.225, -0.134), bevel=.006)
for index, y in enumerate((0.190, 0.262)):
    add(f'Pouch strap {index + 1}', 'mag', 'tan webbing', boxv((.160, .022, .146)),
        loc=(-0.010, y, -0.130), bevel=.002)
add('Ammo box lid', 'mag', 'gunmetal', boxv((.156, .156, .020)),
    loc=(-0.010, 0.225, -0.068), bevel=.002)
add('Ammo box latch', 'mag', 'orange paint', boxv((.030, .012, .030)),
    loc=(-0.010, 0.303, -0.071), bevel=.0015)
pair('Box handle post', 'mag', 'gunmetal', boxv((.008, .010, .026)),
     loc=(0.030, 0.303, -0.105), bevel=.001)
add('Box handle bar', 'mag', 'gunmetal', boxv((.070, .008, .008)),
    loc=(0, 0.307, -0.118), bevel=.001)
add('Round counter strip', 'mag', 'ivory coating', boxv((.030, .006, .014)),
    loc=(-0.010, 0.302, -0.150), bevel=0)
add('Belt exit mouth', 'mag', 'gunmetal', boxv((.032, .044, .024)),
    loc=(-0.073, 0.180, -0.052), bevel=.002)
add_text('200', 'Marking 200 rounds', 'mag', 'ivory coating',
         (-0.010, 0.3005, -0.160), (math.pi / 2, 0, math.pi), .018)
# Hanging belt: articulated dark links weaving up from the box mouth into the
# feed port, each carrying a brass case pointed forward along the barrel.
# Every segment is canted so no faces align.
for index, (zc, xc, yc, rx, rz) in enumerate((
        (-0.028, -0.0705, 0.180, 0.06, 0.02),
        (-0.004, -0.074, 0.183, -0.07, -0.03),
        (0.020, -0.070, 0.177, 0.05, 0.04),
        (0.044, -0.074, 0.182, -0.06, 0.02),
        (0.068, -0.070, 0.178, 0.05, -0.03))):
    add(f'Belt drape link {index + 1}', 'mag', 'gunmetal', boxv((.024, .016, .026)),
        loc=(xc, yc, zc), rot=(rx, 0, rz), bevel=0)
    add(f'Belt case {index + 1}', 'mag', 'brass', tube(.008, .046, 8, axis='Y'),
        loc=(xc, yc, zc), rot=(rx, 0, rz), bevel=0)

# ===========================================================================
# BOLT: reciprocating carrier with a ribbed charging handle on the left
# ===========================================================================
add('Bolt carrier', 'bolt', 'gunmetal', tube(.016, .200, 12), loc=(0, 0.060, 0.058))
add('Bolt collar', 'bolt', 'gunmetal', tube(.019, .014, 12), loc=(0, 0.130, 0.058))
add('Bolt shroud', 'bolt', 'gunmetal', tube(.020, .030, 12), loc=(0, -0.070, 0.058))
add('Cocking piece', 'bolt', 'gunmetal', tube(.008, .014, 10), loc=(0, -0.090, 0.058))
add('Bolt handle root', 'bolt', 'gunmetal', tube(.014, .016, 10, axis='X'),
    loc=(-0.062, BOLT_HOME_Y, 0.058))
add('Bolt handle arm', 'bolt', 'gunmetal', boxv((.046, .016, .018)),
    loc=(-0.090, BOLT_HOME_Y, 0.058), bevel=.003)
BOLT_KNOB_OBJECT = add('Bolt knob', 'bolt', 'gunmetal',
                       taper(.013, .005, 0.0, 0.030, 12),
                       loc=(-0.114, BOLT_HOME_Y, 0.058), rot=(0, 0, math.pi / 2), bevel=0)
add('Bolt knob collar', 'bolt', 'gunmetal', washer(.0135, .0110, .004, 10, axis='X'),
    loc=(-0.1165, BOLT_HOME_Y, 0.058), bevel=0)
for index, x in enumerate((-0.122, -0.128, -0.134)):
    add(f'Bolt knob rib {index + 1}', 'bolt', 'rubber', washer(.0125, .0080, .003, 10, axis='X'),
        loc=(x, BOLT_HOME_Y, 0.058), bevel=0)

# ===========================================================================
# TRIGGER: blade, shoe and guard
# ===========================================================================
TRIGGER_OBJECT = add('Trigger blade', 'trigger', 'orange paint', boxv((.008, .016, .030)),
                     loc=(0, TRIGGER_Y, -0.053), bevel=.002)
add('Trigger shoe', 'trigger', 'orange paint', boxv((.010, .008, .012)),
    loc=(0, TRIGGER_Y + 0.004, -0.046), rot=(math.radians(8), 0, 0), bevel=.0015)
add('Trigger guard', 'trigger', 'gunmetal', solid(recty(0.060, 0.235, -0.105, -0.028), .032, 'X',
                                                  recty(0.075, 0.190, -0.090, -0.042)), bevel=.003)

# ===========================================================================
# EXTRA: the feed cover leaves (re-hung on the hinge pin at runtime) and the
# belt lead lying across the tray (its own origin-centred node)
# ===========================================================================
cover('Feed tray cover', 'gunmetal', boxv((.112, .216, .014)),
      loc=(0, 0.100, 0.144), bevel=.002)
for index, y in enumerate((0.040, 0.160)):
    cover(f'Feed cover rib {index + 1}', 'gunmetal', boxv((.090, .008, .004)),
          loc=(0, y, 0.150), bevel=0)
cover('Feed cover pawl housing', 'gunmetal', boxv((.030, .060, .005)),
      loc=(-0.030, 0.100, 0.1495), bevel=0)
cover('Feed cover latch', 'orange paint', boxv((.014, .040, .012)),
      loc=(-0.058, 0.020, 0.146), bevel=.0015)
cover('Feed cover latch tab', 'gunmetal', boxv((.010, .012, .008)),
      loc=(-0.066, 0.020, 0.147), bevel=.001)
cover('Feed cover pawl', 'gunmetal', boxv((.040, .020, .006)),
      loc=(-0.010, 0.100, 0.1345), bevel=0)
cover('Feed cover pawl rear', 'gunmetal', boxv((.040, .012, .006)),
      loc=(-0.010, 0.050, 0.1345), bevel=0)

# Belt lead: five linked rounds lying across the tray, fed from the left, the
# leading starter tab pointing right. Two origin-centred nodes (one per
# material) sharing the same authored translation.
LEAD_X = (-0.040, -0.020, 0.000, 0.020, 0.040)
add_local('Belt lead', 'extra', 'brass',
          [offset(tube(.0075, .052, 8, axis='Y'), dx=x) for x in LEAD_X],
          BELT_LEAD_HOME, props={'belt_lead': True})
add_local('Belt lead links', 'extra', 'gunmetal',
          [offset(boxv((.012, .022, .012)), dx=x) for x in (-0.050, -0.030, -0.010, 0.010, 0.030)]
          + [offset(boxv((.024, .018, .006)), dx=0.058)],
          BELT_LEAD_HOME, props={'belt_lead': True})

# Node names the delivered files must use verbatim.
CONTRACT_NODE_NAMES = set(GROUPS) | set(MARKERS)


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

for (key, value) in {'asset_id': 'bison',
                     'asset_name': 'BISON',
                     'game_forward': '-Z after glTF export',
                     'sight_height': SIGHT_Z,
                     'bore_radius': BORE_R,
                     'cover_hinge': list(COVER_HINGE),
                     'belt_lead_home': list(BELT_LEAD_HOME)}.items():
    scene[key] = value

# --- contract assertions ---------------------------------------------------
# Headless runs need an explicit view-layer sync before data-API-created
# objects show up in the dependency graph.
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()
extent = {0: [1e9, -1e9], 1: [1e9, -1e9], 2: [1e9, -1e9]}
points = []
for (obj, _part, _material) in PARTS + [(o, 'extra', 'brass') for o in ROUND_OBJECTS]:
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    for vertex in mesh.vertices:
        point = obj.matrix_world @ vertex.co
        points.append((point, obj.name, _part))
        for axis in range(3):
            extent[axis][0] = min(extent[axis][0], point[axis])
            extent[axis][1] = max(extent[axis][1], point[axis])
    evaluated.to_mesh_clear()

bore_object = BORE_OBJECT
band = [(p, n) for (p, n, _g) in points if HEAT_BAND[0] - 1e-9 <= p[1] <= HEAT_BAND[1] + 1e-9]
band_radius = max(math.hypot(p[0] - BORE_X, p[2] - BORE_Z) for (p, _n) in band)
band_foreign = sorted({n for (p, n) in band if n != bore_object.name
                       and math.hypot(p[0] - BORE_X, p[2] - BORE_Z) > BORE_R + 1e-6})
bore_points = [p for (p, n, _g) in points if n == bore_object.name]
bore_x = (min(p[0] for p in bore_points) + max(p[0] for p in bore_points)) / 2
bore_z = (min(p[2] for p in bore_points) + max(p[2] for p in bore_points)) / 2
tip = max(bore_points, key=lambda p: p[1])
tip_plane = sorted({round(p[1], 9) for (p, n, _g) in points if n == bore_object.name and p[1] > 0.71})
trigger_object = TRIGGER_OBJECT
trigger_low = min((trigger_object.matrix_world @ v.co)[2] for v in trigger_object.data.vertices)
bolt_handle = BOLT_KNOB_OBJECT
knob_far = min((bolt_handle.matrix_world @ v.co)[0] for v in bolt_handle.data.vertices)
# The closed cover and everything riding it must stay under the sight line, and
# nothing may sit on the line itself inside the sight channel |x| < 0.018
# between the ghost ring and the front hood (the ring's own hole is the line).
cover_top = max(p[2] for (p, n, g) in points if g == 'extra')
channel_hits = sorted({n for (p, n, _g) in points
                       if abs(p[0]) < 0.018 and SIGHT_Z - 0.0005 <= p[2] <= SIGHT_Z + 0.004
                       and -0.055 < p[1] < 0.700
                       and n not in ('Rear ghost ring', 'Front sight hood')})

CONTRACT = [
    ('muzzle_forward_vertex_y', tip[1], MUZZLE[1], 1e-6),
    ('muzzle_marker', MUZZLE[1], 0.720, 1e-9),
    ('bore_axis_x', bore_x, BORE_X, 1e-9),
    ('bore_axis_z', bore_z, BORE_Z, 1e-9),
    ('exposed_bore_radius_in_heat_band', band_radius, BORE_R, 1e-6),
    ('grip_marker_x', GRIP[0], 0.050, 1e-9),
    ('grip_marker_y', GRIP[1], 0.100, 1e-9),
    ('grip_marker_z', GRIP[2], 0.000, 1e-9),
    ('support_marker_x', SUPPORT[0], -0.060, 1e-9),
    ('support_marker_y', SUPPORT[1], 0.470, 1e-9),
    ('support_marker_z', SUPPORT[2], -0.012, 1e-9),
    ('sight_marker_y', SIGHT[1], -0.060, 1e-9),
    ('sight_axis_z', SIGHT[2], SIGHT_Z, 1e-9),
    ('trigger_blade_y', TRIGGER_Y, 0.130, 1e-9),
    ('trigger_blade_tip_z', trigger_low, TRIGGER_TIP_Z, 1e-6),
    ('bolt_handle_home_y', BOLT_HOME_Y, -BOLT_HOME_GAME_Z, 1e-9),
    ('bolt_knob_reach_x', knob_far, None, None),
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
if cover_top > COVER_TOP + 1e-6:
    contract_failures.append(f'closed feed cover reaches z={cover_top:.4f}, above the {COVER_TOP} ceiling')
if channel_hits:
    contract_failures.append(f'geometry across the 0.155 sight channel: {", ".join(channel_hits)}')

print(f'model extent x={extent[0][0]:+.4f}..{extent[0][1]:+.4f} '
      f'y={extent[1][0]:+.4f}..{extent[1][1]:+.4f} z={extent[2][0]:+.4f}..{extent[2][1]:+.4f}')
print(f'forward-most vertex ({tip[0]:+.6f}, {tip[1]:+.6f}, {tip[2]:+.6f}), muzzle plane rows {tip_plane}')
print(f'heat band z-radius max {band_radius:.6f} over {len(band)} vertices, '
      f'foreign geometry {band_foreign or "none"}')
print(f'bore axis measured ({bore_x:+.9f}, {bore_z:+.9f}); bolt knob reaches x={knob_far:+.4f}; '
      f'closed cover top z={cover_top:.4f}')
if contract_failures:
    print(f'CONTRACT FAILURES: {len(contract_failures)}')
    for line in contract_failures:
        print(f'  {line}')
else:
    print('anchor contract: all assertions pass')

# --- pack textures and save the editable source ----------------------------
bpy.ops.file.pack_all()
BLEND = DOCS / 'bison.blend'
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
CONTACT_ANCHOR = 'Receiver body'


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

GLB = DOCS / 'bison.glb'
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
            node.setdefault('extras', {})['blenderAsset'] = 'bison'
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
    'asset': 'BISON',
    'asset_id': 'bison',
    'kind': 'original belt-fed squad support prop (visual game asset)',
    'revision': 2,
    'blender': bpy.app.version_string,
    'authoring_script': 'tools/blender/bison/build-bison.py',
    'source_parts': len(PARTS),
    'animation_group_nodes': GROUPS,
    'marker_nodes': sorted(MARKERS),
    'batch_nodes': len(batches),
    'round_nodes': [obj.name for obj in round_objects],
    'cover_hinge_authoring': list(COVER_HINGE),
    'cover_hinge_game': [COVER_HINGE[0], COVER_HINGE[2], -COVER_HINGE[1]],
    'belt_lead_home_game': [BELT_LEAD_HOME[0], BELT_LEAD_HOME[2], -BELT_LEAD_HOME[1]],
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
                        'exposed_bore': [GUARD_END, MUZZLE[1]],
                        'heat_band': [-HEAT_BAND[1], -HEAT_BAND[0]],
                        'sight_height': SIGHT_Z,
                        'closed_cover_top': cover_top},
    'files': {'blend': 'docs/design/blender/bison/bison.blend',
              'glb': 'docs/design/blender/bison/bison.glb',
              'renders': ['render-hero.png', 'render-side.png', 'render-left.png',
                          'render-ads.png', 'render-rear.png'],
              'validation': 'docs/design/blender/bison/validation.json'},
    'build_time_checks': {
        'anchor_contract': 'muzzle plane, bore axis and exposed 0.0290 radius across '
                           'the whole heat band, all four markers, the 0.155 sight '
                           'line, the trigger blade and the bolt handle home position '
                           'are asserted against the runtime contract every build',
        'heat_band_clearance': 'no vertex other than the bore may enter the heat band',
        'sight_channel': 'the closed cover stays under z 0.152 and nothing but the '
                         'ghost ring and front hood touches the 0.155 line inside |x| < 0.018',
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
    'notes': ['Fresh design: no geometry reused from any other study.',
              'Six-prong birdcage past the heat band; the band itself stays bare metal.',
              'Markings are modelled geometry, not a texture decal.',
              'The feed cover leaves ship under extra and are re-hung on the authored '
              'hinge pin by public/js/guns/models/bison.js; the belt lead is its own '
              'origin-centred node so the reload can lift it out and lay it back in.',
              'The hanging belt belongs to the mag group and leaves with the spent box.',
              'Ghost-ring rear sight and hooded front post: the 0.155 line passes '
              'through both apertures with visible air around the marker.'],
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
