"""Author KV-9 VANGUARD as editable, textured AR-10 DMR hard-surface geometry.

Run headless: Blender --background --factory-startup --python-exit-code 1
--python tools/blender/vanguard/build-vanguard.py

Authoring is in gun axes (x right, y up, z rear-positive; muzzle at z=-0.64).
All mesh vertex data is baked to Blender (x, -game_z, game_y) via cv(v).
"""
import bpy, bmesh, math, json
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'docs/design/blender/vanguard'; OUT.mkdir(parents=True, exist_ok=True)
bpy.context.preferences.filepaths.save_version = 0
scene = bpy.context.scene
for obj in list(scene.objects): bpy.data.objects.remove(obj, do_unlink=True)
scene.name = 'KV-9 VANGUARD | AR-10 precision battle rifle'
scene.unit_settings.system = 'METRIC'
scene['authoringCoordinates'] = 'Blender (x,-gameZ,gameY); all mesh geometry is final gun-world'
scene['muzzle'] = (0, 0.041, -0.64)
scene['sight'] = (0, 0.15, -0.01)
scene['grip'] = (0, -0.03, -0.03)
scene['support'] = (0, -0.03, -0.40)
PARTS = ['body', 'bolt', 'trigger', 'mag', 'optic']
parts = {}
for part in PARTS:
    ob = bpy.data.objects.new(part, None); scene.collection.objects.link(ob); parts[part] = ob

def cv(v): return (v[0], -v[2], v[1])
for name in ('muzzle', 'sight', 'grip', 'support'):
    ob = bpy.data.objects.new('marker_' + name, None); scene.collection.objects.link(ob)
    ob.location = cv(scene[name]); ob['marker'] = name; ob.empty_display_size = .015

specs = json.loads((ROOT / 'docs/design/blender/material-library/materials.json').read_text())['materials']
materials = {}
TINTS = {'graphite': (.42, .44, .48, 1), 'polymer': (.20, .19, .18, 1),
         'steel': (.85, .88, .95, 1), 'rubber': (.12, .13, .14, 1),
         'lens': (.25, .45, .80, 1)}
FALLBACK = {'vanguard-graphite': 'blued-steel', 'vanguard-polymer': 'molded-polymer',
            'machined-steel': 'machined-steel', 'pebbled-rubber': 'pebbled-rubber'}

def material(name, key):
    mat = bpy.data.materials.new('VANGUARD | ' + name); mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF'); ns = mat.node_tree.nodes; links = mat.node_tree.links
    spec = specs[key]
    if key.startswith('vanguard-'):
        runtime = 'textures/' + key + '.jpg'
        png = ROOT / 'docs/design/blender/textures' / (key + '.png')
        if png.is_file():
            image = bpy.data.images.load(str(png), check_existing=True)
        else:
            image = bpy.data.images.load(str(ROOT / 'public/assets/blender/textures/palette' / (FALLBACK[key] + '.jpg')), check_existing=True)
    else:
        runtime = 'textures/palette/' + FALLBACK[key] + '.jpg'
        image = bpy.data.images.load(str(ROOT / 'public/assets/blender' / runtime), check_existing=True)
    image.name = runtime
    tex = ns.new('ShaderNodeTexImage'); tex.image = image; tex.label = 'Physical-scale material texture'; tex.location = (-650, 100)
    tint = TINTS[name]
    shader.inputs['Base Color'].default_value = tint; mat['textureTint'] = tint
    multiply = ns.new('ShaderNodeMixRGB'); multiply.blend_type = 'MULTIPLY'; multiply.inputs[0].default_value = 1
    multiply.inputs[2].default_value = tint; links.new(tex.outputs['Color'], multiply.inputs[1]); links.new(multiply.outputs[0], shader.inputs['Base Color'])
    shader.inputs['Metallic'].default_value = spec['metal']; shader.inputs['Roughness'].default_value = spec['rough']
    mat['textureFile'] = runtime; mat['textureBumpScale'] = spec['bump']; mat['textureLibrary'] = key
    bump = ns.new('ShaderNodeBump'); bump.inputs['Strength'].default_value = .24; bump.inputs['Distance'].default_value = spec['bump']; bump.location = (-200, -150)
    links.new(tex.outputs['Color'], bump.inputs['Height']); links.new(bump.outputs['Normal'], shader.inputs['Normal'])
    ramp = ns.new('ShaderNodeMapRange'); ramp.inputs['From Min'].default_value = .05; ramp.inputs['From Max'].default_value = .95
    ramp.inputs['To Min'].default_value = max(.12, spec['rough'] - .10); ramp.inputs['To Max'].default_value = min(.95, spec['rough'] + .09)
    links.new(tex.outputs['Color'], ramp.inputs['Value']); links.new(ramp.outputs['Result'], shader.inputs['Roughness'])
    materials[name] = mat; return mat

material('graphite', 'vanguard-graphite')
material('polymer', 'vanguard-polymer')
material('steel', 'machined-steel')
material('rubber', 'pebbled-rubber')
lens = material('lens', 'vanguard-graphite')
lens.node_tree.nodes['Principled BSDF'].inputs['Alpha'].default_value = 0.3
lens['glass'] = True

AUTH = []
def uvmap(mesh, scale=4):
    mesh.update(); uv = mesh.uv_layers.new(name='UVMap')
    for p in mesh.polygons:
        axis = max(range(3), key=lambda k: abs(p.normal[k])); a, b = [(1, 2), (0, 2), (0, 1)][axis]
        for li in p.loop_indices:
            v = mesh.vertices[mesh.loops[li].vertex_index].co; uv.data[li].uv = (v[a] * scale, v[b] * scale)

def mesh(name, part, mat, verts, faces, bevel=0, smooth=False, segments=2):
    data = bpy.data.meshes.new(name + ' mesh'); data.from_pydata([cv(v) for v in verts], [], faces); data.update()
    bm = bmesh.new(); bm.from_mesh(data); bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(data); bm.free()
    data.update(); uvmap(data, 5 if mat in ('rubber', 'polymer') else 4)
    for p in data.polygons: p.use_smooth = smooth
    ob = bpy.data.objects.new(name, data); scene.collection.objects.link(ob); ob.parent = parts[part]; ob['part'] = part
    data.materials.append(materials[mat]); AUTH.append(ob)
    if bevel:
        mod = ob.modifiers.new('Manufactured edge radii', 'BEVEL'); mod.width = bevel; mod.segments = segments; mod.limit_method = 'ANGLE'; mod.angle_limit = .45
        mod.harden_normals = True
        norm = ob.modifiers.new('Area weighted corner normals', 'WEIGHTED_NORMAL'); norm.keep_sharp = True; norm.weight = 45
    return ob

def rr(w, h, r, n=4):
    pts = []
    for cx, cy, start in [(w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)]:
        for i in range(n + 1):
            a = math.radians(start + i * 90 / n); pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts

def extrude(name, part, mat, outline, depth, center=(0, 0, 0), axis='z', bevel=.001, smooth=False):
    def v(a, b, t):
        q = (a, b, t) if axis == 'z' else ((t, b, a) if axis == 'x' else (a, t, b))
        return tuple(q[i] + center[i] for i in range(3))
    n = len(outline); verts = [v(a, b, t) for t in (-depth / 2, depth / 2) for a, b in outline]
    faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)] + [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    return mesh(name, part, mat, verts, faces, bevel, smooth)

def rounded(name, part, mat, size, center, r=.005, axis='z', bevel=.0008):
    dims = size
    if axis == 'z': w, h, d = dims
    elif axis == 'x': w, h, d = dims[2], dims[1], dims[0]
    else: w, h, d = dims[0], dims[2], dims[1]
    return extrude(name, part, mat, rr(w, h, min(r, w * .45, h * .45), 3), d, center, axis, bevel)

def cyl(name, part, mat, r, depth, center, n=32, axis='z', inner=None, bevel=.0005, rot=0):
    n = min(n, 40)
    verts = []; faces = []
    def v(rad, i, t):
        a = rot + 2 * math.pi * i / n; q = (rad * math.cos(a), rad * math.sin(a), t)
        if axis == 'x': q = (q[2], q[1], q[0])
        elif axis == 'y': q = (q[0], q[2], q[1])
        return tuple(q[j] + center[j] for j in range(3))
    for rad in ([r] if inner is None else [r, inner]):
        verts += [v(rad, i, t) for t in (-depth / 2, depth / 2) for i in range(n)]
    for i in range(n):
        j = (i + 1) % n; faces.append((i, j, n + j, n + i))
        if inner is not None:
            faces.extend([(2 * n + i, 3 * n + i, 3 * n + j, 2 * n + j), (n + i, n + j, 3 * n + j, 3 * n + i), (i, 2 * n + i, 2 * n + j, j)])
    if inner is None: faces.extend([tuple(reversed(range(n))), tuple(range(n, 2 * n))])
    ob = mesh(name, part, mat, verts, faces, bevel, True, segments=1)
    for p in ob.data.polygons:
        if len(p.vertices) > 4: p.use_smooth = False
    return ob

def loft(name, part, mat, stations, n=4, bevel=.0006):
    verts = []
    for z, y, x, w, h, r in stations: verts.extend([(x + a, y + b, z) for a, b in rr(w, h, r, n)])
    count = len(rr(stations[0][3], stations[0][4], stations[0][5], n)); faces = []
    for s in range(len(stations) - 1):
        for i in range(count): j = (i + 1) % count; faces.append((s * count + i, s * count + j, (s + 1) * count + j, (s + 1) * count + i))
    faces.extend([tuple(reversed(range(count))), tuple(range((len(stations) - 1) * count, len(stations) * count))])
    ob = mesh(name, part, mat, verts, faces, bevel, True)
    for p in ob.data.polygons:
        if len(p.vertices) > 4: p.use_smooth = False
    return ob

def tube(name, part, mat, points, r=.002, n=8):
    verts = []; faces = []; P = [Vector(p) for p in points]
    for i, p in enumerate(P):
        tangent = (P[min(i + 1, len(P) - 1)] - P[max(0, i - 1)]).normalized()
        ref = Vector((0, 1, 0)) if abs(tangent.y) < .95 else Vector((1, 0, 0))
        a = tangent.cross(ref).normalized(); b = tangent.cross(a).normalized()
        for j in range(n): verts.append(tuple(p + r * (a * math.cos(2 * math.pi * j / n) + b * math.sin(2 * math.pi * j / n))))
    for i in range(len(P) - 1):
        for j in range(n): k = (j + 1) % n; faces.append((i * n + j, i * n + k, (i + 1) * n + k, (i + 1) * n + j))
    faces.extend([tuple(reversed(range(n))), tuple(range((len(P) - 1) * n, len(P) * n))])
    return mesh(name, part, mat, verts, faces, 0, True)

def torus(name, part, mat, R, r, center, n=40, m=8):
    pts = []; faces = []
    for i in range(n):
        a = 2 * math.pi * i / n
        for j in range(m): b = 2 * math.pi * j / m; pts.append((center[0] + (R + r * math.cos(b)) * math.cos(a), center[1] + (R + r * math.cos(b)) * math.sin(a), center[2] + r * math.sin(b)))
    for i in range(n):
        for j in range(m): faces.append((i * m + j, ((i + 1) % n) * m + j, ((i + 1) % n) * m + (j + 1) % m, i * m + (j + 1) % m))
    return mesh(name, part, mat, pts, faces, 0, True)

# --- Receiver: rounded loft with a subtly crowned spine ---
loft('Receiver lofted shell', 'body', 'graphite', [
    (-0.16, 0.062, 0, 0.050, 0.074, 0.022), (-0.06, 0.060, 0, 0.054, 0.079, 0.024),
    (0.04, 0.058, 0, 0.056, 0.081, 0.025), (0.12, 0.055, 0, 0.054, 0.077, 0.024),
    (0.18, 0.052, 0, 0.047, 0.069, 0.022)], n=6, bevel=0.0012)
loft('Receiver polymer lower', 'body', 'polymer', [
    (-0.14, 0.018, 0, 0.047, 0.047, 0.019), (-0.02, 0.015, 0, 0.051, 0.051, 0.020),
    (0.10, 0.014, 0, 0.049, 0.049, 0.019)], n=6, bevel=0.001)
# Full-length top rail with teeth; handguard rail continues forward.
rounded('Receiver top rail', 'body', 'graphite', (0.024, 0.012, 0.38), (0, 0.105, -0.01), r=0.004, bevel=.0006)
for i in range(12):
    rounded('Receiver rail tooth '+str(i), 'body', 'graphite', (0.027, 0.006, 0.011), (0, 0.113, -0.185 + i*0.0335), r=0.0015, bevel=0)
# --- Ribbed cylindrical free-float shroud with rail teeth ---
cyl('Handguard ribbed cylindrical shroud', 'body', 'graphite', 0.039, 0.28, (0, 0.045, -0.29), 24, bevel=0.001)
for i, z in enumerate((-0.395, -0.345, -0.295, -0.245, -0.195)):
    torus('Handguard rib ring '+str(i), 'body', 'graphite', 0.0395, 0.0028, (0, 0.045, z), 28, 8)
for i in range(8):
    rounded('Handguard rail tooth '+str(i), 'body', 'graphite', (0.020, 0.006, 0.013), (0, 0.087, -0.415 + i*0.036), r=0.0015, bevel=0)
cyl('Handguard front collar', 'body', 'steel', 0.041, 0.012, (0, 0.045, -0.432), 20, bevel=0.0007)
# --- Gas piston block + tube ---
rounded('Gas piston block', 'body', 'graphite', (0.017, 0.024, 0.015), (0, 0.068, -0.443), r=0.004, bevel=.0008)
cyl('Gas piston tube', 'body', 'steel', 0.0045, 0.30, (0, 0.070, -0.30), 12, bevel=0)
# --- Free-float fluted barrel (graphite core + dark longitudinal grooves) ---
cyl('Barrel fluted core', 'body', 'graphite', 0.0105, 0.20, (0, 0.045, -0.54), 28, bevel=0.0005)
for i in range(6):
    a = i * math.pi / 3 + 0.35
    cyl('Barrel flute groove '+str(i), 'body', 'rubber', 0.0030, 0.075, (0.0085*math.cos(a), 0.045+0.0085*math.sin(a), -0.4875), 10, bevel=0)
# --- Suppressor with rings and muzzle slots ---
cyl('Suppressor main can', 'body', 'graphite', 0.020, 0.125, (0, 0.045, -0.5775), 24, bevel=0.001)
cyl('Suppressor rear ring', 'body', 'steel', 0.021, 0.008, (0, 0.045, -0.516), 24, bevel=0.0004)
cyl('Suppressor front ring', 'body', 'steel', 0.021, 0.008, (0, 0.045, -0.635), 24, bevel=0.0004)
cyl('Suppressor muzzle face', 'body', 'graphite', 0.009, 0.004, (0, 0.045, -0.639), 16, bevel=0)
for i in range(4):
    a = i * math.pi / 2 + math.pi / 4
    rounded('Suppressor slot '+str(i), 'body', 'rubber', (0.004, 0.005, 0.006), (0.018*math.cos(a), 0.045+0.018*math.sin(a), -0.630), r=0.001, bevel=0)
# --- Ejection port recess, dust cover, forward assist, QD cups ---
rounded('Ejection port recess', 'body', 'rubber', (0.004, 0.022, 0.055), (0.028, 0.068, -0.02), r=0.002, axis='x', bevel=0)
rounded('Ejection dust cover', 'body', 'steel', (0.002, 0.018, 0.050), (0.027, 0.080, -0.02), r=0.0015, axis='x', bevel=0)
rounded('Forward assist housing', 'body', 'graphite', (0.014, 0.020, 0.020), (0.024, 0.058, 0.07), r=0.005, bevel=.0008)
cyl('Forward assist button', 'body', 'steel', 0.009, 0.012, (0.030, 0.058, 0.07), 16, axis='x', bevel=0.0004)
for side in (-1, 1):
    cyl('QD socket '+str(side), 'body', 'rubber', 0.006, 0.003, (side*0.028, 0.050, -0.10), 12, axis='x', bevel=0)
# --- Buffer tube, beveled stock loft, cheek riser, butt pad ---
cyl('Buffer tube', 'body', 'graphite', 0.013, 0.13, (0, 0.057, 0.20), 20, bevel=0.0006)
loft('Stock structural loft', 'body', 'polymer', [
    (0.16, 0.054, 0, 0.046, 0.062, 0.020), (0.24, 0.050, 0, 0.044, 0.073, 0.021),
    (0.32, 0.046, 0, 0.043, 0.083, 0.022), (0.365, 0.043, 0, 0.042, 0.088, 0.022)], n=6, bevel=0.0015)
rounded('Cheek riser bevel', 'body', 'rubber', (0.040, 0.019, 0.13), (0, 0.092, 0.30), r=0.009, bevel=.0012)
rounded('Butt pad', 'body', 'rubber', (0.044, 0.096, 0.022), (0, 0.049, 0.373), r=0.009, bevel=.0012)
# --- Pistol grip (rounded extrude + palm inserts) ---
grip_profile = [(-.043, .009), (-.081, .013), (-.099, -.001), (-.087, -.024), (-.071, -.053), (-.058, -.087), (-.047, -.105), (-.009, -.098), (-.020, -.082), (-.036, -.047), (-.031, -.023)]
extrude('Pistol grip flowing core', 'body', 'polymer', [(z, y - 0.005) for z, y in grip_profile], .038, (0, 0, 0), 'x', .004)
for side in (-1, 1):
    extrude('Pistol pebbled insert '+str(side), 'body', 'rubber',
        [(z, y - 0.005) for z, y in [(-.047, -.018), (-.077, -.019), (-.065, -.052), (-.048, -.091), (-.021, -.088), (-.034, -.055)]], .004, (side*0.021, 0, 0), 'x', .0015)
# --- Trigger guard U + magazine well flare ---
tube('Trigger guard continuous bow', 'body', 'graphite',
    [(0, 0.015, -0.05), (0, -0.012, -0.055), (0, -0.022, -0.075), (0, -0.020, -0.10), (0, -0.008, -0.115), (0, 0.015, -0.115)], .004, 8)
rounded('Magazine well throat', 'body', 'polymer', (0.046, 0.045, 0.060), (0, 0.005, -0.06), r=0.012, bevel=.0012)
rounded('Magazine well flare', 'body', 'polymer', (0.052, 0.016, 0.070), (0, -0.020, -0.06), r=0.006, bevel=.001)
# --- Bolt carrier + T charging handle ---
cyl('Bolt carrier cylinder', 'bolt', 'steel', 0.013, 0.09, (0, 0.045, -0.01), 20, bevel=0.0004)
rounded('Bolt exposed lug', 'bolt', 'graphite', (0.030, 0.028, 0.060), (0, 0.045, -0.01), r=0.009, bevel=.001)
cyl('Charging handle shaft', 'bolt', 'steel', 0.004, 0.07, (0, 0.062, 0.155), 12, bevel=0)
rounded('Charging handle T wing', 'bolt', 'graphite', (0.056, 0.012, 0.013), (0, 0.062, 0.187), r=0.005, bevel=.0007)
for side in (-1, 1):
    cyl('Charging handle knob '+str(side), 'bolt', 'rubber', 0.006, 0.010, (side*0.030, 0.062, 0.187), 12, axis='x', bevel=0.0004)
# --- Trigger blade ---
tube('Trigger curved blade', 'trigger', 'steel',
    [(0, 0.018, -0.085), (0, 0.005, -0.086), (0, -0.004, -0.093), (0, -0.006, -0.098)], .0032, 6)
# --- Curved 20-rd magazine: lofted arc bend + ribs + baseplate ---
loft('Curved magazine shell', 'mag', 'polymer', [
    (-0.075, 0.020, 0, 0.030, 0.034, 0.012), (-0.055, -0.040, 0, 0.030, 0.040, 0.012),
    (-0.030, -0.095, 0, 0.030, 0.044, 0.012), (0.000, -0.142, 0, 0.030, 0.046, 0.012)], n=5, bevel=0.0018)
for i, (z, y) in enumerate(((-0.062, -0.020), (-0.045, -0.058), (-0.024, -0.096), (-0.005, -0.128))):
    tube('Magazine rib '+str(i), 'mag', 'rubber', [(-0.016, y, z), (0, y + 0.002, z + 0.004), (0.016, y, z)], .0018, 6)
rounded('Magazine baseplate', 'mag', 'rubber', (0.036, 0.016, 0.055), (0.010, -0.148, -0.005), r=0.006, bevel=.0012)
# --- LPVO optic: tube, bells, turrets, rings, throw lever ---
cyl('LPVO main tube', 'optic', 'graphite', 0.015, 0.20, (0, 0.148, -0.01), 24, bevel=0.0006)
cyl('LPVO objective bell', 'optic', 'graphite', 0.023, 0.05, (0, 0.148, -0.12), 24, bevel=0.0008)
cyl('LPVO objective lens', 'optic', 'lens', 0.019, 0.003, (0, 0.148, -0.146), 20, bevel=0)
cyl('LPVO ocular bell', 'optic', 'graphite', 0.020, 0.04, (0, 0.148, 0.10), 24, bevel=0.0007)
cyl('LPVO eyepiece', 'optic', 'rubber', 0.016, 0.015, (0, 0.148, 0.125), 20, bevel=0.0005)
cyl('LPVO elevation turret', 'optic', 'graphite', 0.011, 0.022, (0, 0.172, 0.01), 16, axis='y', bevel=0.0005)
cyl('LPVO elevation cap', 'optic', 'steel', 0.008, 0.005, (0, 0.184, 0.01), 12, axis='y', bevel=0)
cyl('LPVO windage turret', 'optic', 'graphite', 0.011, 0.022, (-0.024, 0.148, 0.01), 16, axis='x', bevel=0.0005)
cyl('LPVO power dial', 'optic', 'rubber', 0.012, 0.010, (0.022, 0.148, 0.075), 16, axis='x', bevel=0.0005)
rounded('LPVO throw lever', 'optic', 'steel', (0.008, 0.004, 0.032), (-0.018, 0.160, 0.06), r=0.002, bevel=0)
for i, z in enumerate((-0.05, 0.05)):
    cyl('LPVO ring '+str(i), 'optic', 'graphite', 0.018, 0.016, (0, 0.148, z), 20, bevel=0.0004)
    rounded('LPVO mount '+str(i), 'optic', 'graphite', (0.020, 0.030, 0.016), (0, 0.124, z), r=0.005, bevel=.0007)

# Studio: charcoal AgX Cycles, three-point soft lighting, ortho presentation.
scene.render.engine = 'CYCLES'; scene.cycles.samples = 48; scene.cycles.use_denoising = True
scene.render.resolution_x = 1440; scene.render.resolution_y = 900; scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'; scene.render.film_transparent = False
scene.world = bpy.data.worlds.new('VANGUARD charcoal studio'); scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.027, .044, .063, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .4
scene.view_settings.view_transform = 'AgX'
for image in bpy.data.images:
    if image.source == 'FILE': image.filepath = bpy.path.relpath(image.filepath, start=str(OUT))

def area(name, pos, power, size, color):
    data = bpy.data.lights.new(name, 'AREA'); data.energy = power; data.shape = 'DISK'; data.size = size; data.color = color
    ob = bpy.data.objects.new(name, data); scene.collection.objects.link(ob); ob.location = pos
    ob.rotation_euler = (Vector((0, 0.12, -0.08)) - ob.location).to_track_quat('-Z', 'Y').to_euler()

area('Large warm key', (1.1, 0.9, 1.2), 120, 1.4, (1, .90, .77))
area('Cool rail rim', (-0.7, -1.0, 1.0), 145, 1.1, (.53, .72, 1))
area('Soft rear fill', (0.6, -0.75, 0.25), 40, 1.0, (.7, .8, 1))
cam_data = bpy.data.cameras.new('VANGUARD presentation camera'); cam = bpy.data.objects.new('VANGUARD presentation camera', cam_data); scene.collection.objects.link(cam)
cam.location = (1.15, 0.10, 0.55); target = Vector((0, 0.12, 0.02)); cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler(); cam_data.type = 'ORTHO'; cam_data.ortho_scale = 1.35; scene.camera = cam
for area_item in bpy.context.screen.areas if bpy.context.screen else []:
    if area_item.type == 'VIEW_3D': area_item.spaces.active.region_3d.view_distance = 1.4
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'vanguard.blend'))
deps = bpy.context.evaluated_depsgraph_get(); triangles = 0; counts = {}; batches = set()
for ob in AUTH:
    evaluated = ob.evaluated_get(deps); data = evaluated.to_mesh(); data.calc_loop_triangles(); triangles += len(data.loop_triangles); counts[ob['part']] = counts.get(ob['part'], 0) + len(data.loop_triangles); batches.add((ob['part'], ob.data.materials[0].name)); evaluated.to_mesh_clear()
report = {'source': 'docs/design/blender/vanguard/vanguard.blend', 'meshes': len(AUTH), 'triangles': triangles, 'materialGroupBatches': len(batches), 'parts': counts, 'materials': {k: {'textureFile': v['textureFile'], 'textureBumpScale': v['textureBumpScale'], 'textureTint': list(v['textureTint']), 'textureLibrary': v['textureLibrary']} for k, v in materials.items()}}
(OUT / 'source-report.json').write_text(json.dumps(report, indent=2) + '\n'); print('VANGUARD_SOURCE_REPORT ' + json.dumps(report))
scene.render.filepath = str(OUT / 'studio.png'); bpy.ops.render.render(write_still=True)
