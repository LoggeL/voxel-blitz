"""Author SUBSTATION, an original voxel arena map for Voxel Blitz, in Blender.

The map is a compact 128 x 96 x 40 electrical switchyard: a two-storey
control house with a roof perch in the middle, four transformer bays in the
corners, a maintenance workshop in the west, a shunt-reactor pad in the east,
steel gantries over the outer lanes and rows of switchgear cabinets as mid
cover. Everything is authored on the game's 1 m voxel grid in Blender's own
axes (X = voxel x, Y = voxel z, Z = voxel y) and textured with the six
Codex ImageGen materials under docs/design/blender/substation/textures/.

Run through the live Blender MCP session (protocol 5) on 127.0.0.1:9876:

    from pathlib import Path
    p = Path('.../tools/blender/substation/build-substation.py')
    exec(compile(p.read_text(), str(p), 'exec'), {'__file__': str(p)})

or headless:

    blender --background --factory-startup --python build-substation.py

The script is deterministic and self-contained. It creates its own scene and
collection, never touches other open studies, writes the .blend with
`copy=True`, exports a portable GLB, and derives the runtime data the game
consumes:

    docs/design/blender/substation/substation.blend   editable study
    docs/design/blender/substation/substation.glb     portable GLB (JPEG maps)
    docs/design/blender/substation/manifest.json      machine-readable record
    shared/world/substation-data.js                   voxel RLE, anchors, tiles

Integration decision (see docs/design/blender/README.md): the game simulates,
collides, meshes, damages and path-finds on voxel bytes, so the Blender
geometry is voxelised here at cell centres (axis-aligned boxes by extent,
cylinders by BVH ray parity) into the same y/z/x byte layout the server
serialises. The six textures are box-filtered to 16 x 16 atlas tiles for the
browser's procedural block atlas, so the ImageGen materials drive the in-game
look at voxel resolution. The GLB is design reference only; the runtime never
loads it.
"""
import base64
import bmesh
import bpy
import hashlib
import json
import math
import time
from pathlib import Path

import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / 'docs/design/blender/substation'
TEX = DOCS / 'textures'
DATA_JS = ROOT / 'shared/world/substation-data.js'
DOCS.mkdir(parents=True, exist_ok=True)

ASSET = 'SUBSTATION'
SCENE_NAME = f'{ASSET} | Voxel Blitz map study'
SX, SY, SZ, GROUND = 128, 40, 96, 14
T = GROUND

# Block ids mirror shared/world/blocks.js. The six SUB_* ids are new for this map.
AIR, STONE, METAL, GLASS = 0, 3, 8, 11
SUB_CONCRETE, SUB_STEEL, SUB_GRAVEL, SUB_ENAMEL, SUB_HAZARD, SUB_CLADDING = 30, 31, 32, 33, 34, 35

# name: (texture, block id, metres per texture tile, roughness, metallic, value)
MATERIAL_SPECS = {
    'weathered concrete': ('weathered-concrete.png', SUB_CONCRETE, 3.0, 0.85, 0.0, 1.0),
    'galvanized steel': ('galvanized-steel.png', SUB_STEEL, 2.0, 0.45, 0.85, 1.0),
    'substation gravel': ('substation-gravel.png', SUB_GRAVEL, 2.0, 0.95, 0.0, 1.0),
    'transformer enamel': ('transformer-enamel.png', SUB_ENAMEL, 3.0, 0.35, 0.25, 1.0),
    'hazard stripes': ('hazard-stripes.png', SUB_HAZARD, 2.0, 0.6, 0.1, 1.0),
    'corrugated cladding': ('corrugated-cladding.png', SUB_CLADDING, 2.4, 0.5, 0.6, 1.0),
    'containment steel': ('galvanized-steel.png', METAL, 4.0, 0.7, 0.9, 0.42),
    'window glass': (None, GLASS, 1.0, 0.05, 0.0, 1.0),
}
TILE_KEYS = {
    'concrete': 'weathered-concrete.png',
    'steel': 'galvanized-steel.png',
    'gravel': 'substation-gravel.png',
    'enamel': 'transformer-enamel.png',
    'hazard': 'hazard-stripes.png',
    'cladding': 'corrugated-cladding.png',
}

t_start = time.time()
log = []


def say(message):
    log.append(message)
    print(message)


# --------------------------------------------------------------- scene setup
def drop_previous_study():
    scene = bpy.data.scenes.get(SCENE_NAME)
    if scene is None:
        return
    for collection in list(scene.collection.children_recursive):
        for obj in list(collection.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(collection)
    for obj in list(scene.collection.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    if len(bpy.data.scenes) > 1:
        bpy.data.scenes.remove(scene)
    for collection in (bpy.data.materials, bpy.data.images, bpy.data.meshes,
                       bpy.data.worlds, bpy.data.lights, bpy.data.cameras):
        for block in list(collection):
            if block.name.startswith(f'{ASSET} |') and block.users == 0:
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

STUDY = bpy.data.collections.new(f'{ASSET} study')
scene.collection.children.link(STUDY)
ANCHORS = bpy.data.collections.new(f'{ASSET} anchors')
STUDY.children.link(ANCHORS)
scene.unit_settings.system = 'METRIC'
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.cycles.seed = 20260914
scene.render.resolution_x, scene.render.resolution_y = 1280, 720
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'
world = bpy.data.worlds.new(f'{ASSET} | overcast sky')
world.use_nodes = True
background = world.node_tree.nodes['Background']
background.inputs[0].default_value = (0.55, 0.68, 0.84, 1)
background.inputs[1].default_value = 0.9
scene.world = world

sun_data = bpy.data.lights.new(f'{ASSET} | sun', 'SUN')
sun_data.energy = 3.2
sun_data.angle = math.radians(2.5)
sun_data.color = (1.0, 0.96, 0.9)
sun = bpy.data.objects.new(f'{ASSET} | sun', sun_data)
sun.rotation_euler = (math.radians(48), math.radians(-12), math.radians(135))
STUDY.objects.link(sun)

# --------------------------------------------------------------- materials
MATERIALS = {}
IMAGES = {}


def load_image(filename):
    if filename in IMAGES:
        return IMAGES[filename]
    path = TEX / filename
    if not path.exists():
        raise FileNotFoundError(f'missing ImageGen texture: {path}')
    image = bpy.data.images.load(str(path))
    image.name = f'{ASSET} | {filename}'
    IMAGES[filename] = image
    return image


def make_material(name, spec):
    texture, block, tile_m, roughness, metallic, value = spec
    mat = bpy.data.materials.new(f'{ASSET} | {name}')
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes['Principled BSDF']
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    if texture is None:
        bsdf.inputs['Base Color'].default_value = (0.62, 0.78, 0.86, 1)
        for socket in ('Transmission Weight', 'Transmission'):
            if socket in bsdf.inputs:
                bsdf.inputs[socket].default_value = 0.85
                break
        bsdf.inputs['Alpha'].default_value = 0.55
        try:
            mat.surface_render_method = 'BLENDED'
        except (AttributeError, TypeError):
            pass
    else:
        image = load_image(texture)
        coord = nodes.new('ShaderNodeTexCoord')
        mapping = nodes.new('ShaderNodeMapping')
        mapping.inputs['Scale'].default_value = (1 / tile_m, 1 / tile_m, 1 / tile_m)
        tex = nodes.new('ShaderNodeTexImage')
        tex.image = image
        tex.projection = 'BOX'
        tex.projection_blend = 0.12
        tex.interpolation = 'Linear'
        adjust = nodes.new('ShaderNodeHueSaturation')
        adjust.inputs['Value'].default_value = value
        links.new(coord.outputs['Object'], mapping.inputs['Vector'])
        links.new(mapping.outputs['Vector'], tex.inputs['Vector'])
        links.new(tex.outputs['Color'], adjust.inputs['Color'])
        links.new(adjust.outputs['Color'], bsdf.inputs['Base Color'])
    mat['block'] = block
    MATERIALS[name] = mat
    return mat


for _name, _spec in MATERIAL_SPECS.items():
    make_material(_name, _spec)

# --------------------------------------------------------------- geometry
VOXEL_OBJECTS = []   # (object, block id, mode)
part_count = 0


def new_object(name, bm, material, mode, block=None):
    global part_count
    part_count += 1
    mesh = bpy.data.meshes.new(f'{ASSET} | {name}')
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(material)
    obj = bpy.data.objects.new(f'{name}', mesh)
    obj['vox'] = mode
    STUDY.objects.link(obj)
    VOXEL_OBJECTS.append((obj, material['block'] if block is None else block, mode))
    return obj


PAINT_LIFT = 0.004   # metres per level; stacked floor finishes (avenues 1 < road 2 < pads 3 < markings 4) never z-fight in renders


def box(name, x0, y0, z0, x1, y1, z1, material, paint=0):
    """Axis-aligned block spanning inclusive voxel extents (game x/y/z).

    `paint` > 0 marks a floor finish laid over another finish: its top face is
    lifted by paint * PAINT_LIFT for rendering only. Voxelisation samples cell
    centres, so the lift never changes which cells the box occupies.
    """
    if x1 < x0 or y1 < y0 or z1 < z0:
        raise ValueError(f'{name}: inverted extents {(x0, y0, z0, x1, y1, z1)}')
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    sx, sy, sz = x1 + 1 - x0, z1 + 1 - z0, y1 + 1 - y0 + paint * PAINT_LIFT
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    bmesh.ops.translate(bm, vec=(x0 + sx / 2, z0 + sy / 2, y0 + sz / 2), verts=bm.verts)
    return new_object(name, bm, MATERIALS[material], 'box')


def cylinder(name, cx, cz, y0, y1, radius, material, segments=24):
    """Vertical cylinder; cx/cz are game-space centre coordinates, y inclusive."""
    bm = bmesh.new()
    height = y1 + 1 - y0
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments,
                          radius1=radius, radius2=radius, depth=height)
    bmesh.ops.translate(bm, vec=(cx, cz, y0 + height / 2), verts=bm.verts)
    return new_object(name, bm, MATERIALS[material], 'mesh')


def drum(name, x0, x1, cy, cz, radius, material, segments=24):
    """Horizontal cylinder along game x between inclusive voxel columns."""
    bm = bmesh.new()
    length = x1 + 1 - x0
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments,
                          radius1=radius, radius2=radius, depth=length)
    bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(math.radians(90), 3, 'Y'),
                     verts=bm.verts)
    bmesh.ops.translate(bm, vec=(x0 + length / 2, cz, cy), verts=bm.verts)
    return new_object(name, bm, MATERIALS[material], 'mesh')


def segments_without(a0, a1, holes):
    """Inclusive 1-D range minus hole ranges -> list of inclusive segments."""
    segments = []
    cursor = a0
    for h0, h1 in sorted(holes):
        if h0 > cursor:
            segments.append((cursor, min(h0 - 1, a1)))
        cursor = max(cursor, h1 + 1)
    if cursor <= a1:
        segments.append((cursor, a1))
    return [(s0, s1) for (s0, s1) in segments if s0 <= s1]


def wall_x(name, z, x0, x1, y0, y1, material, holes=()):
    """Wall along x at depth z. holes: (hx0, hx1, hy0, hy1) inclusive."""
    rows = {}
    for y in range(y0, y1 + 1):
        row_holes = [(hx0, hx1) for (hx0, hx1, hy0, hy1) in holes if hy0 <= y <= hy1]
        rows[y] = tuple(segments_without(x0, x1, row_holes))
    for y, segs in _merge_rows(rows):
        for i, (s0, s1) in enumerate(segs):
            box(f'{name} y{y[0]}-{y[1]} s{i}', s0, y[0], z, s1, y[1], z, material)


def wall_z(name, x, z0, z1, y0, y1, material, holes=()):
    """Wall along z at column x. holes: (hz0, hz1, hy0, hy1) inclusive."""
    rows = {}
    for y in range(y0, y1 + 1):
        row_holes = [(hz0, hz1) for (hz0, hz1, hy0, hy1) in holes if hy0 <= y <= hy1]
        rows[y] = tuple(segments_without(z0, z1, row_holes))
    for y, segs in _merge_rows(rows):
        for i, (s0, s1) in enumerate(segs):
            box(f'{name} y{y[0]}-{y[1]} s{i}', x, y[0], s0, x, y[1], s1, material)


def _merge_rows(rows):
    """Group consecutive rows that share the same segment list."""
    out = []
    ys = sorted(rows)
    start = ys[0]
    for prev, y in zip(ys, ys[1:] + [None]):
        if y is None or rows[y] != rows[start]:
            out.append(((start, prev), rows[start]))
            start = y
    return out


def anchor(name, kind, x, z, **props):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = 'PLAIN_AXES'
    obj.empty_display_size = 1.0
    obj.location = (x + 0.5, z + 0.5, T + 1.02)
    obj['kind'] = kind
    obj['vx'] = x
    obj['vz'] = z
    for key, value in props.items():
        obj[key] = value
    ANCHORS.objects.link(obj)
    return obj


# --- ground and containment shell (matches shared/world/flatmaps.js generateFlatBase)
box('Ground gravel bed', 3, T, 3, 124, T, 92, 'substation gravel')
for i, (x0, z0, x1, z1) in enumerate([(0, 0, 127, 2), (0, 93, 127, 95), (0, 3, 2, 92), (125, 3, 127, 92)]):
    box(f'Containment wall {i}', x0, T, z0, x1, SY - 8, z1, 'containment steel')
for i, (x0, z0, x1, z1) in enumerate([(0, 0, 127, 0), (0, 95, 127, 95), (0, 1, 0, 94), (127, 1, 127, 94)]):
    box(f'Containment rim {i}', x0, SY - 7, z0, x1, SY - 1, z1, 'containment steel')

# --- concrete aprons
box('Main road', 3, T, 44, 124, T, 51, 'weathered concrete', paint=2)
box('West avenue', 40, T, 3, 45, T, 92, 'weathered concrete', paint=1)
box('East avenue', 82, T, 3, 87, T, 92, 'weathered concrete', paint=1)
for i, x in enumerate(list(range(6, 50, 6)) + list(range(78, 122, 6))):
    box(f'Centre line dash {i}', x, T, 47, x + 1, T, 47, 'hazard stripes', paint=4)

# --- control house (x 52..75, z 36..59), roof perch reached by an east stair
CX0, CZ0, CX1, CZ1 = 52, 36, 75, 59
box('Control house floor', CX0 + 1, T, CZ0 + 1, CX1 - 1, T, CZ1 - 1, 'weathered concrete', paint=3)
for label, z in (('north', CZ0), ('south', CZ1)):
    door = (62, 65, T + 1, T + 3)
    windows = [(54, 57, T + 5, T + 5), (70, 73, T + 5, T + 5)]
    wall_x(f'Control house {label} base', z, CX0, CX1, T + 1, T + 2, 'weathered concrete', [door])
    wall_x(f'Control house {label} cladding', z, CX0, CX1, T + 3, T + 7, 'corrugated cladding', [door] + windows)
    box(f'Control house {label} parapet', CX0, T + 8, z, CX1, T + 8, z, 'weathered concrete')
    for i, (wx0, wx1, wy0, wy1) in enumerate(windows):
        box(f'Control house {label} window {i}', wx0, wy0, z, wx1, wy1, z, 'window glass')
for label, x in (('west', CX0), ('east', CX1)):
    door = (46, 49, T + 1, T + 3)
    windows = [(38, 41, T + 5, T + 5), (54, 57, T + 5, T + 5)]
    wall_z(f'Control house {label} base', x, CZ0, CZ1, T + 1, T + 2, 'weathered concrete', [door])
    wall_z(f'Control house {label} cladding', x, CZ0, CZ1, T + 3, T + 7, 'corrugated cladding', [door] + windows)
    box(f'Control house {label} parapet', x, T + 8, CZ0, x, T + 8, CZ1, 'weathered concrete')
    for i, (wz0, wz1, wy0, wy1) in enumerate(windows):
        box(f'Control house {label} window {i}', x, wy0, wz0, x, wy1, wz1, 'window glass')
box('Control house roof deck', CX0, T + 9, CZ0, CX1, T + 9, CZ1, 'galvanized steel')
box('Roof parapet north', CX0, T + 10, CZ0, CX1, T + 10, CZ0, 'weathered concrete')
box('Roof parapet south', CX0, T + 10, CZ1, CX1, T + 10, CZ1, 'weathered concrete')
box('Roof parapet west', CX0, T + 10, CZ0 + 1, CX0, T + 10, CZ1 - 1, 'weathered concrete')
box('Roof parapet east', CX1, T + 10, CZ0 + 3, CX1, T + 10, CZ1 - 1, 'weathered concrete')
box('Roof HVAC unit', 60, T + 10, 45, 65, T + 11, 50, 'galvanized steel')
box('Roof antenna mast', 73, T + 10, 38, 73, T + 17, 38, 'galvanized steel')
for i, (x0, z0) in enumerate([(56, 40), (56, 52), (70, 40), (70, 52)]):
    box(f'Switchgear cabinet interior {i}', x0, T + 1, z0, x0 + 1, T + 3, z0 + 3, 'galvanized steel')
box('Relay table', 62, T + 1, 46, 65, T + 2, 49, 'weathered concrete')
for k in range(9):
    box(f'Roof stair step {k}', 76, T + 1, 45 - k, 77, T + 1 + k, 45 - k, 'weathered concrete')
box('Stair post bottom', 78, T + 1, 45, 78, T + 2, 45, 'hazard stripes')
box('Stair post top', 78, T + 1, 37, 78, T + 10, 37, 'galvanized steel')

# --- four transformer bays with firewalls
BAYS = [(16, 12, 33, 'NW'), (96, 12, 94, 'NE'), (16, 68, 33, 'SW'), (96, 68, 94, 'SE')]
for bx, bz, fx, tag in BAYS:
    box(f'Bay {tag} plinth', bx, T, bz, bx + 15, T, bz + 15, 'weathered concrete', paint=2)
    box(f'Bay {tag} tank', bx + 3, T + 1, bz + 4, bx + 12, T + 6, bz + 11, 'transformer enamel')
    for i, x in enumerate(range(bx + 4, bx + 12, 2)):
        box(f'Bay {tag} radiator front {i}', x, T + 1, bz + 2, x, T + 5, bz + 3, 'galvanized steel')
        box(f'Bay {tag} radiator rear {i}', x, T + 1, bz + 12, x, T + 5, bz + 13, 'galvanized steel')
    for i, cx in enumerate((bx + 5.5, bx + 7.5, bx + 9.5)):
        cylinder(f'Bay {tag} bushing {i}', cx, bz + 7.5, T + 7, T + 9, 0.45, 'weathered concrete', 16)
    drum(f'Bay {tag} conservator', bx + 4, bx + 11, T + 8, bz + 5, 1.0, 'transformer enamel')
    gap = (bz + 6, bz + 8, T + 1, T + 5)
    wall_z(f'Bay {tag} firewall', fx, bz, bz + 15, T + 1, T + 5, 'weathered concrete', [gap])
    box(f'Bay {tag} firewall cap', fx, T + 6, bz, fx, T + 6, bz + 15, 'hazard stripes')

# --- switchyard gantries over the north and south lanes
for label, z in (('north', 8), ('south', 86)):
    for x in (40, 64, 88):
        box(f'Gantry {label} column x{x}', x, T + 2, z, x + 1, T + 11, z + 1, 'galvanized steel')
        box(f'Gantry {label} collar x{x}', x, T + 1, z, x + 1, T + 1, z + 1, 'hazard stripes')
    box(f'Gantry {label} beam', 40, T + 12, z, 89, T + 12, z + 1, 'galvanized steel')
    for x in (46, 58, 70, 82):
        cylinder(f'Gantry {label} insulator x{x}', x + 0.5, z + 0.5, T + 9, T + 11, 0.3, 'weathered concrete', 12)
for x in (48, 80):
    for z in (40, 55):
        box(f'Portal column x{x} z{z}', x, T + 2, z, x + 1, T + 9, z + 1, 'galvanized steel')
        box(f'Portal collar x{x} z{z}', x, T + 1, z, x + 1, T + 1, z + 1, 'hazard stripes')
    box(f'Portal beam x{x}', x, T + 10, 40, x + 1, T + 10, 56, 'galvanized steel')

# --- switchgear cabinet rows (mid cover in the outer lanes)
for label, z in (('north', 30), ('south', 64)):
    for x0 in (12, 24, 36, 90, 102, 114):
        box(f'Cabinet {label} x{x0}', x0, T + 1, z, x0 + 2, T + 3, z + 1, 'galvanized steel')

# --- west workshop (x 6..26, z 38..57) with an open bay door facing the road
WX0, WZ0, WX1, WZ1 = 6, 38, 26, 57
box('Workshop floor', WX0 + 1, T, WZ0 + 1, WX1 - 1, T, WZ1 - 1, 'weathered concrete', paint=3)
box('Workshop threshold', 24, T, 44, 25, T, 51, 'hazard stripes', paint=4)
for label, z, holes in (('north', WZ0, [(14, 15, T + 1, T + 3)]), ('south', WZ1, [])):
    windows = [(8, 11, T + 4, T + 4), (18, 21, T + 4, T + 4)]
    wall_x(f'Workshop {label} base', z, WX0, WX1, T + 1, T + 1, 'weathered concrete', holes)
    wall_x(f'Workshop {label} cladding', z, WX0, WX1, T + 2, T + 6, 'corrugated cladding', holes + windows)
    for i, (wx0, wx1, wy0, wy1) in enumerate(windows):
        box(f'Workshop {label} window {i}', wx0, wy0, z, wx1, wy1, z, 'window glass')
windows = [(42, 45, T + 4, T + 4), (50, 53, T + 4, T + 4)]
wall_z('Workshop west base', WX0, WZ0, WZ1, T + 1, T + 1, 'weathered concrete')
wall_z('Workshop west cladding', WX0, WZ0, WZ1, T + 2, T + 6, 'corrugated cladding', windows)
for i, (wz0, wz1, wy0, wy1) in enumerate(windows):
    box(f'Workshop west window {i}', WX0, wy0, wz0, WX0, wy1, wz1, 'window glass')
bay_door = (44, 51, T + 1, T + 4)
wall_z('Workshop east base', WX1, WZ0, WZ1, T + 1, T + 1, 'weathered concrete', [bay_door])
wall_z('Workshop east cladding', WX1, WZ0, WZ1, T + 2, T + 6, 'corrugated cladding', [bay_door])
box('Workshop roof', WX0, T + 7, WZ0, WX1, T + 7, WZ1, 'galvanized steel')
for i, (cx, cz) in enumerate(((10.5, 41.5), (10.5, 53.5))):
    cylinder(f'Workshop vent stack {i}', cx, cz, T + 8, T + 10, 0.5, 'galvanized steel', 12)
box('Workbench', 7, T + 1, 40, 8, T + 1, 55, 'weathered concrete')
box('Parts crate A', 18, T + 1, 40, 20, T + 2, 42, 'galvanized steel')
box('Parts crate B', 20, T + 1, 53, 22, T + 3, 55, 'galvanized steel')
box('Parts crate C', 12, T + 1, 47, 13, T + 1, 48, 'transformer enamel')

# --- east shunt-reactor pad and the cable duct
box('Reactor pad', 96, T, 36, 118, T, 60, 'weathered concrete', paint=3)
for i, cz in enumerate((41.5, 48.5, 55.5)):
    cylinder(f'Shunt reactor {i}', 108.5, cz, T + 1, T + 5, 2.5, 'transformer enamel', 32)
for i, (x, z) in enumerate(((96, 36), (118, 36), (96, 60), (118, 60))):
    box(f'Reactor fence post {i}', x, T + 1, z, x, T + 2, z, 'galvanized steel')
    box(f'Reactor fence cap {i}', x, T + 3, z, x, T + 3, z, 'hazard stripes')
box('Cable duct', 100, T + 1, 30, 101, T + 1, 65, 'weathered concrete')

# --- bollards at the road crossings
for i, (x, z) in enumerate(((39, 43), (46, 43), (39, 52), (46, 52), (81, 43), (88, 43), (81, 52), (88, 52))):
    box(f'Bollard {i}', x, T + 1, z, x, T + 2, z, 'hazard stripes')

# --- anchors: spawns, dummy posts, landmarks, power-up pads
FUN_SPAWNS = [(8, 8), (64, 6), (120, 8), (10, 32), (118, 32), (10, 63), (118, 63),
              (8, 88), (64, 90), (120, 88), (48, 48), (80, 48)]
ALPHA_SPAWNS = [(8, 10), (8, 30), (12, 62), (8, 86), (30, 10), (30, 86)]
BRAVO_SPAWNS = [(119, 10), (119, 30), (115, 62), (119, 86), (97, 10), (97, 86)]
DUMMY_POSTS = [(20, 31), (32, 31), (44, 31), (56, 31), (68, 31), (80, 31), (98, 31), (110, 31), (50, 64), (78, 64)]
LANDMARKS = [('control-house', 'Control House', 64, 33), ('west-workshop', 'West Workshop', 30, 48),
             ('east-reactors', 'Reactor Pad', 92, 48)]
POWERUPS = [(64, 31), (64, 64), (34, 48), (94, 48)]
for i, (x, z) in enumerate(FUN_SPAWNS):
    anchor(f'spawn.fun.{i:02d}', 'spawn', x, z, pool='fun')
for i, (x, z) in enumerate(ALPHA_SPAWNS):
    anchor(f'spawn.alpha.{i:02d}', 'spawn', x, z, pool='alpha')
for i, (x, z) in enumerate(BRAVO_SPAWNS):
    anchor(f'spawn.bravo.{i:02d}', 'spawn', x, z, pool='bravo')
for i, (x, z) in enumerate(DUMMY_POSTS):
    anchor(f'dummy.{i:02d}', 'dummy', x, z, post='range')
    box(f'Dummy post marker {i}', x, T, z, x, T, z, 'hazard stripes', paint=4)
for lid, label, x, z in LANDMARKS:
    anchor(f'landmark.{lid}', 'landmark', x, z, landmark=lid, label=label)
for i, (x, z) in enumerate(POWERUPS):
    anchor(f'powerup.{i:02d}', 'powerup', x, z, floor=T)

bpy.context.view_layer.update()
say(f'authored {part_count} parts, {len(ANCHORS.objects)} anchors in {time.time() - t_start:.1f}s')

# --------------------------------------------------------------- voxelise
grid = np.zeros((SY, SZ, SX), dtype=np.uint8)
depsgraph = bpy.context.evaluated_depsgraph_get()
RAY = Vector((1.0, 0.00137, 0.00071)).normalized()


def world_bounds(obj):
    corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return lo, hi


def inside(bvh, point, reach):
    hits = 0
    origin = point.copy()
    travelled = 0.0
    while travelled < reach:
        location, _normal, _index, distance = bvh.ray_cast(origin, RAY, reach - travelled)
        if location is None:
            break
        hits += 1
        travelled += distance + 1e-4
        origin = location + RAY * 1e-4
    return hits % 2 == 1


t_vox = time.time()
box_cells = mesh_cells = 0
for obj, block, mode in VOXEL_OBJECTS:
    lo, hi = world_bounds(obj)
    # A cell belongs to a box when its centre lies inside the box.
    x0, x1 = max(0, int(math.ceil(lo.x - 0.5))), min(SX - 1, int(math.floor(hi.x - 0.5)))
    z0, z1 = max(0, int(math.ceil(lo.y - 0.5))), min(SZ - 1, int(math.floor(hi.y - 0.5)))
    y0, y1 = max(0, int(math.ceil(lo.z - 0.5))), min(SY - 1, int(math.floor(hi.z - 0.5)))
    if x1 < x0 or y1 < y0 or z1 < z0:
        raise RuntimeError(f'{obj.name} lies outside the voxel grid')
    if mode == 'box':
        grid[y0:y1 + 1, z0:z1 + 1, x0:x1 + 1] = block
        box_cells += (x1 + 1 - x0) * (y1 + 1 - y0) * (z1 + 1 - z0)
        continue
    bvh = BVHTree.FromObject(obj, depsgraph)
    reach = hi.x - lo.x + 2.0
    for y in range(y0, y1 + 1):
        for z in range(z0, z1 + 1):
            for x in range(x0, x1 + 1):
                if inside(bvh, Vector((x + 0.5, z + 0.5, y + 0.5)), reach):
                    grid[y, z, x] = block
                    mesh_cells += 1
say(f'voxelised {len(VOXEL_OBJECTS)} objects: {box_cells} box cells, {mesh_cells} mesh cells in {time.time() - t_vox:.1f}s')

# The engine base (generateFlatBase) supplies the sub-floor stone and shell; the
# authored bytes must agree with it on every shell cell so the overlay is exact.
for z in range(SZ):
    for x in range(SX):
        edge = min(x, z, SX - 1 - x, SZ - 1 - z)
        if edge < 3:
            top = SY - 1 if edge == 0 else SY - 8
            if not (grid[GROUND:top + 1, z, x] == METAL).all():
                raise RuntimeError(f'shell mismatch at {x},{z}')
assert (grid[T, 3:SZ - 3, 3:SX - 3] != AIR).all(), 'floor paint must cover the whole yard'

# Anchor validation against the authored voxels: feet cell and head cell clear.
def walkable(x, z, floor=T):
    return grid[floor, z, x] != AIR and grid[floor + 1, z, x] == AIR and grid[floor + 2, z, x] == AIR


for obj in ANCHORS.objects:
    x, z = int(obj['vx']), int(obj['vz'])
    if not (3 <= x < SX - 3 and 3 <= z < SZ - 3) or not walkable(x, z):
        raise RuntimeError(f'anchor {obj.name} at {x},{z} is not a walkable floor cell')

flat = grid.reshape(-1)
runs = []
run_value = int(flat[0])
run_length = 0
for value in flat:
    value = int(value)
    if value == run_value and run_length < 65535:
        run_length += 1
        continue
    runs.append((run_length, run_value))
    run_value, run_length = value, 1
runs.append((run_length, run_value))
rle = bytearray()
for length, value in runs:
    rle += bytes((length & 255, length >> 8, value))
assert sum(length for length, _ in runs) == SX * SY * SZ
rle_b64 = base64.b64encode(bytes(rle)).decode('ascii')
histogram = {int(k): int(v) for k, v in zip(*np.unique(grid, return_counts=True))}
say(f'rle: {len(runs)} runs, {len(rle_b64)} base64 chars, histogram {histogram}')

# --------------------------------------------------------------- atlas tiles
TILE_PX = 16
tiles = {}
texture_stats = {}
for key, filename in TILE_KEYS.items():
    image = load_image(filename)
    w, h = image.size
    raw = np.empty(w * h * image.channels, dtype=np.float32)
    image.pixels.foreach_get(raw)
    pixels = raw.reshape(h, w, image.channels)[:, :, :3]
    pixels = pixels[::-1]                    # Blender stores rows bottom-up; tiles are top-down
    side = min(w, h) // TILE_PX * TILE_PX
    pixels = pixels[:side, :side]
    block_size = side // TILE_PX
    averaged = pixels.reshape(TILE_PX, block_size, TILE_PX, block_size, 3).mean(axis=(1, 3))
    mean = averaged.mean(axis=(0, 1), keepdims=True)
    boosted = np.clip(mean + (averaged - mean) * 1.35, 0.0, 1.0)
    data = np.rint(boosted * 255).astype(np.uint8).reshape(-1)
    tiles[key] = base64.b64encode(data.tobytes()).decode('ascii')
    texture_stats[key] = {
        'file': f'docs/design/blender/substation/textures/{filename}',
        'size': [int(w), int(h)],
        'mean_rgb_0_255': [round(float(v) * 255, 2) for v in pixels.mean(axis=(0, 1))],
        'sha256': hashlib.sha256((TEX / filename).read_bytes()).hexdigest(),
    }
say(f'baked {len(tiles)} atlas tiles at {TILE_PX}px')

# --------------------------------------------------------------- anchors JSON
anchors = {
    'spawns': {'fun': [list(p) for p in FUN_SPAWNS], 'alpha': [list(p) for p in ALPHA_SPAWNS],
               'bravo': [list(p) for p in BRAVO_SPAWNS]},
    'dummyPosts': [{'kind': 'range', 'x': x, 'z': z} for (x, z) in DUMMY_POSTS],
    'landmarks': [{'id': lid, 'name': label, 'x': x, 'z': z} for (lid, label, x, z) in LANDMARKS],
    'powerups': [[x, T, z] for (x, z) in POWERUPS],
}

# --------------------------------------------------------------- write data
header = (
    '// Generated by tools/blender/substation/build-substation.py from the SUBSTATION\n'
    '// Blender study (docs/design/blender/substation/substation.blend). Do not edit by hand.\n'
    '// Voxels are run-length encoded in the y/z/x byte order of shared/world/blocks.js idx():\n'
    '// three bytes per run (count low, count high, block id), base64.\n'
    f'// Tiles are {TILE_PX}x{TILE_PX} RGB box filters of the six Codex ImageGen textures.\n'
)
data_js = header
data_js += f'export const SUBSTATION_DIMENSIONS = Object.freeze({{ sx: {SX}, sy: {SY}, sz: {SZ}, ground: {GROUND} }});\n'
data_js += f'export const SUBSTATION_RLE = {json.dumps(rle_b64)};\n'
data_js += f'export const SUBSTATION_ANCHORS = Object.freeze({json.dumps(anchors)});\n'
data_js += f'export const SUBSTATION_TILES = Object.freeze({json.dumps(tiles)});\n'
DATA_JS.write_text(data_js)
say(f'wrote {DATA_JS.relative_to(ROOT)} ({len(data_js)} bytes)')

# --------------------------------------------------------------- save + export
bpy.ops.file.pack_all()
BLEND = DOCS / 'substation.blend'
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND), copy=True, check_existing=False)
say(f'saved {BLEND.relative_to(ROOT)}')

for layer in bpy.context.view_layer.layer_collection.children:
    if layer.collection == STUDY:
        bpy.context.view_layer.active_layer_collection = layer
GLB = DOCS / 'substation.glb'
wanted = {'filepath': str(GLB), 'export_format': 'GLB', 'use_active_collection': True,
          'use_active_collection_with_nested': True, 'use_active_scene': True,
          'use_selection': False, 'use_visible': False, 'use_renderable': False,
          'export_apply': True, 'export_yup': True, 'export_extras': True,
          'export_cameras': False, 'export_lights': False, 'export_animations': False,
          'export_skins': False, 'export_morph': False, 'export_image_format': 'JPEG',
          'export_jpeg_quality': 82, 'export_materials': 'EXPORT', 'export_normals': True,
          'export_texcoords': True, 'export_tangents': False}
supported = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
bpy.ops.export_scene.gltf(**{k: v for (k, v) in wanted.items() if k in supported})
say(f'exported {GLB.relative_to(ROOT)} ({GLB.stat().st_size} bytes)')

triangles = 0
for obj, _block, _mode in VOXEL_OBJECTS:
    mesh = obj.evaluated_get(depsgraph).to_mesh()
    mesh.calc_loop_triangles()
    triangles += len(mesh.loop_triangles)
    obj.evaluated_get(depsgraph).to_mesh_clear()

manifest = {
    'asset': ASSET,
    'asset_id': 'substation',
    'kind': 'original voxel arena map (electrical switchyard)',
    'blender': bpy.app.version_string,
    'authoring_script': 'tools/blender/substation/build-substation.py',
    'integration': 'voxelised into shared/world/substation-data.js; GLB is design reference only',
    'dimensions': {'sx': SX, 'sy': SY, 'sz': SZ, 'ground': GROUND},
    'parts': part_count,
    'triangles': triangles,
    'voxels': {'box_cells': box_cells, 'mesh_cells': mesh_cells, 'runs': len(runs),
               'histogram': {str(k): v for k, v in histogram.items()}},
    'materials': {name: {'texture': spec[0], 'block': spec[1], 'tile_metres': spec[2]}
                  for name, spec in MATERIAL_SPECS.items()},
    'textures': texture_stats,
    'anchors': anchors,
    'data_module': {'path': 'shared/world/substation-data.js',
                    'sha256': hashlib.sha256(DATA_JS.read_bytes()).hexdigest()},
    'files': {'blend': 'docs/design/blender/substation/substation.blend',
              'glb': 'docs/design/blender/substation/substation.glb',
              'glb_bytes': GLB.stat().st_size},
    'built_seconds': round(time.time() - t_start, 1),
}
(DOCS / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
say(f'{ASSET}-BUILD-DONE ' + json.dumps({'parts': part_count, 'triangles': triangles,
                                          'runs': len(runs), 'seconds': manifest['built_seconds']}))
