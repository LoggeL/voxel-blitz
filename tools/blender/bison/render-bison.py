#!/usr/bin/env python3
"""Render hero/side/ads/rear proof shots of the BISON study.

Usage:
    blender --background --factory-startup docs/design/blender/bison/bison.blend \\
        --python tools/blender/bison/render-bison.py
"""
import bpy
import sys
from mathutils import Vector

DOCS = None
for arg in sys.argv:
    if arg.endswith('bison.blend'):
        from pathlib import Path
        DOCS = Path(arg).parent
if DOCS is None:
    from pathlib import Path
    DOCS = Path('/Users/logge/Documents/Projects/voxel-blitz/docs/design/blender/bison')

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
    'hero': ((1.55, -1.25, 0.85), (0.0, 0.21, 0.05), 55),
    'side': ((3.0, 0.21, 0.06), (0.0, 0.21, 0.06), 80),
    'left': ((-3.0, 0.21, 0.06), (0.0, 0.21, 0.06), 80),
    'ads': ((0.0, -0.75, 0.24), (0.0, 0.50, 0.19), 45),
    'rear': ((-1.4, -1.1, 0.7), (0.0, 0.10, 0.05), 55),
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


area_light('BISON key', (2.2, 1.6, 2.4), 900)
area_light('BISON fill', (-2.4, -0.6, 1.1), 320, size=2.4, colour=(0.82, 0.88, 1.0, 1))
area_light('BISON rim', (-0.9, -2.2, 1.8), 420, size=1.6, colour=(1.0, 0.94, 0.86, 1))

cam_data = bpy.data.cameras.new('BISON camera')
cam = bpy.data.objects.new('BISON camera', cam_data)
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

print('BISON-RENDER-DONE')
