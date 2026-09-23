"""Rebuild GL-3 SKIPJACK as design study "CITADEL" (revision 8).

Run in the connected Blender 5.x session through Blender MCP:

    from pathlib import Path
    p = Path('/Users/logge/Documents/Projects/voxel-blitz/tools/blender/skipjack/build-skipjack.py')
    exec(compile(p.read_text(), str(p), 'exec'), {'__file__': str(p), '__name__': '__main__'})

or headless as the fallback:

    blender --background --factory-startup --python tools/blender/skipjack/build-skipjack.py

The study is authored in docs/design/blender/skipjack/skipjack.blend (saved with
copy=True so a live session keeps its own file). Design study "CITADEL": one
continuous faceted wedge from stock comb to muzzle nut, a three-grenade cassette
bayed on the left flank whose armoured frame and machined rims expose the
rounds, and an arc-range ladder sight carrying the reflex at the frozen 0.291 m
sight line. Alternatives and the choice are recorded in
docs/design/blender/skipjack/concepts/concept-prompts.md.

Authoring space is +Y muzzle, +Z up, +X right; the delivery export maps
game (x, y, z) = (x, z, -y). This script authors source parts only (one mesh
per named part, `part` + `skipjack_material` custom props); the runtime
batching, manifests and proofs are owned by export-game-assets.py,
validate-skipjack.py, render-skipjack.py and pose-skipjack.py.

Build gates (each raises on violation): the four frozen anchors, the muzzle tip
on the bore axis at the contract plane, heat-band clearance for the runtime
glow sleeve, an unobstructed sight channel down the ADS line, every part
touching its neighbours, and the round-name contract for the runtime sorter.
"""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[3]
SLUG = 'skipjack'
ASSET = 'SKIPJACK'
OUT = ROOT / 'docs/design/blender/skipjack'
OUT.mkdir(parents=True, exist_ok=True)

GROUP_NAMES = ('body', 'mag', 'bolt', 'trigger', 'extra')
MATERIAL_KEYS = ('gunmetal', 'machined steel', 'olive drab', 'dark polymer',
                 'rubber', 'orange paint', 'brass', 'phosphor', 'optic glass')
ROUND_MATERIAL = 'round colors'
UV_SCALE = 3.6

# Frozen viewmodel anchors in authoring space (game = (x, z, -y)).
ANCHORS = {
    'muzzle': (0.0, 0.782, 0.075),
    'grip': (0.047, 0.056, -0.203),
    'support': (-0.058, 0.373, -0.184),
    'sight': (0.0, 0.332, 0.291),
}
BORE_Z = 0.075
MUZZLE_Y = 0.782
# Runtime glow sleeve: BARREL_R.mgl 0.0415 over game z [-0.752, -0.603]
# (BREACH_Z.mgl -0.33 with heatLen [0.62, 0.96] of barrelLen 0.44).
HEAT_Y = (0.603, 0.752)
HEAT_CLEAR_R = 0.046
SIGHT_AXIS = (0.0, ANCHORS['sight'][2])   # (x, z) of the ADS line
SIGHT_CLEAR_R = 0.025
CONTACT_M = 0.004

SCENE_NAME = f'{ASSET} | GL-3 grenade launcher study'
REBUILD_SENTINEL = f'{ASSET} | temporary rebuild sentinel'

# --- scene reset: only SKIPJACK-owned data is removed ------------------------
for obj in list(bpy.data.objects):
    if (obj.get('skipjack_material') is not None or obj.get('blenderAsset') == SLUG
            or obj.name.split('.')[0] in GROUP_NAMES + tuple(ANCHORS)
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
        for obj in list(old_scene.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.scenes.remove(old_scene)
scene.unit_settings.system = 'METRIC'
scene.render.engine = 'CYCLES'
scene.cycles.samples = 96
scene.cycles.use_denoising = True
scene.cycles.seed = 20260923
scene.render.resolution_x = 1680
scene.render.resolution_y = 1120
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'

world = bpy.data.worlds.new(f'{ASSET} | softbox world')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (.105, .13, .16, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = .16
scene.world = world

source_collection = bpy.data.collections.new(f'{ASSET} | authored parts')
scene.collection.children.link(source_collection)
studio_collection = bpy.data.collections.new(f'{ASSET} | studio')
scene.collection.children.link(studio_collection)

groups = {}
for name in GROUP_NAMES:
    empty = bpy.data.objects.new(name, None)
    empty.empty_display_type = 'CIRCLE'
    empty.empty_display_size = .035
    source_collection.objects.link(empty)
    groups[name] = empty

# --- materials ---------------------------------------------------------------
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
        bsdf.inputs['Emission Color'].default_value = (.025, .62, .13, 1)
        bsdf.inputs['Emission Strength'].default_value = 2.0
    materials[key] = mat

glass = bpy.data.materials.new(f'{ASSET} | optic glass')
glass.diffuse_color = (.18, .58, .65, .28)
glass.use_nodes = True
gbsdf = glass.node_tree.nodes['Principled BSDF']
gbsdf.inputs['Base Color'].default_value = (.18, .58, .65, 1)
gbsdf.inputs['Metallic'].default_value = .04
gbsdf.inputs['Roughness'].default_value = .10
gbsdf.inputs['Alpha'].default_value = .28
gbsdf.inputs['Emission Color'].default_value = (.10, .35, .40, 1)
gbsdf.inputs['Emission Strength'].default_value = .22
if hasattr(glass, 'surface_render_method'):
    glass.surface_render_method = 'BLENDED'
materials['optic glass'] = glass

# Runtime rounds merge to one vertex-coloured draw each; the editable study
# parts carry their finish as a RoundColor corner layer on this one material.
ROUND_VERTEX_COLORS = {
    'gunmetal': (.065, .090, .105, 1),
    'machined steel': (.22, .28, .29, 1),
    'olive drab': (.075, .095, .062, 1),
    'dark polymer': (.018, .025, .028, 1),
    'orange paint': (.50, .13, .025, 1),
    'brass': (.30, .20, .06, 1),
}
round_material = bpy.data.materials.new(f'{ASSET} | {ROUND_MATERIAL}')
round_material.diffuse_color = (1, 1, 1, 1)
round_material.use_nodes = True
round_shader = round_material.node_tree.nodes['Principled BSDF']
round_shader.inputs['Metallic'].default_value = .24
round_shader.inputs['Roughness'].default_value = .44
round_color_node = round_material.node_tree.nodes.new('ShaderNodeVertexColor')
round_color_node.layer_name = 'RoundColor'
round_material.node_tree.links.new(round_color_node.outputs['Color'],
                                   round_shader.inputs['Base Color'])
materials[ROUND_MATERIAL] = round_material

PARTS = []


def active_obj():
    return bpy.context.object


def orient(mesh):
    """Force outward-facing winding: profile/extruded shells must not depend on
    the profile's winding direction to pass the delivery normal audit."""
    volume = 0.0
    for poly in mesh.polygons:
        verts = [mesh.vertices[i].co for i in poly.vertices]
        for i in range(1, len(verts) - 1):
            volume += verts[0].dot(verts[i].cross(verts[i + 1])) / 6.0
    if volume < 0:
        for poly in mesh.polygons:
            poly.flip()
        mesh.update()


def link_part(obj, name, group, material, bevel=0.0015, smooth=False, color=None):
    obj.name = name
    obj.data.name = f'{name} mesh'
    obj.parent = groups[group]
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.data.materials.clear()
    obj.data.materials.append(materials[material])
    obj['part'] = group
    obj['skipjack_material'] = material
    orient(obj.data)
    source_collection.objects.link(obj) if obj.name not in source_collection.objects else None
    for poly in obj.data.polygons:
        poly.use_smooth = smooth
    if bevel > 0:
        mod = obj.modifiers.new('machined edge chamfers', 'BEVEL')
        mod.width = bevel
        mod.segments = 1
        mod.limit_method = 'ANGLE'
        mod.angle_limit = math.radians(28)
        mod.use_clamp_overlap = True
        mod2 = obj.modifiers.new('weighted corner normals', 'WEIGHTED_NORMAL')
        mod2.keep_sharp = True
    if color is not None:
        layer = obj.data.color_attributes.new(name='RoundColor', type='BYTE_COLOR',
                                              domain='CORNER')
        for entry in layer.data:
            entry.color = color
    uv = obj.data.uv_layers.new(name='UVMap') if not obj.data.uv_layers else obj.data.uv_layers[0]
    for poly in obj.data.polygons:
        axis = max(range(3), key=lambda i: abs(poly.normal[i]))
        first, second = ((1, 2), (0, 2), (0, 1))[axis]
        for loop in poly.loop_indices:
            co = obj.data.vertices[obj.data.loops[loop].vertex_index].co
            uv.data[loop].uv = (co[first] * UV_SCALE, co[second] * UV_SCALE)
    PARTS.append(obj)
    return obj


def box(name, group, mat, loc, size, bevel=.002, rot=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = active_obj()
    obj.dimensions = size
    if rot:
        obj.rotation_euler = rot
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return link_part(obj, name, group, mat, bevel)


def profile_prism(name, group, mat, x_center, width, profile, bevel=.008):
    """Extrude a Y/Z side profile across X for shaped, non-box volumes."""
    count = len(profile)
    x0, x1 = x_center - width * .5, x_center + width * .5
    verts = [(x0, y, z) for y, z in profile] + [(x1, y, z) for y, z in profile]
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    for i in range(count):
        j = (i + 1) % count
        faces.append((i, j, j + count, i + count))
    mesh = bpy.data.meshes.new(f'{name} mesh')
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    source_collection.objects.link(obj)
    return link_part(obj, name, group, mat, bevel)


def cylinder(name, group, mat, loc, radius, depth, axis='Y', verts=24,
             bevel=.0012, radius_top=None):
    # Blender cones have radius1 at local -Z and radius2 at +Z. A +90 degree
    # X rotation maps local -Z to authoring +Y, so a tip radius must be radius1.
    radius1 = (radius_top if axis == 'Y' and radius_top is not None else radius)
    radius2 = (radius if axis == 'Y' and radius_top is not None else
               (radius if radius_top is None else radius_top))
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=radius1,
                                    radius2=radius2, depth=depth, location=loc)
    obj = active_obj()
    if axis == 'Y':
        obj.rotation_euler[0] = math.pi / 2
    elif axis == 'X':
        obj.rotation_euler[1] = math.pi / 2
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return link_part(obj, name, group, mat, bevel, smooth=True)


def hollow_tube(name, group, mat, loc, outer_radius, inner_radius, depth,
                verts=32, bevel=.001):
    """A true open tube with annular ends and a visible inner wall."""
    if not 0 < inner_radius < outer_radius:
        raise ValueError(f'invalid tube radii for {name}')
    x, y, z = loc
    rings = []
    for radius, yy in ((outer_radius, y - depth / 2), (outer_radius, y + depth / 2),
                       (inner_radius, y - depth / 2), (inner_radius, y + depth / 2)):
        rings.extend((x + radius * math.cos(2 * math.pi * i / verts), yy,
                      z + radius * math.sin(2 * math.pi * i / verts)) for i in range(verts))
    faces = []
    for i in range(verts):
        j = (i + 1) % verts
        faces.extend(((i, verts + i, verts + j, j),
                      (verts + i, 3 * verts + i, 3 * verts + j, verts + j),
                      (2 * verts + i, 2 * verts + j, 3 * verts + j, 3 * verts + i),
                      (i, j, 2 * verts + j, 2 * verts + i)))
    mesh = bpy.data.meshes.new(f'{name} mesh')
    mesh.from_pydata(rings, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    source_collection.objects.link(obj)
    return link_part(obj, name, group, mat, bevel, smooth=True)


def torus(name, group, mat, loc, major, minor, axis='Y', segments=24, ring_segments=8):
    bpy.ops.mesh.primitive_torus_add(major_segments=segments,
                                     minor_segments=ring_segments,
                                     major_radius=major, minor_radius=minor,
                                     location=loc)
    obj = active_obj()
    if axis == 'X':
        obj.rotation_euler[1] = math.pi / 2
    elif axis == 'Y':
        obj.rotation_euler[0] = math.pi / 2
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return link_part(obj, name, group, mat, 0, smooth=True)


def rod_between(name, group, mat, a, b, radius, verts=10):
    av, bv = Vector(a), Vector(b)
    delta = bv - av
    obj = cylinder(name, group, mat, (av + bv) * .5, radius, delta.length,
                   axis='Z', verts=verts, bevel=0)
    obj.rotation_euler = delta.to_track_quat('Z', 'Y').to_euler()
    return obj


def arc(name, group, mat, center, radius, start, end, plane='YZ', tube=.005, steps=20):
    pts = []
    for i in range(steps + 1):
        a = start + (end - start) * i / steps
        if plane == 'YZ':
            pts.append((center[0], center[1] + radius * math.cos(a),
                        center[2] + radius * math.sin(a)))
        elif plane == 'XZ':
            pts.append((center[0] + radius * math.cos(a), center[1],
                        center[2] + radius * math.sin(a)))
        else:
            pts.append((center[0] + radius * math.cos(a),
                        center[1] + radius * math.sin(a), center[2]))
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.resolution_u = 2
    cu.bevel_depth = tube
    cu.bevel_resolution = 2
    sp = cu.splines.new('POLY')
    sp.points.add(len(pts) - 1)
    for p, v in zip(sp.points, pts):
        p.co = (*v, 1)
    obj = bpy.data.objects.new(name, cu)
    source_collection.objects.link(obj)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target='MESH')
    return link_part(active_obj(), name, group, mat, 0, smooth=True)


def round_cyl(name, finish, loc, radius, depth, radius_top=None, verts=20):
    obj = cylinder(name, 'mag', ROUND_MATERIAL, loc, radius, depth,
                   verts=verts, bevel=.0006, radius_top=radius_top)
    obj['skipjack_material'] = finish
    layer = obj.data.color_attributes.new(name='RoundColor', type='BYTE_COLOR',
                                          domain='CORNER')
    for entry in layer.data:
        entry.color = ROUND_VERTEX_COLORS[finish]
    return obj


# ---------------------------------------------------------------------------
# Barrel group: bare 40 mm launch tube across the heat band, fluted shroud
# behind it, and an octagonal crown nut with slot vents at the muzzle.
# ---------------------------------------------------------------------------
hollow_tube('barrel | launch tube', 'body', 'gunmetal', (0, .552, BORE_Z),
            .040, .032, .460, verts=40, bevel=.001)
cylinder('barrel | bore shadow', 'body', 'rubber', (0, .60, BORE_Z),
         .033, .004, verts=32, bevel=0)
hollow_tube('shroud | faceted sleeve', 'body', 'gunmetal', (0, .47, BORE_Z),
            .057, .039, .260, verts=8, bevel=.0025)
for y in (.352, .588):
    hollow_tube(f'shroud | collar {y:.3f}', 'body', 'machined steel', (0, y, BORE_Z),
                .061, .039, .014, verts=8, bevel=.001)
hollow_tube('shroud | orange datum band', 'body', 'orange paint', (0, .568, BORE_Z),
            .0585, .039, .008, verts=8, bevel=.0006)
hollow_tube('crown | octagonal nut', 'body', 'gunmetal', (0, .769, BORE_Z),
            .056, .0395, .026, verts=8, bevel=.004)
for i, x in enumerate((.054, -.054)):
    box(f'crown | slot vent {i + 1}', 'body', 'dark polymer', (x, .769, BORE_Z),
        (.008, .016, .020), .0006)
box('crown | orange index', 'body', 'orange paint', (0, .762, BORE_Z + .0545),
    (.022, .008, .004), .0004)

# ---------------------------------------------------------------------------
# Receiver: one continuous faceted wedge. Diagonal top ridge from the stock
# comb to the muzzle nut; milled left bay carries the cassette's back plate.
# ---------------------------------------------------------------------------
profile_prism('receiver | forged wedge', 'body', 'olive drab', 0, .170,
              [(-.055, .100), (-.010, .145), (.135, .168), (.300, .168),
               (.408, .132), (.436, .062), (.415, -.010), (.335, -.078),
               (.045, -.082), (-.048, -.050)], .012)
box('receiver | top rail', 'body', 'gunmetal', (0, .16, .177), (.10, .30, .018), .003)
for i in range(5):
    box(f'receiver | rail notch {i + 1}', 'body', 'dark polymer',
        (0, .055 + i * .055, .187), (.102, .010, .005), .0006)
for side in (-1, 1):
    box(f'receiver | cheek panel {side:+}', 'body', 'dark polymer',
        (side * .089, .18, .045), (.008, .28, .13), .004)
    for y in (.08, .30):
        cylinder(f'receiver | cheek fastener {side:+} {y:.2f}', 'body', 'machined steel',
                 (side * .093, y, .08), .006, .004, axis='X', verts=12, bevel=.0004)
box('receiver | belly rail', 'body', 'gunmetal', (0, .17, -.086), (.13, .22, .014), .003)
box('receiver | rear cap', 'body', 'gunmetal', (0, -.052, .02), (.15, .05, .13), .005)
# The fixed bay floor and hinge saddles stay behind when the cassette swings out.
box('receiver | bay mount', 'body', 'gunmetal', (-.098, .21, -.01), (.012, .22, .18), .003)
for x in (-.172, -.112):
    box(f'receiver | saddle floor {x:+.3f}', 'body', 'gunmetal',
        (x, .30, .044), (.018, .036, .010), .001)
    box(f'receiver | saddle lip {x:+.3f}', 'body', 'gunmetal',
        (x, .278, .056), (.018, .010, .028), .001)

# ---------------------------------------------------------------------------
# Sight: the ladder fins ARE the reflex housing wings, so the 0.291 m arc line
# reads as range hardware and nothing floats. Open window down the ADS line.
# ---------------------------------------------------------------------------
for side in (-1, 1):
    profile_prism(f'sight | ladder fin {side:+}', 'body', 'gunmetal',
                  side * .0335, .011,
                  [(.230, .180), (.258, .245), (.300, .300), (.350, .335),
                   (.352, .258), (.296, .215), (.252, .176)], .003)
for i, (y, z) in enumerate(( (.272, .238), (.292, .256), (.312, .274))):
    cylinder(f'sight | range dot {i + 1}', 'body', 'orange paint',
             (-.0395, y, z), .004, .003, axis='X', verts=10, bevel=0)
box('sight | cursor bar', 'body', 'dark polymer', (0, .302, .256), (.086, .014, .012), .002)
box('sight | hood bridge', 'body', 'gunmetal', (0, .338, .331), (.092, .034, .016), .003)
box('sight | base block', 'body', 'dark polymer', (0, .332, .238), (.062, .055, .016), .002)
box('sight | reflex lens', 'body', 'optic glass', (0, .332, .292), (.058, .002, .060), 0)
cylinder('sight | reflex emitter', 'extra', 'phosphor', (0, .332, .291),
         .0035, .010, axis='Y', verts=12, bevel=0)
for side in (-1, 1):
    cylinder(f'sight | windage knob {side:+}', 'body', 'machined steel',
             (side * .046, .332, .300), .010, .012, axis='X', verts=16, bevel=.0007)

# ---------------------------------------------------------------------------
# Stock, grip, trigger and the support fore-grip at the frozen hand anchors.
# ---------------------------------------------------------------------------
profile_prism('stock | backbone', 'body', 'olive drab', 0, .115,
              [(-.030, .102), (-.105, .118), (-.190, .102), (-.226, .020),
               (-.214, -.048), (-.140, -.066), (-.050, -.050)], .008)
box('stock | cheek comb', 'body', 'olive drab', (0, -.075, .112), (.10, .11, .016), .005)
box('stock | butt plate', 'body', 'gunmetal', (0, -.215, .018), (.125, .014, .14), .004)
box('stock | shoulder pad', 'body', 'rubber', (0, -.229, .018), (.132, .030, .15), .008)

profile_prism('grip | core', 'body', 'dark polymer', .047, .084,
              [(.140, -.075), (.028, -.075), (.008, -.300), (.058, -.326),
               (.100, -.302), (.128, -.160)], .010)
box('grip | backstrap', 'body', 'rubber', (.047, .008, -.190), (.088, .022, .19), .006,
    rot=(0.10, 0, 0))
box('grip | base cap', 'body', 'gunmetal', (.047, .033, -.318), (.09, .06, .014), .004)

arc('trigger | swept guard', 'trigger', 'gunmetal', (.047, .085, -.105), .052,
    math.pi * 1.05, math.pi * 1.95, 'YZ', .007, 24)
rod_between('trigger | pivot pin', 'trigger', 'gunmetal',
            (.012, .11, -.09), (.082, .11, -.09), .005, 12)
rod_between('trigger | blade', 'trigger', 'orange paint',
            (.047, .12, -.086), (.057, .104, -.15), .006, 10)

box('foregrip | mount', 'body', 'gunmetal', (-.058, .36, .004), (.075, .13, .05), .004)
box('foregrip | neck', 'body', 'dark polymer', (-.058, .37, -.055), (.058, .08, .10), .005)
profile_prism('foregrip | palm swell', 'body', 'dark polymer', -.058, .064,
              [(.318, -.098), (.412, -.098), (.408, -.200), (.378, -.268),
               (.330, -.258), (.312, -.180)], .010)
box('foregrip | hand stop', 'body', 'dark polymer', (-.058, .318, -.115),
    (.068, .028, .03), .004)
box('foregrip | orange index', 'body', 'orange paint', (-.058, .412, -.103),
    (.04, .014, .006), .0008)

# ---------------------------------------------------------------------------
# Cassette (mag): three 40 mm grenades bayed on the left flank between the
# bay mount and the armoured frame, held by machined rims on a transverse
# trunnion. All of it swings out on the runtime reload choreography.
# ---------------------------------------------------------------------------
CASSETTE_X = -.135
ROUND_ROWS = (.055, -.008, -.071)
HINGE_AUTH = Vector((-.163, .300, .055))   # trunnion pin line; exported to the runtime

for index, row in enumerate(ROUND_ROWS, start=1):
    round_cyl(f'round {index} | brass base', 'brass', (CASSETTE_X, .126, row), .0265, .022)
    round_cyl(f'round {index} | olive body', 'olive drab', (CASSETTE_X, .213, row), .025, .152)
    round_cyl(f'round {index} | orange band', 'orange paint', (CASSETTE_X, .190, row), .0258, .012)
    round_cyl(f'round {index} | steel shoulder', 'machined steel', (CASSETTE_X, .295, row),
              .026, .012, radius_top=.0235)
    round_cyl(f'round {index} | olive nose', 'olive drab', (CASSETTE_X, .3125, row),
              .0235, .023, radius_top=.009)
    round_cyl(f'round {index} | dark tip', 'dark polymer', (CASSETTE_X, .327, row),
              .009, .006, radius_top=.004, verts=12)
    for y in (.132, .292):
        torus(f'cassette | rim {index} {y:.3f}', 'mag', 'machined steel',
              (CASSETTE_X, y, row), .029, .005, axis='Y', segments=24, ring_segments=8)

box('cassette | bay plate', 'mag', 'gunmetal', (-.096, .21, -.01), (.02, .245, .20), .003)
box('cassette | spine bar', 'mag', 'gunmetal', (-.152, .21, .092), (.024, .185, .026), .003)
box('cassette | lower bar', 'mag', 'gunmetal', (-.152, .21, -.100), (.024, .185, .022), .003)
for y in (.11, .31):
    box(f'cassette | frame post {y:.2f}', 'mag', 'gunmetal', (-.152, y, -.005),
        (.024, .02, .19), .003)
cylinder('cassette | trunnion pin', 'mag', 'machined steel',
         (-.13, HINGE_AUTH.y, HINGE_AUTH.z), .008, .11, axis='X',
         verts=16, bevel=.0005)
for x in (-.158, -.116):
    cylinder(f'cassette | trunnion boss {x:+.3f}', 'mag', 'gunmetal',
             (x, HINGE_AUTH.y, HINGE_AUTH.z), .018, .02, axis='X', verts=20, bevel=.0008)
box('cassette | release paddle', 'mag', 'orange paint', (-.168, .115, -.105),
    (.016, .03, .05), .003)
rod_between('cassette | release lever', 'mag', 'gunmetal',
            (-.168, .12, -.105), (-.168, .20, -.10), .005, 10)

# ---------------------------------------------------------------------------
# Bolt: the charging pawl slides back 25 mm in its right-cheek track.
# ---------------------------------------------------------------------------
box('bolt | pawl arm', 'bolt', 'machined steel', (.094, .175, .113), (.016, .09, .026), .003)
cylinder('bolt | pawl knob', 'bolt', 'orange paint', (.108, .175, .113),
         .011, .018, axis='X', verts=16, bevel=.0006)
cylinder('bolt | pawl drum', 'bolt', 'machined steel', (.088, .138, .113),
         .015, .014, axis='X', verts=20, bevel=.0008)
for z in (.098, .128):
    box(f'bolt | track rail {z:.3f}', 'body', 'gunmetal', (.09, .175, z),
        (.01, .12, .008), .001)

# ---------------------------------------------------------------------------
# Extra: the fire selector and the round counter on the right cheek.
# ---------------------------------------------------------------------------
cylinder('extra | selector dial', 'extra', 'brass', (.091, .27, .02),
         .016, .012, axis='X', verts=20, bevel=.0008)
box('extra | counter bezel', 'extra', 'gunmetal', (.09, .22, .10), (.014, .05, .028), .003)
box('extra | counter segments', 'extra', 'phosphor', (.098, .22, .10), (.004, .026, .008), .0004)

# --- frozen gameplay mount markers ------------------------------------------
for name, loc in ANCHORS.items():
    marker = bpy.data.objects.new(name, None)
    marker.empty_display_type = 'PLAIN_AXES'
    marker.empty_display_size = .012
    marker.location = loc
    marker['blenderAsset'] = SLUG
    source_collection.objects.link(marker)

# --- studio presentation (omitted from every delivery path) ------------------
floor_mat = bpy.data.materials.new(f'{ASSET} | backdrop')
floor_mat.diffuse_color = (.023, .032, .039, 1)
floor_mat.use_nodes = True
floor_mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (.023, .032, .039, 1)
floor_mat.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = .68
bpy.ops.mesh.primitive_plane_add(size=200, location=(0, .28, -.415))
floor = active_obj()
floor.name = 'studio | ground'
floor.data.materials.append(floor_mat)
studio_collection.objects.link(floor)


def area(name, loc, power, color, size, target):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = power
    data.color = color
    data.shape = 'DISK'
    data.size = size
    obj = bpy.data.objects.new(name, data)
    studio_collection.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()
    return obj


area('studio | key softbox', (1.4, -.6, 1.6), 95, (.72, .84, 1), 1.4, (0, .34, 0))
area('studio | cool edge', (-1.15, .48, .78), 105, (.72, .83, 1), .9, (0, .36, 0))
area('studio | overhead strip', (.1, .75, 1.3), 78, (.66, .90, 1), 1.1, (0, .37, -.02))
area('studio | muzzle fill', (0, 1.35, .36), 44, (.72, .85, 1), .65, (0, .55, .05))
cam_data = bpy.data.cameras.new('studio | hero camera')
cam = bpy.data.objects.new('studio | hero camera', cam_data)
studio_collection.objects.link(cam)
cam.location = (-1.55, 1.15, .32)
target = Vector((0, .32, -.005))
cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
cam_data.type = 'ORTHO'
cam_data.ortho_scale = 1.18
scene.camera = cam

# ---------------------------------------------------------------------------
# Build gates. Each raises on violation: a drifted anchor or a part in the heat
# sleeve / sight channel ships a mis-aimed or occluded launcher.
# ---------------------------------------------------------------------------
failures = []


def gate(name, ok, detail):
    print(f'[gate] {"PASS" if ok else "FAIL"} {name}: {detail}')
    if not ok:
        failures.append(f'{name}: {detail}')


for name, loc in ANCHORS.items():
    marker = bpy.data.objects.get(name)
    got = tuple(round(v, 6) for v in marker.location) if marker else None
    gate(f'anchor:{name}', got == loc, f'{got} (want {loc})')


def mesh_points(obj):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    points = [obj.matrix_world @ vertex.co for vertex in mesh.vertices]
    evaluated.to_mesh_clear()
    return points


source_meshes = [o for o in source_collection.objects if o.type == 'MESH']
part_points = {obj.name: mesh_points(obj) for obj in source_meshes}

tip_y = max(p.y for points in part_points.values() for p in points)
tip_band = [p for points in part_points.values() for p in points if p.y >= tip_y - 2e-3]
tip_cx = sum(p.x for p in tip_band) / len(tip_band)
tip_cz = sum(p.z for p in tip_band) / len(tip_band)
gate('muzzle tip', abs(tip_y - MUZZLE_Y) <= 2e-3
     and abs(tip_cx) <= 2e-3 and abs(tip_cz - BORE_Z) <= 2e-3,
     f'forward-most y={tip_y:.5f} (want {MUZZLE_Y}), band centre ({tip_cx:.5f}, {tip_cz:.5f}) '
     f'over {len(tip_band)} verts')

heat_hits = []
sight_hits = []
for name, points in part_points.items():
    for p in points:
        radius = math.hypot(p.x, p.z - BORE_Z)
        if (HEAT_Y[0] <= p.y <= HEAT_Y[1] and radius < HEAT_CLEAR_R
                and name != 'barrel | launch tube'):
            heat_hits.append(f'{name} ({radius:.4f})')
        axis_radius = math.hypot(p.x - SIGHT_AXIS[0], p.z - SIGHT_AXIS[1])
        if (0.05 <= p.y <= ANCHORS['sight'][1] and axis_radius < SIGHT_CLEAR_R
                and not name.startswith('sight | reflex lens')
                and not name.startswith('sight | reflex emitter')):
            sight_hits.append(f'{name} ({axis_radius:.4f})')
gate('heat band', not heat_hits, f'intrusions: {sorted(set(heat_hits))[:6]}')
gate('sight channel', not sight_hits, f'obstructions: {sorted(set(sight_hits))[:6]}')

floating = []
boxes = {}
for obj in source_meshes:
    points = part_points[obj.name]
    boxes[obj.name] = ([min(getattr(p, a) for p in points) for a in 'xyz'],
                       [max(getattr(p, a) for p in points) for a in 'xyz'])
for name, (low, high) in boxes.items():
    touches = False
    for other, (olow, ohigh) in boxes.items():
        if other == name:
            continue
        if all(low[i] - CONTACT_M <= ohigh[i] and high[i] + CONTACT_M >= olow[i]
               for i in range(3)):
            touches = True
            break
    if not touches:
        floating.append(name)
gate('floating parts', not floating, f'detached: {sorted(floating)[:8]}')

# Same signed-volume math as validate-skipjack's inward-surface audit, on the
# evaluated world-space triangles, so a flipped shell fails here first.
inverted = []
for obj in source_meshes:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    volume = 0.0
    for triangle in mesh.loop_triangles:
        a, b, c = (obj.matrix_world @ mesh.vertices[i].co for i in triangle.vertices)
        volume += a.dot(b.cross(c)) / 6.0
    evaluated.to_mesh_clear()
    if volume <= 0:
        inverted.append(f'{obj.name} ({volume * 1e6:.1f} cm3)')
gate('outward surfaces', not inverted, f'inverted: {sorted(inverted)[:6]}')

round_names = sorted(o.name for o in source_meshes if o.name.startswith('round '))
gate('round contract', len(round_names) == 18
     and all(f'round {n} | ' in ' '.join(round_names) for n in (1, 2, 3)),
     f'{len(round_names)} round parts')

# ---------------------------------------------------------------------------
# Save the study (copy=True keeps a live session's own file untouched).
# ---------------------------------------------------------------------------
triangles = sum(sum(max(0, len(poly.vertices) - 2) for poly in o.data.polygons)
                for o in source_meshes)
bpy.context.window.scene = scene
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'skipjack.blend'),
                            copy=True, check_existing=False)

report = {
    'asset': 'GL-3 SKIPJACK', 'study': 'CITADEL', 'scene': scene.name,
    'source_parts': len(source_meshes), 'source_triangles_estimate': triangles,
    'anchors_authoring': {k: list(v) for k, v in ANCHORS.items()},
    'cassette_hinge_authoring': list(HINGE_AUTH),
    'cassette_hinge_game': [HINGE_AUTH.x, HINGE_AUTH.z, -HINGE_AUTH.y],
    'heat_band_authoring_y': list(HEAT_Y),
    'gates_failed': failures,
    'blend': str((OUT / 'skipjack.blend').relative_to(ROOT)),
}
print(json.dumps(report, indent=2))
if failures:
    raise SystemExit(f'SKIPJACK build gates failed: {len(failures)}')
print('SKIPJACK-BUILD-DONE')
