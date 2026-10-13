"""Render the delivered model's actual role=rotor meshes at home/37/120 degrees.

All rotating meshes come from extra, exactly as the browser rotor does. Their
vertices are gun-local, so transform about authoring bore [0,0,.055] with a
shared rigid motion. Poses are rendered without saving changes to the source.
"""
import bpy
import math
from pathlib import Path
from mathutils import Vector, Matrix
DOCS=Path(__file__).resolve().parents[3]/'docs/design/blender/hydra'
scene=bpy.context.scene
scene.render.engine='CYCLES';scene.cycles.samples=24;scene.cycles.use_denoising=True
scene.render.resolution_x=1600;scene.render.resolution_y=1000;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
rotor=[o for o in scene.objects if o.type=='MESH' and o.get('role')=='rotor']
assert len([o for o in rotor if o.get('rotorKind')=='barrel'])==6
assert all(o.parent.name=='extra' for o in rotor)
pivot=Vector((0,0,.055))
for name,pos,energy,size in [('key',(2.2,1.6,2.4),900,1.4),('fill',(-2.4,-.6,1.1),320,2.4),('rim',(-.9,-2.2,1.8),420,1.6)]:
    data=bpy.data.lights.new(name,'AREA');data.energy=energy;data.size=size
    obj=bpy.data.objects.new(name,data);scene.collection.objects.link(obj);obj.location=pos
    obj.rotation_euler=(Vector((0,.3,0))-Vector(pos)).to_track_quat('-Z','Y').to_euler()
cam_data=bpy.data.cameras.new('Rotor proof camera');cam=bpy.data.objects.new('Rotor proof camera',cam_data)
scene.collection.objects.link(cam);scene.camera=cam
cam.location=(-1.05,1.95,.72);cam.rotation_euler=(Vector((0,.38,0))-cam.location).to_track_quat('-Z','Y').to_euler();cam_data.lens=62
for name,degrees,bolt_y in [('pose-home',0,0),('pose-rotor37',37,0),('pose-rotor120',120,0),('pose-boltback',0,-.075)]:
    spin=Matrix.Rotation(math.radians(degrees),3,'Y');delta=pivot-spin@pivot
    for obj in rotor:obj.rotation_euler=(0,math.radians(degrees),0);obj.location=delta
    scene.objects['bolt'].location.y=bolt_y
    bpy.context.view_layer.update()
    scene.render.filepath=str(DOCS/(name+'.png'));bpy.ops.render.render(write_still=True)
for obj in rotor:obj.rotation_euler=(0,0,0);obj.location=(0,0,0)
scene.objects['bolt'].location=(0,0,0)
print('HYDRA POSES DONE: actual rotor meshes, no source changes')
