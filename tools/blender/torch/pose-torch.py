#!/usr/bin/env python3
"""Render TORCH articulation frames (node transforms only, never geometry).

Usage:
    blender --background --factory-startup docs/design/blender/torch/torch.blend \
        --python tools/blender/torch/pose-torch.py

The transforms mirror the runtime choreography exactly (actions.js
_updateRocketReload / bolt arming stroke): the breech gate group slides 0.11
straight back and swings +0.95 rad about game X at the frozen hinge
(0, 0.075, -0.06); the arming lever rotates +0.5 rad about the gun origin.
"""
import bpy
import math
import sys
from pathlib import Path
from mathutils import Euler, Matrix, Vector

DOCS = None
for arg in sys.argv:
    if arg.endswith('torch.blend'):
        DOCS = Path(arg).parent
if DOCS is None:
    DOCS = Path(__file__).resolve().parents[3] / 'docs/design/blender/torch'

HINGE = Vector((0.000, 0.060, 0.075))   # authoring-space gate pivot
GATE_SLIDE = 0.11                        # straight back along the bore (game +z)
GATE_SWING = 0.95                        # rad about game X (= authoring X)
LEVER_STROKE = 0.5                       # rad about the gun origin

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 40
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'

# Study lighting (same values as render-torch.py).


def area_light(name, location, energy, size=1.4, colour=(1, 1, 1, 1)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.size = size
    data.color = colour[:3]
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    scene.collection.objects.link(obj)
    return obj


area_light('TORCH key', (2.2, 1.6, 2.4), 900)
area_light('TORCH fill', (-2.4, -0.6, 1.1), 320, size=2.4, colour=(0.82, 0.88, 1.0, 1))
area_light('TORCH rim', (-2.6, -0.9, 0.7), 250, size=1.6, colour=(1.0, 0.94, 0.86, 1))

cam_data = bpy.data.cameras.new('TORCH pose camera')
cam = bpy.data.objects.new('TORCH pose camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

gate_parts = [o for o in scene.objects if o.get('part') == 'extra']
bolt_parts = [o for o in scene.objects if o.get('part') == 'bolt']
if not gate_parts or not bolt_parts:
    raise SystemExit('pose-torch needs the authored source parts of torch.blend')

IDENTITY = {}


def reset_nodes():
    for obj in gate_parts + bolt_parts:
        obj.matrix_world = Matrix.Identity(4)
    bpy.context.view_layer.update()


def pose_gate(slide):
    """Slide the gate back and swing it open about the slid hinge, like the runtime."""
    pivot = HINGE + Vector((0.0, -GATE_SLIDE * slide, 0.0))
    swing = Matrix.Rotation(GATE_SWING * slide, 4, 'X')
    matrix = Matrix.Translation(pivot) @ swing @ Matrix.Translation(-pivot)
    for obj in gate_parts:
        obj.matrix_world = matrix


def pose_lever(stroke):
    """Rotate the arming lever group about the gun origin (no per-part pivot)."""
    matrix = Matrix.Rotation(LEVER_STROKE * stroke, 4, 'X')
    for obj in bolt_parts:
        obj.matrix_world = matrix


def frame_camera(pos, target, lens):
    cam.location = Vector(pos)
    direction = Vector(target) - Vector(pos)
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    cam_data.lens = lens


# (name, gate slide, lever stroke, camera pos, look-at, lens)
POSES = [
    ('pose-home', 0.0, 0.0,
     (0.85, -0.95, 0.55), (0.0, 0.18, 0.04), 58),
    ('pose-gate-open', 1.0, 0.0,
     (0.85, -0.95, 0.55), (0.0, 0.12, 0.02), 58),
    ('pose-lever-back', 0.0, 1.0,
     (0.55, 0.04, 0.027), (0.09, 0.04, 0.027), 100),
    ('pose-reload', 1.0, 1.0,
     (1.05, -1.15, 0.62), (0.0, 0.16, 0.02), 52),
]

for (name, gate, lever, pos, target, lens) in POSES:
    reset_nodes()
    if gate:
        pose_gate(gate)
    if lever:
        pose_lever(lever)
    frame_camera(pos, target, lens)
    scene.render.filepath = str(DOCS / f'{name}.png')
    bpy.ops.render.render(write_still=True)
    print(f'POSE_SAVED {name}.png gate_slide={gate} lever_stroke={lever}')

reset_nodes()
print('TORCH-POSE-DONE')
