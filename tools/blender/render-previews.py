"""Render RIVET front, back and detail from the editable Blender scene.

blender --background docs/design/blender/rivet/rivet.blend --python tools/blender/render-previews.py
"""
import bpy
from pathlib import Path
from mathutils import Vector

OUT = Path(__file__).resolve().parents[2] / 'docs/design/blender/rivet'
scene = bpy.context.scene
scene.frame_set(1)
camera = scene.camera
original = (camera.location.copy(), camera.rotation_euler.copy(), camera.data.ortho_scale,
            scene.render.resolution_x, scene.render.resolution_y, scene.render.filepath)
views = {
    'rivet-front': ((1.6, 4.6, 1.98), (0, 0, .93), 2.14, (900, 1150)),
    'rivet-back': ((-2.25, -4.6, 2.22), (0, 0, .93), 2.14, (900, 1150)),
    'rivet-detail': ((1.7, 4.6, 1.94), (0, 0, 1.475), .9, (1100, 1100)),
}
one_view = globals().get('STUDY')
if one_view == 'rivet':
    one_view = 'rivet-front'
try:
    for name, (position, target, scale, size) in views.items():
        if one_view and name != one_view:
            continue
        camera.location = position
        camera.rotation_euler = (Vector(target) - camera.location).to_track_quat('-Z', 'Y').to_euler()
        camera.data.ortho_scale = scale
        scene.render.resolution_x, scene.render.resolution_y = size
        scene.render.filepath = str(OUT / (name + '.png'))
        bpy.ops.render.render(write_still=True)
finally:
    camera.location, camera.rotation_euler, camera.data.ortho_scale = original[:3]
    scene.render.resolution_x, scene.render.resolution_y, scene.render.filepath = original[3:]
