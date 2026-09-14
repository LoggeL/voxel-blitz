#!/usr/bin/env python3
"""Articulation proof shots of the WASP study (pose-only, no geometry edits).

Usage:
    blender --background --factory-startup docs/design/blender/wasp/wasp.blend \\
        --python tools/blender/wasp/pose-wasp.py

Moves ONLY the animation group node transforms (the `body` / `mag` / `bolt` /
`trigger` / `extra` empties that become the GLB animation nodes), never mesh
geometry. Renders three articulation frames with the study lighting:

  1. pose-bolt.png — bolt fully back: -Y by TIMERS.smg.boltTravel (0.06 m).
     Game +Z (rearward) maps to authoring -Y (game_z = -y).
  2. pose-mag.png — magazine stuck out/down with a slight forward tip, the
     mag-type reload path (the SMG slot moves the mag group itself).
  3. pose-home.png — home/closed: every group node at identity.

The .blend source is never saved; this script only renders PNGs next to it.
"""
import bpy
import sys
from mathutils import Vector
from pathlib import Path

DOCS = None
for arg in sys.argv:
    if arg.endswith('wasp.blend'):
        DOCS = Path(arg).parent
if DOCS is None:
    DOCS = Path('/Users/logge/Documents/Projects/voxel-blitz/docs/design/blender/wasp')

# Study lighting + framing (mirrors render-wasp.py): one consistent LEFT-side
# 3/4 angle for all three frames so they compare directly. Side-dominant so
# the bolt stroke (along Y) reads horizontally and the mag drop (along -Z)
# reads vertically; the bolt handle lives on -X.
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 40
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'

# TIMERS.smg.boltTravel (public/js/guns/defs.js) — the full per-shot / reload
# bolt stroke the runtime applies as model.bolt.position.z = travel.
BOLT_TRAVEL = 0.06
POS = (-1.70, -0.55, 0.28)
TARGET = (0.0, 0.03, -0.02)
LENS = 60


def area_light(name, location, energy, size=1.4, colour=(1, 1, 1, 1)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.size = size
    data.color = colour[:3]
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    scene.collection.objects.link(obj)
    return obj


area_light('WASP pose key', (2.2, 1.6, 2.4), 900)
area_light('WASP pose fill', (-2.4, -0.6, 1.1), 320, size=2.4,
           colour=(0.82, 0.88, 1.0, 1))
area_light('WASP pose rim', (-0.9, -2.2, 1.8), 420, size=1.6,
           colour=(1.0, 0.94, 0.86, 1))

cam_data = bpy.data.cameras.new('WASP pose camera')
cam = bpy.data.objects.new('WASP pose camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

cam.location = Vector(POS)
cam.rotation_euler = (Vector(TARGET) - Vector(POS)).to_track_quat('-Z', 'Y').to_euler()
cam_data.lens = LENS

GROUPS = ('body', 'mag', 'bolt', 'trigger', 'extra')
nodes = {}
for name in GROUPS:
    obj = bpy.data.objects.get(name)
    if obj is None:
        raise RuntimeError(f'animation node missing from blend: {name!r}')
    nodes[name] = obj

# (frame name, {node: (location, rotation_euler)})
POSES = [
    ('pose-bolt', {
        'bolt': ((0.0, -BOLT_TRAVEL, 0.0), (0.0, 0.0, 0.0)),
    }),
    ('pose-mag', {
        # Stick the mag out/down with a slight forward tip + cant so the
        # separation from the magwell reads at a glance; kept compact so the
        # mag stays in frame (the runtime first-person path is deliberately
        # exaggerated and would throw the mag out of the shot).
        'mag': ((0.0, 0.035, -0.10), (0.25, 0.0, -0.12)),
    }),
    ('pose-home', {}),
]

for frame, moves in POSES:
    for name in GROUPS:
        nodes[name].location = (0.0, 0.0, 0.0)
        nodes[name].rotation_euler = (0.0, 0.0, 0.0)
    for name, (loc, rot) in moves.items():
        nodes[name].location = loc
        nodes[name].rotation_euler = rot
    bpy.context.view_layer.update()
    scene.render.filepath = str(DOCS / f'{frame}.png')
    bpy.ops.render.render(write_still=True)
    print(f'POSE_SAVED {frame}.png bolt={tuple(nodes["bolt"].location)} '
          f'mag={tuple(nodes["mag"].location)}')

# Leave the in-memory scene parked at home; the .blend file itself is untouched.
for name in GROUPS:
    nodes[name].location = (0.0, 0.0, 0.0)
    nodes[name].rotation_euler = (0.0, 0.0, 0.0)

print('WASP-POSE-DONE')
