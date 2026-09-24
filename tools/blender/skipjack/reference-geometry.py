"""Revision 13 geometry, sculpted against rounded-direction-b.png.

Executed by build-skipjack.py in its authoring namespace. Reference pixel
coordinates refer to the large side view of the approved concept. Revision 13
replaces the extruded side plates of revision 12 with lofted, rounded volumes:

* one continuous receiver/stock shell with super-elliptic cross-sections,
  whose dark keel (muzzle chin -> belly -> stock underside) is split on an
  exact row seam, so the colour break follows the surface without stair steps;
* real Boolean pockets for the cassette bay, the stock thumb scoop and the
  right service cover, whose walls and conformal floors keep the dark finish;
* a lathed barrel, rib bands and slotted muzzle brake instead of stacked tubes;
* a lofted, raked grip with finger swells and a lofted rubber shoulder pad;
* a cassette that pivots on a vertical front hinge hub, as drawn in the
  reference, instead of the old rear trunnion.
"""
import bmesh
from mathutils.bvhtree import BVHTree

REF_SCALE = .00072


def ref_yz(px, py):
    return .782 - (px - 63) * REF_SCALE, .075 + (262 - py) * REF_SCALE


def px_of(y):
    return 63 + (.782 - y) / REF_SCALE


def smooth_outline(points, steps=4):
    result = []
    count = len(points)
    for i in range(count):
        p0, p1, p2, p3 = [Vector(points[j % count])
                          for j in (i - 1, i, i + 1, i + 2)]
        for j in range(steps):
            t = j / steps
            result.append(tuple(.5 * ((2 * p1) + (-p0 + p2) * t
                + (2*p0 - 5*p1 + 4*p2 - p3) * t*t
                + (-p0 + 3*p1 - 3*p2 + p3) * t*t*t)))
    return result


class Profile:
    """Piecewise-linear knots, resampled every 2 px and box-smoothed twice."""

    def __init__(self, knots, window=11):
        self.x0 = knots[0][0]
        self.x1 = knots[-1][0]
        xs = [self.x0 + 2 * i for i in range(int((self.x1 - self.x0) / 2) + 1)]
        width = len(knots[0]) - 1
        columns = []
        for column in range(width):
            values = []
            for x in xs:
                k = next((i for i in range(len(knots) - 1) if x <= knots[i + 1][0]),
                         len(knots) - 2)
                a, b = knots[k], knots[k + 1]
                t = (x - a[0]) / (b[0] - a[0])
                values.append(a[column + 1] * (1 - t) + b[column + 1] * t)
            for _ in range(2):
                values = [sum(values[max(0, min(len(values) - 1, i + d))]
                              for d in range(-window, window + 1)) / (2 * window + 1)
                          for i in range(len(values))]
            columns.append(values)
        self.xs, self.columns = xs, columns

    def __call__(self, x):
        x = max(self.x0, min(self.x1, x))
        f = (x - self.x0) / 2
        i = min(len(self.xs) - 2, int(f))
        t = f - i
        return [c[i] * (1 - t) + c[i + 1] * t for c in self.columns]


def superellipse(phi, n_top, n_bottom):
    c, s = math.cos(phi), math.sin(phi)
    n = n_top if s >= 0 else n_bottom
    return (math.copysign(abs(c) ** (2 / n), c), math.copysign(abs(s) ** (2 / n), s))


def seam_phi(zeta, n):
    """Section angle at which a super-ellipse reaches the normalised height zeta."""
    zeta = max(-.995, min(.995, zeta))
    return math.copysign(math.asin(abs(zeta) ** (n / 2)), zeta)


def box_uv(mesh, scale=UV_SCALE):
    uv = mesh.uv_layers.new(name='UVMap') if not mesh.uv_layers else mesh.uv_layers[0]
    for poly in mesh.polygons:
        axis = max(range(3), key=lambda i: abs(poly.normal[i]))
        first, second = ((1, 2), (0, 2), (0, 1))[axis]
        for loop in poly.loop_indices:
            co = mesh.vertices[mesh.loops[loop].vertex_index].co
            uv.data[loop].uv = (co[first] * scale, co[second] * scale)


def make_object(name, verts, faces, recalc=True):
    mesh = bpy.data.meshes.new(f'{name} mesh')
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    if recalc:
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(mesh)
        bm.free()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    source_collection.objects.link(obj)
    return obj


def carve(obj, cutter):
    """Exact Boolean difference; the cutter's dark polymer finish transfers to
    the new pocket walls and floor, which split_finish() then separates."""
    cutter.data.materials.clear()
    cutter.data.materials.append(materials['dark polymer'])
    if not cutter.data.uv_layers:
        box_uv(cutter.data)
    boolean = obj.modifiers.new('sculpted pocket', 'BOOLEAN')
    boolean.operation = 'DIFFERENCE'
    boolean.solver = 'EXACT'
    boolean.material_mode = 'TRANSFER'
    boolean.use_self = True
    boolean.use_hole_tolerant = True
    boolean.object = cutter
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_move_to_index(modifier=boolean.name, index=0)
    before = len(obj.data.polygons)
    for o in (obj, cutter):
        bm = bmesh.new(); bm.from_mesh(o.data)
        vol = bm.calc_volume(signed=True)
        nm = sum(1 for e in bm.edges if not e.is_manifold)
        print(f'[carve-debug] {o.name}: volume {vol*1e6:.1f} cm3, non-manifold edges {nm}, faces {len(bm.faces)}')
        bm.free()
    bpy.ops.object.modifier_apply(modifier=boolean.name)
    print(f'[carve] {obj.name}: {before} -> {len(obj.data.polygons)} faces')
    bpy.data.objects.remove(cutter, do_unlink=True)


def split_finish(obj, name, group, finish, smooth=True):
    """Move every face that does not use slot 0 into its own part."""
    mesh = obj.data
    keep_material = mesh.materials[0]
    dark = bmesh.new()
    dark.from_mesh(mesh)
    bmesh.ops.delete(dark, geom=[f for f in dark.faces
                                 if mesh.materials[f.material_index] == keep_material],
                     context='FACES')
    base = bmesh.new()
    base.from_mesh(mesh)
    bmesh.ops.delete(base, geom=[f for f in base.faces
                                 if mesh.materials[f.material_index] != keep_material],
                     context='FACES')
    for bm in (dark, base):
        for face in bm.faces:
            face.material_index = 0
    dark_mesh = bpy.data.meshes.new(f'{name} mesh')
    dark.to_mesh(dark_mesh)
    base.to_mesh(mesh)
    dark.free()
    base.free()
    while len(mesh.materials) > 1:
        mesh.materials.pop()
    dark_obj = bpy.data.objects.new(name, dark_mesh)
    dark_obj['open_shell'] = True
    source_collection.objects.link(dark_obj)
    link_part(dark_obj, name, group, finish, 0, smooth=smooth, keep_uv=True)
    return dark_obj


def cut_rounded_box(obj, loc, size, radius):
    """Apply a real rounded window before the edge bevel."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    cutter = bpy.context.object
    cutter.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bevel = cutter.modifiers.new('rounded cutter', 'BEVEL')
    bevel.width = radius
    bevel.segments = 4
    bpy.context.view_layer.objects.active = cutter
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    boolean = obj.modifiers.new('machined opening', 'BOOLEAN')
    boolean.operation = 'DIFFERENCE'
    boolean.solver = 'EXACT'
    boolean.object = cutter
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_move_to_index(modifier=boolean.name, index=0)
    bpy.ops.object.modifier_apply(modifier=boolean.name)
    bpy.data.objects.remove(cutter, do_unlink=True)
    orient(obj.data)


# ---------------------------------------------------------------------------
# Receiver + stock: one lofted shell traced from the reference side view.
# Knots: px, top py, bottom py, half width (m), n top, n bottom.
# ---------------------------------------------------------------------------
BODY = Profile([
    (522, 204, 320, .052, 2.1, 2.1),
    (532, 184, 340, .064, 2.1, 2.2),
    (548, 166, 358, .071, 2.2, 2.3),
    (575, 150, 374, .077, 2.25, 2.4),
    (620, 136, 392, .081, 2.3, 2.5),
    (690, 125, 408, .083, 2.35, 2.6),
    (760, 120, 416, .083, 2.4, 2.7),
    (860, 119, 419, .082, 2.4, 2.7),
    (950, 121, 417, .081, 2.4, 2.7),
    (1015, 128, 409, .078, 2.4, 2.7),
    (1055, 141, 397, .073, 2.45, 2.7),
    (1090, 163, 384, .063, 2.5, 2.7),
    (1120, 182, 370, .053, 2.6, 2.8),
    (1155, 189, 373, .045, 2.7, 2.8),
    (1205, 190, 393, .042, 2.8, 2.9),
    (1265, 189, 431, .043, 2.8, 2.9),
    (1325, 187, 479, .048, 2.8, 2.9),
    (1385, 185, 503, .054, 2.8, 2.9),
    (1428, 184, 508, .058, 2.9, 2.9),
    (1452, 184, 508, .059, 2.9, 2.9),
], window=9)
# Normalised keel seam: chin under the barrel collar, a thin belly strip hidden
# by grip and cassette, then the dark underside of the stock, fading at the pad.
KEEL = Profile([(522, .12), (556, -.04), (592, -.30), (632, -.58), (672, -.80),
                (712, -.91), (1000, -.92), (1075, -.86), (1128, -.72),
                (1195, -.76), (1290, -.79), (1345, -.86), (1420, -.91), (1452, -.92)],
               window=8)
BODY_PX = ([522, 526, 531, 537, 544, 552, 561, 571, 583, 597, 612, 628, 646, 666]
           + list(range(690, 1020, 30)) + [1035, 1055, 1073, 1090, 1106, 1121, 1136,
           1152, 1170, 1192, 1216, 1242, 1270, 1300, 1332, 1364, 1396, 1424, 1452])
LOW_ROWS, HIGH_ROWS = 5, 13


def body_section(px):
    top, bottom, half_width, n_top, n_bottom = BODY(px)
    y, z_top = ref_yz(px, top)
    _, z_bottom = ref_yz(px, bottom)
    return y, (z_top + z_bottom) / 2, (z_top - z_bottom) / 2, half_width, n_top, n_bottom


def body_x(y, z):
    """Outer half width of the shell at (y, z); 0 outside the section."""
    _, cz, rz, half_width, n_top, n_bottom = body_section(px_of(y))
    zeta = max(-.985, min(.985, (z - cz) / rz))
    n = n_top if zeta >= 0 else n_bottom
    return half_width * (1 - abs(zeta) ** n) ** (1 / n)


def body_shell():
    rows = 2 * (LOW_ROWS + HIGH_ROWS)
    verts, faces, face_keel, uvs = [], [], [], []
    ring_info = []
    for px in BODY_PX:
        y, cz, rz, half_width, n_top, n_bottom = body_section(px)
        seam = seam_phi(KEEL(px)[0], n_bottom if KEEL(px)[0] < 0 else n_top)
        seam = max(-math.radians(66), seam)
        phis = ([-math.pi / 2 + (seam + math.pi / 2) * i / LOW_ROWS for i in range(LOW_ROWS)]
                + [seam + (math.pi / 2 - seam) * i / HIGH_ROWS for i in range(HIGH_ROWS + 1)])
        side = [superellipse(phi, n_top, n_bottom) for phi in phis]
        # Right side bottom -> top, then left side top -> bottom (exclusive).
        ring = [(half_width * c, y, cz + rz * s) for c, s in side]
        ring += [(-half_width * c, y, cz + rz * s) for c, s in reversed(side[1:-1])]
        # Arc-length V coordinate, wrapped at the keel centre line.
        lengths = [0.0]
        for a, b in zip(ring, ring[1:] + ring[:1]):
            lengths.append(lengths[-1] + math.dist(a, b))
        ring_info.append((len(verts), y, lengths))
        verts.extend(ring)
    for r in range(len(BODY_PX) - 1):
        a0, ya, la = ring_info[r]
        b0, yb, lb = ring_info[r + 1]
        for i in range(rows):
            j = (i + 1) % rows
            faces.append((a0 + i, a0 + j, b0 + j, b0 + i))
            face_keel.append(i < LOW_ROWS or i >= rows - LOW_ROWS)
            ua, ub = ya * UV_SCALE, yb * UV_SCALE
            va = [la[k] * UV_SCALE for k in (i, j if j else rows)]
            vb = [lb[k] * UV_SCALE for k in (i, j if j else rows)]
            uvs.append({a0 + i: (ua, va[0]), a0 + j: (ua, va[1]),
                        b0 + j: (ub, vb[1]), b0 + i: (ub, vb[0])})
    # Rounded end caps are hidden by the barrel collar and the shoulder pad.
    for start, flip in ((ring_info[0][0], True), (ring_info[-1][0], False)):
        cap = [start + i for i in range(rows)]
        faces.append(tuple(reversed(cap)) if flip else tuple(cap))
        face_keel.append(False)
        uvs.append({k: (verts[k][0] * UV_SCALE, verts[k][2] * UV_SCALE) for k in cap})
    obj = make_object('receiver shell', verts, faces, recalc=False)
    mesh = obj.data
    layer = mesh.uv_layers.new(name='UVMap')
    for poly, corner_uvs in zip(mesh.polygons, uvs):
        for loop in poly.loop_indices:
            layer.data[loop].uv = corner_uvs[mesh.loops[loop].vertex_index]
    link_part(obj, 'receiver | sculpted olive shell', 'body', 'olive drab', 0,
              smooth=True, keep_uv=True)
    mesh.materials.append(materials['dark polymer'])
    for poly, keel in zip(mesh.polygons, face_keel):
        poly.material_index = 1 if keel else 0
    return obj


shell = body_shell()


def conformal_cutter(outline, side, depth, lip=.0035, overshoot=.03, fill_cuts=2, grid=.007):
    """Closed cutter whose floor follows the shell at `depth` below the surface."""
    outline = [Vector(p) for p in outline]
    count = len(outline)
    area = sum(a.x * b.y - b.x * a.y for a, b in zip(outline, outline[1:] + outline[:1]))
    if area < 0:
        outline.reverse()
    inner = []
    for i, p in enumerate(outline):
        a, b = outline[i - 1], outline[(i + 1) % count]
        tangent = (b - a).normalized()
        inner.append(p + Vector((-tangent.y, tangent.x)) * lip)
    mid = [p.lerp(q, .72) for p, q in zip(outline, inner)]

    def surf(p):
        return max(.012, body_x(p.x, p.y))

    bm = bmesh.new()
    authored = bm.verts.layers.int.new('authored')
    top = [bm.verts.new((side * (surf(p) + overshoot), p.x, p.y)) for p in outline]
    rim = [bm.verts.new((side * (surf(p) - depth * .55), p.x, p.y)) for p in mid]
    floor = [bm.verts.new((side * (surf(p) - depth), p.x, p.y)) for p in inner]
    for v in top + rim + floor:
        v[authored] = 1
    for ring_a, ring_b in ((top, rim), (rim, floor)):
        for i in range(count):
            j = (i + 1) % count
            bm.faces.new((ring_a[i], ring_a[j], ring_b[j], ring_b[i]))
    top_face = bm.faces.new(top)
    bmesh.ops.triangulate(bm, faces=[top_face])
    # Constrained Delaunay floor over an even interior grid: no sliver fans,
    # so the smooth-shaded pocket floor reads as one clean moulded surface.
    from mathutils.geometry import delaunay_2d_cdt
    points = [p.copy() for p in inner]
    ys = [p.x for p in inner]
    zs = [p.y for p in inner]
    step = grid

    def inside(q):
        hit = False
        for a, b in zip(inner, inner[1:] + inner[:1]):
            if (a.y > q.y) != (b.y > q.y) and q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x:
                hit = not hit
        if not hit:
            return False
        return min((q - a).length for a in inner) > step * .55
    yy = min(ys) + step / 2
    while yy < max(ys):
        zz = min(zs) + step / 2
        while zz < max(zs):
            q = Vector((yy, zz))
            if inside(q):
                points.append(q)
            zz += step
        yy += step * .92
    result = delaunay_2d_cdt(points, [(i, (i + 1) % count) for i in range(count)],
                             [list(range(count))], 1, 1e-7)
    out_verts, _, out_faces, orig_verts = result[0], result[1], result[2], result[3]
    mapped = []
    for k, co in enumerate(out_verts):
        source = [i for i in orig_verts[k] if i < count]
        if source:
            mapped.append(floor[source[0]])
        else:
            v = bm.verts.new((side * (surf(co) - depth), co.x, co.y))
            mapped.append(v)
    for face in out_faces:
        try:
            bm.faces.new([mapped[i] for i in face])
        except ValueError:
            pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    xs = [v.co.x for v in bm.verts]; ys = [v.co.y for v in bm.verts]; zs = [v.co.z for v in bm.verts]
    print(f'[cutter] side {side} x {min(xs):.4f}..{max(xs):.4f} y {min(ys):.4f}..{max(ys):.4f} '
          f'z {min(zs):.4f}..{max(zs):.4f} volume {bm.calc_volume(signed=True)*1e6:.1f}')
    mesh = bpy.data.meshes.new('pocket cutter mesh')
    bm.to_mesh(mesh)
    bm.free()
    cutter = bpy.data.objects.new('pocket cutter', mesh)
    source_collection.objects.link(cutter)
    orient(mesh)
    return cutter


def rounded_rect(y0, y1, z0, z1, radius, steps=4):
    points = []
    for cy, cz, start in ((y1 - radius, z1 - radius, 0), (y0 + radius, z1 - radius, math.pi / 2),
                          (y0 + radius, z0 + radius, math.pi), (y1 - radius, z0 + radius, 1.5 * math.pi)):
        for i in range(steps + 1):
            a = start + i / steps * math.pi / 2
            points.append((cy + radius * math.cos(a), cz + radius * math.sin(a)))
    return points


def box_cutter(loc, size, radius):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    cutter = bpy.context.object
    cutter.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bevel = cutter.modifiers.new('rounded cutter', 'BEVEL')
    bevel.width = radius
    bevel.segments = 4
    bpy.context.view_layer.objects.active = cutter
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    return cutter


# Cassette bay: a flat seat milled into the left flank.
carve(shell, box_cutter((-.130, .189, .045), (.120, .244, .210), .016))

# Thumb scoop on both stock flanks, traced from the reference.
scoop_px = [(1150, 196), (1206, 192), (1256, 198), (1298, 220), (1334, 254),
            (1354, 296), (1352, 338), (1334, 366), (1302, 376), (1268, 364),
            (1232, 340), (1198, 306), (1172, 268), (1154, 228)]
scoop = smooth_outline([ref_yz(*p) for p in scoop_px], 3)
for side in (-1, 1):
    carve(shell, conformal_cutter(scoop, side, .0135, lip=.007, grid=.0095))

# Right service cover: a shallow pocket that seats the charging track.
cover = rounded_rect(.205, .330, .045, .128, .016)
carve(shell, conformal_cutter(cover, 1, .004, lip=.003, grid=.012))
shell['open_shell'] = True
split_finish(shell, 'receiver | dark keel and pockets', 'body', 'dark polymer')


def panel_line(name, points_px, side, width=.0017, lift=.0003, steps=4):
    """A narrow dark seam ribbon laid on the shell (reference panel lines)."""
    path = smooth_outline([ref_yz(*p) for p in points_px], steps)[:-steps + 1]
    verts, faces = [], []
    for k, (y, z) in enumerate(path):
        a = Vector(path[max(0, k - 1)]); b = Vector(path[min(len(path) - 1, k + 1)])
        t = (b - a).normalized()
        n2 = Vector((-t.y, t.x)) * width / 2
        for sign in (-1, 1):
            yy, zz = y + n2.x * sign, z + n2.y * sign
            x0 = body_x(yy, zz)
            dy = (body_x(yy + .002, zz) - body_x(yy - .002, zz)) / .004
            dz = (body_x(yy, zz + .002) - body_x(yy, zz - .002)) / .004
            normal = Vector((side, -dy, -dz)).normalized()
            verts.append(tuple(Vector((side * x0, yy, zz)) + normal * lift))
        if k:
            i = 2 * k
            faces.append((i - 2, i - 1, i + 1, i) if side > 0 else (i - 2, i, i + 1, i - 1))
    obj = make_object(name, verts, faces, recalc=False)
    obj['open_shell'] = True
    link_part(obj, name, 'body', 'dark polymer', 0, smooth=True)
    return obj


def surface_point(px, py, side, lift=0.0):
    y, z = ref_yz(px, py)
    return Vector((side * (body_x(y, z) + lift), y, z))


def screw(name, px, py, side, radius=.0062):
    """Seat, head and hex socket, tilted to the local shell normal."""
    y, z = ref_yz(px, py)
    x0 = body_x(y, z)
    dz = (body_x(y, z + .003) - body_x(y, z - .003)) / .006
    dy = (body_x(y + .003, z) - body_x(y - .003, z)) / .006
    normal = Vector((side, -dy, -dz)).normalized()
    base = Vector((side * x0, y, z))
    for suffix, finish, r, depth, lift, verts in (
            ('seat', 'dark polymer', radius * 1.35, .0022, .0002, 10),
            ('head', 'machined steel', radius, .0024, .0015, 10),
            ('socket', 'rubber', radius * .42, .0006, .0028, 6)):
        # A domed head is a two-radius cone: no bevel modifier on tiny screws.
        obj = cylinder(f'{name} {suffix}', 'body', finish, (0, 0, 0), r, depth,
                       axis='Z', verts=verts, bevel=0,
                       radius_top=r * .78 if suffix == 'head' else None)
        rotation = normal.to_track_quat('Z', 'Y').to_matrix().to_4x4()
        obj.data.transform(rotation)
        obj.data.transform(Matrix.Translation(base + normal * lift))
        obj.data.update()


for side in (-1, 1):
    for px, py in ((596, 214), (640, 368), (780, 150), (1040, 196), (1066, 350)):
        if side < 0 and 700 < px < 1060:
            continue  # the cassette bay covers these
        screw(f'receiver | screw {side} {px}', px, py, side)
    for px, py in ((1408, 226), (1404, 446)):
        screw(f'stock | screw {side} {px}', px, py, side, .0058)

for side in (-1, 1):
    # Receiver-to-stock joint and the long upper cover seam from the reference.
    panel_line(f'receiver | stock joint seam {side}',
               [(1113, 214), (1116, 232), (1118, 256), (1116, 292), (1106, 336), (1094, 368)], side)
    upper = [(566, 202), (640, 166), (712, 156)]
    panel_line(f'receiver | upper cover seam {side}', upper, side)

# ---------------------------------------------------------------------------
# Shoulder pad: lofted rounded-rectangle rubber, a touch larger than the stock.
# ---------------------------------------------------------------------------
PAD_RINGS = [(1440, .90, .0), (1446, .985, .0), (1454, 1.0, .0),
             (1488, 1.0, .0), (1497, .975, .0), (1503, .91, .0), (1506, .80, .0)]


def shoulder_pad():
    segments = 36
    top_py, bottom_py = 183, 509
    y_c, z_c = ref_yz(1470, (top_py + bottom_py) / 2)
    rz = (bottom_py - top_py) / 2 * REF_SCALE
    rx = .064
    verts, faces = [], []
    for px, scale, _ in PAD_RINGS:
        y = ref_yz(px, 0)[0]
        for i in range(segments):
            a = 2 * math.pi * i / segments
            c, s = math.cos(a), math.sin(a)
            verts.append((rx * scale * math.copysign(abs(c) ** (2 / 4.2), c), y,
                          z_c + rz * (scale * .5 + .5) * math.copysign(abs(s) ** (2 / 3.4), s)))
    for r in range(len(PAD_RINGS) - 1):
        for i in range(segments):
            j = (i + 1) % segments
            faces.append((r * segments + i, r * segments + j,
                          (r + 1) * segments + j, (r + 1) * segments + i))
    faces.append(tuple(reversed(range(segments))))
    last = (len(PAD_RINGS) - 1) * segments
    faces.append(tuple(last + i for i in range(segments)))
    obj = make_object('shoulder pad', verts, faces)
    link_part(obj, 'stock | lofted rubber shoulder pad', 'body', 'rubber', 0, smooth=True)
    for poly in obj.data.polygons[-2:]:
        poly.use_smooth = False


shoulder_pad()
for py in (262, 304, 346, 388, 430):
    y, z = ref_yz(1505, py)
    box(f'stock | pad groove {py}', 'body', 'dark polymer', (0, y, z),
        (.092, .0024, .0026), .0008)

# ---------------------------------------------------------------------------
# Grip: horizontal lofted sections, raked like the reference, finger swells.
# ---------------------------------------------------------------------------
GRIP = [  # py, front px, back px, half width
    (392, 624, 696, .028), (412, 616, 704, .030), (436, 612, 709, .031),
    (462, 618, 711, .032), (488, 628, 713, .033), (514, 633, 720, .034),
    (540, 640, 731, .034), (563, 644, 744, .034), (582, 650, 757, .034),
    (597, 659, 763, .033), (608, 672, 758, .031), (615, 690, 742, .027),
    (618, 706, 726, .018)]


def grip_front_swell(py):
    return sum(5.5 * math.exp(-((py - c) / 10) ** 2) for c in (472, 508, 544))


def grip_loft():
    segments = 24
    verts, faces = [], []
    for py, front, back, half_width in GRIP:
        front -= grip_front_swell(py)
        y_front, z = ref_yz(front, py)
        y_back, _ = ref_yz(back, py)
        cy, ry = (y_front + y_back) / 2, (y_front - y_back) / 2
        for i in range(segments):
            a = 2 * math.pi * i / segments
            c, s = math.cos(a), math.sin(a)
            verts.append((half_width * math.copysign(abs(c) ** (2 / 2.6), c),
                          cy + ry * math.copysign(abs(s) ** (2 / 2.2), s), z))
    for r in range(len(GRIP) - 1):
        for i in range(segments):
            j = (i + 1) % segments
            faces.append((r * segments + i, r * segments + j,
                          (r + 1) * segments + j, (r + 1) * segments + i))
    faces.append(tuple(range(segments)))
    last = (len(GRIP) - 1) * segments
    faces.append(tuple(reversed([last + i for i in range(segments)])))
    obj = make_object('grip', verts, faces)
    link_part(obj, 'grip | stippled lofted core', 'body', 'rubber', 0, smooth=True)
    return obj


grip_loft()
# A smooth polymer heel cap closes the stippled core.
y, z = ref_yz(716, 612)
box('grip | heel cap', 'body', 'dark polymer', (0, y, z - .002), (.058, .052, .009),
    .004, bevel_segments=3)

# Orange trigger blade in front of the grip, as in the reference (no guard).
trigger_path = [ref_yz(p[0], p[1]) for p in ((618, 420), (604, 428), (592, 441), (589, 452))]
for i, (a, b) in enumerate(zip(trigger_path, trigger_path[1:])):
    rod_between(f'trigger | curved blade {i}', 'trigger', 'orange paint',
                (0, a[0], a[1]), (0, b[0], b[1]), .0052, 12)
y, z = trigger_path[0]
rod_between('trigger | pivot pin', 'trigger', 'gunmetal',
            (-.012, y + .004, z + .004), (.012, y + .004, z + .004), .0038, 12)

# ---------------------------------------------------------------------------
# Barrel: one lathed launch tube with rib bands, collar and slotted brake.
# ---------------------------------------------------------------------------


def lathe(name, group, finish, profile, segments=32, bevel=0):
    """Revolve a closed (y, r) profile around the bore axis."""
    count = len(profile)
    verts = []
    for y, r in profile:
        for i in range(segments):
            a = 2 * math.pi * i / segments
            verts.append((r * math.cos(a), y, BORE_Z + r * math.sin(a)))
    faces = []
    for k in range(count - 1):
        for i in range(segments):
            j = (i + 1) % segments
            faces.append((k * segments + i, k * segments + j,
                          (k + 1) * segments + j, (k + 1) * segments + i))
    obj = make_object(name, verts, faces)
    # Collapse the zero-radius end ring into a single pole.
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bm.to_mesh(obj.data)
    bm.free()
    link_part(obj, name, group, finish, bevel, smooth=True)
    return obj


def ribbed(y0, y1, r_low, r_high, edge=.0022):
    return [(y0, r_low), (y0 - edge * .5, r_high - edge * .35),
            (y0 - edge, r_high), (y1 + edge, r_high), (y1 + edge * .5, r_high - edge * .35),
            (y1, r_low)]


outer = [(.4300, .0000), (.4300, .0540), (.4760, .0585), (.5150, .0600), (.5170, .0630),
         (.5290, .0630), (.5305, .0605), (.5345, .0605), (.5360, .0630), (.5500, .0625),
         (.5530, .0590), (.5560, .0552), (.6060, .0550)]
for y0, y1 in ((.6100, .6350), (.6390, .6640), (.6680, .6930)):
    e = .0022
    outer += [(y0, .0545), (y0 + e, .0585), (y1 - e, .0585), (y1, .0545)]
outer += [(.6960, .0560), (.7020, .0570), (.7045, .0612), (.7070, .0630), (.7765, .0630),
          (.7795, .0612), (.7812, .0580), (.7818, .0520), (.7820, .0350)]
# Through the crown lip, the brake chamber, then the 40 mm bore to its floor.
bore = [(.7785, .0350), (.7775, .0500), (.7090, .0500), (.7060, .0335),
        (.6000, .0335), (.6000, .0000)]
tube = lathe('barrel | launch tube', 'body', 'gunmetal', outer + bore, segments=28)
cylinder('barrel | bore shadow', 'body', 'rubber', (0, .6015, BORE_Z), .0332, .002,
         verts=32, bevel=0)
# Eight capsule vents cut radially through the brake wall.
for k in range(8):
    angle = math.pi / 8 + k * math.pi / 4
    profile = []
    for end, start in ((1, -math.pi / 2), (-1, math.pi / 2)):
        for i in range(7):
            a = start + i / 6 * math.pi
            profile.append((.742 + end * .020 + .0062 * math.cos(a), .0062 * math.sin(a)))
    cutter = profile_prism('vent cutter', 'body', 'gunmetal', 0, .05, profile, 0)
    for v in cutter.data.vertices:
        x, y, z = v.co
        radial = .058 + x
        v.co = (radial * math.cos(angle) - z * math.sin(angle), y,
                BORE_Z + radial * math.sin(angle) + z * math.cos(angle))
    cutter.data.update()
    PARTS.remove(cutter)
    for target in (tube,):
        boolean = target.modifiers.new('vent', 'BOOLEAN')
        boolean.operation = 'DIFFERENCE'
        boolean.solver = 'EXACT'
        boolean.object = cutter
        bpy.context.view_layer.objects.active = target
        bpy.ops.object.modifier_move_to_index(modifier=boolean.name, index=0)
        bpy.ops.object.modifier_apply(modifier=boolean.name)
    bpy.data.objects.remove(cutter, do_unlink=True)
orient(tube.data)
for poly in tube.data.polygons:
    poly.use_smooth = True
box_uv(tube.data)

hollow_tube('barrel | orange collar band', 'body', 'orange paint', (0, .5230, BORE_Z),
            .0636, .0590, .0100, verts=32, bevel=0)
hollow_tube('barrel | rubber nose ring', 'body', 'rubber', (0, .4560, BORE_Z),
            .0675, .0500, .0300, verts=32, bevel=0)
for y in (.7005, .5560):
    hollow_tube(f'barrel | machined edge {y}', 'body', 'machined steel',
                (0, y, BORE_Z), .0598 if y > .6 else .0605, .0540, .0016, verts=28, bevel=0)
box('crown | orange index', 'body', 'orange paint', (0, .7630, BORE_Z + .0632),
    (.012, .010, .004), .0012, bevel_segments=2)
for side in (-1, 1):
    cylinder(f'crown | brake screw {side}', 'body', 'machined steel',
             (side * .0632, .7700, BORE_Z), .0034, .002, axis='X', verts=10, bevel=.0003)

# ---------------------------------------------------------------------------
# Flank cassette on a vertical front hinge hub.
# ---------------------------------------------------------------------------
CASSETTE_X = -.119
ROUND_ROWS = (.083, .020, -.043)
HINGE_AUTH = Vector((-.142, .306, .020))
def ring_prism(name, group, finish, x0, x1, outer, inner, bevel=.0012):
    """Rounded-rectangle ring extruded across X (a frame with a true window)."""
    n = len(outer)
    verts = [(x, y, z) for points, x in ((outer, x0), (outer, x1), (inner, x0), (inner, x1))
             for y, z in points]
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.extend(((i, j, n + j, n + i), (2 * n + i, 3 * n + i, 3 * n + j, 2 * n + j),
                      (i, 2 * n + i, 2 * n + j, j), (n + i, n + j, 3 * n + j, 3 * n + i)))
    obj = make_object(name, verts, faces)
    return link_part(obj, name, group, finish, bevel, bevel_segments=2)


ring_prism('cassette | continuous rounded frame', 'mag', 'gunmetal', -.1635, -.1265,
           rounded_rect(.076, .300, -.0945, .1345, .014, 4),
           rounded_rect(.093, .283, -.077, .117, .008, 4), .0022)
for z in (.123, -.083):
    box(f'cassette | frame rail {z}', 'mag', 'gunmetal', (-.107, .188, z),
        (.036, .205, .010), .003, bevel_segments=2)
box('cassette | top slot bar', 'mag', 'gunmetal', (-.160, .188, .1215),
    (.006, .150, .012), .003, bevel_segments=2)
box('cassette | top slot recess', 'mag', 'rubber', (-.1635, .188, .1215),
    (.002, .128, .0035), .0012)
for index, row in enumerate(ROUND_ROWS, 1):
    round_cyl(f'round {index} | steel base', 'machined steel',
              (CASSETTE_X, .276, row), .0268, .012, verts=24)
    round_cyl(f'round {index} | olive body', 'olive drab',
              (CASSETTE_X, .190, row), .0252, .160, verts=24)
    round_cyl(f'round {index} | orange band', 'orange paint',
              (CASSETTE_X, .166, row), .0258, .014, verts=24)
    round_cyl(f'round {index} | steel shoulder', 'machined steel',
              (CASSETTE_X, .1075, row), .0262, .007, verts=24)
    round_cyl(f'round {index} | olive cap', 'olive drab',
              (CASSETTE_X, .0985, row), .0245, .011, radius_top=.0205, verts=24)
    round_cyl(f'round {index} | cap centre', 'gunmetal',
              (CASSETTE_X, .0925, row), .0150, .002, verts=24)
    cylinder(f'cassette | retainer peg {index}', 'mag', 'machined steel',
             (CASSETTE_X, .296, row), .0082, .018, axis='Y', verts=12, bevel=0,
             radius_top=.0070)
    cylinder(f'cassette | detent stud {index}', 'mag', 'machined steel',
             (-.1655, .296, row), .0062, .006, axis='X', verts=12, bevel=0)
    box(f'cassette | orange round mark {index}', 'mag', 'orange paint',
        (-.1650, .081, row), (.004, .016, .0035), .0007)
for y in (.084, .292):
    for z in (.110, -.070):
        cylinder(f'cassette | frame bolt {y} {z}', 'mag', 'machined steel',
                 (-.1650, y, z), .0036, .002, axis='X', verts=10, bevel=.0003)
# Front hinge hub (cassette side) and the receiver lugs that carry its pin.
cylinder('cassette | hinge hub', 'mag', 'gunmetal', HINGE_AUTH, .0135, .070,
         axis='Z', verts=24, bevel=.0012)
cylinder('cassette | hub cap', 'mag', 'machined steel',
         (HINGE_AUTH.x, HINGE_AUTH.y, HINGE_AUTH.z + .0355), .0085, .003,
         axis='Z', verts=16, bevel=.0004)
for dz in (-.0525, .0525):
    z = HINGE_AUTH.z + dz
    cylinder(f'receiver | hinge knuckle {dz:+.3f}', 'body', 'gunmetal',
             (HINGE_AUTH.x, HINGE_AUTH.y, z), .0125, .033, axis='Z', verts=20, bevel=.001)
    box(f'receiver | hinge lug {dz:+.3f}', 'body', 'gunmetal',
        ((HINGE_AUTH.x - .062) / 2, HINGE_AUTH.y + .002, z),
        (abs(HINGE_AUTH.x + .062) + .004, .020, .026), .004, bevel_segments=2)
cylinder('receiver | hinge pin', 'body', 'machined steel', HINGE_AUTH, .0045, .142,
         axis='Z', verts=12, bevel=.0004)
# Pull ring on the rear top corner and the orange release paddle below it.
torus('cassette | pull ring', 'mag', 'machined steel', (-.168, .090, .142), .0115, .0022,
      axis='X', segments=18, ring_segments=6)
cylinder('cassette | pull ring eye', 'mag', 'gunmetal', (-.166, .090, .132), .0048, .006,
         axis='X', verts=12, bevel=.0005)
box('cassette | orange release paddle', 'mag', 'orange paint', (-.163, .080, -.096),
    (.022, .022, .038), .005, bevel_segments=3)
cylinder('cassette | paddle screw', 'mag', 'gunmetal', (-.1745, .080, -.099),
         .0034, .002, axis='X', verts=10, bevel=.0003)

# ---------------------------------------------------------------------------
# Sight: short rail and open reflex hood with a real aperture.
# ---------------------------------------------------------------------------


def reflex_frame():
    def contour(width, height, radius):
        points = []
        for cx, cz, start in ((width / 2 - radius, -height / 2 + radius, -math.pi / 2),
                              (width / 2 - radius, height / 2 - radius, 0),
                              (-width / 2 + radius, height / 2 - radius, math.pi / 2),
                              (-width / 2 + radius, -height / 2 + radius, math.pi)):
            for i in range(6):
                a = start + i / 5 * math.pi / 2
                points.append((cx + radius * math.cos(a), .216 + cz + radius * math.sin(a)))
        return points
    outer = contour(.070, .074, .016)
    inner = contour(.054, .056, .011)
    n = len(outer)
    verts = [(x, y, z) for points, y in ((outer, .330), (outer, .356), (inner, .330), (inner, .356))
             for x, z in points]
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.extend(((i, j, n + j, n + i), (2 * n + i, 3 * n + i, 3 * n + j, 2 * n + j),
                      (i, 2 * n + i, 2 * n + j, j), (n + i, n + j, 3 * n + j, 3 * n + i)))
    obj = make_object('reflex frame', verts, faces)
    return link_part(obj, 'sight | open reflex hood', 'body', 'gunmetal', .0006, smooth=True)


box('sight | short base rail', 'body', 'gunmetal', (0, .305, .1745),
    (.046, .150, .011), .003, bevel_segments=2)
for y in (.250, .272, .294, .316, .338, .360):
    box(f'sight | rail slot {y}', 'body', 'dark polymer', (0, y, .1802),
        (.047, .0045, .0024), .0006)
reflex_frame()
box('sight | electronics foot', 'body', 'gunmetal', (0, .326, .1860),
    (.066, .060, .016), .006, bevel_segments=3)
for side in (-1, 1):
    wing = [ref_yz(*p) for p in ((676, 34), (700, 30), (716, 44), (731, 70), (742, 98),
                                 (728, 108), (706, 96), (688, 82))]
    obj = profile_prism(f'sight | tapered side cheek {side}', 'body', 'gunmetal',
                        side * .0330, .0060, smooth_outline(wing, 3), .0018)
    for poly in obj.data.polygons:
        poly.use_smooth = True
box('sight | reflex lens', 'body', 'optic glass', (0, .343, .216),
    (.053, .001, .054), .004, bevel_segments=3)
cylinder('sight | reflex emitter', 'extra', 'phosphor', (0, .343, .216),
         .0014, .001, axis='Y', verts=12, bevel=0)
for side in (-1, 1):
    cylinder(f'sight | adjustment dial {side}', 'body', 'dark polymer',
             (side * .0375, .318, .198), .0105, .006, axis='X', verts=20, bevel=.001)
    cylinder(f'sight | orange dial {side}', 'body', 'orange paint',
             (side * .0415, .318, .198), .0070, .002, axis='X', verts=20, bevel=.0005)

# ---------------------------------------------------------------------------
# Right flank: charging track in the service pocket, selector and witness.
# ---------------------------------------------------------------------------
track_x = body_x(.262, .086) - .004
box('bolt | recessed charging track', 'body', 'rubber', (track_x + .001, .262, .086),
    (.004, .104, .009), .003, bevel_segments=2)
box('bolt | short charging pawl', 'bolt', 'gunmetal', (track_x + .0065, .300, .086),
    (.013, .036, .013), .004, bevel_segments=3)
cylinder('bolt | pawl grip', 'bolt', 'machined steel', (track_x + .016, .302, .086),
         .0075, .011, axis='X', verts=18, bevel=.001)
cylinder('extra | selector dial', 'extra', 'gunmetal',
         (body_x(.345, -.004) + .002, .345, -.004), .0095, .006, axis='X', verts=20, bevel=.001)
box('extra | chamber witness', 'extra', 'orange paint',
    (body_x(.232, .060) - .0005, .232, .060), (.004, .012, .0035), .0007)
