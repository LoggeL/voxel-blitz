#!/usr/bin/env python3
"""Render hero/side/left/ads/rear proof shots of the SKUA study.

Usage:
    blender --background --factory-startup docs/design/blender/skua/skua.blend \
        --python tools/blender/skua/render-skua.py

The ads shot is taken from the ADS eye point (game (0, 0.150, +0.35)) down the
sight line with a 50 degree field of view: the rear notch, the ring sight and
the seated disc's face must all read in it.
"""
import bpy
import math
import sys
from pathlib import Path
from mathutils import Vector

DOCS = None
for arg in sys.argv:
    if arg.endswith('skua.blend'):
        DOCS = Path(arg).parent
if DOCS is None:
    DOCS = Path(__file__).resolve().parents[3] / 'docs/design/blender/skua'

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 40
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'

# 50 degree horizontal field of view on the default 36 mm sensor.
ADS_LENS = 18 / math.tan(math.radians(25))
VIEWS = {
    # name: (camera pos, look-at, lens) in authoring space (+Y forward, +Z up)
    'hero': ((0.95, 1.10, 0.58), (0.0, 0.15, -0.005), 55),
    'side': ((2.4, 0.15, 0.012), (0.0, 0.15, 0.012), 85),
    'left': ((-2.4, 0.15, 0.012), (0.0, 0.15, 0.012), 85),
    'ads': ((0.0, -0.35, 0.150), (0.0, 0.40, 0.150), ADS_LENS),
    'rear': ((-0.72, -0.98, 0.58), (0.0, 0.12, -0.005), 55),
}


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

cam_data = bpy.data.cameras.new('SKUA camera')
cam_data.clip_start = 0.01
cam = bpy.data.objects.new('SKUA camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

for name, (pos, target, lens) in VIEWS.items():
    cam.location = Vector(pos)
    direction = Vector(target) - Vector(pos)
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    cam_data.lens = lens
    scene.render.filepath = str(DOCS / f'render-{name}.png')
    bpy.ops.render.render(write_still=True)
    print(f'RENDER_SAVED render-{name}.png')

print('SKUA-RENDER-DONE')
