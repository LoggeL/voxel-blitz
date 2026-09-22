"""Blockout three GV-4 RIPTIDE design alternatives and render one hero shot each.

Self-contained: run headless with

    blender --background --factory-startup --python \
        docs/design/blender/skua/concepts/concept-blockouts.py

Generates the three design alternatives recorded in concept-prompts.md as real
geometry blockouts (rough forms, flat palette colours) and writes
concept-1-fork.png / concept-2-drum.png / concept-3-bracer.png plus
concept-0-overview.png next to this file. These are design studies only: no
contract checks, no delivery export.

Authoring space: +Y forward (muzzle), +Z up, +X right (game_z = -y). The
shared anchors are the frozen glaive ones: muzzle (spindle tip) at y 0.40 on
the bore axis z 0, sight line z 0.150, grip at y -0.04 z -0.075.
"""
import bpy
import math
from pathlib import Path
from mathutils import Vector

HERE = Path(__file__).resolve().parent
SIGHT_Z = 0.150

# flat blockout palette (matches the delivered material family)
GREY = (0.24, 0.25, 0.28, 1)
ORANGE = (0.78, 0.32, 0.07, 1)
IVORY = (0.80, 0.78, 0.72, 1)
DARK = (0.08, 0.08, 0.09, 1)
STEEL = (0.62, 0.64, 0.66, 1)
BRASS = (0.62, 0.46, 0.18, 1)
GLOW = (1.0, 0.05, 0.63, 1)

scene = bpy.context.scene
for obj in list(scene.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x, scene.render.resolution_y = 1400, 880
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'
scene.world = bpy.data.worlds.new('concept world')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.13, .15, .19, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = 0.4


def material(name, colour, metal=0.2, rough=0.6, glow=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = colour
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    if glow:
        bsdf.inputs['Emission Color'].default_value = colour
        bsdf.inputs['Emission Strength'].default_value = glow
    return mat


MATS = {name: material(name, col, *args) for (name, col, *args) in (
    ('grey', GREY, .5, .45), ('orange', ORANGE, .1, .5), ('ivory', IVORY, .05, .5),
    ('dark', DARK, .2, .8), ('steel', STEEL, .8, .3), ('brass', BRASS, .7, .4),
    ('glow', GLOW, 0, .4, 6.0))}

PARTS = []


def add(name, mat, verts, faces, loc=(0, 0, 0), rot=(0, 0, 0)):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = loc
    obj.rotation_euler = rot
    mesh.materials.append(MATS[mat])
    scene.collection.objects.link(obj)
    PARTS.append(obj)
    return obj


def box(name, mat, sx, sy, sz, x=0.0, y=0.0, z=0.0, rot=(0, 0, 0)):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    verts = [(dx, dy, dz) for dz in (-hz, hz) for dy in (-hy, hy) for dx in (-hx, hx)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return add(name, mat, verts, faces, loc=(x, y, z), rot=rot)


def cyl(name, mat, radius, length, x=0.0, y=0.0, z=0.0, axis='Y', seg=24, inner=None,
        rot=None):
    """Closed (optionally hollow) cylinder along an axis."""
    verts, faces = [], []

    def ring(r, t):
        base = len(verts)
        for i in range(seg):
            a = 2 * math.pi * i / seg
            (u, v) = (r * math.cos(a), r * math.sin(a))
            verts.append({'X': (t, u, v), 'Y': (u, t, v), 'Z': (u, v, t)}[axis])
        return [base + i for i in range(seg)]

    o0, o1 = ring(radius, -length / 2), ring(radius, length / 2)
    if inner is None:
        faces += [tuple(reversed(o0)), tuple(o1)]
    else:
        i0, i1 = ring(inner, -length / 2), ring(inner, length / 2)
        for i in range(seg):
            j = (i + 1) % seg
            faces += [(o0[i], i0[i], i0[j], o0[j]), (o1[i], o1[j], i1[j], i1[i]),
                      (i0[i], i1[i], i1[j], i0[j])]
    for i in range(seg):
        j = (i + 1) % seg
        faces.append((o0[i], o0[j], o1[j], o1[i]))
    return add(name, mat, verts, faces, loc=(x, y, z), rot=rot or (0, 0, 0))


def toothed_disc(name, radius, x, y, z, tilt=0.0, glow=True):
    """Blade disc + teeth + glow rim, tilted front-edge-up about X."""
    rot = (tilt, 0, 0)
    cyl(f'{name} body', 'steel', radius, .024, x, y, z, axis='Z', seg=36, rot=rot)
    for k in range(24):
        a = 2 * math.pi * k / 24
        (dx, dy) = ((radius + .006) * math.cos(a), (radius + .006) * math.sin(a))
        box(f'{name} tooth {k}', 'steel', .012, .012, .020,
            x + dx, y + dy * math.cos(tilt), z + dy * math.sin(tilt),
            rot=(tilt, 0, a + math.pi / 4))
    if glow:
        cyl(f'{name} rim', 'glow', radius * .86, .026, x, y, z, axis='Z', seg=36,
            inner=radius * .78, rot=rot)


def common_grip():
    """Pistol grip, trigger and brace cuff shared by every alternative."""
    box('Pistol grip', 'dark', .034, .050, .10, 0, -0.045, -0.090, rot=(math.radians(-10), 0, 0))
    box('Trigger', 'orange', .010, .012, .036, 0, 0.005, -0.050)
    box('Trigger guard', 'grey', .026, .080, .010, 0, 0.000, -0.072)
    cyl('Brace cuff', 'dark', .055, .060, 0, -0.130, -0.100, axis='Y', inner=.045,
        rot=(0, 0, 0))
    box('Cuff strut', 'grey', .020, .080, .020, 0, -0.100, -0.045)


def variant_fork():
    """1: fork and spindle, the disc seated flat on a forward spindle."""
    common_grip()
    box('Receiver slab', 'ivory', .080, .220, .070, 0, 0.000, -0.005)
    cyl('Flywheel drum', 'grey', .055, .100, 0, -0.070, 0.0, axis='Y')
    box('Rear notch post', 'grey', .016, .012, .095, 0, -0.100, 0.100)
    cyl('Launch spindle', 'grey', .0155, .300, 0, 0.250, 0.0)
    box('Rail', 'grey', .060, .260, .010, 0, 0.230, -0.022)
    toothed_disc('Seated disc', .100, 0, 0.220, 0.042, tilt=math.radians(6))
    box('Fork bridge', 'orange', .120, .022, .018, 0, 0.330, 0.088)
    for side in (-1, 1):
        box(f'Fork post {side}', 'orange', .016, .018, .110, side * .052, 0.330, 0.035)
        box(f'Horn {side}', 'orange', .014, .140, .080, side * .075, 0.395, 0.020,
            rot=(0, 0, -side * math.radians(21)))
        box(f'Horn prong {side}', 'glow', .012, .016, .050, side * .100, 0.458, 0.020)
    box('Sight post', 'orange', .010, .012, .050, 0, 0.340, 0.115)
    cyl('Ring sight', 'orange', .016, .006, 0, 0.340, SIGHT_Z, axis='Y', inner=.011)
    box('Support stub', 'dark', .028, .030, .070, 0, 0.300, -0.060)
    for side in (-1, 1):
        box(f'Cassette cheek {side}', 'dark', .012, .200, .034, side * .104, 0.140, -0.070)
    box('Cassette spine', 'dark', .200, .030, .034, 0, 0.140, -0.070)
    toothed_disc('Spare disc', .098, 0, 0.140, -0.070, glow=False)


def variant_drum():
    """2: a vertical drum magazine riding above the rail, feeding discs forward."""
    common_grip()
    box('Receiver slab', 'ivory', .080, .300, .070, 0, 0.040, -0.005)
    cyl('Launch spindle', 'grey', .0155, .260, 0, 0.270, 0.0)
    cyl('Disc drum', 'grey', .120, .110, 0, 0.140, 0.100, axis='X', seg=32)
    cyl('Drum face', 'orange', .090, .116, 0, 0.140, 0.100, axis='X', seg=32)
    for k in range(3):
        cyl(f'Drum disc {k}', 'steel' if k != 1 else 'glow', .104, .018,
            (k - 1) * 0.034, 0.140, 0.100, axis='X', seg=24)
    box('Drum hanger', 'grey', .030, .080, .080, 0, 0.140, 0.030)
    box('Front post', 'orange', .012, .012, .060, 0, 0.360, 0.030)
    box('Support stub', 'dark', .028, .030, .070, 0, 0.300, -0.060)
    cyl('Muzzle collar', 'glow', .030, .020, 0, 0.395, 0.0, inner=.018)


def variant_bracer():
    """3: a wrist bracer with the disc strapped flat over the back of the hand."""
    cyl('Bracer shell', 'dark', .058, .220, 0, -0.030, -0.080, axis='Y', inner=.046, seg=28)
    for k in range(3):
        cyl(f'Bracer band {k}', 'ivory', .061, .018, 0, -0.110 + k * 0.08, -0.080, axis='Y',
            inner=.056)
    box('Palm bar', 'grey', .020, .040, .080, 0, 0.100, -0.080)
    box('Deck plate', 'grey', .100, .160, .012, 0, 0.040, -0.016)
    toothed_disc('Wrist disc', .100, 0, 0.060, 0.010, tilt=math.radians(6))
    box('Thumb trigger', 'orange', .014, .020, .020, .050, 0.110, -0.030)
    cyl('Brass gauge', 'brass', .018, .008, .062, -0.050, -0.060, axis='X')


VARIANTS = [('concept-1-fork.png', variant_fork),
            ('concept-2-drum.png', variant_drum),
            ('concept-3-bracer.png', variant_bracer)]


def area_light(name, location, energy, size=1.4, colour=(1, 1, 1)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.size = size
    data.color = colour
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    scene.collection.objects.link(obj)


area_light('key', (1.8, 1.4, 2.2), 520)
area_light('fill', (-2.2, -0.6, 1.0), 200, size=2.4, colour=(0.82, 0.88, 1.0))
area_light('rim', (-2.4, -1.0, 0.6), 160, size=1.4, colour=(1.0, 0.94, 0.86))

cam_data = bpy.data.cameras.new('concept camera')
cam = bpy.data.objects.new('concept camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam


def aim(position, target, lens):
    cam.location = Vector(position)
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam_data.lens = lens


def clear():
    for obj in list(PARTS):
        mesh = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.meshes.remove(mesh)
    PARTS.clear()


for (filename, build) in VARIANTS:
    clear()
    build()
    aim((0.80, 0.95, 0.50), (0.0, 0.12, 0.0), 58)
    scene.render.filepath = str(HERE / filename)
    bpy.ops.render.render(write_still=True)
    print(f'CONCEPT_SAVED {filename}')

# overview sheet: all three side by side (left FORK, centre DRUM, right BRACER)
clear()
for (offset, (_f, build)) in zip((-0.34, 0.0, 0.34), VARIANTS):
    before = len(PARTS)
    build()
    for obj in PARTS[before:]:
        obj.location = (obj.location[0] + offset, obj.location[1], obj.location[2])
aim((1.30, 1.55, 0.90), (0.0, 0.10, 0.0), 50)
scene.render.filepath = str(HERE / 'concept-0-overview.png')
bpy.ops.render.render(write_still=True)
print('CONCEPT_SAVED concept-0-overview.png')
print('CONCEPT-BLOCKOUTS-DONE')
