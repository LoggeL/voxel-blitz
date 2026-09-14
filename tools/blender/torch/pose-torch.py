#!/usr/bin/env python3
"""Render TORCH articulation frames (node transforms only, never geometry).

Usage:
    blender --background --factory-startup docs/design/blender/torch/torch.blend \\
        --python tools/blender/torch/pose-torch.py

What moves (and why it is legal):
    Only the animation-group empties (bolt / trigger / mag / extra) are
    touched, exactly the nodes the runtime animates. No mesh vertex, modifier,
    material, or parent link is edited.

    Game choreography (public/js/guns/actions.js, defs.js, models/common.js):
    - _stepJerk: bolt.position.z = stroke * boltTravel (boltTravel.rocket =
      0.04, game +z is rearward) and triggerGroup.rotation.x = 0.20 * stroke.
      Authoring space maps game_z -> -y, game_x -> x, so the Blender
      equivalent is bolt.location.y = -0.04, trigger.rotation.x = 0.20.
    - _updateRocketReload: bolt.rotation.x = 0.5 * open (reload lift); gate
      rotation and round insertion live on extra, which the delivered asset
      keeps intentionally empty (build-torch.py: reload rocket is spawned
      procedurally by the runtime, extra.userData.reloadRounds).

What does NOT move (frozen by design, documented here so reviewers do not
ask for it):
    - Flip-up ladder sights: modelled erect on the shared 0.175 sight line as
      body-fixed geometry (Rear/Front sight groups parented to body). There is
      no sight node, so "folded" cannot be shown without editing geometry,
      which this script forbids. Both pose frames keep the sights erect; the
      flip articulation the runtime owns is the side arming lever + trigger.
    - Warhead/breech gate: extra is an empty node by contract. No warhead
      geometry ships, so the third frame is the reload-open lever pose from a
      rear 3/4 angle instead of a loaded-round shot.
    - mag (canister shoe): the game pins mag to body during a rocket reload
      (rocket.js: mag = body), so mag stays at identity in every frame.

Frames:
    pose-sight-up.png      identity (lever home, trigger rest), 3/4 view that
                           keeps both ladder sights and the sight line readable
    pose-lever-dropped.png fired jerk peak: bolt y -0.04, trigger rot x 0.20,
                           right-flank close-up on the arming lever + trigger
    pose-reload-open.png   reload lift: bolt rot x 0.5, rear 3/4 on the
                           venturi/breech with the lever visibly lifted

Lighting matches render-torch.py (the study lighting): CYCLES CPU, 40
samples, denoised, 1600x1000, key + fill + rim area lights.
"""
import bpy
import sys
from mathutils import Vector
from pathlib import Path

DOCS = None
for arg in sys.argv:
    if arg.endswith('torch.blend'):
        DOCS = Path(arg).parent
if DOCS is None:
    DOCS = Path('/Users/logge/Documents/Projects/voxel-blitz/docs/design/blender/torch')

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

bolt = bpy.data.objects['bolt']
trigger = bpy.data.objects['trigger']
mag = bpy.data.objects['mag']
extra = bpy.data.objects['extra']


def reset_nodes():
    for node in (bolt, trigger, mag, extra):
        node.location = (0.0, 0.0, 0.0)
        node.rotation_euler = (0.0, 0.0, 0.0)
        node.scale = (1.0, 1.0, 1.0)
    bpy.context.view_layer.update()


def frame_camera(pos, target, lens):
    cam.location = Vector(pos)
    direction = Vector(target) - Vector(pos)
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    cam_data.lens = lens


# (name, bolt_loc, bolt_rot, trigger_rot, cam_pos, cam_target, lens)
# sight-up vs lever-dropped share one mid-body close-up on the arming lever /
# trigger / rear sight so the 40 mm jerk drop reads as a pair; reload-open is
# a wider rear 3/4 on the venturi/breech.
POSES = [
    ('pose-sight-up',
     (0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (0.0, 0.0, 0.0),
     (0.78, -0.52, 0.34), (0.02, 0.07, 0.03), 70),
    ('pose-lever-dropped',
     (0.0, -0.04, 0.0), (0.0, 0.0, 0.0), (0.20, 0.0, 0.0),
     (0.78, -0.52, 0.34), (0.02, 0.07, 0.03), 70),
    ('pose-reload-open',
     (0.0, 0.0, 0.0), (0.5, 0.0, 0.0), (0.0, 0.0, 0.0),
     (0.95, -1.20, 0.52), (0.0, 0.12, 0.04), 55),
]

for name, bolt_loc, bolt_rot, trig_rot, pos, target, lens in POSES:
    reset_nodes()
    bolt.location = bolt_loc
    bolt.rotation_euler = bolt_rot
    trigger.rotation_euler = trig_rot
    bpy.context.view_layer.update()
    frame_camera(pos, target, lens)
    scene.render.filepath = str(DOCS / f'{name}.png')
    bpy.ops.render.render(write_still=True)
    print(f'POSE_SAVED {name}.png bolt_loc={bolt_loc} bolt_rot={bolt_rot} trigger_rot={trig_rot}')

reset_nodes()
print('TORCH-POSE-DONE')
