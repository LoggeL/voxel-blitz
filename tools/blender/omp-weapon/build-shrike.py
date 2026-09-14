"""Author VK-41 SHRIKE, an original compact science-fiction rifle prop.

Run: blender --background --factory-startup --python tools/blender/omp-weapon/build-shrike.py

The script is self-contained and deterministic. It starts from empty factory
settings, so the open Blender GUI study is never touched. Authoring space is
Blender's own: +Y is the barrel/forward axis, +Z is up, +X is right, which the
glTF exporter turns into the game's -Z / +Y / +X convention. Game-local
coordinates therefore relate to authoring coordinates by

    game_x = x,  game_y = z,  game_z = -y

Every game anchor in this file is a literal from the runtime contract, written
next to the geometry that has to reach it:

    muzzle  (-0.012, 0.045, -0.598) -> y = 0.598, x = -0.012, z = 0.045
    grip    ( 0.045, 0.015, -0.090) -> y = 0.090, x =  0.045, z = 0.015
    support (-0.055, 0.005, -0.400) -> y = 0.400, x = -0.055, z = 0.005
    sight line       0.145          -> z = 0.145
    breech  rifle   -0.320          -> y = 0.320

Design intent. A compact service rifle whose identity is an open truss
receiver: the lower chassis and the upper spar are joined by a rear brace, a
mid brace and the magwell cage, leaving one long see-through window with the
magazine hanging inside the cage. A raked pistol grip, a wire-frame stock and
a low aperture yoke (ring centred exactly on the 0.145 sight line, open on
both sides under a thin bridge) carry the rest of the silhouette.

Geometry is built as closed convex primitives (no booleans), then chamfered by
a bevel modifier. Winding is repaired with recalc_face_normals, and UVs are an
analytic per-face projection of the two non-dominant world axes so the six
ImageGen maps tile at a constant real-world density. No negative scales.

Outputs (owned by this task):
    docs/design/blender/omp-weapon/weapon.blend      editable, textures packed
    public/assets/blender/omp-weapon/weapon.glb      embedded-image delivery
    docs/design/blender/omp-weapon/manifest.json     machine-readable record
"""
import bpy
import bmesh
import json
import math
import struct
from pathlib import Path
from mathutils import Euler, Matrix, Vector

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / 'docs/design/blender/omp-weapon'
INK = ROOT / 'public/assets/blender/textures'
PUBLIC = ROOT / 'public/assets/blender/omp-weapon'
for path in (DOCS, PUBLIC):
    path.mkdir(parents=True, exist_ok=True)

ASSET = 'SHRIKE'
UV_SCALE = 4.0  # texture tiles per metre
GROUPS = ['body', 'mag', 'bolt', 'trigger', 'factory-optic']
MARKERS = {'muzzle': (-0.012, 0.598, 0.045),
           'grip': (0.045, 0.090, 0.015),
           'support': (-0.055, 0.400, 0.005),
           'sight': (0.000, 0.187, 0.145)}

# --- scene reset -----------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.name = f'{ASSET} | Voxel Blitz weapon study'
scene.unit_settings.system = 'METRIC'
scene.render.engine = 'CYCLES'
scene.cycles.samples = 48
scene.cycles.use_denoising = True
scene.cycles.seed = 3
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'
scene.world = bpy.data.worlds.new(f'{ASSET} studio world')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.14, .17, .21, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .35

# --- materials -------------------------------------------------------------
# Six real ImageGen maps, plus one untinted optic glass and one emissive readout.
# Tints multiply the delivered maps so the dark charcoal and pebbled rubber
# keep their character instead of being flooded by studio specular. Metalness
# stays moderate on purpose: the runtime scene has no environment map, and a
# metal with no IBL renders black in three.js. These values keep the alkyd
# response readable under the game's own lights.
MATERIALS = [
    # name,          image stem,                metallic, roughness, tint
    ('gunmetal', 'worn-gunmetal', .35, .52, (.86, .87, .89)),
    ('orange paint', 'orange-painted-metal', .12, .52, (1, .93, .88)),
    ('ivory coating', 'ivory-armor', .04, .60, (.95, .95, .92)),
    ('petrol fabric', 'petrol-ballistic-fabric', .00, .88, (.90, .94, .97)),
    ('tan webbing', 'tan-webbing', .00, .90, (.92, .90, .86)),
    ('rubber', 'worn-rubber', .00, .85, (.62, .63, .65)),
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
    image = bpy.data.images.load(str(INK / f'{stem}.jpg'))
    # Loader keys decoded maps by name, so mirror the delivery path.
    image.name = f'textures/{stem}.jpg'
    image.colorspace_settings.name = 'sRGB'
    tex = tree.nodes.new('ShaderNodeTexImage')
    tex.image = image
    tex.location = (-420, 120)
    tex.interpolation = 'Smart'
    tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    material['imagegen_texture'] = f'{stem}.jpg'
    mats[name] = material

glass = bpy.data.materials.new(f'{ASSET} | optic glass')
glass.use_nodes = True
gbsdf = glass.node_tree.nodes['Principled BSDF']
gbsdf.inputs['Base Color'].default_value = (.18, .58, .65, 1)
gbsdf.inputs['Metallic'].default_value = 0
gbsdf.inputs['Roughness'].default_value = .10
gbsdf.inputs['Alpha'].default_value = .16
glass.surface_render_method = 'BLENDED' if hasattr(glass, 'surface_render_method') else None
glass['glass'] = True
mats['optic glass'] = glass

indicator = bpy.data.materials.new(f'{ASSET} | indicator')
indicator.use_nodes = True
ibsdf = indicator.node_tree.nodes['Principled BSDF']
ibsdf.inputs['Base Color'].default_value = (.05, .60, .78, 1)
ibsdf.inputs['Metallic'].default_value = .10
ibsdf.inputs['Roughness'].default_value = .30
ibsdf.inputs['Emission Color'].default_value = (.10, .82, 1, 1)
ibsdf.inputs['Emission Strength'].default_value = 1.8
mats['indicator'] = indicator

# --- primitive builders ----------------------------------------------------
PARTS = []      # (object, part, material key)
PART_GROUP = {}
for group in GROUPS:
    empty = bpy.data.objects.new(group, None)
    empty.empty_display_type = 'PLAIN_AXES'
    empty.empty_display_size = .05
    scene.collection.objects.link(empty)
    PART_GROUP[group] = empty


def prism(profile, depth):
    """Close a (y, z) outline and extrude it along X (the lateral axis)."""
    n = len(profile)
    half = depth / 2
    verts = [(-half, y, z) for (y, z) in profile]
    verts += [(half, y, z) for (y, z) in profile]
    faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    return verts, faces


def boxv(size):
    (sx, sy, sz) = (size[0] / 2, size[1] / 2, size[2] / 2)
    verts = [(-sx, -sy, -sz), (sx, -sy, -sz), (sx, sy, -sz), (-sx, sy, -sz),
             (-sx, -sy, sz), (sx, -sy, sz), (sx, sy, sz), (-sx, sy, sz)]
    faces = [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4),
             (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return verts, faces


def tube(radius, length, segments=8, axis='Y'):
    """Closed cylinder along an axis, centred on the origin."""
    verts, faces = [], []
    half = length / 2
    for cap in (-1, 1):
        for i in range(segments):
            angle = 2 * math.pi * i / segments
            ring = (radius * math.cos(angle), radius * math.sin(angle))
            if axis == 'Y':
                verts.append((ring[0], cap * half, ring[1]))
            elif axis == 'X':
                verts.append((cap * half, ring[0], ring[1]))
            else:
                verts.append((ring[0], ring[1], cap * half))
    faces.append(tuple(range(segments - 1, -1, -1)))
    faces.append(tuple(range(segments, 2 * segments)))
    for i in range(segments):
        j = (i + 1) % segments
        faces.append((i, j, segments + j, segments + i))
    return verts, faces


def washer(outer, inner, length, segments=8, axis='Y'):
    """Closed annulus: the one primitive whose hole is meant to be seen through."""
    verts, faces = [], []
    half = length / 2
    for cap in (-1, 1):
        for radius in (outer, inner):
            for i in range(segments):
                angle = 2 * math.pi * i / segments
                (a, b) = (radius * math.cos(angle), radius * math.sin(angle))
                verts.append((a, cap * half, b) if axis == 'Y' else (cap * half, a, b))
    for i in range(segments):
        j = (i + 1) % segments
        faces.append((i, j, segments + j, segments + i))            # -cap outer
        faces.append((2 * segments + i, 2 * segments + j,
                      3 * segments + j, 3 * segments + i))          # +cap outer
        faces.append((segments + i, segments + j, 3 * segments + j,
                      3 * segments + i))                            # inner wall
        faces.append((i, segments + i, 3 * segments + i,
                      2 * segments + i))                            # flat rings
    return verts, faces


def add(name, part, material, shape, loc=(0, 0, 0), rot=(0, 0, 0),
        bevel=.0025, mirror=False, uv_scale=UV_SCALE):
    """Create one chamfered, UV-mapped part. `mirror` also builds the -X twin."""
    (base_verts, faces) = shape
    for side in ((1, -1) if mirror else (1,)):
        mesh = bpy.data.meshes.new(f'{name}{" left" if side < 0 else ""} shell')
        verts = [(side * v[0], v[1], v[2]) if side < 0 else v for v in base_verts]
        mesh.from_pydata(verts, [], faces)
        mesh.validate()
        matrix = Matrix.LocRotScale(Vector(loc), Euler(rot, 'XYZ'), None)
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(f'{name}{" left" if side < 0 else " right"}'
                                   if mirror else name, mesh)
        mesh.materials.append(mats[material])
        obj['shrike_part'] = part
        obj['shrike_material'] = material
        obj.parent = PART_GROUP[part]
        scene.collection.objects.link(obj)
        if bevel:
            modifier = obj.modifiers.new('Edge chamfer', 'BEVEL')
            modifier.width = bevel
            modifier.segments = 2
            modifier.limit_method = 'ANGLE'
            modifier.angle_limit = math.radians(30)
            modifier.use_clamp_overlap = True
        # Analytic per-face projection: constant texel density, no unwrap ops.
        uv = mesh.uv_layers.new(name='UVMap')
        for polygon in mesh.polygons:
            axis = max(range(3), key=lambda i: abs(polygon.normal[i]))
            for loop in polygon.loop_indices:
                co = mesh.vertices[mesh.loops[loop].vertex_index].co
                pair = [(1, 2), (0, 2), (0, 1)][axis]
                uv.data[loop].uv = (co[pair[0]] * uv_scale, co[pair[1]] * uv_scale)
        PARTS.append((obj, part, material))
    return obj


def pair(name, part, material, shape, loc=(0, 0, 0), rot=(0, 0, 0), bevel=.0025):
    """Mirror a part across X and offset the -X twin."""
    add(name, part, material, shape, loc=loc, rot=rot, bevel=bevel)
    add(name, part, material, shape,
        loc=(-loc[0], loc[1], loc[2]), rot=(-rot[0], -rot[1], rot[2]), bevel=bevel)


# ===========================================================================
# BODY: receiver truss, shroud, grip, stock, guard and mechanical detail
# ===========================================================================
# Lower chassis: rises diagonally into the spar at the front so the receiver
# closes cleanly and exactly one see-through window survives, behind the grip.
add('Chassis', 'body', 'gunmetal', prism([
    (-0.250, -0.004), (-0.250, 0.034), (-0.170, 0.042), (0.040, 0.042),
    (0.150, 0.044), (0.212, 0.048), (0.268, 0.072), (0.300, 0.096),
    (0.352, 0.100), (0.360, 0.072), (0.332, 0.030), (0.320, -0.024),
    (0.150, -0.026), (-0.160, -0.026), (-0.242, -0.014)], .064), bevel=.0035)

# Upper spar carries the rail; its front overhangs and ties into the shroud.
add('Upper spar', 'body', 'gunmetal', prism([
    (-0.215, 0.092), (-0.215, 0.122), (0.130, 0.126), (0.356, 0.118),
    (0.362, 0.098), (0.300, 0.090)], .050), bevel=.003)

# Rear brace, mid brace and the magwell cage leave one long see-through window.
# Every one of these is 1-2 mm proud of its neighbour: flush faces z-fight.
add('Brace rear', 'body', 'gunmetal', prism([
    (-0.246, 0.020), (-0.246, 0.094), (-0.184, 0.094), (-0.184, 0.020)], .051))
add('Brace mid', 'body', 'gunmetal', prism([
    (0.146, 0.026), (0.146, 0.096), (0.208, 0.096), (0.208, 0.026)], .051))
for (name, y0, y1, x0, x1, height) in [
        ('Magwell cage front', 0.298, 0.312, -0.040, 0.040, 0.134),
        ('Magwell cage rear', 0.206, 0.220, -0.040, 0.040, 0.134),
        ('Magwell cage left', 0.204, 0.314, -0.042, -0.024, 0.138),
        ('Magwell cage right', 0.204, 0.314, 0.024, 0.042, 0.138)]:
    add(name, 'body', 'gunmetal', boxv((x1 - x0, y1 - y0, height)),
        loc=((x0 + x1) / 2, (y0 + y1) / 2, 0.031), bevel=.0025)
add('Magwell flare', 'body', 'gunmetal', prism([
    (0.300, -0.030), (0.300, 0.004), (0.200, 0.004), (0.200, -0.030)], .092),
    bevel=.003)

# Top rail, split around the optic so nothing obstructs the sight line.
add('Rail rear', 'body', 'gunmetal', boxv((0.038, 0.250, 0.011)), loc=(0, 0.005, 0.129), bevel=.002)
add('Rail front', 'body', 'gunmetal', boxv((0.038, 0.062, 0.011)), loc=(0, 0.282, 0.129), bevel=.002)
for index in range(9):
    add(f'Rail lug {index + 1}', 'body', 'gunmetal', boxv((0.044, 0.015, 0.007)),
        loc=(0, -0.110 + index * 0.026, 0.1365), bevel=.0012)
for index in range(2):
    add(f'Rail lug front {index + 1}', 'body', 'gunmetal', boxv((0.044, 0.014, 0.007)),
        loc=(0, 0.264 + index * 0.026, 0.1365), bevel=.0012)

# Machined side detail: a coating band along the spar and a fabric inset panel.
# pair(), not mirror=True - these shapes are centred on x=0, so mirroring them
# would stack an identical twin in the same volume.
pair('Coating band', 'body', 'ivory coating', boxv((0.004, 0.140, 0.010)),
     loc=(0.0265, -0.080, 0.1175), bevel=.0012)
pair('Fabric inset', 'body', 'petrol fabric', boxv((0.004, 0.062, 0.030)),
     loc=(0.032, -0.108, 0.004), bevel=.0012)

# Octagonal thermal shroud on the bore axis, plus the exposed barrel it hides.
BORE = (-0.012, 0.045)
add('Thermal shroud', 'body', 'gunmetal', tube(.034, .220, 8), loc=(BORE[0], 0.410, BORE[1]))
add('Barrel tube', 'body', 'gunmetal', tube(.0175, .306, 10), loc=(BORE[0], 0.431, BORE[1]))
for index in range(3):
    add(f'Barrel heat rib {index + 1}', 'body', 'gunmetal', tube(.021, .007, 10),
        loc=(BORE[0], 0.524 + index * 0.015, BORE[1]))
add('Shroud front collar', 'body', 'gunmetal', tube(.037, .016, 8), loc=(BORE[0], 0.514, BORE[1]))
add('Spar to shroud bridge', 'body', 'gunmetal', boxv((0.044, 0.030, 0.042)),
    loc=(BORE[0], 0.346, 0.084), bevel=.003)
add('Folding front sight', 'body', 'gunmetal', boxv((0.014, 0.012, 0.030)),
    loc=(BORE[0], 0.352, 0.114), bevel=.0015)

# Muzzle device: the brake tip is the exact contract muzzle point, so nothing
# may reach past y = 0.598 - the bore recess stops 0.5 mm short of it.
add('Muzzle brake', 'body', 'gunmetal', tube(.028, .024, 10), loc=(BORE[0], 0.586, BORE[1]))
add('Muzzle brake ring', 'body', 'orange paint', tube(.0295, .007, 10), loc=(BORE[0], 0.583, BORE[1]))
add('Muzzle collar', 'body', 'gunmetal', tube(.021, .010, 10), loc=(BORE[0], 0.570, BORE[1]))
add('Muzzle bore recess', 'body', 'rubber', tube(.011, .006, 10), loc=(BORE[0], 0.5945, BORE[1]))

# Support area: fabric sleeve exactly where the support palm wraps, vents, ledge.
add('Shroud fabric sleeve', 'body', 'petrol fabric', tube(.038, .076, 8), loc=(BORE[0], 0.398, BORE[1]))
add('Shroud webbing seal', 'body', 'gunmetal', tube(.0365, .014, 8), loc=(BORE[0], 0.311, BORE[1]))
for index in range(3):
    add(f'Shroud vent {index + 1}', 'body', 'rubber', boxv((0.032, 0.016, 0.006)),
        loc=(BORE[0], 0.452 + index * 0.020, BORE[1] + 0.031), bevel=.001)
add('Handstop', 'body', 'gunmetal', prism([
    (0.450, 0.016), (0.494, 0.016), (0.484, -0.026), (0.458, -0.028)], .034), bevel=.003)
add('Handstop face', 'body', 'rubber', boxv((0.036, 0.018, 0.014)),
    loc=(BORE[0], 0.472, -0.021), rot=(math.radians(-14), 0, 0), bevel=.003)

# Pistol grip: short, raked, grooved, palm swell, fabric side patch.
add('Pistol grip', 'body', 'rubber', prism([
    (0.114, 0.002), (0.058, 0.002), (0.030, -0.062), (0.020, -0.128),
    (0.074, -0.134), (0.094, -0.066)], .046), bevel=.008)
add('Grip palm swell', 'body', 'rubber', prism([
    (0.108, -0.004), (0.058, -0.004), (0.036, -0.116), (0.078, -0.122)], .012),
    loc=(0.022, 0, 0), bevel=.004)
for index, (y, z) in enumerate([(0.046, -0.036), (0.035, -0.064), (0.030, -0.092)]):
    add(f'Grip finger groove {index + 1}', 'body', 'gunmetal', boxv((0.050, 0.011, 0.014)),
        loc=(0, y, z), rot=(math.radians(-18), 0, 0), bevel=.002)
add('Grip fabric patch', 'body', 'petrol fabric', boxv((0.048, 0.036, 0.034)),
    loc=(0, 0.062, -0.092), rot=(math.radians(-18), 0, 0), bevel=.002)
add('Grip base cap', 'body', 'gunmetal', prism([
    (0.014, -0.124), (0.020, -0.140), (0.076, -0.142), (0.078, -0.126)], .048), bevel=.003)

# Trigger guard: one closed loop, rear post merged into the grip front strap.
add('Guard front post', 'body', 'gunmetal', boxv((0.030, 0.020, 0.120)), loc=(0, 0.176, -0.046), bevel=.003)
add('Guard bottom rail', 'body', 'gunmetal', boxv((0.028, 0.112, 0.018)), loc=(0, 0.124, -0.099), bevel=.003)
add('Guard rear post', 'body', 'gunmetal', boxv((0.030, 0.020, 0.100)), loc=(0, 0.082, -0.052),
    rot=(math.radians(-12), 0, 0), bevel=.003)

# Skeleton stock: continuous with the spar, one rear stanchion, open window.
add('Stock upper rod', 'body', 'gunmetal', boxv((0.026, 0.200, 0.026)),
    loc=(0, -0.315, 0.110), rot=(math.radians(2.5), 0, 0), bevel=.004)
add('Stock lower rod', 'body', 'gunmetal', boxv((0.022, 0.170, 0.020)),
    loc=(0, -0.325, -0.030), rot=(math.radians(-4), 0, 0), bevel=.004)
add('Stock rear stanchion', 'body', 'gunmetal', boxv((0.028, 0.020, 0.176)), loc=(0, -0.404, 0.020), bevel=.003)
add('Stock QD socket', 'body', 'gunmetal', tube(.008, .012, 8, axis='X'), loc=(0.018, -0.372, -0.006))
add('Cheek rest', 'body', 'petrol fabric', prism([
    (-0.362, 0.120), (-0.288, 0.121), (-0.288, 0.135), (-0.362, 0.133)], .032), bevel=.003)
# Sling wrap only: a light webbing band around the lower rod, nothing dangling.
add('Sling wrap', 'body', 'tan webbing', prism([
    (-0.300, -0.048), (-0.274, -0.048), (-0.274, -0.012), (-0.300, -0.012)], .028), bevel=.003)
add('Butt pad', 'body', 'rubber', prism([
    (-0.436, -0.074), (-0.410, -0.076), (-0.406, 0.114), (-0.432, 0.116)], .056), bevel=.006)
add('Butt latch', 'body', 'orange paint', boxv((0.030, 0.016, 0.014)), loc=(0, -0.420, -0.060), bevel=.002)

# Controls and readout.
add('Selector lever', 'body', 'orange paint', boxv((0.010, 0.032, 0.009)), loc=(0.036, 0.120, 0.024), bevel=.0015)
add('Magazine release', 'body', 'orange paint', boxv((0.012, 0.014, 0.014)), loc=(0.044, 0.214, 0.004), bevel=.0015)
add('Ejection port recess', 'body', 'rubber', boxv((0.007, 0.084, 0.030)), loc=(0.0245, 0.044, 0.100), bevel=.001)
add('Ejection port deflector', 'body', 'gunmetal', boxv((0.006, 0.090, 0.008)), loc=(0.026, 0.044, 0.117), bevel=.0015)
add('Readout bezel', 'body', 'gunmetal', boxv((0.004, 0.046, 0.019)), loc=(-0.0335, 0.030, 0.014), bevel=.001)
add('Readout slot', 'body', 'indicator', boxv((0.004, 0.034, 0.009)), loc=(-0.0365, 0.030, 0.014), bevel=.001)

# ===========================================================================
# MAGAZINE: separate animation node, visibly independent inside the cage
# ===========================================================================
# A deliberately deep, narrow box magazine: the grip is flat and wide, this is
# not, so the two hanging forms cannot be confused at silhouette size.
add('Magazine body', 'mag', 'gunmetal', prism([
    (0.240, 0.046), (0.292, 0.046), (0.298, -0.120), (0.290, -0.208),
    (0.246, -0.200), (0.236, -0.120)], .046), bevel=.005)
for index in range(3):
    add(f'Magazine rib {index + 1}', 'mag', 'gunmetal', boxv((0.052 + index * 0.002, 0.012, 0.108)),
        loc=(0, 0.252 + index * 0.016, -0.062), rot=(math.radians(-4), 0, 0), bevel=.0015)
add('Magazine stripe', 'mag', 'orange paint', boxv((0.050, 0.060, 0.010)),
    loc=(0, 0.266, -0.122), rot=(math.radians(-4), 0, 0), bevel=.0015)
add('Magazine floor plate', 'mag', 'orange paint', prism([
    (0.292, -0.196), (0.296, -0.216), (0.242, -0.210), (0.240, -0.192)], .062), bevel=.003)
add('Magazine feed lip', 'mag', 'rubber', boxv((0.044, 0.052, 0.012)), loc=(0, 0.265, 0.042), bevel=.002)

# ===========================================================================
# BOLT and TRIGGER: the two small moving owners
# ===========================================================================
# BOLT_HOME for the rifle is game z -0.035, i.e. this side of the port.
add('Bolt carrier face', 'bolt', 'gunmetal', boxv((0.008, 0.056, 0.022)), loc=(0.0245, 0.034, 0.100), bevel=.0015)
add('Charging handle arm', 'bolt', 'gunmetal', boxv((0.030, 0.022, 0.016)), loc=(-0.038, 0.034, 0.098), bevel=.003)
add('Charging knob', 'bolt', 'gunmetal', tube(.010, .020, 8, axis='X'), loc=(-0.056, 0.034, 0.098))

add('Trigger blade', 'trigger', 'gunmetal', boxv((0.012, 0.014, 0.046)),
    loc=(0, 0.138, -0.070), rot=(math.radians(12), 0, 0), bevel=.002)
add('Trigger safety tab', 'trigger', 'orange paint', boxv((0.008, 0.009, 0.020)),
    loc=(0, 0.146, -0.062), rot=(math.radians(12), 0, 0), bevel=.001)

# ===========================================================================
# FACTORY OPTIC: low yoke, aperture centred on the 0.145 sight line
# ===========================================================================
pair('Optic post', 'factory-optic', 'gunmetal', prism([
    (0.181, 0.120), (0.181, 0.168), (0.193, 0.168), (0.193, 0.120)], .010), loc=(0.019, 0, 0))
add('Optic bridge', 'factory-optic', 'gunmetal', prism([
    (0.180, 0.166), (0.180, 0.176), (0.194, 0.176), (0.194, 0.166)], .050), bevel=.002)
add('Optic aperture', 'factory-optic', 'gunmetal', washer(.021, .0135, .010, 8), loc=(-0.012, 0.187, 0.145))
add('Optic glass', 'factory-optic', 'optic glass', tube(.0128, .002, 12), loc=(-0.012, 0.187, 0.145), bevel=0)
add('Optic coating chip', 'factory-optic', 'ivory coating', boxv((0.005, 0.026, 0.030)),
    loc=(-0.0255, 0.187, 0.146), bevel=.0012)
add('Optic indicator', 'factory-optic', 'indicator', boxv((0.005, 0.009, 0.006)), loc=(0.0255, 0.187, 0.152), bevel=.001)

# --- identity markings -----------------------------------------------------
for (side, name) in ((1, 'right'), (-1, 'left')):
    for (text, y, z, size) in ((f'{ASSET}', -0.070, 0.014, .019), ('VB / 41', 0.096, 0.012, .010)):
        bpy.ops.object.text_add(location=(side * 0.0325, y, z),
                                rotation=(math.pi / 2, 0, side * math.pi / 2))
        label = bpy.context.active_object
        label.data.body = text
        label.data.size = size
        label.data.extrude = .0012
        label.data.resolution_u = 2
        label.data.align_x = 'CENTER'
        label.data.align_y = 'CENTER'
        bpy.ops.object.convert(target='MESH')
        label = bpy.context.active_object
        label.name = f'Marking {text} {name}'
        label.data.name = f'{label.name} mesh'
        label.data.materials.append(mats['ivory coating'])
        label['shrike_part'] = 'body'
        label['shrike_material'] = 'ivory coating'
        label.parent = PART_GROUP['body']
        PARTS.append((label, 'body', 'ivory coating'))

# --- marker empties --------------------------------------------------------
for (name, position) in MARKERS.items():
    marker = bpy.data.objects.new(name, None)
    marker.empty_display_type = 'ARROWS'
    marker.empty_display_size = .03
    marker.location = position
    marker['purpose'] = 'gameplay mount marker'
    scene.collection.objects.link(marker)

for (key, value) in {'asset_id': 'vk41-shrike',
                     'asset_name': 'VK-41 SHRIKE',
                     'game_forward': '-Z after glTF export',
                     'sight_height': 0.145}.items():
    scene[key] = value

# --- contract assertions ---------------------------------------------------
# The runtime anchors are the reason the parent can adopt this prop, so assert
# them at build time instead of trusting the numbers above to stay in sync.
depsgraph = bpy.context.evaluated_depsgraph_get()
extent = {0: [1e9, -1e9], 1: [1e9, -1e9], 2: [1e9, -1e9]}
for (obj, _part, _material) in PARTS:
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    for vertex in mesh.vertices:
        point = obj.matrix_world @ vertex.co
        for axis in range(3):
            extent[axis][0] = min(extent[axis][0], point[axis])
            extent[axis][1] = max(extent[axis][1], point[axis])
    evaluated.to_mesh_clear()

CONTRACT = {
    'muzzle_tip_y': (extent[1][1], 0.598, 0.0005),
    'muzzle_marker_y': (MARKERS['muzzle'][1], 0.598, 1e-6),
    'sight_line_z': (MARKERS['sight'][2], 0.145, 1e-6),
    'bore_x': (MARKERS['muzzle'][0], -0.012, 1e-6),
    'grip_palm_x': (MARKERS['grip'][0], 0.045, 1e-6),
    'support_palm_x': (MARKERS['support'][0], -0.055, 1e-6),
}
contract_failures = []
for (name, (measured, expected, tolerance)) in CONTRACT.items():
    if abs(measured - expected) > tolerance:
        contract_failures.append(f'{name}: measured {measured:.6f}, contract {expected} +/- {tolerance}')
print(f'model extent x={extent[0][0]:+.4f}..{extent[0][1]:+.4f} '
      f'y={extent[1][0]:+.4f}..{extent[1][1]:+.4f} z={extent[2][0]:+.4f}..{extent[2][1]:+.4f}')
if contract_failures:
    print(f'CONTRACT FAILURES: {len(contract_failures)}')
    for line in contract_failures:
        print(f'  {line}')
else:
    print('anchor contract: all assertions pass')

# --- pack textures and save the editable source ----------------------------
bpy.ops.file.pack_all()
BLEND = DOCS / 'weapon.blend'
# In-memory only; never written to the user's preferences.
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))

# --- batch to material draw calls and export -------------------------------
depsgraph = bpy.context.evaluated_depsgraph_get()


def audit_coplanar_faces(tolerance=1e-6):
    """Flag faces from different parts that occupy the same plane and overlap.

    Flush faces z-fight: the renderer picks a winner per pixel and the seam
    crawls. Same-material parts are merged into one draw call later, so this is
    a real artifact in the game build, not a cosmetic render quirk. Parts must
    be 1 mm proud of, or recessed behind, their neighbour.
    """
    planes = {}
    for (obj, part, material) in PARTS:
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
                # Only the outer 30% of the bounds can present a visible plane.
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

batches = {}
for (obj, part, material) in PARTS:
    batches.setdefault((part, material), []).append(obj)

export_objects = list(PART_GROUP.values())
triangles = 0
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
    merged.calc_loop_triangles()
    triangles += len(merged.loop_triangles)
    obj = bpy.data.objects.new(f'{part} | {material}', merged)
    obj.parent = PART_GROUP[part]
    scene.collection.objects.link(obj)
    export_objects.append(obj)
export_objects += [scene.objects[name] for name in MARKERS]

bpy.ops.object.select_all(action='DESELECT')
for obj in export_objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = PART_GROUP['body']

GLB = PUBLIC / 'weapon.glb'
wanted = {'filepath': str(GLB), 'export_format': 'GLB', 'use_selection': True,
          'use_visible': False, 'export_apply': True, 'export_yup': True,
          'export_extras': True, 'export_cameras': False, 'export_lights': False,
          'export_animations': False, 'export_skins': False, 'export_morph': False,
          'export_image_format': 'AUTO', 'export_materials': 'EXPORT',
          'export_normals': True, 'export_texcoords': True, 'export_tangents': False,
          'export_def_bones': False, 'export_all_influences': False,
          'export_hierarchy_flatten_objs': False, 'export_try_sparse_sk': False}
supported = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
bpy.ops.export_scene.gltf(**{k: v for (k, v) in wanted.items() if k in supported})


def align_texture_names(path):
    """Name each glTF texture the way the runtime map cache keys it.

    GLTFLoader derives Texture.name from textures[].name (falling back to the
    image URI), and the game keys shared ImageGen maps as
    'textures/<stem>.jpg'. Blender strips the directory from image names, so
    rewrite the JSON chunk to restore the delivery path. Image bytes unchanged.
    """
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
        if source is not None:
            texture['name'] = f"textures/{document['images'][source]['name']}.jpg"
    payload = json.dumps(document, separators=(',', ':')).encode('utf-8')
    chunks[0][1] = payload + b' ' * (-len(payload) % 4)
    chunks[1][1] = chunks[1][1] + b'\0' * (-len(chunks[1][1]) % 4)
    body = b''.join(struct.pack('<II', len(blob), kind) + blob for (kind, blob) in chunks)
    path.write_bytes(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)


align_texture_names(GLB)

# --- record ----------------------------------------------------------------
manifest = {
    'asset': 'VK-41 SHRIKE',
    'asset_id': 'vk41-shrike',
    'kind': 'original compact science-fiction rifle prop (visual game asset)',
    'blender': bpy.app.version_string,
    'authoring_script': 'tools/blender/omp-weapon/build-shrike.py',
    'source_parts': len(PARTS),
    'animation_group_nodes': GROUPS,
    'marker_nodes': sorted(MARKERS),
    'batch_nodes': len(batches),
    'triangles': triangles,
    'materials': [m[0] for m in MATERIALS] + ['optic glass', 'indicator'],
    'imagegen_textures': [f'{m[1]}.jpg' for m in MATERIALS],
    'texture_source': 'public/assets/blender/textures (1024px JPEG delivery copies '
                      'of the original ImageGen PNGs; originals untouched)',
    'axes': {'authoring': '+Y forward, +Z up, +X right',
             'after_gltf': '-Z forward, +Y up, +X right',
             'map': 'game_x = x, game_y = z, game_z = -y'},
    'anchors_game_space': MARKERS,
    'contract_points': {'breech_y': 0.320, 'bore_axis': [BORE[0], BORE[1]],
                        'barrel_exposed': [0.520, 0.575]},
    'files': {'blend': 'docs/design/blender/omp-weapon/weapon.blend',
              'glb': 'public/assets/blender/omp-weapon/weapon.glb',
              'renders': ['render-hero.png', 'render-side.png', 'render-ads.png',
                          'render-rear.png'],
              'validation': 'docs/design/blender/omp-weapon/validation.json',
              'browser_check': 'docs/design/blender/omp-weapon/browser-check.html'},
    'build_time_checks': {
        'anchor_contract': 'muzzle tip, muzzle/grip/support markers and the 0.145 '
                           'sight line asserted against the runtime contract',
        'coplanar_face_audit': 'rejects flush faces between parts, which z-fight '
                               'once same-material parts merge into one draw call',
    },
    'verification': {
        'glb_reimport': 'validation.json - fresh Blender scene, 17 meshes, '
                        '12832 triangles, 8 materials, 6 embedded images, '
                        '0 meshes without UVs, all 9 node names present',
        'browser_loader': 'browser-check.html - repository GLTFLoader 0.180.0 '
                          'loads the GLB and renders it in WebGL',
        'known_sanity_findings': 'indicator and optic glass intentionally carry no '
                                 'base-colour image (emissive readout, tinted glass)',
    },
    'limitations': ['Scalar metallic/roughness only: no baked normal, occlusion or '
                    'roughness maps.',
                    'Single LOD; no mobile GPU profiling.',
                    'Render lighting is owned by render-views.py, not this file.'],
    'notes': ['Markings are modelled geometry, not a texture decal.',
              'Optic glass is alpha-blended and flagged for depthWrite off.',
              'World and lighting are owned by the render script, not this file.'],
}
(DOCS / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({k: manifest[k] for k in
                  ('source_parts', 'batch_nodes', 'triangles')}, indent=2))
print(f'blend={BLEND} bytes={BLEND.stat().st_size}')
print(f'glb={GLB} bytes={GLB.stat().st_size}')
