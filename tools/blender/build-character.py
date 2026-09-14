"""Build RIVET, an original Blender character study for Voxel Blitz.

Execute in the open Blender application through execute_blender_code.
The scene contains editable named parts, a deform rig, and two loop clips.
No existing scene is replaced. Re-running creates another study scene.
"""

import bpy
import json
import math
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/design/blender/rivet'
OUT.mkdir(parents=True, exist_ok=True)
scene = bpy.data.scenes.new('RIVET | Voxel Blitz character study')
bpy.context.window.scene = scene
scene.unit_settings.system = 'METRIC'
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.cycles.use_denoising = True
scene.render.resolution_x = 1200
scene.render.resolution_y = 1400
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.fps = 24
scene.view_settings.view_transform = 'AgX'
scene.world = bpy.data.worlds.new('Rivet studio world')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (0.17, 0.21, 0.27, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = 0.4
parts = []
mat = {}


def material(name, color, metallic=0, roughness=0.5, emission=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    shader = m.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Metallic'].default_value = metallic
    shader.inputs['Roughness'].default_value = roughness
    if emission:
        shader.inputs['Emission Color'].default_value = (*color, 1)
        shader.inputs['Emission Strength'].default_value = emission
    mat[name] = m
    return m


material('Suit | petrol blue', (0.035, 0.16, 0.20), roughness=0.85)
material('Armor | rescue orange', (0.93, 0.235, 0.042), metallic=0.22, roughness=0.35)
material('Armor | warm ceramic', (0.75, 0.79, 0.72), metallic=0.12, roughness=0.38)
material('Joints | graphite', (0.025, 0.04, 0.052), roughness=0.75)
material('Hardware | gunmetal', (0.13, 0.20, 0.23), metallic=0.72, roughness=0.32)
material('Visor | smoked teal', (0.022, 0.15, 0.18), metallic=0.7, roughness=0.14)
material('Signals | ice cyan', (0.07, 0.8, 1.0), metallic=0.1, roughness=0.24, emission=1.5)
material('Webbing | sand', (0.38, 0.29, 0.15), roughness=0.9)
material('Face | warm skin', (0.62, 0.33, 0.18), roughness=0.7)
material('Markings | ivory', (0.94, 0.92, 0.77), roughness=0.55)
M = list(mat)
SUIT, ORANGE, WHITE, DARK, METAL, VISOR, GLOW, STRAP, SKIN, INK = M


def finish(obj, name, material_key, bone, bevel=0):
    obj.name = name
    obj.data.materials.append(mat[material_key])
    if bevel:
        mod = obj.modifiers.new('Machined edge chamfer', 'BEVEL')
        mod.width = bevel
        mod.segments = 2
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
        # Area-weighted normals preserve planar faces and smooth only chamfers.
        for poly in obj.data.polygons:
            poly.use_smooth = True
        mod = obj.modifiers.new('Face weighted normals', 'WEIGHTED_NORMAL')
        mod.keep_sharp = True
        mod.weight = 40
        bpy.ops.object.modifier_apply(modifier=mod.name)
    if bone:
        obj['rig_bone'] = bone
        group = obj.vertex_groups.new(name=bone)
        group.add(list(range(len(obj.data.vertices))), 1, 'REPLACE')
        parts.append(obj)
    return obj


def box(name, pos, size, material_key, bone, bevel=0.008, rotation=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=pos)
    obj = bpy.context.object
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if rotation:
        obj.rotation_euler = rotation
    return finish(obj, name, material_key, bone, bevel)


def tapered(name, levels, material_key, bone, bevel=0.008):
    # Chamfered rectangular cross sections make a deliberately modeled silhouette.
    verts = []
    for z, width, depth, center_y in levels:
        x, y = width / 2, depth / 2
        c = min(width, depth) * 0.18
        verts.extend([(px, py + center_y, z) for px, py in
                      [(-x+c,-y),(x-c,-y),(x,-y+c),(x,y-c),
                       (x-c,y),(-x+c,y),(-x,y-c),(-x,-y+c)]])
    faces = [tuple(reversed(range(8)))]
    for ring in range(len(levels) - 1):
        a, b = ring * 8, (ring + 1) * 8
        faces.extend([(a+i, a+(i+1)%8, b+(i+1)%8, b+i) for i in range(8)])
    faces.append(tuple(range(len(verts)-8, len(verts))))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    return finish(obj, name, material_key, bone, bevel)


def beam(name, start, end, width, depth, material_key, bone, bevel=0.008):
    a, b = Vector(start), Vector(end)
    obj = box(name, (a+b)/2, (width, depth, (b-a).length), material_key, bone, bevel)
    obj.rotation_euler = (b-a).to_track_quat('Z', 'Y').to_euler()
    return obj


def cylinder(name, pos, radius, length, material_key, bone, axis=(0,0,1), vertices=12):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=length, location=pos)
    obj = bpy.context.object
    obj.rotation_euler = Vector(axis).to_track_quat('Z', 'Y').to_euler()
    return finish(obj, name, material_key, bone, 0.003)


def lettering(name, text, pos, size, material_key, bone):
    bpy.ops.object.text_add(location=pos, rotation=(math.pi/2, 0, math.pi))
    obj = bpy.context.object
    obj.data.body = text
    obj.data.align_x = 'CENTER'
    obj.data.align_y = 'CENTER'
    obj.data.size = size
    obj.data.extrude = 0.0004
    bpy.ops.object.convert(target='MESH')
    return finish(obj, name, material_key, bone)


# The character faces Blender +Y, which becomes game/glTF -Z at export.
tapered('01 | flight suit torso', [(0.98,.32,.24,0),(1.12,.36,.26,0),
        (1.40,.49,.28,0),(1.48,.43,.24,0)], SUIT, 'chest', .025)
tapered('02 | upper chest armor', [(1.19,.32,.08,.15),(1.36,.43,.08,.16),
        (1.45,.35,.08,.135)], ORANGE, 'chest', .018)
box('Chest seam', (0,.213,1.335), (.011,.009,.20), DARK, 'chest', .001)
box('Rank backing', (.11,.213,1.39), (.09,.014,.038), DARK, 'chest', .005)
for x in [.082,.106,.13]:
    box('Cyan rank pip', (x,.223,1.39), (.013,.008,.009), GLOW, 'chest', .002)
lettering('Chest identity', 'R / 07', (-.10,.216,1.36), .032, INK, 'chest')
for side in [-1, 1]:
    beam('Shoulder harness', (side*.17,.151,1.45), (side*.16,.157,1.07),
         .052,.026, STRAP,'chest',.007)
    box('Harness buckle', (side*.164,.177,1.23), (.067,.022,.055), METAL,'chest',.006)
    box('Buckle insert', (side*.164,.191,1.23), (.033,.009,.023), DARK,'chest',.003)
for z in [1.075,1.103,1.131,1.159]:
    box('Flexible abdominal rib', (0,.135,z), (.26,.047,.019), DARK,'spine',.006)
# The pelvis reads as wide as the paired thighs (0.64 m) and about 0.82 of the
# pauldron span, so the belt bridges the narrow waist and the broad hips.
box('Utility belt', (0,0,.985), (.46,.32,.075), DARK,'pelvis',.013)
box('Belt buckle', (0,.178,.983), (.10,.033,.062), METAL,'pelvis',.007)
box('Buckle center', (0,.199,.983), (.058,.009,.031), ORANGE,'pelvis',.004)
box('Pelvis suit', (0,0,.875), (.60,.30,.19), SUIT,'pelvis',.035)
for side in [-1, 1]:
    box('Hip armor plate '+('R' if side<0 else 'L'), (side*.31,.01,.88), (.05,.21,.15), WHITE,'pelvis',.012)
for x in [-.117,.025,.16]:
    box('Belt field pouch', (x,.196,1.087), (.11,.094,.14), STRAP,'spine',.012)
    box('Pouch folded flap', (x,.25,1.128), (.113,.02,.055), SUIT,'spine',.006)
    box('Pouch pull tab', (x,.265,1.095), (.019,.012,.057), METAL,'spine',.004)

# Rear equipment is deliberately part of the silhouette, with visible mounting rails.
box('Backpack frame', (0,-.195,1.285), (.34,.12,.36), METAL,'chest',.018)
box('Backpack hard case', (0,-.27,1.29), (.285,.11,.285), WHITE,'chest',.028)
box('Backpack orange lid', (0,-.331,1.37), (.24,.025,.07), ORANGE,'chest',.009)
for x in [-.078,-.039,0,.039,.078]:
    box('Backpack cooling vent', (x,-.334,1.24), (.018,.012,.092), DARK,'chest',.003)
for x in [-.195,.195]:
    cylinder('Pack canister', (x,-.227,1.26), .053,.27, ORANGE,'chest')
    for z in [1.16,1.36]:
        cylinder('Canister collar', (x,-.227,z), .058,.026, DARK,'chest')
beam('Short radio antenna', (-.14,-.27,1.46),(-.16,-.27,1.73), .011,.011,DARK,'chest',.002)

# Oversized helmet and a visible human jaw keep the avatar readable at game distance.
cylinder('Neck gasket', (0,0,1.51), .09,.11,DARK,'neck')
tapered('Human face and jaw', [(1.555,.17,.15,.032),(1.60,.235,.23,.015),
        (1.76,.245,.24,.005)],SKIN,'head',.025)
tapered('Helmet shell', [(1.695,.315,.315,-.014),(1.80,.355,.34,-.015),
        (1.905,.295,.29,-.025),(1.935,.20,.21,-.025)],WHITE,'head',.016)
tapered('Visor gasket', [(1.691,.283,.041,.156),(1.788,.318,.045,.162),
        (1.81,.286,.04,.157)],DARK,'head',.009)
tapered('Wraparound smoked visor', [(1.707,.265,.028,.181),(1.781,.292,.032,.185),
        (1.791,.27,.028,.181)],VISOR,'head',.006)
box('Helmet brow peak', (0,.161,1.815), (.344,.145,.032), WHITE,'head',.012)
box('Helmet orange crown stripe', (0,.00,1.934), (.055,.18,.009), ORANGE,'head',.004)
box('Visor subtle HUD bar', (-.067,.207,1.762), (.086,.006,.008), GLOW,'head',.001)
box('Visor HUD square', (-.123,.20,1.744), (.011,.005,.013), GLOW,'head',.001)
box('Nose', (0,.145,1.673), (.05,.061,.064), SKIN,'head',.014)
box('Mouth shadow', (0,.155,1.62), (.074,.009,.008), DARK,'head',.002)
for side in [-1,1]:
    box('Helmet cheek rail', (side*.133,.072,1.65), (.039,.13,.093),WHITE,'head',.012)
    cylinder('Headset earpiece', (side*.18,-.016,1.728), .073,.052,DARK,'head',(1,0,0))
    cylinder('Headset orange cap', (side*.209,-.016,1.728), .055,.012,ORANGE,'head',(1,0,0))
beam('Mic boom', (.217,.008,1.70),(.13,.191,1.63),.012,.012,METAL,'head',.003)
box('Mic foam',(.115,.196,1.63),(.04,.025,.024),DARK,'head',.008)

bones = {
    'root': ((0,0,0),(0,0,.18),None),
    'pelvis': ((0,0,.87),(0,0,1.0),'root'),
    'spine': ((0,0,1.0),(0,0,1.21),'pelvis'),
    'chest': ((0,0,1.21),(0,0,1.46),'spine'),
    'neck': ((0,0,1.46),(0,0,1.56),'chest'),
    'head': ((0,0,1.56),(0,0,1.9),'neck'),
}
for side, suffix in [(-1,'R'),(1,'L')]:
    shoulder = Vector((side*.27,0,1.43))
    elbow = Vector((side*.45,0,1.165))
    wrist = Vector((side*.555,.01,.945))
    hand = Vector((side*.585,.028,.837))
    upper, lower, palm = 'upper_arm.'+suffix, 'forearm.'+suffix, 'hand.'+suffix
    bones['clavicle.'+suffix] = ((side*.07,0,1.425),tuple(shoulder),'chest')
    bones[upper] = (tuple(shoulder),tuple(elbow),'clavicle.'+suffix)
    bones[lower] = (tuple(elbow),tuple(wrist),upper)
    bones[palm] = (tuple(wrist),tuple(hand),lower)
    beam('Upper sleeve '+suffix, shoulder, elbow, .18,.205,SUIT,upper,.023)
    pad = box('Shoulder pauldron '+suffix, shoulder+(Vector((side*.006,0,-.04))),
              (.245,.27,.17),ORANGE if side==-1 else WHITE,upper,.035)
    pad.rotation_euler[1] = side*.27
    box('Shoulder inset '+suffix, (side*.30,.147,1.389),(.105,.018,.068),DARK,upper,.008)
    lettering('Shoulder unit '+suffix,'07',(side*.30,.160,1.389),.048,INK,upper)
    cylinder('Elbow joint '+suffix, elbow,.08,.17,DARK,lower,(1,0,0))
    beam('Forearm sleeve '+suffix,elbow,wrist,.145,.17,SUIT,lower,.019)
    beam('Forearm bracer '+suffix,elbow+Vector((0,.098,-.045)),
         wrist+Vector((0,.098,.028)),.146,.07,WHITE,lower,.012)
    beam('Orange bracer inset '+suffix,elbow+Vector((0,.139,-.075)),
         wrist+Vector((0,.139,.07)),.086,.016,ORANGE,lower,.004)
    if side==1:
        box('Wrist terminal',(.523,.128,1.015),(.116,.054,.083),DARK,lower,.01)
        box('Terminal display',(.523,.159,1.015),(.078,.009,.048),GLOW,lower,.004)
        for z in [1.005,1.025]:
            box('Display scanline',(.525,.166,z),(.053,.003,.004),VISOR,lower,.0005)
    beam('Glove palm '+suffix,wrist,hand,.106,.119,DARK,palm,.014)
    box('Glove knuckle plate '+suffix,(side*.58,.091,.896),(.1,.032,.073),ORANGE,palm,.012)
    for finger in range(4):
        x = side*(.548+finger*.024)
        box('Glove finger '+suffix,(x,.04,.828),(.019,.079,.067),DARK,palm,.007)
        box('Finger armor '+suffix,(x,.084,.848),(.019,.014,.022),WHITE,palm,.003)
    beam('Glove thumb '+suffix,(side*.53,.003,.9),(side*.516,.044,.85),.034,.043,DARK,palm,.01)

    thigh, shin, foot = 'thigh.'+suffix,'shin.'+suffix,'foot.'+suffix
    hip, knee, ankle, toe = (side*.16,0,.88),(side*.17,.008,.51),(side*.18,0,.155),(side*.18,.18,.085)
    bones[thigh] = (hip,knee,'pelvis')
    bones[shin] = (knee,ankle,thigh)
    bones[foot] = (ankle,toe,shin)
    beam('Trouser thigh '+suffix,hip,knee,.224,.249,SUIT,thigh,.037)
    box('Thigh frontal panel '+suffix,(side*.17,.127,.708),(.171,.04,.212),ORANGE,thigh,.017)
    box('Thigh webbing '+suffix,(side*.175,0,.641),(.235,.268,.039),STRAP,thigh,.01)
    box('Outer thigh pocket '+suffix,(side*.30,.012,.727),(.071,.204,.167),SUIT,thigh,.014)
    box('Pocket fastener '+suffix,(side*.341,.05,.761),(.012,.062,.039),METAL,thigh,.003)
    cylinder('Knee flex joint '+suffix,knee,.09,.20,DARK,shin,(1,0,0))
    beam('Lower trouser '+suffix,knee,ankle,.176,.197,SUIT,shin,.027)
    box('Knee floating armor '+suffix,(side*.17,.134,.508),(.218,.082,.168),WHITE,shin,.026)
    box('Knee orange stripe '+suffix,(side*.17,.181,.508),(.14,.012,.034),ORANGE,shin,.005)
    box('Shin armor '+suffix,(side*.18,.11,.314),(.159,.064,.173),METAL,shin,.017)
    box('Shin safety strip '+suffix,(side*.18,.148,.331),(.029,.01,.11),ORANGE,shin,.003)
    box('Boot upper '+suffix,(side*.18,.025,.148),(.231,.252,.174),DARK,foot,.026)
    box('Boot toe shell '+suffix,(side*.18,.138,.096),(.244,.253,.119),WHITE,foot,.027)
    box('Boot sole '+suffix,(side*.18,.085,.033),(.259,.359,.064),DARK,foot,.008)
    for y in [-.057,.012,.081,.15,.219]:
        box('Boot tread '+suffix,(side*.18,y,.009),(.27,.032,.018),METAL,foot,.003)
    for z,y in [(.153,.117),(.188,.062)]:
        box('Boot buckle '+suffix,(side*.18,y,z),(.16,.021,.019),STRAP,foot,.003)

# A real armature, with rigid weights appropriate for segmented armor.
armature = bpy.data.armatures.new('RIVET skeleton')
rig = bpy.data.objects.new('RIVET_Rig',armature)
scene.collection.objects.link(rig)
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='EDIT')
for name,(head,tail,parent) in bones.items():
    bone = armature.edit_bones.new(name)
    bone.head, bone.tail = head, tail
    if parent:
        bone.parent = armature.edit_bones[parent]
bpy.ops.object.mode_set(mode='OBJECT')
rig.show_in_front = True
rig['asset_id'] = 'rivet-study-01'
rig['game_forward'] = '-Z after glTF export'
rig['authoring_units'] = 'meters'
for obj in parts:
    mod = obj.modifiers.new('Rivet skeleton deformation','ARMATURE')
    mod.object = rig
    obj.parent = rig
rig.animation_data_create()


def clip(name,length,walking=False):
    rig.animation_data.action = bpy.data.actions.new(name)
    action = rig.animation_data.action
    for frame in range(1,length+2,2):
        phase = (frame-1)/length*math.tau
        for p in rig.pose.bones:
            p.rotation_mode = 'XYZ'
            p.rotation_euler = (0,0,0)
            p.location = (0,0,0)
        rig.pose.bones['chest'].rotation_euler[0] = math.sin(phase)*(.025 if walking else .012)
        rig.pose.bones['head'].rotation_euler[1] = math.sin(phase)*.035
        rig.pose.bones['pelvis'].location[1] = (1-math.cos(phase*2))*(.012 if walking else .002)
        if walking:
            for side,suffix in [(-1,'R'),(1,'L')]:
                stride = math.sin(phase)*side
                rig.pose.bones['thigh.'+suffix].rotation_euler[0] = stride*.48
                rig.pose.bones['shin.'+suffix].rotation_euler[0] = max(0,-stride)*.65
                rig.pose.bones['foot.'+suffix].rotation_euler[0] = -max(0,-stride)*.25
                rig.pose.bones['upper_arm.'+suffix].rotation_euler[0] = -stride*.36
                rig.pose.bones['forearm.'+suffix].rotation_euler[0] = -.10-max(0,stride)*.20
        else:
            for side,suffix in [(-1,'R'),(1,'L')]:
                rig.pose.bones['upper_arm.'+suffix].rotation_euler[2] = side*math.sin(phase)*.01
        for p in rig.pose.bones:
            p.keyframe_insert('rotation_euler',frame=frame)
            if p.name=='pelvis': p.keyframe_insert('location',frame=frame)
    action.use_fake_user = True
    return action


idle = clip('Idle',72)
walk = clip('Walk',24,True)
rig.animation_data.action = None
for action in [idle,walk]:
    track = rig.animation_data.nla_tracks.new()
    track.name = action.name
    track.strips.new(action.name,1,action)
    track.mute = True
rig.animation_data.action = idle
scene.frame_start,scene.frame_end = 1,73
scene.frame_set(1)

# Studio and presentation camera are excluded from the game export.
material('Studio | charcoal',(0.048,.066,.076),roughness=.9)
material('Plinth | basalt',(.095,.123,.133),metallic=.25,roughness=.5)
box('Studio floor',(0,0,-.16),(200,200,.1),'Studio | charcoal',None,0)
bpy.ops.mesh.primitive_cylinder_add(vertices=64,radius=.89,depth=.11,location=(0,0,-.066))
finish(bpy.context.object,'Display plinth','Plinth | basalt',None,.015)


def light(name,pos,energy,color,size,target=(0,0,1)):
    data = bpy.data.lights.new(name,'AREA')
    data.energy, data.color, data.shape, data.size = energy,color,'DISK',size
    obj = bpy.data.objects.new(name,data)
    scene.collection.objects.link(obj)
    obj.location = pos
    obj.rotation_euler = (Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()


light('Key softbox',(-3,4.5,5),430,(1,.88,.72),3.5)
light('Cool edge',(2,-3,3.6),550,(.48,.77,1),2.5)
light('Front fill',(3,4,2),190,(.80,.92,1),2.5)
light('Top warm',(-1,-1,4.5),180,(1,.47,.22),2)
camera_data = bpy.data.cameras.new('Rivet portrait lens')
camera = bpy.data.objects.new('Rivet portrait camera',camera_data)
scene.collection.objects.link(camera)
camera.location = (3.0,5.2,2.65)
camera.rotation_euler = (Vector((0,0,.96))-camera.location).to_track_quat('-Z','Y').to_euler()
camera_data.type = 'ORTHO'
camera_data.ortho_scale = 2.48
scene.camera = camera
for area in bpy.context.screen.areas:
    if area.type == 'VIEW_3D':
        area.spaces.active.region_3d.view_perspective = 'CAMERA'
        area.spaces.active.shading.type = 'MATERIAL'
        area.spaces.active.overlay.show_overlays = False

# Bake a compact skin mesh in a separate export collection, keep editable parts.
source_collection = bpy.data.collections.new('SOURCE | individually editable armor parts')
scene.collection.children.link(source_collection)
export_collection = bpy.data.collections.new('EXPORT | rig and merged skin')
scene.collection.children.link(export_collection)
export_collection.objects.link(rig)
scene.collection.objects.unlink(rig)
duplicates = []
for obj in parts:
    for collection in list(obj.users_collection): collection.objects.unlink(obj)
    source_collection.objects.link(obj)
    duplicate = obj.copy()
    duplicate.data = obj.data.copy()
    export_collection.objects.link(duplicate)
    duplicates.append(duplicate)
bpy.ops.object.select_all(action='DESELECT')
for obj in duplicates: obj.select_set(True)
bpy.context.view_layer.objects.active = duplicates[0]
bpy.ops.object.join()
skin = bpy.context.object
skin.name = 'RIVET_SkinnedMesh'
source_collection.hide_render = True
source_collection.hide_viewport = True
skin.data.calc_loop_triangles()
bpy.ops.object.select_all(action='DESELECT')
skin.select_set(True)
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.export_scene.gltf(
    filepath=str(OUT/'rivet.glb'),export_format='GLB',use_selection=True,use_active_scene=True,
    export_animations=True,export_animation_mode='ACTIONS',
    export_anim_single_armature=False,export_skins=True,export_extras=True,export_yup=True,
)
manifest = {
    'asset':'RIVET', 'stage':'Blender character study, not integrated into gameplay',
    'blender':bpy.app.version_string,'meters':True,'forward_after_gltf':'-Z',
    'editable_parts':len(parts),'skin_meshes':1,'materials':len(skin.data.materials),
    'triangles':len(skin.data.loop_triangles),'bones':list(bones),
    'animations':['Idle','Walk'],'rigging':'Rigid armor weights, no facial or finger rig',
    'authoring_source':'tools/blender/build-character.py',
    'glb_bytes':(OUT/'rivet.glb').stat().st_size,
    'integration_remaining':['GLB loading and rig adapter','Weapon hand targets',
       'Stance, damage, gore and team-color mapping','Mobile draw-call and animation budget'],
}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
scene.render.filepath = str(OUT/'rivet-front.png')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'rivet.blend'))
print(json.dumps(manifest,indent=2))
