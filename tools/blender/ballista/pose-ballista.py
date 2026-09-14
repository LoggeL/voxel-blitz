#!/usr/bin/env python3
"""BALLISTA articulation proof frames (final acceptance).

Headless use:
    blender --background --factory-startup docs/design/blender/ballista/ballista.blend \\
        --python tools/blender/ballista/pose-ballista.py

Moves ONLY animation-group node transforms (the `bolt` / `mag` empties that
parent the batched delivery meshes), never geometry / materials / UVs.

Game mapping (public/js/guns/defs.js + actions.js, sniper slot):
- boltTravel 0.16, cycleKind 'bolt'. Stripper reload drives
  model.bolt.position.z = boltTravel * open (game +Z = rearward, toward the
  shooter) with model.bolt.rotation.z = 0.5 * open lift.
- Authoring space is +Y forward / +Z up, game_z = -y. Rearward in game (+Z)
  is therefore -Y in authoring: bolt open = bolt.location.y -= 0.16.
- The game roll about its rearward Z axis reads in authoring as a roll about
  the forward Y axis: bolt.rotation_euler.y = +0.5 lifts the left-side handle
  knob (+X-negative arm) upward (+Z). Pure slide would also satisfy the
  contract; the lift matches the shipped stripper choreography.
- Mag drop is an articulation proof pose (stripper reloads keep the mag
  seated in game): mag.location.z -= 0.08 (80 mm straight down) with a
  15-degree nose-forward tip about the lateral X axis so the drop reads.

Frames (one shared left-quarter camera + study lighting, so before/after
compares cleanly):
1. pose-home.png      — identity (closed / home, control frame)
2. pose-bolt-open.png — bolt at full 0.16 throw + 0.5 rad lift
3. pose-mag-drop.png  — mag dropped 80 mm + 15 deg tilt
"""
import bpy
import math
import sys
from mathutils import Vector
from pathlib import Path

DOCS = None
for arg in sys.argv:
    if arg.endswith('ballista.blend'):
        DOCS = Path(arg).parent
if DOCS is None:
    DOCS = Path('/Users/logge/Documents/Projects/voxel-blitz/docs/design/blender/ballista')

STUDY_SCENE = 'BALLISTA | Voxel Blitz sniper study'
scene = bpy.data.scenes.get(STUDY_SCENE) or bpy.context.scene
bpy.context.window.scene = scene

scene.render.engine = 'CYCLES'
scene.cycles.samples = 40
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'

# Study lighting: identical rig to render-ballista.py so the articulation
# frames compare 1:1 with the five delivered angles.
def area_light(name, location, energy, size=1.4, colour=(1, 1, 1, 1)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.size = size
    data.color = colour[:3]
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    scene.collection.objects.link(obj)
    return obj

area_light('BALLISTA pose key', (2.2, 1.6, 2.4), 900)
area_light('BALLISTA pose fill', (-2.4, -0.6, 1.1), 320, size=2.4,
           colour=(0.82, 0.88, 1.0, 1))
area_light('BALLISTA pose rim', (-0.9, -2.2, 1.8), 420, size=1.6,
           colour=(1.0, 0.94, 0.86, 1))

cam_data = bpy.data.cameras.new('BALLISTA pose camera')
cam = bpy.data.objects.new('BALLISTA pose camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

# Left-quarter 3/4: bolt lives on the left flank (x < 0), mag hangs below the
# receiver — one camera shows both articulations without view-selection bias.
POS = Vector((-1.9, -1.25, 0.85))
TARGET = Vector((0.0, 0.12, 0.0))
cam.location = POS
cam.rotation_euler = (TARGET - POS).to_track_quat('-Z', 'Y').to_euler()
cam_data.lens = 50

bolt = bpy.data.objects.get('bolt')
mag = bpy.data.objects.get('mag')
assert bolt is not None, 'bolt node missing from ballista.blend'
assert mag is not None, 'mag node missing from ballista.blend'
for node in (bolt, mag):
    assert node.type == 'EMPTY', f'{node.name} must stay an EMPTY node, got {node.type}'
assert bolt.parent is None and mag.parent is None, 'anim nodes must be unparented'

BOLT_THROW = 0.16   # defs.js sniper boltTravel
BOLT_LIFT = 0.5     # actions.js stripper reload bolt rotation.z at full open
MAG_DROP = 0.08     # 80 mm straight down
MAG_TILT = math.radians(15.0)

def content_pivot(node):
    """World-space bounding-box centre of a node's mesh descendants (read-only)."""
    lo, hi = Vector((1e9, 1e9, 1e9)), Vector((-1e9, -1e9, -1e9))

    def visit(obj):
        nonlocal lo, hi
        if obj.type == 'MESH':
            for corner in obj.bound_box:
                world = obj.matrix_world @ Vector(corner)
                lo = Vector((min(a, b) for a, b in zip(lo, world)))
                hi = Vector((max(a, b) for a, b in zip(hi, world)))
        for child in obj.children:
            visit(child)

    visit(node)
    assert hi.x > lo.x, f'{node.name} has no mesh descendants'
    return (lo + hi) * 0.5


def pose_node(node, drop, euler_xyz):
    """Slide the node by `drop` plus an in-place roll about its own content.

    The anim empties sit at the world origin, far from their meshes, so a raw
    rotation would swing the content in a wide arc (a 15-degree mag tilt about
    the origin lifts the mag 60 mm, cancelling most of the 80 mm drop).
    location = pivot - R*pivot + drop keeps the requested drop exact while the
    tilt spins about the content centre. Node transforms only; no mesh edits.
    """
    from mathutils import Euler
    pivot = content_pivot(node)
    rot = Euler(euler_xyz, 'XYZ').to_matrix().to_4x4()
    node.location = pivot - (rot @ pivot) + Vector(drop)
    node.rotation_euler = euler_xyz


def set_home():
    for node in (bolt, mag):
        node.location = (0.0, 0.0, 0.0)
        node.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()


bpy.context.view_layer.update()
HOME_PIVOTS = {node.name: tuple(round(v, 5) for v in content_pivot(node))
               for node in (bolt, mag)}
print(f'PIVOTS {HOME_PIVOTS}')

FRAMES = (
    ('pose-home.png', lambda: None),
    ('pose-bolt-open.png', lambda: pose_node(bolt, (0.0, -BOLT_THROW, 0.0),
                                             (0.0, BOLT_LIFT, 0.0))),
    ('pose-mag-drop.png', lambda: pose_node(mag, (0.0, 0.0, -MAG_DROP),
                                            (MAG_TILT, 0.0, 0.0))),
)

for filename, pose in FRAMES:
    set_home()
    pose()
    bpy.context.view_layer.update()
    # Proof that only node transforms moved: mesh datablocks untouched.
    scene.render.filepath = str(DOCS / filename)
    bpy.ops.render.render(write_still=True)
    print(f'POSE_SAVED {filename} '
          f'bolt_loc={tuple(round(v, 4) for v in bolt.location)} '
          f'bolt_rot={tuple(round(v, 4) for v in bolt.rotation_euler)} '
          f'mag_loc={tuple(round(v, 4) for v in mag.location)} '
          f'mag_rot={tuple(round(v, 4) for v in mag.rotation_euler)}')

set_home()
print('BALLISTA-POSE-DONE')
