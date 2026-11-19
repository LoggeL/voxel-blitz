"""Bake short-range, pose-independent ambient occlusion into the rigid joints.

Thirteen orthographic projections provide 26 symmetric illumination directions.
In each projection, a 2D spatial hash finds the nearest surface along the
vertex's ray. Hit distances fade smoothly over the first six centimetres.
"""
from collections import defaultdict
from itertools import product
from math import acos, floor

from .model import cross, dot, sub, unit

_RADIUS = .06
_BIAS = .00065
_CELL = .012
_STRENGTH = .45


def _joint_mesh(pieces):
    # Blender may split a vertex at each UV seam or even for every triangle
    # corner. Reconstruct the geometric normals per piece before taking the
    # visibility integral so edits and UV splits have identical shading.
    xyz, normals, faces, vertex_lists = [], [], [], []
    for piece in pieces:
        lookup, local_ids = {}, []
        for p in piece.verts:
            position = tuple(round(v, 6) for v in p)
            index = lookup.get(position)
            if index is None:
                index = lookup[position] = len(xyz)
                xyz.append(position)
                normals.append([0., 0., 0.])
            local_ids.append(index)
        vertex_lists.append(local_ids)
        for polygon in piece.faces:
            for j in range(1, len(polygon) - 1):
                ids = local_ids[polygon[0]], local_ids[polygon[j]], local_ids[polygon[j+1]]
                a, b, c = (xyz[i] for i in ids)
                normal = unit(cross(sub(b, a), sub(c, a)))
                if normal == (0, 0, 0):
                    continue
                faces.append(ids)
                for k, i in enumerate(ids):
                    left = unit(sub(xyz[ids[(k+1) % 3]], xyz[i]))
                    right = unit(sub(xyz[ids[(k+2) % 3]], xyz[i]))
                    angle = acos(max(-1., min(1., dot(left, right))))
                    n = normals[i]
                    n[0] += normal[0] * angle
                    n[1] += normal[1] * angle
                    n[2] += normal[2] * angle
    return xyz, [unit(n) for n in normals], faces, vertex_lists


def _bake_direction(positions, normals, faces, direction, weights, shaded):
    # Fold opposite directions into one sweep. The side of the surface
    # receiving light decides which way to search the depth stack.
    u_axis = unit(cross(direction, (0, 1, 0) if abs(direction[1]) < .9 else (1, 0, 0)))
    v_axis = cross(direction, u_axis)
    coords = [(dot(p, u_axis), dot(p, v_axis), dot(p, direction)) for p in positions]
    grid = defaultdict(list)
    for ia, ib, ic in faces:
        ax, ay, az = coords[ia]
        bx, by, bz = coords[ib]
        cx, cy, cz = coords[ic]
        bx -= ax
        by -= ay
        cx -= ax
        cy -= ay
        det = bx*cy - cx*by
        if abs(det) < 1e-12:
            continue
        # Barycentric edge equations and interpolated depth plane.
        iu, ju, iv, jv = cy/det, -cx/det, -by/det, bx/det
        dzdx = (bz-az)*iu + (cz-az)*iv
        dzdy = (bz-az)*ju + (cz-az)*jv
        patch = (ax, ay, az, iu, ju, iv, jv, dzdx, dzdy)
        xmin = floor((ax+min(0., bx, cx)) / _CELL)
        xmax = floor((ax+max(0., bx, cx)) / _CELL)
        ymin = floor((ay+min(0., by, cy)) / _CELL)
        ymax = floor((ay+max(0., by, cy)) / _CELL)
        for x in range(xmin, xmax+1):
            for y in range(ymin, ymax+1):
                grid[x, y].append(patch)

    for i, (sx, sy, sz) in enumerate(coords):
        cosine = dot(normals[i], direction)
        weight = abs(cosine)
        if weight < .015:
            continue
        weights[i] += weight
        sign = 1 if cosine > 0 else -1
        nearest = _RADIUS
        for ax, ay, az, iu, ju, iv, jv, zx, zy in grid.get((floor(sx/_CELL), floor(sy/_CELL)), ()):
            dx, dy = sx-ax, sy-ay
            u = dx*iu + dy*ju
            if u < -1e-7 or u > 1.0000001:
                continue
            v = dx*iv + dy*jv
            if v < -1e-7 or u+v > 1.0000001:
                continue
            gap = (az + dx*zx + dy*zy - sz)*sign
            if _BIAS < gap < nearest:
                nearest = gap
        coverage = 1 - nearest/_RADIUS
        shaded[i] += weight*coverage*coverage*(3 - 2*coverage)


def bake_occlusion(model):
    """Return linear diffuse multipliers indexed by original piece and vertex."""
    groups = defaultdict(list)
    for i, piece in enumerate(model.pieces):
        groups[piece.part].append(i)
    result = [None] * len(model.pieces)
    directions = [unit(d) for d in product((-1, 0, 1), repeat=3)
                  if next((c for c in d if c), 0) == 1]
    for indices in groups.values():
        xyz, normals, faces, local_ids = _joint_mesh([model.pieces[i] for i in indices])
        weights, shaded = [0.] * len(xyz), [0.] * len(xyz)
        for direction in directions:
            _bake_direction(xyz, normals, faces, direction, weights, shaded)
        colors = [1. - _STRENGTH * s/w if w else 1. for s, w in zip(shaded, weights)]
        for i, vertex_ids in zip(indices, local_ids):
            result[i] = [colors[v] for v in vertex_ids]
    return result
