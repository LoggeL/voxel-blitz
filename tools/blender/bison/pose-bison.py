#!/usr/bin/env python3
"""Articulation stills for the BISON study (final acceptance).

Usage:
    blender --background --factory-startup docs/design/blender/bison/bison.blend \
        --python tools/blender/bison/pose-bison.py

Moves ONLY group-empty transforms (bolt / mag / a temporary hinge empty for
the feed cover / the belt lead objects), never mesh geometry:
  1. pose-bolt-back.png — bolt group -0.075 in Y (game +0.075 Z, defs lmg
     boltTravel 0.075; actions.js _stepCycle and the belt reload's final
     charging-handle rack both drive model.bolt.position.z by T.boltTravel).
  2. pose-cover-open.png — the feed cover leaves (custom prop `cover`) swung
     -70 degrees about the authored 'Feed cover hinge' pin, belt lead still on
     the tray: the runtime's reloadPart.rotation.x = -1.22 at mid reload.
  3. pose-reload.png — cover open, ammo box (mag group, with its hanging belt)
     dropped along the box-out path, belt lead lifted out of the tray: the
     runtime's box-out / spent-lead beat of the belt reload.
  4. pose-home.png — everything home/closed (identity, matches the 5 shipped
     angle renders).

Study lighting + a raised left-flank camera match render-bison.py's palette so
the sheets compare directly (charging handle lives on -X; the hero view hides
it; the raised angle looks into the open tray).
"""
import sys
from pathlib import Path

import bpy
from mathutils import Vector

DOCS = None
for arg in sys.argv:
    if arg.endswith('bison.blend'):
        DOCS = Path(arg).parent
if DOCS is None:
    DOCS = Path('/Users/logge/Documents/Projects/voxel-blitz/docs/design/blender/bison')

# Game contract: public/js/guns/defs.js lmg boltTravel 0.075, magTimeline
# type 'belt'. Game +Z is rearward; authoring +Y is forward, so a game
# +Z bolt throw is authoring -Y.
BOLT_BACK_Y = -0.075
COVER_OPEN = -1.22  # radians about X on the hinge pin, as actions.js applies

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 40
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'


def area_light(name, location, energy, size=1.4, colour=(1, 1, 1, 1)):
    if name in bpy.data.objects:
        obj = bpy.data.objects[name]
        obj.location = location
        return obj
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.size = size
    data.color = colour[:3]
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    scene.collection.objects.link(obj)
    return obj


area_light('BISON key', (2.2, 1.6, 2.4), 900)
area_light('BISON fill', (-2.4, -0.6, 1.1), 320, size=2.4, colour=(0.82, 0.88, 1.0, 1))
area_light('BISON rim', (-0.9, -2.2, 1.8), 420, size=1.6, colour=(1.0, 0.94, 0.86, 1))

def group_empty(name):
    return next((o for o in scene.objects if o.type == 'EMPTY' and o.name.split('.')[0] == name), None)


bolt_empty = group_empty('bolt')
mag_empty = group_empty('mag')
if bolt_empty is None or mag_empty is None:
    raise RuntimeError('pose-bison: bolt/mag empties missing from bison.blend')
hinge = tuple(scene.get('cover_hinge', (0.0, 0.206, 0.145)))
cover_objects = [o for o in scene.objects if o.type == 'MESH' and o.get('cover')]
lead_objects = [o for o in scene.objects if o.type == 'MESH' and o.get('belt_lead')]
if not cover_objects or not lead_objects:
    raise RuntimeError('pose-bison: feed cover leaves or belt lead missing from bison.blend')

# Temporary hinge pivot: the cover leaves are re-parented to it with their
# world placement kept, exactly like the runtime builder re-hangs them.
pivot = bpy.data.objects.new('BISON pose hinge', None)
pivot.location = Vector(hinge)
scene.collection.objects.link(pivot)
bpy.context.view_layer.update()
for obj in cover_objects:
    world = obj.matrix_world.copy()
    obj.parent = pivot
    obj.matrix_parent_inverse = pivot.matrix_world.inverted()
    obj.matrix_world = world

bolt_home = (bolt_empty.location.copy(), bolt_empty.rotation_euler.copy())
mag_home = (mag_empty.location.copy(), mag_empty.rotation_euler.copy())
lead_home = [(o, o.location.copy(), o.rotation_euler.copy()) for o in lead_objects]

cam_data = bpy.data.cameras.new('BISON pose camera')
cam = bpy.data.objects.new('BISON pose camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

# Raised left flank: charging handle (-X), under-hung box, and the open tray.
pos, target, lens = ((-2.7, 0.10, 0.95), (0.0, 0.15, 0.07), 80)
cam.location = Vector(pos)
cam.rotation_euler = (Vector(target) - Vector(pos)).to_track_quat('-Z', 'Y').to_euler()
cam_data.lens = lens


def reset():
    bolt_empty.location = bolt_home[0].copy()
    bolt_empty.rotation_euler = bolt_home[1].copy()
    mag_empty.location = mag_home[0].copy()
    mag_empty.rotation_euler = mag_home[1].copy()
    pivot.rotation_euler = (0.0, 0.0, 0.0)
    for (obj, location, rotation) in lead_home:
        obj.location = location.copy()
        obj.rotation_euler = rotation.copy()
        obj.hide_render = False
    bpy.context.view_layer.update()


def render(name):
    scene.render.filepath = str(DOCS / name)
    bpy.ops.render.render(write_still=True)
    print(f'POSE_SAVED {name}')


# 1 — bolt back, box home, cover shut.
reset()
bolt_empty.location.y += BOLT_BACK_Y
bpy.context.view_layer.update()
render('pose-bolt-back.png')

# 2 — cover open on its hinge, belt lead on the tray, box home.
reset()
pivot.rotation_euler = (COVER_OPEN, 0.0, 0.0)
bpy.context.view_layer.update()
render('pose-cover-open.png')

# 3 — reload: cover open, box dropped out on the exit path, lead lifted clear.
reset()
pivot.rotation_euler = (COVER_OPEN, 0.0, 0.0)
mag_empty.location.x += -0.075
mag_empty.location.y += -0.030
mag_empty.location.z += -0.110
mag_empty.rotation_euler = (0.20, 0.0, 0.12)
for (obj, location, _rotation) in lead_home:
    obj.location = location + Vector((-0.070, 0.020, -0.090))
    obj.rotation_euler = (0.0, 0.40, 0.0)
bpy.context.view_layer.update()
render('pose-reload.png')

# 4 — home/closed.
reset()
render('pose-home.png')

print('BISON-POSE-DONE')
