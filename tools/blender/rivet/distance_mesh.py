"""Coarsen each authored surface independently; reuse vertices of the close mesh."""

from math import floor, sqrt

from .model import cross, dot, sub


# About one screen pixel at the distance transition on a 1080p display.
CELL = .032


def distant_triangles(indices, vertices, shared_edges):
    lo = [min(p[k] for p in vertices) for k in range(3)]
    hi = [max(p[k] for p in vertices) for k in range(3)]
    sizes = sorted(b-a for a, b in zip(lo, hi))
    if sizes[1] < .040 or sizes[2] < .050:
        return []
    # A curved length of stitching can span a large box while covering
    # only a fraction of a pixel across its width. Drop those pieces too.
    area = 0.
    for j in range(0, len(indices), 3):
        a, b, c = [vertices[i][:3] for i in indices[j:j+3]]
        n = cross(sub(b, a), sub(c, a))
        area += .5*sqrt(dot(n, n))
    if area < sizes[2]*.019:
        return []

    cells = {}
    groups = {}
    for i, vertex in enumerate(vertices):
        p, normal = vertex[:3], vertex[3:6]
        if p in shared_edges:
            # Sleeves and team yokes meet edge-to-edge. Both sides must
            # preserve exactly the same silhouette along that sewn line.
            key = ('edge', p)
            error = 0
        else:
            cell = tuple(floor(x/CELL) for x in p)
            # Preserve hard panel and toe edges that land in the same cell.
            axis = max(range(3), key=lambda k: abs(normal[k]))
            key = (cell, axis, normal[axis] < 0)
            error = sum((x/CELL-c-.5)**2 for x, c in zip(p, cell))
        if key not in cells or error < cells[key][0]:
            cells[key] = (error, i)
        groups[i] = key

    result = []
    for i in range(0, len(indices), 3):
        a, b, c = [cells[groups[j]][1] for j in indices[i:i+3]]
        if a != b and a != c and b != c:
            result.extend((a, b, c))
    return result


def seams_by_part(pieces):
    """Geometry boundaries shared by two separately editable surfaces."""
    seen, seams = {}, {}
    for piece in pieces:
        lookup = seen.setdefault(piece.part, set())
        shared = seams.setdefault(piece.part, set())
        points = {tuple(round(v, 6) for v in p) for p in piece.verts}
        shared.update(lookup.intersection(points))
        lookup.update(points)
    return seams
