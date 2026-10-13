"""Fresh-import validation of the delivered FURNACE GLB and runtime parity.

Checks actual six hollow barrel meshes, rotor ownership, full 360-degree swept
clearance against static triangle polygons, sight ray, anchors, materials and
budgets. Exit failure when any gate fails. Run in factory-startup Blender.
"""
import bpy
import json
import math
import struct
from pathlib import Path
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
ROOT=Path(__file__).resolve().parents[3]
DOCS=ROOT/'docs/design/blender/hydra'
GLB=DOCS/'hydra.glb'
failures=[];measured={}
def check(name,ok,detail):
    measured[name]=detail
    if not ok:failures.append(name+': '+str(detail))

# Compare identical geometry and scene contracts before Blender import.
runtime=json.loads((ROOT/'public/assets/blender/hydra.gltf').read_text())
raw=GLB.read_bytes();json_len=struct.unpack_from('<I',raw,12)[0]
portable=json.loads(raw[20:20+json_len]);bin_start=28+json_len
binary=raw[bin_start:]
runtime_bin=(ROOT/'public/assets/blender/hydra.bin').read_bytes()
check('portable_geometry_parity',binary[:len(runtime_bin)]==runtime_bin,'GLB geometry prefix is byte-identical to hydra.bin')
for key in ['nodes','meshes','accessors','scenes','materials']:
    check('portable_parity:'+key,portable[key]==runtime[key],key+' match')
check('images_embedded',all('bufferView' in i and 'uri' not in i for i in portable['images']),len(portable['images']))
for obj in list(bpy.context.scene.objects):bpy.data.objects.remove(obj,do_unlink=True)
bpy.ops.import_scene.gltf(filepath=str(GLB))
bpy.context.view_layer.update()
scene=bpy.context.scene;by_name={o.name:o for o in scene.objects}
anchors={'muzzle':(0,.88,.055),'grip':(.05,.1,0),'support':(-.06,.47,-.012),'sight':(0,.2,.155)}
for name,want in anchors.items():
    got=by_name[name].matrix_world.translation
    check('anchor:'+name,(got-Vector(want)).length<1e-6,list(got))
for name in ['body','mag','bolt','trigger','extra']:
    check('contract_group:'+name,name in by_name and all(abs(by_name[name].matrix_world[i][j]-(1 if i==j else 0))<1e-6 for i in range(4) for j in range(4)),'present at identity')
meshes=[o for o in scene.objects if o.type=='MESH']
rotor=[o for o in meshes if o.get('role')=='rotor']
barrels=[o for o in rotor if o.get('rotorKind')=='barrel']
indicators=[o for o in meshes if o.get('role')=='heatIndicator']
check('six_named_barrels',sorted(o.name for o in barrels)==[f'minigun_barrel_{i}' for i in range(6)],[o.name for o in barrels])
check('rotor_parent',all(o.parent and o.parent.name=='extra' for o in rotor),{o.name:o.parent.name if o.parent else None for o in rotor})
check('heat_indicators',len(indicators)==5 and sorted(round(o.get('heatThreshold',0),2) for o in indicators)==[.2,.4,.6,.8,1.],{o.name:o.get('heatThreshold') for o in indicators})
check('moving_single_primitive',all(len(runtime['meshes'][n['mesh']]['primitives'])==1 for n in runtime['nodes'] if n.get('extras',{}).get('role') in ['rotor','heatIndicator']),'each rotor/indicator is a direct one-material mesh')
rotor_materials={m.name for o in barrels for m in o.data.materials}
static=[o for o in meshes if o not in rotor]
static_materials={m.name for o in static for m in o.data.materials}
check('barrel_heat_isolation',rotor_materials=={'HYDRA | heated barrels'} and not(rotor_materials&static_materials),sorted(rotor_materials))
triangles=0
for obj in meshes:obj.data.calc_loop_triangles();triangles+=len(obj.data.loop_triangles)
draws=sum(len(m['primitives']) for m in runtime['meshes'])
check('triangle_budget',triangles<=12000,{'actual':triangles,'max':12000})
check('draw_budget',draws<=32,{'actual':draws,'max':32})
check('material_budget',len(runtime['materials'])<=8,len(runtime['materials']))

# Validate each tube's actual muzzle hole and off-axis vertex motion.
for obj in barrels:
    points=[obj.matrix_world@v.co for v in obj.data.vertices]
    tip=max(v.y for v in points);front=[v for v in points if abs(v.y-tip)<1e-6]
    centre=Vector(((max(v.x for v in points)+min(v.x for v in points))/2,tip,(max(v.z for v in points)+min(v.z for v in points))/2))
    radii=[math.hypot(v.x-centre.x,v.z-centre.z) for v in front]
    check('hollow:'+obj.name,abs(tip-.88)<1e-6 and abs(min(radii)-.014)<2e-6 and abs(max(radii)-.022)<2e-6,
          {'muzzle_y':tip,'inner_radius':min(radii),'outer_radius':max(radii)})
    point=points[0];pivot=Vector((0,0,.055));radius=math.hypot(point.x,point.z-.055)
    spin=Matrix.Rotation(math.pi/7,3,'Y');moved=spin@(point-pivot)+pivot
    check('rotation:'+obj.name,(moved-point).length>.005 and abs(math.hypot(moved.x,moved.z-.055)-radius)<1e-6 and abs(moved.y-point.y)<1e-6,
          {'vertex_motion':(moved-point).length,'bore_radius':radius})

# A full revolution of each rotor mesh lies inside its tight axial cylinder.
# Clip each fixed triangle against each cylinder's actual y interval and then
# find the exact nearest radial distance on the resulting 2D polygon. Positive
# clearance proves the entire continuous sweep, rather than a few sampled poses.
def clip(poly,bound,keep_above):
    out=[]
    if not poly:return out
    for i,a in enumerate(poly):
        b=poly[(i+1)%len(poly)];ina=a.y>=bound if keep_above else a.y<=bound;inb=b.y>=bound if keep_above else b.y<=bound
        if ina:out.append(a)
        if ina!=inb:out.append(a+(b-a)*((bound-a.y)/(b.y-a.y)))
    return out

def radial_min(poly):
    ps=[Vector((p.x,p.z-.055)) for p in poly]
    if not ps:return float('inf')
    distances=[];signs=[]
    for i,a in enumerate(ps):
        b=ps[(i+1)%len(ps)];d=b-a
        t=max(0,min(1,-a.dot(d)/d.length_squared)) if d.length_squared>1e-20 else 0
        distances.append((a+d*t).length)
        signs.append(d.x*(-a.y)-d.y*(-a.x))
    area=sum(ps[i].x*ps[(i+1)%len(ps)].y-ps[(i+1)%len(ps)].x*ps[i].y for i in range(len(ps)))
    if abs(area)>1e-14 and (all(s>=-1e-12 for s in signs) or all(s<=1e-12 for s in signs)):return 0
    return min(distances)

fixed_triangles=[]
for obj in static:
    world=obj.matrix_world;vertices=[world@v.co for v in obj.data.vertices]
    for tri in obj.data.loop_triangles:
        points=[vertices[i] for i in tri.vertices]
        fixed_triangles.append((obj.name,points,min(p.y for p in points),max(p.y for p in points)))
sweep=[]
for obj in rotor:
    points=[obj.matrix_world@v.co for v in obj.data.vertices]
    low=min(p.y for p in points);high=max(p.y for p in points)
    radius=max(math.hypot(p.x,p.z-.055) for p in points)
    best=float('inf');closest=None
    for name,tri,lo,hi in fixed_triangles:
        if hi<low or lo>high:continue
        section=clip(clip(tri,low,True),high,False)
        distance=radial_min(section)-radius
        if distance<best:best=distance;closest=name
    entry={'node':obj.name,'y_interval':[low,high],'swept_radius':radius,'min_clearance':best if math.isfinite(best) else None,'nearest_fixed':closest}
    sweep.append(entry)
    check('full_sweep:'+obj.name,best>=.0002,entry)
measured['full_rotor_sweep']=sweep

# Sight channel starts just beyond the intended front post and continues
# across the bearing. Any hit on this line would block the actual sight axis.
vertices=[];faces=[];face_owners=[]
for obj in meshes:
    base=len(vertices);vertices += [obj.matrix_world@v.co for v in obj.data.vertices]
    faces += [tuple(base+i for i in t.vertices) for t in obj.data.loop_triangles]
    face_owners += [obj.name for t in obj.data.loop_triangles]
tree=BVHTree.FromPolygons(vertices,faces,all_triangles=True)
hit=tree.ray_cast(Vector((0,.337,.155)),Vector((0,1,0)),1)
check('ads_sight_channel',hit[0] is None,{'axis_z':.155,'start_y':.337,'hit':list(hit[0]) if hit[0] else None})
# Five cells must be visible from the player's rear eye position.
for obj in indicators:
    pts=[obj.matrix_world@v.co for v in obj.data.vertices]
    center=sum(pts,Vector())/len(pts)
    eye=Vector((0,-.45,.14));direction=(center-eye).normalized()
    cell_hit=tree.ray_cast(eye,direction,1.0)
    owner=face_owners[cell_hit[2]] if cell_hit[2] is not None else None
    check('heat_cell_visible:'+obj.name,owner==obj.name,{'first_hit':owner,'eye':list(eye)})
report={'asset':'HYDRA','passed':not failures,'failures':failures,'measured':measured}
(DOCS/'validation.json').write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
print(json.dumps({'passed':not failures,'failures':failures,'triangles':triangles,'draws':draws},indent=2))
if failures:raise SystemExit(1)
