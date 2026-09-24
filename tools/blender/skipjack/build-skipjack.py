"""Rebuild GL-3 SKIPJACK as the sculpted CITADEL study (revision 13).

Run in the connected Blender 5.x session through Blender MCP:

    from pathlib import Path
    p = Path('/Users/logge/Documents/Projects/voxel-blitz/tools/blender/skipjack/build-skipjack.py')
    exec(compile(p.read_text(), str(p), 'exec'), {'__file__': str(p), '__name__': '__main__'})

or headless as the fallback:

    blender --background --factory-startup --python tools/blender/skipjack/build-skipjack.py

The study is authored in docs/design/blender/skipjack/skipjack.blend (saved with
copy=True so a live session keeps its own file). Design study "CITADEL": one
lofted receiver/stock shell with super-elliptic sections, Boolean pockets for
the cassette bay, thumb scoops and service cover, a lathed barrel and brake,
a lofted grip and shoulder pad, a three-position flank cassette on a vertical
front hinge hub and a compact 0.216 m reflex sight. Geometry is authored in
reference-geometry.py against the large side view in
concepts/revision11/rounded-direction-b.png.

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
UV_SCALE = 7.5

# Reference-model viewmodel anchors in authoring space (game = (x, z, -y)).
ANCHORS = {
    'muzzle': (0.0, 0.782, 0.075),
    'grip': (0.041, 0.332, -0.112),
    'support': (-0.052, 0.478, 0.006),
    'sight': (0.0, 0.342, 0.216),
}
BORE_Z = 0.075
MUZZLE_Y = 0.782
# Runtime glow sleeve: BARREL_R.mgl 0.0415 over game z [-0.752, -0.603]
# (BREACH_Z.mgl -0.33 with heatLen [0.62, 0.96] of barrelLen 0.44).
HEAT_Y = (0.603, 0.752)
HEAT_CLEAR_R = 0.046
SIGHT_AXIS = (0.0, ANCHORS['sight'][2])   # (x, z) of the ADS line
SIGHT_CLEAR_R = 0.021
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
    'gunmetal': (.10, .13, .15, 1),
    'machined steel': (.30, .34, .35, 1),
    'olive drab': (.27, .34, .19, 1),
    'dark polymer': (.035, .045, .050, 1),
    'orange paint': (.90, .31, .065, 1),
    'brass': (.52, .37, .14, 1),
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


def link_part(obj, name, group, material, bevel=0.0015, smooth=False, color=None,
              bevel_segments=1, keep_uv=False):
    obj.name = name
    obj.data.name = f'{name} mesh'
    obj.parent = groups[group]
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.data.materials.clear()
    obj.data.materials.append(materials[material])
    obj['part'] = group
    obj['skipjack_material'] = material
    if not obj.get('open_shell'):
        orient(obj.data)
    source_collection.objects.link(obj) if obj.name not in source_collection.objects else None
    for poly in obj.data.polygons:
        poly.use_smooth = smooth
    if bevel > 0:
        mod = obj.modifiers.new('machined edge chamfers', 'BEVEL')
        mod.width = bevel
        mod.segments = bevel_segments
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
    if keep_uv and obj.data.uv_layers:
        PARTS.append(obj)
        return obj
    uv = obj.data.uv_layers.new(name='UVMap') if not obj.data.uv_layers else obj.data.uv_layers[0]
    for poly in obj.data.polygons:
        axis = max(range(3), key=lambda i: abs(poly.normal[i]))
        first, second = ((1, 2), (0, 2), (0, 1))[axis]
        for loop in poly.loop_indices:
            co = obj.data.vertices[obj.data.loops[loop].vertex_index].co
            uv.data[loop].uv = (co[first] * UV_SCALE, co[second] * UV_SCALE)
    PARTS.append(obj)
    return obj


def box(name, group, mat, loc, size, bevel=.002, rot=None, bevel_segments=1):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = active_obj()
    obj.dimensions = size
    if rot:
        obj.rotation_euler = rot
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return link_part(obj, name, group, mat, bevel,
                     bevel_segments=bevel_segments)


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
                   verts=verts, bevel=0, radius_top=radius_top)
    obj['skipjack_material'] = finish
    layer = obj.data.color_attributes.new(name='RoundColor', type='BYTE_COLOR',
                                          domain='CORNER')
    for entry in layer.data:
        entry.color = ROUND_VERTEX_COLORS[finish]
    return obj


# Geometry follows the approved side reference, including its hand/optic layout.
reference = Path(__file__).with_name('reference-geometry.py')
exec(compile(reference.read_text(), str(reference), 'exec'))

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
cam.location = (-2.0, .56, .23)
target = Vector((0, .26, .025))
cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
cam_data.type = 'ORTHO'
cam_data.ortho_scale = 1.14
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
empty_parts = sorted(name for name, points in part_points.items() if not points)
gate('non-empty parts', not empty_parts, f'empty: {empty_parts[:8]}')
source_meshes = [o for o in source_meshes if part_points[o.name]]

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
open_volume = 0.0
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
    if obj.get('open_shell'):
        # The olive shell and its dark keel/pocket skin close each other.
        open_volume += volume
        continue
    if volume <= 0:
        inverted.append(f'{obj.name} ({volume * 1e6:.1f} cm3)')
if open_volume <= 0:
    inverted.append(f'open shell pair ({open_volume * 1e6:.1f} cm3)')
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
