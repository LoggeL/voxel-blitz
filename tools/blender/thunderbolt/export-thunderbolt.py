"""Export the TB-4 Blender source to runtime glTF and an identical portable GLB.

Run with Blender --background docs/design/blender/thunderbolt/thunderbolt.blend
--python tools/blender/thunderbolt/export-thunderbolt.py. Evaluated modifiers,
split corner normals and UV seams are baked in gun-local coordinates. Each
top-level animation part is an identity wrapper with one child per material.
"""
import copy
import hashlib
import json
import math
import struct
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / 'docs/design/blender/thunderbolt'
OUT = ROOT / 'public/assets/blender'
PARTS = ['body', 'bolt', 'trigger', 'rotor', 'orb0', 'orb1', 'orb2', 'orb3', 'energy', 'arcs', 'optic']
GAME = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))
CONTRACT = {'muzzle': [0, 0.07, -0.74], 'sightHeight': 0.17,
            'rotorPivot': [-0.103, 0.009, -0.22], 'energyPivot': [0, 0.07, -0.64]}


def bounds(vertices):
    return {'min': [min(v[i] for v in vertices) for i in range(3)],
            'max': [max(v[i] for v in vertices) for i in range(3)]}


def triangle_uv_area(vertices, indices, at):
    a, b, c = [vertices[indices[at + i]][6:8] for i in range(3)]
    return abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2


def run():
    DOCS.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    bpy.context.view_layer.update()
    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()
    source = sorted((o for o in scene.objects if o.type == 'MESH' and o.get('part') in PARTS), key=lambda o: o.name)
    assert source, 'No meshes carrying the TB-4 part contract were found'
    materials = []
    batches = {}
    degenerate_skipped = 0
    source_counts = {part: 0 for part in PARTS}
    source_orbs = [{'name': obj.name, 'part': obj['part']} for obj in source
                   if any(mat and mat.get('tbOrb') for mat in obj.data.materials)]
    for obj in source:
        part = obj['part']
        source_counts[part] += 1
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            mesh.calc_loop_triangles()
            assert mesh.uv_layers.active, f'{obj.name}: active UV map is required'
            uv = mesh.uv_layers.active.data
            world = evaluated.matrix_world
            normals = GAME @ world.to_3x3().inverted().transposed()
            mirrored = world.to_3x3().determinant() < 0
            for triangle in mesh.loop_triangles:
                material = mesh.materials[triangle.material_index]
                assert material, f'{obj.name}: missing material'
                if material not in materials:
                    materials.append(material)
                mi = materials.index(material)
                batch = batches.setdefault((part, mi), {'vertices': [], 'indices': [], 'lookup': {}})
                loops = list(triangle.loops)
                if mirrored:
                    loops.reverse()
                corners = []
                source_uvs = []
                for li in loops:
                    loop = mesh.loops[li]
                    position = GAME @ (world @ mesh.vertices[loop.vertex_index].co)
                    normal = (normals @ mesh.corner_normals[li].vector).normalized()
                    coord = uv[li].uv
                    # Blender's image origin is bottom-left; glTF's is top-left.
                    # GLTFLoader sets flipY=false, so bake the convention here.
                    vertex = tuple(round(float(v), 8) for v in (*position, *normal, coord.x, 1 - coord.y))
                    assert all(math.isfinite(v) for v in vertex), f'{obj.name}: non-finite vertex'
                    corners.append(vertex)
                    source_uvs.append([round(float(coord.x), 8), round(float(coord.y), 8)])
                # Sphere poles and tiny bevel tips can contain collapsed faces.
                # Test after float32 conversion, which is what glTF stores.
                points = [Vector(struct.unpack('<3f', struct.pack('<3f', *v[:3]))) for v in corners]
                if (points[1] - points[0]).cross(points[2] - points[0]).length_squared <= 1e-24:
                    degenerate_skipped += 1
                    continue
                for vertex, source_uv in zip(corners, source_uvs):
                    if vertex not in batch['lookup']:
                        batch['lookup'][vertex] = len(batch['vertices'])
                        batch['vertices'].append(vertex)
                    batch['indices'].append(batch['lookup'][vertex])
                    if 'uv_source_sample' not in batch and abs(source_uv[1] - 0.5) > 1e-3:
                        batch['uv_source_sample'] = {'vertex': batch['lookup'][vertex], 'blender_uv': source_uv}
        finally:
            evaluated.to_mesh_clear()
    assert all(source_counts.values()), f'Missing parts: {source_counts}'

    textures = []
    exported_materials = []
    uses_emissive_strength = False
    for material in materials:
        shader = next(n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        pbr = {'baseColorFactor': list(shader.inputs['Base Color'].default_value),
               'metallicFactor': float(shader.inputs['Metallic'].default_value),
               'roughnessFactor': float(shader.inputs['Roughness'].default_value)}
        extras = {'partMaterial': material.name}
        uri = material.get('textureFile')
        # Energy materials keep a library reference for editing, but disconnect
        # the image in Blender so their blue/white discharge stays unmodulated.
        if uri and shader.inputs['Base Color'].is_linked:
            assert uri.startswith('textures/') and '..' not in Path(uri).parts, f'Unsafe texture URI: {uri}'
            assert (OUT / uri).is_file(), f'Missing texture: {uri}'
            if uri not in textures:
                textures.append(uri)
            tint = list(material.get('textureTint', [1, 1, 1, 1]))
            assert len(tint) == 4 and all(math.isfinite(v) and 0 <= v <= 1 for v in tint), f'{material.name}: invalid texture tint'
            pbr.update({'baseColorFactor': tint, 'baseColorTexture': {'index': textures.index(uri)}})
            extras.update({'textureLibrary': Path(uri).stem,
                           'textureBumpScale': float(material.get('textureBumpScale', 0))})
        for flag in ['tbEnergy', 'tbArc', 'tbOrb']:
            if material.get(flag):
                extras[flag] = True
        entry = {'name': material.name, 'pbrMetallicRoughness': pbr, 'extras': extras}
        color_input = shader.inputs.get('Emission Color') or shader.inputs.get('Emission')
        strength_input = shader.inputs.get('Emission Strength')
        color = list(color_input.default_value[:3]) if color_input else [0, 0, 0]
        strength = float(strength_input.default_value) if strength_input else 1
        if strength > 0 and max(color) > 0:
            normalization = max(1, max(color))
            entry['emissiveFactor'] = [value / normalization for value in color]
            entry['extensions'] = {'KHR_materials_emissive_strength': {'emissiveStrength': strength * normalization}}
            uses_emissive_strength = True
        if pbr['baseColorFactor'][3] < 1:
            entry.update({'alphaMode': 'BLEND', 'doubleSided': True})
        exported_materials.append(entry)

    contract = dict(CONTRACT)
    for name in ['muzzle', 'rotorPivot', 'energyPivot', 'grip', 'support', 'sight']:
        marker = scene.objects.get('marker_' + name) or scene.objects.get(name)
        if marker:
            contract[name] = [round(float(v), 8) for v in GAME @ marker.matrix_world.translation]
    if 'sight' in contract:
        contract['sightHeight'] = contract['sight'][1]
    doc = {'asset': {'version': '2.0', 'generator': 'Voxel Blitz TB-4 Blender exporter',
                     'extras': {'blenderAsset': 'thunderbolt', 'contract': contract}},
           'scene': 0, 'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [], 'materials': exported_materials,
           'images': [{'uri': uri, 'name': uri} for uri in textures],
           'textures': [{'source': i, 'sampler': 0} for i in range(len(textures))],
           'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}],
           'buffers': [], 'bufferViews': [], 'accessors': []}
    if uses_emissive_strength:
        doc['extensionsUsed'] = ['KHR_materials_emissive_strength']
    binary = bytearray()

    def accessor(values, width, component, kind, target, with_bounds=False):
        while len(binary) % 4:
            binary.append(0)
        start = len(binary)
        binary.extend(struct.pack('<' + ('f' if component == 5126 else 'I') * len(values), *values))
        vi = len(doc['bufferViews'])
        doc['bufferViews'].append({'buffer': 0, 'byteOffset': start, 'byteLength': len(binary) - start, 'target': target})
        entry = {'bufferView': vi, 'componentType': component, 'count': len(values) // width, 'type': kind}
        if with_bounds:
            entry['min'] = [min(values[i::width]) for i in range(width)]
            entry['max'] = [max(values[i::width]) for i in range(width)]
        doc['accessors'].append(entry)
        return len(doc['accessors']) - 1

    primitive_report = {}
    part_bounds = {}
    draws = triangles = 0
    for part in PARTS:
        wrapper_index = len(doc['nodes'])
        wrapper = {'name': part, 'children': [], 'extras': {'blenderAsset': 'thunderbolt', 'part': part}}
        doc['nodes'].append(wrapper)
        doc['scenes'][0]['nodes'].append(wrapper_index)
        keys = sorted((k for k in batches if k[0] == part), key=lambda k: materials[k[1]].name)
        part_vertices = []
        for key in keys:
            batch = batches[key]
            vertices, indices = batch['vertices'], batch['indices']
            mi = key[1]
            assert vertices and indices and len(indices) % 3 == 0
            attrs = {}
            for name, start, end in [('POSITION', 0, 3), ('NORMAL', 3, 6), ('TEXCOORD_0', 6, 8)]:
                attrs[name] = accessor([v for vertex in vertices for v in vertex[start:end]], end - start,
                                       5126, 'VEC' + str(end - start), 34962, name == 'POSITION')
            primitive = {'attributes': attrs, 'indices': accessor(indices, 1, 5125, 'SCALAR', 34963), 'material': mi}
            name = part + '_' + str(len(wrapper['children']))
            mesh_index = len(doc['meshes'])
            doc['meshes'].append({'name': name, 'primitives': [primitive]})
            wrapper['children'].append(len(doc['nodes']))
            doc['nodes'].append({'name': name, 'mesh': mesh_index,
                                 'extras': {'blenderAsset': 'thunderbolt', 'part': part}})
            count = len(indices) // 3
            nondegenerate = sum(triangle_uv_area(vertices, indices, i) > 1e-12 for i in range(0, len(indices), 3))
            assert nondegenerate > 0, f'{name}: collapsed UV coordinates'
            primitive_report[part + ' | ' + materials[mi].name] = {
                'triangles': count, 'vertices': len(vertices), 'bounds': bounds(vertices),
                'uv_triangles': nondegenerate,
                'uv_source_sample': batch['uv_source_sample'],
                'uv_min': [min(v[i] for v in vertices) for i in [6, 7]],
                'uv_max': [max(v[i] for v in vertices) for i in [6, 7]]}
            triangles += count
            draws += 1
            part_vertices.extend(vertices)
        part_bounds[part] = bounds(part_vertices)

    doc['buffers'] = [{'uri': 'thunderbolt.bin', 'byteLength': len(binary)}]
    (OUT / 'thunderbolt.bin').write_bytes(binary)
    (OUT / 'thunderbolt.gltf').write_text(json.dumps(doc, separators=(',', ':')) + '\n')

    # The portable asset embeds the same geometry buffer and exact texture files.
    portable = copy.deepcopy(doc)
    embedded = bytearray(binary)
    for item in portable['images']:
        while len(embedded) % 4:
            embedded.append(0)
        start = len(embedded)
        texture_path = OUT / item.pop('uri')
        embedded.extend(texture_path.read_bytes())
        mime = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png'}.get(texture_path.suffix.lower())
        assert mime, f'Unsupported texture format: {texture_path.name}'
        item.update({'bufferView': len(portable['bufferViews']), 'mimeType': mime})
        portable['bufferViews'].append({'buffer': 0, 'byteOffset': start, 'byteLength': len(embedded) - start})
    portable['buffers'] = [{'byteLength': len(embedded)}]
    while len(embedded) % 4:
        embedded.append(0)
    payload = json.dumps(portable, separators=(',', ':')).encode()
    payload += b' ' * (-len(payload) % 4)
    body = struct.pack('<II', len(payload), 0x4e4f534a) + payload
    body += struct.pack('<II', len(embedded), 0x004e4942) + embedded
    (DOCS / 'thunderbolt.glb').write_bytes(struct.pack('<III', 0x46546c67, 2, 12 + len(body)) + body)
    assert embedded[:len(binary)] == binary

    entry = {'asset': 'thunderbolt', 'source_parts': len(source), 'draws': draws,
             'triangles': triangles, 'geometry_bytes': len(binary)}
    report = {'passed': True, **entry, 'source_blend': 'docs/design/blender/thunderbolt/thunderbolt.blend',
              'runtime': 'public/assets/blender/thunderbolt.gltf',
              'portable': 'docs/design/blender/thunderbolt/thunderbolt.glb',
              'portable_geometry_matches_runtime': True, 'geometry_sha256': hashlib.sha256(binary).hexdigest(),
              'zero_area_source_triangles_omitted': degenerate_skipped,
              'uv_transform': 'Blender (u, v) -> glTF (u, 1-v)',
              'source_parts_per_group': source_counts, 'part_bounds': part_bounds,
              'orb_source_meshes': source_orbs,
              'bounds': bounds([v for b in batches.values() for v in b['vertices']]),
              'contract': contract, 'materials': len(materials), 'textures': textures,
              'material_surfaces': {m['name']: {'baseColorFactor': m['pbrMetallicRoughness']['baseColorFactor'],
                                               'extras': m['extras']} for m in exported_materials},
              'primitives': primitive_report,
              'budgets': {'triangles': 40000, 'draws': 35,
                          'within_target': triangles <= 40000 and draws <= 35}}
    (DOCS / 'export-report.json').write_text(json.dumps(report, indent=2) + '\n')
    manifest_path = DOCS / 'manifest.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    manifest.update(report)
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    runtime_manifest_path = OUT / 'manifest.json'
    runtime_manifest = json.loads(runtime_manifest_path.read_text())
    runtime_manifest['assets'] = sorted([a for a in runtime_manifest['assets'] if a['asset'] != 'thunderbolt'] + [entry],
                                        key=lambda a: a['asset'])
    runtime_manifest_path.write_text(json.dumps(runtime_manifest, indent=2) + '\n')
    print(json.dumps({**entry, 'within_target': report['budgets']['within_target']}, indent=2))


run()
