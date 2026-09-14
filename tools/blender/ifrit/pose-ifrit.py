#!/usr/bin/env python3
"""Articulation proof shots for the IFRIT study.

Usage:
    blender --background --factory-startup docs/design/blender/ifrit/ifrit.blend \\
        --python tools/blender/ifrit/pose-ifrit.py

Moves ONLY animation-node transforms (the `trigger`, `bolt` and `mag`
empties that the game rig drives) — never geometry — and renders three
articulation frames with the study lighting:

    pose-fire.png    trigger pulled + valve (bolt) lever rotated open
    pose-detach.png  fuel tank (mag) tilted/dropped off its saddle
    pose-home.png    home/closed reference from the same camera

Game choreography this mirrors (public/js/guns/):
  - trigger pull:  actions.js jerk, triggerGroup.rotation.x = 0.20 * stroke.
  - valve open:    reload staging, bolt.position.z = boltTravel * open and
                   bolt.rotation.z = 0.5 * open (TIMERS.flamethrower
                   boltTravel = 0.01). Game +Z (rearward) is authoring -Y and
                   game rotation about the longitudinal Z is authoring
                   rotation about Y (sign-flipped), hence location.y = -0.01
                   and rotation.y = -0.5.
  - tank detach:   actions.js 'mag' timeline drops the whole transverse fuel
                   tank off the receiver. The full game path would carry the
                   tank a metre out of frame, so this pose uses a modest but
                   unambiguous drop + tilt that keeps the part in view.
"""

import sys
from pathlib import Path

import bpy
from mathutils import Vector

DOCS = None
for arg in sys.argv:
    if arg.endswith('ifrit.blend'):
        DOCS = Path(arg).parent
if DOCS is None:
    DOCS = Path('/Users/logge/Documents/Projects/voxel-blitz/docs/design/blender/ifrit')

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
    scene.collection.objects.link(obj)
    return obj


# Study lighting, identical to tools/blender/ifrit/render-ifrit.py.
area_light('IFRIT key', (2.2, 1.6, 2.4), 900)
area_light('IFRIT fill', (-2.4, -0.6, 1.1), 320, size=2.4, colour=(0.82, 0.88, 1.0, 1))
area_light('IFRIT rim', (-0.9, -2.2, 1.8), 420, size=1.6, colour=(1.0, 0.94, 0.86, 1))

cam_data = bpy.data.cameras.new('IFRIT pose camera')
cam = bpy.data.objects.new('IFRIT pose camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

# Right-rear three-quarter view: trigger, valve lever and tank saddle all read.
POSE_CAM = ((1.55, -0.55, 0.55), (0.0, 0.15, -0.03), 55)
pos, target, lens = POSE_CAM
cam.location = Vector(pos)
cam.rotation_euler = (Vector(target) - Vector(pos)).to_track_quat('-Z', 'Y').to_euler()
cam_data.lens = lens

# Animation nodes only: the empties the game rig drives. Geometry is untouched.
trigger = bpy.data.objects['trigger']
bolt = bpy.data.objects['bolt']
mag = bpy.data.objects['mag']
NODES = (trigger, bolt, mag)


def home():
    for node in NODES:
        node.location = (0.0, 0.0, 0.0)
        node.rotation_euler = (0.0, 0.0, 0.0)


def pose_fire():
    """Trigger at full pull; valve lever thrown open."""
    home()
    trigger.rotation_euler.x = 0.20
    bolt.location.y = -0.01
    bolt.rotation_euler.y = -0.5


def pose_detach():
    """Fuel tank dropped clear of its saddle with a readable tilt."""
    home()
    mag.location = (0.0, -0.02, -0.12)
    mag.rotation_euler = (0.12, 0.0, 0.10)


FRAMES = (
    ('pose-fire', pose_fire),
    ('pose-detach', pose_detach),
    ('pose-home', home),
)

for name, pose in FRAMES:
    pose()
    bpy.context.view_layer.update()
    scene.render.filepath = str(DOCS / f'{name}.png')
    bpy.ops.render.render(write_still=True)
    print(f'POSE_SAVED {name}.png')

home()
print('POSE-IFRIT-DONE')
