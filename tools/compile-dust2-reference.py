#!/usr/bin/env python3
"""Compile the May 2018 Dust 2 VMF into the shared, authoritative voxel grid.

Usage: python tools/compile-dust2-reference.py path/to/de_dust2_custom.vmf
Requires numpy. Source download/provenance is documented in docs/maps/dust2.md.
The source asset is an offline authoring input, never a runtime dependency.
"""
import base64
import hashlib
import itertools
import json
import math
from pathlib import Path
import re
import sys
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE_SHA = '5e692292eb59b5ad73e3036bfa074527acf4dab6157d50b822efbac5415090a1'
SIZE = np.array([128, 40, 96])
ORIGIN = np.array([64 + 212.5 / 48, 15, 48 + 975 / 48])
SANDSTONE, PLASTER, ROCK, FLOOR, TRIM, TILE, CRATE, WOOD = range(21, 29)
grid = np.zeros((40, 96, 128), dtype=np.uint8)
grid[:9] = ROCK
grid[0] = 8


def transform(points):
    p = np.asarray(points, dtype=float)
    return p[..., [0, 2, 1]] * [1 / 48, 1 / 48, -1 / 48] + ORIGIN


def numbers(value):
    return np.array([float(x) for x in re.findall(r'-?\d+(?:\.\d+)?(?:e[+-]?\d+)?', value, re.I)])


def parse_vmf(text):
    tokens = iter(re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"|([{}])|([^\s{}"]+)', text))
    def token(t):
        return next(x for x in t if x != '') if any(t) else ''
    def node():
        result = {}
        for t in tokens:
            key = token(t)
            if key == '}':
                return result
            value = token(next(tokens))
            if value == '{':
                result.setdefault(key, []).append(node())
            else:
                result[key] = value
        return result
    return node()


def material(name):
    name = name.lower()
    if 'tools/' in name:
        return None
    if any(s in name for s in ['grass', 'bush', 'foliage']):
        return 6
    if any(s in name for s in ['wood', 'door']):
        return WOOD
    if any(s in name for s in ['crate', 'box']):
        return CRATE
    if any(s in name for s in ['rock', 'cliff']):
        return ROCK
    if any(s in name for s in ['ground', 'sand_', 'floor', 'concrete']):
        return FLOOR
    if any(s in name for s in ['trim', 'stair', 'tilefloor']):
        return TRIM
    if any(s in name for s in ['tile', 'blue']):
        return TILE
    if any(s in name for s in ['metal', 'rail', 'rust']):
        return 13
    if any(s in name for s in ['brick', 'stone', 'kasbah']):
        return SANDSTONE
    return PLASTER


def candidates(lo, hi):
    lo = np.maximum(0, lo.astype(int))
    hi = np.minimum(SIZE - 1, hi.astype(int))
    if np.any(lo > hi):
        return np.empty((0, 3))
    return np.stack(np.meshgrid(*[np.arange(lo[k], hi[k]+1) for k in range(3)], indexing='ij'), axis=-1).reshape(-1, 3)


def put(points, mat):
    if len(points):
        p = points.astype(int)
        grid[p[:, 1], p[:, 2], p[:, 0]] = mat


def triangle(vertices, mat):
    """Conservative triangle-box SAT, preserving thin arches and displacement skins."""
    vertices = transform(vertices)
    if not np.all(np.isfinite(vertices)):
        return
    p = candidates(np.floor(vertices.min(axis=0)), np.floor(vertices.max(axis=0)))
    if not len(p):
        return
    edges = np.roll(vertices, -1, axis=0) - vertices
    axes = [np.cross(edges[0], edges[1])]
    axes += [np.cross(e, a) for e in edges for a in np.eye(3)]
    mask = np.ones(len(p), dtype=bool)
    for axis in axes:
        if np.linalg.norm(axis) < 1e-8:
            continue
        dots = vertices @ axis
        centers = (p + .5) @ axis
        radius = np.abs(axis).sum() * .501
        mask &= (centers + radius >= dots.min()) & (centers - radius <= dots.max())
    put(p[mask], mat)


def solid(brush):
    sides = brush.get('side', [])
    mats = [material(s.get('material', '')) for s in sides]
    if not any(mats):
        return
    planes = np.array([numbers(s['plane']).reshape(3, 3) for s in sides])
    normals = -np.cross(planes[:, 1] - planes[:, 0], planes[:, 2] - planes[:, 0])
    lengths = np.linalg.norm(normals, axis=1)
    if (lengths < 1e-8).any():
        return
    normals /= lengths[:, None]
    distances = (normals * planes[:, 0]).sum(axis=1)
    vertices = []
    for indices in itertools.combinations(range(len(sides)), 3):
        matrix = normals[list(indices)]
        if abs(np.linalg.det(matrix)) < 1e-6:
            continue
        point = np.linalg.solve(matrix, distances[list(indices)])
        if np.all(normals @ point <= distances + .08):
            vertices.append(point)
    if not vertices:
        return
    vertices = np.unique(np.round(vertices, 4), axis=0)
    world = transform(vertices)
    lo, hi = np.floor(world.min(axis=0)), np.floor(world.max(axis=0))
    if np.any(hi < 0) or np.any(lo >= SIZE):
        return
    # Solid interior: original brush halfspaces, not its enclosing rectangle.
    if not any('dispinfo' in s for s in sides):
        p = candidates(lo, hi)
        if len(p):
            source = ((p + .5 - ORIGIN) * [48, 48, -48])[:, [0, 2, 1]]
            dots = source @ normals.T - distances
            inside = (dots <= .08).all(axis=1)
            nearest = dots[inside].argmax(axis=1)
            default = next(m for m in mats if m)
            put(p[inside], np.array([mats[i] or default for i in nearest]))
    # Rendered surfaces retain sub-voxel wall skins and the actual arch cuts.
    for i, side in enumerate(sides):
        if mats[i] is None:
            continue
        face = vertices[np.abs(vertices @ normals[i] - distances[i]) < .15]
        if len(face) < 3:
            continue
        center = face.mean(axis=0)
        u = face[0] - center
        u /= np.linalg.norm(u)
        v = np.cross(normals[i], u)
        face = face[np.argsort(np.arctan2((face-center) @ v, (face-center) @ u))]
        if 'dispinfo' in side and len(face) == 4:
            disp = side['dispinfo'][0]
            start = numbers(disp['startposition'])
            face = np.roll(face, -np.argmin(np.linalg.norm(face-start, axis=1)), axis=0)
            n = 2**int(disp['power']) + 1
            ds = np.array([numbers(disp['distances'][0][f'row{j}']) for j in range(n)])
            ns = np.array([numbers(disp['normals'][0][f'row{j}']).reshape(n, 3) for j in range(n)])
            offsets = disp.get('offsets', [{}])[0]
            os = np.array([numbers(offsets.get(f'row{j}', ' '.join(['0']*(n*3)))).reshape(n, 3) for j in range(n)])
            surface = np.zeros((n, n, 3))
            for row in range(n):
                for col in range(n):
                    a, b = col/(n-1), row/(n-1)
                    surface[row, col] = ((1-a)*(1-b)*face[0] + a*(1-b)*face[1]
                        + a*b*face[2] + (1-a)*b*face[3] + ns[row, col]*ds[row, col] + os[row, col])
            for row in range(n-1):
                for col in range(n-1):
                    a,b,c,d = surface[row,col],surface[row,col+1],surface[row+1,col+1],surface[row+1,col]
                    triangle([a,b,c], mats[i]); triangle([a,c,d], mats[i])
        else:
            for j in range(1, len(face)-1):
                triangle([face[0], face[j], face[j+1]], mats[i])


def oriented_box(origin, yaw, lo, hi, mat):
    angle = math.radians(yaw)
    rotation = np.array([[math.cos(angle), -math.sin(angle), 0], [math.sin(angle), math.cos(angle), 0], [0,0,1]])
    corners = np.array(list(itertools.product(*zip(lo, hi)))) @ rotation.T + origin
    w = transform(corners)
    p = candidates(np.floor(w.min(axis=0)), np.floor(w.max(axis=0)))
    source = ((p + .5 - ORIGIN) * [48,48,-48])[:,[0,2,1]]
    local = (source-origin) @ rotation
    # Half-cell pad keeps the small original shutters/railings visible.
    mask = (local >= np.array(lo)-12).all(axis=1) & (local <= np.array(hi)+12).all(axis=1)
    put(p[mask], mat)


def props(entities):
    count = 0
    for entity in entities:
        if entity.get('classname') != 'prop_static':
            continue
        name = entity.get('model', '').lower()
        origin = numbers(entity.get('origin', '0 0 0'))
        yaw = numbers(entity.get('angles', '0 0 0'))[1]
        w = transform(origin)
        if np.any(w < [0,0,0]) or np.any(w >= SIZE):
            continue
        def box(lo, hi, mat):
            oriented_box(origin, yaw, lo, hi, mat)
        dimensions = re.search(r'(\d+)x(\d+)(?:x(\d+))?', name)
        if 'crate_style' in name and dimensions and dimensions[3]:
            x,y,z = map(int, dimensions.groups())
            box([-x/2,-y/2,0], [x/2,y/2,z], CRATE)
        elif ('window' in name or 'dust_door_' in name or 'rollupdoor' in name) and dimensions:
            x,z = int(dimensions[1]),int(dimensions[2])
            box([-5,-x/2,0],[5,x/2,z], WOOD if 'wood' in name or 'door' in name else TILE)
        elif 'barrel' in name and 'cluster' not in name:
            box([-15,-15,0],[15,15,48],13)
        elif 'garbage_container' in name:
            box([-38,-64,0],[38,64,64],TILE)
        elif 'car' in name and ('wreck' in name or 'sedan' in name):
            box([-95,-40,8],[95,40,46],TRIM)
            box([-42,-34,46],[48,34,78],TILE)
            for x in [-62,62]:
                for y in [-39,39]:
                    box([x-15,y-6,0],[x+15,y+6,28],18)
        elif 'flatbed' in name:
            box([-120,-45,15],[120,45,46],13)
            box([55,-42,46],[115,42,110],TRIM)
        elif 'palm_tree' in name and 'skybox' not in name:
            box([-9,-9,0],[9,9,330],WOOD)
            box([-100,-22,305],[100,22,345],6)
            box([-22,-100,305],[22,100,345],6)
        elif 'ac_unit' in name:
            box([-18,-32,0],[18,32,38],TRIM)
        elif 'kasbah_merlon' in name:
            box([-20,-20,0],[20,20,48],SANDSTONE)
        else:
            continue
        count += 1
    return count


def main():
    source = Path(sys.argv[1])
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCE_SHA:
        raise ValueError('Expected verified May 8 2018 de_dust2 VMF; see docs/maps/dust2.md')
    tree = parse_vmf(raw.decode('utf8'))
    brushes = tree['world'][0].get('solid', [])
    for entity in tree.get('entity', []):
        if entity.get('classname') in ('func_detail', 'func_brush', 'func_wall'):
            brushes.extend(entity.get('solid', []))
    for i, brush in enumerate(brushes):
        solid(brush)
        if i % 1000 == 0:
            print(f'Brushes {i}/{len(brushes)}', flush=True)
    prop_count = props(tree.get('entity', []))
    flat = grid.ravel()
    encoded = bytearray()
    begin = 0
    while begin < len(flat):
        end = begin + 1
        while end < len(flat) and flat[end] == flat[begin] and end-begin < 65535:
            end += 1
        n = end-begin
        encoded.extend([n & 255, n >> 8, int(flat[begin])])
        begin = end
    data = base64.b64encode(encoded).decode()
    output = ROOT / 'shared/world/dust2-reference-data.js'
    output.write_text('// Generated by tools/compile-dust2-reference.py. See docs/maps/dust2.md.\n'
        + f'export const DUST2_SOURCE_SHA256 = {json.dumps(SOURCE_SHA)};\n'
        + f'export const DUST2_REFERENCE_RLE = {json.dumps(data)};\n')
    print(f'{len(brushes)} brushes, {prop_count} voxel props, {np.count_nonzero(grid)} blocks, {len(data)} encoded bytes', flush=True)


if __name__ == '__main__':
    main()
