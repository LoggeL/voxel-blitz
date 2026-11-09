"""Procedural surface library and atlas bake for script-authored weapons.

The older studies sample one tiling ImageGen scan per material through planar
UVs and ship scalar metal/roughness. This module instead:

1. builds layered Cycles materials (coating, edge wear to the base metal,
   cavity grime, scratches and smudges from ImageGen masks, engraved decals
   projected in gun space) on the mid-poly study,
2. unwraps every opaque part into ONE atlas with per-part texel weights,
3. bakes base colour, tangent normal and occlusion/roughness/metal maps,
4. returns the files a glTF material needs.

All projections use object coordinates, so nothing depends on the UV layout
and the bake can be repeated after any geometry change.
"""
import math
from pathlib import Path

import bpy
import numpy as np

ATLAS_UV = 'atlas'


# ------------------------------------------------------------------ node DSL
class Graph:
    def __init__(self, material):
        material.use_nodes = True
        self.material = material
        self.tree = material.node_tree
        self.nodes = self.tree.nodes
        self.links = self.tree.links
        self.bsdf = self.nodes.get('Principled BSDF')
        self.output = self.nodes.get('Material Output')
        self._coords = None
        self._geometry = None

    def node(self, kind, **props):
        n = self.nodes.new(kind)
        for key, value in props.items():
            setattr(n, key, value)
        return n

    def put(self, value, socket):
        if hasattr(value, 'is_output') or isinstance(value, bpy.types.NodeSocket):
            self.links.new(value, socket)
        else:
            try:
                socket.default_value = value
            except (TypeError, ValueError):
                socket.default_value = (*value, 1.0) if len(value) == 3 else value

    @property
    def coords(self):
        """Object coordinates: Blender (x, -gameZ, gameY) in metres."""
        if self._coords is None:
            self._coords = self.node('ShaderNodeTexCoord').outputs['Object']
        return self._coords

    @property
    def geometry(self):
        if self._geometry is None:
            self._geometry = self.node('ShaderNodeNewGeometry')
        return self._geometry

    def math(self, op, a, b=None, clamp=False):
        n = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.put(a, n.inputs[0])
        if b is not None:
            self.put(b, n.inputs[1])
        return n.outputs[0]

    def remap(self, x, x0, x1, y0=0.0, y1=1.0, smooth=False):
        n = self.node('ShaderNodeMapRange', clamp=True)
        if smooth:
            n.interpolation_type = 'SMOOTHSTEP'
        for i, v in enumerate((x, x0, x1, y0, y1)):
            self.put(v, n.inputs[i])
        return n.outputs[0]

    def mix(self, fac, a, b, blend='MIX'):
        n = self.node('ShaderNodeMix', data_type='RGBA', blend_type=blend)
        self.put(fac, n.inputs[0])
        self.put(a, n.inputs[6])
        self.put(b, n.inputs[7])
        return n.outputs[2]

    def mixf(self, fac, a, b):
        n = self.node('ShaderNodeMix', data_type='FLOAT')
        self.put(fac, n.inputs[0])
        self.put(a, n.inputs[2])
        self.put(b, n.inputs[3])
        return n.outputs[0]

    def scaled(self, scale, vector=None):
        n = self.node('ShaderNodeMapping')
        self.links.new(vector or self.coords, n.inputs['Vector'])
        s = scale if isinstance(scale, (tuple, list)) else (scale, scale, scale)
        n.inputs['Scale'].default_value = s
        return n.outputs[0]

    def noise(self, scale, detail=4.0, roughness=0.55, stretch=None):
        n = self.node('ShaderNodeTexNoise')
        self.links.new(self.scaled(stretch) if stretch else self.coords, n.inputs['Vector'])
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = roughness
        return n.outputs[0]

    def voronoi(self, scale, feature='F1', randomness=1.0):
        n = self.node('ShaderNodeTexVoronoi', feature=feature)
        self.links.new(self.coords, n.inputs['Vector'])
        n.inputs['Scale'].default_value = scale
        n.inputs['Randomness'].default_value = randomness
        return n.outputs[0]

    def image(self, image, tile, blend=0.25):
        """Box-project a tiling mask; `tile` is the edge length it covers in metres."""
        n = self.node('ShaderNodeTexImage', projection='BOX', projection_blend=blend)
        n.image = image
        self.links.new(self.scaled(1.0 / tile), n.inputs['Vector'])
        return n.outputs['Color']

    def axis(self, name):
        n = self.node('ShaderNodeSeparateXYZ')
        self.links.new(self.coords, n.inputs[0])
        return n.outputs[name]

    def normal_axis(self, name):
        n = self.node('ShaderNodeSeparateXYZ')
        self.links.new(self.geometry.outputs['True Normal'], n.inputs[0])
        return n.outputs[name]


def load_mask(path):
    image = bpy.data.images.load(str(path), check_existing=True)
    image.colorspace_settings.name = 'Non-Color'
    return image


# ------------------------------------------------------------------ surfaces
def surface(name, spec, masks, decals=()):
    """Create one layered source material.

    spec keys: base, metal, rough; wear {color, metal, rough, edge, scratch};
    grime (0..1); detail in {None,'speckle','stipple','knurl','brushed','grain'};
    bump (metres); tint (callable(graph) -> colour socket replacing base).
    """
    material = bpy.data.materials.new(name)
    g = Graph(material)
    base = spec['tint'](g) if spec.get('tint') else spec['base']
    metal, rough = spec.get('metal', 0.0), spec.get('rough', 0.5)

    # large and fine tonal variation
    cloud = g.noise(9.0, 5.0, 0.6)
    smudge = g.image(masks['smudge'], 0.22)
    color = g.mix(g.remap(cloud, 0.3, 0.7, 0.0, spec.get('mottle', 0.10) * 4.0), base, (0.55, 0.55, 0.55), 'MULTIPLY')
    color = g.mix(spec.get('mottle', 0.10) * 0.8, color, smudge, 'OVERLAY')
    rough_s = g.math('ADD', rough, g.remap(smudge, 0.25, 0.75, -spec.get('rough_var', 0.10), spec.get('rough_var', 0.10)))
    metal_s = metal
    height = None

    def add_height(h, amount):
        nonlocal height
        term = g.math('MULTIPLY', h, amount)
        height = term if height is None else g.math('ADD', height, term)

    detail = spec.get('detail')
    if detail == 'speckle':
        grain = g.noise(5200.0, 2.0, 0.5)
        add_height(grain, 0.03)
        rough_s = g.math('ADD', rough_s, g.remap(grain, 0.3, 0.7, -0.03, 0.03))
    elif detail == 'grain':
        add_height(g.noise(2600.0, 3.0, 0.6), 0.03)
    elif detail == 'stipple':
        dots = g.voronoi(1500.0, 'F1', 1.0)
        img = g.image(masks['stipple'], 0.045, 0.3)
        add_height(g.remap(dots, 0.0, 0.5, 1.0, 0.0, True), 0.30)
        add_height(img, 0.22)
        rough_s = g.math('ADD', rough_s, g.remap(dots, 0.0, 0.5, -0.06, 0.05))
    elif detail == 'knurl':
        a = g.node('ShaderNodeTexWave', wave_type='BANDS', bands_direction='DIAGONAL')
        g.links.new(g.coords, a.inputs['Vector'])
        a.inputs['Scale'].default_value = 520.0
        b = g.node('ShaderNodeTexWave', wave_type='BANDS', bands_direction='DIAGONAL')
        g.links.new(g.scaled((-1, 1, 1)), b.inputs['Vector'])
        b.inputs['Scale'].default_value = 520.0
        knurl = g.math('MULTIPLY', a.outputs[0], b.outputs[0])
        add_height(knurl, 0.30)
        rough_s = g.math('ADD', rough_s, g.remap(knurl, 0.0, 1.0, 0.06, -0.06))
    elif detail == 'brushed':
        streak = g.noise(900.0, 3.0, 0.6, stretch=spec.get('brush_axis', (1.0, 0.03, 1.0)))
        add_height(streak, 0.012)
        rough_s = g.math('ADD', rough_s, g.remap(streak, 0.25, 0.75, -0.07, 0.07))

    # cavity grime: ambient occlusion sampled in the bake
    grime = spec.get('grime', 0.5)
    wear = spec.get('wear')
    occlusion = None
    if grime > 0 or wear:
        ao = g.node('ShaderNodeAmbientOcclusion', samples=8)
        ao.inputs['Distance'].default_value = 0.012
        occlusion = ao.outputs['AO']
    if grime > 0:
        cavity = g.remap(occlusion, 0.35, 0.92, 1.0, 0.0, True)
        dirt = g.math('MULTIPLY', cavity, g.remap(g.noise(60.0, 5.0, 0.7), 0.25, 0.75, 0.35, 1.0))
        color = g.mix(g.math('MULTIPLY', dirt, grime), color, (0.012, 0.011, 0.010))
        rough_s = g.math('ADD', rough_s, g.math('MULTIPLY', dirt, 0.22 * grime))
        metal_s = g.math('MULTIPLY', metal_s, g.math('SUBTRACT', 1.0, g.math('MULTIPLY', dirt, 0.6 * grime)))

    # wear: exposed edges found with the bevel node (independent of mesh density; pointiness
    # paints whole faces on mid-poly plates), gated to convex ones by occlusion, plus scratches
    if wear:
        scratches = g.image(masks['scratches'], 0.19)
        scratches2 = g.image(masks['scratches'], 0.31, 0.35)
        bevel = g.node('ShaderNodeBevel', samples=6)
        bevel.inputs['Radius'].default_value = wear.get('radius', 0.0013)
        dot = g.node('ShaderNodeVectorMath', operation='DOT_PRODUCT')
        g.links.new(g.geometry.outputs['True Normal'], dot.inputs[0])
        g.links.new(bevel.outputs['Normal'], dot.inputs[1])
        curve = g.math('SUBTRACT', 1.0, dot.outputs['Value'])
        edge = g.remap(curve, 0.015, 0.14, 0.0, 1.0)
        edge = g.math('MULTIPLY', edge, g.remap(occlusion, 0.62, 0.88, 0.0, 1.0))
        breakup = g.remap(g.noise(260.0, 6.0, 0.72), 0.36, 0.62, 0.0, 1.0)
        patch = g.remap(g.noise(22.0, 4.0, 0.6), 0.50, 0.72, 0.0, 1.0)
        edge = g.math('MULTIPLY', edge, g.math('MAXIMUM', breakup, patch), clamp=True)
        edge = g.math('MULTIPLY', edge, wear.get('edge', 1.0), clamp=True)
        scr = g.math('MAXIMUM', g.remap(scratches, 0.30, 0.75),
                     g.math('MULTIPLY', g.remap(scratches2, 0.35, 0.8), g.math('MULTIPLY', patch, 0.6)))
        scr = g.math('MULTIPLY', scr, wear.get('scratch', 0.6), clamp=True)
        mask = g.math('MAXIMUM', edge, scr, clamp=True)
        color = g.mix(mask, color, wear['color'])
        rough_s = g.mixf(mask, rough_s, wear.get('rough', 0.3))
        metal_s = g.mixf(mask, metal_s, wear.get('metal', 1.0))
        add_height(mask, -0.09)

    # projected markings
    for decal in decals:
        if decal.get('on') and name.split(' | ')[-1] not in decal['on']:
            continue
        ink = decal_mask(g, decal)
        if decal.get('paint') is not None:
            color = g.mix(g.math('MULTIPLY', ink, decal.get('opacity', 0.92)), color, decal['paint'])
            rough_s = g.mixf(ink, rough_s, 0.62)
            metal_s = g.mixf(ink, metal_s, 0.0)
        add_height(ink, -decal.get('depth', 0.16))

    g.put(color, g.bsdf.inputs['Base Color'])
    rough_c = g.math('MAXIMUM', g.math('MINIMUM', rough_s, 1.0), 0.04)
    g.put(rough_c, g.bsdf.inputs['Roughness'])
    g.put(metal_s, g.bsdf.inputs['Metallic'])
    if height is not None:
        bump = g.node('ShaderNodeBump')
        bump.inputs['Strength'].default_value = 1.0
        bump.inputs['Distance'].default_value = 0.001 * spec.get('bump', 1.0)
        g.links.new(height, bump.inputs['Height'])
        g.links.new(bump.outputs['Normal'], g.bsdf.inputs['Normal'])
    # emission taps the bake switches to
    emit = g.node('ShaderNodeEmission')
    emit.name = 'BAKE_EMIT'
    _TAPS[material.name] = {'color': color, 'rough': rough_c, 'metal': metal_s, 'graph': g, 'emit': emit}
    return material


_TAPS = {}


def decal_mask(g, d):
    """Mask of one marking projected along +-x onto a wall at gun x = d['x'].

    d: image, x, side (+1 right wall, -1 left wall), u0, u1 (start and end of the
    reading direction, u = -gameZ), v0, v1 (bottom, top).
    """
    u = g.axis('Y')            # Blender y = -gameZ = u
    v = g.axis('Z')            # Blender z = gameY
    x = g.axis('X')
    mu = g.node('ShaderNodeMapRange', clamp=False)
    for i, val in enumerate((u, d['u0'], d['u1'], 0.0, 1.0)):
        g.put(val, mu.inputs[i])
    mv = g.node('ShaderNodeMapRange', clamp=False)
    for i, val in enumerate((v, d['v0'], d['v1'], 0.0, 1.0)):
        g.put(val, mv.inputs[i])
    comb = g.node('ShaderNodeCombineXYZ')
    g.links.new(mu.outputs[0], comb.inputs[0])
    g.links.new(mv.outputs[0], comb.inputs[1])
    tex = g.node('ShaderNodeTexImage', extension='CLIP', interpolation='Cubic')
    tex.image = d['image']
    g.links.new(comb.outputs[0], tex.inputs['Vector'])
    facing = g.math('GREATER_THAN', g.math('MULTIPLY', g.normal_axis('X'), d['side']), 0.6)
    near = g.math('LESS_THAN', g.math('ABSOLUTE', g.math('SUBTRACT', x, d['x'])), d.get('reach', 0.0025))
    return g.math('MULTIPLY', tex.outputs['Color'], g.math('MULTIPLY', facing, near))


# ------------------------------------------------------------------ atlas
def join_for_atlas(objects, name, part_names):
    """Apply modifiers, tag faces with their rig part and texel weight, join into one mesh."""
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    copies = []
    for ob in objects:
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        part = me.attributes.new('part', 'INT', 'FACE')
        part.data.foreach_set('value', [part_names.index(ob['part'])] * len(me.polygons))
        texel = me.attributes.new('texel', 'FLOAT', 'POINT')
        texel.data.foreach_set('value', [float(ob.get('texel', 1.0))] * len(me.vertices))
        src = me.attributes.new('source', 'INT', 'FACE')
        src.data.foreach_set('value', [objects.index(ob)] * len(me.polygons))
        copy = bpy.data.objects.new(ob.name + ' | baked', me)
        copy.matrix_world = ob.matrix_world
        bpy.context.scene.collection.objects.link(copy)
        copies.append(copy)
    bpy.ops.object.select_all(action='DESELECT')
    for copy in copies:
        copy.select_set(True)
    bpy.context.view_layer.objects.active = copies[0]
    bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = name
    joined.data.name = name
    return joined


def unwrap(obj, margin=0.0016, angle=66.0, shape='CONCAVE'):
    """Smart-project the joined mesh, weight islands by the `texel` attribute, pack once."""
    me = obj.data
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
    me.uv_layers.new(name=ATLAS_UV)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=0.0, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    # weight: scale each part about the origin (uniform per source object) while densities are averaged
    count = len(me.vertices)
    co = np.empty(count * 3, dtype=np.float32)
    me.vertices.foreach_get('co', co)
    texel = np.empty(count, dtype=np.float32)
    me.attributes['texel'].data.foreach_get('value', texel)
    me.vertices.foreach_set('co', (co.reshape(-1, 3) * texel[:, None]).ravel())
    me.update()
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.average_islands_scale()
    bpy.ops.object.mode_set(mode='OBJECT')
    me.vertices.foreach_set('co', co)
    me.update()
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=True, margin=margin, shape_method=shape, margin_method='FRACTION')
    bpy.ops.object.mode_set(mode='OBJECT')


def uv_coverage(obj):
    me = obj.data
    uv = np.empty(len(me.loops) * 2, dtype=np.float32)
    me.uv_layers[ATLAS_UV].data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2)
    me.calc_loop_triangles()
    tri = np.empty(len(me.loop_triangles) * 3, dtype=np.int32)
    me.loop_triangles.foreach_get('loops', tri)
    t = uv[tri.reshape(-1, 3)]
    area = 0.5 * np.abs((t[:, 1, 0] - t[:, 0, 0]) * (t[:, 2, 1] - t[:, 0, 1])
                        - (t[:, 2, 0] - t[:, 0, 0]) * (t[:, 1, 1] - t[:, 0, 1]))
    return float(area.sum()), float(uv.min()), float(uv.max())


def use_gpu(scene):
    scene.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for device in prefs.devices:
            device.use = True
        scene.cycles.device = 'GPU'
    except Exception as error:   # CPU bake is slower but identical
        print('[bake] GPU unavailable:', error)


def bake(obj, size, out_dir, stem, samples=48, ao_samples=96, margin=10):
    """Bake base colour, tangent normal and ORM for `obj`; returns {albedo, normal, orm} paths."""
    scene = bpy.context.scene
    use_gpu(scene)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    scene.render.bake.margin = margin
    scene.render.bake.margin_type = 'EXTEND'
    scene.render.bake.use_selected_to_active = False
    scene.render.bake.target = 'IMAGE_TEXTURES'
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    targets = {}
    for slot in obj.material_slots:
        g = _TAPS[slot.material.name]['graph']
        node = g.node('ShaderNodeTexImage')
        node.name = 'BAKE_TARGET'
        uvn = g.node('ShaderNodeUVMap', uv_map=ATLAS_UV)
        g.links.new(uvn.outputs[0], node.inputs['Vector'])
        g.nodes.active = node
        targets[slot.material.name] = node

    def image(name, data):
        img = bpy.data.images.new(f'{stem}-{name}', size, size, alpha=False, float_buffer=False, is_data=data)
        if data:
            img.colorspace_settings.name = 'Non-Color'
        for node in targets.values():
            node.image = img
        return img

    def route(channel):
        for name in targets:
            tap = _TAPS[name]
            g = tap['graph']
            for link in list(g.output.inputs['Surface'].links):
                g.links.remove(link)
            if channel is None:
                g.links.new(g.bsdf.outputs[0], g.output.inputs['Surface'])
            else:
                for link in list(tap['emit'].inputs['Color'].links):
                    g.links.remove(link)
                value = tap[channel]
                if isinstance(value, bpy.types.NodeSocket):
                    g.links.new(value, tap['emit'].inputs['Color'])
                else:
                    tap['emit'].inputs['Color'].default_value = (value, value, value, 1.0)
                g.links.new(tap['emit'].outputs[0], g.output.inputs['Surface'])

    def pixels(img):
        buf = np.empty(size * size * 4, dtype=np.float32)
        img.pixels.foreach_get(buf)
        return buf.reshape(size, size, 4)

    scene.cycles.samples = samples
    route('color')
    albedo = image('albedo', False)
    bpy.ops.object.bake(type='EMIT')
    route('rough')
    rough = image('rough', True)
    bpy.ops.object.bake(type='EMIT')
    route('metal')
    metal = image('metal', True)
    bpy.ops.object.bake(type='EMIT')
    route(None)
    normal = image('normal', True)
    bpy.ops.object.bake(type='NORMAL', normal_space='TANGENT')
    scene.cycles.samples = ao_samples
    ao = image('ao', True)
    bpy.ops.object.bake(type='AO')

    orm = bpy.data.images.new(f'{stem}-orm', size, size, alpha=False, float_buffer=False, is_data=True)
    orm.colorspace_settings.name = 'Non-Color'
    packed = np.ones((size, size, 4), dtype=np.float32)
    occlusion = pixels(ao)[:, :, 0]
    packed[:, :, 0] = np.clip(0.25 + 0.75 * occlusion ** 0.8, 0, 1)
    packed[:, :, 1] = pixels(rough)[:, :, 0]
    packed[:, :, 2] = pixels(metal)[:, :, 0]
    orm.pixels.foreach_set(packed.ravel())
    paths = {}
    for name, img in (('albedo', albedo), ('normal', normal), ('orm', orm)):
        path = out_dir / f'{stem}-{name}.png'
        img.filepath_raw = str(path)
        img.file_format = 'PNG'
        img.save()
        paths[name] = path
    for img in (rough, metal, ao):
        bpy.data.images.remove(img)
    for name, node in targets.items():
        _TAPS[name]['graph'].nodes.remove(node)
    return paths


def delivery_material(name, paths):
    """glTF-shaped material that reads the three baked maps through the atlas UVs."""
    material = bpy.data.materials.new(name)
    g = Graph(material)
    uv = g.node('ShaderNodeUVMap', uv_map=ATLAS_UV).outputs[0]

    def tex(path, data):
        n = g.node('ShaderNodeTexImage')
        n.image = bpy.data.images.load(str(path), check_existing=False)
        if data:
            n.image.colorspace_settings.name = 'Non-Color'
        g.links.new(uv, n.inputs['Vector'])
        return n

    albedo = tex(paths['albedo'], False)
    orm = tex(paths['orm'], True)
    normal = tex(paths['normal'], True)
    sep = g.node('ShaderNodeSeparateColor')
    g.links.new(orm.outputs['Color'], sep.inputs[0])
    occluded = g.mix(1.0, albedo.outputs['Color'], sep.outputs[0], 'MULTIPLY')
    g.links.new(occluded, g.bsdf.inputs['Base Color'])
    g.links.new(sep.outputs[1], g.bsdf.inputs['Roughness'])
    g.links.new(sep.outputs[2], g.bsdf.inputs['Metallic'])
    nm = g.node('ShaderNodeNormalMap', uv_map=ATLAS_UV)
    g.links.new(normal.outputs['Color'], nm.inputs['Color'])
    g.links.new(nm.outputs[0], g.bsdf.inputs['Normal'])
    material['atlas'] = True
    return material
