"""Create an original stylized KEStrel carbine, a visual game asset only.

Run inside Blender via MCP. Parts are independently editable and skinned to
body, magazine, bolt and trigger bones. No functional weapon internals.
"""
import bpy
import json
import math
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT/'docs/design/blender/kestrel'
OUT.mkdir(parents=True, exist_ok=True)
scene = bpy.data.scenes.new('KESTREL | Voxel Blitz weapon study')
bpy.context.window.scene = scene
scene.unit_settings.system = 'METRIC'
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.cycles.use_denoising = True
scene.render.resolution_x,scene.render.resolution_y = 1600,1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.fps = 24
scene.view_settings.view_transform = 'AgX'
scene.world = bpy.data.worlds.new('Kestrel studio')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.16,.20,.25,1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value=.4
parts=[]


def mat(name,color,metal=0,rough=.4,glow=0):
    m=bpy.data.materials.new('Kestrel | '+name)
    m.diffuse_color=(*color,1)
    m.use_nodes=True
    p=m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value=(*color,1)
    p.inputs['Metallic'].default_value=metal
    p.inputs['Roughness'].default_value=rough
    p.inputs['Emission Color'].default_value=(*color,1)
    p.inputs['Emission Strength'].default_value=glow
    return m


orange=mat('orange paint',(.93,.235,.042),.25)
ceramic=mat('ceramic paint',(.75,.79,.72),.2)
dark=mat('rubber',(.025,.036,.043),0,.7)
steel=mat('machined steel',(.12,.17,.20),.85,.32)
blue=mat('petrol paint',(.035,.14,.18),.35)
glow=mat('cyan indicator',(.07,.8,1),.1,.25,1.6)
ink=mat('ivory marking',(.9,.92,.81),0,.6)
glass=mat('optic glass',(.04,.18,.20),.7,.12)


def finish(obj,name,material,bone='body',bevel=.004):
    obj.name=name
    obj.data.materials.append(material)
    if bevel:
        b=obj.modifiers.new('Edge chamfer','BEVEL')
        b.width,b.segments=bevel,2
        bpy.context.view_layer.objects.active=obj
        bpy.ops.object.modifier_apply(modifier=b.name)
        for p in obj.data.polygons:p.use_smooth=True
        n=obj.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
        n.keep_sharp=True
        bpy.ops.object.modifier_apply(modifier=n.name)
    if bone:
        obj['rig_bone']=bone
        group=obj.vertex_groups.new(name=bone)
        group.add(list(range(len(obj.data.vertices))),1,'REPLACE')
        parts.append(obj)
    return obj


def box(name,pos,size,material,bone='body',bevel=.004,angle=0):
    bpy.ops.mesh.primitive_cube_add(size=1,location=pos)
    obj=bpy.context.object
    obj.scale=size
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    obj.rotation_euler[1]=angle
    return finish(obj,name,material,bone,bevel)


def cylinder(name,pos,radius,length,material,bone='body',axis=(1,0,0),vertices=12):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=radius,depth=length,location=pos)
    obj=bpy.context.object
    obj.rotation_euler=Vector(axis).to_track_quat('Z','Y').to_euler()
    return finish(obj,name,material,bone,.002)


def profile(name,points,depth,material,bone='body',bevel=.005):
    n=len(points)
    verts=[(x,y,z) for y in [-depth/2,depth/2] for x,z in points]
    faces=[tuple(reversed(range(n))),tuple(range(n,2*n))]
    faces.extend([(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)])
    mesh=bpy.data.meshes.new(name)
    mesh.from_pydata(verts,[],faces)
    mesh.update()
    obj=bpy.data.objects.new(name,mesh)
    scene.collection.objects.link(obj)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active=obj
    return finish(obj,name,material,bone,bevel)


def label(text,pos,size,material=ink):
    bpy.ops.object.text_add(location=pos,rotation=(math.pi/2,0,0))
    obj=bpy.context.object
    obj.data.body=text
    obj.data.size=size
    obj.data.extrude=.0001
    bpy.ops.object.convert(target='MESH')
    return finish(obj,'Marking | '+text,material,bevel=0)


# Barrel axis +X in Blender; the root is rotated to game -Z before export.
profile('Receiver outer shell',[(-.27,.035),(-.25,.122),(.20,.122),
        (.25,.09),(.23,-.025),(.035,-.055),(-.16,-.047)],.09,blue)
profile('Receiver top armor',[(-.26,.127),(-.215,.165),(.19,.165),
        (.237,.13),(.227,.10),(-.26,.10)],.099,ceramic)
profile('Angled foreguard',[(.12,.11),(.14,.14),(.37,.14),(.405,.11),
        (.385,-.017),(.13,-.037)],.095,orange)
cylinder('Visible barrel',(.425,0,.079),.020,.16,steel)
cylinder('Muzzle collar',(.499,0,.079),.032,.053,dark)
cylinder('Octagonal muzzle shroud',(.54,0,.079),.040,.063,steel,vertices=8)
cylinder('Dark muzzle face',(.573,0,.079),.025,.004,dark,vertices=12)
cylinder('Muzzle recess appearance',(.576,0,.079),.013,.004,steel,vertices=12)
for side in [-1,1]:
    y=side*.052
    for x in [.174,.220,.266,.312,.358]:
        box('Foreguard cooling slot',(x,y,.085),(.028,.007,.027),dark,bevel=.004)
        box('Lower grip rib',(x,side*.044,-.018),(.024,.017,.035),steel,bevel=.003)
    for x,z in [(-.205,.069),(.065,.076),(.144,.024),(.37,.025)]:
        cylinder('Recessed fastener',(x,side*.054,z),.011,.009,steel,axis=(0,1,0),vertices=8)
        box('Fastener slot',(x,side*.060,z),(.01,.003,.002),dark,bevel=.0005)
profile('Stock support',[(-.30,.092),(-.275,.122),(-.26,.072),(-.465,-.004),
        (-.499,-.008),(-.495,.054)],.055,steel)
profile('Stock cheek rest',[(-.50,.11),(-.48,.138),(-.29,.135),(-.28,.10),
        (-.49,.05)],.089,ceramic)
box('Stock adjustment track',(-.392,-.047,.059),(.123,.018,.018),dark)
box('Stock adjustment latch',(-.387,-.058,.046),(.042,.02,.023),orange)
box('Rubber butt pad',(-.511,0,.035),(.030,.105,.185),dark,bevel=.009,angle=-.06)
for z in [-.024,.004,.032,.060,.088]:
    box('Butt pad tread',(-.53,0,z),(.012,.089,.012),steel,bevel=.002)
profile('Pistol grip',[(-.166,-.035),(-.085,-.041),(-.139,-.213),
        (-.223,-.192)],.069,dark,bevel=.012)
for z,x in [(-.098,-.144),(-.126,-.155),(-.154,-.165),(-.180,-.175)]:
    box('Grip traction',(x,-.038,z),(.058,.011,.013),blue,bevel=.003,angle=.28)
box('Grip base cap',(-.182,0,-.201),(.081,.079,.025),orange,angle=.24)
# Open trigger guard built as three narrow beams.
box('Trigger guard bottom',(-.035,0,-.107),(.114,.022,.013),steel)
box('Trigger guard front',(.022,0,-.074),(.013,.023,.07),steel)
box('Trigger guard back',(-.095,0,-.083),(.014,.023,.049),steel,angle=-.15)
box('Trigger visual',(-.057,0,-.060),(.012,.016,.040),dark,'trigger',.003,-.20)
profile('Detachable curved magazine',[(.045,-.039),(.126,-.043),(.112,-.149),
        (.065,-.241),(-.014,-.217),(.026,-.123)],.067,steel,'magazine',.006)
for side in [-1,1]:
    for x in [.038,.064,.089]:
        box('Magazine reinforcing flute',(x,side*.038,-.105),(.008,.009,.071),dark,'magazine',.002,angle=.08)
    box('Magazine orange band',(.022,side*.039,-.197),(.07,.012,.035),orange,'magazine',.003,angle=-.35)
box('Magazine floor plate',(.023,0,-.23),(.09,.079,.026),dark,'magazine',.004,angle=-.33)
box('Bolt recess',(-.08,-.05,.069),(.139,.008,.039),dark)
box('Visible bolt',(-.075,-.057,.072),(.092,.006,.023),steel,'bolt')
box('Charging handle',(-.142,-.082,.097),(.042,.058,.025),steel,'bolt',.004)
box('Bolt release',(-.015,-.058,.007),(.023,.013,.026),orange)
cylinder('Selector switch',(-.164,-.055,-.005),.016,.012,steel,axis=(0,1,0))
box('Selector lever',(-.177,-.065,-.005),(.035,.008,.009),orange,bevel=.002)
box('Top rail base',(.07,0,.174),(.48,.036,.019),steel)
for x in [-.15+i*.032 for i in range(15)]:
    box('Top rail lug',(x,0,.189),(.017,.06,.012),steel,bevel=.002)
box('Optic riser',(-.025,0,.208),(.084,.052,.037),dark)
for y in [-.036,.036]:
    box('Reflex sight side',(-.025,y,.246),(.080,.012,.074),ceramic,bevel=.005)
box('Reflex sight arch',(-.025,0,.284),(.083,.077,.013),ceramic)
box('Reflex sight lens',(-.004,0,.248),(.007,.057,.053),glass,bevel=.001)
box('Optic side signal',(-.025,-.044,.251),(.026,.005,.007),glow,bevel=.001)
label('KESTREL',(-.223,-.055,.102),.023)
label('VB  /  07',(.132,-.054,.035),.014)
label('ENERGY SYSTEM',(-.225,-.052,.017),.009)

data=bpy.data.armatures.new('Kestrel skeleton')
rig=bpy.data.objects.new('KESTREL_Rig',data)
scene.collection.objects.link(rig)
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
bpy.context.view_layer.objects.active=rig
bpy.ops.object.mode_set(mode='EDIT')
for name,head,tail in [('body',(0,0,0),(.1,0,0)),
        ('magazine',(.075,0,-.04),(.035,0,-.22)),
        ('bolt',(-.1,0,.07),(-.05,0,.07)),
        ('trigger',(-.057,0,-.04),(-.057,0,-.08))]:
    bone=data.edit_bones.new(name)
    bone.head,bone.tail=head,tail
    if name!='body':bone.parent=data.edit_bones['body']
bpy.ops.object.mode_set(mode='OBJECT')
for obj in parts:
    mod=obj.modifiers.new('Weapon part rig','ARMATURE')
    mod.object=rig
    obj.parent=rig
# Axis +X -> Blender +Y -> glTF -Z.
rig.rotation_euler[2]=math.pi/2
rig['asset_id']='kestrel-study-01'
rig['game_forward']='-Z after glTF export'
rig.animation_data_create()
rig.animation_data.action=bpy.data.actions.new('Reload_Study')
action=rig.animation_data.action
mag=rig.pose.bones['magazine']
bolt=rig.pose.bones['bolt']
for frame,drop,slide in [(1,0,0),(10,0,0),(21,.24,0),(34,.24,0),(47,0,0),(54,0,-.06),(60,0,0)]:
    # Global-down offset represented in the bone's local coordinates.
    mag.location=data.bones['magazine'].matrix_local.to_3x3().inverted()@Vector((0,0,-drop))
    bolt.location=data.bones['bolt'].matrix_local.to_3x3().inverted()@Vector((slide,0,0))
    mag.keyframe_insert('location',frame=frame)
    bolt.keyframe_insert('location',frame=frame)
action.use_fake_user=True
scene.frame_start,scene.frame_end=1,60
scene.frame_set(1)
for name,pos in [('muzzle',(.58,0,.079)),('grip',(-.155,0,-.12)),('support',(.25,0,-.02))]:
    empty=bpy.data.objects.new(name,None)
    scene.collection.objects.link(empty)
    empty.parent=rig
    empty.location=pos
    empty.empty_display_size=.035
    empty['purpose']='Visual mount marker; gameplay needs adapter'

floor=mat('studio floor',(.043,.057,.065),.1,.7)
box('Studio ground',(0,0,-.33),(200,200,.06),floor,None,0)
def area(name,pos,energy,color,size):
    d=bpy.data.lights.new(name,'AREA')
    d.energy,d.color,d.shape,d.size=energy,color,'DISK',size
    obj=bpy.data.objects.new(name,d)
    scene.collection.objects.link(obj)
    obj.location=pos
    obj.rotation_euler=(-obj.location).to_track_quat('-Z','Y').to_euler()
area('Kestrel key',(2,-1,3),170,(1,.88,.7),2)
area('Kestrel edge',(-2,1.5,2),210,(.5,.79,1),2)
area('Kestrel front',(2,3,1),80,(.82,.94,1),2)
d=bpy.data.cameras.new('Kestrel lens')
camera=bpy.data.objects.new('Kestrel camera',d)
scene.collection.objects.link(camera)
camera.location=(2.8,1.7,1.40)
camera.rotation_euler=(Vector((0,.02,.005))-camera.location).to_track_quat('-Z','Y').to_euler()
d.type='ORTHO'
d.ortho_scale=1.40
scene.camera=camera
for area in bpy.context.screen.areas:
    if area.type=='VIEW_3D':
        area.spaces.active.region_3d.view_perspective='CAMERA'
        area.spaces.active.shading.type='MATERIAL'
        area.spaces.active.overlay.show_overlays=False
bpy.ops.object.select_all(action='DESELECT')
for obj in parts:obj.select_set(True)
rig.select_set(True)
for obj in rig.children:
    if obj.type=='EMPTY':obj.select_set(True)
bpy.context.view_layer.objects.active=rig
bpy.ops.export_scene.gltf(filepath=str(OUT/'kestrel.glb'),export_format='GLB',
    use_selection=True,use_active_scene=True,export_animations=True,export_animation_mode='ACTIONS',
    export_anim_single_armature=False,export_extras=True)
triangles=0
for obj in parts:
    obj.data.calc_loop_triangles()
    triangles+=len(obj.data.loop_triangles)
manifest={'asset':'KESTREL','stage':'Visual weapon study, not integrated into gameplay',
    'blender':bpy.app.version_string,'editable_parts':len(parts),'triangles':triangles,
    'bones':['body','magazine','bolt','trigger'],'animations':['Reload_Study'],
    'mounts':['muzzle','grip','support'],'forward_after_gltf':'-Z',
    'integration_remaining':['Merged mesh and draw-call budget','Existing weapon animation adapter',
                             'Hand placement, ADS and authoritative muzzle alignment']}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
scene.render.filepath=str(OUT/'kestrel.png')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'kestrel.blend'))
print(json.dumps(manifest,indent=2))
