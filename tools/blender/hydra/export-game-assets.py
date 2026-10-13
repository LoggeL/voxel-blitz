"""Export the FURNACE runtime glTF and an identical portable, embedded GLB.

Blender --background docs/design/blender/hydra/hydra.blend --python this_file
Static parts batch by material. Each extra mesh stays a named single-primitive
node with its animation role directly on the mesh (the runtime loader flattens
multi-primitive wrappers). Every vertex is gun-local and all part transforms
are identity. Only the hydra entry of the shared runtime manifest is changed.
"""
import bpy
import json
import struct
import copy
from pathlib import Path
from collections import defaultdict
from mathutils import Matrix
ROOT=Path(__file__).resolve().parents[3]
DOCS=ROOT/'docs/design/blender/hydra'
OUT=ROOT/'public/assets/blender'
GROUPS=['body','mag','bolt','trigger','extra']
MARKERS=['grip','muzzle','sight','support']
GAME=Matrix(((1,0,0),(0,0,1),(0,-1,0)))
scene=bpy.context.scene
bpy.context.view_layer.update()
depsgraph=bpy.context.evaluated_depsgraph_get()
material_names=[];material_objects=[];batches={};extra_meta={}
for obj in sorted(scene.objects,key=lambda o:o.name):
    part=obj.get('part')
    if obj.type!='MESH' or part not in GROUPS:continue
    key=obj['hydra_material']
    if key not in material_names:
        material_names.append(key);material_objects.append(obj.data.materials[0])
    mi=material_names.index(key)
    batch_name=obj.name if part=='extra' else part
    batch=batches.setdefault((batch_name,mi),{'vertices':[],'indices':[],'lookup':{}})
    if part=='extra':
        extra_meta[obj.name]={k:obj[k] for k in ['role','rotorKind','barrelIndex','heatThreshold'] if k in obj}
    evaluated=obj.evaluated_get(depsgraph);mesh=evaluated.to_mesh();mesh.calc_loop_triangles()
    uv=mesh.uv_layers.active.data
    for triangle in mesh.loop_triangles:
        for li in triangle.loops:
            loop=mesh.loops[li]
            position=GAME@(obj.matrix_world@mesh.vertices[loop.vertex_index].co)
            normal=(GAME@obj.matrix_world.to_3x3()@mesh.corner_normals[li].vector).normalized()
            coord=uv[li].uv
            vertex=tuple(round(float(v),6) for v in (*position,*normal,*coord))
            if vertex not in batch['lookup']:
                batch['lookup'][vertex]=len(batch['vertices']);batch['vertices'].append(vertex)
            batch['indices'].append(batch['lookup'][vertex])
    evaluated.to_mesh_clear()

textures=[];materials=[]
for name,mat in zip(material_names,material_objects):
    shader=mat.node_tree.nodes['Principled BSDF']
    pbr={'baseColorFactor':[1,1,1,1],'metallicFactor':float(shader.inputs['Metallic'].default_value),
         'roughnessFactor':float(shader.inputs['Roughness'].default_value)}
    extras={'partMaterial':name}
    if mat.get('palette_texture'):
        uri='textures/'+mat['palette_texture']
        if uri not in textures:textures.append(uri)
        pbr['baseColorTexture']={'index':textures.index(uri)}
        extras.update({'textureLibrary':mat['textureLibrary'],'textureBumpScale':mat['textureBumpScale']})
    else:pbr['baseColorFactor']=list(shader.inputs['Base Color'].default_value)
    if mat.get('role'):extras['role']=mat['role']
    if name=='heated barrels':extras['paletteColor']=0x4c535a
    materials.append({'name':'HYDRA | '+name,'pbrMetallicRoughness':pbr,'extras':extras})
doc={'asset':{'version':'2.0','generator':'Voxel Blitz FURNACE Blender exporter'},'scene':0,
     'scenes':[{'nodes':[]}],'nodes':[],'meshes':[],'materials':materials,
     'images':[{'uri':uri,'name':uri} for uri in textures],
     'textures':[{'source':i,'sampler':0} for i in range(len(textures))],
     'samplers':[{'magFilter':9729,'minFilter':9987,'wrapS':10497,'wrapT':10497}],
     'buffers':[],'bufferViews':[],'accessors':[]}
binary=bytearray()
def accessor(values,width,component,kind,target,bounds=False):
    while len(binary)%4:binary.append(0)
    start=len(binary)
    binary.extend(struct.pack('<'+('f' if component==5126 else 'I')*len(values),*values))
    vi=len(doc['bufferViews']);doc['bufferViews'].append({'buffer':0,'byteOffset':start,'byteLength':len(binary)-start,'target':target})
    entry={'bufferView':vi,'componentType':component,'count':len(values)//width,'type':kind}
    if bounds:
        entry['min']=[min(values[i::width]) for i in range(width)]
        entry['max']=[max(values[i::width]) for i in range(width)]
    doc['accessors'].append(entry);return len(doc['accessors'])-1

def primitive(batch,mi):
    attrs={}
    for key,a,b in [('POSITION',0,3),('NORMAL',3,6),('TEXCOORD_0',6,8)]:
        attrs[key]=accessor([value for vertex in batch['vertices'] for value in vertex[a:b]],b-a,5126,'VEC'+str(b-a),34962,key=='POSITION')
    idx=accessor(batch['indices'],1,5125,'SCALAR',34963)
    return {'attributes':attrs,'indices':idx,'material':mi}

draws=0;triangles=0;per_primitive={}
def add_mesh_node(name,keys,extra):
    global draws,triangles
    primitives=[]
    for key in keys:
        batch=batches[key];primitives.append(primitive(batch,key[1]))
        count=len(batch['indices'])//3;triangles+=count;draws+=1
        per_primitive[name+' | '+material_names[key[1]]]=count
    node={'name':name,'extras':{'blenderAsset':'hydra',**extra}}
    if primitives:
        node['mesh']=len(doc['meshes']);doc['meshes'].append({'name':name,'primitives':primitives})
    doc['nodes'].append(node);return len(doc['nodes'])-1

for part in GROUPS:
    if part=='extra':continue
    keys=sorted(k for k in batches if k[0]==part)
    assert keys,part
    doc['scenes'][0]['nodes'].append(add_mesh_node(part,keys,{}))
children=[]
for name,extras in extra_meta.items():
    keys=[k for k in batches if k[0]==name]
    assert len(keys)==1, f'{name}: moving meshes must have one primitive'
    children.append(add_mesh_node(name,keys,extras))
extra_index=add_mesh_node('extra',[],{})
doc['nodes'][extra_index]['children']=children
doc['scenes'][0]['nodes'].append(extra_index)
for name in MARKERS:
    marker=scene.objects[name]
    doc['nodes'].append({'name':name,'translation':[round(float(v),6) for v in GAME@marker.location],
                         'extras':{'role':'gameplay mount marker'}})
    doc['scenes'][0]['nodes'].append(len(doc['nodes'])-1)
doc['buffers']=[{'uri':'hydra.bin','byteLength':len(binary)}]
(OUT/'hydra.bin').write_bytes(binary)
(OUT/'hydra.gltf').write_text(json.dumps(doc,separators=(',',':'))+'\n')

# GLB embeds only the exact same buffers and existing JPEGs, no second mesh conversion.
portable=copy.deepcopy(doc);embedded=bytearray(binary)
for item in portable['images']:
    while len(embedded)%4:embedded.append(0)
    start=len(embedded);embedded.extend((OUT/item.pop('uri')).read_bytes())
    item['bufferView']=len(portable['bufferViews']);item['mimeType']='image/jpeg'
    portable['bufferViews'].append({'buffer':0,'byteOffset':start,'byteLength':len(embedded)-start})
portable['buffers']=[{'byteLength':len(embedded)}]
while len(embedded)%4:embedded.append(0)
payload=json.dumps(portable,separators=(',',':')).encode();payload+=b' '*(-len(payload)%4)
body=struct.pack('<II',len(payload),0x4e4f534a)+payload+struct.pack('<II',len(embedded),0x004e4942)+embedded
(DOCS/'hydra.glb').write_bytes(struct.pack('<III',0x46546c67,2,12+len(body))+body)

manifest_path=OUT/'manifest.json';manifest=json.loads(manifest_path.read_text())
entry={'asset':'hydra','source_parts':sum(1 for o in scene.objects if o.type=='MESH' and o.get('part') in GROUPS),
       'draws':draws,'triangles':triangles,'geometry_bytes':len(binary)}
manifest['assets']=sorted([a for a in manifest['assets'] if a['asset']!='hydra']+[entry],key=lambda a:a['asset'])
manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
record=json.loads((DOCS/'manifest.json').read_text());record.update(entry)
record['triangles_per_primitive']=per_primitive;record['runtime_nodes']=[n['name'] for n in doc['nodes']]
(DOCS/'manifest.json').write_text(json.dumps(record,indent=2)+'\n')
(DOCS/'export-report.json').write_text(json.dumps({'passed':True,**entry,'triangles_per_primitive':per_primitive,
 'portable_geometry_matches_runtime':True,'moving_nodes':extra_meta},indent=2)+'\n')
print(json.dumps(entry,indent=2))
