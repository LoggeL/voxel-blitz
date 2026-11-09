"""Hard-surface modelling kit for script-authored weapon studies.

Every helper takes and returns GAME gun-space coordinates (metres):
+x right, +y up, -z toward the muzzle. Geometry is committed to Blender as
(x, -z, y), the same convention the older studies use, so the runtime export
is a plain axis swap.

The kit builds mid-poly geometry: real chamfers (two bevel segments) and
filleted outlines instead of unit cubes, so a model carries its own rounded
silhouette and the bake only has to add surface detail.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector

G2B = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
B2G = G2B.inverted()
TAU = math.tau


def game(v):
    """Blender vector -> game vector."""
    return Vector((v[0], v[2], -v[1]))


def blender(v):
    """Game vector -> Blender vector."""
    return Vector((v[0], -v[2], v[1]))


# ---------------------------------------------------------------- 2D outlines
def fillet(points, radius, steps=5):
    """Round the corners of a closed 2D polygon.

    `radius` is one number or a per-vertex list; a corner whose radius is 0
    stays sharp. Arc length is clamped to 45 % of the shorter adjacent edge.
    """
    n = len(points)
    radii = radius if isinstance(radius, (list, tuple)) else [radius] * n
    out = []
    for i in range(n):
        a = Vector(points[i - 1]).to_2d()
        b = Vector(points[i]).to_2d()
        c = Vector(points[(i + 1) % n]).to_2d()
        r = radii[i]
        ab, cb = (a - b), (c - b)
        la, lc = ab.length, cb.length
        if r <= 0 or la < 1e-9 or lc < 1e-9:
            out.append((b.x, b.y))
            continue
        ab.normalize()
        cb.normalize()
        cosang = max(-1.0, min(1.0, ab.dot(cb)))
        ang = math.acos(cosang)
        if ang < 1e-3 or abs(ang - math.pi) < 1e-3:
            out.append((b.x, b.y))
            continue
        t = min(r / math.tan(ang / 2), la * 0.45, lc * 0.45)
        rr = t * math.tan(ang / 2)
        p0 = b + ab * t
        p1 = b + cb * t
        bis = (ab + cb).normalized()
        centre = b + bis * (rr / math.sin(ang / 2))
        a0 = math.atan2(p0.y - centre.y, p0.x - centre.x)
        a1 = math.atan2(p1.y - centre.y, p1.x - centre.x)
        da = a1 - a0
        while da > math.pi:
            da -= TAU
        while da < -math.pi:
            da += TAU
        count = max(1, int(math.ceil(abs(da) / (math.pi / 2) * steps)))
        for k in range(count + 1):
            ang_k = a0 + da * k / count
            out.append((centre.x + rr * math.cos(ang_k), centre.y + rr * math.sin(ang_k)))
    return out


def rect(u0, v0, u1, v1, radius=0.0, steps=4):
    pts = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
    return fillet(pts, radius, steps) if radius > 0 else pts


def slot(cu, cv, length, height, steps=6, angle=0.0):
    """Stadium (obround) outline centred on (cu, cv)."""
    r = height / 2
    half = max(0.0, length / 2 - r)
    pts = []
    for k in range(steps * 2 + 1):
        a = -math.pi / 2 + math.pi * k / (steps * 2)
        pts.append((half + r * math.cos(a), r * math.sin(a)))
    for k in range(steps * 2 + 1):
        a = math.pi / 2 + math.pi * k / (steps * 2)
        pts.append((-half + r * math.cos(a), r * math.sin(a)))
    ca, sa = math.cos(angle), math.sin(angle)
    return [(cu + u * ca - v * sa, cv + u * sa + v * ca) for u, v in pts]


def circle(cu, cv, r, n=24, phase=0.0):
    return [(cu + r * math.cos(phase + TAU * k / n), cv + r * math.sin(phase + TAU * k / n)) for k in range(n)]


def superellipse(a, b, n=24, e=3.0):
    """Closed 2D section, half-axes a and b; e=2 is an ellipse, larger is boxier."""
    pts = []
    for k in range(n):
        t = TAU * k / n
        c, s = math.cos(t), math.sin(t)
        pts.append((a * math.copysign(abs(c) ** (2 / e), c), b * math.copysign(abs(s) ** (2 / e), s)))
    return pts


# ---------------------------------------------------------------- primitives
def _commit(dst, tmp, matrix=None):
    if matrix is not None:
        tmp.transform(matrix)
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces[:])
    me = bpy.data.meshes.new('hs-tmp')
    tmp.to_mesh(me)
    tmp.free()
    dst.from_mesh(me)
    bpy.data.meshes.remove(me)


def frame(origin=(0, 0, 0), x=(1, 0, 0), y=(0, 1, 0)):
    """Matrix whose columns are x, y, x cross y, placed at origin."""
    vx = Vector(x).normalized()
    vy = Vector(y)
    vy = (vy - vx * vy.dot(vx)).normalized()
    vz = vx.cross(vy)
    m = Matrix.Identity(4)
    for i in range(3):
        m[i][0], m[i][1], m[i][2], m[i][3] = vx[i], vy[i], vz[i], origin[i]
    return m


def rot(axis, degrees, origin=(0, 0, 0)):
    o = Vector(origin)
    return Matrix.Translation(o) @ Matrix.Rotation(math.radians(degrees), 4, axis) @ Matrix.Translation(-o)


def box(bm, size, center=(0, 0, 0), bevel=0.0008, segs=2, matrix=None):
    """Chamfered box. `matrix` is applied after centring (rotate about any pivot)."""
    t = bmesh.new()
    bmesh.ops.create_cube(t, size=1.0)
    for v in t.verts:
        v.co = Vector((v.co.x * size[0] + center[0], v.co.y * size[1] + center[1], v.co.z * size[2] + center[2]))
    if bevel > 0:
        bmesh.ops.bevel(t, geom=t.edges[:], offset=min(bevel, min(size) * 0.42), segments=segs, profile=0.5,
                        affect='EDGES', clamp_overlap=True)
    _commit(bm, t, matrix)


def lathe(bm, profile, origin=(0, 0, 0), seg=32, matrix=None, closed=False, sweep=1.0, phase=0.0):
    """Revolve (z, r) profile points about the axis through `origin` parallel to game z.

    `closed` joins the last profile point to the first (hollow parts). Points
    with r == 0 become poles. `sweep` < 1 revolves part of a turn and caps it.
    """
    t = bmesh.new()
    full = sweep >= 0.9999
    steps = seg if full else max(2, int(round(seg * sweep)))
    rings = []
    for z, r in profile:
        if r <= 1e-9:
            rings.append([t.verts.new((origin[0], origin[1], origin[2] + z))])
        else:
            ring = []
            for k in range(steps if full else steps + 1):
                a = phase + TAU * sweep * k / steps
                ring.append(t.verts.new((origin[0] + r * math.cos(a), origin[1] + r * math.sin(a), origin[2] + z)))
            rings.append(ring)
    pairs = list(zip(rings[:-1], rings[1:]))
    if closed:
        pairs.append((rings[-1], rings[0]))
    for a, b in pairs:
        if len(a) == 1 and len(b) == 1:
            continue
        m = max(len(a), len(b))
        span = m if full else m - 1
        for k in range(span):
            k2 = (k + 1) % m
            va, va2 = a[k % len(a)], a[k2 % len(a)]
            vb, vb2 = b[k % len(b)], b[k2 % len(b)]
            verts = [va, vb, vb2, va2]
            uniq = []
            for v in verts:
                if v not in uniq:
                    uniq.append(v)
            if len(uniq) >= 3:
                try:
                    t.faces.new(uniq)
                except ValueError:
                    pass
    if not full:
        for k in (0, steps):
            loop = [ring[min(k, len(ring) - 1)] for ring in rings]
            uniq = []
            for v in loop:
                if v not in uniq:
                    uniq.append(v)
            if len(uniq) >= 3:
                try:
                    t.faces.new(uniq)
                except ValueError:
                    pass
    _commit(bm, t, matrix)


def cyl(bm, p0, p1, r, seg=24, bevel=0.0006, r1=None, cap0=True, cap1=True):
    """Solid cylinder (or cone when r1 differs) between two game-space points."""
    a, b = Vector(p0), Vector(p1)
    axis = b - a
    length = axis.length
    r1 = r if r1 is None else r1
    be0 = min(bevel, r * 0.4, length * 0.3)
    be1 = min(bevel, r1 * 0.4, length * 0.3)
    prof = []
    if cap0:
        prof += [(0, 0), (0, r - be0)]
    prof += [(be0, r), (length - be1, r1)]
    if cap1:
        prof += [(length, r1 - be1), (length, 0)]
    up = Vector((0, 1, 0)) if abs(axis.normalized().y) < 0.9 else Vector((1, 0, 0))
    zx = axis.normalized()
    vx = up.cross(zx).normalized()
    vy = zx.cross(vx)
    m = Matrix.Identity(4)
    for i in range(3):
        m[i][0], m[i][1], m[i][2], m[i][3] = vx[i], vy[i], zx[i], a[i]
    lathe(bm, prof, seg=seg, matrix=m)


def tube(bm, p0, p1, r_out, r_in, seg=24, bevel=0.0005):
    """Hollow cylinder with chamfered lips between two game-space points."""
    a, b = Vector(p0), Vector(p1)
    axis = b - a
    length = axis.length
    be = min(bevel, (r_out - r_in) * 0.4, length * 0.3)
    prof = [(0, r_in + be), (0, r_out - be), (be, r_out), (length - be, r_out), (length, r_out - be),
            (length, r_in + be), (length - be, r_in), (be, r_in)]
    up = Vector((0, 1, 0)) if abs(axis.normalized().y) < 0.9 else Vector((1, 0, 0))
    zx = axis.normalized()
    vx = up.cross(zx).normalized()
    vy = zx.cross(vx)
    m = Matrix.Identity(4)
    for i in range(3):
        m[i][0], m[i][1], m[i][2], m[i][3] = vx[i], vy[i], zx[i], a[i]
    lathe(bm, prof, seg=seg, matrix=m, closed=True)


def plate(bm, outline, holes=(), thickness=0.004, bevel=0.0007, segs=2, matrix=None, center=True):
    """Extruded 2D outline with holes and a chamfered rim.

    Local frame: outline (u, v) -> (x, y), thickness along +z (centred when
    `center`). Use `matrix` (see plane_zy / frame) to stand it up in gun space.
    """
    t = bmesh.new()
    edges = []
    for loop in (outline, *holes):
        verts = [t.verts.new((u, v, 0.0)) for u, v in loop]
        for i, v in enumerate(verts):
            edges.append(t.edges.new((v, verts[(i + 1) % len(verts)])))
    res = bmesh.ops.triangle_fill(t, use_beauty=True, use_dissolve=False, edges=edges)
    faces = [g for g in res['geom'] if isinstance(g, bmesh.types.BMFace)]
    bmesh.ops.recalc_face_normals(t, faces=faces)
    ext = bmesh.ops.extrude_face_region(t, geom=faces)
    top = [g for g in ext['geom'] if isinstance(g, bmesh.types.BMVert)]
    for v in top:
        v.co.z += thickness
    bmesh.ops.recalc_face_normals(t, faces=t.faces[:])
    if bevel > 0:
        rim = [e for e in t.edges if len(e.link_faces) == 2
               and abs(e.verts[0].co.z - e.verts[1].co.z) < 1e-7
               and e.link_faces[0].normal.dot(e.link_faces[1].normal) < 0.5]
        if rim:
            bmesh.ops.bevel(t, geom=rim, offset=min(bevel, thickness * 0.42), segments=segs, profile=0.5,
                            affect='EDGES', clamp_overlap=True)
    if center:
        for v in t.verts:
            v.co.z -= thickness / 2
    _commit(bm, t, matrix)


def plane_zy(x=0.0, flip=False):
    """Matrix for plate(): outline u -> game -z (forward), v -> game y, thickness along game x.

    Outlines are then drawn with u = distance toward the muzzle, i.e. u = -z.
    """
    m = Matrix(((0, 0, 1, x), (0, 1, 0, 0), (-1, 0, 0, 0), (0, 0, 0, 1)))
    if flip:
        m = m @ Matrix.Scale(-1, 4, (0, 0, 1))
    return m


def plane_xz(y=0.0):
    """plate(): u -> game x, v -> game -z (forward), thickness along game y."""
    return Matrix(((1, 0, 0, 0), (0, 0, 1, y), (0, -1, 0, 0), (0, 0, 0, 1)))


def plane_xy(z=0.0):
    """plate(): u -> game x, v -> game y, thickness along game z."""
    return Matrix(((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, z), (0, 0, 0, 1)))


def loft(bm, sections, cap=True, closed=True, matrix=None):
    """Skin consecutive rings of equal vertex count into one smooth shell."""
    t = bmesh.new()
    rings = [[t.verts.new(p) for p in sec] for sec in sections]
    n = len(rings[0])
    for a, b in zip(rings[:-1], rings[1:]):
        for k in range(n if closed else n - 1):
            k2 = (k + 1) % n
            t.faces.new((a[k], a[k2], b[k2], b[k]))
    if cap:
        t.faces.new(rings[0])
        t.faces.new(list(reversed(rings[-1])))
    _commit(bm, t, matrix)


def section(center, right, up, pts2d):
    """Lift a 2D section into gun space on the plane spanned by right/up."""
    c, r, u = Vector(center), Vector(right).normalized(), Vector(up).normalized()
    return [tuple(c + r * p[0] + u * p[1]) for p in pts2d]


def sweep(bm, path, radius, seg=8, closed_path=False, cap=True):
    """Round wire along a polyline (springs, cables, guard loops)."""
    pts = [Vector(p) for p in path]
    n = len(pts)
    rings = []
    prev_normal = None
    for i, p in enumerate(pts):
        a = pts[i - 1] if (i > 0 or closed_path) else p
        b = pts[(i + 1) % n] if (i < n - 1 or closed_path) else p
        tan = (b - a).normalized()
        if prev_normal is None:
            ref = Vector((0, 1, 0)) if abs(tan.y) < 0.9 else Vector((1, 0, 0))
            normal = (ref - tan * ref.dot(tan)).normalized()
        else:
            normal = (prev_normal - tan * prev_normal.dot(tan)).normalized()
        prev_normal = normal
        binormal = tan.cross(normal)
        r = radius[i] if isinstance(radius, (list, tuple)) else radius
        rings.append([tuple(p + (normal * math.cos(TAU * k / seg) + binormal * math.sin(TAU * k / seg)) * r)
                      for k in range(seg)])
    if closed_path:
        rings.append(rings[0])
    loft(bm, rings, cap=cap and not closed_path)


def helix(p0, p1, radius, turns, steps_per_turn=14, dead=0.75):
    """Compression-spring centreline from p0 to p1 with closed (flat) end coils."""
    a, b = Vector(p0), Vector(p1)
    axis = b - a
    length = axis.length
    zx = axis.normalized()
    ref = Vector((0, 1, 0)) if abs(zx.y) < 0.9 else Vector((1, 0, 0))
    vx = ref.cross(zx).normalized()
    vy = zx.cross(vx)
    total = int(turns * steps_per_turn)
    pts = []
    for i in range(total + 1):
        t = i / total
        turn = t * turns
        # ease the pitch at both ends so the last coils close up
        e = dead / turns
        if t < e:
            s = (t / e) ** 2 * e * 0.5
        elif t > 1 - e:
            s = 1 - ((1 - t) / e) ** 2 * e * 0.5
        else:
            s = e * 0.5 + (t - e) / (1 - 2 * e) * (1 - e)
        ang = TAU * turn
        pts.append(tuple(a + zx * (s * length) + (vx * math.cos(ang) + vy * math.sin(ang)) * radius))
    return pts


# ---------------------------------------------------------------- objects
class Study:
    """Collects named parts; each part is one mesh object with one source material."""

    def __init__(self, name, collection_name='source'):
        self.name = name
        self.scene = bpy.context.scene
        self.collection = bpy.data.collections.new(collection_name)
        self.scene.collection.children.link(self.collection)
        self.objects = []
        self.parts = {}

    def add(self, bm, name, part, mat, smooth=38.0, texel=1.0, weighted=True, slide=None):
        """Commit a game-space bmesh as an object owned by rig `part` with source material `mat`."""
        bm.transform(G2B)
        me = bpy.data.meshes.new(f'{self.name} | {name}')
        bm.to_mesh(me)
        bm.free()
        for poly in me.polygons:
            poly.use_smooth = True
        me.set_sharp_from_angle(angle=math.radians(smooth))
        ob = bpy.data.objects.new(f'{self.name} | {name}', me)
        ob['part'] = part
        ob['mat'] = mat
        ob['texel'] = texel
        if slide:
            ob['slide'] = slide
        self.collection.objects.link(ob)
        if weighted:
            mod = ob.modifiers.new('weighted normals', 'WEIGHTED_NORMAL')
            mod.keep_sharp = True
            mod.weight = 60
        self.objects.append(ob)
        self.parts.setdefault(part, []).append(ob)
        return ob

    def triangles(self):
        dg = bpy.context.evaluated_depsgraph_get()
        total = 0
        for ob in self.objects:
            me = ob.evaluated_get(dg).data
            me.calc_loop_triangles()
            total += len(me.loop_triangles)
        return total
