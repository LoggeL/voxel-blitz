#!/usr/bin/env python3
"""Articulation study for the PIKE charge lance: bolt-back, mag-out, home.

Moves ONLY group-node transforms (the `bolt` / `mag` empties); no mesh data,
no materials, no added geometry. Same study lighting as render-pike.py.

Usage:
    blender --background --factory-startup docs/design/blender/pike/pike.blend \\
        --python tools/blender/pike/pose-pike.py

Game mapping (authoring space: +Y forward, +Z up; game z = -authoring y):
- bolt-back: full recharge throw. defs.js gives lance boltTravel = 0.10 m
  along game +Z (rearward), i.e. authoring -Y by 0.10. Per-shot
  reciprocation is translation-only, so the study keeps rotation at zero.
- mag-out: the live reload slides the `mag` group along the lance exit path
  (exit [-0.46, -1.30, 0.80] in game space), which would fling the cell ~1.4 m
  out of frame. The study uses a reduced excursion in the same direction
  (down/outboard with a slight twist) so the separated cell still reads
  beside the magwell.
- home: identity on both nodes (matches the five shipped angle renders).
"""
import bpy
import sys
from mathutils import Vector
from pathlib import Path

DOCS = None
for arg in sys.argv:
    if arg.endswith('pike.blend'):
        DOCS = Path(arg).parent
if DOCS is None:
    DOCS = Path('/Users/logge/Documents/Projects/voxel-blitz/docs/design/blender/pike')

# --- node-only posing ---------------------------------------------------------
# Only the group empties move; every mesh keeps its authored vertices.
POSES = {
    # name: {group: (location, rotation_euler)}
    'pose-home': {
        'bolt': ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0)),
        'mag': ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0)),
    },
    'pose-bolt-back': {
        # Full 0.10 m recharge throw, rearward (-Y authoring = game +Z).
        'bolt': ((0.0, -0.10, 0.0), (0.0, 0.0, 0.0)),
        'mag': ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0)),
    },
    'pose-mag-out': {
        # Reduced lance exit excursion: down/outboard with a slight twist.
        'bolt': ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0)),
        'mag': ((-0.06, -0.03, -0.15), (0.12, -0.10, 0.0)),
    },
}

bolt = bpy.data.objects.get('bolt')
mag = bpy.data.objects.get('mag')
assert bolt is not None and bolt.type == 'EMPTY', 'group node `bolt` missing'
assert mag is not None and mag.type == 'EMPTY', 'group node `mag` missing'

# --- study lighting (same rig as render-pike.py) ------------------------------
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


area_light('PIKE pose key', (2.2, 1.6, 2.4), 900)
area_light('PIKE pose fill', (-2.4, -0.6, 1.1), 320, size=2.4,
           colour=(0.82, 0.88, 1.0, 1))
area_light('PIKE pose rim', (-0.9, -2.2, 1.8), 420, size=1.6,
           colour=(1.0, 0.94, 0.86, 1))

cam_data = bpy.data.cameras.new('PIKE pose camera')
cam = bpy.data.objects.new('PIKE pose camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

# Bolt handle rides the -X flank, so the study camera works that side:
# rear-biased 3/4 showing the sled, the magwell cell, and the rail lane.
CAM_POS = Vector((-1.55, -1.15, 0.80))
CAM_TARGET = Vector((0.0, 0.12, 0.0))
cam.location = CAM_POS
cam.rotation_euler = (CAM_TARGET - CAM_POS).to_track_quat('-Z', 'Y').to_euler()
cam_data.lens = 50

for name, groups in POSES.items():
    for group_name, (loc, rot) in groups.items():
        node = bpy.data.objects[group_name]
        node.location = Vector(loc)
        node.rotation_euler = rot
    bpy.context.view_layer.update()
    scene.render.filepath = str(DOCS / f'{name}.png')
    bpy.ops.render.render(write_still=True)
    print(f'POSE_SAVED {name}.png')

# Leave the session parked at home so an interactive open shows the closed gun.
bolt.location = Vector((0.0, 0.0, 0.0))
bolt.rotation_euler = (0.0, 0.0, 0.0)
mag.location = Vector((0.0, 0.0, 0.0))
mag.rotation_euler = (0.0, 0.0, 0.0)

print('PIKE-POSE-DONE')
