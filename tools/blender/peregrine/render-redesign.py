"""Neutral studio renders of the actual concept-A source; no source edits."""
import bpy
import math
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/design/blender/peregrine-redesign'
scene=bpy.data.scenes['PEREGRINE | Voxel Blitz sniper study']
bpy.context.window.scene=scene
for obj in scene.objects:
    if obj.get('part')=='extra': obj.hide_render=True
scene.render.engine='CYCLES'
scene.cycles.samples=24
scene.cycles.use_denoising=True
scene.render.resolution_x=1600; scene.render.resolution_y=900
scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.22,.24,.27,1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value=.45
scene.view_settings.view_transform='AgX'
scene.view_settings.look='AgX - Medium High Contrast'

def area(name,loc,energy,size):
    data=bpy.data.lights.new(name,'AREA'); data.energy=energy; data.shape='DISK'; data.size=size
    obj=bpy.data.objects.new(name,data); scene.collection.objects.link(obj)
    obj.location=loc; obj.rotation_euler=(Vector((0,.15,.02))-obj.location).to_track_quat('-Z','Y').to_euler()
area('Key',(-1,-.4,1.6),115,1.5)
area('Fill',(1,.5,.7),65,1.3)
area('Rim',(.2,1.3,1.1),95,1)
cam=bpy.data.objects.new('Review camera',bpy.data.cameras.new('Review camera'))
scene.collection.objects.link(cam); scene.camera=cam
for name,loc,aim,scale in [
    ('side',(2.4,.176,.055),(0,.176,.055),1.31),
    ('hero',(-1.35,1.55,.90),(0,.17,.050),1.39),
    ('rear',(-1.25,-1.25,.70),(0,.15,.05),1.40),
    ('optic',(-.00001,-.28,.205),(0,.4,.205),.14),
]:
    cam.data.type='ORTHO'; cam.data.ortho_scale=scale
    cam.location=loc; cam.rotation_euler=(Vector(aim)-cam.location).to_track_quat('-Z','Y').to_euler()
    scene.render.filepath=str(OUT/f'model-{name}.png')
    bpy.ops.render.render(write_still=True)
