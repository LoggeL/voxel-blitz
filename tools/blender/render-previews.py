"""Render one study or a character detail in the current Blender session.

Set STUDY to 'rivet', 'rivet-detail' or 'rivet-back' in the exec scope.
"""
import bpy
from pathlib import Path
from mathutils import Vector

BASE=Path(__file__).resolve().parents[2]/'docs/design/blender'
study=globals().get('STUDY','rivet')
prefix='RIVET'
scene=next(s for s in bpy.data.scenes if s.name.startswith(prefix+' |'))
bpy.context.window.scene=scene
scene.frame_set(1)
if globals().get('FORCE_CPU',False):scene.cycles.device='CPU'
camera=scene.camera
original=(camera.location.copy(),camera.rotation_euler.copy(),camera.data.ortho_scale,
          scene.render.resolution_x,scene.render.resolution_y,scene.render.filepath)
if study=='rivet-detail':
    camera.location=(2.3,4.5,2.05)
    camera.rotation_euler=(Vector((0,0,1.49))-camera.location).to_track_quat('-Z','Y').to_euler()
    camera.data.ortho_scale=.96
    scene.render.resolution_x,scene.render.resolution_y=1400,1400
elif study=='rivet-back':
    camera.location=(-3,-5,2.7)
    camera.rotation_euler=(Vector((0,0,1.04))-camera.location).to_track_quat('-Z','Y').to_euler()
    camera.data.ortho_scale=2.48
scene.render.filepath=str(BASE/'rivet'/
                          (study+'.png' if study!='rivet' else 'rivet-front.png'))
scene.cycles.samples=32
bpy.ops.render.render(write_still=True)
print('RENDER_SAVED',scene.render.filepath)
camera.location,camera.rotation_euler,camera.data.ortho_scale=original[:3]
scene.render.resolution_x,scene.render.resolution_y,scene.render.filepath=original[3:]
