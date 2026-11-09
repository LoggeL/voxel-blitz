"""Runtime delivery of the SP-2 DOPPLER.

blender --background --factory-startup docs/design/blender/doppler/doppler.blend \
  --python-exit-code 1 --python tools/blender/doppler/export-doppler.py

Writes public/assets/blender/doppler.{gltf,bin}, the WebP atlas maps under
public/assets/blender/textures/doppler/, the manifest entry and
docs/design/blender/doppler/export-report.json.
"""
import json
import subprocess
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path[:0] = [str(HERE.parent / 'lib')]
import pbr_bake as pb         # noqa: E402
import runtime_gltf as rg     # noqa: E402

OUT = ROOT / 'public/assets/blender'
DOC = ROOT / 'docs/design/blender/doppler'
TEX = OUT / 'textures/doppler'
TEX.mkdir(parents=True, exist_ok=True)
QUALITY = {'albedo': 84, 'normal': 88, 'orm': 82}

game = bpy.data.objects['DOPPLER']
parts = list(game['parts'])
sources = list(game['sources'])
source_parts = list(game['sourceParts'])
report = json.loads((DOC / 'build-report.json').read_text())

# ---------------------------------------------------------------- textures
uris = []
for name in ('albedo', 'normal', 'orm'):
    src = DOC / 'maps' / f'doppler-{name}.png'
    dst = TEX / f'doppler-{name}.webp'
    cmd = ['cwebp', '-quiet', '-q', str(QUALITY[name]), '-m', '6', str(src), '-o', str(dst)]
    if name != 'albedo':
        cmd[1:1] = ['-sharp_yuv']
    subprocess.run(cmd, check=True)
    uris.append(f'textures/doppler/{dst.name}')

def new_writer():
    """A writer with the atlas material and the three blended runtime materials registered."""
    w = rg.Writer('doppler', 'Voxel Blitz baked-atlas runtime export')
    albedo, normal, orm = w.textures(uris)
    w.atlas = w.material({
        'name': 'DOPPLER | atlas',
        'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 1.0, 'roughnessFactor': 1.0,
                                 'baseColorTexture': {'index': albedo}, 'metallicRoughnessTexture': {'index': orm}},
        'normalTexture': {'index': normal, 'scale': 1.0},
        'occlusionTexture': {'index': orm, 'strength': 1.0},
        'extras': {'partMaterial': 'atlas', 'bakedAtlas': True}})
    w.clear = {}
    for mat in bpy.data.materials:
        if mat.get('runtime'):
            b = mat.node_tree.nodes['Principled BSDF']
            col = b.inputs['Base Color'].default_value
            w.clear[mat['runtime']] = w.material({
                'name': mat.name,
                'pbrMetallicRoughness': {'baseColorFactor': [col[0], col[1], col[2], float(mat['alpha'])],
                                         'metallicFactor': 0.0,
                                         'roughnessFactor': float(b.inputs['Roughness'].default_value)},
                'alphaMode': 'BLEND', 'doubleSided': mat['runtime'] == 'smoke',
                'extras': {'partMaterial': mat['runtime'], 'glass': True}})
    return w


writer = new_writer()
CLEAR = writer.clear

# ---------------------------------------------------------------- geometry
me = game.data
pos, nrm, uv, tri, poly = rg.mesh_arrays(me, pb.ATLAS_UV)
part_of_poly = np.empty(len(me.polygons), np.int32)
me.attributes['part'].data.foreach_get('value', part_of_poly)
source_of_poly = np.empty(len(me.polygons), np.int32)
me.attributes['source'].data.foreach_get('value', source_of_poly)
tri_part = part_of_poly[poly]
tri_source = source_of_poly[poly]

clear_prims = {}
dg = bpy.context.evaluated_depsgraph_get()
for ob in bpy.data.objects:
    if ob.type != 'MESH' or ob.get('mat') not in CLEAR:
        continue
    cme = ob.evaluated_get(dg).to_mesh()
    cpos, cnrm, cuv, ctri, _ = rg.mesh_arrays(cme)
    clear_prims.setdefault((ob['part'], ob['mat']), []).append((cpos, cnrm, cuv, ctri))
    ob.evaluated_get(dg).to_mesh_clear()

round_count = int(report['mag_rounds'])


def write_nodes(target, lod=None):
    """One node per rig part. `lod` = (dropped source indices, collapse ratio) writes the reduced world mesh."""
    for index, part in enumerate(parts):
        prims = []
        if lod is None:
            sel = tri_part == index
            if sel.any():
                prims.append(target.primitive(pos, nrm, uv, tri[sel], target.atlas, {'part': part})[0])
        else:
            arrays = reduced(index, *lod)
            if arrays is not None:
                prims.append(target.primitive(*arrays, target.atlas, {'part': part})[0])
        for (cpart, cmat), chunks in clear_prims.items():
            if cpart != part:
                continue
            offset, P, N, U, T = 0, [], [], [], []
            for cpos, cnrm, cuv, ctri in chunks:
                P.append(cpos); N.append(cnrm); U.append(cuv); T.append(ctri + offset)
                offset += len(cpos)
            prims.append(target.primitive(np.concatenate(P), np.concatenate(N), np.concatenate(U), np.concatenate(T),
                                          target.clear[cmat], {'part': part, 'clear': cmat})[0])
        if prims:
            target.node(part, prims)


def reduced(part_index, dropped, ratio):
    """Atlas faces of one part without the dropped detail sources, collapsed to `ratio`."""
    bm = bmesh.new()
    bm.from_mesh(me)
    part_layer = bm.faces.layers.int['part']
    source_layer = bm.faces.layers.int['source']
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[part_layer] != part_index or f[source_layer] in dropped],
                     context='FACES')
    if not bm.faces:
        bm.free()
        return None
    mesh = bpy.data.meshes.new('lod')
    bm.to_mesh(mesh)
    bm.free()
    ob = bpy.data.objects.new('lod', mesh)
    bpy.context.scene.collection.objects.link(ob)
    mod = ob.modifiers.new('collapse', 'DECIMATE')
    mod.ratio = ratio
    mod.use_collapse_triangulate = True
    graph = bpy.context.evaluated_depsgraph_get()
    graph.update()
    out = bpy.data.meshes.new_from_object(ob.evaluated_get(graph), preserve_all_data_layers=True, depsgraph=graph)
    # Collapsing interpolates the authored corner normals into noise: shade the reduced mesh by angle instead.
    if 'custom_normal' in out.attributes:
        out.attributes.remove(out.attributes['custom_normal'])
    for polygon in out.polygons:
        polygon.use_smooth = True
    out.set_sharp_from_angle(angle=0.66)
    lpos, lnrm, luv, ltri, _ = rg.mesh_arrays(out, pb.ATLAS_UV)
    bpy.data.meshes.remove(out)
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.meshes.remove(mesh)
    return lpos, lnrm, luv, ltri


markers = {ob['marker']: rg_pos for ob in bpy.data.objects if ob.get('marker')
           for rg_pos in [[ob.location.x, ob.location.z, -ob.location.y]]}
path = list(game['followerPath'])
rounds_flat = list(game['roundMatrices'])
contract = {
    'markers': {k: [round(float(v), 5) for v in p] for k, p in markers.items()},
    'unitTravel': report['unit_travel'], 'roundCount': round_count,
    'roundMatrices': [[round(float(v), 6) for v in rounds_flat[i:i + 16]] for i in range(0, len(rounds_flat), 16)],
    'followerPath': [[round(float(v), 5) for v in path[i:i + 4]] for i in range(0, len(path), 4)],
    'sightHeight': markers['sight'][1],
}


def finish(target):
    for name in ('muzzle', 'grip', 'support', 'sight'):
        target.node(name, translation=markers[name], extras={'role': 'gameplay mount marker'})
    target.doc['asset']['extras']['contract'] = contract


write_nodes(writer)
finish(writer)
size = writer.write(OUT / 'doppler.gltf')

# ---------------------------------------------------------------- world model (remote players)
# Detail no one resolves at arm's length and beyond is dropped, the rest collapsed; UVs and maps are shared.
WORLD_DROP = ('screws', 'pins', 'buffer spring', 'rail lugs', 'pulley web', 'pulley hub', 'inlays', 'sling cups',
              'ribs', 'port bezel', 'cable runs', 'slide rails', 'riser posts', 'riser wheel', 'selector',
              'case deflector', 'stock latch', 'feed lips', 'magazine latch', 'bolt catch', 'magazine paddle',
              'optic dials', 'rod brackets', 'pulley axle', 'mid web', 'unit interior', 'housing pins')
dropped = {i for i, name in enumerate(sources) if any(key in name for key in WORLD_DROP)}
world = new_writer()
write_nodes(world, (dropped, 0.5))
finish(world)
world_size = world.write(OUT / 'doppler-world.gltf')

manifest_path = OUT / 'manifest.json'
manifest = json.loads(manifest_path.read_text())
entry = {'asset': 'doppler', 'source_parts': report['source_parts'], 'draws': writer.draws,
         'triangles': writer.triangles, 'geometry_bytes': size}
world_entry = {'asset': 'doppler-world', 'source_parts': len(sources) - len(dropped), 'draws': world.draws,
               'triangles': world.triangles, 'geometry_bytes': world_size}
manifest['assets'] = sorted([a for a in manifest['assets'] if a['asset'] not in ('doppler', 'doppler-world')]
                            + [entry, world_entry], key=lambda a: a['asset'])
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
texture_bytes = {Path(u).name: (OUT / u).stat().st_size for u in uris}
export = {**entry, 'textures': texture_bytes, 'instanced_rounds': round_count, 'atlas_size': report['atlas_size'],
          'world': world_entry}
(DOC / 'export-report.json').write_text(json.dumps(export, indent=2) + '\n')
print('[export]', json.dumps(export))
