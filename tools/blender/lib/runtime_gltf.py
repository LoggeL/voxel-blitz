"""Minimal glTF 2.0 writer for baked weapon studies.

Vertices are written in final gun space (game x, y, z = Blender x, z, -y) with
identity node transforms, split corner normals and atlas UVs (v flipped for
glTF). One top-level node per rig part; one primitive per material.
"""
import json
import struct
from pathlib import Path

import numpy as np

FLOAT, UINT, USHORT = 5126, 5125, 5123
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963


def mesh_arrays(me, uv_layer=None):
    """Per-corner positions, normals and UVs in game space plus triangle corner indices."""
    me.calc_loop_triangles()
    nv, nl, nt = len(me.vertices), len(me.loops), len(me.loop_triangles)
    co = np.empty(nv * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    vi = np.empty(nl, np.int32)
    me.loops.foreach_get('vertex_index', vi)
    nrm = np.empty(nl * 3, np.float32)
    me.corner_normals.foreach_get('vector', nrm)
    nrm = nrm.reshape(-1, 3)
    uv = np.zeros((nl, 2), np.float32)
    layer = me.uv_layers.get(uv_layer) if uv_layer else None
    if layer:
        flat = np.empty(nl * 2, np.float32)
        layer.data.foreach_get('uv', flat)
        uv = flat.reshape(-1, 2).copy()
        uv[:, 1] = 1.0 - uv[:, 1]
    tri = np.empty(nt * 3, np.int32)
    me.loop_triangles.foreach_get('loops', tri)
    tri = tri.reshape(-1, 3)
    poly = np.empty(nt, np.int32)
    me.loop_triangles.foreach_get('polygon_index', poly)
    pos = co[vi]
    pos_g = np.stack([pos[:, 0], pos[:, 2], -pos[:, 1]], axis=1)
    nrm_g = np.stack([nrm[:, 0], nrm[:, 2], -nrm[:, 1]], axis=1)
    length = np.linalg.norm(nrm_g, axis=1, keepdims=True)
    nrm_g = nrm_g / np.maximum(length, 1e-9)
    return pos_g.astype(np.float32), nrm_g.astype(np.float32), uv, tri, poly


def weld(pos, nrm, uv, tri):
    """Index a triangle soup: identical (position, normal, uv) corners share a vertex."""
    corners = tri.reshape(-1)
    packed = np.concatenate([pos[corners], nrm[corners], uv[corners]], axis=1)
    key = np.round(packed * np.array([1e5] * 3 + [1e3] * 3 + [1e5] * 2, np.float32)).astype(np.int64)
    _, first, inverse = np.unique(key, axis=0, return_index=True, return_inverse=True)
    verts = packed[first]
    return verts[:, 0:3], verts[:, 3:6], verts[:, 6:8], inverse.reshape(-1).astype(np.uint32)


def drop_degenerate(pos, tri):
    a, b, c = pos[tri[:, 0]], pos[tri[:, 1]], pos[tri[:, 2]]
    area = np.linalg.norm(np.cross(b - a, c - a), axis=1)
    return tri[area > 1e-12]


class Writer:
    def __init__(self, asset, generator):
        self.asset = asset
        self.doc = {'asset': {'version': '2.0', 'generator': generator, 'extras': {}}, 'scene': 0,
                    'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [], 'materials': [], 'buffers': [],
                    'bufferViews': [], 'accessors': []}
        self.blob = bytearray()
        self.triangles = 0
        self.draws = 0

    def _view(self, data, target):
        while len(self.blob) % 4:
            self.blob.append(0)
        offset = len(self.blob)
        self.blob.extend(data.tobytes())
        self.doc['bufferViews'].append({'buffer': 0, 'byteOffset': offset, 'byteLength': data.nbytes, 'target': target})
        return len(self.doc['bufferViews']) - 1

    def _accessor(self, data, kind, component, target, bounds=False):
        entry = {'bufferView': self._view(data, target), 'componentType': component, 'count': int(data.shape[0]),
                 'type': kind}
        if bounds:
            entry['min'] = [float(v) for v in data.min(axis=0)]
            entry['max'] = [float(v) for v in data.max(axis=0)]
        self.doc['accessors'].append(entry)
        return len(self.doc['accessors']) - 1

    def material(self, definition):
        self.doc['materials'].append(definition)
        return len(self.doc['materials']) - 1

    def textures(self, uris):
        """Register image files; returns their texture indices in order."""
        self.doc.setdefault('samplers', [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}])
        images = self.doc.setdefault('images', [])
        textures = self.doc.setdefault('textures', [])
        out = []
        for uri in uris:
            images.append({'uri': uri, 'name': uri})
            textures.append({'source': len(images) - 1, 'sampler': 0, 'name': uri})
            out.append(len(textures) - 1)
        return out

    def primitive(self, pos, nrm, uv, tri, material, extras=None):
        tri = drop_degenerate(pos, tri)
        p, n, t, index = weld(pos, nrm, uv, tri)
        small = len(p) < 65535
        prim = {'attributes': {
            'POSITION': self._accessor(p.astype(np.float32), 'VEC3', FLOAT, ARRAY_BUFFER, True),
            'NORMAL': self._accessor(n.astype(np.float32), 'VEC3', FLOAT, ARRAY_BUFFER),
            'TEXCOORD_0': self._accessor(t.astype(np.float32), 'VEC2', FLOAT, ARRAY_BUFFER)},
            'indices': self._accessor(index.astype(np.uint16 if small else np.uint32), 'SCALAR',
                                      USHORT if small else UINT, ELEMENT_ARRAY_BUFFER),
            'material': material}
        if extras:
            prim['extras'] = extras
        self.triangles += len(tri)
        self.draws += 1
        return prim, len(tri)

    def node(self, name, primitives=None, translation=None, extras=None):
        node = {'name': name, 'extras': {'blenderAsset': self.asset, **(extras or {})}}
        if primitives:
            self.doc['meshes'].append({'name': name, 'primitives': primitives})
            node['mesh'] = len(self.doc['meshes']) - 1
        if translation is not None:
            node['translation'] = [float(v) for v in translation]
        self.doc['nodes'].append(node)
        self.doc['scenes'][0]['nodes'].append(len(self.doc['nodes']) - 1)

    def write(self, gltf_path):
        gltf_path = Path(gltf_path)
        bin_path = gltf_path.with_suffix('.bin')
        self.doc['buffers'] = [{'uri': bin_path.name, 'byteLength': len(self.blob)}]
        bin_path.write_bytes(bytes(self.blob))
        gltf_path.write_text(json.dumps(self.doc, separators=(',', ':')))
        return len(self.blob)
