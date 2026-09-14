#!/usr/bin/env python3
"""Render hero/side/left/ads/rear proof shots of the KESTREL revision 2 study.

Usage:
    blender --background --factory-startup docs/design/blender/kestrel/kestrel.blend \\
        --python tools/blender/kestrel/render-kestrel.py

Environment (review loops):
    KESTREL_ENGINE=BLENDER_EEVEE   quick look instead of Cycles
    KESTREL_VIEWS=hero,top         subset of the views
    KESTREL_OUT=/some/dir          write elsewhere than docs/design/blender/kestrel
    KESTREL_SAMPLES=16             Cycles sample count (default 48)
"""
import bpy
import os
import sys
from pathlib import Path
from mathutils import Vector

DOCS = None
for arg in sys.argv:
    if arg.endswith('kestrel.blend'):
        DOCS = Path(arg).parent
if DOCS is None:
    DOCS = Path(__file__).resolve().parents[3] / 'docs/design/blender/kestrel'
OUT = Path(os.environ.get('KESTREL_OUT', str(DOCS)))
OUT.mkdir(parents=True, exist_ok=True)

scene = next((s for s in bpy.data.scenes if s.name.startswith('KESTREL')), bpy.context.scene)
bpy.context.window.scene = scene if bpy.context.window else None
engine = os.environ.get('KESTREL_ENGINE', 'CYCLES')
scene.render.engine = engine
if engine == 'CYCLES':
    scene.cycles.samples = int(os.environ.get('KESTREL_SAMPLES', '48'))
    scene.cycles.use_denoising = True
    scene.cycles.device = 'CPU'
else:
    scene.eevee.taa_render_samples = 32
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.film_transparent = False

VIEWS = {
    # name: (camera pos, look-at, lens)
    'hero': ((1.15, 0.95, 0.60), (0.0, 0.14, 0.04), 55),
    'side': ((2.6, 0.13, 0.05), (0.0, 0.13, 0.05), 85),
    'left': ((-2.6, 0.13, 0.05), (0.0, 0.13, 0.05), 85),
    'ads': ((0.0, -0.62, 0.20), (0.0, 0.30, 0.140), 50),
    'rear': ((-1.05, -0.95, 0.55), (0.0, 0.06, 0.03), 55),
    'top': ((0.0, 0.13, 2.4), (0.0, 0.13, 0.0), 85),
    'front': ((0.25, 1.6, 0.30), (-0.01, 0.30, 0.05), 70),
}
wanted = os.environ.get('KESTREL_VIEWS')
views = wanted.split(',') if wanted else ['hero', 'side', 'left', 'ads', 'rear']


def area_light(name, location, energy, size=1.4, colour=(1, 1, 1, 1)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.size = size
    data.color = colour[:3]
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    scene.collection.objects.link(obj)
    return obj


area_light('KESTREL key', (2.0, 1.4, 2.2), 800)
area_light('KESTREL fill', (-2.2, -0.5, 1.0), 300, size=2.4, colour=(0.82, 0.88, 1.0, 1))
area_light('KESTREL rim', (-0.8, -2.0, 1.6), 400, size=1.6, colour=(1.0, 0.94, 0.86, 1))

cam_data = bpy.data.cameras.new('KESTREL camera')
cam = bpy.data.objects.new('KESTREL camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

for name in views:
    (pos, target, lens) = VIEWS[name]
    cam.location = Vector(pos)
    direction = Vector(target) - Vector(pos)
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    cam_data.lens = lens
    scene.render.filepath = str(OUT / f'render-{name}.png')
    bpy.ops.render.render(write_still=True)
    print(f'RENDER_SAVED render-{name}.png')

print('KESTREL-RENDER-DONE')
