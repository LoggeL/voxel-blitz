"""Author IFRIT, an original stylized flamethrower prop for Voxel Blitz.

Fresh design, built from scratch: no geometry, file or mesh is loaded from any
older study. Only the low-level authoring technique (closed convex
primitives, analytic planar UVs, shared ImageGen maps) and the frozen runtime
interface (anchors, part nodes, markers) are shared, because the game slot
demands them.

Run headless (the repo's own convention for long Blender work; the MCP bridge
runs the same Blender Python underneath):

    blender --background --factory-startup --python build-ifrit.py

or through the live Blender MCP session (protocol 5) on 127.0.0.1:9876:

    from pathlib import Path
    p = Path('.../tools/blender/ifrit/build-ifrit.py')
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

    muzzle   (0, 0.065, -0.655)   -> y = 0.655, x = 0, z = 0.065
    bore axis x = 0, z = 0.065    -> x = 0, z = 0.065, exposed radius 0.0425
    grip     (0.045, -0.020, -0.08) -> y = 0.080, x = 0.045, z = -0.020
    support  (-0.06, -0.030, -0.40) -> y = 0.400, x = -0.060, z = -0.030
    sight    iron-sight axis 0.158 -> z = 0.158
    breech   flamethrower -0.220   -> y = 0.220
    trigger  flamethrower -0.110   -> y = 0.110, blade tip z = -0.055
    bolt home flamethrower -0.040  -> y = 0.040, lever to +x
    heat band game -0.4375 .. -0.6333 -> y = 0.4375 .. 0.6333

Design intent: a compact pressure-tool flamethrower. A low manifold receiver
carries a top accessory rail with iron sights on the 0.158 line, a fat mixing
chamber feeding a bare burner tube across the heat band, an open six-strut
burner cage around the muzzle with a brass pilot-light housing and an emissive
pilot flame, a transverse red fuel tank slung under the receiver on a saddle
with webbing straps, a rubber hose looping down the left flank from the tank
to the receiver heel, a raked pistol grip, a forward support foregrip, and an
open two-bar stock. It reads as the opposite of BALLISTA: hot, plumbed and
front-heavy, rather than tall, enclosed and precise.

Geometry is closed convex primitives (no booleans, no negative scales), then
chamfered by a bevel modifier; winding is repaired with recalc_face_normals and
UVs are an analytic per-face projection of the two non-dominant axes so the six
ImageGen maps tile at a constant real-world density. Every joint overlaps
volumetrically by >= 1 mm: butt-jointed flush faces z-fight once same-material
parts merge into one draw call.

Outputs (owned by this task):
    docs/design/blender/ifrit/ifrit.blend   editable, textures packed
    docs/design/blender/ifrit/ifrit.glb     portable GLB, images embedded
    docs/design/blender/ifrit/manifest.json    machine-readable record
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
DOCS = ROOT / 'docs/design/blender/ifrit'
INK = ROOT / 'public/assets/blender/textures'
DOCS.mkdir(parents=True, exist_ok=True)

ASSET = 'IFRIT'
SCENE_NAME = f'{ASSET} | Voxel Blitz flamethrower study'
UV_SCALE = 3.6  # texture tiles per metre, constant across the whole model
GROUPS = ['body', 'mag', 'bolt', 'trigger', 'extra']

# --- frozen runtime anchors, in Blender authoring space --------------------
MUZZLE = (0.000, 0.655, 0.065)     # game (0.000, 0.065, -0.655)
GRIP = (0.045, 0.080, -0.020)      # game (0.045, -0.020, -0.080)
SUPPORT = (-0.060, 0.400, -0.030)  # game (-0.060, -0.030, -0.400), rides `body`
SIGHT = (0.000, 0.300, 0.158)      # iron-sight axis, game y = 0.158
MARKERS = {'muzzle': MUZZLE, 'grip': GRIP, 'support': SUPPORT, 'sight': SIGHT}

BORE_X, BORE_Z = 0.000, 0.065   # bore axis
BORE_R = 0.0425                 # exposed bore radius (BARREL_R.flamethrower minus clearance)
BORE_IN = 0.0200                # muzzle mouth recess radius
BORE_START = 0.100              # buried in the manifold receiver
CHAMBER_END = 0.400             # mixing chamber ends: bare burner tube begins
HEAT_BAND = (0.4375, 0.6333)    # game z -0.4375 .. -0.6333
BREECH_Y = 0.220                # BREACH_Z.flamethrower -0.22
SIGHT_Z = 0.158                 # iron-sight axis height (-TIMERS.flamethrower.adsOffset.y)
TRIGGER_Y, TRIGGER_TIP_Z = 0.110, -0.055   # TRIGGER_Z.flamethrower -0.11
BOLT_HOME_GAME_Z = -0.040       # BOLT_HOME.flamethrower
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
# Workshop pressure-tool palette: blackened gunmetal, red fuel tank, brass fittings,
# ivory accents, rubber grips and hose, fabric heat wrap, webbing straps. Every
# textured material reuses one of the six delivered maps with a multiply tint
# (no new images). The pilot flame is an unmapped emissive material (emission
# is free under the brief).
MATERIALS = [
    ('gunmetal', 'worn-gunmetal', .55, .38, (.36, .36, .38)),
    ('fuel red', 'orange-painted-metal', .15, .48, (.72, .16, .12)),
    ('brass', 'orange-painted-metal', .80, .30, (.72, .55, .30)),
    ('cream', 'ivory-armor', .04, .45, (.96, .95, .90)),
    ('heat wrap', 'petrol-ballistic-fabric', 0, .82, (.55, .52, .50)),
    ('webbing', 'tan-webbing', 0, .88, (.80, .72, .58)),
    ('rubber', 'worn-rubber', 0, .90, (.60, .61, .63)),
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

pilot = bpy.data.materials.new(f'{ASSET} | pilot light')
pilot.use_nodes = True
pbsdf = pilot.node_tree.nodes['Principled BSDF']
pbsdf.inputs['Base Color'].default_value = (.45, .12, .02, 1)
pbsdf.inputs['Metallic'].default_value = 0
pbsdf.inputs['Roughness'].default_value = .40
pbsdf.inputs['Emission Color'].default_value = (1.0, .38, .06, 1)
pbsdf.inputs['Emission Strength'].default_value = 3.0
pilot['pilot'] = True
mats['pilot light'] = pilot

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
# BODY: low manifold receiver, railed top with iron sights, fat mixing
# chamber, bare burner tube, open burner cage with pilot light, pistol grip,
# support foregrip, hose loop down the left flank, open two-bar stock
# ===========================================================================
# Low manifold receiver. The burner tube runs through its top half, the tank
# saddle hangs below it, and the return hose lands on its heel.
add('Manifold receiver', 'body', 'gunmetal', prism([
    (-0.100, -0.030), (-0.100, 0.090), (0.300, 0.090),
    (0.340, 0.050), (0.340, -0.020), (0.100, -0.050)], .110), bevel=.005)

# Low accessory rail on two risers, carrying the iron sights.
add('Rail riser rear', 'body', 'gunmetal', boxv((.040, .050, .030)),
    loc=(0, -0.020, 0.100), bevel=.002)
add('Rail riser front', 'body', 'gunmetal', boxv((.040, .050, .030)),
    loc=(0, 0.200, 0.100), bevel=.002)
add('Top rail', 'body', 'gunmetal', boxv((.046, .300, .014)),
    loc=(0, 0.090, 0.116), bevel=.0015)
for index, y in enumerate((-0.030, 0.070, 0.170)):
    add(f'Rail lug {index + 1}', 'body', 'gunmetal', boxv((.030, .014, .005)),
        loc=(0, y, 0.1245), bevel=.0012)

# Rear notch sight straddling the 0.158 axis; the front blade sits on the cage.
add('Rear sight base', 'body', 'gunmetal', boxv((.040, .050, .020)),
    loc=(0, 0.160, 0.130), bevel=.002)
pair('Rear sight ear', 'body', 'cream', boxv((.008, .024, .024)),
     loc=(.014, 0.160, 0.150), bevel=.0015)

# Fat mixing chamber with brass collars and rubber vent bars.
add('Mixing chamber', 'body', 'gunmetal', tube(.052, .160, 24),
    loc=(0, 0.3225, BORE_Z), bevel=.002)
add('Chamber collar rear', 'body', 'brass', washer(.056, .050, .020, 24),
    loc=(0, 0.260, BORE_Z), bevel=0)
add('Chamber collar front', 'body', 'brass', washer(.056, .050, .020, 24),
    loc=(0, 0.380, BORE_Z), bevel=0)
add('Chamber band center', 'body', 'brass', washer(.056, .050, .024, 24),
    loc=(0, 0.320, BORE_Z), bevel=0)
pair('Chamber vent bar', 'body', 'rubber', boxv((.006, .080, .030)),
     loc=(.053, 0.320, BORE_Z), bevel=0)

# Bare burner tube: a buried 0.048 run through receiver and chamber, exactly
# 0.0425 across the whole heat band, tapering to 0.038 at the muzzle.
BORE_OBJECT = add('Burner tube', 'body', 'gunmetal', merge_shapes([
    tube_stacked(.048, BORE_START, HEAT_BAND[0], step=0.02, segments=20, radius1=BORE_R),
    tube_stacked(BORE_R, HEAT_BAND[0], HEAT_BAND[1], step=0.008, segments=24),
    tube_stacked(BORE_R, HEAT_BAND[1], MUZZLE[1], step=0.01, segments=24, radius1=0.038)]),
    loc=(BORE_X, 0, 0), bevel=0)
add('Burner mouth', 'body', 'rubber', tube(.020, .003, 16),
    loc=(BORE_X, 0.655, BORE_Z), bevel=0)

# Open six-strut burner cage: collar and rim rings joined by short bars. Only
# the burner tube may occupy the heat-band slab, so every cage vertex sits
# past y = 0.6333.
add('Nozzle collar', 'body', 'gunmetal', washer(.058, .038, .016, 16),
    loc=(0, 0.642, BORE_Z), bevel=0)
add('Muzzle rim', 'body', 'gunmetal', washer(.056, .036, .014, 16),
    loc=(0, 0.6455, BORE_Z), bevel=0)
add('Muzzle crown', 'body', 'gunmetal', washer(.040, .036, .008, 24),
    loc=(0, 0.6490, BORE_Z), bevel=0)
for index in range(6):
    angle = index * math.pi / 3
    add(f'Cage strut {index + 1}', 'body', 'gunmetal', boxv((.010, .017, .010)),
        loc=(.052 * math.cos(angle), 0.6435, BORE_Z + .052 * math.sin(angle)),
        rot=(0, -angle, 0), bevel=0)
add('Front sight blade', 'body', 'cream', boxv((.010, .012, .040)),
    loc=(0, 0.6435, 0.140), bevel=.0015)
# Pilot light: brass strut off the nozzle collar, brass housing, emissive flame.
add('Pilot support strut', 'body', 'brass', boxv((.035, .014, .030)),
    loc=(-0.062, 0.644, 0.088), bevel=.0015)
add('Pilot housing', 'body', 'brass', tube(.013, .040, 12),
    loc=(-0.075, 0.6565, 0.100), bevel=0)
add('Pilot flame', 'body', 'pilot light', taper(.010, .001, 0.0, 0.035, 12),
    loc=(-0.075, 0.668, 0.100), bevel=0)
# Tank saddle bridging receiver belly and fuel tank.
add('Tank saddle', 'body', 'heat wrap', boxv((.100, .160, .040)),
    loc=(0, 0.235, -0.065), bevel=.003)

# Raked pistol grip wrapping the grip marker; the x = 0.045 palm sits just
# outboard of the half-width 0.029 panel.
add('Pistol grip', 'body', 'rubber', prism([
    (0.160, 0.000), (0.100, 0.000), (0.055, -0.050), (0.045, -0.115),
    (0.100, -0.125), (0.130, -0.060)], .058), bevel=.008)
add('Grip finger rib upper', 'body', 'rubber', boxv((.060, .012, .012)),
    loc=(0, 0.078, -0.024), rot=(math.atan2(-0.050, -0.045), 0, 0), bevel=.002)
add('Grip finger rib lower', 'body', 'rubber', boxv((.060, .012, .012)),
    loc=(0, 0.050, -0.0825), rot=(math.atan2(-0.065, -0.010), 0, 0), bevel=.002)
add('Grip base cap', 'body', 'rubber', boxv((.060, .024, .050)),
    loc=(0, 0.070, -0.128), rot=(math.atan2(-0.010, 0.055), 0, 0), bevel=.003)

# Forward support foregrip under the burner tube, wrapping the support marker.
add('Support foregrip', 'body', 'rubber', prism([
    (0.420, 0.020), (0.360, 0.020), (0.345, -0.060),
    (0.360, -0.115), (0.405, -0.110), (0.415, -0.050)], .052), bevel=.006)
pair('Foregrip rib', 'body', 'heat wrap', boxv((.006, .050, .040)),
     loc=(.027, 0.385, -0.065), bevel=0)

# Open two-bar stock: comb and toe leave a genuine opening; plate and pad close
# the back. All butt joints overlap by 5 mm, never flush.
add('Stock comb bar', 'body', 'gunmetal', boxv((.044, .200, .040)),
    loc=(0, -0.195, 0.055), bevel=.005)
add('Stock toe bar', 'body', 'gunmetal', boxv((.040, .200, .036)),
    loc=(0, -0.195, -0.045), bevel=.005)
add('Stock butt plate', 'body', 'gunmetal', boxv((.046, .018, .150)),
    loc=(0, -0.303, -0.005), bevel=.004)
add('Butt pad', 'body', 'rubber', boxv((.048, .020, .120)),
    loc=(0, -0.320, -0.005), bevel=.006)
add('Toe sling loop', 'body', 'gunmetal', solid(recty(-0.012, 0.012, -0.014, 0.014), .008, 'X',
                                                recty(-0.005, 0.005, -0.006, 0.006)),
    loc=(0.017, -0.240, -0.068), bevel=.001)

# Pressure dial on the left manifold flank: drum, brass rim, cream face.
add('Pressure dial', 'body', 'gunmetal', tube(.028, .020, 16, axis='X'),
    loc=(-0.062, 0.050, 0.030), bevel=0)
add('Dial rim', 'body', 'brass', washer(.029, .024, .008, 16, axis='X'),
    loc=(-0.070, 0.050, 0.030), bevel=0)
add('Dial face', 'body', 'cream', tube(.023, .006, 16, axis='X'),
    loc=(-0.072, 0.050, 0.030), bevel=0)

# Identity markings, modelled as geometry on the receiver flanks.
add_text(ASSET, 'Marking IFRIT left', 'body', 'cream',
         (-0.0552, 0.210, 0.020), (math.pi / 2, 0, -math.pi / 2), .020)
add_text(ASSET, 'Marking IFRIT right', 'body', 'cream',
         (0.0552, 0.210, 0.020), (math.pi / 2, 0, math.pi / 2), .020)
add_text('VB 07', 'Marking VB 07 left', 'body', 'cream',
         (-0.0552, -0.040, 0.020), (math.pi / 2, 0, -math.pi / 2), .012)
add_text('VB 07', 'Marking VB 07 right', 'body', 'cream',
         (0.0552, -0.040, 0.020), (math.pi / 2, 0, math.pi / 2), .012)
# MAGAZINE: transverse fuel tank slung under the receiver. It detaches as one
# assembly on reload, so it owns the `mag` node.
# ===========================================================================
add('Fuel tank', 'mag', 'fuel red', tube(.080, .218, 24, axis='X'),
    loc=(0, 0.235, -0.136), bevel=.003)
pair('Tank end cap', 'mag', 'fuel red', tube(.082, .020, 24, axis='X'),
     loc=(.100, 0.235, -0.136), bevel=.002)
pair('Tank valve', 'mag', 'brass', tube(.020, .030, 12, axis='X'),
     loc=(.118, 0.235, -0.136), bevel=0)
pair('Tank strap', 'mag', 'webbing', washer(.083, .079, .024, 24, axis='X'),
     loc=(.050, 0.235, -0.136), bevel=0)
add('Fuel filler cap', 'mag', 'brass', tube(.022, .025, 12, axis='Z'),
    loc=(0.050, 0.235, -0.048), bevel=0)
pair('Tank rib', 'mag', 'fuel red', washer(.082, .078, .016, 24, axis='X'),
     loc=(.065, 0.235, -0.136), bevel=0)

# ===========================================================================
# HOSE: rubber loop down the left flank, tank heel to receiver heel, with
# brass elbows seating both ends and clamp bands on its long runs
# ===========================================================================
add('Hose inlet elbow', 'body', 'brass', tube(.018, .050, 12, axis='X'),
    loc=(-0.095, 0.170, -0.150), bevel=0)
add('Hose outlet elbow', 'body', 'brass', tube(.018, .050, 12, axis='X'),
    loc=(-0.0725, -0.100, -0.020), bevel=0)
HOSE_RUNS = [
    ((-0.100, 0.170, -0.150), (-0.100, 0.040, -0.190)),
    ((-0.100, 0.040, -0.190), (-0.100, -0.090, -0.165)),
    ((-0.100, -0.090, -0.165), (-0.100, -0.155, -0.080)),
    ((-0.100, -0.155, -0.080), (-0.100, -0.100, -0.020)),
]
for index, (start, end) in enumerate(HOSE_RUNS):
    dy, dz = end[1] - start[1], end[2] - start[2]
    length = math.hypot(dy, dz) + 0.030
    mid = (start[0], (start[1] + end[1]) / 2, (start[2] + end[2]) / 2)
    add(f'Hose run {index + 1}', 'body', 'rubber', tube(0.014, length, 12),
        loc=mid, rot=(math.atan2(dz, dy), 0, 0), bevel=.0015)
add('Hose clamp fore', 'body', 'brass', boxv((.036, .024, .024)),
    loc=(-0.100, 0.040, -0.190), bevel=.0015)
add('Hose clamp aft', 'body', 'brass', boxv((.036, .024, .024)),
    loc=(-0.100, -0.155, -0.080), bevel=.0015)

# ===========================================================================
# BOLT and TRIGGER: the two small moving owners. The arming lever rides the
# right manifold wall and throws toward +x.
# ===========================================================================
add('Bolt lever root', 'bolt', 'gunmetal', tube(.014, .030, 12, axis='X'),
    loc=(0.060, BOLT_HOME_Y, 0.050), bevel=0)
add('Bolt collar', 'bolt', 'gunmetal', washer(.017, .013, .010, 12, axis='X'),
    loc=(0.052, BOLT_HOME_Y, 0.050), bevel=0)
add('Bolt lever arm', 'bolt', 'gunmetal', boxv((.045, .016, .018)),
    loc=(0.085, BOLT_HOME_Y, 0.050), bevel=.003)
BOLT_KNOB_OBJECT = add('Bolt knob', 'bolt', 'rubber', taper(.016, .006, 0.0, 0.034, 16),
                       loc=(0.1045, BOLT_HOME_Y, 0.050), rot=(0, 0, -math.pi / 2), bevel=0)

TRIGGER_OBJECT = add('Trigger blade', 'trigger', 'gunmetal', boxv((.010, .014, .030)),
                     loc=(0, TRIGGER_Y, -0.040), rot=(math.radians(10), 0, 0), bevel=.002)
add('Trigger shoe', 'trigger', 'brass', boxv((.012, .010, .016)),
    loc=(0, 0.110, -0.053), rot=(math.radians(10), 0, 0), bevel=.0015)

add('Trigger guard', 'trigger', 'gunmetal', solid(recty(0.045, 0.175, -0.080, -0.010), .028, 'X',
                                                  recty(0.060, 0.160, -0.070, -0.022)), bevel=.003)

# ===========================================================================
# EXTRA: no loose rounds. The flamethrower reload detaches the whole fuel
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

for (key, value) in {'asset_id': 'ifrit',
                     'asset_name': 'IFRIT',
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
for (obj, _part, _material) in PARTS + [(o, 'extra', 'fuel red') for o in ROUND_OBJECTS]:
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
tip_plane = sorted({round(p[1], 9) for (p, n) in points if n == bore_object.name and p[1] > 0.650})
trigger_object = TRIGGER_OBJECT
trigger_low = min((trigger_object.matrix_world @ v.co)[2] for v in trigger_object.data.vertices)
bolt_handle = BOLT_KNOB_OBJECT
knob_far = max((bolt_handle.matrix_world @ v.co)[0] for v in bolt_handle.data.vertices)

CONTRACT = [
    ('muzzle_forward_vertex_y', tip[1], MUZZLE[1], 1e-6),
    ('muzzle_marker', MUZZLE[1], 0.655, 1e-9),
    ('bore_axis_x', bore_x, BORE_X, 1e-9),
    ('bore_axis_z', bore_z, BORE_Z, 1e-9),
    ('exposed_bore_radius_in_heat_band', band_radius, BORE_R, 1e-6),
    ('grip_marker_x', GRIP[0], 0.045, 1e-9),
    ('grip_marker_y', GRIP[1], 0.080, 1e-9),
    ('grip_marker_z', GRIP[2], -0.020, 1e-9),
    ('support_marker_x', SUPPORT[0], -0.060, 1e-9),
    ('support_marker_y', SUPPORT[1], 0.400, 1e-9),
    ('support_marker_z', SUPPORT[2], -0.030, 1e-9),
    ('sight_axis_z', SIGHT[2], SIGHT_Z, 1e-9),
    ('trigger_blade_y', TRIGGER_Y, 0.110, 1e-9),
    ('trigger_blade_tip_z', trigger_low, TRIGGER_TIP_Z, 1e-3),
    ('bolt_lever_home_y', BOLT_HOME_Y, 0.040, 1e-9),
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
if knob_far <= 0.10:
    contract_failures.append(f'bolt lever knob does not protrude to +x: reaches {knob_far:.4f}')

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
BLEND = DOCS / 'ifrit.blend'
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
CONTACT_ANCHOR = 'Manifold receiver'


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

GLB = DOCS / 'ifrit.glb'
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
            node.setdefault('extras', {})['blenderAsset'] = 'ifrit'
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
    'asset': 'IFRIT',
    'asset_id': 'ifrit',
    'kind': 'original stylized flamethrower prop (visual game asset)',
    'blender': bpy.app.version_string,
    'authoring_script': 'tools/blender/ifrit/build-ifrit.py',
    'source_parts': len(PARTS),
    'animation_group_nodes': GROUPS,
    'marker_nodes': sorted(MARKERS),
    'batch_nodes': len(batches),
    'round_nodes': [obj.name for obj in round_objects],
    'triangles': triangles,
    'triangles_per_primitive': per_primitive,
    'materials': [m[0] for m in MATERIALS] + ['pilot light'],
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
                        'exposed_bore': [CHAMBER_END, MUZZLE[1]],
                        'heat_band': [-HEAT_BAND[1], -HEAT_BAND[0]],
                        'sight_height': SIGHT_Z},
    'files': {'blend': 'docs/design/blender/ifrit/ifrit.blend',
              'glb': 'docs/design/blender/ifrit/ifrit.glb',
              'renders': ['render-hero.png', 'render-side.png', 'render-left.png',
                          'render-ads.png', 'render-rear.png'],
              'validation': 'docs/design/blender/ifrit/validation.json'},
    'build_time_checks': {
        'anchor_contract': 'muzzle plane, bore axis and exposed 0.0425 radius across '
                           'the whole heat band, all four markers, the 0.158 sight '
                           'line, the trigger blade and the bolt lever home position '
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
    'notes': ['Fresh design: no geometry reused from any older study.',
              'Open six-strut burner cage around the muzzle; the heat band stays bare metal.',
              'Transverse fuel tank owns the mag node and detaches on reload; extra ships empty.',
              'Pilot flame is an unmapped emissive material, flagged for the flame-glow rig.',
              'Markings are modelled geometry, not a texture decal.'],
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
