"""Validate delivered sniper geometry, physical contacts and the opaque optic.
Run Blender background on peregrine.blend after export-game-assets.py.
"""
import bpy
import json
import struct
from pathlib import Path
from mathutils import Vector
from mathutils.bvhtree import BVHTree
ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/design/blender/peregrine-redesign'
scene=bpy.data.scenes['PEREGRINE | Voxel Blitz sniper study']
bpy.context.window.scene=scene
bpy.context.view_layer.update()
assert len(bpy.data.scenes)==1, 'source contains foreign scenes'
source={}
for obj in scene.objects:
    if obj.type!='MESH' or not obj.get('part'): continue
    vertices=[obj.matrix_world @ v.co for v in obj.data.vertices]
    source[obj.name]=BVHTree.FromPolygons(vertices,[tuple(p.vertices) for p in obj.data.polygons])
contact_pairs=[
    ('Stock triangular chassis','Stock rear stanchion'),
    ('Stock triangular chassis','Stock receiver neck'),
    ('Continuous teal fore-end','Ivory handguard collar'),
    ('Scope bridge receiver seat','Scope mounting rail'),
    ('Scope bridge receiver seat.001','Scope mounting rail'),
    ('Scope ring foot','Scope mounting rail'),
    ('Scope ring foot.001','Scope mounting rail'),
    ('Ivory scope ring','Scope main hollow housing'),
    ('Ivory scope ring.001','Scope main hollow housing'),
]
for a,b in contact_pairs:
    assert source[a].overlap(source[b]), f'detached assembly: {a} / {b}'

def decode(document,binary,index):
    a=document['accessors'][index]; view=document['bufferViews'][a['bufferView']]
    fmt={5123:'H',5125:'I',5126:'f'}[a['componentType']]
    width={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
    size=struct.calcsize('<'+fmt*width)
    start=view.get('byteOffset',0)+a.get('byteOffset',0); stride=view.get('byteStride',size)
    return [struct.unpack_from('<'+fmt*width,binary,start+i*stride) for i in range(a['count'])]

def audit(document,binary):
    count=0; trees={}
    for node in document['nodes']:
        if 'mesh' not in node: continue
        allverts=[]; faces=[]
        for primitive in document['meshes'][node['mesh']]['primitives']:
            pos=[Vector(v) for v in decode(document,binary,primitive['attributes']['POSITION'])]
            ids=[v[0] for v in decode(document,binary,primitive['indices'])]
            for k in range(0,len(ids),3):
                tri=ids[k:k+3]
                assert len(set(tri))==3,('repeated indices',node['name'])
                a,b,c=[pos[i] for i in tri]
                assert (b-a).cross(c-a).length > 1e-12,('zero-area triangle',node['name'])
                faces.append(tuple(i+len(allverts) for i in tri)); count+=1
            allverts+=pos
        trees[node['name']]=BVHTree.FromPolygons(allverts,faces)
    return count,trees

runtime=json.loads((ROOT/'public/assets/blender/peregrine.gltf').read_text())
binary=(ROOT/'public/assets/blender/peregrine.bin').read_bytes()
count,trees=audit(runtime,binary)
expected={'muzzle':(0,.055,-.760),'grip':(.045,.020,-.130),
          'support':(-.055,-.010,-.480),'sight':(0,.205,-.250)}
for key,position in expected.items():
    node=next(n for n in runtime['nodes'] if n['name']==key)
    assert (Vector(node['translation'])-Vector(position)).length < 1e-6
contacts={}
for key in ['grip','support']:
    distance=trees['body'].find_nearest(Vector(expected[key]))[3]
    assert distance<.003,(key,distance)
    contacts[key]=round(distance*1000,4)
for tree_name in ['body','factory-optic']:
    for dx,dy in [(0,0),(.01,0),(-.01,0),(0,.01),(0,-.01)]:
        hit=trees[tree_name].ray_cast(Vector((dx,.205+dy,.07)),Vector((0,0,-1)),.64)
        assert hit[0] is None,('opaque optic obstruction',tree_name,hit[0])
extra=next(n for n in runtime['nodes'] if n['name']=='extra')
assert len(extra['children'])==3
roots=[runtime['nodes'][i]['name'] for i in runtime['scenes'][0]['nodes']]
assert set(roots)=={'body','bolt','mag','trigger','factory-optic','extra',*expected}
# Portable file must contain exactly this model and its three reload rounds.
data=(ROOT/'docs/design/blender/peregrine/peregrine.glb').read_bytes()
size,kind=struct.unpack_from('<II',data,12)
glb=json.loads(data[20:20+size]); offset=20+size
binsize,binkind=struct.unpack_from('<II',data,offset)
glb_count,_=audit(glb,data[offset+8:offset+8+binsize])
assert glb_count==count,('source/runtime triangle mismatch',glb_count,count)
assert not any(n.get('name')=='Cube' for n in glb['nodes'])
assert len([n for n in glb['nodes'] if n.get('extras',{}).get('round')])==3
report={'triangles':count,'portable_triangles':glb_count,'degenerate_triangles':0,
        'hand_surface_gap_mm':contacts,'opaque_optic_blockers':0,
        'verified_assembly_contacts':contact_pairs,'draw_primitives':sum(len(m['primitives']) for m in runtime['meshes']),
        'materials':len(runtime['materials']),'runtime_bytes':len(binary),'reload_rounds':3}
(OUT/'geometry-validation.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
