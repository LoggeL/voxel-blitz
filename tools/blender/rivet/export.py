"""Batch Rivet's rigid parts into the indexed glTF consumed by the game.

Run from the repository root with python3 -m tools.blender.rivet.export.
"""

import json
import struct
from collections import defaultdict
from math import acos
from pathlib import Path

from .distance_mesh import distant_triangles, seams_by_part
from .materials import MATERIALS
from .model import build_model, cross, dot, sub, unit
from .occlusion import bake_occlusion


def corners(piece, *, indexed=False):
    """Triangulated position, normal and glTF UV corners, shared by both exports."""
    verts = piece.verts
    triangles = []
    sums = [[0., 0., 0.] for _ in verts]
    for face in piece.faces:
        for j in range(1, len(face)-1):
            ids = (face[0], face[j], face[j+1])
            a, b, c = [verts[i] for i in ids]
            face_normal = unit(cross(sub(b, a), sub(c, a)))
            if face_normal == (0, 0, 0):
                continue
            triangles.append((ids, face_normal))
            if not piece.smooth or piece.normals:
                continue
            for k, i in enumerate(ids):
                one = unit(sub(verts[ids[(k+1) % 3]], verts[i]))
                two = unit(sub(verts[ids[(k+2) % 3]], verts[i]))
                angle = acos(max(-1, min(1, dot(one, two))))
                for axis in range(3):
                    sums[i][axis] += face_normal[axis] * angle
    normals = piece.normals or ([unit(n) for n in sums] if piece.smooth else None)
    for ids, face_normal in triangles:
        # Repeat surface grain in metres so a tiny buckle and a large
        # backpack don't show identical, differently scaled swatches.
        axis = max(range(3), key=lambda k: abs(face_normal[k]))
        u, v = ((2, 1), (0, 2), (0, 1))[axis]
        tri = tuple((verts[i], normals[i] if normals else face_normal,
                     piece.uvs[i] if piece.uvs else (verts[i][u]*3.2, -verts[i][v]*3.2))
                    for i in ids)
        yield (ids, tri) if indexed else tri


def write_runtime(model, output_dir):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    doc = {'asset': {'version': '2.0', 'generator': 'Voxel Blitz RIVET field operator'},
           'scene': 0, 'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [],
           'materials': [], 'images': [], 'textures': [], 'bufferViews': [], 'accessors': []}
    material_ids, texture_ids = {}, {}
    for key in dict.fromkeys(p.mat for p in model.pieces):
        spec = MATERIALS[key]
        pbr = {'baseColorFactor': [*spec['color'], 1], 'roughnessFactor': spec['roughness'],
               'metallicFactor': spec['metalness']}
        uri = spec.get('texture')
        if uri:
            if uri not in texture_ids:
                texture_ids[uri] = len(doc['images'])
                doc['images'].append({'name': uri, 'uri': uri})
                doc['textures'].append({'name': uri, 'source': texture_ids[uri]})
            pbr['baseColorTexture'] = {'index': texture_ids[uri]}
        material_ids[key] = len(doc['materials'])
        doc['materials'].append({'name': spec['name'], 'pbrMetallicRoughness': pbr,
                                 'extras': spec.get('extras', {})})

    binary = bytearray()

    def accessor(values, width, component, target, bounds=False):
        binary.extend(b'\0' * (-len(binary) % 4))
        start = len(binary)
        fmt = {5126: 'f', 5123: 'H', 5125: 'I', 5121: 'B'}[component]
        binary.extend(struct.pack(f'<{len(values)}{fmt}', *values))
        view = len(doc['bufferViews'])
        doc['bufferViews'].append({'buffer': 0, 'byteOffset': start,
                                   'byteLength': len(binary)-start, 'target': target})
        data = {'bufferView': view, 'componentType': component, 'count': len(values)//width,
                'type': {1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4'}[width]}
        if component == 5121:
            data['normalized'] = True
        if bounds:
            data['min'] = [min(values[i::width]) for i in range(width)]
            data['max'] = [max(values[i::width]) for i in range(width)]
        doc['accessors'].append(data)
        return len(doc['accessors'])-1

    batches = defaultdict(lambda: defaultdict(list))
    occlusion = bake_occlusion(model)
    seams = seams_by_part(model.pieces)
    for i, piece in enumerate(model.pieces):
        batches[piece.part][piece.mat].append((piece, occlusion[i]))
    triangles = draws = far_triangles = far_draws = 0
    for part, by_material in sorted(batches.items()):
        primitives = []
        for material, pieces in sorted(by_material.items()):
            lookup, indices, far_indices = {}, [], []
            for piece, shade in pieces:
                piece_vertices, piece_indices = {}, []
                for ids, tri in corners(piece, indexed=True):
                    for i, (p, n, uv) in zip(ids, tri):
                        attributes = tuple(round(v, 6) for v in (*p, *n, *uv))
                        record = attributes + (round(255*shade[i]),)
                        piece_indices.append(piece_vertices.setdefault(record, len(piece_vertices)))
                vertex_ids = [lookup.setdefault(v, len(lookup)) for v in piece_vertices]
                indices.extend(vertex_ids[j] for j in piece_indices)
                far = distant_triangles(piece_indices, list(piece_vertices), seams[part])
                far_indices.extend(vertex_ids[j] for j in far)
            attrs = {}
            for name, a, b in [('POSITION',0,3), ('NORMAL',3,6), ('TEXCOORD_0',6,8)]:
                attrs[name] = accessor([x for rec in lookup for x in rec[a:b]], b-a, 5126,
                                       34962, bounds=name == 'POSITION')
            attrs['COLOR_0'] = accessor([v for rec in lookup for v in (rec[8], rec[8], rec[8], 255)],
                                        4, 5121, 34962)
            index_type = 5123 if len(lookup) <= 65535 else 5125
            index_id = accessor(indices, 1, index_type, 34963)
            far_id = accessor(far_indices, 1, index_type, 34963) if far_indices else -1
            primitives.append({'attributes': attrs, 'indices': index_id, 'material': material_ids[material],
                               'extras': {'rivetFarIndices': far_id}})
            triangles += len(indices)//3
            draws += 1
            far_triangles += len(far_indices)//3
            far_draws += bool(far_indices)
        mesh_id = len(doc['meshes'])
        doc['scenes'][0]['nodes'].append(len(doc['nodes']))
        doc['nodes'].append({'name': part, 'mesh': mesh_id, 'extras': {'blenderAsset': 'rivet'}})
        doc['meshes'].append({'name': part, 'primitives': primitives})

    doc['buffers'] = [{'uri': 'rivet.bin', 'byteLength': len(binary)}]
    (output_dir/'rivet.bin').write_bytes(binary)
    (output_dir/'rivet.gltf').write_text(json.dumps(doc, separators=(',', ':'))+'\n')
    return {'asset': 'rivet', 'source_parts': len(model.pieces), 'draws': draws,
            'triangles': triangles, 'distance_draws': far_draws,
            'distance_triangles': far_triangles, 'geometry_bytes': len(binary)}


def update_manifest(stats, output):
    path = output/'manifest.json'
    manifest = json.loads(path.read_text())
    for i, asset in enumerate(manifest['assets']):
        if asset['asset'] == 'rivet':
            manifest['assets'][i] = stats
            break
    else:
        manifest['assets'].append(stats)
    path.write_text(json.dumps(manifest, indent=2)+'\n')


if __name__ == '__main__':
    output = Path(__file__).resolve().parents[3]/'public/assets/blender'
    stats = write_runtime(build_model(), output)
    update_manifest(stats, output)
    print(json.dumps(stats))
