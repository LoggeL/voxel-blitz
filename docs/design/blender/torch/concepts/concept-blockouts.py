"""Blockout three RX-8 HAVOC design alternatives and render one hero shot each.

Self-contained: run headless with

    blender --background --factory-startup --python \
        docs/design/blender/torch/concepts/concept-blockouts.py

Generates the three design alternatives recorded in concept-prompts.md as real
geometry blockouts (rough forms, flat palette colours) and writes
concept-1-anvil.png / concept-2-cage.png / concept-3-bulwark.png next to this
file. These are design studies only: no contract checks, no delivery export.
"""
import bpy
import math
import sys
from pathlib import Path
from mathutils import Vector

HERE = Path(__file__).resolve().parent
BORE_Z = 0.075
MUZZLE_Y = 0.780

# flat blockout palette (matches the delivered texture family)
GREY = (0.24, 0.25, 0.28, 1)
OLIVE = (0.30, 0.30, 0.19, 1)
ORANGE = (0.78, 0.32, 0.07, 1)
IVORY = (0.80, 0.78, 0.72, 1)
DARK = (0.10, 0.10, 0.11, 1)
BLACK = (0.015, 0.015, 0.016, 1)

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


def material(name, colour, metal=0.2, rough=0.6):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = colour
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    return mat


MATS = {name: material(name, col, *args) for (name, col, *args) in (
    ('grey', GREY, .5, .45), ('olive', OLIVE, .1, .65), ('orange', ORANGE, .1, .5),
    ('ivory', IVORY, .05, .5), ('dark', DARK, .2, .8), ('black', BLACK, 0, 1))}

PARTS = []


def add(name, mat, verts, faces, loc=(0, 0, 0)):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = loc
    mesh.materials.append(MATS[mat])
    scene.collection.objects.link(obj)
    PARTS.append(obj)
    return obj


def box(name, mat, sx, sy, sz, y, z=BORE_Z, x=0.0):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    verts = [(x + dx, y + dy, z + dz) for dz in (-hz, hz) for dy in (-hy, hy) for dx in (-hx, hx)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return add(name, mat, verts, faces)


def cyl(name, mat, r0, r1, y0, y1, seg=20, inner=None):
    """Closed (optionally hollow) cone/tube along Y."""
    verts, faces = [], []

    def ring(radius, y):
        base = len(verts)
        for i in range(seg):
            a = 2 * math.pi * i / seg
            verts.append((radius * math.cos(a), y, BORE_Z + radius * math.sin(a)))
        return [base + i for i in range(seg)]

    outer0, outer1 = ring(r0, y0), ring(r1, y1)
    if inner is None:
        faces.append(tuple(reversed(outer0)))
        faces.append(tuple(outer1))
        inner0 = inner1 = None
    else:
        inner0, inner1 = ring(inner[0], y0), ring(inner[1], y1)
        for i in range(seg):
            j = (i + 1) % seg
            faces.append((outer0[i], inner0[i], inner0[j], outer0[j]))
            faces.append((outer1[i], outer1[j], inner1[j], inner1[i]))
    for i in range(seg):
        j = (i + 1) % seg
        faces.append((outer0[i], outer0[j], outer1[j], outer1[i]))
        if inner is not None:
            faces.append((inner0[i], inner1[i], inner1[j], inner0[j]))
    return add(name, mat, verts, faces)


def strut(name, mat, p0, p1, w):
    """A square-section strut from p0 to p1 (authoring space)."""
    (y0, z0), (y1, z1) = p0, p1
    length = math.hypot(y1 - y0, z1 - z0)
    obj = box(name, mat, w, length, w, 0.0, 0.0)
    obj.location = (0.0, (y0 + y1) / 2, (z0 + z1) / 2)
    obj.rotation_euler = (math.atan2(z1 - z0, y1 - y0), 0, 0)
    return obj


def base_skeleton(variant):
    """Tube, breech block, tail, grip, trigger, lever, sights, warhead."""
    cyl('Launch tube', 'olive', .062, .062, .20, MUZZLE_Y, inner=(.056, .056))
    cyl('Muzzle collar', 'grey', .072, .072, .752, .782, inner=(.056, .056))
    # rear assembly: squared breech block + venturi tail + hinge
    box('Breech block', 'grey', .17, .17, .17, .185)
    cyl('Venturi tail', 'grey', .075, .098, -.05, .11, inner=(.056, .056))
    cyl('Venturi rim', 'orange', .100, .100, -.05, -.03, inner=(.056, .056))
    box('Hinge knuckle', 'grey', .20, .05, .05, .06, .075)
    # shoulder rest: left flank brace + pad
    box('Shoulder brace', 'grey', .03, .12, .04, .08, .01, -.085)
    box('Shoulder pad', 'dark', .035, .13, .10, .05, .01, -.115)
    # pistol grip + trigger guard
    grip = box('Pistol grip', 'dark', .05, .06, .12, .085, -.075)
    grip.rotation_euler = (math.radians(-12), 0, 0)
    box('Grip base', 'grey', .055, .07, .02, .075, -.135)
    box('Trigger guard', 'grey', .03, .11, .012, .11, -.012)
    box('Trigger blade', 'orange', .012, .018, .05, .11, -.038)
    # arming lever on the right flank at bolt home
    box('Arming lever', 'grey', .05, .025, .025, .04, .03, .085)
    cyl('Lever knob', 'orange', .013, .013, .04, .04, seg=10)
    bpy.data.objects['Lever knob'].rotation_euler = (0, 0, math.radians(90))
    bpy.data.objects['Lever knob'].location = (0.108, .04, .03)
    # top spine + ladder sights (rear at y 0.02, front at y 0.768)
    box('Top spine', 'grey', .05, .52, .02, .26, .163)
    box('Rear sight base', 'grey', .04, .035, .02, .02, .172)
    box('Rear sight ear L', 'grey', .008, .03, .035, .02, .182, -.016)
    box('Rear sight ear R', 'grey', .008, .03, .035, .02, .182, .016)
    box('Front sight', 'grey', .02, .02, .05, .768, .175)
    box('Front sight tip', 'orange', .008, .008, .01, .768, .202)
    # underslung control canister
    box('Control canister', 'dark', .07, .10, .075, .30, -.055)
    box('Canister stripe', 'orange', .074, .03, .08, .30, -.065)


def warhead_fat():
    """Fat ogive warhead proud of the muzzle on a slim boom (Panzerfaust 3 read)."""
    cyl('Warhead boom', 'grey', .034, .034, .70, .80)
    cyl('Warhead boat tail', 'olive', .036, .058, .795, .845)
    cyl('Warhead ogive', 'ivory', .062, .030, .845, .955)
    cyl('Warhead band', 'orange', .064, .064, .848, .868)
    cyl('Warhead tip', 'black', .030, .012, .955, .975)


def warhead_slim():
    """Long slim dart with wrap lugs (munitions-bay read)."""
    cyl('Warhead boom', 'grey', .034, .034, .70, .80)
    cyl('Warhead ogive', 'olive', .056, .012, .795, .965)
    cyl('Warhead band', 'orange', .058, .058, .80, .818)
    for k in range(4):
        a = k * math.pi / 2
        box(f'Warhead lug {k}', 'grey', .012, .03, .03, .885,
            BORE_Z + .058 * math.sin(a), .058 * math.cos(a))


def warhead_cradled():
    """Warhead seated in a forked muzzle bracket (heavy ordnance read)."""
    cyl('Warhead boom', 'grey', .034, .034, .70, .80)
    cyl('Warhead boat tail', 'grey', .038, .062, .795, .855)
    cyl('Warhead ogive', 'orange', .066, .020, .855, .965)
    cyl('Warhead band', 'ivory', .068, .068, .858, .876)
    box('Muzzle fork L', 'grey', .014, .10, .03, .80, .12, -.055)
    box('Muzzle fork R', 'grey', .014, .10, .03, .80, .12, .055)


def variant_anvil():
    """A: squared armour receiver, heavy panels, industrial slab silhouette."""
    base_skeleton('anvil')
    box('Receiver shell', 'olive', .185, .30, .19, .37, .075)
    for side in (-1, 1):
        box(f'Side panel {side}', 'grey', .012, .22, .12, .37, .075, side * .098)
        box(f'Panel bolt {side}', 'orange', .014, .03, .03, .28, .11, side * .100)
        box(f'Panel bolt rear {side}', 'orange', .014, .03, .03, .46, .11, side * .100)
        box(f'Handle rail {side}', 'grey', .012, .18, .02, .37, -.02, side * .10)
    box('Receiver top panel', 'ivory', .12, .24, .012, .37, .171)
    warhead_fat()


def variant_cage():
    """B: open cage-braced exoskeleton, skeletal lattice around the bare tube."""
    base_skeleton('cage')
    for side in (-1, 1):
        for deck in (-1, 1):
            box(f'Longeron {side} {deck}', 'grey', .016, .30, .016,
                .37, BORE_Z + deck * .082, side * .062)
    for k, y in enumerate((.235, .37, .505)):
        box(f'Hoop top {k}', 'grey', .15, .014, .014, y, .157)
        box(f'Hoop bottom {k}', 'grey', .15, .014, .014, y, -.007)
        box(f'Hoop left {k}', 'grey', .014, .014, .16, y, BORE_Z, -.068)
        box(f'Hoop right {k}', 'grey', .014, .014, .16, y, BORE_Z, .068)
    for k, (y0, y1) in enumerate(((.245, .36), (.38, .495))):
        strut(f'Diagonal L {k}', 'orange', (y0, .150), (y1, .000), .012)
        strut(f'Diagonal R {k}', 'orange', (y0, .000), (y1, .150), .012)
    warhead_slim()


def variant_bulwark():
    """C: hybrid — squared breech housing forward into a half cage, big handles."""
    base_skeleton('bulwark')
    box('Breech housing', 'olive', .18, .16, .185, .31, .075)
    box('Housing cheek L', 'grey', .014, .12, .10, .31, .075, -.096)
    box('Housing cheek R', 'grey', .014, .12, .10, .31, .075, .096)
    for side in (-1, 1):
        box(f'Carry handle {side}', 'grey', .014, .10, .026, .41, -.03, side * .07)
        strut(f'Brace top {side}', 'grey', (.39, .155), (.505, .12), .014)
        strut(f'Brace low {side}', 'grey', (.39, -.005), (.505, .045), .014)
    box('Spine deck', 'ivory', .08, .22, .012, .42, .168)
    warhead_cradled()


VARIANTS = [('concept-1-anvil.png', variant_anvil),
            ('concept-2-cage.png', variant_cage),
            ('concept-3-bulwark.png', variant_bulwark)]


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
cam.location = Vector((1.45, -1.25, 0.80))
direction = Vector((0.0, 0.44, 0.02)) - cam.location
cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
cam_data.lens = 56

for (filename, build) in VARIANTS:
    for obj in list(PARTS):
        mesh = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.meshes.remove(mesh)
    PARTS.clear()
    build()
    scene.render.filepath = str(HERE / filename)
    bpy.ops.render.render(write_still=True)
    print(f'CONCEPT_SAVED {filename}')

# overview sheet: all three side by side (left ANVIL, centre CAGE, right BULWARK)
for obj in list(PARTS):
    mesh = obj.data
    bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.meshes.remove(mesh)
PARTS.clear()
for (offset, (_f, build)) in zip((-0.55, 0.0, 0.55), VARIANTS):
    before = len(PARTS)
    build()
    for obj in PARTS[before:]:
        obj.location = (obj.location[0] + offset, obj.location[1], obj.location[2])
cam.location = Vector((2.5, -2.35, 1.35))
direction = Vector((0.0, 0.42, 0.02)) - cam.location
cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
cam_data.lens = 52
scene.render.filepath = str(HERE / 'concept-0-overview.png')
bpy.ops.render.render(write_still=True)
print('CONCEPT_SAVED concept-0-overview.png')

print('CONCEPT-BLOCKOUTS-DONE')
