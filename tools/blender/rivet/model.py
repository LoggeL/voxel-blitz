"""Rivet's editable surfaces in the game's rigid, Y-up joint frames (metres)."""

from dataclasses import dataclass
from math import cos, copysign, pi, sin, sqrt


def sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def cross(a, b):
    return (a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0])


def unit(v):
    length = sqrt(dot(v, v))
    return tuple(x / length for x in v) if length else (0, 0, 0)


@dataclass
class Piece:
    part: str
    name: str
    mat: str
    verts: list
    faces: list
    smooth: bool
    normals: list | None = None
    uvs: list | None = None


class MeshModel:
    def __init__(self):
        self.pieces = []

    def mesh(self, part, name, mat, vertices, faces, smooth=True, normals=None, uvs=None):
        piece = Piece(part, name, mat, list(vertices), list(faces), smooth, normals, uvs)
        self.pieces.append(piece)
        return piece

    def surface(self, part, name, mat, rows):
        """An open panel. Ascending rows and left-to-right columns face the camera (-Z)."""
        h, w = len(rows), len(rows[0])
        faces = []
        for y in range(h-1):
            for x in range(w-1):
                i = y*w+x
                faces.append((i, i+w, i+w+1, i+1))
        uvs = ([(x/(w-1), 1-y/(h-1)) for y in range(h) for x in range(w)]
               if mat == 'visor' else None)
        return self.mesh(part, name, mat, [p for row in rows for p in row], faces, uvs=uvs)

    def loft(self, part, name, mat, rings, segments=24, exponent=1.0):
        """Varying elliptical sections. A smaller exponent squares off their corners."""
        vertices = []
        for y, rx, rz, cx, cz in rings:
            for i in range(segments):
                a = i * 2 * pi / segments
                sx, sz = sin(a), -cos(a)
                vertices.append((cx + rx * copysign(abs(sx)**exponent, sx), y,
                                 cz + rz * copysign(abs(sz)**exponent, sz)))
        faces = []
        for j in range(len(rings)-1):
            for i in range(segments):
                a = j * segments + i
                b = j * segments + (i+1) % segments
                faces.append((a, a+segments, b+segments, b))
        faces += [tuple(range(segments)), tuple(reversed(range(len(vertices)-segments, len(vertices))))]
        return self.mesh(part, name, mat, vertices, faces)

    def ellipsoid(self, part, name, mat, center, radii, segments=16, rings=10):
        # Single pole vertices avoid rings of degenerate triangles at the tips.
        cx, cy, cz = center
        rx, ry, rz = radii
        verts = [(cx, cy-ry, cz)]
        normals = [(0, -1, 0)]
        for j in range(1, rings):
            phi = -pi/2 + j*pi/rings
            for i in range(segments):
                a = i*2*pi/segments
                x, y, z = cos(phi)*sin(a), sin(phi), -cos(phi)*cos(a)
                verts.append((cx+rx*x, cy+ry*y, cz+rz*z))
                normals.append(unit((x/rx, y/ry, z/rz)))
        top = len(verts)
        verts.append((cx, cy+ry, cz))
        normals.append((0, 1, 0))
        faces = []
        for i in range(segments):
            a, b = 1+i, 1+(i+1) % segments
            faces.append((0, a, b))
            for j in range(rings-2):
                faces.append((a, a+segments, b+segments, b))
                a, b = a+segments, b+segments
            faces.append((a, top, b))
        return self.mesh(part, name, mat, verts, faces, normals=normals)

    def tube(self, part, name, mat, points, radius, sides=8):
        """Sweep a round section along a seam, cable, folded binding or length of cord."""
        # Closed seams often repeat their first point. Transport the first
        # section across that join too so the ends meet without a pinch.
        points = [p for i, p in enumerate(points) if i == 0 or p != points[i-1]]
        closed = len(points) > 2 and points[0] == points[-1]
        if closed:
            points.pop()
        if len(points) < 2:
            raise ValueError(f'{name}: a tube needs two distinct points')
        stations = len(points)
        verts, faces = [], []
        axis = None
        for j, p in enumerate(points):
            prev = points[(j-1) % stations] if closed else points[max(0, j-1)]
            nxt = points[(j+1) % stations] if closed else points[min(stations-1, j+1)]
            tangent = unit(sub(nxt, prev))
            if axis is None:
                axis = (0, 1, 0) if abs(tangent[1]) < .85 else (1, 0, 0)
            second = unit(cross(tangent, axis))
            axis = cross(second, tangent)
            for i in range(sides):
                angle = 2*pi*i/sides
                verts.append(tuple(p[k] + radius*(axis[k]*cos(angle) + second[k]*sin(angle))
                                   for k in range(3)))
        for j in range(stations if closed else stations-1):
            next_row = (j+1) % stations * sides
            for i in range(sides):
                ni = (i+1) % sides
                faces.append((j*sides+i, j*sides+ni, next_row+ni, next_row+i))
        if not closed:
            faces += [tuple(reversed(range(sides))), tuple(range(len(verts)-sides, len(verts)))]
        return self.mesh(part, name, mat, verts, faces)

    def box(self, part, name, mat, center, size, bevel=.004):
        """Chamfer the twelve edges and clip the eight corners of a fitting."""
        half = [s/2 for s in size]
        radius = min(bevel, min(half)*.8)
        vertices, faces, lookup = [], [], {}

        def face(points, outward):
            normal = cross(sub(points[1], points[0]), sub(points[2], points[0]))
            if dot(normal, outward) < 0:
                points.reverse()
            indices = []
            for p in points:
                key = tuple(p)
                if key not in lookup:
                    lookup[key] = len(vertices)
                    vertices.append(tuple(x+c for x, c in zip(key, center)))
                indices.append(lookup[key])
            faces.append(indices)

        def corner(signs, face_axis):
            return [s*(half[k] - (0 if k == face_axis else radius)) for k, s in enumerate(signs)]

        for axis in range(3):
            a, b = (axis+1) % 3, (axis+2) % 3
            for sign in (-1, 1):
                points = []
                for sa, sb in [(-1,-1), (1,-1), (1,1), (-1,1)]:
                    signs = [0, 0, 0]
                    signs[axis], signs[a], signs[b] = sign, sa, sb
                    points.append(corner(signs, axis))
                outward = [0, 0, 0]
                outward[axis] = sign
                face(points, outward)
            if radius:
                for sa in (-1, 1):
                    for sb in (-1, 1):
                        signs = [0, 0, 0]
                        signs[axis], signs[a], signs[b] = -1, sa, sb
                        points = [corner(signs, a), corner(signs, b)]
                        signs[axis] = 1
                        points.extend([corner(signs, b), corner(signs, a)])
                        signs[axis] = 0
                        face(points, signs)
        if radius:
            for sx in (-1, 1):
                for sy in (-1, 1):
                    for sz in (-1, 1):
                        signs = (sx, sy, sz)
                        face([corner(signs, i) for i in range(3)], signs)
        return self.mesh(part, name, mat, vertices, faces, smooth=False)


def build_model():
    from .arms import build_arms
    from .carrier import build_carrier
    from .head import build_head
    from .limbs import build_lower_body

    model = MeshModel()
    build_carrier(model)
    build_head(model)
    build_arms(model)
    build_lower_body(model)
    return model
