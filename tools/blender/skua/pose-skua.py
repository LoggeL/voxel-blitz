#!/usr/bin/env python3
"""Render SKUA articulation frames (part transforms only, never geometry).

Usage:
    blender --background --factory-startup docs/design/blender/skua/skua.blend \
        --python tools/blender/skua/pose-skua.py

The transforms mirror the runtime presentation (public/js/guns/glaive-presentation.js):
    pose-home          both discs in hand, horns closed
    pose-throw         seated disc slid 0.18 forward along its tilted plane, spun and
                       shrunk to 0.25 (it clears the horn hinge knuckles), flywheel
                       whirled and kicked back 0.012
    pose-horns-open    the return-leg flare: horns 22 deg about their pins
                       (right rotation.y = -flare, left = +flare in game space)
    pose-empty         both discs out: seated disc hidden, spare hidden, horns 11 deg
    pose-cassette-lift 75 % into the lift: the spare has shrunk away in the cassette
                       and the next disc grows on the seat (half size)
"""
import bpy
import math
import sys
from pathlib import Path
from mathutils import Matrix, Vector

DOCS = None
for arg in sys.argv:
    if arg.endswith('skua.blend'):
        DOCS = Path(arg).parent
if DOCS is None:
    DOCS = Path(__file__).resolve().parents[3] / 'docs/design/blender/skua'

# Authoring-space pivots; they must match build-skua.py.
DISC_TILT = math.radians(6)
DISC_C = Vector((0.0, 0.220, 0.042))
SPARE_C = Vector((0.0, 0.165, -0.072))
FLYWHEEL_C = Vector((0.0, -0.060, 0.0))
HINGES = {'horn right': Vector((0.050, 0.335, 0.0)), 'horn left': Vector((-0.050, 0.335, 0.0))}
THROW_M = 0.18
SLIDE_SCALE_END, SLIDE_SHRINK_RATE = 0.25, 2.4
KICK_M = 0.012

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 40
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'


def area_light(name, location, energy, size=1.4, colour=(1, 1, 1, 1)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.size = size
    data.color = colour[:3]
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    obj.rotation_euler = (Vector((0, 0.15, 0)) - Vector(location)).to_track_quat('-Z', 'Y').to_euler()
    scene.collection.objects.link(obj)
    return obj


area_light('SKUA key', (2.2, 1.6, 2.4), 900)
area_light('SKUA fill', (-2.4, -0.6, 1.1), 320, size=2.4, colour=(0.82, 0.88, 1.0, 1))
area_light('SKUA rim', (-2.6, -0.9, 0.7), 250, size=1.6, colour=(1.0, 0.94, 0.86, 1))

cam_data = bpy.data.cameras.new('SKUA pose camera')
cam_data.clip_start = 0.01
cam = bpy.data.objects.new('SKUA pose camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

parts = [o for o in scene.objects if o.type == 'MESH' and o.get('part')]
mag = [o for o in parts if o['part'] == 'mag']
bolt = [o for o in parts if o['part'] == 'bolt']
spare = [o for o in parts if o.get('node') == 'spare disc']
horns = {node: [o for o in parts if o.get('node') == node] for node in HINGES}
if not (mag and bolt and spare and all(horns.values())):
    raise SystemExit('pose-skua needs the authored source parts of skua.blend')
MOVING = mag + bolt + spare + [o for group in horns.values() for o in group]


def about(pivot, rotation):
    return Matrix.Translation(pivot) @ rotation @ Matrix.Translation(-pivot)


def reset():
    for obj in MOVING:
        obj.matrix_world = Matrix.Identity(4)
        obj.hide_render = False
    bpy.context.view_layer.update()


def pose(throw=0.0, spin=0.0, flywheel=0.0, flare=0.0, show_disc=True, show_spare=True,
         lift=0.0):
    normal = Matrix.Rotation(DISC_TILT, 3, 'X') @ Vector((0, 0, 1))
    forward = Matrix.Rotation(DISC_TILT, 3, 'X') @ Vector((0, 1, 0))
    # Runtime: the slide shrinks the disc; the lift's second half grows it on the seat.
    scale = 1 - (1 - SLIDE_SCALE_END) * min(1.0, throw * SLIDE_SHRINK_RATE)
    if lift > 0.5:
        u = min(1.0, (lift - 0.5) * 2)
        scale = max(0.05, u * u * (3 - 2 * u))
    disc = Matrix.Translation(forward * THROW_M * throw) @ \
        about(DISC_C, Matrix.Rotation(spin, 4, normal) @ Matrix.Scale(scale, 4))
    for obj in mag:
        obj.matrix_world = disc
        obj.hide_render = not show_disc or 0 < lift <= 0.5
    wheel = Matrix.Translation((0, -KICK_M * min(1.0, throw * 2), 0)) @ \
        about(FLYWHEEL_C, Matrix.Rotation(flywheel, 4, 'Y'))
    for obj in bolt:
        obj.matrix_world = wheel
    for (node, hinge) in HINGES.items():
        side = 1 if node.endswith('right') else -1
        # Right horn: rotation.y = -flare in game space = -flare about authoring +Z.
        matrix = about(hinge, Matrix.Rotation(-side * flare, 4, 'Z'))
        for obj in horns[node]:
            obj.matrix_world = matrix
    # Runtime: the lift's first half shrinks the spare in place inside the cassette.
    u = min(1.0, lift * 2)
    shrunk = about(SPARE_C, Matrix.Scale(max(0.05, 1 - u * u * (3 - 2 * u)), 4))
    for obj in spare:
        obj.matrix_world = shrunk
        obj.hide_render = not show_spare or u >= 1
    bpy.context.view_layer.update()


def frame(pos, target, lens):
    cam.location = Vector(pos)
    cam.rotation_euler = (Vector(target) - Vector(pos)).to_track_quat('-Z', 'Y').to_euler()
    cam_data.lens = lens


HERO = ((0.95, 1.10, 0.58), (0.0, 0.15, -0.005), 55)
POSES = [
    ('pose-home', {}, HERO),
    ('pose-throw', {'throw': 1.0, 'spin': math.radians(140), 'flywheel': math.radians(35)},
     ((1.10, 0.55, 0.62), (0.0, 0.22, 0.0), 55)),
    ('pose-horns-open', {'flare': math.radians(22)}, ((0.0, 0.30, 0.95), (0.0, 0.26, 0.0), 50)),
    ('pose-empty', {'flare': math.radians(11), 'show_disc': False, 'show_spare': False}, HERO),
    ('pose-cassette-lift', {'lift': 0.75},
     ((1.25, 0.25, 0.20), (0.0, 0.18, -0.02), 60)),
]

for (name, args, view) in POSES:
    reset()
    pose(**args)
    frame(*view)
    scene.render.filepath = str(DOCS / f'{name}.png')
    bpy.ops.render.render(write_still=True)
    print(f'POSE_SAVED {name}.png {args}')

reset()
print('SKUA-POSE-DONE')
