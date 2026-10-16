#!/usr/bin/env python3
"""Render TORCH articulation frames (node transforms only, never geometry).

Usage:
    blender --background --factory-startup docs/design/blender/torch/torch.blend \
        --python tools/blender/torch/pose-torch.py

The transforms mirror the runtime choreography:
  - `pose-home.png`: gate closed, round seated in the mouth, lever at home.
  - `pose-gate-open.png`: breech gate swung open 1.75 rad about the vertical
    left-flank hinge pin, round ejected/hidden to reveal the open breech throat.
  - `pose-lever-back.png`: right-flank arming lever stroked +0.55 rad.
  - `pose-reload.png`: breech gate open 1.75 rad, lever stroked, and the
    authored fin-stabilized HAVOC rocket round entering the open breech throat
    along the bore axis (matching Concept A's reload inset).
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

HINGE = Vector((-0.104, 0.135, 0.075))   # authoring-space gate pivot (vertical pin)
ROUND_SEAT = Vector((0.0, 0.550, 0.075)) # authoring-space seated round origin
GATE_SWING = 1.75                        # rad; runtime gate.rotation.y = -GATE_SWING * open
LEVER_STROKE = 0.55                      # rad about the gun origin

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


area_light('TORCH key', (2.2, 1.6, 2.4), 900)
area_light('TORCH fill', (-2.4, -0.6, 1.1), 320, size=2.4, colour=(0.82, 0.88, 1.0, 1))
area_light('TORCH rim', (-2.6, -0.9, 0.7), 250, size=1.6, colour=(1.0, 0.94, 0.86, 1))

cam_data = bpy.data.cameras.new('TORCH pose camera')
cam = bpy.data.objects.new('TORCH pose camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

gate_parts = [o for o in scene.objects
              if o.get('part') == 'extra' and o.get('extra_role', 'gate') == 'gate']
round_parts = [o for o in scene.objects
               if o.get('part') == 'extra' and o.get('extra_role') == 'round']
bolt_parts = [o for o in scene.objects if o.get('part') == 'bolt']
if not gate_parts or not bolt_parts or not round_parts:
    raise SystemExit('pose-torch needs the authored gate, round, and bolt source parts of torch.blend')


def reset_nodes():
    for obj in gate_parts + round_parts + bolt_parts:
        obj.matrix_world = Matrix.Identity(4)
        obj.hide_render = False
    bpy.context.view_layer.update()


def pose_gate(open_amount):
    """Swing the gate sideways about the vertical hinge line."""
    swing = Matrix.Rotation(-GATE_SWING * open_amount, 4, 'Z')
    matrix = Matrix.Translation(HINGE) @ swing @ Matrix.Translation(-HINGE)
    for obj in gate_parts:
        obj.matrix_world = matrix


def pose_round(mode):
    """Pose the authored HAVOC rocket round ('seated', 'hidden', or 'entering')."""
    if mode == 'hidden':
        for obj in round_parts:
            obj.hide_render = True
    elif mode == 'entering':
        # Shift the round back by 0.56 m along -Y so its nose enters the open breech
        matrix = Matrix.Translation(Vector((0.0, -0.560, 0.0)))
        for obj in round_parts:
            obj.hide_render = False
            obj.matrix_world = matrix
    else:
        for obj in round_parts:
            obj.hide_render = False
            obj.matrix_world = Matrix.Identity(4)


def pose_lever(stroke):
    """Rotate the arming lever group about the gun origin."""
    matrix = Matrix.Rotation(LEVER_STROKE * stroke, 4, 'X')
    for obj in bolt_parts:
        obj.matrix_world = matrix


def frame_camera(pos, target, lens):
    cam.location = Vector(pos)
    direction = Vector(target) - Vector(pos)
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    cam_data.lens = lens


# (name, gate open, round mode, lever stroke, camera pos, look-at, lens)
POSES = [
    ('pose-home', 0.0, 'seated', 0.0,
     (-0.85, -0.95, 0.55), (0.0, 0.18, 0.04), 58),
    ('pose-gate-open', 1.0, 'hidden', 0.0,
     (-0.95, -0.85, 0.55), (-0.08, 0.10, 0.04), 58),
    ('pose-lever-back', 0.0, 'seated', 1.0,
     (0.55, 0.04, 0.027), (0.09, 0.04, 0.027), 100),
    ('pose-reload', 1.0, 'entering', 1.0,
     (-1.05, -0.95, 0.48), (-0.04, 0.02, 0.06), 54),
]

for (name, gate, round_mode, lever, pos, target, lens) in POSES:
    reset_nodes()
    if gate:
        pose_gate(gate)
    pose_round(round_mode)
    if lever:
        pose_lever(lever)
    frame_camera(pos, target, lens)
    scene.render.filepath = str(DOCS / f'{name}.png')
    bpy.ops.render.render(write_still=True)
    print(f'POSE_SAVED {name}.png gate_open={gate} round={round_mode} lever_stroke={lever}')

reset_nodes()
print('TORCH-POSE-DONE')
