"""Rebuild the PEREGRINE game prop after ImageGen concept A.

Execute this file via Blender MCP. The generated reference and prompt live in
 docs/design/blender/peregrine-redesign/. Coordinates: Blender +Y forward, +Z up;
 glTF/game -Z forward, +Y up. All animation owners and gameplay anchors survive.
Only this study is replaced in the live file. The source is saved as a copy.
"""
import bpy
import bmesh
import json
import math
from pathlib import Path
from mathutils import Vector, Matrix, Euler
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / 'docs/design/blender/peregrine'
DOCS.mkdir(parents=True, exist_ok=True)
SCENE_NAME = 'PEREGRINE | Voxel Blitz sniper study'
GROUPS = ['body', 'mag', 'bolt', 'trigger', 'factory-optic', 'extra']
MARKERS = {'muzzle': (0,.760,.055), 'grip': (.045,.130,.020),
           'support': (-.055,.480,-.010), 'sight': (0,.250,.205)}
old = bpy.data.scenes.get(SCENE_NAME)
if old:
    for obj in list(old.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.scenes.remove(old)
scene = bpy.data.scenes.new(SCENE_NAME)
bpy.context.window.scene = scene
scene.unit_settings.system = 'METRIC'
collection = bpy.data.collections.new('PEREGRINE concept A')
scene.collection.children.link(collection)
parts = {}
for name in GROUPS:
    obj = bpy.data.objects.new(name, None)
    collection.objects.link(obj)
    parts[name] = obj


def linear(hexvalue):
    values = [(hexvalue >> shift & 255) / 255 for shift in (16,8,0)]
    return [v / 12.92 if v <= .04045 else ((v+.055)/1.055)**2.4 for v in values]


mats = {}
# Base material roles match concept A; the shared ImageGen palette is applied before delivery.
for name, color, metal, rough in [
    ('gunmetal', 0x41494a, .32, .42),
    ('petrol coating', 0x426b70, .16, .54),
    ('ivory coating', 0xd9cfb9, .10, .48),
    ('orange paint', 0xf17b35, .10, .43),
    ('rubber', 0x232a2c, 0, .76),
    ('machined metal', 0x7c8d91, .52, .32),
]:
    material = bpy.data.materials.new('PEREGRINE | '+name)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*linear(color), 1)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    material.diffuse_color = (*linear(color), 1)
    material['gltf_tint'] = linear(color)
    mats[name] = material


def extrude(profile, width, inner=None, axis='X'):
    n = len(profile)
    def point(t,a,b):
        return (t,a,b) if axis=='X' else ((a,t,b) if axis=='Y' else (a,b,t))
    vertices = [point(t,a,b) for t in (-width/2,width/2) for a,b in profile]
    faces = [(i,(i+1)%n,n+(i+1)%n,n+i) for i in range(n)]
    if inner is None:
        faces.extend([tuple(range(n-1,-1,-1)),tuple(range(n,2*n))])
    else:
        assert len(inner)==n
        vertices += [point(t,a,b) for t in (-width/2,width/2) for a,b in inner]
        for i in range(n):
            j=(i+1)%n
            faces += [(2*n+i,3*n+i,3*n+j,2*n+j),
                      (i,2*n+i,2*n+j,j),(n+i,n+j,3*n+j,3*n+i)]
    return vertices, faces


def rect(y0,y1,z0,z1):
    return [(y0,z0),(y1,z0),(y1,z1),(y0,z1)]


def circle(radius,n=12):
    # Flat top and bottom facets suit the voxel art direction.
    return [(radius*math.cos(2*math.pi*(i+.5)/n),radius*math.sin(2*math.pi*(i+.5)/n)) for i in range(n)]


def tube(stations,n=12):
    """Hollow loft, with annular end faces and no opaque disks on the axis."""
    vertices=[]
    for y,outer,inner in stations:
        for radius in (outer,inner):
            vertices.extend((x,y,z) for x,z in circle(radius,n))
    faces=[]
    for s in range(len(stations)-1):
        a=s*2*n; b=(s+1)*2*n
        for i in range(n):
            j=(i+1)%n
            faces += [(a+i,a+j,b+j,b+i),(a+n+i,b+n+i,b+n+j,a+n+j)]
    for s in (0,len(stations)-1):
        a=s*2*n
        for i in range(n):
            j=(i+1)%n
            faces.append((a+i,a+n+i,a+n+j,a+j))
    return vertices,faces


def uv_project(mesh):
    uv=mesh.uv_layers.new(name='UVMap')
    for face in mesh.polygons:
        dominant=max(range(3),key=lambda i:abs(face.normal[i]))
        first,second=[(1,2),(0,2),(0,1)][dominant]
        for li in face.loop_indices:
            co=mesh.vertices[mesh.loops[li].vertex_index].co
            uv.data[li].uv=(co[first]*3.6,co[second]*3.6)


objects=[]
def add(name, material, shape, loc=(0,0,0), part='body', bevel=.0015, rot=(0,0,0), local=False):
    vertices,faces=shape
    mesh=bpy.data.meshes.new(name+' mesh')
    mesh.from_pydata(vertices,[],faces)
    mesh.update()
    bm=bmesh.new(); bm.from_mesh(mesh)
    if not local:
        matrix=Matrix.LocRotScale(Vector(loc),Euler(rot).to_quaternion(),Vector((1,1,1)))
        bmesh.ops.transform(bm,matrix=matrix,verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm,faces=bm.faces)
    if bevel:
        bmesh.ops.bevel(bm,geom=list(bm.edges),offset=bevel,segments=1,affect='EDGES',clamp_overlap=True)
    bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-7)
    bmesh.ops.dissolve_degenerate(bm,edges=list(bm.edges),dist=1e-8)
    bmesh.ops.triangulate(bm,faces=list(bm.faces))
    bmesh.ops.recalc_face_normals(bm,faces=bm.faces)
    bm.to_mesh(mesh); bm.free(); mesh.update()
    uv_project(mesh)
    obj=bpy.data.objects.new(name,mesh)
    obj['part']=part; obj['peregrine_material']=material
    obj.parent=parts[part]; collection.objects.link(obj)
    mesh.materials.append(mats[material])
    if local:
        obj.location=loc; obj['round']=True
    objects.append(obj)
    return obj


def box(name,mat,size,loc,part='body',bevel=.0015):
    x,y,z=size
    return add(name,mat,extrude(rect(-y/2,y/2,-z/2,z/2),x),loc,part,bevel)


def cylinder(name,mat,r,length,loc,part='body',axis='Y',bevel=.0006):
    return add(name,mat,extrude(circle(r),length,axis=axis),loc,part,bevel)


# Connected angular shoulder stock with a single deliberate triangular opening.
stock_outer=[(-.360,-.065),(.035,.019),(.042,.060),(-.360,.076)]
stock_inner=[(-.323,-.022),(-.060,.032),(-.060,.046),(-.323,.046)]
add('Stock triangular chassis','gunmetal',extrude(stock_outer,.048,stock_inner),bevel=.002)
box('Stock receiver neck','gunmetal',(.066,.115,.055),(0,.025,.049))
box('Stock rear stanchion','gunmetal',(.065,.032,.157),(0,-.354,.007),bevel=.003)
box('Stock ivory pad backing','ivory coating',(.070,.019,.166),(0,-.378,.007),bevel=.003)
box('Stock recoil pad','rubber',(.074,.022,.158),(0,-.397,.007),bevel=.005)
for y in [-.305,-.202]:
    box('Cheek pad support','gunmetal',(.030,.018,.023),(0,y,.086))
box('Teal cheek pad','petrol coating',(.070,.185,.031),(0,-.258,.110),bevel=.005)
for side in [-1,1]:
    box('Stock adjustment tab','orange paint',(.006,.020,.023),(side*.027,-.125,.049),bevel=.001)

# Low solid receiver with an exposed top action trough, and continuous fore-end.
add('Receiver lower chassis','gunmetal',extrude([
    (-.023,.010),(.057,-.018),(.272,-.018),(.307,.002),(.305,.071),
    (.267,.103),(.031,.103),(-.023,.070)],.088),bevel=.003)
# The bolt is visibly seated above the chassis, below the raised optic bridge.
box('Action channel left','gunmetal',(.013,.253,.028),(-.043,.132,.110))
box('Action channel right','gunmetal',(.013,.253,.028),(.043,.132,.110))
box('Action rear bridge','gunmetal',(.084,.030,.031),(0,.004,.113))
box('Action front bridge','gunmetal',(.084,.035,.034),(0,.270,.112))
for y in [.025,.188]:
    box('Scope bridge receiver seat','gunmetal',(.097,.029,.024),(0,y,.126))
for side in [-1,1]:
    add('Receiver side inset','rubber',extrude([
        (.025,.017),(.238,.017),(.253,.030),(.241,.073),(.035,.073)],.003),
        loc=(side*.045,0,0),bevel=.001)
    box('Receiver orange latch','orange paint',(.006,.024,.012),(side*.048,.214,.021),bevel=.001)
    for y in [.041,.252]:
        cylinder('Receiver flush pin','machined metal',.0035,.003,(side*.047,y,.063),axis='X',bevel=0)
box('Ivory handguard collar','ivory coating',(.105,.039,.088),(0,.293,.034),bevel=.003)
fore_profile=[(.307,-.037),(.520,-.037),(.550,-.018),(.550,.058),(.532,.070),(.307,.070)]
add('Continuous teal fore-end','petrol coating',extrude(fore_profile,.110),bevel=.002)
box('Fore-end lower grip rail','rubber',(.081,.196,.012),(0,.419,-.038),bevel=.002)
# Thin dark inset panels read as recessed slots, without exposing empty hand space.
for side in [-1,1]:
    for y in [.343,.392,.441,.490]:
        add('Fore-end recessed slot','rubber',extrude([
            (y-.018,.021),(y+.018,.021),(y+.020,.024),
            (y+.020,.030),(y+.018,.033),(y-.018,.033),
            (y-.020,.030),(y-.020,.024)],.002),loc=(side*.0553,0,0),bevel=0)
    box('Fore-end orange index','orange paint',(.003,.023,.005),(side*.056,.526,.027),bevel=.0004)
# Grip reaches the real palm anchor at x=.045, y=.130, z=.020.
add('Pistol grip core','rubber',extrude([
    (.045,-.127),(.101,-.143),(.162,.031),(.102,.041)],.090),bevel=.002)
add('Grip foot cap','gunmetal',extrude([
    (.040,-.128),(.103,-.148),(.109,-.136),(.046,-.117)],.094),bevel=.001)
for side in [-1,1]:
    for i in range(5):
        z=-.033-i*.017; y=.118-i*.006
        box('Grip side texture rib','gunmetal',(.002,.031,.003),(side*.0453,y,z),bevel=0)
# Open guard fits around the moving blade, both ends embedded in chassis.
add('Trigger guard','gunmetal',extrude(
    [(.142,.010),(.220,.010),(.220,-.066),(.155,-.066)],.032,
    [(.154,-.002),(.208,-.002),(.208,-.053),(.167,-.053)]),bevel=.001)
add('Trigger blade','machined metal',extrude([
    (.163,.013),(.177,.011),(.174,-.024),(.164,-.040),(.155,-.037),(.165,-.017)],.012),part='trigger',bevel=.0008)
# Short magazine seated in a collar. The three reload rounds remain separate nodes.
box('Magazine well collar','gunmetal',(.080,.080,.024),(0,.248,-.023),bevel=.002)
add('Magazine shell','gunmetal',extrude([
    (.214,-.027),(.282,-.027),(.279,-.117),(.218,-.122)],.060),part='mag',bevel=.002)
box('Orange magazine floorplate','orange paint',(.068,.075,.011),(0,.249,-.123),'mag',.001)
for side in [-1,1]:
    for y in [.232,.258]:
        box('Magazine flute','rubber',(.003,.005,.066),(side*.0305,y,-.078),'mag',.0006)

# Visible bolt group: action bar and offset handle all move with the existing rig.
cylinder('Bolt body','machined metal',.015,.188,(0,.131,.116),'bolt')
cylinder('Bolt tail','gunmetal',.019,.033,(0,.018,.116),'bolt')
box('Bolt handle arm','machined metal',(.079,.015,.014),(-.034,.031,.111),'bolt',.001)
box('Bolt handle drop','gunmetal',(.014,.019,.052),(-.072,.031,.088),'bolt',.0015)
cylinder('Bolt handle knob','machined metal',.015,.020,(-.072,.031,.056),'bolt',axis='Y',bevel=.001)

# Faceted barrel matches the heat sleeve radius in the exposed span.
add('Barrel hollow tube','gunmetal',tube([(.286,.021,.008),(.726,.021,.008)]),loc=(0,0,.055),bevel=0)
cylinder('Barrel shoulder','rubber',.024,.015,(0,.554,.055),bevel=.0005)
# An annular ivory muzzle frame, with dark side port recesses.
add('Muzzle ivory collar','ivory coating',tube([(.725,.029,.009),(.760,.029,.009)]),loc=(0,0,.055),bevel=0)
for side in [-1,1]:
    for y in [.734,.746]:
        box('Muzzle side port','rubber',(.002,.005,.026),(side*.028,y,.055),bevel=.0004)

# Compact scope: exactly two connected mounts around real hollow walls.
box('Scope mounting rail','gunmetal',(.051,.256,.011),(0,.171,.137),'factory-optic',.001)
for y in [.067,.234]:
    box('Scope ring foot','ivory coating',(.070,.036,.014),(0,y,.147),'factory-optic',.001)
    box('Scope short pedestal','ivory coating',(.028,.026,.035),(0,y,.168),'factory-optic',.001)
    add('Ivory scope ring','ivory coating',tube([(y-.012,.032,.026),(y+.012,.032,.026)]),
        loc=(0,0,.205),part='factory-optic',bevel=0)
    for side in [-1,1]:
        cylinder('Scope ring fastener','gunmetal',.004,.003,(side*.034,y,.203),'factory-optic',axis='X',bevel=.0003)
# The scope tube, bells, collars and rings all have a clear optical axis.
add('Scope main hollow housing','gunmetal',tube([
    (-.022,.036,.027),(.014,.036,.027),(.039,.0265,.019),
    (.272,.0265,.019),(.441,.050,.042),(.505,.050,.042)]),
    loc=(0,0,.205),part='factory-optic',bevel=0)
for name,y0,y1,outer,inner,mat in [
    ('Eyepiece rubber lip',-.026,-.018,.037,.027,'rubber'),
    ('Eyepiece teal band',-.011,.002,.037,.029,'petrol coating'),
    ('Objective teal band',.480,.497,.051,.043,'petrol coating'),
    ('Objective rubber lip',.499,.508,.051,.043,'rubber'),
    ('Scope focus ring',.100,.122,.0285,.019,'rubber')]:
    add(name,mat,tube([(y0,outer,inner),(y1,outer,inner)]),loc=(0,0,.205),part='factory-optic',bevel=0)
cylinder('Scope elevation pedestal','gunmetal',.019,.015,(0,.166,.237),'factory-optic',axis='Z')
cylinder('Scope elevation dial','rubber',.023,.013,(0,.166,.250),'factory-optic',axis='Z')
cylinder('Scope windage dial','gunmetal',.020,.017,(-.029,.166,.205),'factory-optic',axis='X')
for i in range(10):
    angle=i*2*math.pi/10
    box('Elevation dial knurl','gunmetal',(.004,.004,.009),(.022*math.cos(angle),.166+.022*math.sin(angle),.251),'factory-optic',.0004)
# Concept A has a compact optic. Shorten its axial proportions as one assembly,
# including both rings and their rail, while preserving the game sight height.
for obj in objects:
    if obj['part']=='factory-optic':
        for vertex in obj.data.vertices: vertex.co.y *= .68
        obj.data.update()
# Stripper rounds use local vertices, so animation can place each directly.
for i in range(3):
    add('Stripper round '+str(i+1),'machined metal',extrude(circle(.006,10),.062,axis='Y'),
        loc=(0,.235,.115+i*.016),part='extra',bevel=.0005,local=True)

for name,loc in MARKERS.items():
    marker=bpy.data.objects.new(name,None); marker.location=loc
    marker.empty_display_size=.012; collection.objects.link(marker)
    marker['contract_marker']=name
bpy.context.view_layer.update()
# Independent mesh-surface and optic checks, not just marker equality.
geometry={}
triangles=0
for obj in objects:
    vertices=[obj.matrix_world @ v.co for v in obj.data.vertices]
    geometry[obj.name]=BVHTree.FromPolygons(vertices,[tuple(p.vertices) for p in obj.data.polygons])
    obj.data.calc_loop_triangles(); triangles+=len(obj.data.loop_triangles)
    for t in obj.data.loop_triangles:
        a,b,c=[vertices[j] for j in t.vertices]
        assert (b-a).cross(c-a).length > 1e-12, ('zero area',obj.name)
contacts={}
for marker in ['grip','support']:
    hits=[(tree.find_nearest(Vector(MARKERS[marker]))[3],name) for name,tree in geometry.items()
          if bpy.data.objects[name]['part']=='body']
    distance,name=min(hits)
    assert distance < .003,(marker,distance,name)
    contacts[marker]={'distance_mm':round(distance*1000,4),'surface':name}
blockers=[]
for obj in objects:
    if obj['part']=='extra': continue
    for dx,dz in [(0,0),(.01,0),(-.01,0),(0,.01),(0,-.01)]:
        hit=geometry[obj.name].ray_cast(Vector((dx,-.07,.205+dz)),Vector((0,1,0)),.64)
        if hit[0] is not None: blockers.append(obj.name)
assert not blockers,blockers

# Neutral studio and a useful saved viewport.
scene.world=bpy.data.worlds.new('PEREGRINE neutral world'); scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.20,.23,.27,1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value=.45
scene.render.engine='CYCLES'; scene.cycles.samples=32; scene.cycles.use_denoising=True
scene.view_settings.view_transform='AgX'
scene.render.resolution_x=1600; scene.render.resolution_y=1000; scene.render.resolution_percentage=100
for obj in objects:
    obj.select_set(obj['part']!='extra')
for area in bpy.context.screen.areas:
    if area.type=='CONSOLE': area.type='VIEW_3D'
    if area.type=='VIEW_3D':
        area.spaces.active.shading.type='MATERIAL'
        area.spaces.active.region_3d.view_distance=1.55
        area.spaces.active.region_3d.view_location=(0,.16,.060)
        area.spaces.active.region_3d.view_rotation=Vector((-.9,-1,.5)).to_track_quat('Z','Y')
        area.spaces.active.overlay.show_extras=False
        area.spaces.active.overlay.show_floor=False
BLEND=DOCS/'peregrine.blend'
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND),copy=True,check_existing=False)
# Write a portable glb of only the study. The runtime exporter batches by material.
bpy.ops.export_scene.gltf(filepath=str(DOCS/'peregrine.glb'),export_format='GLB',
    use_active_scene=True,export_extras=True,export_yup=True,export_animations=False)
for obj in objects:
    obj.select_set(False)
    if obj.get('round'): obj.hide_set(True)
manifest={'asset':'PEREGRINE','design':'ImageGen concept A','source_parts':len(objects),
    'triangles':triangles,'anchors_blender':MARKERS,'surface_contacts':contacts,
    'opaque_optic_blockers':blockers,'reference':'../peregrine-redesign/concepts.png',
    'source':'peregrine.blend','portable':'peregrine.glb'}
(DOCS/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(manifest,indent=2))

# Shared ImageGen materials are part of the authored sniper source.
import runpy
runpy.run_path(str(ROOT / 'tools/blender/material-library.py'))['finish_asset']('peregrine', scene=scene)
