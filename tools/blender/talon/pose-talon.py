#!/usr/bin/env python3
"""Render TALON handling close-ups (no articulation possible).

The knife slot never reloads, cycles or feeds cartridges: mag / bolt /
trigger / extra export as empty identity nodes (see build-talon.py). There
is no game animation to articulate, so this script moves NO node transforms
and touches NO geometry -- it only re-frames the camera with the study
lighting to capture three handling details:

    pose-edge.png   -- cutting-edge / fuller / marking close-up, mid-blade
    pose-top.png    -- top-down alignment (blade, guard oval, handle centreline)
    pose-pommel.png -- pommel stack detail (ring, cap, boot, lanyard)

Usage:
    blender --background --factory-startup docs/design/blender/talon/talon.blend \
        --python tools/blender/talon/pose-talon.py
"""
import bpy
import sys
from mathutils import Vector
from pathlib import Path

DOCS = None
for arg in sys.argv:
    if arg.endswith('talon.blend'):
        DOCS = Path(arg).parent
if DOCS is None:
    DOCS = Path('/Users/logge/Documents/Projects/voxel-blitz/docs/design/blender/talon')

# --- no-articulation guard ---------------------------------------------------
# mag / bolt / trigger / extra must stay empty identity nodes; body carries
# all knife geometry. Fail loudly if anything drifted.
for node in ('mag', 'bolt', 'trigger', 'extra'):
    obj = bpy.data.objects.get(node)
    assert obj is not None, f'articulation node missing: {node}'
    assert obj.type == 'EMPTY', f'{node} must stay EMPTY, got {obj.type}'
    assert obj.location.length < 1e-6, f'{node} must stay at identity, got {obj.location}'
    assert Vector(obj.rotation_euler).length < 1e-6, f'{node} must stay unrotated'
    assert (Vector(obj.scale) - Vector((1, 1, 1))).length < 1e-6, f'{node} scale drift'
body = bpy.data.objects.get('body')
assert body is not None, 'body node missing'
print('POSE-GUARD-OK mag/bolt/trigger/extra empty at identity; geometry untouched')

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 40
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'

VIEWS = {
    # edge: macro on the right flat / edge bevel / TALON marking, mid-blade
    'pose-edge': ((0.30, -0.06, 0.11), (0.0, 0.22, 0.002), 60),
    # top: straight down the spine, blade + guard oval + handle centreline
    'pose-top': ((0.01, 0.14, 1.38), (0.01, 0.14, -0.12), 50),
    # pommel: close-up on ring / cap / boot / lanyard loop at the butt
    'pose-pommel': ((0.33, -0.30, -0.11), (0.01, 0.028, -0.28), 60),
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


# Study lighting, same rig as render-talon.py
area_light('TALON key', (2.2, 1.6, 2.4), 900)
area_light('TALON fill', (-2.4, -0.6, 1.1), 320, size=2.4, colour=(0.82, 0.88, 1.0, 1))
area_light('TALON rim', (-0.9, -2.2, 1.8), 420, size=1.6, colour=(1.0, 0.94, 0.86, 1))

cam_data = bpy.data.cameras.new('TALON pose camera')
cam = bpy.data.objects.new('TALON pose camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

for name, (pos, target, lens) in VIEWS.items():
    cam.location = Vector(pos)
    direction = Vector(target) - Vector(pos)
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    cam_data.lens = lens
    scene.render.filepath = str(DOCS / f'{name}.png')
    bpy.ops.render.render(write_still=True)
    print(f'RENDER_SAVED {name}.png')

print('TALON-POSE-DONE')
