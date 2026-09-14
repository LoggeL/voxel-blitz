"""Author KESTREL revision 2, the VK-77 RAPTOR carbine for Voxel Blitz.

Second study revision of the `rifle` slot asset. Fresh geometry built from
scratch: no mesh or file from the first study (tools/blender/build-weapon.py,
docs/design/blender/kestrel/kestrel-r1.blend) is loaded. Only the low-level
authoring technique (closed convex primitives, analytic planar UVs, the six
shared ImageGen maps) and the frozen runtime interface (anchors, part nodes,
markers) carry over, because the game slot demands them.

Run headless (the repo's own convention for long Blender work; the MCP bridge
runs the same Blender Python underneath):

    blender --background --factory-startup --python build-kestrel.py

or through the live Blender MCP session (protocol 5) on 127.0.0.1:9876:

    from pathlib import Path
    p = Path('.../tools/blender/kestrel/build-kestrel.py')
    exec(compile(p.read_text(), str(p), 'exec'), {'__file__': str(p)})

The script is deterministic and self-contained. It creates its own scene,
builds there, and writes the .blend with `copy=True` so a live session keeps
pointing at whatever was open. Other scenes in the session are never touched.

Authoring space is Blender's own: +Y is the barrel/forward axis, +Z is up, +X
is right, which the glTF exporter turns into the game's -Z forward / +Y up /
+X right convention. Game-local coordinates relate to authoring coordinates by

    game_x = x,  game_y = z,  game_z = -y

Every frozen runtime anchor is written as a literal next to the geometry that
has to reach it, and asserted at build time (public/js/guns/defs.js
TIMERS.rifle, public/js/guns/models/common.js, shared/avatar-hands.js,
public/js/guns/models/kestrel.js):

    muzzle   (-0.012, 0.045, -0.598) -> y = 0.598, x = -0.012, z = 0.045
    bore axis x = -0.012, z = 0.045  -> exposed radius 0.0170 (BARREL_R 0.0175 - 0.0005)
    breech   rifle -0.32             -> y = 0.320 (bore starts behind this)
    heat band                        -> y = 0.460 .. 0.572 (breech + heatLen * 0.28)
    grip     (0.045, 0.015, -0.090)  -> y = 0.090, x = 0.045, z = 0.015
    support  (-0.055, 0.005, -0.400) -> y = 0.400, x = -0.055, z = 0.005
    sight    reflex axis 0.145       -> z = 0.145, the red dot at game (0, 0.145, -0.187)
    trigger  rifle -0.13             -> y = 0.130, blade tip z = -0.038
    bolt     home -0.035, travel 0.085 -> handle at y = 0.035, racks to y = -0.050

Design intent: a modern M4-class carbine. A slab upper receiver with an open
ejection port (the bolt carrier is seen moving through it), brass deflector,
hanging dust cover and forward assist; a full-length top rail carrying a
folded rear sight and the factory reflex sight; a left-side reciprocating
charging handle; a lower receiver with a flared magwell, selector, bolt catch
and magazine release; an open trigger guard; a raked pistol grip with texture
ribs and a rubber backstrap; an octagonal free-float M-LOK handguard with rail
slots, an amber ribbed rail cover and the gas tube inside; a low gas block
carrying an A-frame front sight post; a bare barrel across the heat band with
a six-prong birdcage; a curved 30-round magazine with witness ribs, a round
window and an amber baseplate; and a six-position collapsible stock on a
buffer tube with a cheek riser and rubber butt pad.

Animated parts follow the runtime contract in public/js/guns/models/kestrel.js
and public/js/guns/actions.js:

    body          static forms
    mag           the magazine (drops out and a fresh one enters on the reload path)
    bolt          bolt carrier and charging handle (reciprocates per shot, racked on reload)
    trigger       blade and guard (rotates about the gun origin on the pull)
    factory-optic the reflex sight, hidden whenever a replacement optic is fitted
    extra         empty for this slot (the mag reload needs no loose rounds)

Geometry is closed convex primitives (no booleans, no negative scales), then
chamfered by a bevel modifier; winding is repaired with recalc_face_normals and
UVs are an analytic per-face projection of the two non-dominant axes so the six
ImageGen maps tile at a constant real-world density. Every joint overlaps
volumetrically by >= 1 mm: butt-jointed flush faces z-fight once same-material
parts merge into one draw call.

Outputs (owned by this task):
    docs/design/blender/kestrel/kestrel.blend    editable, textures packed
    docs/design/blender/kestrel/kestrel.glb      portable GLB, images embedded
    docs/design/blender/kestrel/manifest.json    machine-readable record
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
DOCS = ROOT / 'docs/design/blender/kestrel'
INK = ROOT / 'public/assets/blender/textures'
DOCS.mkdir(parents=True, exist_ok=True)

ASSET = 'KESTREL'
SLUG = 'kestrel'
SCENE_NAME = f'{ASSET} | Voxel Blitz rifle study'
UV_SCALE = 3.6  # texture tiles per metre, constant across the whole model
GROUPS = ['body', 'mag', 'bolt', 'trigger', 'factory-optic', 'extra']

# --- frozen runtime anchors, in Blender authoring space --------------------
MUZZLE = (-0.012, 0.598, 0.045)     # game (-0.012, 0.045, -0.598)
GRIP = (0.045, 0.090, 0.015)        # game (0.045, 0.015, -0.090)
SUPPORT = (-0.055, 0.400, 0.005)    # game (-0.055, 0.005, -0.400)
SIGHT = (0.000, 0.187, 0.145)       # reflex dot, game (0, 0.145, -0.187)
MARKERS = {'muzzle': MUZZLE, 'grip': GRIP, 'support': SUPPORT, 'sight': SIGHT}

BORE_X, BORE_Z = -0.012, 0.045  # bore axis (TIMERS.rifle.muzzle x/y)
BORE_R = 0.0170                 # exposed bore radius = BARREL_R.rifle - 0.0005
BORE_IN = 0.0095                # muzzle mouth recess radius
BORE_START = 0.230              # buried in the upper receiver
GUARD_END = 0.417               # handguard front cap ends: gas block and bare barrel past here
HEAT_BAND = (0.460, 0.572)      # game z -0.460 .. -0.572 (breech 0.32 + heatLen * 0.28)
BREECH_Y = 0.320                # BREACH_Z.rifle -0.32
SIGHT_Z = 0.145                 # kestrel.js sightHeight / adsOffset.y
TRIGGER_Y, TRIGGER_TIP_Z = 0.130, -0.038   # TRIGGER_Z.rifle -0.13
BOLT_HOME_GAME_Z = -0.035       # BOLT_HOME.rifle
BOLT_HOME_Y = -BOLT_HOME_GAME_Z  # the same point in authoring space
BOLT_TRAVEL = 0.085             # TIMERS.rifle.boltTravel

# Receiver centreline. The bore sits 6 mm left of it (the contract muzzle is
# at x = -0.012); the sights stay on x = 0 where the ADS camera looks.
CX = -0.006

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
scene.cycles.seed = 20260915
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'
scene.world = bpy.data.worlds.new(f'{ASSET} studio world')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.14, .17, .21, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .35

# --- materials -------------------------------------------------------------
# Carbine two-tone: blackened aluminium receivers and rail over dark polymer
# furniture, petrol optic housing and rail cover, amber accents. All reuse the
# delivered maps with multiply tints (no new images); the export stage swaps
# the palette maps in by material name (tools/blender/material-library.py).
MATERIALS = [
    ('gunmetal', 'worn-gunmetal', .50, .35, (.34, .34, .36)),
    ('polymer', 'worn-rubber', .05, .70, (.40, .41, .43)),
    ('petrol paint', 'petrol-ballistic-fabric', .10, .55, (.62, .72, .74)),
    ('orange paint', 'orange-painted-metal', .12, .50, (.95, .93, .90)),
    ('ivory coating', 'ivory-armor', .04, .45, (.96, .95, .92)),
    ('rubber', 'worn-rubber', 0, .90, (.62, .63, .65)),
    ('brass', 'worn-gunmetal', .65, .45, (.72, .58, .30)),
    ('optic glass', 'worn-gunmetal', 0, .10, (.18, .58, .65)),
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
    if name == 'optic glass':
        bsdf.inputs['Alpha'].default_value = .18
        material.blend_method = 'BLEND'
        material['glass'] = True
        material['gltf_tint'] = list(tint)
        mats[name] = material
        continue
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


def octagon(half_w, half_h, chamfer):
    """An (x, z) octagon for solid(..., 'Y'): a chamfered handguard section."""
    return [(-half_w + chamfer, -half_h), (half_w - chamfer, -half_h),
            (half_w, -half_h + chamfer), (half_w, half_h - chamfer),
            (half_w - chamfer, half_h), (-half_w + chamfer, half_h),
            (-half_w, half_h - chamfer), (-half_w, -half_h + chamfer)]


def tube(radius, length, segments=12, axis='Y'):
    """Closed cylinder along an axis, centred on the origin."""
    return solid(circle(radius, segments), length, axis)


def washer(outer, inner, length, segments=12, axis='Y'):
    """Closed annulus: the primitive whose hole is meant to be seen through."""
    return solid(circle(outer, segments), length, axis, circle(inner, segments))


def tube_stacked(radius, y0, y1, step=0.02, segments=24, radius1=None):
    """Closed Y-cylinder with lengthwise ring subdivisions.

    Plain tube() only carries vertices at its end caps, which leaves spans
    like the heat band with nothing to measure. Rings every `step` keep every
    audit honest while the silhouette stays a perfect cylinder.
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
        bevel=.0025, uv_scale=UV_SCALE, props=None):
    """Create one chamfered, UV-mapped part."""
    (verts, faces) = shape
    mesh = bpy.data.meshes.new(f'{name} shell')
    mesh.from_pydata(verts, [], faces)
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
    obj['kestrel_material'] = material
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


def pair(name, part, material, shape, loc=(0, 0, 0), rot=(0, 0, 0), bevel=.0025, about=CX):
    """Mirror a part across the receiver centreline x = `about`."""
    add(f'{name} right', part, material, shape, loc=loc, rot=rot, bevel=bevel)
    add(f'{name} left', part, material, shape,
        loc=(2 * about - loc[0], loc[1], loc[2]), rot=(rot[0], -rot[1], -rot[2]), bevel=bevel)


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
    label['kestrel_material'] = material
    label.parent = PART_GROUP[part]
    project_uvs(label.data)
    PARTS.append((label, part, material))
    return label


# ===========================================================================
# BODY / upper receiver: slab walls with an open ejection port on the right
# and a charging-handle slot on the left, deck, floor, end plates, barrel nut
# ===========================================================================
UPPER_Y0, UPPER_Y1 = -0.045, 0.240
UPPER_Z0, UPPER_Z1 = 0.012, 0.092
PORT = recty(0.050, 0.135, 0.028, 0.068)            # ejection port cut-out
SLOT = recty(BOLT_HOME_Y - BOLT_TRAVEL - 0.008, BOLT_HOME_Y + 0.008, 0.050, 0.070)
add('Upper receiver right wall', 'body', 'gunmetal',
    solid(recty(UPPER_Y0, UPPER_Y1, UPPER_Z0, UPPER_Z1), .008, 'X', PORT),
    loc=(CX + 0.028, 0, 0), bevel=.002)
add('Upper receiver left wall', 'body', 'gunmetal',
    solid(recty(UPPER_Y0, UPPER_Y1, UPPER_Z0, UPPER_Z1), .008, 'X', SLOT),
    loc=(CX - 0.028, 0, 0), bevel=.002)
add('Upper receiver deck', 'body', 'gunmetal', boxv((.066, .288, .013)),
    loc=(CX, 0.0975, 0.0865), bevel=.003)
add('Upper receiver floor', 'body', 'gunmetal', boxv((.060, .286, .012)),
    loc=(CX, 0.0975, 0.017), bevel=.002)
add('Upper receiver rear plate', 'body', 'gunmetal', boxv((.058, .011, .070)),
    loc=(CX, -0.039, 0.052), bevel=.002)
add('Upper receiver front plate', 'body', 'gunmetal', boxv((.058, .010, .070)),
    loc=(CX, 0.236, 0.052), bevel=.002)
add('Barrel nut', 'body', 'gunmetal', tube(.033, .016, 16), loc=(CX, 0.244, 0.050), bevel=.002)
# Brass deflector: a wedge in top view, standing behind the port on the wall.
add('Brass deflector', 'body', 'gunmetal',
    solid([(0.031, 0.134), (0.044, 0.146), (0.044, 0.158), (0.031, 0.172)], .046, 'Z'),
    loc=(CX, 0, 0.050), bevel=.002)
# Dust cover hinged along the port's lower edge, hanging open.
add('Dust cover hinge pin', 'body', 'gunmetal', tube(.003, .092, 8, axis='Y'),
    loc=(CX + 0.033, 0.0925, 0.027), bevel=0)
add('Dust cover', 'body', 'gunmetal', boxv((.003, .086, .034)),
    loc=(CX + 0.033 + 0.017 * math.sin(2.5), 0.0925, 0.027 + 0.017 * math.cos(2.5)),
    rot=(0, 2.5, 0), bevel=.001)
add('Forward assist housing', 'body', 'gunmetal', boxv((.012, .032, .026)),
    loc=(CX + 0.033, 0.024, 0.060), bevel=.002)
add('Forward assist', 'body', 'gunmetal', tube(.009, .014, 10, axis='X'),
    loc=(CX + 0.040, 0.014, 0.060), bevel=.001)
add('Serial plate', 'body', 'ivory coating', boxv((.003, .034, .012)),
    loc=(CX + 0.0325, 0.196, 0.050), bevel=0)

# Full-length top rail: base and lugs over the receiver deck.
add('Top rail base', 'body', 'gunmetal', boxv((.044, .284, .008)),
    loc=(CX, 0.0975, 0.096), bevel=.001)
for index in range(18):
    add(f'Rail lug {index + 1}', 'body', 'gunmetal', boxv((.046, .009, .006)),
        loc=(CX, -0.038 + 0.016 * index, 0.1025), bevel=0)

# Folding rear sight, stowed flat at the rear of the rail (x = 0: the ADS axis).
add('Rear sight base', 'body', 'gunmetal', boxv((.036, .040, .010)),
    loc=(0, -0.020, 0.1095), bevel=.0015)
add('Rear sight leaf', 'body', 'gunmetal', boxv((.030, .036, .006)),
    loc=(0, -0.020, 0.117), bevel=.001)
add('Rear sight aperture', 'body', 'gunmetal', washer(.006, .003, .004, 12, axis='Z'),
    loc=(0, -0.028, 0.121), bevel=0)
add('Rear sight hinge pin', 'body', 'gunmetal', tube(.003, .040, 8, axis='X'),
    loc=(0, -0.003, 0.116), bevel=0)
add('Rear sight detent', 'body', 'orange paint', boxv((.008, .006, .004)),
    loc=(0.014, -0.036, 0.1215), bevel=0)

# ===========================================================================
# BODY / lower receiver: trigger housing, flared magwell, controls, pins
# ===========================================================================
add('Lower receiver', 'body', 'gunmetal', prism([
    (-0.040, 0.014), (0.152, 0.014), (0.152, -0.032), (0.010, -0.032), (-0.040, -0.008)], .058),
    loc=(CX, 0, 0), bevel=.003)
add('Magwell', 'body', 'gunmetal', prism([
    (0.148, 0.015), (0.240, 0.015), (0.246, -0.052), (0.150, -0.052)], .061),
    loc=(CX, 0, 0), bevel=.003)
add('Magwell flare', 'body', 'gunmetal', boxv((.064, .100, .006)),
    loc=(CX, 0.198, -0.052), bevel=.0015)
add('Rear takedown pin', 'body', 'gunmetal', tube(.005, .064, 10, axis='X'),
    loc=(CX, 0.000, 0.004), bevel=0)
add('Front pivot pin', 'body', 'gunmetal', tube(.005, .066, 10, axis='X'),
    loc=(CX, 0.192, 0.004), bevel=0)
add('Selector pivot', 'body', 'gunmetal', tube(.007, .006, 10, axis='X'),
    loc=(CX - 0.031, 0.046, 0.001), bevel=0)
add('Selector lever', 'body', 'orange paint', boxv((.006, .034, .010)),
    loc=(CX - 0.0315, 0.058, 0.001), bevel=.001)
add('Bolt catch', 'body', 'gunmetal', boxv((.006, .014, .026)),
    loc=(CX - 0.032, 0.160, 0.001), bevel=.001)
add('Bolt catch button', 'body', 'orange paint', boxv((.004, .010, .010)),
    loc=(CX - 0.036, 0.160, 0.008), bevel=0)
add('Magazine release', 'body', 'orange paint', tube(.008, .010, 10, axis='X'),
    loc=(CX + 0.026, 0.146, -0.006), bevel=0)
add('Magazine release fence', 'body', 'gunmetal', boxv((.006, .006, .024)),
    loc=(CX + 0.030, 0.136, -0.006), bevel=0)
add('Trigger pin', 'body', 'gunmetal', tube(.004, .060, 8, axis='X'),
    loc=(CX, 0.118, -0.002), bevel=0)

# ===========================================================================
# BODY / pistol grip: raked polymer grip around the grip marker, rubber
# backstrap, finger ridges, side texture ribs, amber base plug
# ===========================================================================
add('Pistol grip', 'body', 'polymer', prism([
    (0.048, 0.010), (0.112, 0.010), (0.118, -0.010), (0.082, -0.100), (0.076, -0.122),
    (0.028, -0.122), (0.032, -0.090), (0.046, -0.030)], .040), loc=(0, 0, 0), bevel=.005)
add('Grip backstrap', 'body', 'rubber', boxv((.036, .008, .080)),
    loc=(0, 0.036, -0.060), rot=(-0.23, 0, 0), bevel=.002)
for index, (y, z) in enumerate(((0.110, -0.037), (0.100, -0.061), (0.090, -0.085))):
    add(f'Grip finger ridge {index + 1}', 'body', 'rubber', boxv((.044, .010, .006)),
        loc=(0, y, z), bevel=.001)
for index, (y, z) in enumerate(((0.078, -0.045), (0.072, -0.060), (0.066, -0.075),
                                (0.060, -0.090), (0.055, -0.105))):
    pair(f'Grip texture rib {index + 1}', 'body', 'rubber', boxv((.003, .026, .004)),
         loc=(0.0205, y, z), bevel=0, about=0)
add('Grip base plug', 'body', 'orange paint', boxv((.044, .052, .008)),
    loc=(0, 0.052, -0.124), bevel=.002)
add('Grip screw', 'body', 'gunmetal', tube(.005, .046, 10, axis='X'),
    loc=(0, 0.070, -0.040), bevel=0)

# ===========================================================================
# BODY / stock: buffer tube with castle nut and position notches, six-position
# polymer stock with cheek riser, rubber butt pad, release lever, sling points
# ===========================================================================
add('Buffer tube', 'body', 'gunmetal', tube(.017, .262, 16), loc=(CX, -0.171, 0.045), bevel=.001)
add('Receiver end plate', 'body', 'gunmetal', boxv((.050, .007, .060)),
    loc=(CX, -0.0495, 0.045), bevel=.001)
add('Castle nut', 'body', 'gunmetal', tube(.021, .012, 16), loc=(CX, -0.050, 0.045), bevel=.001)
for index, y in enumerate((-0.100, -0.130, -0.160, -0.190, -0.220)):
    add(f'Stock notch {index + 1}', 'body', 'rubber', boxv((.008, .008, .004)),
        loc=(CX, y, 0.028), bevel=0)
add('Stock sleeve', 'body', 'polymer', prism([
    (-0.165, 0.068), (-0.165, 0.024), (-0.235, 0.020), (-0.235, 0.070)], .040),
    loc=(CX, 0, 0), bevel=.003)
add('Stock body', 'body', 'polymer', prism([
    (-0.225, 0.070), (-0.225, 0.022), (-0.262, 0.010), (-0.300, -0.006), (-0.316, -0.010),
    (-0.316, 0.086), (-0.250, 0.082)], .044), loc=(CX, 0, 0), bevel=.004)
add('Cheek riser', 'body', 'rubber', boxv((.040, .070, .010)),
    loc=(CX, -0.276, 0.088), bevel=.002)
add('Butt pad', 'body', 'rubber', boxv((.046, .016, .104)),
    loc=(CX, -0.322, 0.038), bevel=.003)
for index, z in enumerate((0.000, 0.025, 0.050, 0.075)):
    add(f'Butt pad rib {index + 1}', 'body', 'rubber', boxv((.048, .004, .005)),
        loc=(CX, -0.331, z), bevel=0)
add('Stock release lever', 'body', 'orange paint', boxv((.024, .040, .008)),
    loc=(CX, -0.212, 0.019), bevel=.0015)
add('Stock release pin', 'body', 'gunmetal', tube(.004, .030, 8, axis='X'),
    loc=(CX, -0.200, 0.021), bevel=0)
add('Stock QD socket', 'body', 'gunmetal', washer(.008, .004, .005, 12, axis='X'),
    loc=(CX - 0.0235, -0.260, 0.040), bevel=0)
add('Rear sling loop', 'body', 'gunmetal', washer(.009, .005, .006, 12, axis='X'),
    loc=(CX, -0.300, -0.004), bevel=0)

# ===========================================================================
# BODY / handguard: octagonal free-float M-LOK tube with rail base and lugs,
# slots on every facet, an amber ribbed rail cover on the support side, barrel
# nut and front cap, the gas tube inside, a QD socket on the right
# ===========================================================================
GUARD_Y0, GUARD_Y1 = 0.245, 0.410
GUARD_C = (CX, (GUARD_Y0 + GUARD_Y1) / 2, 0.050)
add('Handguard', 'body', 'gunmetal',
    solid(octagon(.034, .043, .016), GUARD_Y1 - GUARD_Y0, 'Y', octagon(.024, .030, .011)),
    loc=GUARD_C, bevel=.002)
add('Handguard front cap', 'body', 'gunmetal',
    solid(octagon(.031, .040, .015), .008, 'Y', octagon(.020, .020, .008)),
    loc=(CX, 0.413, 0.050), bevel=.001)
add('Guard rail base', 'body', 'gunmetal', boxv((.044, .160, .008)),
    loc=(CX, GUARD_C[1], 0.096), bevel=.001)
for index in range(10):
    add(f'Guard rail lug {index + 1}', 'body', 'gunmetal', boxv((.046, .009, .006)),
        loc=(CX, 0.256 + 0.016 * index, 0.1025), bevel=0)
SLOT_STATIONS = (0.268, 0.302, 0.336, 0.370)
FACETS = {  # facet: (x, z) of its midpoint from the guard centre, rotation about Y
    'upper right': ((0.026, 0.035), -math.pi / 4),
    'upper left': ((-0.026, 0.035), 3 * math.pi / 4),
    'lower right': ((0.026, -0.035), math.pi / 4),
    'lower left': ((-0.026, -0.035), -3 * math.pi / 4),
    'right': ((0.034, 0.0), 0.0),
    'bottom': ((0.0, -0.043), math.pi / 2),
}
for facet, ((fx, fz), turn) in FACETS.items():
    for index, y in enumerate(SLOT_STATIONS):
        add(f'M-LOK slot {facet} {index + 1}', 'body', 'rubber', boxv((.004, .026, .010)),
            loc=(CX + fx, y, 0.050 + fz), rot=(0, turn, 0), bevel=0)
for index, y in enumerate(SLOT_STATIONS[2:]):
    add(f'M-LOK slot left {index + 1}', 'body', 'rubber', boxv((.004, .026, .010)),
        loc=(CX - 0.034, y + 0.010, 0.050), bevel=0)
add('Rail cover', 'body', 'orange paint', boxv((.006, .074, .028)),
    loc=(CX - 0.0355, 0.293, 0.050), bevel=.0015)
for index in range(4):
    add(f'Rail cover rib {index + 1}', 'body', 'rubber', boxv((.003, .006, .030)),
        loc=(CX - 0.0385, 0.266 + 0.018 * index, 0.050), bevel=0)
add('Guard QD socket', 'body', 'gunmetal', washer(.007, .0035, .004, 12, axis='X'),
    loc=(CX + 0.0345, 0.395, 0.060), bevel=0)
add('Gas tube', 'body', 'gunmetal', tube(.005, .190, 8), loc=(BORE_X, 0.335, 0.070), bevel=0)

# ===========================================================================
# BODY / gas block with an A-frame front sight post (post on x = 0)
# ===========================================================================
add('Gas block', 'body', 'gunmetal', boxv((.036, .036, .050)),
    loc=(BORE_X, 0.434, 0.047), bevel=.002)
add('Gas block pin', 'body', 'gunmetal', tube(.003, .040, 8, axis='X'),
    loc=(BORE_X, 0.440, 0.030), bevel=0)
add('Front sight base', 'body', 'gunmetal', boxv((.030, .026, .016)),
    loc=(0, 0.436, 0.078), bevel=.0015)
add('Front sight leg right', 'body', 'gunmetal', boxv((.006, .020, .040)),
    loc=(0.009, 0.436, 0.102), rot=(0, -0.30, 0), bevel=.001)
add('Front sight leg left', 'body', 'gunmetal', boxv((.006, .020, .040)),
    loc=(-0.009, 0.436, 0.102), rot=(0, 0.30, 0), bevel=.001)
add('Front sight housing', 'body', 'gunmetal', boxv((.020, .014, .014)),
    loc=(0, 0.436, 0.118), bevel=.001)
add('Front sight post', 'body', 'orange paint', boxv((.005, .005, .032)),
    loc=(0, 0.436, SIGHT_Z - 0.016), bevel=0)
add('Front sight wing right', 'body', 'gunmetal', boxv((.004, .012, .036)),
    loc=(0.011, 0.436, 0.134), bevel=0)
add('Front sight wing left', 'body', 'gunmetal', boxv((.004, .012, .036)),
    loc=(-0.011, 0.436, 0.134), bevel=0)

# ===========================================================================
# BODY / barrel: bare 0.0170 bore from the receiver to the crown, muzzle
# recess, six-prong birdcage past the heat band
# ===========================================================================
BORE_OBJECT = add('Barrel', 'body', 'gunmetal', merge_shapes([
    tube_stacked(BORE_R, BORE_START, 0.594, step=0.02, segments=24),
    offset(washer(BORE_R, 0.010, 0.008, 24), dy=0.594, dz=BORE_Z),
]), loc=(BORE_X, 0, 0), bevel=0)
add('Muzzle mouth', 'body', 'rubber', tube(BORE_IN, .005, 16),
    loc=(BORE_X, 0.5945, BORE_Z), bevel=0)
add('Flash hider base ring', 'body', 'gunmetal', washer(.024, .016, .010, 16),
    loc=(BORE_X, 0.5775, BORE_Z), bevel=0)
for index in range(6):
    angle = math.pi / 6 + index * math.pi / 3
    add(f'Flash hider prong {index + 1}', 'body', 'gunmetal', boxv((.008, .016, .008)),
        loc=(BORE_X + .021 * math.cos(angle), 0.589, BORE_Z + .021 * math.sin(angle)),
        rot=(angle - math.pi / 2, 0, 0), bevel=0)
add('Flash hider front ring', 'body', 'gunmetal', washer(.024, .014, .004, 16),
    loc=(BORE_X, 0.5955, BORE_Z), bevel=0)

# Markings: modelled geometry on the magwell flanks and the upper's left wall.
add_text('VK-77', 'Marking VK-77 left', 'body', 'ivory coating',
         (CX - 0.0305, 0.196, -0.020), (math.pi / 2, 0, -math.pi / 2), .012)
add_text('RAPTOR', 'Marking RAPTOR right', 'body', 'ivory coating',
         (CX + 0.0305, 0.196, -0.020), (math.pi / 2, 0, math.pi / 2), .010)
add_text('VB 07', 'Marking VB 07 left', 'body', 'ivory coating',
         (CX - 0.0325, 0.005, 0.030), (math.pi / 2, 0, -math.pi / 2), .008)

# ===========================================================================
# MAGAZINE: curved 30-round box in three segments (each a half-degree wider
# so no flank is coplanar), witness ribs, round-count window with brass,
# amber baseplate with a rubber pull lip
# ===========================================================================
add('Magazine upper', 'mag', 'polymer', boxv((.040, .062, .068)),
    loc=(CX, 0.196, -0.022), bevel=.003)
add('Magazine middle', 'mag', 'polymer', boxv((.0405, .062, .060)),
    loc=(CX, 0.202, -0.080), rot=(0.10, 0, 0), bevel=.003)
add('Magazine lower', 'mag', 'polymer', boxv((.041, .062, .052)),
    loc=(CX, 0.212, -0.130), rot=(0.20, 0, 0), bevel=.003)
for index, y in enumerate((0.183, 0.197, 0.211, 0.225)):
    pair(f'Magazine middle rib {index + 1}', 'mag', 'polymer', boxv((.004, .004, .048)),
         loc=(CX + 0.0215 + 0.0002 * (index % 2), y, -0.080), rot=(0.10, 0, 0), bevel=0)
for index, y in enumerate((0.198, 0.212, 0.226)):
    pair(f'Magazine lower rib {index + 1}', 'mag', 'polymer', boxv((.004, .004, .040)),
         loc=(CX + 0.0218 + 0.0002 * (index % 2), y, -0.130), rot=(0.20, 0, 0), bevel=0)
add('Round window', 'mag', 'rubber', boxv((.002, .008, .044)),
    loc=(CX + 0.0212, 0.174, -0.080), rot=(0.10, 0, 0), bevel=0)
for index, z in enumerate((-0.068, -0.080, -0.092)):
    add(f'Witness round {index + 1}', 'mag', 'brass', tube(.003, .010, 8, axis='Y'),
        loc=(CX + 0.0215, 0.174 + 0.10 * (0.080 + z), z), rot=(0.10, 0, 0), bevel=0)
BASE_C = (CX, 0.212 + 0.029 * math.sin(0.20), -0.130 - 0.029 * math.cos(0.20))
add('Magazine baseplate', 'mag', 'orange paint', boxv((.044, .066, .010)),
    loc=BASE_C, rot=(0.20, 0, 0), bevel=.002)
add('Baseplate lip', 'mag', 'rubber', boxv((.030, .012, .008)),
    loc=(CX, BASE_C[1] + 0.034 * math.cos(0.20), BASE_C[2] + 0.034 * math.sin(0.20)),
    rot=(0.20, 0, 0), bevel=.001)

# ===========================================================================
# BOLT: carrier seen through the ejection port, bolt head, left-side charging
# handle with a ribbed knob and an amber latch
# ===========================================================================
add('Bolt carrier', 'bolt', 'gunmetal', tube(.015, .200, 16), loc=(BORE_X, 0.050, BORE_Z), bevel=.001)
add('Bolt head', 'bolt', 'gunmetal', tube(.012, .018, 12), loc=(BORE_X, 0.158, BORE_Z), bevel=.001)
add('Carrier cam pin', 'bolt', 'gunmetal', tube(.004, .006, 8, axis='X'),
    loc=(BORE_X + 0.015, 0.095, 0.050), bevel=0)
add('Charging handle stem', 'bolt', 'gunmetal', boxv((.042, .010, .016)),
    loc=(-0.041, BOLT_HOME_Y, 0.060), bevel=.001)
BOLT_KNOB_OBJECT = add('Charging handle knob', 'bolt', 'gunmetal', boxv((.014, .034, .024)),
                       loc=(-0.067, BOLT_HOME_Y, 0.060), bevel=.002)
for index, z in enumerate((0.052, 0.060, 0.068)):
    add(f'Charging handle rib {index + 1}', 'bolt', 'rubber', boxv((.004, .036, .004)),
        loc=(-0.0745, BOLT_HOME_Y, z), bevel=0)
add('Charging handle latch', 'bolt', 'orange paint', boxv((.008, .012, .010)),
    loc=(-0.066, BOLT_HOME_Y + 0.021, 0.060), bevel=.001)

# ===========================================================================
# TRIGGER: amber blade and open guard
# ===========================================================================
TRIGGER_OBJECT = add('Trigger blade', 'trigger', 'orange paint', boxv((.008, .012, .032)),
                     loc=(CX, TRIGGER_Y, -0.022), bevel=.0015)
add('Trigger guard', 'trigger', 'gunmetal',
    solid(recty(0.092, 0.178, -0.054, -0.014), .012, 'X', recty(0.100, 0.170, -0.046, -0.022)),
    loc=(CX, 0, 0), bevel=.002)

# ===========================================================================
# FACTORY OPTIC: open-frame reflex sight on a rail mount, window centred on
# the 0.145 line, lens at the front, emitter inside, battery cap and buttons
# ===========================================================================
add('Reflex mount base', 'factory-optic', 'gunmetal', boxv((.040, .076, .012)),
    loc=(0, 0.187, 0.110), bevel=.0015)
add('Reflex mount clamp', 'factory-optic', 'gunmetal', boxv((.010, .030, .014)),
    loc=(0.0212, 0.187, 0.105), bevel=.001)
add('Reflex clamp bolt', 'factory-optic', 'gunmetal', tube(.004, .006, 8, axis='X'),
    loc=(0.026, 0.187, 0.104), bevel=0)
add('Reflex housing floor', 'factory-optic', 'petrol paint', boxv((.046, .044, .008)),
    loc=(0, 0.187, 0.119), bevel=.0015)
add('Reflex housing side right', 'factory-optic', 'petrol paint', boxv((.005, .046, .048)),
    loc=(0.0225, 0.187, 0.146), bevel=.0015)
add('Reflex housing side left', 'factory-optic', 'petrol paint', boxv((.005, .046, .048)),
    loc=(-0.0225, 0.187, 0.146), bevel=.0015)
add('Reflex hood', 'factory-optic', 'petrol paint', boxv((.051, .044, .006)),
    loc=(0, 0.187, 0.170), bevel=.0015)
add('Reflex lens', 'factory-optic', 'optic glass', boxv((.039, .003, .045)),
    loc=(0, 0.2035, SIGHT_Z), bevel=0)
add('Reflex emitter', 'factory-optic', 'gunmetal', boxv((.012, .010, .006)),
    loc=(0, 0.172, 0.125), bevel=0)
add('Reflex battery cap', 'factory-optic', 'gunmetal', tube(.009, .006, 12, axis='X'),
    loc=(0.027, 0.180, 0.140), bevel=.0005)
for index, y in enumerate((0.176, 0.192)):
    add(f'Reflex brightness button {index + 1}', 'factory-optic', 'orange paint',
        boxv((.004, .008, .008)), loc=(-0.026, y, 0.150), bevel=0)

# Node names the delivered files must use verbatim.
CONTRACT_NODE_NAMES = set(GROUPS) | set(MARKERS)


def contract_node_name(name):
    head, _, tail = name.rpartition('.')
    if tail.isdigit() and len(tail) == 3 and head in CONTRACT_NODE_NAMES:
        return head
    return name


def base_name(name):
    """Object name without Blender's numeric suffix."""
    head, _, tail = name.rpartition('.')
    return head if tail.isdigit() and len(tail) == 3 else name


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

for (key, value) in {'asset_id': SLUG,
                     'asset_name': ASSET,
                     'revision': 2,
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
for (obj, _part, _material) in PARTS:
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
forward_most = max(points, key=lambda entry: entry[0][1])
trigger_object = TRIGGER_OBJECT
trigger_low = min((trigger_object.matrix_world @ v.co)[2] for v in trigger_object.data.vertices)
bolt_handle = BOLT_KNOB_OBJECT
knob_far = min((bolt_handle.matrix_world @ v.co)[0] for v in bolt_handle.data.vertices)
# Nothing but the sights may sit on the sight line inside the channel
# |x| < 0.018 between the receiver rear and the muzzle: the reflex lens is
# the window the eye looks through, the front post and its wings are the
# co-witnessed iron.
SIGHT_PARTS = {'Reflex lens', 'Front sight post', 'Front sight wing right', 'Front sight wing left'}
channel_hits = sorted({n for (p, n, _g) in points
                       if abs(p[0]) < 0.018 and SIGHT_Z - 0.0005 <= p[2] <= SIGHT_Z + 0.004
                       and -0.050 < p[1] < 0.600
                       and base_name(n) not in SIGHT_PARTS})
# The stowed rear sight and everything on the rail behind the reflex must stay
# under the window so the ADS picture is the reflex, not a folded leaf.
rail_rear_top = max(p[2] for (p, n, g) in points
                    if g == 'body' and p[1] < 0.149 and p[1] > -0.045 and abs(p[0]) < 0.026)
# The hands must land on authored surfaces: the grip palm sits just outboard
# of the grip's right flank and the support palm just under the guard's
# lower-left chamfer.
grip_points = [p for (p, n, _g) in points if n == 'Pistol grip']
grip_right = max(p[0] for p in grip_points)
guard_points = [p for (p, n, _g) in points if n == 'Handguard']
guard_low = min(p[2] for p in guard_points)
optic_points = [p for (p, n, g) in points if g == 'factory-optic']
optic_bottom = min(p[2] for p in optic_points)

CONTRACT = [
    ('muzzle_forward_vertex_y', tip[1], MUZZLE[1], 1e-6),
    ('model_forward_most_y', forward_most[0][1], MUZZLE[1], 1e-6),
    ('muzzle_marker', MUZZLE[1], 0.598, 1e-9),
    ('bore_axis_x', bore_x, BORE_X, 1e-9),
    ('bore_axis_z', bore_z, BORE_Z, 1e-9),
    ('exposed_bore_radius_in_heat_band', band_radius, BORE_R, 1e-6),
    ('grip_marker_x', GRIP[0], 0.045, 1e-9),
    ('grip_marker_y', GRIP[1], 0.090, 1e-9),
    ('grip_marker_z', GRIP[2], 0.015, 1e-9),
    ('support_marker_x', SUPPORT[0], -0.055, 1e-9),
    ('support_marker_y', SUPPORT[1], 0.400, 1e-9),
    ('support_marker_z', SUPPORT[2], 0.005, 1e-9),
    ('sight_marker_y', SIGHT[1], 0.187, 1e-9),
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
if channel_hits:
    contract_failures.append(f'geometry across the 0.145 sight channel: {", ".join(channel_hits)}')
if rail_rear_top > 0.125 + 1e-6:
    contract_failures.append(f'rail furniture behind the reflex reaches z={rail_rear_top:.4f} (ceiling 0.125)')
if not (0.010 <= grip_right <= 0.030):
    contract_failures.append(f'grip right flank at x={grip_right:.4f}: the 0.045 palm would float or sink')
if not (-0.010 <= guard_low - SUPPORT[2] <= 0.012):
    contract_failures.append(f'handguard underside at z={guard_low:.4f} vs support palm z={SUPPORT[2]}')
if optic_bottom < 0.095:
    contract_failures.append(f'factory optic reaches down to z={optic_bottom:.4f}, into the rail')

print(f'model extent x={extent[0][0]:+.4f}..{extent[0][1]:+.4f} '
      f'y={extent[1][0]:+.4f}..{extent[1][1]:+.4f} z={extent[2][0]:+.4f}..{extent[2][1]:+.4f}')
print(f'forward-most vertex ({tip[0]:+.6f}, {tip[1]:+.6f}, {tip[2]:+.6f}) on {forward_most[1]}')
print(f'heat band z-radius max {band_radius:.6f} over {len(band)} vertices, '
      f'foreign geometry {band_foreign or "none"}')
print(f'bore axis measured ({bore_x:+.9f}, {bore_z:+.9f}); bolt knob reaches x={knob_far:+.4f}; '
      f'rail furniture behind the reflex tops at z={rail_rear_top:.4f}; grip flank x={grip_right:.4f}; '
      f'guard underside z={guard_low:.4f}')
if contract_failures:
    print(f'CONTRACT FAILURES: {len(contract_failures)}')
    for line in contract_failures:
        print(f'  {line}')
else:
    print('anchor contract: all assertions pass')

# --- pack textures and save the editable source ----------------------------
bpy.ops.file.pack_all()
BLEND = DOCS / 'kestrel.blend'
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
CONTACT_ANCHOR = 'Lower receiver'


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

GLB = DOCS / 'kestrel.glb'
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
    offset_bytes = 12
    while offset_bytes < total:
        (length, kind) = struct.unpack('<II', raw[offset_bytes:offset_bytes + 8])
        chunks.append([kind, raw[offset_bytes + 8:offset_bytes + 8 + length]])
        offset_bytes += 8 + length
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
            node.setdefault('extras', {})['blenderAsset'] = SLUG
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
manifest = {
    'asset': ASSET,
    'asset_id': SLUG,
    'kind': 'original assault carbine (visual game asset, rifle slot)',
    'revision': 2,
    'blender': bpy.app.version_string,
    'authoring_script': 'tools/blender/kestrel/build-kestrel.py',
    'source_parts': len(PARTS),
    'animation_group_nodes': GROUPS,
    'marker_nodes': sorted(MARKERS),
    'batch_nodes': len(batches),
    'triangles': triangles,
    'triangles_per_primitive': per_primitive,
    'materials': [m[0] for m in MATERIALS],
    'material_textures': {m[0]: f'{m[1]}.jpg' for m in MATERIALS if m[0] != 'optic glass'},
    'imagegen_textures': sorted({f'{m[1]}.jpg' for m in MATERIALS if m[0] != 'optic glass'}),
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
                        'bolt_home_y': BOLT_HOME_Y, 'bolt_travel': BOLT_TRAVEL,
                        'trigger_y': TRIGGER_Y},
    'files': {'blend': 'docs/design/blender/kestrel/kestrel.blend',
              'glb': 'docs/design/blender/kestrel/kestrel.glb',
              'renders': ['render-hero.png', 'render-side.png', 'render-left.png',
                          'render-ads.png', 'render-rear.png'],
              'validation': 'docs/design/blender/kestrel/validation.json'},
    'build_time_checks': {
        'anchor_contract': 'muzzle plane, bore axis and exposed 0.0170 radius across '
                           'the whole heat band, all four markers, the 0.145 sight '
                           'line, the trigger blade and the bolt handle home position '
                           'are asserted against the runtime contract every build',
        'heat_band_clearance': 'no vertex other than the bore may enter the heat band',
        'sight_channel': 'nothing but the reflex lens, the front post and its wings '
                         'touches the 0.145 line inside |x| < 0.018; rail furniture '
                         'behind the reflex stays under z 0.125',
        'hand_fit': 'the grip flank sits inboard of the 0.045 palm and the guard '
                    'underside meets the support palm',
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
        'The ejection port is an authored opening: the bolt carrier is visible through '
        'it and moves with the bolt group, but there is no chamber interior beyond the '
        'carrier and the far wall.',
    ],
    'notes': ['Fresh design: no geometry reused from the first KESTREL study.',
              'Six-prong birdcage past the heat band; the band itself stays bare metal.',
              'Markings are modelled geometry, not a texture decal.',
              'The reflex sight ships as factory-optic; public/js/guns/models/kestrel.js '
              'adds the emissive dot at game (0, 0.145, -0.187) inside its housing.',
              'The bore sits 6 mm left of the receiver centreline (contract muzzle x '
              '-0.012); the sights sit on x = 0 where the ADS camera looks.'],
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
