#!/usr/bin/env python3
"""Articulation frames for the FANG revolver study (pose-only, no geometry edits).

Moves ONLY animation-group node transforms (mag = swing-out cylinder assembly,
bolt = spur hammer), mirroring the runtime revolver choreography in
public/js/guns/actions.js (_updateCylinderReload: crane.rotation.z = PI/2*open;
jerk: hammer.rotation.x up to 0.65) and public/js/guns/models/revolver.js
(crane hinge below the cylinder, bore-parallel; hammer rotates about its pin).

Authoring space: +Y forward (bore), +Z up, +X right. Game mapping:
game_x = x, game_y = z, game_z = -y.

  - crane.rotation.z (game, about the bore axis) -> rotation about authoring Y
    through the crane hinge line (x=0, z=0.005, parallel to Y). -90 degrees
    swings the cylinder out to the left (-X), matching the game swing.
  - hammer.rotation.x = +0.65 (game) -> rotation about authoring X through the
    hammer pin (0, 0.018, 0.030); game X and authoring X are the same axis.

Both empties rest at the origin, so each articulation is a pivot-compensated
transform: location = pivot - R*pivot, rotation = R. Geometry is untouched and
the .blend is never saved, so the shipped source stays at identity.

Frames:
  1. pose-open.png    cylinder swung open + hammer cocked (reload pose)
  2. pose-closed.png  closed / carry (identity proof)
  3. pose-ejector.png tight rear-left view of the open cylinder: chamber mouths,
     ejector star region and rod tip. The rod is merged into the mag batches,
     so it cannot travel on its own node; this frame proves it is modeled.

Usage:
    blender --background --factory-startup docs/design/blender/fang/fang.blend \
        --python tools/blender/fang/pose-fang.py
"""
import math
import sys
from pathlib import Path

import bpy
from mathutils import Euler, Matrix, Vector

DOCS = None
for arg in sys.argv:
    if arg.endswith('fang.blend'):
        DOCS = Path(arg).parent
if DOCS is None:
    DOCS = Path('/Users/logge/Documents/Projects/voxel-blitz/docs/design/blender/fang')

# --- pivots, authoring space -------------------------------------------------
CRANE_HINGE = Vector((0.0, 0.0, 0.005))   # bore-parallel hinge under the cylinder
HAMMER_PIN = Vector((0.0, 0.018, 0.030))  # bolt home: hammer pin
COCK_ANGLE = 0.65                          # game hammer.rotation.x at full cock


def pose_about(empty, axis, angle, pivot):
    """Rotate `empty` about `axis` through `pivot` (node transform only)."""
    rot = Matrix.Rotation(angle, 4, axis)
    empty.rotation_euler = rot.to_euler('XYZ')
    empty.location = pivot - (rot @ pivot)


def set_open_cocked():
    mag = bpy.data.objects['mag']
    bolt = bpy.data.objects['bolt']
    pose_about(mag, 'Y', math.radians(-90.0), CRANE_HINGE)
    pose_about(bolt, 'X', COCK_ANGLE, HAMMER_PIN)


def set_identity():
    for name in ('body', 'mag', 'bolt', 'trigger', 'extra'):
        obj = bpy.data.objects.get(name)
        if obj is not None:
            obj.location = (0.0, 0.0, 0.0)
            obj.rotation_euler = (0.0, 0.0, 0.0)
            obj.scale = (1.0, 1.0, 1.0)


# --- study lighting (same rig as render-fang.py) ------------------------------
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


area_light('FANG pose key', (1.6, 1.1, 1.8), 700)
area_light('FANG pose fill', (-1.8, -0.4, 0.8), 220, size=2.4, colour=(0.82, 0.88, 1.0, 1))
area_light('FANG pose rim', (1.6, -1.4, 2.0), 260, size=1.6, colour=(1.0, 0.94, 0.86, 1))

cam_data = bpy.data.cameras.new('FANG pose camera')
cam = bpy.data.objects.new('FANG pose camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam


def shoot(filename, pos, target, lens):
    cam.location = Vector(pos)
    direction = Vector(target) - Vector(pos)
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    cam_data.lens = lens
    scene.render.filepath = str(DOCS / filename)
    bpy.ops.render.render(write_still=True)
    print(f'POSE_SAVED {filename}')


# Frame 1: swung open + cocked, front-left three-quarter.
set_open_cocked()
shoot('pose-open.png', (-0.85, 0.55, 0.45), (-0.01, 0.12, 0.02), 55)

# Frame 2: closed / carry, left three-quarter (cylinder flank).
set_identity()
bpy.context.view_layer.update()
shoot('pose-closed.png', (-1.00, -0.35, 0.35), (0.0, 0.15, 0.02), 55)

# Frame 3: ejector detail — open pose, tight rear-left close-up on the swung
# cylinder (chamber mouths) and the underlug rod tip.
set_open_cocked()
bpy.context.view_layer.update()
shoot('pose-ejector.png', (-0.38, -0.18, 0.20), (-0.016, 0.12, 0.01), 70)

# Leave the session at identity; the file on disk is never saved.
set_identity()
bpy.context.view_layer.update()
print('FANG-POSE-DONE')
