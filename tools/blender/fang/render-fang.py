#!/usr/bin/env python3
"""Render hero/side/ads/rear proof shots of the FANG study.

Usage:
    blender --background --factory-startup docs/design/blender/fang/fang.blend \\
        --python tools/blender/fang/render-fang.py
"""
import bpy
import sys
from mathutils import Vector

DOCS = None
for arg in sys.argv:
    if arg.endswith('fang.blend'):
        from pathlib import Path
        DOCS = Path(arg).parent
if DOCS is None:
    from pathlib import Path
    DOCS = Path('/Users/logge/Documents/Projects/voxel-blitz/docs/design/blender/fang')

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 40
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'

VIEWS = {
    # name: (camera pos, look-at, lens)
    'hero': ((0.95, -0.75, 0.55), (0.0, 0.20, 0.02), 55),
    'side': ((2.2, 0.20, 0.03), (0.0, 0.20, 0.03), 80),
    'left': ((-2.2, 0.20, 0.03), (0.0, 0.20, 0.03), 80),
    'ads': ((0.0, -0.55, 0.15), (0.0, 0.50, 0.09), 45),
    'rear': ((-0.85, -0.75, 0.45), (0.0, 0.12, 0.02), 55),
}


def area_light(name, location, energy, size=1.4, colour=(1, 1, 1, 1)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.size = size
    data.color = colour[:3]
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    scene.collection.objects.link(obj)
    return obj


area_light('FANG key', (1.6, 1.1, 1.8), 700)
area_light('FANG fill', (-1.8, -0.4, 0.8), 220, size=2.4, colour=(0.82, 0.88, 1.0, 1))
area_light('FANG rim', (1.6, -1.4, 2.0), 260, size=1.6, colour=(1.0, 0.94, 0.86, 1))

cam_data = bpy.data.cameras.new('FANG camera')
cam = bpy.data.objects.new('FANG camera', cam_data)
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

print('FANG-RENDER-DONE')
