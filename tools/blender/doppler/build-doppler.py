"""Author the SP-2 DOPPLER study: geometry, layered surfaces, atlas bake, saved .blend.

blender --background --factory-startup --python-exit-code 1 \
  --python tools/blender/doppler/build-doppler.py [-- --size 2048 --fast]

Writes docs/design/blender/doppler/{doppler.blend,build-report.json} and the baked
PNG masters under docs/design/blender/doppler/maps/. Run make-decals.py first.
"""
import json
import sys
import time
from pathlib import Path

import bpy

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path[:0] = [str(HERE), str(HERE.parent / 'lib')]
import hardsurface as hs      # noqa: E402
import pbr_bake as pb         # noqa: E402
import geometry as geo        # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SIZE = int(argv[argv.index('--size') + 1]) if '--size' in argv else 2048
FAST = '--fast' in argv
OUT = ROOT / 'docs/design/blender/doppler'
DESIGN = ROOT / 'docs/design/doppler'
OUT.mkdir(parents=True, exist_ok=True)
PARTS = ['body', 'unit', 'bolt', 'trigger', 'mag', 'rounds', 'follower', 'pulley', 'spring', 'factory-optic']
RUNTIME = {'glass', 'lens', 'smoke'}     # transparent surfaces keep simple runtime materials

started = time.time()
bpy.context.preferences.filepaths.save_version = 0
scene = bpy.context.scene
for ob in list(scene.objects):
    bpy.data.objects.remove(ob, do_unlink=True)
scene.name = 'SP-2 DOPPLER | shifted pulse battle rifle'
scene.unit_settings.system = 'METRIC'
scene['authoringCoordinates'] = 'Blender (x, -gameZ, gameY); meshes are final gun space'
scene['reference'] = 'docs/design/doppler/concepts/concept-a-profile-reference.jpg'

st = hs.Study('DOPPLER')
geo.build(st)
for name, pos in geo.MARKERS.items():
    marker = bpy.data.objects.new('marker_' + name, None)
    marker.location = hs.blender(pos)
    marker.empty_display_size = 0.012
    marker['marker'] = name
    scene.collection.objects.link(marker)

# ---------------------------------------------------------------- surfaces
masks = {
    'scratches': pb.load_mask(DESIGN / 'textures/wear-scratches.png'),
    'smudge': pb.load_mask(DESIGN / 'textures/smudge-grunge.png'),
    'stipple': pb.load_mask(DESIGN / 'textures/stipple-height.png'),
}
W = geo.W
INK = (0.62, 0.62, 0.60)


def decal(name, side, x, u0, u1, v0, v1, on, paint=INK, depth=0.16, reach=0.0010):
    return {'image': pb.load_mask(DESIGN / f'decals/{name}.png'), 'side': side, 'x': side * abs(x), 'u0': u0, 'u1': u1,
            'v0': v0, 'v1': v1, 'on': on, 'paint': paint, 'depth': depth, 'reach': reach}


POCKET = W - geo.SKIN      # floor of the milled wall pockets
DECALS = [
    decal('nameplate', -1, POCKET, 0.1130, 0.0570, 0.0320, 0.0720, ['cerakote']),
    decal('nameplate', 1, POCKET, 0.0570, 0.1130, 0.0320, 0.0720, ['cerakote']),
    decal('serial', 1, POCKET, 0.139, 0.251, 0.0140, 0.0220, ['cerakote'], depth=0.10),
    decal('warning', -1, POCKET, 0.251, 0.139, 0.0140, 0.0220, ['cerakote'], paint=(0.78, 0.40, 0.04), depth=0.08),
    decal('selector', 1, W, 0.072, 0.102, -0.0075, 0.0045, ['cerakote'], depth=0.10),
    decal('selector', -1, W, 0.102, 0.072, -0.0075, 0.0045, ['cerakote'], depth=0.10),
    decal('optic', -1, 0.0189, 0.201, 0.161, 0.1365, 0.1485, ['teal'], paint=(0.80, 0.82, 0.82), depth=0.08, reach=0.002),
]


def heat_tint(g):
    """Titanium temper colours along the brake: grey collar, straw, purple, blue, pale crown."""
    u = g.axis('Y')
    warp = g.noise(75.0, 3.0, 0.6)
    t = g.math('ADD', g.remap(u, 0.597, 0.661), g.remap(warp, 0.3, 0.7, -0.09, 0.09), clamp=True)
    ramp = g.node('ShaderNodeValToRGB')
    stops = [(0.00, (0.40, 0.38, 0.36)), (0.16, (0.74, 0.50, 0.19)), (0.33, (0.56, 0.25, 0.14)),
             (0.50, (0.30, 0.09, 0.40)), (0.68, (0.06, 0.17, 0.62)), (0.85, (0.24, 0.48, 0.68)),
             (1.00, (0.72, 0.58, 0.34))]
    elements = ramp.color_ramp.elements
    while len(elements) < len(stops):
        elements.new(0.5)
    for element, (pos, col) in zip(elements, stops):
        element.position = pos
        element.color = (*col, 1.0)
    g.links.new(t, ramp.inputs[0])
    return ramp.outputs[0]


# Albedo and metalness are tuned against the game's daylight (hemisphere 0.78, sun 1.35,
# environment 0.45; see tools/render-gun-views.mjs), not the studio renders: a physically
# pure metal reads near black there, so coatings stay mostly dielectric.
ALU = {'color': (0.78, 0.79, 0.80), 'metal': 0.70, 'rough': 0.34}
SPECS = {
    'cerakote': dict(base=(0.165, 0.170, 0.178), metal=0.22, rough=0.50, detail='speckle', grime=0.65, bump=1.0,
                     wear=dict(ALU, edge=1.0, scratch=0.40), mottle=0.07),
    'nitride': dict(base=(0.030, 0.031, 0.034), metal=0.45, rough=0.38, detail='grain', grime=0.45, bump=1.0,
                    wear=dict(color=(0.38, 0.38, 0.39), metal=0.8, rough=0.32, edge=0.75, scratch=0.16), mottle=0.04),
    'polymer': dict(base=(0.036, 0.037, 0.040), metal=0.0, rough=0.60, detail='grain', grime=0.45, bump=1.0,
                    wear=dict(color=(0.085, 0.086, 0.090), metal=0.0, rough=0.72, edge=0.6, scratch=0.22), mottle=0.06),
    'stipple': dict(base=(0.031, 0.032, 0.035), metal=0.0, rough=0.70, detail='stipple', grime=0.35, bump=1.0,
                    wear=dict(color=(0.075, 0.075, 0.080), metal=0.0, rough=0.52, edge=0.35, scratch=0.10), mottle=0.05),
    'rubber': dict(base=(0.022, 0.022, 0.024), metal=0.0, rough=0.84, detail='grain', grime=0.5, bump=2.0,
                   mottle=0.08, rough_var=0.06),
    'steel': dict(base=(0.62, 0.63, 0.65), metal=0.72, rough=0.30, detail='brushed', grime=0.7, bump=1.0,
                  mottle=0.08, rough_var=0.12),
    'titanium': dict(base=(0.5, 0.5, 0.5), tint=heat_tint, metal=0.68, rough=0.30, detail='brushed', grime=0.55,
                     bump=1.0, mottle=0.04, brush_axis=(1.0, 1.0, 0.03),
                     wear=dict(color=(0.70, 0.68, 0.66), metal=0.8, rough=0.34, edge=0.45, scratch=0.14)),
    'brass': dict(base=(0.84, 0.58, 0.20), metal=0.70, rough=0.30, detail='brushed', grime=0.5, bump=1.0,
                  mottle=0.10),
    'copper': dict(base=(0.80, 0.40, 0.22), metal=0.70, rough=0.33, grime=0.4, mottle=0.08),
    'teal': dict(base=(0.016, 0.190, 0.225), metal=0.25, rough=0.40, detail='speckle', grime=0.5, bump=1.0,
                 wear=dict(ALU, edge=0.8, scratch=0.14), mottle=0.04),
    'orange': dict(base=(0.86, 0.170, 0.014), metal=0.0, rough=0.50, detail='grain', grime=0.5, bump=1.0,
                   wear=dict(color=(0.95, 0.42, 0.20), metal=0.0, rough=0.6, edge=0.5, scratch=0.12), mottle=0.05),
    'knurl': dict(base=(0.036, 0.037, 0.041), metal=0.45, rough=0.42, detail='knurl', grime=0.6, bump=1.0,
                  wear=dict(color=(0.42, 0.42, 0.43), metal=0.8, rough=0.32, edge=0.7, scratch=0.12), mottle=0.04),
    'void': dict(base=(0.004, 0.004, 0.004), metal=0.0, rough=0.95, grime=0.0, mottle=0.0),
}
surfaces = {key: pb.surface(f'DOPPLER | {key}', spec, masks, DECALS) for key, spec in SPECS.items()}


def transparent(name, color, alpha, rough, transmission=0.85):
    m = bpy.data.materials.new(f'DOPPLER | {name}')
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Alpha'].default_value = alpha
    b.inputs['Roughness'].default_value = rough
    b.inputs['Transmission Weight'].default_value = transmission
    b.inputs['IOR'].default_value = 1.45
    m['runtime'] = name
    m['alpha'] = alpha
    return m


surfaces['glass'] = transparent('glass', (0.55, 0.75, 0.78), 0.16, 0.06)
surfaces['lens'] = transparent('lens', (0.10, 0.42, 0.44), 0.22, 0.04)
surfaces['smoke'] = transparent('smoke', (0.060, 0.046, 0.034), 0.62, 0.20, 0.0)
for ob in st.objects:
    ob.data.materials.append(surfaces[ob['mat']])

# ---------------------------------------------------------------- atlas
source_tris = st.triangles()
if '--stats' in argv:
    dg = bpy.context.evaluated_depsgraph_get()
    rows = []
    for ob in st.objects:
        me = ob.evaluated_get(dg).data
        me.calc_loop_triangles()
        rows.append((len(me.loop_triangles), ob.name))
    for n, name in sorted(rows, reverse=True)[:28]:
        print(f'[tris] {n:6d} {name}')
opaque = [ob for ob in st.objects if ob['mat'] not in RUNTIME]
clear = [ob for ob in st.objects if ob['mat'] in RUNTIME]
game = pb.join_for_atlas(opaque, 'DOPPLER', PARTS)
game['parts'] = PARTS
game['sources'] = [ob.name for ob in opaque]
game['sourceParts'] = [ob['part'] for ob in opaque]
follower = next(ob for ob in opaque if ob['part'] == 'follower')
game['followerPath'] = [value for row in follower['followerPath'] for value in row]
game['roundMatrices'] = list(next(ob for ob in opaque if ob['part'] == 'rounds')['roundMatrices'])
for ob in st.objects:
    ob.hide_render = True
st.collection.hide_render = True
t0 = time.time()
pb.unwrap(game, shape='AABB' if FAST else 'CONCAVE')
print(f'[doppler] unwrap {time.time() - t0:.1f}s')
coverage, uv_min, uv_max = pb.uv_coverage(game)
print(f'[doppler] atlas coverage {coverage:.3f} uv {uv_min:.3f}..{uv_max:.3f}')
paths = pb.bake(game, SIZE, OUT / 'maps', 'doppler', samples=12 if FAST else 20, ao_samples=24 if FAST else 64)

delivery = pb.delivery_material('DOPPLER | atlas', paths)
game.data.materials.clear()
game.data.materials.append(delivery)
for poly in game.data.polygons:
    poly.material_index = 0
st.collection.hide_render = False
for ob in clear:
    ob.hide_render = False
for ob in opaque:
    ob.hide_viewport = True
# The atlas holds one cartridge; stand the rest of the stack up as linked copies for the renders.
import bmesh                   # noqa: E402
from mathutils import Matrix   # noqa: E402
display = bpy.data.collections.new('display')
scene.collection.children.link(display)
bm = bmesh.new()
bm.from_mesh(game.data)
layer = bm.faces.layers.int['part']
bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[layer] != PARTS.index('rounds')], context='FACES')
round_mesh = bpy.data.meshes.new('DOPPLER | cartridge display')
bm.to_mesh(round_mesh)
bm.free()
round_mesh.materials.append(delivery)
flat = list(game['roundMatrices'])
for index in range(1, geo.MAG_ROUNDS):
    m = flat[index * 16:(index + 1) * 16]
    rel = Matrix([[m[c * 4 + r] for c in range(4)] for r in range(4)])
    ob = bpy.data.objects.new(f'DOPPLER | cartridge {index:02d}', round_mesh)
    ob.matrix_world = hs.G2B @ rel @ hs.B2G
    ob['display'] = True
    display.objects.link(ob)
game.data.calc_loop_triangles()
report = {
    'asset': 'doppler', 'source_parts': len(st.objects), 'source_triangles': source_tris,
    'atlas_triangles': len(game.data.loop_triangles), 'atlas_size': SIZE, 'uv_coverage': round(coverage, 4),
    'parts': PARTS, 'markers': {k: list(v) for k, v in geo.MARKERS.items()},
    'unit_travel': geo.UNIT_TRAVEL, 'mag_rounds': geo.MAG_ROUNDS, 'seconds': round(time.time() - started, 1),
}
(OUT / 'build-report.json').write_text(json.dumps(report, indent=2) + '\n')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'doppler.blend'), copy=False)
print('[doppler]', json.dumps(report))
