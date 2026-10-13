"""Build the six-barrel M-6 FURNACE prop from the selected ImageGen concept A.

Run with Blender --background --factory-startup --python this_file.
Authoring axes: +Y forward, +Z up. All mesh vertices are gun-local, every
contract group and moving mesh has an identity transform. The browser spins
extra role=rotor meshes about game [0,.055,0]. Blender remains editable.
"""
import bpy
import bmesh
import json
import math
from pathlib import Path
from mathutils import Matrix, Vector, Euler

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / 'docs/design/blender/hydra'
DOCS.mkdir(parents=True, exist_ok=True)
GROUPS = ['body', 'mag', 'bolt', 'trigger', 'extra']
MARKERS = {'muzzle': (0,.88,.055), 'grip': (.05,.1,0),
           'support': (-.06,.47,-.012), 'sight': (0,.2,.155)}
UV_SCALE = 3.6
scene = bpy.context.scene
for obj in list(scene.objects): bpy.data.objects.remove(obj, do_unlink=True)
scene.name = 'HYDRA | Voxel Blitz minigun study'
scene.unit_settings.system = 'METRIC'
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.cycles.use_denoising = True
scene.view_settings.view_transform = 'AgX'
scene.world = bpy.data.worlds.new('HYDRA studio')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.11,.14,.18,1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .40
parts = {}
for name in GROUPS:
    obj = bpy.data.objects.new(name, None)
    scene.collection.objects.link(obj)
    obj['blenderAsset'] = 'hydra'
    parts[name] = obj

# Existing ImageGen material-library images, used identically by both exports.
config = json.loads((ROOT/'docs/design/blender/material-library/materials.json').read_text())
MATERIALS = {'gunmetal': 'phosphated-steel', 'dark steel': 'blued-steel',
             'machined steel': 'machined-steel', 'orange paint': 'orange-paint',
             'rubber': 'pebbled-rubber', 'brass': 'aged-brass',
             'heated barrels': 'blued-steel', 'heat indicator': None}
mats = {}
for name, key in MATERIALS.items():
    material = bpy.data.materials.new('HYDRA | '+name)
    material.use_nodes = True
    shader = material.node_tree.nodes['Principled BSDF']
    material['hydra_material'] = name
    if key:
        spec = config['materials'][key]
        image = bpy.data.images.load(str(ROOT/'public/assets/blender/textures/palette'/f'{key}.jpg'), check_existing=True)
        image.name = f'textures/palette/{key}.jpg'
        tex = material.node_tree.nodes.new('ShaderNodeTexImage')
        tex.image = image
        material.node_tree.links.new(tex.outputs['Color'], shader.inputs['Base Color'])
        shader.inputs['Metallic'].default_value = spec['metal']
        shader.inputs['Roughness'].default_value = spec['rough']
        material['palette_texture'] = 'palette/'+key+'.jpg'
        material['textureLibrary'] = key
        material['textureBumpScale'] = spec['bump']
    else:
        shader.inputs['Base Color'].default_value = (.13,.018,.002,1)
        shader.inputs['Metallic'].default_value = .15
        shader.inputs['Roughness'].default_value = .42
    if name == 'heated barrels': material['role'] = 'heatedBarrel'
    if name == 'heat indicator': material['role'] = 'heatIndicator'
    mats[name] = material


def solid(outer, depth, axis='Y', inner=None):
    n = len(outer)
    def place(a,b,t): return (t,a,b) if axis=='X' else ((a,t,b) if axis=='Y' else (a,b,t))
    verts=[place(a,b,t) for t in (-depth/2,depth/2) for a,b in outer]
    faces=[]
    for i in range(n):
        j=(i+1)%n
        faces.append((i,j,n+j,n+i))
    if inner is None:
        faces += [tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]
    else:
        verts += [place(a,b,t) for t in (-depth/2,depth/2) for a,b in inner]
        for i in range(n):
            j=(i+1)%n
            faces += [(2*n+i,3*n+i,3*n+j,2*n+j),
                      (n+i,n+j,3*n+j,3*n+i),(2*n+i,2*n+j,j,i)]
    return verts,faces

def circle(r,n=16): return [(r*math.cos(2*math.pi*i/n),r*math.sin(2*math.pi*i/n)) for i in range(n)]
def cylinder(r,length,n=16,axis='Y'): return solid(circle(r,n),length,axis)
def washer(r,inner,length,n=16,axis='Y'): return solid(circle(r,n),length,axis,circle(inner,n))
def box(size):
    x,y,z=size
    return solid([(-y/2,-z/2),(y/2,-z/2),(y/2,z/2),(-y/2,z/2)],x,'X')
def profile(points,width): return solid(points,width,'X')
def offset(shape,loc): return ([tuple(v[k]+loc[k] for k in range(3)) for v in shape[0]],shape[1])
def combine(shapes):
    vertices,faces=[],[]
    for vs,fs in shapes:
        base=len(vertices); vertices.extend(vs); faces.extend(tuple(i+base for i in f) for f in fs)
    return vertices,faces

def uv_map(mesh):
    uv=mesh.uv_layers.new(name='UVMap')
    for p in mesh.polygons:
        axis=max(range(3), key=lambda i: abs(p.normal[i]))
        a,b=[(1,2),(0,2),(0,1)][axis]
        for li in p.loop_indices:
            v=mesh.vertices[mesh.loops[li].vertex_index].co
            uv.data[li].uv=(v[a]*UV_SCALE,v[b]*UV_SCALE)

AUTHORED=[]
def add(name,part,material,shape,loc=(0,0,0),rot=(0,0,0),bevel=.0015,**extras):
    verts,faces=shape
    transform=Matrix.LocRotScale(Vector(loc),Euler(rot).to_quaternion(),None)
    mesh=bpy.data.meshes.new(name+' mesh')
    mesh.from_pydata([transform@Vector(v) for v in verts],[],faces)
    bm=bmesh.new();bm.from_mesh(mesh);bmesh.ops.recalc_face_normals(bm,faces=bm.faces);bm.to_mesh(mesh);bm.free()
    mesh.update();uv_map(mesh)
    obj=bpy.data.objects.new(name,mesh);scene.collection.objects.link(obj)
    obj.parent=parts[part];obj['part']=part;obj['hydra_material']=material
    for key,value in extras.items(): obj[key]=value
    mesh.materials.append(mats[material])
    if bevel:
        mod=obj.modifiers.new('Machined edges','BEVEL');mod.width=bevel;mod.segments=1
        mod.limit_method='ANGLE';mod.angle_limit=math.radians(30)
    AUTHORED.append(obj)
    return obj

# Compact faceted receiver: the round powertrain remains visually dominant.
add('Receiver core','body','gunmetal',cylinder(.089,.292,12),loc=(0,.252,.055),bevel=.003)
add('Receiver rear flange','body','dark steel',cylinder(.094,.026,12),loc=(0,.106,.055))
add('Receiver drive cap','body','machined steel',cylinder(.076,.020,12),loc=(0,.085,.055))
for y in (.142,.337):
    add('Receiver rib '+str(y),'body','machined steel',washer(.094,.087,.018,12),loc=(0,y,.055),bevel=.001)
# Static bearing surrounds the rotating cluster with a measurable air gap.
add('Static rotor bearing','body','dark steel',washer(.0965,.079,.055,16),loc=(0,.425,.055),bevel=.001)
add('Bearing outer armor','body','machined steel',washer(.0985,.0935,.022,12),loc=(0,.42,.055))
for side in (-1,1):
    add('Receiver flank armor '+str(side),'body','gunmetal',box((.016,.132,.069)),loc=(side*.084,.244,.057),bevel=.004)
    add('Receiver orange plate '+str(side),'body','orange paint',box((.006,.066,.026)),loc=(side*.094,.256,.058),bevel=.001)
    for y in (.236,.276):
        add('Plate fastener '+str((side,y)),'body','dark steel',cylinder(.003,.008,8,axis='X'),loc=(side*.098,y,.058),bevel=0)
# Off-side carry handle preserves the iron sight channel.
for y in (.14,.315):
    add('Carry handle mount '+str(y),'body','dark steel',box((.022,.025,.068)),loc=(-.072,y,.139),bevel=.002)
add('Carry handle','body','machined steel',box((.029,.2,.026)),loc=(-.072,.227,.172),bevel=.004)
for y in (.18,.218,.256):
    add('Handle wrap '+str(y),'body','rubber',box((.031,.018,.028)),loc=(-.072,y,.172),bevel=.001)
# Small offset motor bulge breaks the cylindrical silhouette without a long box.
add('Drive motor','body','dark steel',cylinder(.037,.14,12),loc=(.089,.182,-.009),bevel=.002)
for y in (.134,.222):
    add('Motor rib '+str(y),'body','machined steel',washer(.04,.035,.010,12),loc=(.089,y,-.009),bevel=.0005)

# Every visible barrel is an actual hollow, separately named rotating mesh.
# Six tubes: radius .022 at .048 from bore -> .070 m barrel envelope.
# Their open annular muzzle ends lie exactly on authoring y=.880.
for i in range(6):
    angle=2*math.pi*i/6+math.pi/6
    cx,cz=.048*math.cos(angle),.055+.048*math.sin(angle)
    add(f'minigun_barrel_{i}','extra','heated barrels',washer(.022,.014,.464,12),
        loc=(cx,.648,cz),bevel=0,role='rotor',rotorKind='barrel',barrelIndex=i)
# Collars have a single asymmetric orange key so rotation remains obvious.
for name,y in [('rear',.501),('front',.825)]:
    add('minigun_collar_'+name,'extra','orange paint',washer(.076,.064,.025,18),
        loc=(0,y,.055),bevel=.001,role='rotor',rotorKind='collar')
    shapes=[offset(washer(.074,.063,.006,18),(0,y+d,.055)) for d in (-.016,.016)]
    shapes.append(offset(box((.012,.03,.012)),(.076,y,.055)))
    add('minigun_collar_trim_'+name,'extra','machined steel',combine(shapes),
        bevel=.0007,role='rotor',rotorKind='collarTrim')
add('minigun_spindle','extra','dark steel',cylinder(.017,.43,12),loc=(0,.626,.055),
    bevel=0,role='rotor',rotorKind='spindle')
# Visible backplate seals the optical tunnel far inside each open tube.
add('minigun_rotor_backplate','extra','dark steel',cylinder(.074,.014,18),loc=(0,.411,.055),
    bevel=.0005,role='rotor',rotorKind='backplate')

# Short skeletal stock. Empty triangular window stays readable from both sides.
add('Stock struts','body','gunmetal',combine([
    offset(box((.034,.232,.032)),(0,-.036,.068)),
    profile([(-.153,-.082),(-.137,-.093),(.077,.037),(.061,.054)],.029),
    offset(box((.042,.028,.18)),(0,-.154,-.007))]),bevel=.003)
add('Stock socket','body','orange paint',box((.052,.031,.049)),loc=(0,.054,.067),bevel=.002)
add('Stock butt pad','body','rubber',box((.051,.019,.185)),loc=(0,-.174,-.007),bevel=.003)
add('Pistol grip','body','rubber',profile([(.068,.011),(.131,.012),(.124,-.032),(.079,-.144),(.023,-.129),(.053,-.042)],.061),bevel=.004)
add('Grip base','body','machined steel',box((.065,.061,.012)),loc=(0,.052,-.136),rot=(math.radians(12),0,0),bevel=.001)
add('Trigger guard','body','dark steel',solid([(.125,-.059),(.187,-.047),(.201,-.003),(.128,.005)],.012,'X',[(.132,-.050),(.178,-.040),(.188,-.010),(.139,-.005)]),bevel=.001)
add('Trigger blade','trigger','machined steel',box((.009,.014,.024)),loc=(0,.13,-.008),bevel=.001)
# Foregrip wraps frozen support mount without entering the swept rotor envelope.
add('Foregrip outrigger','body','gunmetal',box((.035,.162,.028)),loc=(-.060,.401,-.048),bevel=.002)
add('Foregrip','body','rubber',profile([(.438,-.053),(.484,-.053),(.489,-.153),(.445,-.162)],.041),loc=(-.06,0,0),bevel=.003)
add('Foregrip foot','body','machined steel',box((.049,.053,.014)),loc=(-.06,.465,-.157),bevel=.001)
# Shoulder at the support palm, clear of the rear rotor collar.
add('Support palm rest','body','rubber',box((.041,.031,.023)),loc=(-.068,.466,-.026),bevel=.002)

# Belly drum, hanging belt, and brass cartridges matching concept A.
add('Drum mount','mag','dark steel',box((.086,.11,.068)),loc=(0,.235,-.056),bevel=.003)
add('Drum body','mag','gunmetal',cylinder(.112,.144,20),loc=(.005,.24,-.178),bevel=.003)
for y in (.170,.31):
    add('Drum rim '+str(y),'mag','machined steel',washer(.118,.106,.014,20),loc=(.005,y,-.178),bevel=.001)
add('Drum rear cover','mag','dark steel',cylinder(.102,.012,20),loc=(.005,.163,-.178),bevel=.001)
add('Drum front cover','mag','dark steel',cylinder(.102,.012,20),loc=(.005,.317,-.178),bevel=.001)
add('Drum hub','mag','machined steel',cylinder(.035,.016,12),loc=(.005,.328,-.178),bevel=.001)
add('Feed tray','body','dark steel',box((.062,.075,.042)),loc=(-.095,.3,-.014),bevel=.002)
for i in range(7):
    z=-.026-i*.026;y=.305-.014*math.sin(i*.32);x=-.114-.010*math.sin(i*.4)
    add('Belt link '+str(i),'mag','dark steel',box((.052,.013,.028)),loc=(x,y-.019,z),bevel=.001)
    add('Belt cartridge '+str(i),'mag','brass',cylinder(.009,.054,10),loc=(x,y+.005,z),bevel=.0007)
    add('Belt cartridge tip '+str(i),'mag','orange paint',cylinder(.007,.012,8),loc=(x,y+.038,z),bevel=.0007)

# Bolt animation retains its own fixed contract group.
add('Bolt slide','bolt','dark steel',box((.016,.099,.023)),loc=(-.074,.075,.103),bevel=.001)
add('Bolt handle','bolt','machined steel',box((.061,.017,.016)),loc=(-.100,.025,.096),bevel=.002)
add('Bolt knob','bolt','rubber',cylinder(.015,.023,10,axis='X'),loc=(-.137,.025,.096),bevel=.001)
# Sight post/notch at .155. Receiver crown is .144, leaving a clear aim lane.
add('Sight rail','body','dark steel',box((.029,.264,.008)),loc=(0,.20,.146),bevel=.001)
for side in (-1,1):
    add('Rear sight ear '+str(side),'body','machined steel',box((.006,.018,.020)),loc=(side*.014,.085,.155),bevel=.0005)
    add('Front sight wing '+str(side),'body','dark steel',box((.005,.014,.020)),loc=(side*.014,.327,.153),bevel=.0005)
add('Front sight post','body','orange paint',box((.005,.01,.010)),loc=(0,.327,.151),bevel=0)
# Five separate cells face the player's eye from the upper rear receiver cap.
# The panel sits beside the stock socket; the backing intersects the cap by
# 3.5 mm, so the slightly overhanging left edge remains mechanically attached.
add('Heat panel backing','body','dark steel',box((.067,.011,.027)),loc=(-.040,.073,.126),bevel=.001)
for i in range(5):
    add(f'minigun_heat_{i}','extra','heat indicator',box((.009,.006,.018)),
        loc=(-.064+i*.012,.066,.126),bevel=.0004,
        role='heatIndicator',heatThreshold=(i+1)/5)

for name,loc in MARKERS.items():
    obj=bpy.data.objects.new(name,None);scene.collection.objects.link(obj);obj.location=loc;obj['role']='gameplay mount marker'
bpy.context.view_layer.update()
assert len([o for o in AUTHORED if o.get('rotorKind')=='barrel'])==6
assert all(o.parent==parts['extra'] for o in AUTHORED if o.get('role')=='rotor')
assert max(max(v.co.y for v in o.data.vertices) for o in AUTHORED if o.get('rotorKind')=='barrel')==.88 or abs(max(max(v.co.y for v in o.data.vertices) for o in AUTHORED if o.get('rotorKind')=='barrel')-.88)<1e-6
bpy.ops.file.pack_all()
bpy.context.preferences.filepaths.save_version=0
bpy.ops.wm.save_as_mainfile(filepath=str(DOCS/'hydra.blend'),check_existing=False)
record={'asset':'HYDRA','asset_id':'hydra','display_name':'M-6 FURNACE','design':'ImageGen concept A, six-barrel cylindrical minigun',
 'authoring_script':'tools/blender/hydra/build-hydra.py','source_parts':len(AUTHORED),
 'animation_group_nodes':GROUPS,'rotor':{'barrels':6,'pivot_game':[0,.055,0],'geometry_space':'gun-local vertices; identity mesh transforms',
 'parent':'extra','role':'rotor','barrel_radius':.022,'cluster_radius':.048,'collar_radius':.082,'bearing_inner_radius':.079},
 'anchors_game_space':{n:[v[0],v[2],-v[1]] for n,v in MARKERS.items()},
 'materials':MATERIALS,'files':{'blend':'docs/design/blender/hydra/hydra.blend','glb':'docs/design/blender/hydra/hydra.glb'},
 'notes':['Six hollow moving barrels with rotating collars and asymmetric collar keys.',
 'Body and static bearing remain separate from the rotor. Five independent authoritative heat indicators.',
 'Existing palette images reused. Runtime glTF and portable GLB share byte-identical geometry.']}
(DOCS/'manifest.json').write_text(json.dumps(record,indent=2)+'\n')
(DOCS/'material-library.json').write_text(json.dumps({'version':config['version'],'asset':'hydra','materials':[{'material':'HYDRA | '+n,'texture':k} for n,k in MATERIALS.items() if k]},indent=2)+'\n')
print('HYDRA BUILD',len(AUTHORED),'authored meshes')
