#!/usr/bin/env python3
"""Compile ttt_minecraft_b5.bsp into the shared, authoritative voxel grid.

Usage: python3 tools/compile-minecraft-b5-reference.py path/to/ttt_minecraft_b5.bsp
Pure Python (no numpy). Source download/provenance is documented in
docs/maps/minecraft-b5.md. The BSP is an offline authoring input, never a
runtime dependency; the generated module is shared/world/minecraft-b5-data.js.

The map is built from 32-unit cube brushes, so one Source block is exactly one
voxel. The island, the Nether below it and the ocean around it are placed in a
128 x 96 x 88 world with a four-voxel sea margin on every side.
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
OUT = ROOT / 'shared' / 'world' / 'minecraft-b5-data.js'

UNIT = 32.0
SX, SY, SZ = 128, 88, 96
MARGIN_X, MARGIN_Z = 4, 4
SOURCE_X0 = -2688.0          # west edge of voxel column MARGIN_X
SOURCE_Y1 = 1344.0           # north edge of voxel row MARGIN_Z
BASE_LAYER = -42             # source layer stored at voxel y = 0
GROUND_LEVEL = -BASE_LAYER   # source z = 0 (island surface) -> voxel y
NETHER_TOP_LAYER = -25       # last Nether layer; solid bedrock above until the sea floor
SEA_FLOOR_LAYER = -10        # first ocean bedrock layer

# Block ids: must equal shared/world/blocks.js.
AIR = 0
BEDROCK = 29
B = dict(
    MC_GRASS=36, MC_DIRT=37, MC_STONE=38, MC_COBBLE=39, MC_MOSSY=40, MC_SAND=41,
    MC_GRAVEL=42, MC_CLAY=43, MC_LOG=44, MC_LEAVES=45, MC_PLANKS=46, MC_GLASS=47,
    MC_BRICK=48, MC_BOOKSHELF=49, MC_WOOL_WHITE=50, MC_WOOL_RED=51, MC_IRON=52,
    MC_GOLD=53, MC_DIAMOND=54, MC_DIAMOND_ORE=55, MC_COAL_ORE=56, MC_OBSIDIAN=57,
    MC_NETHERRACK=58, MC_GLOWSTONE=59, MC_CLOUD=60, MC_CACTUS=61, MC_CHEST=62,
    MC_FURNACE=63, MC_CRAFTING=64, MC_TNT=65, MC_WATER=66, MC_LAVA=67, MC_PORTAL=68,
    MC_GHOST_GRASS=69, MC_GHOST_PLANKS=70, MC_GHOST_STONE=71, MC_GHOST_WOOL_WHITE=72,
    MC_GHOST_GLOWSTONE=73, MC_GHOST_NETHERRACK=74, MC_GHOST_WOOL_RED=75, MC_GHOST_BOOKSHELF=76,
    MC_GHOST_DIRT=77, MC_GHOST_LOG=78,
)
GHOST_OF = {
    B['MC_GRASS']: B['MC_GHOST_GRASS'], B['MC_PLANKS']: B['MC_GHOST_PLANKS'],
    B['MC_STONE']: B['MC_GHOST_STONE'], B['MC_WOOL_WHITE']: B['MC_GHOST_WOOL_WHITE'],
    B['MC_GLOWSTONE']: B['MC_GHOST_GLOWSTONE'], B['MC_NETHERRACK']: B['MC_GHOST_NETHERRACK'],
    B['MC_WOOL_RED']: B['MC_GHOST_WOOL_RED'], B['MC_BOOKSHELF']: B['MC_GHOST_BOOKSHELF'],
    B['MC_DIRT']: B['MC_GHOST_DIRT'], B['MC_LOG']: B['MC_GHOST_LOG'],
}
# Source texture -> block id (specific names first; GRASS-TOP is a filler texture).
MATERIAL_BLOCKS = [
    ('CHEST', 'MC_CHEST'), ('FURNACE', 'MC_FURNACE'), ('CRAFT', 'MC_CRAFTING'), ('TNT', 'MC_TNT'),
    ('CACTUS', 'MC_CACTUS'), ('TREE', 'MC_LOG'), ('BOOKSHELF', 'MC_BOOKSHELF'),
    ('GLOWSTONE', 'MC_GLOWSTONE'), ('OBSIDIAN', 'MC_OBSIDIAN'), ('NETHERRACK', 'MC_NETHERRACK'),
    ('DIAMOND-BLOCK', 'MC_DIAMOND'), ('GOLD-BLOCK', 'MC_GOLD'), ('DIAMOND', 'MC_DIAMOND_ORE'),
    ('COAL', 'MC_COAL_ORE'), ('IRON', 'MC_IRON'), ('WOOLRED', 'MC_WOOL_RED'),
    ('WOOLWHITE', 'MC_WOOL_WHITE'), ('BRICK', 'MC_BRICK'), ('GLASS', 'MC_GLASS'),
    ('MOSSYCOBBLESTONE', 'MC_MOSSY'), ('COBBLESTONE', 'MC_COBBLE'), ('GRAVEL', 'MC_GRAVEL'),
    ('CLAY', 'MC_CLAY'), ('SAND', 'MC_SAND'), ('PLANKS', 'MC_PLANKS'), ('LEAVES', 'MC_LEAVES'),
    ('STONE', 'MC_STONE'), ('FARMLAND', 'MC_DIRT'), ('DIRT', 'MC_DIRT'), ('BEDROCK', 'BEDROCK'),
    ('CLOUD', 'MC_CLOUD'), ('END', 'MC_STONE'),
]
SIGN_TEXT = {
    'NETHER': 'NETHER', 'INCINERATOR': 'INCINERATOR', 'TNT': 'TNT', 'ROOM': 'T ROOM', 'DOOR': 'DOOR',
    'GOLD': 'GOLD', 'WIN': 'WIN', 'TEST': 'TRAITOR TESTER', 'UNLOCK': 'UNLOCK', 'COUNT': 'COUNT',
    'PIGMEN': 'PIGMEN', 'HINT': 'HINT', 'WEAPON': 'WEAPONS',
}

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

    entities = []
    for block in re.findall(r'\{(.*?)\}', lump(0).decode('latin1'), re.S):
        entities.append(dict(re.findall(r'"([^"]*)" "([^"]*)"', block)))
    return {
        'sha256': hashlib.sha256(data).hexdigest(),
        'entities': entities,
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
    """Half-spaces (world space), material counter, AABB and axis-alignment."""
    planes, mats = [], collections.Counter()
    aabb = [[None, None], [None, None], [None, None]]
    axis_aligned = True
    top_material = None
    for (nx, ny, nz, d), name, bevel in sides:
        if bevel:
            continue
        d += nx * origin[0] + ny * origin[1] + nz * origin[2]
        planes.append((nx, ny, nz, d))
        if name and not name.startswith('TOOLS/'):
            mats[name] += 1
            if nz > 0.9:
                top_material = name
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
    return planes, mats, aabb, axis_aligned, top_material


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
        [(sx0 - SOURCE_X0) / UNIT + MARGIN_X, (sx1 - SOURCE_X0) / UNIT + MARGIN_X],
        [sz0 / UNIT - BASE_LAYER, sz1 / UNIT - BASE_LAYER],
        [(SOURCE_Y1 - sy1) / UNIT + MARGIN_Z, (SOURCE_Y1 - sy0) / UNIT + MARGIN_Z],
    ]


def world_point(sx, sy, sz):
    return ((sx - SOURCE_X0) / UNIT + MARGIN_X, sz / UNIT - BASE_LAYER, (SOURCE_Y1 - sy) / UNIT + MARGIN_Z)


def source_point(wx, wy, wz):
    return ((wx - MARGIN_X) * UNIT + SOURCE_X0, SOURCE_Y1 - (wz - MARGIN_Z) * UNIT, (wy + BASE_LAYER) * UNIT)


def cells_covered(box, planes=None, axis_aligned=True, threshold=0.5, ignore_axis=None):
    """Voxel cells whose overlap with the brush reaches the volume threshold.

    ignore_axis picks the single cell containing the box centre on that axis,
    which is how thin wall slabs (fake walls, portals, lava films) snap.
    """
    ranges = []
    for axis in range(3):
        lo, hi = box[axis]
        if ignore_axis == axis:
            c = int(math.floor((lo + hi) / 2))
            ranges.append(range(c, c + 1))
        else:
            ranges.append(range(max(0, int(math.floor(lo))), min((SX, SY, SZ)[axis], int(math.ceil(hi)))))
    out = []
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
                    if frac + 1e-9 >= threshold:
                        out.append((x, y, z))
                else:
                    inside = 0
                    for ox in (0.125, 0.375, 0.625, 0.875):
                        for oy in (0.125, 0.375, 0.625, 0.875):
                            for oz in (0.125, 0.375, 0.625, 0.875):
                                sx, sy, sz = source_point(x + ox, y + oy, z + oz)
                                if all(a * sx + b * sy + c * sz <= d + 1e-4 for a, b, c, d in planes):
                                    inside += 1
                    if inside >= 64 * threshold:
                        out.append((x, y, z))
    return out


def MC_VOID_FILL(y):
    return B['MC_NETHERRACK'] if y <= NETHER_TOP_LAYER - BASE_LAYER else B['MC_STONE']


def material_block(mats, top_material):
    if any(n.startswith('MINECRAFT/GRASS-SIDE') for n in mats):
        return B['MC_GRASS']
    counted = collections.Counter({n: c for n, c in mats.items() if n != 'MINECRAFT/GRASS-TOP'})
    if not counted:
        return B['MC_GRASS'] if 'MINECRAFT/GRASS-TOP' in mats else None
    if len(counted) == 1 and 'MINECRAFT/DIRT' in counted and top_material == 'MINECRAFT/GRASS-TOP':
        return B['MC_GRASS']
    best = max(counted.values())
    for key, block in MATERIAL_BLOCKS:
        for name, count in counted.items():
            if count == best and name.startswith('MINECRAFT/' + key):
                return BEDROCK if block == 'BEDROCK' else B[block]
    return None


# ------------------------------------------------------------------- compiler

def main(argv):
    if len(argv) != 2:
        raise SystemExit(__doc__)
    bsp = read_bsp(Path(argv[1]))
    grid = bytearray(SX * SY * SZ)

    def idx(x, y, z):
        return (y * SZ + z) * SX + x

    def get(x, y, z):
        return grid[idx(x, y, z)] if 0 <= x < SX and 0 <= y < SY and 0 <= z < SZ else BEDROCK

    def put(x, y, z, value, only_air=False):
        if not (0 <= x < SX and 0 <= y < SY and 0 <= z < SZ):
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

    solids, overlays, ghosts, fluids = [], [], [], []
    props = collections.defaultdict(list)
    ladder_cells = []
    clip_cells = set()
    stats = collections.Counter()

    def facing(sides, key):
        """Game-space direction a textured face looks toward (x+/x-/z+/z-)."""
        for (nx, ny, nz, _), name, bevel in sides:
            if bevel or key not in name:
                continue
            if abs(nx) > 0.9:
                return 'x+' if nx > 0 else 'x-'
            if abs(ny) > 0.9:
                return 'z-' if ny > 0 else 'z+'
        return None

    def classify(sides, entity):
        origin = vec(entity.get('origin')) if entity else (0.0, 0.0, 0.0)
        planes, mats, aabb, axis_aligned, top_material = brush_geometry(sides, origin)
        if aabb is None or not mats:
            return
        names = set(mats)
        cls = entity.get('classname', 'worldspawn') if entity else 'worldspawn'
        if aabb[2][0] >= 2000:
            return  # END-stone win room and stored trap physboxes above the sky
        size = [aabb[i][1] - aabb[i][0] for i in range(3)]
        # Source axes are x, y(north), z(up); voxel boxes are x, y(up), z(south).
        thin_axis = (0, 2, 1)[min(range(3), key=lambda i: size[i])] if min(size) < 16 else None
        box = to_world_box(aabb)
        centre = world_point(*[(aabb[i][0] + aabb[i][1]) / 2 for i in range(3)])
        if any('TORCH' in n for n in names):
            props['torches'].append([round(centre[0], 3), round(box[1][0], 3), round(centre[2], 3)])
            return
        if any('ROSE' in n for n in names):
            kind = 1 if any('YELLOW' in n for n in names) else 0
            props['roses'].append([int(centre[0]), int(box[1][0] + 0.01), int(centre[2]), kind])
            return
        if any('LADDER' in n for n in names):
            look = facing(sides, 'LADDER')
            for (x, y, z) in cells_covered(box, planes, axis_aligned, 0.25, thin_axis):
                ladder_cells.append((x, y, z, thin_axis, look))
            return
        if any('TRACK' in n for n in names):
            cells = cells_covered(box, planes, axis_aligned, 0.3, ignore_axis=1)
            straight = [n for n in names if 'TRACK_S' in n]
            orientation = 2 if not straight else (0 if size[0] >= size[1] else 1)
            for (x, y, z) in cells:
                props['rails'].append([x, int(box[1][0] + 0.01), z, orientation])
            return
        sign = next((n for n in names if 'SIGN-' in n), None)
        if sign:
            key = sign.split('SIGN-')[1]
            if key.isdigit() or key not in SIGN_TEXT or (entity and entity.get('StartDisabled') == '1'):
                return
            face = facing(sides, 'SIGN-')
            if face is None:
                return
            props['signs'].append([round(centre[0], 3), round(centre[1], 3), round(centre[2], 3), face, SIGN_TEXT[key]])
            return
        if any('PORTAL' in n for n in names):
            fluids.append((cells_covered(box, planes, axis_aligned, 0.5, thin_axis), B['MC_PORTAL']))
            return
        if any('TRAP_LAVA' in n for n in names):
            if entity and entity.get('StartDisabled') == '1':
                return
            fluids.append((cells_covered(box, planes, axis_aligned, 0.5, thin_axis), B['MC_LAVA']))
            return
        if any('WATER' in n for n in names):
            if cls == 'func_water_analog':
                return  # traitor flood trap, hidden until triggered
            fluids.append((cells_covered(box, planes, axis_aligned, 0.5), B['MC_WATER']))
            return
        block = material_block(mats, top_material)
        if block is None:
            stats['unmapped:' + ','.join(sorted(names))] += 1
            return
        if cls in ('trigger_multiple', 'trigger_push', 'trigger_hurt', 'trigger_teleport', 'trigger_once',
                   'trigger_gravity', 'ttt_traitor_check', 'func_button', 'func_movelinear', 'func_wall',
                   'func_clip_vphysics'):
            return
        if entity and entity.get('StartDisabled') == '1':
            return
        if block == B['MC_CLOUD']:
            cy = int(math.floor((box[1][0] + box[1][1]) / 2))
            overlays.append(([(x, cy, z) for (x, y, z) in cells_covered(
                [box[0], [cy, cy + 1], box[2]], planes, True, 0.5)], block))
            return
        if cls == 'func_illusionary' or (cls == 'func_brush' and entity and entity.get('Solidity') == '1'):
            ghost = GHOST_OF.get(block)
            if ghost is None:
                stats['ghost-skipped:' + str(block)] += 1
                return
            if thin_axis is not None:
                others = [size[i] for i in range(3) if i != thin_axis]
                if min(others) < 28:
                    return  # fence posts, pressure plates and other sub-voxel decoration
                ghosts.append((cells_covered(box, planes, axis_aligned, 0.5, thin_axis), ghost))
            else:
                ghosts.append((cells_covered(box, planes, axis_aligned, 0.5), ghost))
            return
        if cls == 'func_physbox' and min(size) < 24:
            return
        if thin_axis is not None:
            others = [size[i] for i in range(3) if i != thin_axis]
            if min(others) < 28:
                stats['thin-skipped'] += 1
                return
            stats['thin-wall'] += 1
            solids.append((cells_covered(box, planes, axis_aligned, 0.5, thin_axis), block))
            return
        solids.append((cells_covered(box, planes, axis_aligned, 0.5), block))

    door_entities = []
    for model in range(bsp['models']):
        entity = by_model.get(model) if model else None
        if model and entity is None:
            continue
        sides_list = [bsp['brush_sides'](brush) for brush in bsp['model_brushes'](model)]
        cls = entity.get('classname') if entity else 'worldspawn'
        names = {name for sides in sides_list for _, name, _ in sides}
        if cls in ('func_physbox', 'func_tanktrain') and any('CART' in n for n in names):
            origin = vec(entity.get('origin'))
            boxes = [to_world_box(brush_geometry(sides, origin)[2]) for sides in sides_list]
            centre = world_point(*origin)
            props['carts'].append([round(centre[0], 3), round(min(b[1][0] for b in boxes), 3), round(centre[2], 3)])
            continue
        if cls == 'func_door_rotating':
            if any('HATCH' in n for n in names) or not any('DOOR' in n for n in names):
                continue
            origin = vec(entity.get('origin'))
            boxes = [to_world_box(brush_geometry(sides, origin)[2]) for sides in sides_list]
            union = [[min(b[i][0] for b in boxes), max(b[i][1] for b in boxes)] for i in range(3)]
            door_entities.append({'box': union, 'hinge': world_point(*origin),
                                  'kind': 1 if any('DOOR-IRON' in n for n in names) else 0})
            continue
        for sides in sides_list:
            classify(sides, entity)

    for cells, block in solids:
        for (x, y, z) in cells:
            put(x, y, z, block)
    for cells, block in overlays:
        for (x, y, z) in cells:
            put(x, y, z, block, only_air=True)
    solid_of_ghost = {ghost: solid for solid, ghost in GHOST_OF.items()}
    for cells, block in ghosts:
        for (x, y, z) in cells:
            # A player clip over a fake block means the original was walkable.
            put(x, y, z, solid_of_ghost[block] if (x, y, z) in clip_cells else block, only_air=True)
    stats['clip-cells-without-block'] = sum(1 for c in clip_cells if get(*c) == AIR)
    for cells, block in fluids:
        for (x, y, z) in cells:
            put(x, y, z, block, only_air=True)

    # Unbreakable foundation: the void between the Nether ceiling and the sea
    # floor, the world floor, and everything outside the Nether shell.
    nether_top = NETHER_TOP_LAYER - BASE_LAYER
    sea_floor = SEA_FLOOR_LAYER - BASE_LAYER
    for y in range(nether_top + 1, sea_floor):
        for z in range(SZ):
            for x in range(SX):
                put(x, y, z, BEDROCK)
    for z in range(SZ):
        for x in range(SX):
            put(x, 0, z, BEDROCK)
    queue = []
    seen = set()
    for y in range(1, nether_top + 1):
        for z in range(SZ):
            for x in range(SX):
                if (x in (0, SX - 1) or z in (0, SZ - 1)) and get(x, y, z) == AIR:
                    queue.append((x, y, z))
                    seen.add((x, y, z))
    while queue:
        x, y, z = queue.pop()
        put(x, y, z, BEDROCK)
        for dx, dy, dz in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
            n = (x + dx, y + dy, z + dz)
            if 1 <= n[1] <= nether_top and n not in seen and get(*n) == AIR:
                seen.add(n)
                queue.append(n)

    solid_types = set(B.values()) - {B['MC_WATER'], B['MC_LAVA'], B['MC_PORTAL']} - set(GHOST_OF.values())
    solid_types.add(BEDROCK)

    def solid(x, y, z):
        return get(x, y, z) in solid_types

    # Spawns: info_player_start feet positions become [x, z, floorY] anchors.
    # The floor is the first solid voxel under the feet (two lighthouse spawns
    # and one stream spawn stand on illusionary or fluid volumes in Source).
    # Fluid contact is resolved after the void fill below, once every block is final.
    spawns = []
    for entity in bsp['entities']:
        if entity.get('classname') != 'info_player_start':
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

    # Source leaves the inside of hollow terrain as void; the compiled BSP marks
    # that void solid. Cells whose centre sits in a solid leaf become stone (or
    # netherrack below), so mining a hill never opens onto an empty shell.
    CONTENTS_SOLID = 0x1
    for y in range(1, SY):
        for z in range(SZ):
            for x in range(SX):
                v = get(x, y, z)
                if v != AIR and v != B['MC_WATER']:
                    continue
                if bsp['leaf_contents'](*source_point(x + 0.5, y + 0.5, z + 0.5)) & CONTENTS_SOLID:
                    put(x, y, z, MC_VOID_FILL(y))
                    stats['bsp-void-filled'] += 1

    # The island shell is open to the sea along its shores, so the space under
    # it is real (players can wade in from the beach). Anything still
    # unreachable from the sky, a spawn or a portal arrival is sealed
    # decoration space and is filled the same way.
    reachable = set()
    queue = [(x, SY - 1, z) for z in range(SZ) for x in range(SX) if not solid(x, SY - 1, z)]
    queue += [(sx, sy + 1, sz) for (sx, sz, sy) in spawns]
    for entity in bsp['entities']:
        if entity.get('classname') in ('point_teleport', 'info_teleport_destination'):
            wx, wy, wz = world_point(*vec(entity.get('origin')))
            queue.append((int(wx), int(wy + 0.01), int(wz)))
    queue = [c for c in queue if 0 <= c[0] < SX and 0 <= c[1] < SY and 0 <= c[2] < SZ and not solid(*c)]
    reachable.update(queue)
    while queue:
        x, y, z = queue.pop()
        for dx, dy, dz in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
            n = (x + dx, y + dy, z + dz)
            if 0 <= n[0] < SX and 0 <= n[1] < SY and 0 <= n[2] < SZ and n not in reachable and not solid(*n):
                reachable.add(n)
                queue.append(n)
    for y in range(1, SY):
        for z in range(SZ):
            for x in range(SX):
                v = get(x, y, z)
                if (v == AIR or v == B['MC_WATER']) and (x, y, z) not in reachable:
                    put(x, y, z, MC_VOID_FILL(y))
                    stats['void-filled'] += 1

    # A spawn never touches fluid: its feet, body and floor cells plus the eight
    # horizontal neighbours at feet and floor level stay clear of water and lava,
    # so the spawn push can never drop a fresh body into the lava sea. Source
    # authored two such spawns (one wading in the village stream, one on the
    # lava shore of the Nether); each moves to the nearest safe standing cell.
    # server/sim/spawn.js applies the same rule at runtime as a guard.
    fluid_types = {B['MC_WATER'], B['MC_LAVA']}
    ring8 = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)]

    def spawn_safe(x, z, floor):
        feet = floor + 1
        if not (0 < x < SX - 1 and 0 < z < SZ - 1 and 1 <= floor < SY - 3):
            return False
        if not solid(x, floor, z) or solid(x, feet, z) or solid(x, feet + 1, z) or (x, feet, z) not in reachable:
            return False
        cells = [(x, feet, z), (x, feet + 1, z), (x, floor, z)]
        cells += [(x + dx, y, z + dz) for dx, dz in ring8 for y in (feet, floor)]
        return not any(get(*c) in fluid_types for c in cells)

    for spawn in spawns:
        x, z, floor = spawn
        if spawn_safe(x, z, floor):
            continue
        best = None
        for dx in range(-4, 5):
            for dz in range(-4, 5):
                for dy in (0, 1, -1):
                    if dx == 0 and dz == 0 and dy == 0:
                        continue
                    if not spawn_safe(x + dx, z + dz, floor + dy):
                        continue
                    rank = (dx * dx + dz * dz, abs(dy), dz, dx)
                    if best is None or rank < best[0]:
                        best = (rank, [x + dx, z + dz, floor + dy])
        if best is None:
            stats['spawn-fluid-kept'] += 1
            continue
        stats['spawn-fluid-moved'] += 1
        spawn[:] = best[1]

    # Ladders: the climb volume is the air voxel holding the rung slab; the wall
    # face is whichever neighbour along the slab's thin axis is solid.
    ladders = {}
    opposite = {'x+': 'x-', 'x-': 'x+', 'z+': 'z-', 'z-': 'z+'}
    neighbour = {'x-': (-1, 0), 'x+': (1, 0), 'z-': (0, -1), 'z+': (0, 1)}
    for (x, y, z, axis, look) in ladder_cells:
        if solid(x, y, z) and look:
            # A rung slab flush with the wall face belongs to the open cell it looks into.
            x, z = x + neighbour[look][0], z + neighbour[look][1]
        if solid(x, y, z):
            stats['ladder-in-wall'] += 1
            continue
        face = None
        candidates = [opposite[look]] if look else []
        candidates += ['x-', 'x+'] if axis == 0 else ['z-', 'z+'] if axis == 2 else []
        for option in candidates:
            dx, dz = neighbour[option]
            if solid(x + dx, y, z + dz):
                face = option
                break
        if face is None:
            stats['ladder-unattached'] += 1
            continue
        ladders.setdefault((x, z, face), set()).add(y)
    ladder_volumes = []
    for (x, z, face), ys in sorted(ladders.items()):
        ys = sorted(ys)
        start = ys[0]
        for i in range(1, len(ys) + 1):
            if i == len(ys) or ys[i] != ys[i - 1] + 1:
                ladder_volumes.append({'minX': x, 'maxX': x + 1, 'minY': start, 'maxY': ys[i - 1] + 1.15,
                                       'minZ': z, 'maxZ': z + 1, 'face': face})
                if i < len(ys):
                    start = ys[i]

    def floor_below(wx, wy, wz):
        x, z = int(wx), int(wz)
        y = int(wy)
        while y > 1 and not solid(x, y - 1, z):
            y -= 1
        return y - 1

    # Doors: draw the panel swung 90 degrees into whichever side is open.
    doors = []
    for door in door_entities:
        (x0, x1), (y0, y1), (z0, z1) = door['box']
        hx, _, hz = door['hinge']
        along_x = (x1 - x0) >= (z1 - z0)
        length = (x1 - x0) if along_x else (z1 - z0)
        thick = (z1 - z0) if along_x else (x1 - x0)
        far = (x1 if abs(x1 - hx) > abs(x0 - hx) else x0) if along_x else (z1 if abs(z1 - hz) > abs(z0 - hz) else z0)
        options = []
        for sign in (1, -1):
            if along_x:
                zz = [min(hz, hz + sign * length), max(hz, hz + sign * length)]
                opened = [[hx - thick / 2, hx + thick / 2], [y0, y1], zz]
            else:
                xx = [min(hx, hx + sign * length), max(hx, hx + sign * length)]
                opened = [xx, [y0, y1], [hz - thick / 2, hz + thick / 2]]
            cells = cells_covered(opened, None, True, 0.05)
            if all(not solid(*c) for c in cells):
                options.append(opened)
        if not options:
            stats['door-kept-closed'] += 1
            options.append(door['box'])
        b = options[0]
        doors.append([round(v, 3) for v in (b[0][0], b[1][0], b[2][0], b[0][1], b[1][1], b[2][1])] + [door['kind']])
    props['doors'] = doors

    # Portals: always-on trigger_teleport volumes and their destinations.
    portals = []
    destinations = {e['targetname']: e for e in bsp['entities'] if e.get('classname') in ('point_teleport', 'info_teleport_destination') and e.get('targetname')}
    for model, entity in sorted(by_model.items()):
        if entity.get('classname') != 'trigger_teleport' or entity.get('StartDisabled') == '1':
            continue
        target = destinations.get(entity.get('target', ''))
        if not target:
            continue
        origin = vec(entity.get('origin'))
        boxes = []
        for brush in bsp['model_brushes'](model):
            _, _, aabb, _, _ = brush_geometry(bsp['brush_sides'](brush), origin)
            if aabb:
                boxes.append(to_world_box(aabb))
        if not boxes:
            continue
        volume = [[min(b[i][0] for b in boxes), max(b[i][1] for b in boxes)] for i in range(3)]
        dest = list(world_point(*vec(target.get('origin'))))
        # Source drops arrivals onto the floor; land them there directly so
        # prediction and authority agree from the first tick.
        dest[1] = floor_below(dest[0], dest[1] + 0.01, dest[2]) + 1.02
        source_yaw = math.radians(vec(target.get('angles'))[1])
        yaw = math.atan2(-math.cos(source_yaw), math.sin(source_yaw))
        portals.append({
            'id': entity.get('targetname') or f'portal-{model}',
            'minX': round(volume[0][0], 3), 'maxX': round(volume[0][1], 3),
            'minY': round(volume[1][0], 3), 'maxY': round(volume[1][1], 3),
            'minZ': round(volume[2][0], 3), 'maxZ': round(volume[2][1], 3),
            'x': round(dest[0], 3), 'y': round(dest[1], 3), 'z': round(dest[2], 3), 'yaw': round(yaw, 4),
        })

    surface = sorted((s for s in spawns if s[2] >= sea_floor), key=lambda s: (s[0], s[1]))
    alpha = surface[:8]
    bravo = surface[-8:]
    # Free-for-all uses a spread subset (14 voxels apart within each dimension)
    # so the shared power-up and Chaos cash rules keep exposed pads away from
    # every spawn; the full original list stays available as spawns.all.
    spread = []
    for spawn in spawns:
        same = [s for s in spread if (s[2] >= sea_floor) == (spawn[2] >= sea_floor)]
        if all(math.hypot(s[0] - spawn[0], s[1] - spawn[1]) >= 14 for s in same):
            spread.append(spawn)

    # Power-up pads: exposed grass, far from spawns and from one another.
    candidates = []
    for z in range(6, SZ - 6):
        for x in range(6, SX - 6):
            for y in range(sea_floor + 4, GROUND_LEVEL + 20):
                floors = (B['MC_GRASS'], B['MC_SAND'], B['MC_DIRT'], B['MC_STONE'], B['MC_COBBLE'], B['MC_PLANKS'])
                if get(x, y - 1, z) not in floors or (x, y, z) not in reachable:
                    continue
                clear = all(get(x + dx, y - 1, z + dz) in floors and get(x + dx, y, z + dz) == AIR
                            and get(x + dx, y + 1, z + dz) == AIR for dx in (-1, 0, 1) for dz in (-1, 0, 1))
                # The runtime pad rules need open sky (no cloud or canopy) above the pad.
                open_sky = all(get(x, yy, z) == AIR for yy in range(y + 2, SY))
                if clear and open_sky and all(math.hypot(s[0] - x, s[1] - z) >= 13 for s in spawns):
                    candidates.append((x, y, z))
    powerups = []
    while candidates and len(powerups) < 4:
        best = max(candidates, key=lambda c: min([math.hypot(c[0] - p[0], c[2] - p[2]) for p in powerups] or [
            math.hypot(c[0] - SX / 2, c[2] - SZ / 2)]))
        powerups.append(best)
        candidates = [c for c in candidates if math.hypot(c[0] - best[0], c[2] - best[2]) >= 16]
    # Pads are stored as [x, floorY, z] like every other map's anchors.
    powerups = [[x, y - 1, z] for (x, y, z) in powerups]

    # Landmarks at authored places: lighthouse foot, surface portal, Nether arrival.
    def surface_floor(wx, wz):
        """Highest walkable floor in a column, ignoring clouds and tree canopies."""
        x, z = int(wx), int(wz)
        for y in range(SY - 1, 1, -1):
            v = get(x, y, z)
            if v in (B['MC_CLOUD'], B['MC_LEAVES']) or not solid(x, y, z):
                continue
            return y
        return 1

    lighthouse = world_point(-1904, 592, 0)
    portal = next((p for p in portals if p['id'] == 'Portal_Nether'), None)
    landmarks = [
        {'id': 'lighthouse', 'name': 'Lighthouse', 'x': int(lighthouse[0]), 'z': int(lighthouse[2]) + 8,
         'floorY': surface_floor(lighthouse[0], lighthouse[2] + 8)},
    ]
    if portal:
        px, pz = int((portal['minX'] + portal['maxX']) / 2), int(portal['maxZ']) + 1
        landmarks.append({'id': 'nether-portal', 'name': 'Nether Portal', 'x': px, 'z': pz,
                          'floorY': floor_below(px, portal['minY'] + 1, pz)})
        landmarks.append({'id': 'nether', 'name': 'The Nether', 'x': int(portal['x']), 'z': int(portal['z']),
                          'floorY': floor_below(portal['x'], portal['y'] + 0.5, portal['z'])})

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
        'seaLevel': SEA_FLOOR_LAYER - BASE_LAYER + 5,
        'spawns': {'fun': spread, 'alpha': alpha, 'bravo': bravo, 'all': spawns},
        'landmarks': landmarks,
        'powerups': powerups,
        'ladders': ladder_volumes,
        'portals': portals,
        'props': {key: sorted({tuple(p) for p in props[key]}) for key in ('torches', 'roses', 'rails', 'carts', 'doors', 'signs')},
    }
    header = (
        '// Generated by tools/compile-minecraft-b5-reference.py from ttt_minecraft_b5.bsp.\n'
        '// See docs/maps/minecraft-b5.md. Coordinates are voxel units; one Source block is one voxel.\n'
    )
    body = (
        f"export const MINECRAFT_B5_SOURCE_SHA256 = '{bsp['sha256']}';\n"
        f"export const MINECRAFT_B5_DIMENSIONS = Object.freeze({{ sx: {SX}, sy: {SY}, sz: {SZ} }});\n"
        "export const MINECRAFT_B5_TRANSFORM = Object.freeze({ unitsPerVoxel: 32, sourceX0: -2688, sourceY1: 1344, "
        f"baseLayer: {BASE_LAYER}, marginX: {MARGIN_X}, marginZ: {MARGIN_Z} }});\n"
        f"export const MINECRAFT_B5_RLE = '{rle}';\n"
        f"export const MINECRAFT_B5_ANCHORS = {json.dumps(anchors, separators=(',', ':'))};\n"
    )
    OUT.write_text(header + body)

    print(json.dumps({
        'sha256': bsp['sha256'],
        'runs': len(runs), 'bytes': OUT.stat().st_size,
        'blocks': {str(k): v for k, v in sorted(counts.items())},
        'spawns': len(spawns), 'funSpawns': len(spread), 'ladders': len(ladder_volumes), 'portals': len(portals),
        'props': {k: len(v) for k, v in anchors['props'].items()},
        'clipCells': len(clip_cells),
        'powerups': powerups, 'landmarks': landmarks,
        'notes': dict(stats),
    }, indent=1))


if __name__ == '__main__':
    main(sys.argv)
