#!/usr/bin/env python3
"""Compile ttt_waterworld.bsp (Leith Waterworld) into the shared voxel grid.

Usage: python3 tools/compile-waterworld-reference.py path/to/ttt_waterworld.bsp
Pure Python (no numpy). Source download/provenance is documented in
docs/maps/waterworld.md. The BSP is an offline authoring input, never a
runtime dependency; the generated module is shared/world/waterworld-data.js.

Unlike ttt_minecraft_b5, Waterworld is ordinary Source architecture: 1860
world brushes of which two thirds are not axis-aligned (the flume tubes),
thin 4 to 20 unit walls, floors, railings and stairs. The compiler samples
every brush at 32 Source units per voxel (the same scale as Minecraft B5, so
a player keeps its 72-unit proportions) and fills a cell when

  * the accumulated brush volume covers at least 45 % of it, or
  * an axis-aligned brush thinner than one voxel covers at least half of the
    cell's cross-section, in which case the slab snaps to the cell holding
    its centre plane (walls, glass, floors, railings and stair treads), or
  * a tilted panel (thin on one axis of its bounding box) projects onto at
    least a quarter of the cell along that axis, or
  * a shell brush (tilted on two axes and filling little of its own bounding
    box, as the flume tube panels do) covers 30 % of the cell once every face
    is pushed out by 12 units to voxel thickness.

A water brush thinner than a voxel (the flume splash lane) snaps to the cell
holding its centre plane like a slab, so the lane stays wet.

The two flumes are rides: the 25 trigger_push volumes that carry riders
(170 units per second) are chained by following each push direction to the
next volume, and every chain becomes an authored slide whose path runs from
the tower mouth through the push-volume centres to the shared splash lane.
A two-voxel bore is carved along each path and the tube shell closed around
it, so a rider on the rails always travels through air inside plastic.

Spawns for the free-for-all and team modes are generated: dry standing cells
with a flat 3 x 3 floor, three voxels of head room and no water beside them,
spread by farthest-point sampling over the decks, changing rooms, mezzanine
and tower. Trouble in Terrorist Town keeps the 66 original entities.

The compiled BSP's own solid leaves (the void outside the sealed hull) and
every air pocket unreachable from the spawns become a backing layer of the
adjacent material over bedrock, so mining never opens onto an empty shell.
"""
import base64
import collections
import hashlib
import json
import math
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'shared' / 'world' / 'waterworld-data.js'

UNIT = 32.0
SX, SY, SZ = 200, 36, 188
SOURCE_X0 = -3392.0          # west edge of voxel column 0 (hull wall at -3328 plus a margin)
SOURCE_Y1 = 960.0            # north edge of voxel row 0 (hull wall at 896 plus a margin)
BASE_LAYER = -17             # source layer stored at voxel y = 0 (z = -544 .. -512)
DECK_Z = -256.0              # pool deck and foyer floor: the walkable ground level
GROUND_LEVEL = int(DECK_Z / UNIT - BASE_LAYER) - 1   # floor voxel under a player on the deck (8)
THIN = 32.0                  # brushes thinner than one voxel snap to their centre cell
VOLUME_THRESHOLD = 0.45
ANGLED_VOLUME_THRESHOLD = 0.3   # bent flume segments are thin shells
ANGLED_SHELL_FILL = 0.35        # a tilted brush filling less of its box than this is a shell
SHELL_INFLATE = 12.0            # Source units added to every face of a shell before sampling
SLAB_THRESHOLD = 0.5
ANGLED_SLAB_THRESHOLD = 0.4     # a tilted panel passes through several cells along its thin axis;
                                # door-frame posts beside the cubicle doors stay below this
FLUME_PUSH_SPEED = 150.0        # trigger_push volumes at least this fast (Source units/s) carry flume riders;
                                # the lazy river (65) and the whirlpool (100) are currents, not rides
SLIDE_FEET_DROP = 1.1           # a rider's feet sit this far under the tube centreline (shared/slide-rules.js)
SLIDE_BORE_RADIUS = 1.25        # cells whose centre is this close to the path are cleared for the rider
SLIDE_BEND_RADIUS = 1.6         # the bore widens to this within a voxel of every bend so a steered rider clears it
SLIDE_SHELL_RADIUS = 2.0        # cells out to here become tube shell where the voxel tube leaks
SLIDE_MOUTH_REACH = 4.0         # the mouth waypoint sits this far up the tower from the first push volume
SLIDE_EXIT_REACH = 2.5          # the ride ends this far past the last push volume, over the splash lane
SLIDE_CHAIN_REACH = 8.0         # a push volume hands over to the next one whose entry face is this close
SPAWN_GAP = 9.0                 # least distance (x/z, with height weighted three times) between generated spawns
FUN_SPAWN_COUNT = 24
TEAM_SPAWN_COUNT = 12
ALPHA_MIN_Z = 112               # the foyer and its forecourt lie south of the hall's south wall (z >= 112)
BRAVO_MAX_Z = 60                # the wave pool, cafe, tower stairs and traitor room lie north of z = 60

# Block ids: must equal shared/world/blocks.js.
AIR = 0
CONCRETE = 7
METAL = 8
GLASS = 11
PALE = 12
BEDROCK = 29
MC_WATER = 66
MC_PORTAL = 68
POOL_TILE_BLUE = 79
POOL_TILE_WHITE = 80
POOL_FLOOR = 81
SLIDE_BLUE = 82
SLIDE_YELLOW = 83
POOL_PANEL = 84
VOID = 255

# Source texture substring -> block id, first match wins.
MATERIAL_BLOCKS = [
    ('DGLZ_TILES_BLUE', POOL_TILE_BLUE), ('DGLZ_TILES_WHITE', POOL_TILE_WHITE),
    ('DGLZ_PLASTIC_BLUE', SLIDE_BLUE), ('DGLZ_PLASTIC_YELLOW', SLIDE_YELLOW),
    ('/TILE/', POOL_FLOOR), ('TILE/TILEFLOOR', POOL_FLOOR), ('GLASS', GLASS),
    ('CONCRETE', CONCRETE), ('PLASTER', PALE), ('BUILDING_TEMPLATE', PALE),
    ('METALHULL', POOL_PANEL), ('METALWALL', POOL_PANEL), ('CITADEL_METALWALL', POOL_PANEL),
    ('METAL', METAL), ('DECALMETALGRATE', METAL), ('DEV/', CONCRETE),
]
IGNORED_TEXTURES = ('PROPS/', 'SPRITES/')
# Decoration models drawn by public/js/engine/waterworld-details.js: local
# half-extents in Source units (x along the model's yaw, y across, z up).
PROP_KINDS = {
    'models/props_c17/lockers001a.mdl': ('locker', (22, 10, 41)),
    'models/props_borealis/bluebarrel001.mdl': ('barrel', (11, 11, 22)),
    'models/props_wasteland/cafeteria_table001a.mdl': ('table', (48, 26, 15)),
    'models/props_interiors/vendingmachinesoda01a.mdl': ('vending', (18, 14, 36)),
    'models/props_junk/wood_crate001a.mdl': ('crate', (20, 20, 20)),
    'models/props_junk/wood_crate002a.mdl': ('crate', (14, 14, 14)),
    'models/props_trainstation/bench_indoor001a.mdl': ('bench', (30, 10, 18)),
    'models/props_wasteland/coolingtank02.mdl': ('tank', (48, 48, 64)),
    'models/props_trainstation/trashcan_indoor001b.mdl': ('bin', (9, 9, 18)),
    'models/props_lab/generator.mdl': ('generator', (30, 20, 30)),
    'models/props_wasteland/controlroom_desk001a.mdl': ('desk', (40, 20, 18)),
    'models/props_wasteland/kitchen_shelf001a.mdl': ('shelf', (24, 10, 40)),
}
DOOR_MODELS = ('models/props_c17/door01_left.mdl', 'models/props_c17/door02_double.mdl')

# ------------------------------------------------------------------ BSP reader

def read_bsp(path):
    data = path.read_bytes()
    ident, version = struct.unpack_from('<4si', data, 0)
    if ident != b'VBSP' or version != 20:
        raise SystemExit('expected a VBSP version 20 file')
    lumps = [struct.unpack_from('<iii4s', data, 8 + i * 16) for i in range(64)]

    def lump(i):
        ofs, ln, _, _ = lumps[i]
        if ofs + ln > len(data):
            raise SystemExit('truncated BSP')
        return data[ofs:ofs + ln]

    planes = [struct.unpack_from('<ffffi', lump(1), i * 20) for i in range(len(lump(1)) // 20)]
    texdata = [struct.unpack_from('<fffiiiii', lump(2), i * 32) for i in range(len(lump(2)) // 32)]
    texinfo = [struct.unpack_from('<16fii', lump(6), i * 72) for i in range(len(lump(6)) // 72)]
    strdata = lump(43)
    strtab = struct.unpack_from('<%di' % (len(lump(44)) // 4), lump(44))
    brushes = [struct.unpack_from('<iii', lump(18), i * 12) for i in range(len(lump(18)) // 12)]
    sides = [struct.unpack_from('<Hhhh', lump(19), i * 8) for i in range(len(lump(19)) // 8)]
    models = [struct.unpack_from('<9fiii', lump(14), i * 48) for i in range(len(lump(14)) // 48)]
    nodes = [struct.unpack_from('<iii6hHHhh', lump(5), i * 32) for i in range(len(lump(5)) // 32)]
    leaves = [struct.unpack_from('<ihh6hHHHHh', lump(10), i * 32) for i in range(len(lump(10)) // 32)]
    leafbrushes = struct.unpack_from('<%dH' % (len(lump(17)) // 2), lump(17))

    def texname(index):
        offset = strtab[texdata[index][3]]
        end = strdata.index(b'\0', offset)
        return strdata[offset:end].decode().upper()

    def model_brushes(m):
        out = set()
        stack = [models[m][9]]
        while stack:
            n = stack.pop()
            if n < 0:
                leaf = leaves[-1 - n]
                out.update(leafbrushes[leaf[11]:leaf[11] + leaf[12]])
            else:
                stack.extend(nodes[n][1:3])
        return sorted(out)

    def leaf_contents(x, y, z):
        node = models[0][9]
        while node >= 0:
            nx, ny, nz, d, _ = planes[nodes[node][0]]
            node = nodes[node][1] if nx * x + ny * y + nz * z - d >= 0 else nodes[node][2]
        return leaves[-1 - node][0]

    def brush_sides(index):
        first, num, contents = brushes[index]
        result = []
        for s in range(first, first + num):
            plane, tinfo, _, bevel = sides[s]
            nx, ny, nz, d, _ = planes[plane]
            name = texname(texinfo[tinfo][17]) if 0 <= tinfo < len(texinfo) else ''
            result.append(((nx, ny, nz, d), name, bevel != 0))
        return result

    # Static props (game lump 'sprp'): model name, origin and yaw per instance.
    static_props = []
    game = lump(35)
    if len(game) >= 4:
        count = struct.unpack_from('<i', game, 0)[0]
        for i in range(count):
            gid, _flags, _version, fileofs, filelen = struct.unpack_from('<iHHii', game, 4 + i * 16)
            if gid.to_bytes(4, 'little') != b'prps':
                continue
            s = data[fileofs:fileofs + filelen]
            n = struct.unpack_from('<i', s, 0)[0]
            names = [s[4 + 128 * j:4 + 128 * j + 128].split(b'\0')[0].decode() for j in range(n)]
            p = 4 + 128 * n
            leafcount = struct.unpack_from('<i', s, p)[0]
            p += 4 + 2 * leafcount
            m = struct.unpack_from('<i', s, p)[0]
            p += 4
            size = (filelen - p) // m if m else 0
            for j in range(m):
                ox, oy, oz, _pitch, yaw, _roll, model = struct.unpack_from('<6fH', s, p + j * size)
                static_props.append({'model': names[model], 'origin': (ox, oy, oz), 'yaw': yaw})

    entities = []
    for block in re.findall(r'\{(.*?)\}', lump(0).decode('latin1'), re.S):
        entities.append(dict(re.findall(r'"([^"]*)" "([^"]*)"', block)))
    return {
        'sha256': hashlib.sha256(data).hexdigest(),
        'entities': entities,
        'static_props': static_props,
        'models': len(models),
        'model_brushes': model_brushes,
        'brush_sides': brush_sides,
        'leaf_contents': leaf_contents,
    }


# ------------------------------------------------------------- geometry helpers

def vec(text, default=(0.0, 0.0, 0.0)):
    parts = [float(v) for v in re.findall(r'-?\d+(?:\.\d+)?(?:e[+-]?\d+)?', text or '', re.I)]
    return tuple(parts[:3]) if len(parts) >= 3 else default


def brush_geometry(sides, origin):
    """Half-spaces (world space), material counter, AABB and axis-alignment.

    A textured top face counts three times: floors are seen from above, and
    their sides usually carry the hull texture of the wall they sit against.
    """
    planes, mats = [], collections.Counter()
    aabb = [[None, None], [None, None], [None, None]]
    axis_aligned = True
    for (nx, ny, nz, d), name, bevel in sides:
        if bevel:
            continue
        d += nx * origin[0] + ny * origin[1] + nz * origin[2]
        planes.append((nx, ny, nz, d))
        if name and not name.startswith('TOOLS/'):
            mats[name] += 3 if nz > 0.9 else 1
        axis = next((i for i, v in enumerate((nx, ny, nz)) if abs(abs(v) - 1) < 1e-5), None)
        if axis is None or abs(nx) + abs(ny) + abs(nz) > 1.0001:
            axis_aligned = False
            continue
        sign = 1 if (nx, ny, nz)[axis] > 0 else -1
        if sign > 0:
            aabb[axis][1] = d if aabb[axis][1] is None else min(aabb[axis][1], d)
        else:
            aabb[axis][0] = -d if aabb[axis][0] is None else max(aabb[axis][0], -d)
    if not axis_aligned or any(v is None for a in aabb for v in a):
        aabb = polytope_aabb(planes)
        axis_aligned = False
    return planes, mats, aabb, axis_aligned


def polytope_aabb(planes):
    points = []
    n = len(planes)
    for i in range(n):
        for j in range(i + 1, n):
            for k in range(j + 1, n):
                p = solve3(planes[i], planes[j], planes[k])
                if p and all(a * p[0] + b * p[1] + c * p[2] <= d + 1e-3 for a, b, c, d in planes):
                    points.append(p)
    if not points:
        return None
    return [[min(p[i] for p in points), max(p[i] for p in points)] for i in range(3)]


def brush_vertices(planes):
    """Every corner of a convex brush (the intersection points that satisfy all planes)."""
    points = []
    n = len(planes)
    for i in range(n):
        for j in range(i + 1, n):
            for k in range(j + 1, n):
                p = solve3(planes[i], planes[j], planes[k])
                if p and all(a * p[0] + b * p[1] + c * p[2] <= d + 1e-3 for a, b, c, d in planes):
                    points.append(p)
    return points


def solve3(p, q, r):
    a = [[p[0], p[1], p[2]], [q[0], q[1], q[2]], [r[0], r[1], r[2]]]
    b = [p[3], q[3], r[3]]
    det = (a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
           - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
           + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]))
    if abs(det) < 1e-6:
        return None
    x = [0.0, 0.0, 0.0]
    for col in range(3):
        m = [row[:] for row in a]
        for row in range(3):
            m[row][col] = b[row]
        x[col] = (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                  - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                  + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])) / det
    return tuple(x)


def to_world_box(aabb):
    """Source AABB -> continuous voxel-space box [x0,x1],[y0,y1],[z0,z1]."""
    (sx0, sx1), (sy0, sy1), (sz0, sz1) = aabb
    return [
        [(sx0 - SOURCE_X0) / UNIT, (sx1 - SOURCE_X0) / UNIT],
        [sz0 / UNIT - BASE_LAYER, sz1 / UNIT - BASE_LAYER],
        [(SOURCE_Y1 - sy1) / UNIT, (SOURCE_Y1 - sy0) / UNIT],
    ]


def world_point(sx, sy, sz):
    return ((sx - SOURCE_X0) / UNIT, sz / UNIT - BASE_LAYER, (SOURCE_Y1 - sy) / UNIT)


def source_point(wx, wy, wz):
    return (wx * UNIT + SOURCE_X0, SOURCE_Y1 - wz * UNIT, (wy + BASE_LAYER) * UNIT)


def segment_hits(planes, p0, p1):
    """True when the segment p0-p1 (Source space) passes through the convex brush."""
    t0, t1 = 0.0, 1.0
    dx, dy, dz = p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]
    for a, b, c, d in planes:
        start = a * p0[0] + b * p0[1] + c * p0[2] - d
        slope = a * dx + b * dy + c * dz
        if abs(slope) < 1e-9:
            if start > 1e-4:
                return False
            continue
        t = -start / slope
        if slope > 0:
            t1 = min(t1, t)
        else:
            t0 = max(t0, t)
        if t0 > t1:
            return False
    return True


def coverage(box, planes, axis_aligned, ignore_axis=None):
    """Yield (cell, fraction) for every voxel the brush overlaps.

    ignore_axis reports cross-section coverage instead of volume, which is
    how slabs thinner than a voxel become full cells: an axis-aligned slab
    snaps to the single cell holding its centre plane, an angled panel marks
    every cell its projection passes through.
    """
    ranges = []
    for axis in range(3):
        lo, hi = box[axis]
        if ignore_axis == axis and axis_aligned:
            c = int(math.floor((lo + hi) / 2))
            ranges.append(range(max(0, c), min((SX, SY, SZ)[axis], c + 1)))
        else:
            ranges.append(range(max(0, int(math.floor(lo))), min((SX, SY, SZ)[axis], int(math.ceil(hi)))))
    samples = (0.125, 0.375, 0.625, 0.875)
    for x in ranges[0]:
        for y in ranges[1]:
            for z in ranges[2]:
                if axis_aligned:
                    frac = 1.0
                    for axis, c in enumerate((x, y, z)):
                        if ignore_axis == axis:
                            continue
                        lo, hi = box[axis]
                        frac *= max(0.0, min(hi, c + 1) - max(lo, c))
                    if frac > 1e-9:
                        yield (x, y, z), frac
                elif ignore_axis is None:
                    inside = 0
                    for ox in samples:
                        for oy in samples:
                            for oz in samples:
                                sx, sy, sz = source_point(x + ox, y + oy, z + oz)
                                if all(a * sx + b * sy + c * sz <= d + 1e-4 for a, b, c, d in planes):
                                    inside += 1
                    if inside:
                        yield (x, y, z), inside / 64
                else:
                    hits = 0
                    for ou in samples:
                        for ov in samples:
                            if ignore_axis == 0:
                                p0, p1 = (x, y + ou, z + ov), (x + 1, y + ou, z + ov)
                            elif ignore_axis == 1:
                                p0, p1 = (x + ou, y, z + ov), (x + ou, y + 1, z + ov)
                            else:
                                p0, p1 = (x + ou, y + ov, z), (x + ou, y + ov, z + 1)
                            if segment_hits(planes, source_point(*p0), source_point(*p1)):
                                hits += 1
                    if hits:
                        yield (x, y, z), hits / 16


def material_block(mats):
    """The block with the most textured faces wins; ties follow MATERIAL_BLOCKS order."""
    scores = collections.Counter()
    for name, count in mats.items():
        if any(name.startswith(prefix) for prefix in IGNORED_TEXTURES):
            continue
        block = next((block for key, block in MATERIAL_BLOCKS if key in name), CONCRETE)
        scores[block] += count
    if not scores:
        return None
    order = [block for _, block in MATERIAL_BLOCKS] + [CONCRETE]
    return max(scores, key=lambda block: (scores[block], -order.index(block)))


# ------------------------------------------------------------------- compiler

def main(argv):
    if len(argv) != 2:
        raise SystemExit(__doc__)
    bsp = read_bsp(Path(argv[1]))
    grid = bytearray(SX * SY * SZ)
    stats = collections.Counter()

    def idx(x, y, z):
        return (y * SZ + z) * SX + x

    def inside(x, y, z):
        return 0 <= x < SX and 0 <= y < SY and 0 <= z < SZ

    def get(x, y, z):
        return grid[idx(x, y, z)] if inside(x, y, z) else BEDROCK

    def put(x, y, z, value, only_air=False):
        if not inside(x, y, z):
            return
        i = idx(x, y, z)
        if only_air and grid[i] != AIR:
            return
        grid[i] = value

    by_model = {}
    for entity in bsp['entities']:
        model = entity.get('model', '')
        if model.startswith('*'):
            by_model[int(model[1:])] = entity

    volume = collections.defaultdict(float)     # accumulated brush volume per cell
    slab = collections.defaultdict(float)       # snapped cross-section coverage per cell
    weight = collections.defaultdict(collections.Counter)
    water = collections.defaultdict(float)
    shallow = collections.defaultdict(float)     # water layers thinner than a voxel (the splash lane)
    angled = set()                              # cells claimed by tilted panels and bends
    sky_open, sky_wall = set(), set()

    def add_brush(sides, origin, forced_block=None):
        names = {name for _, name, bevel in sides if not bevel}
        planes, mats, aabb, axis_aligned = brush_geometry(sides, origin)
        if aabb is None:
            return
        box = to_world_box(aabb)
        size = [aabb[i][1] - aabb[i][0] for i in range(3)]
        thin_axis = (0, 2, 1)[min(range(3), key=lambda i: size[i])] if min(size) < THIN else None
        if any('TOOLSSKYBOX' in n for n in names):
            # Sky ceilings open to the sky; vertical sky walls become the hull.
            target = sky_open if thin_axis == 1 or size[2] <= min(size[0], size[1]) else sky_wall
            for cell, frac in coverage(box, planes, axis_aligned, thin_axis):
                if frac >= SLAB_THRESHOLD:
                    target.add(cell)
            stats['skybox-brushes'] += 1
            return
        if any('NATURE/WATER' in n for n in names):
            # A water layer thinner than a voxel (the flume splash lane holds
            # twelve units over a thin floor) snaps to the cell holding its
            # centre plane, or to the cell above when a floor slab owns it.
            if thin_axis is not None:
                for cell, frac in coverage(box, planes, axis_aligned, thin_axis):
                    shallow[cell] += frac
            else:
                for cell, frac in coverage(box, planes, axis_aligned):
                    water[cell] += frac
            stats['water-brushes'] += 1
            return
        block = forced_block if forced_block is not None else material_block(mats)
        if block is None:
            stats['untextured-brushes'] += 1
            return
        covered = list(coverage(box, planes, axis_aligned))
        # A tilted brush that fills little of its own bounding box is a shell
        # (a flume bend, a curved wall); its cells need less volume than a
        # solid wedge such as the sloped pool bed.
        shell = (not axis_aligned and thin_axis is None
                 and sum(f for _, f in covered) < ANGLED_SHELL_FILL * max(1.0, (box[0][1] - box[0][0]) * (box[1][1] - box[1][0]) * (box[2][1] - box[2][0])))
        for cell, frac in covered:
            volume[cell] += frac
            weight[cell][block] += frac
        if shell:
            # A 4-unit flume panel tilted on two axes never fills a cell; inflate
            # it to voxel thickness so the tube walls stay continuous.
            inflated = [(a, b, c, d + SHELL_INFLATE) for a, b, c, d in planes]
            grown = [[box[0][0] - SHELL_INFLATE / UNIT, box[0][1] + SHELL_INFLATE / UNIT],
                     [box[1][0] - SHELL_INFLATE / UNIT, box[1][1] + SHELL_INFLATE / UNIT],
                     [box[2][0] - SHELL_INFLATE / UNIT, box[2][1] + SHELL_INFLATE / UNIT]]
            for cell, frac in coverage(grown, inflated, False):
                if frac + 1e-9 >= ANGLED_VOLUME_THRESHOLD:
                    angled.add(cell)
                    weight[cell][block] += frac * 0.5
            stats['shell-brushes'] += 1
        if thin_axis is not None:
            for cell, frac in coverage(box, planes, axis_aligned, thin_axis):
                weight[cell][block] += frac * 0.5
                if axis_aligned:
                    slab[cell] += frac
                elif frac + 1e-9 >= ANGLED_SLAB_THRESHOLD:
                    angled.add(cell)
            stats['thin-brushes'] += 1
        else:
            stats['solid-brushes'] += 1

    for brush in bsp['model_brushes'](0):
        add_brush(bsp['brush_sides'](brush), (0.0, 0.0, 0.0))
    for model, entity in sorted(by_model.items()):
        # Breakable windows are the only brush entities that shape the hull;
        # doors, buttons, triggers and the traitor traps stay out of the grid.
        if entity.get('classname') == 'func_breakable_surf':
            for brush in bsp['model_brushes'](model):
                add_brush(bsp['brush_sides'](brush), vec(entity.get('origin')), GLASS)

    for cell in set(volume) | set(slab) | angled:
        if slab.get(cell, 0.0) + 1e-9 < SLAB_THRESHOLD and cell not in angled:
            if volume.get(cell, 0.0) + 1e-9 < VOLUME_THRESHOLD:
                continue
            # The shallow beach floors sit 16 units under the surface: a cell
            # half filled by the pool bed and half by water stays water so the
            # paddling area keeps its depth instead of drying into a tile shelf.
            if water.get(cell, 0.0) + 1e-9 >= SLAB_THRESHOLD and volume.get(cell, 0.0) < 0.6:
                stats['beach-water'] += 1
                continue
        put(*cell, weight[cell].most_common(1)[0][0])
    for cell, frac in water.items():
        if frac + 1e-9 >= SLAB_THRESHOLD:
            put(*cell, MC_WATER, only_air=True)
    for (x, y, z), frac in shallow.items():
        if frac + 1e-9 < SLAB_THRESHOLD:
            continue
        if get(x, y, z) == AIR:
            put(x, y, z, MC_WATER)
        elif get(x, y + 1, z) == AIR:
            put(x, y + 1, z, MC_WATER)
            stats['shallow-water-lifted'] += 1
    for cell in sky_wall:
        put(*cell, CONCRETE, only_air=True)

    solid_types = {v for v in range(1, 255)} - {MC_WATER, MC_PORTAL, VOID}

    def solid(x, y, z):
        return get(x, y, z) in solid_types

    def floor_below(wx, wy, wz):
        x, z = int(wx), int(wz)
        y = int(wy)
        while y > 1 and not solid(x, y - 1, z):
            y -= 1
        return y - 1

    # Flume rides. The trigger_push volumes that carry riders are chained by
    # following each push direction to the volume whose entry face lies
    # nearest to the current exit face; every chain start is a flume mouth on
    # the tower and both chains end in the shared splash lane. A ride follows
    # the polyline through the volume centres (shared/slide-rules.js).
    pushes = []
    for model, entity in sorted(by_model.items()):
        if entity.get('classname') != 'trigger_push' or entity.get('StartDisabled') == '1':
            continue
        if float(entity.get('speed', 0) or 0) < FLUME_PUSH_SPEED:
            continue
        origin = vec(entity.get('origin'))
        corners = []
        for brush in bsp['model_brushes'](model):
            planes, _, _, _ = brush_geometry(bsp['brush_sides'](brush), origin)
            corners += [world_point(*c) for c in brush_vertices(planes)]
        if not corners:
            continue
        centre = [sum(c[i] for c in corners) / len(corners) for i in range(3)]
        yaw = math.radians(vec(entity.get('pushdir'))[1])
        direction = (math.cos(yaw), -math.sin(yaw))
        reach = max((c[0] - centre[0]) * direction[0] + (c[2] - centre[2]) * direction[1] for c in corners)
        pushes.append({
            'model': model, 'centre': centre, 'dir': direction, 'reach': reach,
            'speed': float(entity['speed']) / UNIT,
            'entry': (centre[0] - direction[0] * reach, centre[2] - direction[1] * reach),
            'exit': (centre[0] + direction[0] * reach, centre[2] + direction[1] * reach),
        })
    successor = {}
    for push in pushes:
        best = None
        for other in pushes:
            if other is push or push['dir'][0] * other['dir'][0] + push['dir'][1] * other['dir'][1] < -0.3:
                continue
            gap = (math.hypot(push['exit'][0] - other['entry'][0], push['exit'][1] - other['entry'][1])
                   + abs(push['centre'][1] - other['centre'][1]) * 0.5)
            if gap < SLIDE_CHAIN_REACH and (best is None or gap < best[0]):
                best = (gap, other['model'])
        successor[push['model']] = best[1] if best else None
    by_push = {push['model']: push for push in pushes}
    chains = []
    for push in pushes:
        if push['model'] in successor.values():
            continue
        chain = [push['model']]
        while successor[chain[-1]] is not None and successor[chain[-1]] not in chain:
            chain.append(successor[chain[-1]])
        chains.append(chain)
    chains.sort(key=lambda chain: sum(by_push[m]['centre'][0] for m in chain) / len(chain))
    slide_names = ['west-flume', 'east-flume', 'third-flume', 'fourth-flume']
    shared_pushes = {m for chain in chains for m in chain if sum(m in c for c in chains) > 1}
    slides = []
    for name, chain in zip(slide_names, chains):
        first, second = by_push[chain[0]]['centre'], by_push[chain[1]]['centre']
        heading = math.hypot(second[0] - first[0], second[2] - first[2])
        back = ((second[0] - first[0]) / heading, (second[2] - first[2]) / heading)
        mouth = [first[0] - back[0] * SLIDE_MOUTH_REACH, 0.0, first[2] - back[1] * SLIDE_MOUTH_REACH]
        mouth[1] = floor_below(mouth[0], first[1] + 3, mouth[2]) + 1 + SLIDE_FEET_DROP
        path = [mouth]
        for m in chain:
            push = by_push[m]
            if m not in shared_pushes:
                path.append(list(push['centre']))
                continue
            # The splash lane is one wide push volume shared by both flumes,
            # with a divider between the two channels: keep the rider's lane
            # by projecting the previous waypoint along the push direction,
            # and lift the rail onto the voxel lane floor.
            prev, d = path[-1], push['dir']
            along = (push['centre'][0] - prev[0]) * d[0] + (push['centre'][2] - prev[2]) * d[1]
            span = along + push['reach'] + SLIDE_EXIT_REACH
            end = [prev[0] + d[0] * span, push['centre'][1], prev[2] + d[1] * span]
            end[1] = max(end[1], floor_below(end[0], end[1] + 1, end[2]) + 1 + SLIDE_FEET_DROP)
            path.append([prev[0] + d[0] * along, end[1], prev[2] + d[1] * along])
            path.append(end)
        if chain[-1] not in shared_pushes:
            last = by_push[chain[-1]]
            span = last['reach'] + SLIDE_EXIT_REACH
            path.append([last['centre'][0] + last['dir'][0] * span, last['centre'][1], last['centre'][2] + last['dir'][1] * span])
        slides.append({
            'id': name,
            'speed': round(sum(by_push[m]['speed'] for m in chain) / len(chain), 3),
            'pushes': chain,
            'path': [[round(v, 3) for v in point] for point in path],
        })
    stats['flume-pushes'] = len(pushes)

    # Carve a rider-sized bore along every ride and close the tube shell
    # around it: the 32-unit sampling leaves the tubes one cell wide with
    # gaps, so the rails alone would drag a body through plastic and out
    # into the hall. The mouth on the tower and the open splash lane keep
    # their original shape.
    bore = set()
    shell = {}
    for slide in slides:
        path = slide['path']
        travelled = 0.0
        for index in range(len(path) - 1):
            a, b = path[index], path[index + 1]
            length = math.dist(a, b)
            steps = max(1, int(length / 0.25))
            for k in range(steps + 1):
                t = k / steps
                px, py, pz = [a[j] + (b[j] - a[j]) * t for j in range(3)]
                feet = int(math.floor(py - SLIDE_FEET_DROP))
                closed = travelled + length * t > SLIDE_MOUTH_REACH and index < len(path) - 2
                bend = (index > 0 and length * t < 1.0) or (index < len(path) - 2 and length * (1 - t) < 1.0)
                radius = SLIDE_BEND_RADIUS if bend else SLIDE_BORE_RADIUS
                for dx in range(-2, 3):
                    for dz in range(-2, 3):
                        cx, cz = int(math.floor(px)) + dx, int(math.floor(pz)) + dz
                        distance = math.hypot(cx + 0.5 - px, cz + 0.5 - pz)
                        if distance <= radius:
                            bore.add((cx, feet, cz))
                            bore.add((cx, feet + 1, cz))
                            if closed:
                                shell[(cx, feet - 1, cz)] = SLIDE_YELLOW
                                shell.setdefault((cx, feet + 2, cz), SLIDE_BLUE)
                        elif distance <= SLIDE_SHELL_RADIUS and closed:
                            shell.setdefault((cx, feet, cz), SLIDE_BLUE)
                            shell.setdefault((cx, feet + 1, cz), SLIDE_BLUE)
            travelled += length
    for cell in sorted(bore):
        if inside(*cell) and get(*cell) not in (AIR, BEDROCK, MC_WATER):
            stats['bore-carved:%d' % get(*cell)] += 1
            put(*cell, AIR)
    for cell, block in sorted(shell.items()):
        if cell not in bore:
            put(*cell, block, only_air=True)
    stats['bore-cells'] = len(bore)

    # Spawns: info_player_deathmatch feet positions become [x, z, floorY].
    spawns = []
    for entity in bsp['entities']:
        if entity.get('classname') != 'info_player_deathmatch':
            continue
        wx, wy, wz = world_point(*vec(entity['origin']))
        x, z = int(wx), int(wz)
        feet = int(math.floor(wy + 0.01))
        while feet < SY - 2 and solid(x, feet, z):
            feet += 1
        floor = feet - 1
        while floor > 1 and not solid(x, floor, z):
            floor -= 1
        spawns.append([x, z, floor])

    # The compiled BSP marks everything outside the sealed hull as solid
    # leaves; those cells are void. Sky brushes are exempt so the foyer and the
    # hall's skylight stay open above, and so is the flume bore where a ride
    # cuts through the original tube shell.
    CONTENTS_SOLID = 0x1
    for y in range(1, SY):
        for z in range(SZ):
            for x in range(SX):
                v = get(x, y, z)
                if v != AIR and v != MC_WATER:
                    continue
                if (x, y, z) in sky_open or (x, y, z) in bore:
                    continue
                if bsp['leaf_contents'](*source_point(x + 0.5, y + 0.5, z + 0.5)) & CONTENTS_SOLID:
                    put(x, y, z, VOID)
                    stats['bsp-void'] += 1

    # Anything the players cannot reach from a spawn or a teleport arrival is
    # sealed decoration space and joins the void.
    reachable = set()
    queue = [(sx, sy + 1, sz) for (sx, sz, sy) in spawns]
    # The sky over the foyer is outside too: nothing above the glass canopy
    # or the entrance walls is sealed space.
    queue += [(x, SY - 1, z) for (x, y, z) in sky_open if y == SY - 1]
    for entity in bsp['entities']:
        if entity.get('classname') in ('point_teleport', 'info_teleport_destination'):
            wx, wy, wz = world_point(*vec(entity.get('origin')))
            queue.append((int(wx), int(wy + 0.01), int(wz)))
    queue = [c for c in queue if inside(*c) and get(*c) in (AIR, MC_WATER)]
    reachable.update(queue)
    while queue:
        x, y, z = queue.pop()
        for dx, dy, dz in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
            n = (x + dx, y + dy, z + dz)
            if inside(*n) and n not in reachable and get(*n) in (AIR, MC_WATER):
                reachable.add(n)
                queue.append(n)
    for y in range(1, SY):
        for z in range(SZ):
            for x in range(SX):
                v = get(x, y, z)
                if v in (AIR, MC_WATER) and (x, y, z) not in reachable:
                    put(x, y, z, VOID)
                    stats['sealed-void'] += 1

    # Void next to a visible wall takes that wall's material so a mined wall
    # shows one more course of the same finish; deeper void is bedrock.
    backing = {}
    neighbours6 = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))
    for y in range(1, SY):
        for z in range(SZ):
            for x in range(SX):
                if get(x, y, z) != VOID:
                    continue
                faces = collections.Counter()
                exposed = False
                for dx, dy, dz in neighbours6:
                    v = get(x + dx, y + dy, z + dz)
                    if v == VOID:
                        continue
                    if v in (AIR, MC_WATER):
                        exposed = True
                    elif v != BEDROCK:
                        faces[v] += 1
                backing[(x, y, z)] = faces.most_common(1)[0][0] if faces else (CONCRETE if exposed else BEDROCK)
    for cell, block in backing.items():
        put(*cell, block)
        stats['void-backed' if block != BEDROCK else 'void-bedrock'] += 1
    for z in range(SZ):
        for x in range(SX):
            put(x, 0, z, BEDROCK)

    # Standing connectivity from the first spawn: one-voxel steps, swimming
    # through water. Landmarks snap to the nearest standing cell so a name never
    # points into a cubicle wall or onto a flume roof.
    fluid = (MC_WATER,)

    def passable(x, y, z):
        return get(x, y, z) in (AIR, MC_WATER, MC_PORTAL)

    def stand(x, y, z):
        return (1 <= y < SY - 2 and passable(x, y, z) and passable(x, y + 1, z)
                and (solid(x, y - 1, z) or get(x, y - 1, z) in fluid or get(x, y, z) in fluid))

    walkable = set()
    if spawns:
        start = (spawns[0][0], spawns[0][2] + 1, spawns[0][1])
        queue = [start]
        walkable.add(start)
        while queue:
            x, y, z = queue.pop()
            vertical = get(x, y, z) in fluid
            for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1), (0, 0)):
                for dy in (0, 1, -1):
                    if dx == 0 and dz == 0 and (dy == 0 or not vertical):
                        continue
                    n = (x + dx, y + dy, z + dz)
                    if not (1 <= n[0] < SX - 1 and 1 <= n[2] < SZ - 1) or n in walkable or not stand(*n):
                        continue
                    if dy == 1 and not passable(x, y + 2, z):
                        continue
                    walkable.add(n)
                    queue.append(n)

    # Portals: always-on trigger_teleport volumes and their destinations
    # (the traitor room's escape teleport; the soda machine trap starts disabled).
    portals = []
    destinations = {e['targetname']: e for e in bsp['entities']
                    if e.get('classname') in ('point_teleport', 'info_teleport_destination') and e.get('targetname')}
    for model, entity in sorted(by_model.items()):
        if entity.get('classname') != 'trigger_teleport' or entity.get('StartDisabled') == '1':
            continue
        target = destinations.get(entity.get('target', ''))
        if not target:
            continue
        origin = vec(entity.get('origin'))
        boxes = []
        for brush in bsp['model_brushes'](model):
            _, _, aabb, _ = brush_geometry(bsp['brush_sides'](brush), origin)
            if aabb:
                boxes.append(to_world_box(aabb))
        if not boxes:
            continue
        vol = [[min(b[i][0] for b in boxes), max(b[i][1] for b in boxes)] for i in range(3)]
        dest = list(world_point(*vec(target.get('origin'))))
        dest[1] = floor_below(dest[0], dest[1] + 0.01, dest[2]) + 1.02
        # Source drops arrivals onto the floor; land them on the nearest cell
        # a player can stand on and walk away from.
        cell = (int(dest[0]), int(dest[1]), int(dest[2]))
        if cell not in walkable:
            near = min(walkable, key=lambda c: (max(abs(c[0] - cell[0]), abs(c[2] - cell[2]), abs(c[1] - cell[1])), abs(c[1] - cell[1])))
            if max(abs(near[0] - cell[0]), abs(near[2] - cell[2]), abs(near[1] - cell[1])) <= 3:
                dest = [near[0] + 0.5, near[1] + 0.02, near[2] + 0.5]
                stats['portal-arrival-moved'] += 1
            else:
                stats['portal-arrival-unreachable'] += 1
        source_yaw = math.radians(vec(target.get('angles'))[1])
        yaw = math.atan2(-math.cos(source_yaw), math.sin(source_yaw))
        portals.append({
            'id': entity.get('targetname') or f'portal-{model}',
            'minX': round(vol[0][0], 3), 'maxX': round(vol[0][1], 3),
            'minY': round(vol[1][0], 3), 'maxY': round(vol[1][1], 3),
            'minZ': round(vol[2][0], 3), 'maxZ': round(vol[2][1], 3),
            'x': round(dest[0], 3), 'y': round(dest[1], 3), 'z': round(dest[2], 3), 'yaw': round(yaw, 4),
        })

    # Traitor tester: riding either flume through the ttt_logic_role trigger
    # volumes shows the verdict on the beam rig at the top of the tower.
    tester = []
    for model, entity in sorted(by_model.items()):
        if entity.get('classname') != 'trigger_multiple' or 'tttrolecheck' not in entity.get('OnTrigger', ''):
            continue
        boxes = []
        for brush in bsp['model_brushes'](model):
            _, _, aabb, _ = brush_geometry(bsp['brush_sides'](brush), vec(entity.get('origin')))
            if aabb:
                boxes.append(to_world_box(aabb))
        if boxes:
            vol = [[min(b[i][0] for b in boxes), max(b[i][1] for b in boxes)] for i in range(3)]
            tester.append({'minX': round(vol[0][0], 3), 'maxX': round(vol[0][1], 3), 'minY': round(vol[1][0], 3),
                           'maxY': round(vol[1][1], 3), 'minZ': round(vol[2][0], 3), 'maxZ': round(vol[2][1], 3)})
    beams = [world_point(*vec(e.get('origin'))) for e in bsp['entities']
             if e.get('classname') == 'info_target' and e.get('targetname', '').startswith('beam_target')]

    # Decoration props: physics props and static props as oriented boxes, doors
    # swung open against a wall. Every doorway is passable in the voxel grid.
    props = collections.defaultdict(list)

    def prop_box(kind, half, origin, yaw):
        wx, wy, wz = world_point(*origin)
        cell = (int(wx), int(wy + 0.5), int(wz))
        # Props outside the hull (the skybox dressing) or buried in a block
        # would never be seen; keep the list to the ones players walk past.
        if not inside(*cell) or get(*cell) not in (AIR, MC_WATER):
            stats['prop-skipped'] += 1
            return
        hx, hy, hz = [h / UNIT for h in half]
        props['boxes'].append([kind, round(wx, 3), round(wy, 3), round(wz, 3), round(hx, 3), round(hz, 3), round(hy, 3),
                               round(-math.radians(yaw), 4)])

    for entity in bsp['entities']:
        model = entity.get('model', '')
        cls = entity.get('classname')
        if cls in ('prop_physics', 'prop_dynamic') and model in PROP_KINDS:
            kind, half = PROP_KINDS[model]
            prop_box(kind, half, vec(entity.get('origin')), vec(entity.get('angles'))[1])
        elif cls == 'prop_door_rotating' and model in DOOR_MODELS:
            wx, wy, wz = world_point(*vec(entity.get('origin')))
            hy = int(wy + 0.01)
            options = []
            # The hinge sits on the frame, which may voxelise into the wall
            # cell itself; look for the leaf from the hinge cell or a neighbour.
            for near, (hx, hz) in enumerate([(int(wx), int(wz)), (int(wx) + 1, int(wz)), (int(wx) - 1, int(wz)),
                                             (int(wx), int(wz) + 1), (int(wx), int(wz) - 1)]):
                for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    cells = [(hx + dx * i, hy + j, hz + dz * i) for i in (0, 1) for j in (0, 1)]
                    if any(solid(*c) for c in cells):
                        continue
                    # Prefer a leaf lying flat against a wall, as an open door does.
                    against = sum(1 for c in cells if solid(c[0] + dz, c[1], c[2] + dx) or solid(c[0] - dz, c[1], c[2] - dx))
                    options.append((against, -near, hx, hz, dx, dz))
            if not options:
                stats['door-without-room'] += 1
                continue
            _, _, hx, hz, dx, dz = max(options)
            props['doors'].append([hx + 0.5 - dx * 0.5, round(hy + 0.02, 3), hz + 0.5 - dz * 0.5, dx, dz])
    for prop in bsp['static_props']:
        if prop['model'] in PROP_KINDS:
            kind, half = PROP_KINDS[prop['model']]
            prop_box(kind, half, prop['origin'], prop['yaw'])

    # Spawn pools. Every original spawn stands in the foyer: Trouble in
    # Terrorist Town keeps all of them; the six-voxel spread is the fallback
    # free-for-all pool when the generator finds nothing.
    spread = []
    for spawn in spawns:
        if all(math.hypot(s[0] - spawn[0], s[1] - spawn[1]) >= 6 for s in spread):
            spread.append(spawn)

    # Generated spawns for the free-for-all and team modes: standing cells
    # reachable from the foyer with a flat, dry 3 x 3 floor, air in the 3 x 3
    # body space two voxels high, a third voxel of head room, and no flume
    # bore within reach, thinned to an even lattice and spread by
    # farthest-point sampling (height counts three times so the mezzanine,
    # changing rooms and tower landings are chosen next to the decks).
    def spawn_cell(x, y, z):
        if (x + z) % 2 or not (8 <= x < SX - 8 and 8 <= z < SZ - 8):
            return False
        if get(x, y + 2, z) != AIR:
            return False
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                if not solid(x + dx, y - 1, z + dz) or get(x + dx, y - 1, z + dz) in fluid:
                    return False
                if get(x + dx, y, z + dz) != AIR or get(x + dx, y + 1, z + dz) != AIR:
                    return False
        for dx in range(-2, 3):
            for dz in range(-2, 3):
                for dy in range(-3, 4):
                    if (x + dx, y + dy, z + dz) in bore:
                        return False
        return True

    spawn_cells = sorted(c for c in walkable if spawn_cell(*c))

    def spawn_metric(a, b):
        return math.hypot(a[0] - b[0], a[2] - b[2], 3 * (a[1] - b[1]))

    def spread_points(cells, count, seeds):
        chosen = []
        while len(chosen) < count and cells:
            best = max(cells, key=lambda c: (min(spawn_metric(c, s) for s in seeds + chosen), -c[2], -c[0], -c[1]))
            if min(spawn_metric(best, s) for s in seeds + chosen) < SPAWN_GAP:
                break
            chosen.append(best)
        return chosen

    foyer_centre = (sum(s[0] for s in spawns) / len(spawns), spawns[0][2] + 1, sum(s[1] for s in spawns) / len(spawns))
    fun_cells = spread_points(spawn_cells, FUN_SPAWN_COUNT, [foyer_centre])
    # Alpha grows from the deepest point of the foyer, bravo from the far end of the hall.
    alpha_cells = spread_points([c for c in spawn_cells if c[2] >= ALPHA_MIN_Z], TEAM_SPAWN_COUNT, [(SX / 2, GROUND_LEVEL + 1, 0)])
    bravo_cells = spread_points([c for c in spawn_cells if c[2] <= BRAVO_MAX_Z], TEAM_SPAWN_COUNT, [foyer_centre])
    fun_spawns = [[x, z, y - 1] for (x, y, z) in fun_cells]
    alpha = [[x, z, y - 1] for (x, y, z) in alpha_cells]
    bravo = [[x, z, y - 1] for (x, y, z) in bravo_cells]
    team_gap = min(math.hypot(a[0] - b[0], a[1] - b[1]) for a in alpha for b in bravo)

    # Power-up pads: open floor under open sky (the foyer and the skylight),
    # far from spawns and from one another.
    floors = (POOL_TILE_WHITE, POOL_FLOOR, CONCRETE, METAL, PALE, POOL_TILE_BLUE)
    candidates = []
    for z in range(6, SZ - 6):
        for x in range(6, SX - 6):
            for y in range(2, SY - 3):
                if get(x, y - 1, z) not in floors or (x, y, z) not in reachable:
                    continue
                clear = all(get(x + dx, y - 1, z + dz) in floors and get(x + dx, y, z + dz) == AIR
                            and get(x + dx, y + 1, z + dz) == AIR for dx in (-1, 0, 1) for dz in (-1, 0, 1))
                open_sky = all(get(x, yy, z) == AIR for yy in range(y + 2, SY))
                if clear and open_sky and all(math.hypot(s[0] - x, s[1] - z) >= 13 for s in spawns):
                    candidates.append((x, y, z))
    powerups = []
    while candidates and len(powerups) < 4:
        best = max(candidates, key=lambda c: min([math.hypot(c[0] - p[0], c[2] - p[2]) for p in powerups] or [
            math.hypot(c[0] - SX / 2, c[2] - SZ / 2)]))
        powerups.append(best)
        candidates = [c for c in candidates if math.hypot(c[0] - best[0], c[2] - best[2]) >= 16]
    powerups = [[x, y - 1, z] for (x, y, z) in powerups]

    def landmark(id_, name, sx, sy, sz):
        wx, wy, wz = world_point(sx, sy, sz)
        x, z = int(wx), int(wz)
        floor = floor_below(wx, wy + 0.5, wz)
        best = None
        for (cx, cy, cz) in walkable:
            distance = max(abs(cx - x), abs(cz - z)) + abs(cy - 1 - floor) * 0.5
            if distance <= 6 and (best is None or distance < best[0]):
                best = (distance, cx, cy, cz)
        if best is None:
            stats['landmark-unreachable:' + id_] += 1
            return {'id': id_, 'name': name, 'x': x, 'z': z, 'floorY': floor}
        return {'id': id_, 'name': name, 'x': best[1], 'z': best[3], 'floorY': best[2] - 1}

    landmarks = [
        landmark('foyer', 'Entrance Foyer', -1150, -3580, DECK_Z),
        landmark('poolside', 'Poolside', 600, -2650, DECK_Z),
        landmark('wave-pool', 'Wave Pool', -2700, -400, DECK_Z),
        landmark('flume-tower', 'Flume Tower', -196, -1304, 400),
        landmark('traitor-room', 'Traitor Room', 2320, 401, -192),
        landmark('changing-rooms', 'Changing Rooms', -2800, -1155, DECK_Z),
    ]

    counts = collections.Counter(grid)
    runs = []
    cursor = 0
    total = len(grid)
    while cursor < total:
        value = grid[cursor]
        end = cursor
        while end < total and grid[end] == value and end - cursor < 65535:
            end += 1
        runs.append(struct.pack('<HB', end - cursor, value))
        cursor = end
    rle = base64.b64encode(b''.join(runs)).decode()

    anchors = {
        'groundLevel': GROUND_LEVEL,
        'waterLevel': int(-288 / UNIT - BASE_LAYER),
        'spawns': {'fun': fun_spawns or spread, 'alpha': alpha, 'bravo': bravo, 'ttt': spawns, 'all': spawns},
        'slides': slides,
        'landmarks': landmarks,
        'powerups': powerups,
        'portals': portals,
        'tester': {'volumes': tester, 'beams': [[round(v, 3) for v in b] for b in beams]},
        'props': {key: sorted(props[key]) for key in ('boxes', 'doors')},
    }
    header = (
        '// Generated by tools/compile-waterworld-reference.py from ttt_waterworld.bsp.\n'
        '// See docs/maps/waterworld.md. Coordinates are voxel units; one voxel is 32 Source units.\n'
    )
    body = (
        f"export const WATERWORLD_SOURCE_SHA256 = '{bsp['sha256']}';\n"
        f"export const WATERWORLD_DIMENSIONS = Object.freeze({{ sx: {SX}, sy: {SY}, sz: {SZ} }});\n"
        f"export const WATERWORLD_TRANSFORM = Object.freeze({{ unitsPerVoxel: {int(UNIT)}, sourceX0: {int(SOURCE_X0)}, "
        f"sourceY1: {int(SOURCE_Y1)}, baseLayer: {BASE_LAYER} }});\n"
        f"export const WATERWORLD_RLE = '{rle}';\n"
        f"export const WATERWORLD_ANCHORS = {json.dumps(anchors, separators=(',', ':'))};\n"
    )
    OUT.write_text(header + body)

    print(json.dumps({
        'sha256': bsp['sha256'],
        'runs': len(runs), 'bytes': OUT.stat().st_size,
        'blocks': {str(k): v for k, v in sorted(counts.items())},
        'reachable': len(reachable),
        'spawns': len(spawns), 'funSpawns': len(fun_spawns), 'alphaSpawns': len(alpha), 'bravoSpawns': len(bravo),
        'spawnCells': len(spawn_cells), 'teamGap': round(team_gap, 2),
        'spawnLevels': sorted({c[1] for c in fun_cells + alpha_cells + bravo_cells}),
        'slides': [{'id': s['id'], 'pushes': s['pushes'], 'waypoints': len(s['path']),
                    'mouth': s['path'][0], 'exit': s['path'][-1]} for s in slides],
        'portals': len(portals), 'tester': len(tester),
        'walkable': len(walkable),
        'testerWalkable': [any(t['minX'] - 1 <= x <= t['maxX'] and t['minY'] - 1 <= y <= t['maxY'] and t['minZ'] - 1 <= z <= t['maxZ']
                               for (x, y, z) in walkable) for t in tester],
        'props': {k: len(v) for k, v in anchors['props'].items()},
        'powerups': powerups, 'landmarks': landmarks,
        'notes': dict(stats),
    }, indent=1))


if __name__ == '__main__':
    main(sys.argv)
