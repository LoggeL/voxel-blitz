#!/usr/bin/env python3
"""Render proof shots of the GRENADES study: every type from three angles
plus one line-up of all five at a common scale.

Usage:
    blender --background --factory-startup docs/design/blender/grenades/grenades.blend \\
        --python tools/blender/grenades/render-grenades.py

Writes docs/design/blender/grenades/render-<type>-{hero,rear,front}.png and
render-lineup.png. Cycles on the CPU (no Metal compilation on a shared box).
"""
import bpy
import sys
from pathlib import Path
from mathutils import Matrix, Vector

DOCS = None
for arg in sys.argv:
    if arg.endswith('grenades.blend'):
        DOCS = Path(arg).parent
if DOCS is None:
    DOCS = Path(__file__).resolve().parents[3] / 'docs/design/blender/grenades'

GROUPS = ['frag', 'limpet', 'pulse', 'molotov', 'smoke']
scene = (bpy.data.scenes.get('GRENADES | Voxel Blitz throwables study')
         or next(s for s in bpy.data.scenes if s.name.startswith('GRENADES')))
bpy.context.window.scene = scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 48
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x, scene.render.resolution_y = 900, 900
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'

rig = bpy.data.collections.new('GRENADES render rig')
scene.collection.children.link(rig)


def aim(obj, loc, target, up=(0, 1, 0)):
    """Look-at that keeps the held frame's +y on screen (a TRACK_TO would roll)."""
    forward = (Vector(target) - Vector(loc)).normalized()
    right = forward.cross(Vector(up)).normalized()
    real_up = right.cross(forward).normalized()
    obj.matrix_world = Matrix((right.to_tuple() + (0,), real_up.to_tuple() + (0,),
                               (-forward).to_tuple() + (0,), tuple(loc) + (1,))).transposed()


def area_light(name, location, energy, size=0.6, colour=(1, 1, 1)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.size = size
    data.color = colour
    obj = bpy.data.objects.new(name, data)
    rig.objects.link(obj)
    aim(obj, location, (0, 0.02, 0))
    return obj


area_light('GRENADES key', (0.40, 0.55, 0.42), 55)
area_light('GRENADES fill', (-0.45, 0.18, 0.35), 18, size=0.9, colour=(0.82, 0.88, 1.0))
area_light('GRENADES rim', (0.12, 0.35, -0.55), 26, size=0.5, colour=(1.0, 0.94, 0.86))
camera_data = bpy.data.cameras.new('GRENADES camera')
camera_data.lens = 60
camera = bpy.data.objects.new('GRENADES camera', camera_data)
rig.objects.link(camera)
scene.camera = camera

objects = {group: [o for o in scene.objects if o.get('part') == group] for group in GROUPS}
CENTRE = {'frag': (0, 0.012, 0), 'limpet': (0, 0, -0.004), 'pulse': (0, 0.012, 0),
          'molotov': (0, 0.112, 0), 'smoke': (0, 0.014, 0)}
DISTANCE = {'frag': 0.42, 'limpet': 0.48, 'pulse': 0.46, 'molotov': 0.86, 'smoke': 0.44}
VIEWS = {'hero': (1.0, 0.75, 1.1), 'rear': (-1.0, 0.55, -1.0), 'front': (0.12, 0.30, 1.3)}

for group in GROUPS:
    for other in GROUPS:
        for obj in objects[other]:
            obj.hide_render = other != group
    for view, direction in VIEWS.items():
        if group == 'limpet' and view == 'rear':
            direction = (-0.9, 0.5, -1.1)   # the wall side: magnet plate and feet
        location = Vector(direction).normalized() * DISTANCE[group] + Vector(CENTRE[group])
        aim(camera, tuple(location), CENTRE[group])
        scene.render.filepath = str(DOCS / f'render-{group}-{view}.png')
        bpy.ops.render.render(write_still=True)
        print(f'RENDER_SAVED render-{group}-{view}.png')

# Line-up: all five side by side at the same scale (spacing 0.24 m).
for group in GROUPS:
    for obj in objects[group]:
        obj.hide_render = False
spacing = 0.24
for index, group in enumerate(GROUPS):
    shift = Vector(((index - 2) * spacing, 0, 0))
    for obj in objects[group]:
        obj.location = obj.location + shift
scene.render.resolution_x, scene.render.resolution_y = 1800, 700
aim(camera, (0.15, 0.55, 1.75), (0, 0.06, 0))
camera_data.lens = 50
scene.render.filepath = str(DOCS / 'render-lineup.png')
bpy.ops.render.render(write_still=True)
print('RENDER_SAVED render-lineup.png')
for index, group in enumerate(GROUPS):
    shift = Vector(((index - 2) * spacing, 0, 0))
    for obj in objects[group]:
        obj.location = obj.location - shift
print('GRENADES-RENDER-DONE')
