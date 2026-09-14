#!/usr/bin/env python3
"""Articulation proof shots of the MASTIFF pump-shotgun study.

Usage:
    blender --background --factory-startup docs/design/blender/mastiff/mastiff.blend \\
        --python tools/blender/mastiff/pose-mastiff.py

Moves ONLY animation-node transforms (the `pump` / `bolt` empties and the
`support` gameplay marker that rides the pump); no mesh vertex, modifier, or
material is touched and the .blend is never saved. Lighting matches the study
renders (three area lights over the AgX studio world from build-mastiff.py).

Frames:
    pose-open.png    pump slid back 85 mm + bolt open 55 mm (same camera as closed)
    pose-closed.png  battery / rest pose, same camera for direct comparison
    pose-carrier.png rest pose, close-up of the left-flank side-saddle + shells
"""
import bpy
import sys
from mathutils import Vector
from pathlib import Path

DOCS = None
for arg in sys.argv:
    if arg.endswith('mastiff.blend'):
        DOCS = Path(arg).parent
if DOCS is None:
    DOCS = Path('/Users/logge/Documents/Projects/voxel-blitz/docs/design/blender/mastiff')

PUMP_BACK = -0.085  # slide rearward toward the receiver, front stays clear of it
BOLT_TRAVEL_Y = -0.045  # rearward slide: opens the window front, rear end hides inside the receiver
BOLT_TUCK_X = -0.0035  # slight inward cam: retracted bolt sits behind the side plate, never proud of it

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 40
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'

pump = bpy.data.objects.get('pump')
bolt = bpy.data.objects.get('bolt')
support = bpy.data.objects.get('support')
assert pump is not None and bolt is not None, 'pump/bolt animation nodes missing'
pump_rest = pump.location.copy()
bolt_rest = bolt.location.copy()
support_rest = support.location.copy() if support is not None else None


def area_light(name, location, energy, size=1.4, colour=(1, 1, 1, 1)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.size = size
    data.color = colour[:3]
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    scene.collection.objects.link(obj)
    return obj


area_light('MASTIFF key', (2.2, 1.6, 2.4), 900)
area_light('MASTIFF fill', (-2.4, -0.6, 1.1), 320, size=2.4, colour=(0.82, 0.88, 1.0, 1))
area_light('MASTIFF rim', (-0.9, -2.2, 1.8), 420, size=1.6, colour=(1.0, 0.94, 0.86, 1))

cam_data = bpy.data.cameras.new('MASTIFF pose camera')
cam = bpy.data.objects.new('MASTIFF pose camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam


def frame(fname, pos, target, lens):
    cam.location = Vector(pos)
    direction = Vector(target) - Vector(pos)
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    cam_data.lens = lens
    bpy.context.view_layer.update()
    scene.render.filepath = str(DOCS / fname)
    bpy.ops.render.render(write_still=True)
    print(f'POSE_SAVED {fname}')


PROFILE = ((2.4, -1.2, 0.5), (0.0, 0.20, 0.02), 60)

# (1) pump back + bolt open
pump.location.y = pump_rest.y + PUMP_BACK
bolt.location.y = bolt_rest.y + BOLT_TRAVEL_Y
bolt.location.x = bolt_rest.x + BOLT_TUCK_X
if support is not None:
    support.location.y = support_rest.y + PUMP_BACK
frame('pose-open.png', *PROFILE)

# (2) battery, same camera for direct comparison
pump.location = pump_rest
bolt.location = bolt_rest
if support is not None:
    support.location = support_rest
frame('pose-closed.png', *PROFILE)

# (3) side-saddle carrier detail, rest pose (shells live on `extra` at contract default)
frame('pose-carrier.png', (-1.4, -0.2, 0.35), (-0.03, 0.0, 0.015), 55)

# Restore (blend is not saved, but leave the session clean anyway).
pump.location = pump_rest
bolt.location = bolt_rest
if support is not None:
    support.location = support_rest

print('MASTIFF-POSE-DONE')
