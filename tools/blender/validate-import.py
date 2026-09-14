"""Validate actual exported GLBs by re-importing them in a fresh Blender process.

blender --background --factory-startup --python tools/blender/validate-import.py
"""
import bpy
import json
import math
import struct
from pathlib import Path

BASE=Path(__file__).resolve().parents[2]/'docs/design/blender'
reports=[]
# The rifle (KESTREL) is a part rig without skin or clips: it is validated by
# tools/blender/kestrel/validate-kestrel.py.
FILES={}
for slug,bone_count,clips,image_count in [('rivet',20,{'Idle','Walk'},6)]:
    scene=bpy.data.scenes.new('Import validation '+slug)
    bpy.context.window.scene=scene
    path=BASE/slug/FILES.get(slug,slug+'.glb')
    raw=path.read_bytes()
    magic,version,length=struct.unpack_from('<III',raw)
    assert magic==0x46546c67 and version==2 and length==len(raw)
    json_length=struct.unpack_from('<I',raw,12)[0]
    document=json.loads(raw[20:20+json_length])
    assert len(document['meshes'])==1
    assert len(document['skins'])==1
    assert {a['name'] for a in document['animations']}==clips
    assert len(document['images'])==image_count
    assert all('bufferView' in image for image in document['images']), 'External texture dependency'
    for primitive in document['meshes'][0]['primitives']:
        material=document['materials'][primitive['material']]
        texture=material.get('pbrMetallicRoughness',{}).get('baseColorTexture')
        if texture:
            assert 'TEXCOORD_'+str(texture.get('texCoord',0)) in primitive['attributes']
        assert 'JOINTS_0' in primitive['attributes'] and 'WEIGHTS_0' in primitive['attributes']
        assert 'normalTexture' not in material, 'Albedo must not be interpreted as a normal map'
    old_actions=set(bpy.data.actions)
    old_objects=set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    scene=bpy.context.scene
    actions=[a for a in bpy.data.actions if a not in old_actions]
    objects=[o for o in bpy.data.objects if o not in old_objects]
    rigs=[o for o in objects if o.type=='ARMATURE']
    # Blender's glTF importer creates an unlinked Icosphere for joint gizmos.
    joint_shapes={bone.custom_shape for rig in rigs for bone in rig.pose.bones if bone.custom_shape}
    meshes=[o for o in objects if o.type=='MESH' and o not in joint_shapes]
    assert len(rigs)==1 and len(meshes)==1,[(o.name,o.type) for o in objects]
    rig,mesh=rigs[0],meshes[0]
    assert len(rig.data.bones)==bone_count
    assert all(abs(sum(g.weight for g in v.groups)-1)<1e-5 for v in mesh.data.vertices)
    for track in rig.animation_data.nla_tracks:track.mute=True
    movement={}
    for action in actions:
        rig.animation_data.action=action
        slots=[slot for slot in action.slots if slot.target_id_type=='OBJECT']
        if slots:rig.animation_data.action_slot=slots[0]
        start,end=map(float,action.frame_range)
        def sample(frame):
            scene.frame_set(int(frame),subframe=frame-int(frame))
            graph=bpy.context.evaluated_depsgraph_get()
            evaluated=mesh.evaluated_get(graph)
            data=evaluated.to_mesh()
            positions=[evaluated.matrix_world@v.co for v in data.vertices]
            evaluated.to_mesh_clear()
            return positions
        baseline=sample(start)
        largest=0
        for t in [.25,.5,.75]:
            positions=sample(start+(end-start)*t)
            assert all(math.isfinite(value) for p in positions for value in p)
            largest=max(largest,max((p-q).length for p,q in zip(positions,baseline)))
        assert largest>.0005,(slug,action.name,'no evaluated skin motion')
        movement[action.name]={'frame_range':[start,end],'max_vertex_motion_m':round(largest,6)}
    scene.frame_set(1)
    mesh.data.calc_loop_triangles()
    reports.append({'asset':slug,'glb_bytes':len(raw),'imported_meshes':len(meshes),
        'bones':len(rig.data.bones),'triangles':len(mesh.data.loop_triangles),
        'embedded_images':image_count,'weighted_vertices':len(mesh.data.vertices),
        'animation_motion':movement,'result':'PASS'})
(BASE/'validation.json').write_text(json.dumps(reports,indent=2)+'\n')
print('BLENDER_IMPORT_VALIDATION',json.dumps(reports,indent=2))
