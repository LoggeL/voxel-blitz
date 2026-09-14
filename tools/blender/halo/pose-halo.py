#!/usr/bin/env python3
"""Articulation proof shots of the HALO study.

Moves ONLY the animation node empties (`bolt`, `mag`) the game choreography
owns -- never geometry -- and renders the three frames the final acceptance
needs, under the study lighting (same 3 area lights as render-halo.py):

  pose-bolt-back.png  bolt empty -0.11 on Y (authoring rearward). Game space
                      bolt.position.z = +travel with boltTravel 0.11
                      (defs.js longarc); game +z maps to authoring -Y.
  pose-mag-out.png    mag empty (0, -0.05, -0.12): down + slightly rearward,
                      the dominant axes of the game mag-swap exit vector
                      (-0.30, -1.32, 0.76) -> authoring (-0.30, -0.76, -1.32),
                      scaled to ~0.12 so the dropped cell stays framed and
                      the well gap reads. X zeroed for profile legibility.
  pose-home.png       both nodes at identity (closed / home), hero framing to
                      match render-hero.png.

Usage:
    blender --background --factory-startup docs/design/blender/halo/halo.blend \
        --python tools/blender/halo/pose-halo.py
"""
import bpy
import sys
from mathutils import Vector

DOCS = None
for arg in sys.argv:
    if arg.endswith('halo.blend'):
        from pathlib import Path
        DOCS = Path(arg).parent
if DOCS is None:
    from pathlib import Path
    DOCS = Path('/Users/logge/Documents/Projects/voxel-blitz/docs/design/blender/halo')

BOLT_TRAVEL = 0.11  # defs.js longarc boltTravel: capacitor sled throw (m)

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 40
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'

bolt = bpy.data.objects.get('bolt')
mag = bpy.data.objects.get('mag')
if bolt is None or mag is None:
    raise RuntimeError('pose-halo: bolt/mag animation nodes missing from halo.blend')

# Node transforms only: geometry stays exactly as authored.
bolt.location = (0.0, 0.0, 0.0)
mag.location = (0.0, 0.0, 0.0)


def area_light(name, location, energy, size=1.4, colour=(1, 1, 1, 1)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.size = size
    data.color = colour[:3]
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    scene.collection.objects.link(obj)
    return obj


area_light('HALO key', (2.2, 1.6, 2.4), 900)
area_light('HALO fill', (-2.4, -0.6, 1.1), 320, size=2.4, colour=(0.82, 0.88, 1.0, 1))
area_light('HALO rim', (-0.9, -2.2, 1.8), 420, size=1.6, colour=(1.0, 0.94, 0.86, 1))

cam_data = bpy.data.cameras.new('HALO pose camera')
cam = bpy.data.objects.new('HALO pose camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

# name: (bolt loc, mag loc, camera pos, look-at, lens)
FRAMES = {
    'pose-bolt-back': (
        (0.0, -BOLT_TRAVEL, 0.0), (0.0, 0.0, 0.0),
        (3.0, 0.21, 0.06), (0.0, 0.10, 0.06), 80,
    ),
    'pose-mag-out': (
        (0.0, 0.0, 0.0), (0.0, -0.05, -0.12),
        (2.1, -1.55, 0.50), (0.0, 0.08, -0.06), 50,
    ),
    'pose-home': (
        (0.0, 0.0, 0.0), (0.0, 0.0, 0.0),
        (1.55, -1.25, 0.85), (0.0, 0.21, 0.05), 55,
    ),
}

for name, (bolt_loc, mag_loc, pos, target, lens) in FRAMES.items():
    bolt.location = Vector(bolt_loc)
    mag.location = Vector(mag_loc)
    bpy.context.view_layer.update()
    cam.location = Vector(pos)
    direction = Vector(target) - Vector(pos)
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    cam_data.lens = lens
    scene.render.filepath = str(DOCS / f'{name}.png')
    bpy.ops.render.render(write_still=True)
    print(f'POSE_SAVED {name}.png bolt={tuple(bolt_loc)} mag={tuple(mag_loc)}')

bolt.location = (0.0, 0.0, 0.0)
mag.location = (0.0, 0.0, 0.0)
print('HALO-POSE-DONE')
