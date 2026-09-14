"""Author FANG, an original S&W-686-style swing-out-cylinder revolver prop for Voxel Blitz.

Fresh design, built from scratch: no geometry, file or mesh is loaded from the
older BALLISTA study. Only the low-level authoring technique (closed convex
primitives, analytic planar UVs, shared ImageGen maps) and the frozen runtime
interface (anchors, part nodes, markers) are shared, because the game slot
demands them.

Run headless (the repo's own convention for long Blender work; the MCP bridge
runs the same Blender Python underneath):

    blender --background --factory-startup --python build-fang.py

or through the live Blender MCP session (protocol 5) on 127.0.0.1:9876:

    from pathlib import Path
    p = Path('.../tools/blender/fang/build-fang.py')
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

    muzzle   (0, 0.040, -0.520)   -> y = 0.520, x = 0, z = 0.040
    bore axis x = 0, z = 0.040    -> x = 0, z = 0.040, exposed radius 0.0180
    grip     (0.042, -0.012, -0.055) -> y = 0.055, x = 0.042, z = -0.012
    sight    iron-sight line 0.105 -> z = 0.105
    breech   revolver -0.160      -> y = 0.160
    trigger  revolver -0.075      -> y = 0.075, blade tip z = -0.010
    bolt home revolver -0.018     -> y = 0.018, hammer spur rearward
    heat band -0.3688 .. -0.4984  -> y = 0.3688 .. 0.4984

Design intent: a stainless S&W-686-style duty revolver. A solid frame with a
genuine cylinder window carries a fluted swing-out cylinder (owned by the mag
node, mirroring the runtime crane/cylinder hierarchy), a ventilated top rib
over the rear barrel half, a heavy underlug shroud housing the ejector rod, a
bare bull barrel across the heat band, a recessed target crown, an adjustable
rear sight and ramp front sight on the 0.105 iron-sight line, an exposed spur
hammer (bolt node), an open trigger guard, and swept rubber service grips with
finger grooves. It reads as the opposite of BALLISTA: compact, open and
mechanical, rather than tall, armored and shut.

Geometry is closed convex primitives (no booleans, no negative scales), then
chamfered by a bevel modifier; winding is repaired with recalc_face_normals and
UVs are an analytic per-face projection of the two non-dominant axes so the six
ImageGen maps tile at a constant real-world density. Every joint overlaps
volumetrically by >= 1 mm: butt-jointed flush faces z-fight once same-material
parts merge into one draw call.

Outputs (owned by this task):
    docs/design/blender/fang/fang.blend   editable, textures packed
    docs/design/blender/fang/fang.glb     portable GLB, images embedded
    docs/design/blender/fang/manifest.json    machine-readable record
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
DOCS = ROOT / 'docs/design/blender/fang'
INK = ROOT / 'public/assets/blender/textures'
DOCS.mkdir(parents=True, exist_ok=True)

ASSET = 'FANG'
SCENE_NAME = f'{ASSET} | Voxel Blitz revolver study'
UV_SCALE = 3.6  # texture tiles per metre, constant across the whole model
GROUPS = ['body', 'mag', 'bolt', 'trigger', 'extra']

# --- frozen runtime anchors, in Blender authoring space --------------------
MUZZLE = (0.000, 0.520, 0.040)     # game (0.000, 0.040, -0.520)
GRIP = (0.042, 0.055, -0.012)      # game (0.042, -0.012, -0.055)
SIGHT = (0.000, 0.020, 0.105)      # iron-sight line, game y = 0.105
MARKERS = {'muzzle': MUZZLE, 'grip': GRIP, 'sight': SIGHT}

BORE_X, BORE_Z = 0.000, 0.040   # bore axis
BORE_R = 0.0180                 # exposed bore radius (BARREL_R.revolver minus clearance)
BORE_IN = 0.0070                # muzzle mouth recess radius
BORE_START = 0.152              # buried in the barrel boss, must stay behind BREECH_Y
HEAT_BAND = (0.3688, 0.4984)    # -BREACH_Z + heatLen * barrelLen: 0.16 + [0.58, 0.94] * 0.36
BREECH_Y = 0.160                # BREACH_Z.revolver -0.16
SIGHT_Z = 0.105                 # iron-sight line height (ironSights height in models/revolver.js)
REAR_SIGHT_Y = 0.005            # adjustable rear-sight block plane, game z -0.005
FRONT_SIGHT_Y = 0.508           # ramp front-sight plane, game z -0.508
TRIGGER_Y, TRIGGER_TIP_Z = 0.075, -0.010   # TRIGGER_Z.revolver -0.075
BOLT_HOME_GAME_Z = -0.018       # BOLT_HOME.revolver
BOLT_HOME_Y = -BOLT_HOME_GAME_Z  # the same point in authoring space
CYL_R = 0.0250                  # swing-out cylinder outer radius
CYL_Y0, CYL_Y1 = 0.095, 0.148   # cylinder extent along the bore axis
CYL_Z = 0.0260                  # cylinder centerline height; top chamber meets the bore axis

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
# S&W-686 duty finish: deep blued frame/barrel/cylinder, satin stainless small
# parts, dark rubber service grips, brass chamber mouths, orange ramp insert.
# All reuse the delivered maps with different multiply tints (no new images),
# so the portable GLB and the runtime stay in agreement through baseColorFactor.
MATERIALS = [
    ('blued steel', 'worn-gunmetal', .82, .38, (.15, .16, .20)),
    ('satin steel', 'worn-gunmetal', .90, .30, (.60, .61, .64)),
    ('black oxide', 'petrol-ballistic-fabric', .40, .55, (.07, .07, .08)),
    ('brass', 'orange-painted-metal', .85, .35, (.80, .58, .25)),
    ('sight orange', 'orange-painted-metal', .10, .50, (.98, .55, .16)),
    ('ivory coating', 'ivory-armor', .04, .45, (.96, .95, .92)),
    ('rubber', 'worn-rubber', 0, .92, (.055, .055, .06)),
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
ROUND_OBJECTS = []  # no loose rounds: the revolver reload drives one speedloader group
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
# BODY: solid frame with a genuine cylinder window, vent-rib barrel with full
# underlug shroud, bare heat-band barrel, recessed crown, adjustable rear
# sight + ramp front sight on the 0.105 line, open trigger guard, rubber grips
# ===========================================================================
# Frame side plates with a real punched window (no booleans: the hole is part
# of the extrusion). The swing cylinder rides in the opening with a working
# breech gap at both ends; the crane and ejector rod bridge it structurally.
FRAME_PROFILE = [(-0.030, 0.006), (-0.041, 0.020), (-0.041, 0.038),
                (-0.031, 0.052), (-0.019, 0.059),
                (0.100, 0.059), (0.150, 0.058), (0.156, 0.050),
                (0.156, 0.002), (0.060, -0.008)]
FRAME_WINDOW = [(0.070, -0.004), (0.070, 0.024), (0.070, 0.052), (0.097, 0.052),
                (0.124, 0.052), (0.154, 0.052), (0.154, 0.024), (0.154, -0.004),
                (0.124, -0.004), (0.097, -0.004)]
pair('Frame window plate', 'body', 'blued steel',
    solid(FRAME_PROFILE, 0.010, 'X', FRAME_WINDOW), loc=(0.013, 0, 0), bevel=.004)

# Top strap: the contact anchor every other part chains back to.
add('Frame top strap', 'body', 'blued steel', boxv((0.018, 0.150, 0.013)),
    loc=(0, 0.070, 0.0590), bevel=.002)
# Tapered topstrap hump sculpting the 686 crown over the cylinder rear.
add('Frame topstrap hump', 'body', 'blued steel', prism([
    (0.055, 0.058), (0.155, 0.058), (0.155, 0.062), (0.100, 0.068),
    (0.060, 0.070)], 0.022), bevel=.0025)
# Bottom frame bar tying the trigger, guard and grip frame together.
add('Frame bottom bar', 'body', 'blued steel', boxv((0.022, 0.166, 0.012)),
    loc=(0, 0.063, -0.002), bevel=.002)
for index, y in enumerate((0.036, 0.048, 0.060, 0.072, 0.084, 0.096)):
    add(f'Top strap serration {index + 1}', 'body', 'black oxide',
        boxv((0.020, 0.002, 0.001)), loc=(0, y, 0.0640), bevel=0)
# Recoil shield standing 1.5 mm behind the cylinder rear face (breech gap).
add('Recoil shield', 'body', 'blued steel', boxv((0.030, 0.0155, 0.058)),
    loc=(0, 0.08575, 0.028), bevel=.002)
add('Firing pin boss', 'body', 'satin steel', tube(.003, .004, 12),
    loc=(0, 0.091, 0.040), bevel=0)
pair('Frame sideplate', 'body', 'blued steel', prism([
    (0.008, 0.018), (0.008, 0.038), (0.016, 0.047), (0.032, 0.051),
    (0.048, 0.047), (0.056, 0.038), (0.056, 0.018), (0.048, 0.009),
    (0.032, 0.006), (0.016, 0.009)], 0.003),
    loc=(0.0170, 0, 0), bevel=.002)
# Barrel boss the barrel threads into ahead of the cylinder gap.
add('Barrel boss', 'body', 'blued steel', boxv((0.030, 0.030, 0.056)),
    loc=(0, 0.16325, 0.036), bevel=.002)

pair('Boss side rib', 'body', 'blued steel', boxv((0.002, 0.020, 0.040)),
    loc=(0.0155, 0.163, 0.036), bevel=0)
BORE_OBJECT = add('Duty barrel', 'body', 'blued steel', merge_shapes([
    tube_stacked(BORE_R, BORE_START, HEAT_BAND[1], step=0.02, segments=52),
    tube_stacked(BORE_R, HEAT_BAND[1], 0.518, step=0.004, segments=52)]),
    loc=(BORE_X, 0, 0), bevel=0)
add('Recessed crown', 'body', 'blued steel', washer(.0175, .0110, .004, 36),
    loc=(BORE_X, 0.518, BORE_Z), bevel=0)
add('Muzzle mouth', 'body', 'black oxide', tube(.0108, .002, 28),
    loc=(BORE_X, 0.5185, BORE_Z), bevel=0)
add('Bore depth', 'body', 'black oxide', tube(BORE_IN, .003, 16),
    loc=(BORE_X, 0.517, BORE_Z), bevel=0)

# Ventilated top rib: solid top bar on five cross posts, genuine see-through
# slots between them, serrated top. Everything ends ahead of the heat band.
add('Vent rib top bar', 'body', 'blued steel', boxv((0.014, 0.190, 0.006)),
    loc=(0, 0.271, 0.065), bevel=.0015)
add('Rib rear fillet', 'body', 'blued steel', boxv((0.018, 0.022, 0.010)),
    loc=(0, 0.179, 0.062), bevel=.0015)
for index, y in enumerate((0.186, 0.232, 0.278, 0.324, 0.356)):
    add(f'Vent rib post {index + 1}', 'body', 'blued steel',
        boxv((0.012, 0.012, 0.010)), loc=(0, y, 0.061), bevel=.001)
for index, y in enumerate((0.200, 0.212, 0.246, 0.258, 0.292, 0.304, 0.338, 0.348)):
    add(f'Rib serration {index + 1}', 'body', 'black oxide',
        boxv((0.016, 0.002, 0.001)), loc=(0, y, 0.0680), bevel=0)

# Full underlug shroud swallowing the ejector rod; cross bolt locks it.
add('Underlug shroud', 'body', 'blued steel', boxv((0.022, 0.191, 0.034)),
    loc=(0, 0.2715, 0.011), bevel=.001)
add('Shroud locking bolt', 'body', 'satin steel', tube(.004, .024, 10, axis='X'),
    loc=(0, 0.360, 0.015), bevel=0)

# Adjustable rear sight: base, notched blade ears on the sight line, white
# outlines, elevation + windage screws.
add('Rear sight base', 'body', 'blued steel', boxv((0.028, 0.056, 0.014)),
    loc=(0, 0.002, 0.067), bevel=.0015)
pair('Rear sight blade', 'body', 'blued steel', boxv((0.012, 0.012, 0.033)),
    loc=(0.009, 0.002, 0.0885), bevel=.001)
pair('Rear sight notch outline', 'body', 'ivory coating', boxv((0.003, 0.002, 0.010)),
    loc=(0.0055, -0.0035, 0.094), bevel=0)
add('Rear sight elevation screw', 'body', 'black oxide', tube(.003, .004, 8),
    loc=(0, -0.020, 0.072), bevel=0)
add('Rear sight windage screw', 'body', 'black oxide', tube(.003, .034, 8, axis='X'),
    loc=(0, 0.002, 0.080), bevel=0)

# Ramp front sight straddling the band end: base ring, ramp blade to the
# sight line, orange insert. The ring starts 2.6 mm past the heat band.
add('Front sight base ring', 'body', 'blued steel', washer(.0205, .0170, .018, 20),
    loc=(BORE_X, 0.508, BORE_Z), bevel=0)
FRONT_RAMP_OBJECT = add('Front sight ramp', 'body', 'blued steel', prism([
    (0.497, 0.052), (0.519, 0.052), (0.512, 0.105), (0.505, 0.105)], 0.012),
    bevel=.001)
add('Front sight insert', 'body', 'sight orange', boxv((0.013, 0.005, 0.012)),
    loc=(0, 0.5085, 0.096), bevel=0)
add('Grip frame core', 'body', 'blued steel', prism([
    (0.070, 0.000), (0.052, -0.034), (0.024, -0.066), (0.018, -0.078),
    (-0.010, -0.090), (-0.015, -0.083), (-0.015, -0.048), (0.006, -0.012)], 0.028),
    bevel=.006)
# Rubber service panels wrapping the grip marker, finger-groove ribs on the
# front strap, checkered side fields, medallions, screws, butt cap.
pair('Rubber grip panel', 'body', 'rubber', prism([
    (0.078, 0.004), (0.058, -0.036), (0.028, -0.068), (0.022, -0.082),
    (-0.014, -0.096), (-0.020, -0.089), (-0.020, -0.050), (0.008, -0.012)], 0.010),
    loc=(0.0185, 0, 0), bevel=.006)
for index, (y, z, w) in enumerate(((0.0505, -0.0440, 0.048), (0.0430, -0.0520, 0.044),
                                  (0.0355, -0.0600, 0.040))):
    add(f'Finger groove rib {index + 1}', 'body', 'rubber',
        boxv((w, 0.011, 0.009)), loc=(0, y, z),
        rot=(math.radians(-133), 0, 0), bevel=.003)
for index, (y, z) in enumerate(((0.0151, -0.044), (0.0314, -0.044),
                                (0.0107, -0.052), (0.0256, -0.052),
                                (0.0061, -0.060), (0.0196, -0.060))):
    pair(f'Grip checkering {index + 1}', 'body', 'black oxide',
        boxv((0.002, 0.007, 0.006)), loc=(0.0243, y, z), bevel=0)
pair('Grip medallion', 'body', 'ivory coating', tube(.007, .002, 24, axis='X'),
    loc=(0.0235, 0.012, -0.062), bevel=0)
pair('Grip screw', 'body', 'satin steel', tube(.0035, .002, 10, axis='X'),
    loc=(0.0235, 0.002, -0.078), bevel=0)
add('Grip butt cap', 'body', 'rubber', boxv((0.046, 0.038, 0.018)),
    loc=(0, 0.004, -0.089), rot=(math.radians(-159), 0, 0), bevel=.005)
add('Grip backstrap upper', 'body', 'black oxide', boxv((0.030, 0.050, 0.008)),
    loc=(0, -0.006, -0.031), rot=(math.radians(-126), 0, 0), bevel=.006)
add('Grip backstrap lower', 'body', 'black oxide', boxv((0.026, 0.008, 0.042)),
    loc=(0, -0.0185, -0.0695), bevel=.006)
# Round backstrap palm swell: a vertical column, not a block, merging the
# grip rear into one continuous rubber service-grip volume.
add('Grip palm swell', 'body', 'rubber', tube(0.017, 0.040, 20, axis='Z'),
    loc=(0, -0.019, -0.063), bevel=.004)
GUARD_OUTER = [(0.030, -0.058), (0.012, -0.020), (0.008, 0.000), (0.020, 0.006),
                (0.062, 0.009), (0.118, 0.009), (0.130, 0.000), (0.130, -0.024),
                (0.120, -0.036), (0.090, -0.045), (0.056, -0.047)]
GUARD_INNER = [(0.034, -0.038), (0.026, -0.014), (0.024, -0.002), (0.032, 0.001),
                (0.062, 0.002), (0.108, 0.002), (0.116, -0.002), (0.116, -0.020),
                (0.108, -0.028), (0.088, -0.034), (0.060, -0.036)]
add('Trigger guard', 'body', 'blued steel',
    solid(GUARD_OUTER, 0.024, 'X', GUARD_INNER), bevel=.007)
# Cylinder release, sideplate screws, modelled markings.
add('Cylinder release', 'body', 'satin steel', boxv((0.008, 0.024, 0.010)),
    loc=(-0.020, 0.045, 0.038), bevel=.0015)
for index, (x, y, z) in enumerate(((-0.0185, -0.005, 0.030), (-0.0185, -0.020, 0.035),
                                   (0.0185, -0.005, 0.030))):
    add(f'Sideplate screw {index + 1}', 'body', 'satin steel',
        tube(.0032, .003, 10, axis='X'), loc=(x, y, z), bevel=0)
add('Boss screw', 'body', 'satin steel', tube(.0032, .003, 10, axis='X'),
    loc=(-0.0155, 0.163, 0.036), bevel=0)
add_text(ASSET, 'Marking FANG left', 'body', 'ivory coating',
         (-0.0108, 0.270, 0.013), (math.pi / 2, 0, -math.pi / 2), .009)
add_text('.357 MAGNUM', 'Marking caliber right', 'body', 'ivory coating',
         (0.0108, 0.270, 0.013), (math.pi / 2, 0, math.pi / 2), .007)

# ===========================================================================
# MAG: the swing-out cylinder assembly (mirrors the runtime crane/cylinder
# ownership: everything here rides the mag node). Fluted drum, brass chamber
# mouths with dark centres, ejector star + coaxial rod, crane arm + pivot.
# ===========================================================================
add('Swing cylinder', 'mag', 'blued steel', tube(CYL_R, CYL_Y1 - CYL_Y0, 48),
    loc=(0, (CYL_Y0 + CYL_Y1) / 2, CYL_Z), bevel=.001)
# Fluted-drum read (proven ballista pattern): six thin matte-dark lines
# barely proud of the drum between the chambers so they read as recessed
# flutes rather than ribs, bevel 0.
for index in range(6):
    angle = index * math.pi / 3
    ca, sa = math.cos(angle), math.sin(angle)
    add(f'Cylinder flute {index + 1}', 'mag', 'rubber',
        boxv((0.0025, 0.050, 0.002)),
        loc=((CYL_R - 0.0005) * ca, 0.1215, CYL_Z + (CYL_R - 0.0005) * sa),
        rot=(0, math.radians(90) - angle, 0), bevel=0)
for index in range(6):
    phi = math.radians(90 + index * 60)
    cx, cz = 0.014 * math.cos(phi), CYL_Z + 0.014 * math.sin(phi)
    add(f'Chamber mouth {index + 1}', 'mag', 'brass',
        washer(.0058, .0040, .003, 16), loc=(cx, 0.0955, cz), bevel=0)
    add(f'Chamber center {index + 1}', 'mag', 'black oxide',
        tube(.0040, .004, 12), loc=(cx, 0.0945, cz), bevel=0)
add('Ejector rod', 'mag', 'satin steel', tube(.0035, .218, 12),
    loc=(0, 0.256, CYL_Z), bevel=0)
add('Ejector rod tip', 'mag', 'satin steel', tube(.0045, .010, 12),
    loc=(0, 0.363, CYL_Z), bevel=0)
add('Ejector rod collar', 'mag', 'satin steel', washer(.008, .0050, .006, 12),
    loc=(0, 0.3625, CYL_Z), bevel=0)
add('Crane arm', 'mag', 'blued steel', boxv((0.014, 0.022, 0.014)),
    loc=(0, 0.155, 0.007), bevel=.0015)
add('Crane pivot', 'mag', 'blued steel', tube(.006, .020, 12, axis='X'),
    loc=(0, 0.160, 0.004), bevel=0)

# ===========================================================================
# BOLT and TRIGGER: spur hammer on its pivot pin (bolt node), single blade
# (trigger node). No cartridges under extra: the revolver reload choreography
# drives one speedloader group (reloadRounds), never the cartridges array,
# so this study ships no loose rounds — the WASP precedent.
# ===========================================================================
HAMMER_PIN_OBJECT = add('Hammer pivot pin', 'bolt', 'satin steel',
    tube(.004, .040, 12, axis='X'), loc=(0, BOLT_HOME_Y, 0.030), bevel=0)
HAMMER_OBJECT = add('Spur hammer', 'bolt', 'satin steel', prism([
    (0.030, 0.018), (0.002, 0.022), (-0.018, 0.040), (-0.030, 0.062),
    (-0.034, 0.080), (-0.030, 0.088), (-0.022, 0.088), (-0.020, 0.078),
    (-0.008, 0.058), (0.018, 0.040), (0.032, 0.028)], 0.022),
    bevel=.002)
for index, (y, z, w) in enumerate(((-0.0335, 0.0815, 0.020), (-0.0325, 0.0845, 0.018),
                                  (-0.0310, 0.0875, 0.016))):
    add(f'Hammer serration {index + 1}', 'bolt', 'black oxide',
        boxv((w, 0.003, 0.0025)), loc=(0, y, z), bevel=0)
TRIGGER_OBJECT = add('Trigger blade', 'trigger', 'satin steel',
    boxv((0.014, 0.014, 0.024)), loc=(0, 0.074, 0.002), bevel=.002)
for index, z in enumerate((-0.006, -0.002, 0.002)):
    add(f'Trigger groove {index + 1}', 'trigger', 'black oxide',
        boxv((0.0145, 0.002, 0.0025)), loc=(0, 0.0665, z), bevel=0)
# Longer orange trigger shoe: a forward-swept hook filling the guard opening
# so the trigger keeps a distinct curved silhouette from the side, with open
# air between its tip and the guard front / grip. Rear top stays buried in the
# blade for the >= 1 mm volumetric joint; tip stays clear of the guard inner
# wall (front y ~0.107, floor z -0.036 in this span).
add('Trigger shoe', 'trigger', 'sight orange', prism([
    (0.070, -0.001), (0.084, -0.003), (0.092, -0.009), (0.094, -0.017),
    (0.089, -0.025), (0.081, -0.029), (0.073, -0.026), (0.068, -0.019),
    (0.067, -0.010), (0.068, -0.004)], 0.020), bevel=.0015)

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

for (key, value) in {'asset_id': 'fang',
                     'asset_name': 'FANG',
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
for (obj, _part, _material) in PARTS + [(o, 'extra', 'sight orange') for o in ROUND_OBJECTS]:
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
muzzle_names = {bore_object.name, 'Recessed crown'}
tip = max((p for (p, n) in points if n in muzzle_names), key=lambda p: p[1])
tip_plane = sorted({round(p[1], 9) for (p, n) in points if n in muzzle_names and p[1] > 0.50})
trigger_object = TRIGGER_OBJECT
trigger_low = min((trigger_object.matrix_world @ v.co)[2] for v in trigger_object.data.vertices)
hammer_object = HAMMER_OBJECT
spur_back = min((hammer_object.matrix_world @ v.co)[1] for v in hammer_object.data.vertices)
hammer_pin = HAMMER_PIN_OBJECT
pin_y = (min((hammer_pin.matrix_world @ v.co)[1] for v in hammer_pin.data.vertices)
         + max((hammer_pin.matrix_world @ v.co)[1] for v in hammer_pin.data.vertices)) / 2
ramp_object = FRONT_RAMP_OBJECT
ramp_top = max((ramp_object.matrix_world @ v.co)[2] for v in ramp_object.data.vertices)
blades = [obj for (obj, _part, _material) in PARTS if obj.name.startswith('Rear sight blade')]
blade_top = max((obj.matrix_world @ v.co)[2]
                for obj in blades for v in obj.data.vertices)

CONTRACT = [
    ('muzzle_forward_vertex_y', tip[1], MUZZLE[1], 1e-6),
    ('muzzle_marker', MUZZLE[1], 0.520, 1e-9),
    ('bore_axis_x', bore_x, BORE_X, 1e-9),
    ('bore_axis_z', bore_z, BORE_Z, 1e-9),
    ('exposed_bore_radius_in_heat_band', band_radius, BORE_R, 1e-6),
    ('grip_marker_x', GRIP[0], 0.042, 1e-9),
    ('grip_marker_y', GRIP[1], 0.055, 1e-9),
    ('grip_marker_z', GRIP[2], -0.012, 1e-9),
    ('sight_axis_z', SIGHT[2], SIGHT_Z, 1e-9),
    ('sight_marker_y', SIGHT[1], 0.020, 1e-9),
    ('front_ramp_top_z', ramp_top, SIGHT_Z, 1e-6),
    ('rear_blade_top_z', blade_top, SIGHT_Z, 1e-3),
    ('trigger_blade_y', TRIGGER_Y, 0.075, 1e-9),
    ('trigger_blade_tip_z', trigger_low, TRIGGER_TIP_Z, 1e-6),
    ('hammer_pin_home_y', pin_y, BOLT_HOME_Y, 1e-9),
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
if spur_back >= -0.025:
    contract_failures.append(f'hammer spur does not sweep rearward: reaches y={spur_back:.4f}')
if ramp_top > SIGHT_Z + 1e-6:
    contract_failures.append(f'front ramp crosses the sight line: top z={ramp_top:.4f}')

print(f'model extent x={extent[0][0]:+.4f}..{extent[0][1]:+.4f} '
      f'y={extent[1][0]:+.4f}..{extent[1][1]:+.4f} z={extent[2][0]:+.4f}..{extent[2][1]:+.4f}')
print(f'forward-most vertex ({tip[0]:+.6f}, {tip[1]:+.6f}, {tip[2]:+.6f}), muzzle plane rows {tip_plane}')
print(f'heat band z-radius max {band_radius:.6f} over {len(band)} vertices, '
      f'foreign geometry {band_foreign or "none"}')
print(f'bore axis measured ({bore_x:+.9f}, {bore_z:+.9f}); hammer spur reaches y={spur_back:+.4f}')
if contract_failures:
    print(f'CONTRACT FAILURES: {len(contract_failures)}')
    for line in contract_failures:
        print(f'  {line}')
else:
    print('anchor contract: all assertions pass')

# --- pack textures and save the editable source ----------------------------
bpy.ops.file.pack_all()
BLEND = DOCS / 'fang.blend'
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
CONTACT_ANCHOR = 'Frame top strap'


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

GLB = DOCS / 'fang.glb'
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
            node.setdefault('extras', {})['blenderAsset'] = 'fang'
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
    'asset': 'FANG',
    'asset_id': 'fang',
    'kind': 'original S&W-686-style swing-out-cylinder revolver prop (visual game asset)',
    'blender': bpy.app.version_string,
    'authoring_script': 'tools/blender/fang/build-fang.py',
    'source_parts': len(PARTS),
    'animation_group_nodes': GROUPS,
    'marker_nodes': sorted(MARKERS),
    'batch_nodes': len(batches),
    'round_nodes': [obj.name for obj in round_objects],
    'triangles': triangles,
    'triangles_per_primitive': per_primitive,
    'materials': [m[0] for m in MATERIALS],
    'material_textures': {m[0]: f'{m[1]}.jpg' for m in MATERIALS},
    'imagegen_textures': sorted({f'{m[1]}.jpg' for m in MATERIALS}),
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
    'contract_points': {'breech_y': BREECH_Y, 'bore_axis': [BORE_X, BORE_Z],
                        'exposed_bore_radius': BORE_R,
                        'exposed_bore': [BORE_START, MUZZLE[1]],
                        'heat_band': [-HEAT_BAND[1], -HEAT_BAND[0]],
                        'sight_height': SIGHT_Z,
                        'sight_planes': [REAR_SIGHT_Y, FRONT_SIGHT_Y],
                        'cylinder': {'radius': CYL_R, 'y_span': [CYL_Y0, CYL_Y1],
                                     'centerline_z': CYL_Z}},
    'files': {'blend': 'docs/design/blender/fang/fang.blend',
              'glb': 'docs/design/blender/fang/fang.glb',
              'renders': ['render-hero.png', 'render-side.png', 'render-ads.png',
                          'render-rear.png'],
              'validation': 'docs/design/blender/fang/validation.json'},
    'build_time_checks': {
        'anchor_contract': 'muzzle plane, bore axis and exposed 0.0180 radius across '
                           'the whole heat band, all three markers, the 0.105 sight '
                           'line, the trigger blade, the hammer pin home position '
                           'and the rearward hammer spur '
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
        'Hand fit is unverified: the grip palm sits on the contract '
        'point and the geometry is built around it, but no third-person pose test '
        'was run.',
    ],
    'notes': ['Fresh design: no geometry reused from the older BALLISTA study.',
              'Fluted swing-out cylinder on the mag node mirrors the runtime '
              'crane/cylinder ownership; the spur hammer rides the bolt node.',
              'Vent rib with genuine slots ends ahead of the heat band, which stays bare metal.',
              'Markings are modelled geometry, not a texture decal.',
              'No loose rounds: the revolver reload choreography drives a single '
              'speedloader group, never the cartridges array (WASP precedent).'],
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
