"""Export the authored rigid armor into the game's existing pose frames.

blender --background docs/design/blender/kestrel/kestrel.blend --python tools/blender/export-game-assets.py
Produces standard glTF 2.0 with indexed, material-batched geometry and shared
1024px JPEG delivery copies of the original ImageGen textures. No study file
is modified. Animation remains owned by the game's stance/IK/reload systems.
"""
import bpy
import json
import struct
from collections import defaultdict
from pathlib import Path
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/assets/blender'
OUT.mkdir(parents=True, exist_ok=True)
C = Matrix(((1,0,0), (0,0,1), (0,-1,0)))
DOWN = Vector((0,-1,0))
textures = ['orange-painted-metal','ivory-armor','petrol-ballistic-fabric',
            'worn-gunmetal','tan-webbing','worn-rubber']
scene = bpy.context.scene
scene.render.image_settings.file_format = 'JPEG'
scene.render.image_settings.color_mode = 'RGB'
scene.render.image_settings.quality = 84
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.view_settings.exposure = 0
scene.view_settings.gamma = 1
for name in textures:
    img = bpy.data.images.load(str(ROOT/'docs/design/blender/textures'/f'{name}.png'))
    img.scale(1024,1024)
    img.save_render(str(OUT/'textures'/f'{name}.jpg'), scene=scene)


def char_frame(obj, rig):
    bone = obj['rig_bone']
    name = obj.name.lower()
    if bone.startswith(('upper_arm.', 'forearm.', 'thigh.', 'shin.', 'hand.')):
        b = rig.data.bones[bone]
        start, end = C@b.head_local, C@b.tail_local
        rotation = (end-start).normalized().rotation_difference(DOWN).to_matrix()
        prefix = 'l' if bone.endswith('.R') else 'r'
        part = {'upper_arm':'Arm', 'forearm':'Elbow', 'thigh':'Thigh',
                'shin':'Knee', 'hand':'Hand'}[bone.split('.')[0]]
        length = .34 if part in ['Arm','Elbow'] else .325
        scale = Matrix.Diagonal((.88, length/(end-start).length, .88))
        if part == 'Hand':
            start = start.lerp(end,.55)
            scale = Matrix.Diagonal((.72,.72,.72))
        linear = scale@rotation
        return prefix+part, linear, -(linear@start)
    if bone.startswith('foot.'):
        side = -1 if bone.endswith('.R') else 1
        linear = Matrix.Diagonal((.88,.88,.88))
        return ('lBoot' if side<0 else 'rBoot'), linear, -(linear@Vector((side*.18,.08,0)))
    part, origin = 'torso', Vector((0,1.235,0))
    if bone=='pelvis': part,origin='hips',Vector((0,.90,0))
    if bone in ['head','neck']: part,origin='head',Vector((0,1.74,0))
    if any(s in name for s in ['backpack','pack canister','canister collar','radio antenna']):
        part,origin='pack',Vector((0,1.435,.18))
    if any(s in name for s in ['belt field pouch','pouch folded','pouch pull']):
        part,origin='pouches',Vector((0,1.16,-.19))
    linear=Matrix.Diagonal((.96,1,1))
    return part,linear,-(linear@origin)


def material_desc(material, slug, team=False):
    shader=material.node_tree.nodes.get('Principled BSDF')
    name=material.name
    tex=material.get('imagegen_texture','').replace('.png','')
    color=list(shader.inputs['Base Color'].default_value)
    if tex: color=[1,1,1,1]
    if 'gltf_tint' in material: color=list(material['gltf_tint'])+[1]
    extras={}
    if slug=='rivet':
        if team: tex='ivory-armor';extras['slot']='suit'
        elif 'Suit |' in name: extras['slot']='dark'
        elif 'Face |' in name: extras['slot']='skin'
        elif 'Visor |' in name: extras['paletteColor']=0x6aa5af
        elif 'ceramic' in name: extras['paletteColor']=0x26323b
    else:
        for token,key in [('orange',0xff8c1a),('ceramic',0x454b52),('petrol',0x3c4046),
                          ('rubber',0x22252a),('machined',0x2b3038)]:
            if token in name: extras['paletteColor']=key
    pbr={'baseColorFactor':color,'metallicFactor':shader.inputs['Metallic'].default_value,
         'roughnessFactor':material.get('gltf_roughness',shader.inputs['Roughness'].default_value)}
    if tex:pbr['baseColorTexture']={'index':textures.index(tex)}
    result={'name':name+(' | team' if team else ''),'pbrMetallicRoughness':pbr,'extras':extras}
    if slug=='kestrel' and 'optic glass' in name:
        pbr['baseColorFactor']=[.18,.58,.65,.12]
        pbr['metallicFactor']=0
        result['alphaMode']='BLEND'
        result['doubleSided']=True
        extras['glass']=True
    strength=shader.inputs['Emission Strength'].default_value
    if strength:
        result['emissiveFactor']=[min(1,v*strength) for v in shader.inputs['Emission Color'].default_value[:3]]
        extras['cosmeticGlow']=True
    return result


stats=[]
for slug,prefix in [('rivet','RIVET'),('kestrel','KESTREL')]:
    rig=bpy.data.objects[prefix+'_Rig']
    rig.data.pose_position='REST'
    # Only the independently authored parts, never the merged export duplicate.
    sources=[o for o in rig.children if o.type=='MESH' and 'rig_bone' in o
             and 'SkinnedMesh' not in o.name]
    batches=defaultdict(lambda: {'vertices':[], 'indices':[], 'lookup':{}})
    materials=[]; material_keys={}
    for obj in sources:
        mesh=obj.data
        mesh.calc_loop_triangles()
        # Hidden authoring collections are excluded from the dependency graph;
        # their cached matrix_world may be identity after reopening the file.
        # Compose stored transforms explicitly, including the weapon's root turn.
        root_matrix=Matrix.LocRotScale(rig.location,rig.rotation_euler.to_quaternion(),rig.scale)
        world=root_matrix@obj.matrix_parent_inverse@Matrix.LocRotScale(
            obj.location,obj.rotation_euler.to_quaternion(),obj.scale)
        part,linear,offset=char_frame(obj,rig) if slug=='rivet' else (
            {'magazine':'mag','trigger':'trigger','bolt':'bolt'}.get(obj['rig_bone'],'body'),
            Matrix.Diagonal((.691,.62,.691)),Vector((-.012,.045-.079*.62,-.598+.58*.691)))
        if slug=='kestrel' and any(s in obj.name.lower() for s in ['optic','reflex sight']):
            part='factory-optic'
            offset.x=0
            offset.y=.145-.248*.62
        normal_matrix=(linear@C@world.to_3x3()).inverted().transposed()
        team=slug=='rivet' and any(s in obj.name.lower() for s in
            ['upper chest armor','helmet orange crown','headset orange cap','thigh frontal panel'])
        for tri in mesh.loop_triangles:
            material=mesh.materials[tri.material_index]
            key=(material.name,team)
            if key not in material_keys:
                material_keys[key]=len(materials)
                materials.append(material_desc(material,slug,team))
            batch=batches[(part,material_keys[key])]
            for loop_index in tri.loops:
                loop=mesh.loops[loop_index]
                p=linear@(C@(world@mesh.vertices[loop.vertex_index].co))+offset
                n=(normal_matrix@mesh.corner_normals[loop_index].vector).normalized()
                rest=world@mesh.vertices[loop.vertex_index].co
                face_normal=world.to_3x3()@mesh.polygons[tri.polygon_index].normal
                axis=max(range(3),key=lambda i:abs(face_normal[i]))
                axes=[i for i in range(3) if i!=axis]
                uv=(rest[axes[0]]*3.2,rest[axes[1]]*3.2)
                vertex=tuple(round(float(v),6) for v in (*p,*n,uv[0],1-uv[1]))
                if vertex not in batch['lookup']:
                    batch['lookup'][vertex]=len(batch['vertices'])
                    batch['vertices'].append(vertex)
                batch['indices'].append(batch['lookup'][vertex])
    doc={'asset':{'version':'2.0','generator':'Voxel Blitz Blender runtime export'},
         'scene':0,'scenes':[{'nodes':[]}],'nodes':[],'meshes':[], 'materials':materials,
         'images':[{'uri':f'textures/{name}.jpg'} for name in textures],
         'textures':[{'source':i,'sampler':0} for i in range(len(textures))],
         'samplers':[{'magFilter':9729,'minFilter':9987,'wrapS':10497,'wrapT':10497}],
         'buffers':[], 'bufferViews':[], 'accessors':[]}
    binary=bytearray()
    def accessor(values, size, component, kind, target, bounds=False):
        while len(binary)%4:binary.append(0)
        start=len(binary)
        fmt='f' if component==5126 else 'I'
        binary.extend(struct.pack('<'+fmt*len(values),*values))
        view=len(doc['bufferViews'])
        doc['bufferViews'].append({'buffer':0,'byteOffset':start,'byteLength':len(binary)-start,'target':target})
        acc={'bufferView':view,'componentType':component,'count':len(values)//size,'type':kind}
        if bounds:
            acc['min']=[min(values[i::size]) for i in range(size)]
            acc['max']=[max(values[i::size]) for i in range(size)]
        doc['accessors'].append(acc)
        return len(doc['accessors'])-1
    parts=defaultdict(list)
    for (part,material),batch in sorted(batches.items()):
        attrs={}
        for key,a,b in [('POSITION',0,3),('NORMAL',3,6),('TEXCOORD_0',6,8)]:
            attrs[key]=accessor([v for vertex in batch['vertices'] for v in vertex[a:b]],b-a,5126,
                'VEC'+str(b-a),34962,key=='POSITION')
        idx=accessor(batch['indices'],1,5125,'SCALAR',34963)
        parts[part].append({'attributes':attrs,'indices':idx,'material':material})
    for part,primitives in sorted(parts.items()):
        i=len(doc['nodes'])
        doc['nodes'].append({'name':part,'mesh':i,'extras':{'blenderAsset':slug}})
        doc['meshes'].append({'name':part,'primitives':primitives})
        doc['scenes'][0]['nodes'].append(i)
    doc['buffers']=[{'uri':slug+'.bin','byteLength':len(binary)}]
    (OUT/(slug+'.bin')).write_bytes(binary)
    (OUT/(slug+'.gltf')).write_text(json.dumps(doc,separators=(',',':'))+'\n')
    stats.append({'asset':slug,'source_parts':len(sources),'draws':len(batches),
        'triangles':sum(len(b['indices'])//3 for b in batches.values()),'geometry_bytes':len(binary)})
    study_path=ROOT/'docs/design/blender'/slug/'manifest.json'
    study=json.loads(study_path.read_text())
    study['stage']='Blender authoring source with integrated gameplay export'
    study['runtime']={'path':f'public/assets/blender/{slug}.gltf',
        'exporter':'tools/blender/export-game-assets.py',
        'slot':'standard operator' if slug=='rivet' else 'rifle',
        'animation':'Existing gameplay joint and animation controllers'}
    study['integration_remaining']=['Optional distance LODs and wider mobile GPU profiling']
    study_path.write_text(json.dumps(study,indent=2)+'\n')
# Other weapon exporters keep their own entries in the shared manifest.
manifest_path=OUT/'manifest.json'
manifest=json.loads(manifest_path.read_text()) if manifest_path.exists() else {'assets':[]}
exported={entry['asset'] for entry in stats}
manifest['assets']=[entry for entry in manifest.get('assets',[]) if entry['asset'] not in exported]+stats
manifest['texture_size']=1024
manifest['textures_bytes']=sum(p.stat().st_size for p in (OUT/'textures').glob('*.jpg'))
manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(stats,indent=2))

# Final weapon palette; the character keeps its existing material system.
import runpy
runpy.run_path(str(ROOT / 'tools/blender/material-library.py'))['finish_asset']('kestrel')
