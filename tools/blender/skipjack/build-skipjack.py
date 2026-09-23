"""Rebuild the ImageGen-selected GL-3 SKIPJACK grenade-launcher concept.

Run in the connected Blender 5.x session through Blender MCP:

    from pathlib import Path
    p = Path('/Users/logge/Documents/Projects/voxel-blitz/tools/blender/skipjack/build-skipjack.py')
    exec(compile(p.read_text(), str(p), 'exec'), {'__file__': str(p), '__name__': '__main__'})

The source scene is kept in docs/design/blender/skipjack/skipjack.blend. The
game-facing glTF uses the standard five-part Voxel Blitz gun contract and the
shared palette texture finalizer. Authoring space is +Y forward, +Z up, +X right.
"""
import bpy
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[3]
SLUG = 'skipjack'
ASSET = 'SKIPJACK'
OUT = ROOT / 'docs/design/blender/skipjack'
GAME_ASSETS = ROOT / 'public/assets/blender'
OUT.mkdir(parents=True, exist_ok=True)

GROUP_NAMES = ('body', 'mag', 'bolt', 'trigger', 'extra')
MATERIAL_KEYS = ('gunmetal', 'machined steel', 'olive drab', 'dark polymer',
                 'rubber', 'orange paint', 'brass', 'phosphor')
UV_SCALE = 3.6
PARTS = []

# Stable viewmodel anchors: game muzzle (0, .075, -.72), hand grip and support,
# and sight line. Blender authoring coordinates map as game=(x,z,-y).
ANCHORS = {
    'muzzle': (0.000, 0.720, 0.075),
    'grip': (0.047, 0.056, -0.203),
    'support': (-0.058, 0.373, -0.184),
    'sight': (0.000, 0.337, 0.291),
}

SCENE_NAME = f'{ASSET} | GL-3 grenade launcher study'
REBUILD_SENTINEL = f'{ASSET} | temporary rebuild sentinel'
for obj in list(bpy.data.objects):
    if (obj.get('skipjack_material') is not None or obj.get('blenderAsset') == SLUG
            or obj.name.split('.')[0] in GROUP_NAMES
            or obj.name.startswith(('authoring |', 'studio |'))):
        bpy.data.objects.remove(obj, do_unlink=True)
for sc in list(bpy.data.scenes):
    if sc.name == SCENE_NAME:
        if len(bpy.data.scenes) == 1:
            bpy.data.scenes.new(REBUILD_SENTINEL)
        bpy.data.scenes.remove(sc)

scene = bpy.data.scenes.new(SCENE_NAME)
for old_scene in list(bpy.data.scenes):
    if old_scene.name == REBUILD_SENTINEL:
        bpy.data.scenes.remove(old_scene)
for material in list(bpy.data.materials):
    if material.name.split('.')[0].startswith(f'{ASSET} |'):
        bpy.data.materials.remove(material, do_unlink=True)
for collection in list(bpy.data.collections):
    if collection.name.split('.')[0].startswith(f'{ASSET} |') and collection.users == 0:
        bpy.data.collections.remove(collection)
for world_data in list(bpy.data.worlds):
    if world_data.name.split('.')[0].startswith(f'{ASSET} |') and world_data.users == 0:
        bpy.data.worlds.remove(world_data)
for win in bpy.context.window_manager.windows:
    win.scene = scene
for old_scene in list(bpy.data.scenes):
    if old_scene is scene or old_scene.name != 'Scene':
        continue
    if {obj.name for obj in old_scene.objects} <= {'Cube', 'Camera', 'Light'}:
        for obj in list(old_scene.objects): bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.scenes.remove(old_scene)
scene.unit_settings.system = 'METRIC'
scene.render.engine = 'CYCLES'
scene.cycles.samples = 96
scene.cycles.use_denoising = True
scene.cycles.seed = 20260923
scene.render.resolution_x = 1680
scene.render.resolution_y = 1120
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'
scene.render.film_transparent = False
world = bpy.data.worlds.new(f'{ASSET} | softbox world')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (.105, .13, .16, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = .16
scene.world = world

source_collection = bpy.data.collections.new(f'{ASSET} | authored parts')
scene.collection.children.link(source_collection)
runtime_collection = bpy.data.collections.new(f'{ASSET} | game export')
scene.collection.children.link(runtime_collection)
studio_collection = bpy.data.collections.new(f'{ASSET} | studio')
scene.collection.children.link(studio_collection)
groups = {}
for name in GROUP_NAMES:
    empty = bpy.data.objects.new(name, None)
    empty.name = f'authoring | {name}'
    empty.empty_display_type = 'CIRCLE'
    empty.empty_display_size = .035
    source_collection.objects.link(empty)
    groups[name] = empty
# Drop the complete side-swing cassette below the receiver so the three live
# 40 mm rounds remain readable in the normal side-on player/HUD views.
groups['mag'].location.z = -0.17

materials = {}
for key, rgba, metallic, roughness in [
    ('gunmetal', (.105, .145, .160, 1), .68, .34),
    ('machined steel', (.37, .44, .45, 1), .82, .26),
    ('olive drab', (.20, .245, .19, 1), .28, .49),
    ('dark polymer', (.035, .050, .054, 1), .04, .73),
    ('rubber', (.018, .024, .026, 1), .0, .88),
    ('orange paint', (.96, .245, .045, 1), .18, .4),
    ('brass', (.48, .29, .095, 1), .72, .31),
    ('phosphor', (.12, .82, .32, 1), .0, .32),
]:
    mat = bpy.data.materials.new(f'{ASSET} | {key}')
    mat.diffuse_color = rgba
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = rgba
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if key == 'phosphor':
        if 'Emission Color' in bsdf.inputs:
            bsdf.inputs['Emission Color'].default_value = (.025, .62, .13, 1)
            bsdf.inputs['Emission Strength'].default_value = 2.0
        else:
            bsdf.inputs['Emission'].default_value = (.025, .62, .13, 1)
    materials[key] = mat


def active_obj():
    return bpy.context.object


def link_part(obj, name, group, material, bevel=0.0015, smooth=False):
    obj.name = name
    obj.data.name = f'{name} mesh'
    obj.parent = groups[group]
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.data.materials.clear()
    obj.data.materials.append(materials[material])
    obj['part'] = group
    obj['skipjack_material'] = material
    source_collection.objects.link(obj) if obj.name not in source_collection.objects else None
    for poly in obj.data.polygons:
        poly.use_smooth = smooth
    if bevel > 0:
        mod = obj.modifiers.new('machined edge chamfers', 'BEVEL')
        mod.width = bevel
        mod.segments = 2 if bevel >= .006 else 1
        mod.limit_method = 'ANGLE'
        mod.angle_limit = math.radians(28)
        mod.use_clamp_overlap = True
        mod2 = obj.modifiers.new('weighted corner normals', 'WEIGHTED_NORMAL')
        mod2.keep_sharp = True
    uv = obj.data.uv_layers.new(name='UVMap') if not obj.data.uv_layers else obj.data.uv_layers[0]
    for poly in obj.data.polygons:
        axis = max(range(3), key=lambda i: abs(poly.normal[i]))
        first, second = ((1, 2), (0, 2), (0, 1))[axis]
        for loop in poly.loop_indices:
            co = obj.data.vertices[obj.data.loops[loop].vertex_index].co
            uv.data[loop].uv = (co[first] * UV_SCALE, co[second] * UV_SCALE)
    PARTS.append(obj)
    return obj


def box(name, group, mat, loc, size, bevel=.002):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = active_obj()
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return link_part(obj, name, group, mat, bevel)


def cylinder(name, group, mat, loc, radius, depth, axis='Y', verts=24,
             bevel=.0012, radius_top=None):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=radius,
        radius2=radius if radius_top is None else radius_top, depth=depth,
        location=loc)
    obj = active_obj()
    if axis == 'Y':
        obj.rotation_euler[0] = math.pi / 2
    elif axis == 'X':
        obj.rotation_euler[1] = math.pi / 2
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return link_part(obj, name, group, mat, bevel, smooth=True)


def torus(name, group, mat, loc, major, minor, axis='Y', segments=32, ring_segments=8):
    bpy.ops.mesh.primitive_torus_add(major_segments=segments,
        minor_segments=ring_segments, major_radius=major, minor_radius=minor,
        location=loc)
    obj = active_obj()
    if axis == 'X': obj.rotation_euler[1] = math.pi / 2
    elif axis == 'Y': obj.rotation_euler[0] = math.pi / 2
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return link_part(obj, name, group, mat, 0, smooth=True)


def rod_between(name, group, mat, a, b, radius, verts=10):
    av, bv = Vector(a), Vector(b)
    delta = bv-av
    obj = cylinder(name, group, mat, (av+bv)*.5, radius, delta.length,
                   axis='Z', verts=verts, bevel=0)
    obj.rotation_euler = delta.to_track_quat('Z', 'Y').to_euler()
    return obj


def arc(name, group, mat, center, radius, start, end, plane='YZ', tube=.004, steps=20):
    pts=[]
    for i in range(steps+1):
        a=start+(end-start)*i/steps
        if plane=='YZ': pts.append((center[0], center[1]+radius*math.cos(a), center[2]+radius*math.sin(a)))
        elif plane=='XZ': pts.append((center[0]+radius*math.cos(a), center[1], center[2]+radius*math.sin(a)))
        else: pts.append((center[0]+radius*math.cos(a), center[1]+radius*math.sin(a), center[2]))
    cu=bpy.data.curves.new(name,'CURVE');cu.dimensions='3D';cu.resolution_u=2
    cu.bevel_depth=tube;cu.bevel_resolution=2
    sp=cu.splines.new('POLY');sp.points.add(len(pts)-1)
    for p,v in zip(sp.points,pts):p.co=(*v,1)
    obj=bpy.data.objects.new(name,cu);source_collection.objects.link(obj)
    bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active=obj
    bpy.ops.object.convert(target='MESH')
    obj=active_obj()
    return link_part(obj,name,group,mat,0,smooth=True)


def text_label(label, name, group, material, loc, size, rot=(math.pi/2,0,0), extrude=.0005):
    cu=bpy.data.curves.new(name,'FONT');cu.body=label;cu.size=size;cu.extrude=extrude;cu.resolution_u=2
    cu.align_x='CENTER';cu.align_y='CENTER'
    obj=bpy.data.objects.new(name,cu);source_collection.objects.link(obj)
    obj.location=loc;obj.rotation_euler=rot
    bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active=obj
    bpy.ops.object.convert(target='MESH')
    return link_part(active_obj(),name,group,material,0)


def radial(angle, radius, center=(0.0, .20, -.14)):
    return (center[0] + radius*math.sin(angle), center[1], center[2] + radius*math.cos(angle))


# ---------------------------------------------------------------------------
# Receiver and barrel: compact under-slung three-chamber design, with an open
# protective cage so the three loaded 40 mm rounds read clearly in first person.
# ---------------------------------------------------------------------------
# Main upper receiver and its layered shoulder / cheek surfaces.
box('receiver | forged upper', 'body', 'olive drab', (0,.245,.055), (.205,.355,.195), .012)
box('receiver | crown rail', 'body', 'gunmetal', (0,.255,.163), (.116,.405,.030), .004)
box('receiver | top armor plate', 'body', 'dark polymer', (0,.255,.183), (.088,.335,.014), .002)
box('receiver | orange safety stripe', 'body', 'orange paint', (0,.404,.171), (.058,.075,.006), .001)
box('receiver | lower spine', 'body', 'gunmetal', (0,.18,-.084), (.15,.26,.040), .004)
for side in (-1,1):
    box(f'receiver | cheek panel {side:+}', 'body', 'dark polymer', (side*.107,.25,.045), (.016,.267,.111), .004)
    box(f'receiver | inset armor {side:+}', 'body', 'olive drab', (side*.117,.245,.054), (.008,.191,.074), .003)
    # Three recessed pressure ribs and two pinned cheek-panel fasteners.
    for i in range(3):
        box(f'receiver | cheek rib {side:+} {i}', 'body', 'gunmetal',
            (side*.123,.205+i*.041,.079), (.004,.006,.051), .001)
    for yy in (.173,.326):
        cylinder(f'receiver | quarter-turn latch {side:+} {yy:.3f}', 'body', 'brass',
                 (side*.125,yy,.047), .009,.005,axis='X',verts=12,bevel=.0004)
        box(f'receiver | latch slot {side:+} {yy:.3f}', 'body', 'dark polymer',
            (side*.128,yy,.047), (.002,.007,.0014), .0003)

# Short 40 mm launch tube; dark bore liner is visible through the muzzle.
z_bore=.075
cylinder('barrel | pressure tube', 'body', 'gunmetal', (0,.526,z_bore), .040,.394,verts=32,bevel=.002)
cylinder('barrel | bore shadow', 'body', 'dark polymer', (0,.727,z_bore), .035,.003,verts=32,bevel=0)
cylinder('barrel | crown lip', 'body', 'machined steel', (0,.716,z_bore), .055,.023,verts=32,bevel=.001)
cylinder('barrel | muzzle shroud', 'body', 'olive drab', (0,.630,z_bore), .060,.155,verts=32,bevel=.003)
cylinder('barrel | forward ferrule', 'body', 'gunmetal', (0,.689,z_bore), .064,.022,verts=32,bevel=.001)
cylinder('barrel | ferrule orange datum', 'body', 'orange paint', (0,.675,z_bore), .065,.006,verts=32,bevel=0)
torus('barrel | muzzle machined bead','body','machined steel',(0,.719,z_bore),.050,.0027)
# Eight recessed cooling slots with raised chamfered surrounds.
for i in range(8):
    a=2*math.pi*i/8
    x=math.sin(a)*.058
    z=z_bore+math.cos(a)*.058
    box(f'barrel | vent recess {i+1}', 'body','dark polymer',(x,.624,z),(.009,.071,.004),.001)
    box(f'barrel | vent lip {i+1}', 'body','gunmetal',(x,.624,z+.003),(.014,.077,.003),.001)
# Side rails with open key slots, clear of the barrel's thermal sleeve.
for side in (-1,1):
    box(f'barrel | accessory rail {side:+}', 'body','gunmetal',(side*.066,.493,.09),(.020,.291,.022),.002)
    for i in range(8):
        box(f'barrel | rail notch {side:+} {i}', 'body','dark polymer',
            (side*.077,.377+i*.032,.09),(.003,.014,.014),.0008)

# Three-round side-swing cassette (mag group). All three cartridges are live,
# separately modelled 40 mm shells. An open triad shroud exposes the round tips.
drum_center=(0,.198,-.050)
cylinder('cassette | rotary drum core','mag','dark polymer',(0,.202,-.050),.045,.222,axis='Y',verts=32,bevel=.001)
torus('cassette | forward cage hoop','mag','gunmetal',(0,.321,-.050),.151,.009,axis='Y',segments=48)
torus('cassette | rear cage hoop','mag','gunmetal',(0,.083,-.050),.151,.009,axis='Y',segments=48)
cylinder('cassette | central spindle','mag','brass',(0,.198,-.050),.028,.279,axis='Y',verts=24,bevel=.001)
cylinder('cassette | ratchet plate','mag','gunmetal',(0,.333,-.050),.048,.012,axis='Y',verts=32,bevel=.001)
cylinder('cassette | ratchet hub','mag','brass',(0,.343,-.050),.023,.010,axis='Y',verts=20,bevel=.0008)
for i,a in enumerate((0, 2*math.pi/3, 4*math.pi/3), start=1):
    pos=radial(a,.118,drum_center)
    shellx, shell_y, pz=pos
    # Chamber throat and shell sit parallel to the bore, with the top round
    # aligned behind the launch tube and the lower pair forming a triad.
    cylinder(f'cassette | chamber liner {i}','mag','gunmetal',(shellx,.202,pz),.023,.240,axis='Y',verts=20,bevel=.0007)
    for yy in (.078,.326):
        cylinder(f'cassette | chamber rim {i} {yy:.3f}','mag','machined steel',(shellx,yy,pz),.033,.008,axis='Y',verts=24,bevel=.0006)
    cylinder(f'round {i} | olive casing','mag','olive drab',(shellx,.205,pz),.026,.178,verts=20,bevel=.001)
    cylinder(f'round {i} | brass base','mag','brass',(shellx,.116,pz),.027,.018,verts=20,bevel=.0006)
    cylinder(f'round {i} | orange arming band','mag','orange paint',(shellx,.171,pz),.0275,.009,verts=20,bevel=.0004)
    cylinder(f'round {i} | low profile ogive','mag','machined steel',(shellx,.297,pz),.022,.035,verts=20,bevel=.0005,radius_top=.004)
    cylinder(f'round {i} | luminous primer','mag','phosphor',(shellx,.316,pz),.008,.003,verts=12,bevel=0)
    for k in range(3):
        box(f'round {i} | case flute {k+1}','mag','gunmetal',
            (shellx,.222,pz+(k-1)*.007),(.029,.004,.0015),.0003)
# Hinged side cradle, release pins and a chunky orange quarter-turn catch.
for side in (-1,1):
    arc(f'cassette | side cradle {side:+}','mag','olive drab',(side*.105,.198,-.050),.157,
        math.radians(-135),math.radians(135),'YZ',.006,30)
    cylinder(f'cassette | hinge pin {side:+}','mag','brass',(side*.151,.112,-.050),.018,.010,axis='X',verts=16,bevel=.0006)
    cylinder(f'cassette | latch pin {side:+}','mag','machined steel',(side*.151,.289,-.050),.015,.010,axis='X',verts=16,bevel=.0006)
box('cassette | latch bridge','mag','gunmetal',(0,.302,.114),(.085,.047,.018),.003)
box('cassette | orange release tab','mag','orange paint',(0,.325,.125),(.036,.023,.008),.002)

# Grip with a curved heel, stippled backstrap and three raised finger ledges.
box('grip | skeleton','body','dark polymer',(.047,.056,-.203),(.104,.127,.234),.012)
box('grip | front strap','body','rubber',(.047,.112,-.220),(.101,.022,.179),.008)
box('grip | backstrap','body','rubber',(.047,.001,-.203),(.099,.020,.196),.006)
for i in range(8):
    z=-.282+i*.021
    box(f'grip | backstrap traction rib {i+1}','body','dark polymer',(.047,-.012,z),(.100,.009,.004),.001)
for i in range(4):
    z=-.274+i*.041
    box(f'grip | finger scallop ledge {i+1}','body','olive drab',(.047,.125,z),(.082,.012,.012),.003)
for side in (-1,1):
    box(f'grip | side scale {side:+}','body','olive drab',(.047+side*.055,.05,-.205),(.008,.090,.15),.004)
    for k in range(6):
        box(f'grip | scale checkering {side:+} {k+1}','body','gunmetal',
            (.047+side*.060,.012+k*.015,-.247),(.002,.006,.003),.0007)

# Forward angled hand stop and a fluted under-barrel support grip.
box('foregrip | mounting foot','body','gunmetal',(-.058,.366,-.080),(.074,.119,.031),.003)
box('foregrip | saddle','body','olive drab',(-.058,.373,-.125),(.070,.084,.105),.008)
box('foregrip | palm swell','body','dark polymer',(-.058,.373,-.184),(.081,.078,.105),.010)
for i in range(7):
    box(f'foregrip | diagonal grip rib {i+1}','body','rubber',(-.058,.339+i*.011,-.184),(.083,.004,.083),.0015)
box('foregrip | orange index','body','orange paint',(-.058,.418,-.125),(.048,.013,.004),.001)

# Trigger group with a deep guard, return coil and tactile shoe.
arc('trigger | swept guard','trigger','gunmetal',(0,.073,-.105),.055,math.pi*1.05,math.pi*1.95,'YZ',.004,24)
rod_between('trigger | pivot pin','trigger','brass',(0,.068,-.108),(.068,.068,-.108),.006,12)
rod_between('trigger | curved shoe','trigger','machined steel',(.026,.070,-.111),(.039,.087,-.157),.006,10)
rod_between('trigger | return spring','trigger','gunmetal',(-.013,.072,-.113),(-.013,.072,-.146),.003,12)

# Moving bolt / rotary advance indicator. Detail stays in a pivot-local group.
box('bolt | advancing pawl','bolt','machined steel',(0,.177,.119),(.055,.084,.013),.002)
cylinder('bolt | index drum','bolt','gunmetal',(.051,.176,.119),.018,.012,axis='X',verts=20,bevel=.0008)
cylinder('bolt | thumb cap','bolt','orange paint',(.059,.176,.119),.010,.005,axis='X',verts=16,bevel=.0005)
box('bolt | returned position plate','bolt','dark polymer',(0,.124,.125),(.039,.025,.004),.001)

# Feed access, tactile selector, rear brace, sight housing, and engraved labels.
for side in (-1,1):
    cylinder(f'feed | service cover {side:+}','extra','gunmetal',(side*.132,.25,.053),.031,.012,axis='X',verts=32,bevel=.001)
    torus(f'feed | service cover bead {side:+}','extra','machined steel',(side*.140,.25,.053),.022,.0018,axis='X')
    cylinder(f'feed | axle cap {side:+}','extra','brass',(side*.148,.25,.053),.008,.006,axis='X',verts=16,bevel=.0005)
    box(f'feed | ejector rail {side:+}','extra','gunmetal',(side*.108,.108,-.002),(.018,.090,.024),.003)
    for i in range(4):
        box(f'feed | ejector grip notch {side:+} {i+1}','extra','dark polymer',
            (side*.119,.078+i*.020,-.002),(.004,.008,.017),.001)
# Three round index marks and one spare-round lamp on the right cassette cheek.
for i,a in enumerate((0, 2*math.pi/3, 4*math.pi/3), start=1):
    y,z=drum_center[1]+.118*math.sin(a),drum_center[2]+.118*math.cos(a)
    cylinder(f'feed | chamber index {i}','extra','orange paint',(.153,y,z),.006,.004,axis='X',verts=12,bevel=0)
box('receiver | selector plate','extra','dark polymer',(.128,.371,.074),(.012,.067,.060),.003)
cylinder('receiver | fire selector','extra','brass',(.140,.372,.077),.016,.010,axis='X',verts=20,bevel=.0008)
box('receiver | selector lever','extra','orange paint',(.147,.381,.081),(.022,.041,.006),.002)
box('receiver | round counter bezel','extra','gunmetal',(.129,.227,.126),(.011,.078,.039),.003)
box('receiver | round counter glass','extra','dark polymer',(.136,.227,.126),(.004,.061,.025),.001)
box('receiver | counter segments','extra','phosphor',(.139,.227,.127),(.002,.035,.009),.0002)
for i in range(5):
    box(f'receiver | counter tick {i+1}','extra','orange paint',(.139,.205+i*.011,.114),(.002,.003,.004),0)

# Low, fast acquisition reflex sight: hood, armored lens, rear notch and green dot.
box('sight | foot','body','gunmetal',(0,.346,.207),(.077,.140,.027),.003)
box('sight | riser','body','dark polymer',(0,.347,.228),(.064,.091,.027),.003)
box('sight | hood lower rail','body','gunmetal',(0,.374,.255),(.093,.111,.012),.002)
arc('sight | armored window','body','gunmetal',(0,.338,.281),.041,-.62,3.78,'XZ',.0045,28)
rod_between('sight | armored forward pillar','body','gunmetal',(0,.378,.249),(0,.378,.317),.006,8)
rod_between('sight | armored rear pillar','body','gunmetal',(0,.297,.249),(0,.297,.317),.006,8)
box('sight | top bridge','body','gunmetal',(0,.337,.317),(.076,.073,.008),.002)
box('sight | orange index stripe','body','orange paint',(0,.337,.323),(.043,.042,.003),.0006)
cylinder('sight | green dot emitter','extra','phosphor',(0,.332,.291),.0035,.010,axis='Y',verts=12,bevel=0)
for side in (-1,1):
    cylinder(f'sight | windage knob {side:+}','extra','brass',(side*.050,.338,.263),.013,.010,axis='X',verts=16,bevel=.0007)

# Real modeled identification / calibre marks on both flanks.
text_label('GL-3','marking | model id','body','machined steel',(.127,.244,.070),.022,rot=(math.pi/2,0,math.pi/2),extrude=.0003)
text_label('SKIPJACK','marking | name','body','orange paint',(.127,.242,.044),.010,rot=(math.pi/2,0,math.pi/2),extrude=.00025)
text_label('40 MM','marking | calibre','body','machined steel',(.127,.211,.018),.008,rot=(math.pi/2,0,math.pi/2),extrude=.0002)
text_label('03 / ROTARY','marking | feed','body','brass',(-.127,.234,.070),.009,rot=(math.pi/2,0,-math.pi/2),extrude=.0002)
text_label('40 MM • IMPACT','marking | shell spec','body','machined steel',(-.127,.213,.045),.0065,rot=(math.pi/2,0,-math.pi/2),extrude=.00015)

# A row of top-rail teeth, receiver screws, connector pins, and utility ribs.
for i in range(9):
    box(f'rail | recoil lug {i+1}','body','machined steel',(0,.090+i*.039,.197),(.073,.015,.009),.002)
for side in (-1,1):
    for i,yy in enumerate((.121,.177,.344,.405)):
        cylinder(f'receiver | flush torx fastener {side:+} {i+1}','body','machined steel',
                 (side*.122,yy,.110),.0055,.003,axis='X',verts=12,bevel=.0004)
    for i in range(5):
        box(f'receiver | cooling louvre {side:+} {i+1}','body','dark polymer',
            (side*.120,.151+i*.031,-.017),(.006,.004,.047),.001)

# Small serial / safety panels, rear buffer, and chamber-swap handle.
box('rear | shoulder buffer','body','rubber',(0,.018,-.016),(.175,.054,.142),.009)
box('rear | orange latch','extra','orange paint',(0,.035,.065),(.049,.030,.012),.002)
rod_between('cassette | release bail left','extra','brass',(-.157,.110,-.050),(-.157,.151,-.050),.0035,8)
rod_between('cassette | release bail lower','extra','brass',(-.157,.151,-.050),(-.157,.151,-.010),.0035,8)
box('safety | instruction tag','extra','dark polymer',(.130,.404,.094),(.010,.070,.027),.002)
text_label('ARM','marking | selector','extra','orange paint',(.136,.404,.095),.006,rot=(math.pi/2,0,math.pi/2),extrude=.0001)

# Four anchor empties are intentionally plain and stable for viewmodel posing.
for name, loc in ANCHORS.items():
    marker=bpy.data.objects.new(name,None);marker.empty_display_type='SPHERE';marker.empty_display_size=.012
    marker.name=f'authoring | anchor {name}'
    marker.location=loc;source_collection.objects.link(marker);marker['blenderAsset']=SLUG

# Studio presentation objects sit on a dark sweep and are omitted from export.
floor_mat=bpy.data.materials.new(f'{ASSET} | backdrop');floor_mat.diffuse_color=(.023,.032,.039,1)
floor_mat.use_nodes=True;floor_mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.023,.032,.039,1)
floor_mat.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=.68
bpy.ops.mesh.primitive_plane_add(size=200, location=(0,.28,-.415))
floor=active_obj();floor.name='studio | ground';floor.data.materials.append(floor_mat);studio_collection.objects.link(floor)

def area(name, loc, power, color, size, target):
    data=bpy.data.lights.new(name,'AREA');data.energy=power;data.color=color;data.shape='DISK';data.size=size
    ob=bpy.data.objects.new(name,data);studio_collection.objects.link(ob);ob.location=loc
    ob.rotation_euler=(Vector(target)-ob.location).to_track_quat('-Z','Y').to_euler();return ob

area('studio | key softbox',(1.4,-.6,1.6),210,(.72,.85,1),1.4,(0,.34,0))
area('studio | warm edge',(-1.15,.48,.78),280,(1,.47,.20),.9,(0,.36,0))
area('studio | overhead strip',(.1,.75,1.3),185,(.46,1,.76),1.1,(0,.37,-.02))
area('studio | muzzle fill',(0,1.35,.36),120,(.72,.85,1),.65,(0,.55,.05))
cam_data=bpy.data.cameras.new('studio | hero camera');cam=bpy.data.objects.new('studio | hero camera',cam_data)
studio_collection.objects.link(cam);cam.location=(1.42,-.02,.54)
target=Vector((0,.36,-.025));cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler()
cam_data.type='ORTHO';cam_data.ortho_scale=1.22;scene.camera=cam

# Preserve the detailed editable construction and create one joined runtime mesh
# per part/material. That keeps the in-game draw budget under control while the
# source .blend retains separately named parts and modifiers.
runtime_groups={}
for name in GROUP_NAMES:
    empty=bpy.data.objects.new(name,None);empty.empty_display_type='PLAIN_AXES';empty.empty_display_size=.045
    runtime_collection.objects.link(empty);runtime_groups[name]=empty

source_objects=[o for o in source_collection.objects if o.type=='MESH' and o.get('part') in GROUP_NAMES]
for part in GROUP_NAMES:
    for material_key in MATERIAL_KEYS:
        candidates=[]
        for original in source_objects:
            if original.get('part')!=part or not original.data.materials or original.data.materials[0].name != f'{ASSET} | {material_key}':
                continue
            dup=original.copy();dup.data=original.data.copy();dup.parent=None
            dup.matrix_world=original.matrix_world.copy();runtime_collection.objects.link(dup)
            bpy.ops.object.select_all(action='DESELECT');dup.select_set(True);bpy.context.view_layer.objects.active=dup
            for modifier in list(dup.modifiers):
                try: bpy.ops.object.modifier_apply(modifier=modifier.name)
                except Exception: pass
            candidates.append(dup)
        if not candidates: continue
        bpy.ops.object.select_all(action='DESELECT')
        for obj in candidates: obj.select_set(True)
        bpy.context.view_layer.objects.active=candidates[0]
        bpy.ops.object.join()
        merged=active_obj();merged.name=f'{part} | {material_key}'
        merged.parent=runtime_groups[part];merged.matrix_parent_inverse=Matrix.Identity(4)
        merged['blenderAsset']=SLUG;merged['part']=part
        # Bake bevel and weighted-normal modifiers before export and triangle accounting.
        bpy.ops.object.select_all(action='DESELECT');merged.select_set(True);bpy.context.view_layer.objects.active=merged
        for modifier in list(merged.modifiers):
            try: bpy.ops.object.modifier_apply(modifier=modifier.name)
            except Exception: pass

for name, loc in ANCHORS.items():
    marker=bpy.data.objects.new(name,None);runtime_collection.objects.link(marker);marker.location=loc
    marker.name=name;marker.empty_display_type='PLAIN_AXES';marker.empty_display_size=.012;marker['blenderAsset']=SLUG

# Count the model before export and guard the runtime complexity contract.
draw_count=sum(1 for o in runtime_collection.objects if o.type=='MESH')
triangles=sum(sum(max(0,p.loop_total-2) for p in o.data.polygons) for o in runtime_collection.objects if o.type=='MESH')
if draw_count > 32: raise RuntimeError(f'{draw_count} material batches exceed the 32-draw asset budget')
if triangles > 26000: raise RuntimeError(f'{triangles} triangles exceed the 26k asset budget')

# Store the source with both the editable art and compact runtime hierarchy.
bpy.context.window.scene=scene
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'skipjack.blend'), check_existing=False)

# Export only game collection objects, leaving source geometry and studio gear out.
bpy.ops.object.select_all(action='DESELECT')
for obj in runtime_collection.objects: obj.select_set(True)
bpy.context.view_layer.objects.active=runtime_groups['body']
gltf_path=GAME_ASSETS/'skipjack.gltf'
gltf_path.parent.mkdir(parents=True,exist_ok=True)
rna=bpy.ops.export_scene.gltf.get_rna_type()
available={p.identifier for p in rna.properties}
kwargs={
    'filepath':str(gltf_path),'export_format':'GLTF_SEPARATE','export_yup':True,
    'export_apply':True,'export_materials':'EXPORT','export_texcoords':True,
    'export_normals':True,'export_cameras':False,'export_lights':False,
    'use_selection':True,'export_extras':True,'export_animations':False,
    'export_skins':False,'export_image_format':'AUTO','export_keep_originals':True,
}
bpy.ops.export_scene.gltf(**{k:v for k,v in kwargs.items() if k in available})

# Keep the runtime asset inventory in sync with the exported binary geometry.
runtime_manifest_path = GAME_ASSETS / 'manifest.json'
runtime_manifest = json.loads(runtime_manifest_path.read_text())
runtime_manifest['assets'] = [entry for entry in runtime_manifest.get('assets', [])
                              if entry.get('asset') != SLUG]
runtime_manifest['assets'].append({
    'asset': SLUG,
    'source_parts': len(source_objects),
    'draws': draw_count,
    'triangles': triangles,
    'geometry_bytes': gltf_path.with_suffix('.bin').stat().st_size,
})
runtime_manifest['assets'].sort(key=lambda entry: entry['asset'])
runtime_manifest_path.write_text(json.dumps(runtime_manifest, indent=2) + '\n')

# Portable all-in-one GLB is kept with the Blender source for reviews and handoff.
portable={k:v for k,v in kwargs.items() if k in available}
portable.update({'filepath':str(OUT/'skipjack.glb'),'export_format':'GLB'})
bpy.ops.export_scene.gltf(**portable)

# Run the shared material finalizer while this live Blender scene is available.
library_script=ROOT/'tools/blender/material-library.py'
namespace={'__file__':str(library_script),'__name__':'vb_material_library'}
exec(compile(library_script.read_text(),str(library_script),'exec'),namespace)
if SLUG not in namespace['ASSETS']:
    raise RuntimeError('Add skipjack to material-library/materials.json assets before finishing materials')
material_result=namespace['finish_asset'](SLUG,scene=scene)

# Save a deterministic studio proof image with construction art visible and the
# duplicate runtime export collection hidden from the hero render.
for obj in runtime_collection.objects: obj.hide_render=True
for obj in studio_collection.objects: obj.hide_render=False
scene.render.filepath=str(OUT/'skipjack-hero.png')
bpy.context.window.scene=scene
bpy.ops.render.render(write_still=True)
for obj in runtime_collection.objects: obj.hide_render=False

manifest={
    'asset':'GL-3 SKIPJACK','asset_id':SLUG,'weapon_id':'mgl','revision':1,
    'axis_contract':{'authoring_forward':'+Y','authoring_up':'+Z','authoring_right':'+X',
                     'game_mapping':'x=x, y=z, z=-y'},
    'anchors_authoring':{k:list(v) for k,v in ANCHORS.items()},
    'source_parts':len(source_objects),'runtime_draws':draw_count,'triangles':triangles,
    'runtime_gltf':'public/assets/blender/skipjack.gltf',
    'portable_glb':'docs/design/blender/skipjack/skipjack.glb',
    'blend':'docs/design/blender/skipjack/skipjack.blend',
    'hero_render':'docs/design/blender/skipjack/skipjack-hero.png',
    'textured_materials':material_result['textured_materials'],
}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(manifest,indent=2))
