"""Reference voxel model of the Bikini Bottom BUILD SPEC (map-spec.md).

Collision-relevant geometry of every region, used to verify the spec:
region ownership / overlap, anchor clearance, power-up exposure, signs,
TTT buttons, S&D sites, bot-roam reachability (standHeights [13,17]) and
to print the ASCII top-down map. Not the game code: it mirrors the spec.
"""
import math, sys
from collections import deque
import numpy as np

SX, SY, SZ, T = 128, 40, 96, 14
AIR = 'AIR'
MATS = ['AIR', 'STONE', 'CONCRETE', 'METAL', 'BEDROCK', 'BB_SAND', 'BB_CORAL', 'BB_PINEAPPLE', 'BB_PINE_LEAF',
        'BB_KELP', 'BB_MOAI', 'BB_ROCK', 'BB_HULL', 'BB_CHUM', 'BB_ROAD', 'GLASS', 'PLANK', 'WOOD', 'LEAVES',
        'GRASS', 'PALE', 'RUST', 'ACCENT', 'ROOF', 'TEAL_SIDING', 'BUS_YELLOW', 'TRUCK_RED', 'DUST_WOOD',
        'DUST_CRATE', 'POOL_TILE_WHITE', 'POOL_TILE_BLUE', 'MC_IRON', 'MC_CHEST', 'MC_WATER', 'MC_MOSSY',
        'SLIDE_BLUE', 'SLIDE_YELLOW', 'ASPHALT']
MID = {m: i for i, m in enumerate(MATS)}
W = np.zeros((SX, SY, SZ), dtype=np.int16)
OWN = np.zeros((SX, SY, SZ), dtype=np.int8)
REG = {0: 'base', 1: 'core', 2: 'R1-north', 3: 'R2-krab', 4: 'R3-school', 5: 'R4-chum', 6: 'R5-south'}
RECTS = {2: (15, 112, 14, 27), 3: (15, 49, 34, 61), 4: (50, 77, 34, 61), 5: (78, 112, 34, 61), 6: (15, 112, 68, 81)}
problems = []
cur = [0]
FLUME_CELLS = set()


def region_of(x, z):
    for r, (x0, x1, z0, z1) in RECTS.items():
        if x0 <= x <= x1 and z0 <= z <= z1:
            return r
    return 1


def put(x, y, z, m):
    if not (0 <= x < SX and 0 <= y < SY and 0 <= z < SZ):
        return
    r = cur[0]
    if r >= 2 and y > T:
        home = region_of(x, z)
        if home != r and not (r == 4 and (x, z) in FLUME_CELLS):
            problems.append(f'{REG[r]} writes outside its rect at ({x},{y},{z}) -> {REG[home]}')
    if y > T and OWN[x, y, z] not in (0, r) and OWN[x, y, z] != 0:
        problems.append(f'overlap {REG[OWN[x,y,z]]} vs {REG[r]} at ({x},{y},{z})')
    W[x, y, z] = MID[m]
    OWN[x, y, z] = r


def get(x, y, z):
    if y < 0: return 'BEDROCK'
    if y >= SY: return AIR
    if not (0 <= x < SX and 0 <= z < SZ): return 'METAL'
    return MATS[W[x, y, z]]


def box(x0, y0, z0, x1, y1, z1, m):
    for x in range(min(x0, x1), max(x0, x1) + 1):
        for y in range(min(y0, y1), max(y0, y1) + 1):
            for z in range(min(z0, z1), max(z0, z1) + 1):
                put(x, y, z, m)


def tbox(x0, h0, z0, x1, h1, z1, m):  # heights relative to T
    box(x0, T + h0, z0, x1, T + h1, z1, m)


def paint(x0, z0, x1, z1, m, y=T):
    box(x0, y, z0, x1, y, z1, m)


def P(x, z):
    return 127 - x, 95 - z


def mbox(x0, h0, z0, x1, h1, z1, m):
    tbox(x0, h0, z0, x1, h1, z1, m)
    a, b = P(x0, z0); c, d = P(x1, z1)
    tbox(a, h0, b, c, h1, d, m)


def hash01(x, y, z, salt=20260922):
    h = (salt ^ ((x + 1013) * 0x27d4eb2f) ^ ((y + 7919) * 0x9e3779b1) ^ ((z + 31337) * 0x85ebca6b)) & 0xffffffff
    h = ((h ^ (h >> 15)) * 0x2c1b3c6d) & 0xffffffff
    h = ((h ^ (h >> 12)) * 0x297a2d39) & 0xffffffff
    h ^= h >> 15
    return (h & 0xffffffff) / 4294967296


# ---------------------------------------------------------------- CORE
def core():
    cur[0] = 0
    for x in range(SX):
        for z in range(SZ):
            for y in range(0, T + 1):
                W[x, y, z] = MID['CONCRETE' if y == T else 'STONE']
            e = min(x, z, SX - 1 - x, SZ - 1 - z)
            if e < 3:
                top = SY - 1 if e == 0 else SY - 8
                for y in range(T, top + 1):
                    W[x, y, z] = MID['METAL']
    cur[0] = 1
    # reef boundary dressing on the inner shell faces (x=2,125 / z=2,93), y15..32
    def face(x, z, along):
        for y in range(T + 1, SY - 7):
            rise = y - T
            m = 'BB_ROCK' if rise <= 4 + round(2 * math.sin(along * 0.23)) else 'BB_CORAL' if rise in (7, 8, 13) else 'BB_ROCK'
            if along % 9 == 4 and rise <= 10: m = 'BB_KELP'
            if rise == 1: m = 'PALE'
            put(x, y, z, m)
    for x in range(2, SX - 2):
        face(x, 2, x); face(x, SZ - 3, x)
    for z in range(3, SZ - 3):
        face(2, z, z); face(SX - 3, z, z)
    paint(3, 3, 124, 92, 'BB_SAND')
    paint(3, 28, 124, 33, 'BB_ROAD'); paint(3, 62, 124, 67, 'BB_ROAD')
    for x in range(3, 125):
        if x % 8 < 4:
            put(x, T, 31, 'PALE'); put(x, T, 64, 'PALE')
    # outer-lane blockers (west authored, P twins east)
    for x in range(10, 15):
        for z in range(18, 23):
            if (x % 2 == 0 and z % 4 == 0) or (x % 2 == 1 and z % 4 == 2):
                tbox(x, 1, z, x, 8, z, 'BB_KELP')
                a, b = P(x, z); tbox(a, 1, b, a, 8, b, 'BB_KELP')
    mbox(3, 1, 29, 4, 3, 33, 'BB_ROCK'); mbox(5, 1, 29, 6, 2, 33, 'BB_ROCK'); mbox(7, 1, 29, 8, 1, 33, 'BB_ROCK')
    mbox(5, 1, 48, 9, 1, 51, 'PALE'); mbox(5, 2, 48, 5, 6, 51, 'BB_CORAL'); mbox(6, 5, 48, 6, 6, 51, 'BB_CORAL')
    mbox(7, 2, 49, 7, 2, 50, 'PALE')
    mbox(9, 1, 62, 14, 1, 67, 'BB_HULL'); mbox(10, 2, 64, 13, 2, 65, 'BB_HULL')
    mbox(3, 1, 74, 7, 1, 78, 'BB_CORAL')
    for x in range(3, 8):
        for z in range(74, 79):
            if (x + z) % 3 == 0:
                tbox(x, 2, z, x, 5, z, 'BB_CORAL'); a, b = P(x, z); tbox(a, 2, b, a, 5, b, 'BB_CORAL')
    # conch sculptures: N1 x60-62 z28-31, N2 x65-67 z30-33, twins S1/S2
    for (x0, z0, x1, z1) in [(60, 28, 62, 31), (65, 30, 67, 33)]:
        for (a0, b0, a1, b1) in [(x0, z0, x1, z1), (127 - x1, 95 - z1, 127 - x0, 95 - z0)]:
            tbox(a0, 1, b0, a1, 4, b1, 'PALE'); tbox(a0, 2, b0, a1, 2, b1, 'BB_CORAL')
            tbox(a0 + 1, 5, b0 + 1, a1, 6, b1 - 1, 'PALE'); tbox(a0 + 1, 7, b0 + 1, a0 + 1, 7, b0 + 1, 'BB_CORAL')
    # spawn-strip tide rocks (1-high)
    for x0 in (12, 27, 41, 58, 68, 85, 99):
        tbox(x0, 1, 7, x0 + 1, 4, 9, 'BB_CORAL'); tbox(x0, 4, 7, x0 + 1, 4, 9, 'PALE')
        a, _ = P(x0 + 1, 0); tbox(a, 1, 86, a + 1, 4, 88, 'BB_CORAL'); tbox(a, 4, 86, a + 1, 4, 88, 'PALE')
    for x0 in (26, 44, 80, 98):
        tbox(x0, 1, 12, x0 + 3, 1, 12, 'BB_ROCK'); tbox(x0, 1, 83, x0 + 3, 1, 83, 'BB_ROCK')


# ---------------------------------------------------------------- R1 NORTH
def north():
    cur[0] = 2
    # kelp grove stalks (P images of the field coral trees)
    for (x, z) in [(29, 16), (24, 16), (19, 16), (17, 19), (19, 23)]:
        h = 7 + int(hash01(x, 1, z) * 5)
        tbox(x, 1, z, x, h, z, 'BB_KELP')
        tbox(x + 1, 5, z, x + 1, 5, z, 'BB_KELP'); tbox(x, h - 2, z - 1, x, h - 2, z - 1, 'BB_KELP')
    tbox(18, 1, 24, 18, 1, 26, 'BB_ROCK'); tbox(17, 1, 24, 17, 2, 26, 'BB_ROCK'); tbox(16, 1, 24, 16, 3, 26, 'BB_ROCK')
    # pineapple, centre (40,21)
    R = {1: 5.5, 2: 6.0, 10: 6.2, 11: 5.8, 12: 5.2, 13: 4.4, 14: 3.4, 15: 2.2}
    cx, cz = 40, 21
    for h in range(1, 16):
        r = R.get(h, 6.5)
        for x in range(33, 48):
            for z in range(14, 29):
                d = math.hypot(x - cx, z - cz)
                if h <= 10:
                    if r - 1.2 < d <= r: tbox(x, h, z, x, h, z, 'BB_PINEAPPLE')
                    elif h == 4 and d <= r - 1.2: tbox(x, h, z, x, h, z, 'PLANK')
                elif d <= r:
                    tbox(x, h, z, x, h, z, 'BB_PINEAPPLE')
    tbox(43, 4, 20, 44, 4, 22, AIR)  # stair hole
    tbox(43, 1, 22, 44, 1, 22, 'PLANK'); tbox(43, 1, 21, 44, 2, 21, 'PLANK'); tbox(43, 1, 20, 44, 3, 20, 'PLANK')
    for zr in ((14, 17), (25, 27)):
        for x in range(39, 42):
            for z in range(zr[0], zr[1] + 1):
                tbox(x, 1, z, x, 3, z, AIR)
                if get(x, T + 4, z) == 'BB_PINEAPPLE': tbox(x, 4, z, x, 4, z, 'WOOD')
    for (x0, x1, z0, z1) in [(39, 41, 25, 27), (34, 35, 20, 22), (45, 46, 20, 22)]:
        for x in range(x0, x1 + 1):
            for z in range(z0, z1 + 1):
                for h in (6, 7):
                    if get(x, T + h, z) == 'BB_PINEAPPLE': tbox(x, h, z, x, h, z, 'GLASS')
    for x in range(34, 47):
        for z in (20, 21):
            for h in (2, 3):
                if x in (34, 46) and get(x, T + h, z) == 'BB_PINEAPPLE': tbox(x, h, z, x, h, z, 'GLASS')
    tbox(39, 16, 20, 41, 17, 22, 'BB_PINE_LEAF'); tbox(40, 16, 21, 40, 23, 21, 'BB_PINE_LEAF')
    for dx, dz in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
        for k, h in enumerate([16, 17, 18, 18, 17], 1):
            tbox(cx + dx * k, h, cz + dz * k, cx + dx * k, h, cz + dz * k, 'BB_PINE_LEAF')
    for dx, dz in [(1, 1), (1, -1), (-1, 1), (-1, -1)]:
        for k, h in enumerate([16, 17, 17, 16], 1):
            tbox(cx + dx * k, h, cz + dz * k, cx + dx * k, h, cz + dz * k, 'BB_PINE_LEAF')
    tbox(36, 1, 18, 37, 2, 18, 'PALE'); tbox(36, 1, 24, 36, 2, 24, 'BB_CORAL'); tbox(42, 1, 17, 43, 1, 17, 'RUST')
    tbox(37, 5, 18, 39, 5, 20, 'BB_HULL'); tbox(43, 5, 24, 43, 5, 24, 'POOL_TILE_BLUE')
    tbox(44, 1, 27, 44, 4, 27, 'WOOD'); tbox(44, 5, 27, 44, 5, 27, 'BB_HULL')  # mailbox
    tbox(49, 1, 26, 53, 1, 26, 'BB_CORAL'); tbox(74, 1, 26, 78, 1, 26, 'BB_CORAL')  # yard hedges
    # moai house (solid)
    tbox(59, 1, 14, 68, 12, 24, 'BB_MOAI'); tbox(60, 13, 16, 67, 16, 23, 'BB_MOAI')
    tbox(60, 10, 25, 67, 11, 25, 'BB_MOAI'); tbox(61, 4, 25, 66, 4, 25, 'BB_MOAI')
    tbox(63, 5, 25, 64, 9, 26, 'BB_MOAI')
    tbox(58, 6, 19, 58, 10, 21, 'BB_MOAI'); tbox(69, 6, 19, 69, 10, 21, 'BB_MOAI')
    tbox(60, 7, 24, 61, 8, 24, 'GLASS'); tbox(66, 7, 24, 67, 8, 24, 'GLASS')
    tbox(63, 1, 24, 64, 3, 24, 'DUST_WOOD')
    tbox(61, 1, 25, 61, 2, 25, 'BB_CORAL'); tbox(66, 1, 25, 66, 2, 25, 'BB_CORAL')
    # rock home, centre (88,21)
    for x in range(81, 96):
        for z in range(14, 29):
            d = math.hypot(x - 88, z - 21)
            h = 4 if d < 1.5 else 3 if d < 3 else 2 if d < 4.5 else 1 if d < 6.3 else 0
            if h: tbox(x, 1, z, x, h, z, 'BB_ROCK')
            if math.hypot(x - 88, z - 19) < 3.5:
                box(x, 21 if z >= 19 else 22, z, x, 21 if z >= 19 else 22, z, 'BB_ROCK')
    box(89, 19, 22, 89, 20, 22, 'WOOD'); box(88, 22, 19, 88, 25, 19, 'WOOD'); box(88, 26, 19, 88, 26, 19, 'ACCENT')
    tbox(86, 1, 27, 86, 4, 27, 'WOOD'); tbox(86, 5, 27, 86, 5, 27, 'BB_HULL')
    # anchor yard
    tbox(98, 1, 17, 108, 2, 18, 'RUST'); tbox(96, 1, 14, 97, 1, 21, 'RUST')
    tbox(96, 2, 14, 97, 2, 15, 'RUST'); tbox(96, 2, 20, 97, 2, 21, 'RUST')
    tbox(106, 1, 14, 107, 1, 16, 'DUST_WOOD'); tbox(106, 1, 19, 107, 1, 21, 'DUST_WOOD')
    tbox(109, 1, 16, 111, 1, 19, 'RUST'); tbox(110, 1, 17, 110, 1, 18, AIR)
    tbox(109, 1, 23, 111, 2, 25, 'RUST'); tbox(108, 1, 24, 108, 1, 24, 'WOOD')


# ---------------------------------------------------------------- R2 KRUSTY KRAB
def krab():
    cur[0] = 3
    for x in range(15, 37):
        for z in range(37, 59):
            if x in (15, 36) or z in (37, 58):
                tbox(x, 1, z, x, 3, z, 'BB_HULL'); tbox(x, 4, z, x, 4, z, 'WOOD')
                along = z if x in (15, 36) else x
                for h in range(5, 10):
                    m = 'WOOD' if along % 3 == 0 else 'PLANK' if h in (5, 7, 9) else 'GLASS'
                    tbox(x, h, z, x, h, z, m)
    tbox(22, 5, 58, 28, 7, 58, 'PLANK')                       # sign backing
    tbox(24, 1, 58, 27, 3, 58, AIR); tbox(23, 1, 58, 23, 3, 58, 'TRUCK_RED'); tbox(28, 1, 58, 28, 3, 58, 'TRUCK_RED')
    tbox(18, 1, 37, 20, 3, 37, AIR); tbox(36, 1, 46, 36, 3, 49, AIR)
    for z0 in (42, 47, 52):
        tbox(15, 1, z0 - 1, 15, 4, z0 + 2, 'PALE'); tbox(15, 2, z0, 15, 3, z0 + 1, 'GLASS')
    tbox(36, 2, 52, 36, 3, 53, 'GLASS')
    for z in range(36, 60):
        zd = abs(z - 47.5)
        y = 24 + min(3, (12 - int(zd * 2) // 2) // 3 if False else math.floor((12 - zd) / 3))
        for x in range(15, 38):
            if zd < 5 and z % 2 == 1:
                continue
            put(x, y, z, 'PLANK' if zd < 5 else 'ROOF')
        for x in (15, 36):
            if 37 <= z <= 58:
                for yy in range(24, y): put(x, yy, z, 'PLANK')
    box(15, 28, 47, 37, 28, 48, 'WOOD')
    box(31, 24, 38, 32, 33, 39, 'RUST'); box(31, 34, 38, 32, 34, 39, 'ACCENT')
    box(25, 29, 47, 25, 36, 47, 'WOOD'); box(26, 33, 47, 29, 35, 47, 'TRUCK_RED'); box(27, 34, 47, 28, 34, 47, 'PALE')
    paint(16, 38, 35, 57, 'PLANK')
    tbox(16, 1, 38, 35, 1, 40, 'PLANK')
    tbox(24, 2, 38, 27, 2, 38, 'RUST'); tbox(29, 2, 38, 30, 2, 38, 'RUST'); tbox(33, 2, 38, 34, 3, 38, 'MC_IRON')
    tbox(16, 1, 41, 35, 1, 41, 'BB_HULL'); tbox(16, 2, 41, 35, 2, 41, 'PLANK')
    tbox(22, 1, 41, 23, 2, 41, AIR); tbox(30, 1, 41, 31, 2, 41, AIR)
    tbox(26, 1, 42, 29, 1, 43, 'BB_HULL'); tbox(27, 2, 42, 27, 2, 42, 'ACCENT')
    for (x, z) in [(21, 45), (21, 50), (29, 47)]:
        tbox(x, 1, z, x + 1, 1, z + 1, 'PLANK')
    tbox(25, 1, 49, 26, 2, 50, 'BB_HULL'); tbox(25, 3, 49, 26, 4, 50, 'GLASS')
    tbox(32, 1, 44, 33, 2, 45, 'WOOD'); tbox(34, 1, 44, 34, 1, 44, 'WOOD')
    tbox(22, 1, 54, 22, 4, 57, 'BB_HULL'); tbox(22, 1, 55, 22, 3, 56, AIR); tbox(17, 1, 57, 19, 1, 57, 'PLANK')
    tbox(29, 1, 55, 29, 1, 55, 'WOOD'); tbox(32, 1, 55, 32, 1, 55, 'WOOD')
    # outside
    tbox(28, 1, 34, 30, 2, 35, 'RUST'); tbox(31, 1, 34, 31, 1, 35, 'RUST')
    tbox(16, 1, 35, 16, 4, 35, 'WOOD'); tbox(35, 1, 35, 35, 4, 35, 'WOOD')
    tbox(30, 1, 60, 32, 1, 61, 'PLANK')
    tbox(16, 1, 59, 16, 2, 60, 'DUST_CRATE'); tbox(17, 1, 59, 17, 1, 60, 'DUST_CRATE')
    tbox(35, 1, 60, 35, 5, 60, 'RUST'); tbox(34, 1, 60, 36, 1, 60, 'RUST')
    # A lot
    tbox(40, 1, 41, 44, 1, 43, 'TRUCK_RED'); tbox(41, 2, 42, 43, 2, 42, 'GLASS'); tbox(40, 2, 42, 40, 2, 42, 'TRUCK_RED')
    tbox(44, 1, 50, 46, 1, 54, 'BUS_YELLOW'); tbox(45, 2, 51, 45, 2, 53, 'GLASS'); tbox(45, 2, 54, 45, 2, 54, 'BUS_YELLOW')
    tbox(39, 1, 55, 41, 1, 57, 'BB_CORAL'); tbox(40, 2, 56, 40, 6, 56, 'BB_KELP')
    tbox(47, 1, 37, 49, 4, 38, 'DUST_CRATE'); tbox(47, 4, 37, 49, 4, 38, 'WOOD')


# ---------------------------------------------------------------- R3 SCHOOL + FLUME
FLUME_PATH = [(56.5, 20.1, 55.5), (56.5, 20.0, 58.5), (53.5, 19.8, 62.5), (50.5, 19.6, 66.5),
              (49.0, 19.4, 71.0), (47.5, 19.3, 74.5), (44.5, 19.2, 75.5)]


def flume_cells():
    floor, wall = set(), set()
    for (ax, ay, az), (bx, by, bz) in zip(FLUME_PATH, FLUME_PATH[1:]):
        L = math.hypot(bx - ax, bz - az); hx, hz = (bx - ax) / L, (bz - az) / L; px, pz = -hz, hx
        n = int(L / 0.2) + 1
        for i in range(n + 1):
            t = i / n; cx, cz = ax + (bx - ax) * t, az + (bz - az) * t
            for off in [o / 4 for o in range(-6, 7)]:
                floor.add((math.floor(cx + px * off), math.floor(cz + pz * off)))
            for off in (-2.2, -2.0, 2.0, 2.2):
                wall.add((math.floor(cx + px * off), math.floor(cz + pz * off)))
    wall -= floor
    return floor, wall


def school():
    cur[0] = 4
    for x in range(54, 74):
        for z in range(39, 57):
            per = x in (54, 73) or z in (39, 56)
            if per:
                tbox(x, 1, z, x, 1, z, 'BB_HULL'); tbox(x, 2, z, x, 2, z, 'PALE'); tbox(x, 3, z, x, 3, z, 'TEAL_SIDING')
            tbox(x, 4, z, x, 4, z, 'BB_HULL' if per else 'PLANK')
            if per: tbox(x, 5, z, x, 5, z, 'PALE')
    for (x, z) in [(54, 39), (73, 39), (54, 56), (73, 56)]:
        tbox(x, 1, z, x, 5, z, AIR)
    tbox(54, 5, 51, 54, 5, 54, AIR); tbox(73, 5, 41, 73, 5, 44, AIR)
    tbox(61, 5, 39, 66, 5, 39, AIR); tbox(61, 5, 56, 66, 5, 56, AIR); tbox(55, 5, 56, 57, 5, 56, AIR)
    tbox(54, 1, 43, 54, 3, 45, AIR); tbox(73, 1, 50, 73, 3, 52, AIR)
    tbox(55, 1, 39, 57, 3, 39, AIR); tbox(70, 1, 56, 72, 3, 56, AIR)
    for x in (60, 64, 68): tbox(x, 2, 39, x, 2, 39, 'GLASS')
    for x in (59, 63, 67): tbox(x, 2, 56, x, 2, 56, 'GLASS')
    tbox(54, 2, 47, 54, 3, 50, 'ASPHALT')
    tbox(62, 1, 46, 65, 1, 49, 'BB_HULL'); tbox(62, 2, 46, 65, 2, 49, 'PLANK')
    tbox(59, 1, 44, 59, 3, 44, 'PALE'); tbox(68, 1, 51, 68, 3, 51, 'PALE')
    for (x0, z) in [(57, 42), (57, 50), (67, 45), (67, 53)]:
        tbox(x0, 1, z, x0 + 3, 1, z, 'PLANK')
    # wheelhouse
    tbox(61, 5, 45, 66, 9, 50, 'PALE'); tbox(62, 5, 46, 65, 9, 49, AIR)
    for x in range(62, 66):
        for z in (45, 50): tbox(x, 6, z, x, 6, z, 'GLASS')
    for z in range(46, 50):
        for x in (61, 66): tbox(x, 6, z, x, 6, z, 'GLASS')
    tbox(61, 5, 46, 61, 7, 47, AIR); tbox(66, 5, 48, 66, 7, 49, AIR)
    tbox(61, 10, 45, 66, 10, 50, 'BB_HULL'); tbox(63, 11, 47, 64, 12, 48, 'GLASS'); tbox(63, 13, 47, 64, 13, 48, 'ACCENT')
    # stairs
    for i, x in enumerate(range(50, 54)): tbox(x, 1, 51, x, i + 1, 54, 'PALE')
    for i, x in enumerate(range(77, 73, -1)): tbox(x, 1, 41, x, i + 1, 44, 'PALE')
    # boat-bus
    tbox(58, 1, 35, 58, 1, 37, 'PALE'); tbox(59, 1, 34, 60, 2, 38, 'BUS_YELLOW')
    tbox(61, 1, 34, 68, 1, 38, 'BUS_YELLOW'); tbox(61, 2, 34, 68, 3, 38, 'POOL_TILE_BLUE')
    for x in (62, 64, 66):
        for z in (34, 38): tbox(x, 2, z, x, 2, z, 'GLASS')
    for x in (61, 68):
        for z in (34, 38): tbox(x, 1, z, x, 1, z, 'BB_ROCK')
    tbox(56, 1, 36, 56, 5, 36, 'WOOD')
    # shake shack (P twin of the bus)
    tbox(69, 1, 58, 69, 1, 60, 'PALE'); tbox(67, 1, 57, 68, 2, 61, 'BB_CORAL'); tbox(59, 1, 57, 66, 3, 61, 'BB_CORAL')
    tbox(60, 2, 61, 65, 2, 61, 'GLASS')
    for x in range(59, 67, 2): tbox(x, 3, 57, x, 3, 61, 'PALE')
    # flume
    floor, wall = flume_cells()
    for (x, z) in wall:
        if z >= 57: box(x, 19, z, x, 19, z, 'SLIDE_BLUE')
    for (x, z) in floor:
        if z >= 57: box(x, 18, z, x, 18, z, 'SLIDE_YELLOW')
    for (x, z) in [(55, 60), (50, 68), (47, 75)]:
        box(x, 15, z, x, 17, z, 'BB_CORAL')


# ---------------------------------------------------------------- R4 CHUM BUCKET
def ang(x, z):
    return math.degrees(math.atan2(z - 47.5, x - 101.5)) % 360


def chum():
    cur[0] = 5
    tbox(91, 1, 37, 112, 3, 58, 'BB_CHUM')
    paint(96, 42, 107, 53, 'POOL_TILE_WHITE', y=T + 3)
    for x in range(90, 114):
        for z in range(36, 60):
            d = math.hypot(x - 101.5, z - 47.5)
            if 9 <= d < 10:
                a = ang(x, z)
                for h in range(4, 13):
                    if h <= 6 and (abs(a - 180) < 13 or abs(a - 45) < 12): continue
                    tbox(x, h, z, x, h, z, 'RUST' if h in (6, 11) else 'BB_CHUM')
            if 9.5 <= d < 11:
                tbox(x, 13, z, x, 13, z, 'RUST')
    tbox(96, 4, 38, 107, 11, 39, 'BB_CHUM'); tbox(100, 4, 38, 103, 6, 39, AIR)
    for z in range(46, 50):
        if get(111, T + 5, z) == 'BB_CHUM': tbox(111, 5, z, 111, 6, z, 'GLASS')
    for x in range(90, 114):
        for y in range(27, 39):
            if abs(math.hypot(x - 101.5, y - 27) - 10.5) < 0.6:
                box(x, y, 47, x, y, 48, 'RUST')
    tbox(100, 4, 46, 103, 6, 49, 'RUST')
    for (x, z) in [(100, 46), (103, 46), (100, 49), (103, 49)]: tbox(x, 4, z, x, 6, z, AIR)
    tbox(101, 6, 47, 102, 6, 48, 'TRUCK_RED')
    tbox(104, 4, 43, 106, 6, 43, 'BB_CHUM'); tbox(105, 5, 43, 105, 6, 43, 'GLASS'); tbox(104, 4, 44, 106, 4, 44, 'PALE')
    for (x, z) in [(97, 44), (98, 44), (106, 51)]: tbox(x, 4, z, x, 4, z, 'RUST')
    tbox(96, 4, 50, 97, 5, 51, 'RUST'); tbox(98, 4, 51, 98, 4, 51, 'RUST')
    tbox(99, 4, 52, 99, 5, 52, 'GLASS'); tbox(104, 4, 42, 104, 5, 42, 'GLASS')
    # stairs
    for i, x in enumerate(range(85, 91)): tbox(x, 1, 45, x, 1 + i // 2, 50, 'BB_CHUM')
    for i, z in enumerate(range(34, 37)): tbox(100, 1, z, 103, 1 + i, z, 'BB_CHUM')
    for i, z in enumerate(range(61, 58, -1)): tbox(107, 1, z, 109, 1 + i, z, 'BB_CHUM')
    tbox(95, 1, 34, 97, 1, 35, 'PLANK')
    tbox(97, 1, 60, 99, 2, 61, 'RUST'); tbox(96, 1, 60, 96, 1, 61, 'RUST')
    # chum lab under the deck
    tbox(104, 1, 51, 110, 2, 56, AIR); tbox(111, 1, 52, 112, 2, 53, AIR)
    tbox(105, 3, 52, 105, 3, 52, 'GLASS')
    tbox(109, 1, 55, 110, 2, 56, 'MC_IRON')
    # B lot (P images of the A lot)
    tbox(83, 1, 52, 87, 1, 54, 'TEAL_SIDING'); tbox(84, 2, 53, 86, 2, 53, 'GLASS'); tbox(87, 2, 53, 87, 2, 53, 'TEAL_SIDING')
    tbox(81, 1, 41, 83, 1, 45, 'POOL_TILE_BLUE'); tbox(82, 2, 42, 82, 2, 44, 'GLASS'); tbox(82, 2, 41, 82, 2, 41, 'POOL_TILE_BLUE')
    tbox(86, 1, 38, 88, 1, 40, 'BB_CORAL'); tbox(87, 2, 39, 87, 6, 39, 'BB_KELP')
    tbox(78, 1, 57, 80, 4, 58, 'RUST'); tbox(78, 4, 57, 80, 4, 58, 'TRUCK_RED')


# ---------------------------------------------------------------- R5 SOUTH
def south():
    cur[0] = 6
    # wreck cove (P image of the anchor yard heightfield)
    tbox(19, 1, 77, 29, 2, 78, 'BB_HULL'); tbox(30, 1, 74, 31, 1, 81, 'WOOD')
    tbox(30, 2, 74, 31, 2, 75, 'WOOD'); tbox(30, 2, 80, 31, 2, 81, 'WOOD')
    tbox(20, 1, 74, 21, 1, 76, 'WOOD'); tbox(20, 1, 79, 21, 1, 81, 'WOOD')
    tbox(16, 1, 76, 18, 1, 79, 'DUST_WOOD'); tbox(17, 1, 77, 17, 1, 78, AIR)
    tbox(16, 1, 70, 18, 2, 72, 'DUST_CRATE'); tbox(19, 1, 71, 19, 1, 71, 'WOOD'); tbox(17, 2, 71, 17, 2, 71, 'MC_CHEST')
    tbox(24, 1, 78, 24, 6, 78, 'WOOD')
    for z in (79, 80):
        for h in range(3, 7):
            if (h + z) % 3: tbox(24, h, z, 24, h, z, 'PALE')
    # goo lagoon
    for x in range(30, 50):
        for z in range(68, 83):
            e = ((x - 39) / 5) ** 2 + ((z - 75) / 4) ** 2
            if e <= 1:
                box(x, 12, z, x, 12, z, 'BB_SAND'); box(x, 13, z, x, 14, z, 'MC_WATER')
    tbox(37, 1, 68, 39, 3, 70, 'PLANK'); tbox(37, 2, 68, 39, 2, 70, 'TEAL_SIDING'); tbox(37, 4, 68, 39, 4, 70, 'PLANK')
    tbox(37, 5, 69, 37, 5, 70, 'PALE'); tbox(38, 5, 70, 39, 5, 70, 'PALE'); tbox(37, 5, 68, 37, 6, 68, 'WOOD')
    tbox(42, 1, 68, 42, 1, 69, 'PLANK'); tbox(41, 1, 68, 41, 2, 69, 'PLANK'); tbox(40, 1, 68, 40, 3, 69, 'PLANK')
    for (x, z) in [(34, 71), (43, 80)]:
        tbox(x, 1, z, x, 4, z, 'WOOD')
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                tbox(x + dx, 5, z + dz, x + dx, 5, z + dz, 'BB_CORAL' if (dx + dz) % 2 else 'PALE')
    tbox(50, 1, 77, 52, 1, 79, 'BB_SAND')
    for (x, z) in [(50, 77), (52, 77), (50, 79), (52, 79)]: tbox(x, 2, z, x, 2, z, 'BB_SAND')
    # coral pinnacle (P twin of the moai)
    tbox(59, 1, 71, 68, 8, 81, 'BB_CORAL')
    for (lx, lz, r, top) in [(61, 73, 3.2, 14), (66, 77, 3.2, 17), (63, 76, 2.2, 12), (66, 72, 2.2, 11)]:
        for x in range(59, 69):
            for z in range(71, 81):
                if math.hypot(x - lx, z - lz) <= r: tbox(x, 9, z, x, top, z, 'BB_CORAL')
    tbox(57, 9, 74, 58, 11, 76, 'BB_CORAL'); tbox(69, 12, 74, 70, 14, 76, 'BB_CORAL')
    tbox(63, 5, 69, 64, 9, 70, 'BB_CORAL')
    # treedome, centre (87, 74.5)
    cx, cz = 87, 74.5
    for x in range(79, 96):
        for z in range(67, 83):
            d = math.hypot(x - cx, z - cz)
            if 6.3 <= d < 7.3:
                tbox(x, 1, z, x, 3, z, 'PALE'); tbox(x, 4, z, x, 4, z, 'ACCENT')
            for y in range(T + 5, SY):
                if d >= 7.3: break
                r = math.sqrt(d * d + (y - (T + 4)) ** 2)
                if abs(r - 7) < 0.6:
                    a = math.degrees(math.atan2(z - cz, x - cx)) % 45
                    box(x, y, z, x, y, z, 'PALE' if (a < 5 or a > 40) else 'GLASS')
            if d < 6.3: paint(x, z, x, z, 'GRASS')
    tbox(86, 1, 68, 88, 3, 68, AIR); tbox(86, 1, 81, 88, 3, 81, AIR)
    tbox(86, 1, 74, 87, 9, 75, 'WOOD')
    for x in range(82, 92):
        for z in range(70, 80):
            for y in (21, 22, 23):
                rr = 3.5 * math.sqrt(max(0, 1 - ((y - 22) / 1.5) ** 2))
                if math.hypot(x + 0.5 - 87, z + 0.5 - 75) <= rr and get(x, y, z) == AIR:
                    box(x, y, z, x, y, z, 'LEAVES')
    for x in range(85, 90):
        for z in range(72, 78):
            if get(x, T + 4, z) == AIR: tbox(x, 4, z, x, 4, z, 'PLANK')
            if (x in (85, 89) or z in (72, 77)) and not (x == 85 and z in (73, 74)):
                tbox(x, 5, z, x, 5, z, 'PLANK')
    tbox(82, 1, 73, 82, 1, 74, 'PLANK'); tbox(83, 1, 73, 83, 2, 74, 'PLANK'); tbox(84, 1, 73, 84, 3, 74, 'PLANK')
    tbox(90, 1, 76, 91, 1, 77, 'PLANK'); tbox(82, 1, 78, 82, 5, 78, 'WOOD')
    # jellyfish fields
    paint(95, 68, 112, 81, 'GRASS')
    for (x, z) in [(98, 79), (103, 79), (108, 79), (110, 76), (108, 72)]:
        tbox(x, 1, z, x, 4, z, 'BB_CORAL')
        for dx in range(-2, 3):
            for dz in range(-2, 3):
                if dx * dx + dz * dz <= 5: tbox(x + dx, 5, z + dz, x + dx, 5, z + dz, 'BB_PINE_LEAF')
                if dx * dx + dz * dz <= 1: tbox(x + dx, 6, z + dz, x + dx, 6, z + dz, 'BB_CORAL')
    tbox(109, 1, 69, 109, 1, 71, 'BB_ROCK'); tbox(110, 1, 69, 110, 2, 71, 'BB_ROCK'); tbox(111, 1, 69, 111, 3, 71, 'BB_ROCK')


# ---------------------------------------------------------------- metadata
FUN = [[8, 8], [64, 8], [119, 87], [63, 87], [10, 41], [117, 54], [26, 22], [101, 73], [102, 24], [25, 71], [45, 47], [82, 48]]
ALPHA = [[18, 87], [36, 87], [54, 87], [73, 87], [91, 87], [109, 87]]
BRAVO = [[18, 8], [36, 8], [54, 8], [73, 8], [91, 8], [109, 8]]
ATK = [[20, 87], [34, 87], [48, 87], [79, 87], [93, 87], [107, 87]]
DEF = [[24, 24], [50, 22], [56, 12], [71, 12], [79, 21], [101, 22]]
POWER = [[45, 14, 31], [82, 14, 64], [82, 14, 31], [45, 14, 64], [57, 18, 42], [70, 18, 53]]
SITES = [('A', 20, 31, 42, 53, T + 1.02), ('B', 96, 107, 42, 53, T + 4.02)]
SIGNS = [('THE KRUSTY KRAB', 25.5, 20.5, 59, 5.6, 1.6, '+z'), ('CHUM BUCKET', 101.5, 23, 38, 7, 1.6, '-z'),
         ('BOATING SCHOOL', 63.5, 22.5, 51, 5, 1.2, '+z'), ('GOO LAGOON', 38.5, 16.5, 68, 2.6, 1.0, '-z')]
TRAPS = [('grill-flare', (21, 16, 38, 'z-'), [(23.5, 15.05, 44.5), (27.5, 15.05, 47.5), (24.5, 15.05, 51.5)]),
         ('high-tide', (36, 15, 69, 'x+'), None), ('jelly-sting', (95, 15, 74, 'x-'), None)]
LANDMARKS = [('conch', 64, 31, 0), ('pineapple', 40, 21, 0), ('moai', 64, 27, 0), ('rock', 88, 23, 3), ('kelp', 22, 20, 0),
             ('anchors', 103, 21, 0), ('krab', 25, 47, 0), ('school', 57, 48, 4), ('chum', 98, 47, 3),
             ('lagoon', 46, 80, 0), ('pinnacle', 64, 68, 0), ('treedome', 84, 77, 0), ('fields', 103, 75, 0), ('wreck', 25, 74, 0)]
STAND = (T - 1, T + 3)


def solid(m):
    return m not in (AIR, 'MC_WATER')


def height_at(x, z):
    col = W[x, :, z]
    nz = np.nonzero(col)[0]
    return int(nz[-1]) if len(nz) else -1


def main():
    global FLUME_CELLS
    fl, wl = flume_cells()
    FLUME_CELLS = {c for c in fl | wl} | {(55, 60), (50, 68), (47, 75)}
    core(); north(); krab(); school(); chum(); south()
    rep = []
    # anchors
    allsolid_prop = lambda x, z: any(solid(get(x, y, z)) for y in range(T + 1, SY))
    for name, pool in [('fun', FUN), ('alpha', ALPHA), ('bravo', BRAVO), ('atk', ATK), ('def', DEF)]:
        for ax, az in pool:
            h = height_at(ax, az)
            if h != T or get(ax, T + 1, az) != AIR or get(ax, T + 2, az) != AIR:
                rep.append(f'ANCHOR {name} {ax},{az} not open ground (h={h})')
            near = [(x, z) for x in range(ax - 2, ax + 3) for z in range(az - 2, az + 3) if allsolid_prop(x, z)]
            if near: rep.append(f'ANCHOR {name} {ax},{az} has props within Chebyshev 2: {near[:4]}')
    fs = {tuple(a) for a in FUN}
    for a in FUN:
        if P(*a) not in fs: rep.append(f'fun anchor {a} has no P twin')
    for pool, other in [(ALPHA, BRAVO)]:
        if {P(*a) for a in pool} != {tuple(b) for b in other}: rep.append('tdm pools not P twins')
    # powerups
    spawns = [(x + .5, z + .5) for x, z in FUN + ALPHA + BRAVO]
    for (x, fy, z) in POWER:
        ok = all(solid(get(x + dx, fy, z + dz)) and get(x + dx, fy + 1, z + dz) == AIR and get(x + dx, fy + 2, z + dz) == AIR
                 for dx in (-1, 0, 1) for dz in (-1, 0, 1))
        sky = all(get(x, y, z) == AIR for y in range(fy + 3, SY))
        md = min(math.hypot(x + .5 - sx, z + .5 - sz) for sx, sz in spawns)
        open_dirs = 0
        for k in range(16):
            a = k * math.pi / 8; clear = True; dist = 1
            while dist <= 12:
                if get(math.floor(x + .5 + math.cos(a) * dist), fy + 2, math.floor(z + .5 + math.sin(a) * dist)) != AIR:
                    clear = False; break
                dist += .5
            open_dirs += clear
        rep.append(f'POWERUP {x},{fy},{z}: pad={ok} sky={sky} minSpawn={md:.1f} openDirs={open_dirs}')
    # signs
    for (title, sx, sy, sz, w, hgt, face) in SIGNS:
        out = 1 if face == '+z' else -1
        bad = []
        dx = -w / 2 + .01
        cells = set()
        while dx <= w / 2:
            dy = -hgt / 2 + .01
            while dy <= hgt / 2:
                cells.add((math.floor(sx + dx), math.floor(sy + dy), math.floor(sz - out * .01))); dy += .25
            dx += .25
        for (bx, by, bz) in cells:
            if get(bx, by, bz) in (AIR, 'GLASS'): bad.append(('back', bx, by, bz, get(bx, by, bz)))
            if get(bx, by, bz + out) != AIR: bad.append(('front', bx, by, bz + out, get(bx, by, bz + out)))
        xs = sorted({c[0] for c in cells}); ys = sorted({c[1] for c in cells})
        rep.append(f'SIGN {title}: backing x{xs[0]}-{xs[-1]} y{ys[0]}-{ys[-1]} z{next(iter(cells))[2]} -> {"OK" if not bad else bad[:4]}')
    # sites
    for (sid, x0, x1, z0, z1, y) in SITES:
        fy = int(y) - 1; good = 0; tot = 0
        for x in range(x0, x1 + 1):
            for z in range(z0, z1 + 1):
                tot += 1
                if solid(get(x, fy, z)) and get(x, fy + 1, z) == AIR and get(x, fy + 2, z) == AIR: good += 1
        rep.append(f'SITE {sid}: {good}/{tot} cells plantable at floor y{fy}')
    # BFS (ttt-traps style)
    def stand(x, y, z):
        return 1 <= y < SY - 2 and not solid(get(x, y, z)) and not solid(get(x, y + 1, z)) and (
            solid(get(x, y - 1, z)) or get(x, y - 1, z) == 'MC_WATER' or get(x, y, z) == 'MC_WATER')
    o = (FUN[0][0], T + 1, FUN[0][1]); seen = {o}; q = deque([o])
    while q:
        x, y, z = q.popleft()
        wet = get(x, y, z) == 'MC_WATER'
        for dx, dz in [(1, 0), (-1, 0), (0, 1), (0, -1), (0, 0)]:
            for dy in (0, 1, -1):
                if dx == 0 and dz == 0 and (dy == 0 or not wet): continue
                X, Y, Z = x + dx, y + dy, z + dz
                if (X, Y, Z) in seen or not (1 <= X <= SX - 2 and 1 <= Z <= SZ - 2) or not stand(X, Y, Z): continue
                if dy == 1 and solid(get(x, y + 2, z)): continue
                seen.add((X, Y, Z)); q.append((X, Y, Z))
    # drops of more than one voxel: allow falling
    changed = True
    while changed:
        changed = False
        for (x, y, z) in list(seen):
            for dx, dz in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
                X, Z = x + dx, z + dz
                if not (1 <= X <= SX - 2 and 1 <= Z <= SZ - 2): continue
                if solid(get(X, y, Z)) or solid(get(X, y + 1, Z)): continue
                Y = y
                while Y > 1 and not solid(get(X, Y - 1, Z)) and get(X, Y - 1, Z) != 'MC_WATER' and get(X, Y, Z) != 'MC_WATER': Y -= 1
                if stand(X, Y, Z) and (X, Y, Z) not in seen:
                    seen.add((X, Y, Z)); q.append((X, Y, Z)); changed = True
        while q:
            x, y, z = q.popleft()
            for dx, dz in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
                for dy in (0, 1, -1):
                    X, Y, Z = x + dx, y + dy, z + dz
                    if (X, Y, Z) in seen or not (1 <= X <= SX - 2 and 1 <= Z <= SZ - 2) or not stand(X, Y, Z): continue
                    if dy == 1 and solid(get(x, y + 2, z)): continue
                    seen.add((X, Y, Z)); q.append((X, Y, Z)); changed = True
    unreach = []
    for x in range(3, SX - 3):
        for z in range(3, SZ - 3):
            h = height_at(x, z)
            if not (STAND[0] <= h <= STAND[1]): continue
            if get(x, h, z) == 'MC_WATER' or get(x, h + 1, z) != AIR or get(x, h + 2, z) != AIR: continue
            if (x, h + 1, z) not in seen: unreach.append((x, h, z, get(x, h, z)))
    rep.append(f'ROAM: {len(unreach)} standable roam columns unreachable by 1-step BFS: {unreach[:20]}')
    for (tid, (bx, by, bz, face), pts) in TRAPS:
        wx = bx + (1 if face == 'x+' else -1 if face == 'x-' else 0); wz = bz + (1 if face == 'z+' else -1 if face == 'z-' else 0)
        okb = solid(get(bx, by - 1, bz)) and get(bx, by, bz) == AIR and get(bx, by + 1, bz) == AIR \
            and solid(get(wx, by, wz)) and solid(get(wx, by + 1, wz)) and (bx, by, bz) in seen
        fp = all(get(math.floor(px), math.floor(py), math.floor(pz)) == AIR and solid(get(math.floor(px), math.floor(py) - 1, math.floor(pz))) for px, py, pz in (pts or []))
        rep.append(f'TRAP {tid}: button ok={okb} (wall {get(wx,by,wz)}) fire points ok={fp}')
    for (lid, x, z, fy) in LANDMARKS:
        y = T + fy + 1
        rep.append(f'LANDMARK {lid} ({x},{z}) floor y{T+fy}: reach={(x, y, z) in seen} free={get(x,y,z)==AIR and get(x,y+1,z)==AIR} heightAt={height_at(x,z)}')
    for sid, x0, x1, z0, z1, yy in SITES:
        fy = int(yy)
        r = sum((x, fy, z) in seen for x in range(x0, x1 + 1) for z in range(z0, z1 + 1))
        rep.append(f'SITE {sid} reachable cells {r}/{(x1-x0+1)*(z1-z0+1)}')
    # water check
    wet = [(x, z) for x in range(SX) for z in range(SZ) if get(x, T, z) == 'MC_WATER']
    rep.append(f'WATER cells: {len(wet)}; spawns within 2 of water: '
               f'{[a for a in FUN+ALPHA+BRAVO+ATK+DEF if any(abs(a[0]-x)<=2 and abs(a[1]-z)<=2 for x,z in wet)]}')
    # boot cost proxy: non-base solid voxels above ground
    rep.append(f'VOXELS above ground authored: {int(np.count_nonzero(W[:, T+1:, :]))}')
    # longest open chest-height axis runs (y=16) outside the shell
    best = []
    for z in range(14, 82):
        run = 0
        for x in range(3, 125):
            run = run + 1 if get(x, 16, z) == AIR and get(x, 15, z) == AIR else 0
            best.append((run, 'x-run', z, x))
    for x in range(3, 125):
        run = 0
        for z in range(14, 82):
            run = run + 1 if get(x, 16, z) == AIR and get(x, 15, z) == AIR else 0
            best.append((run, 'z-run', x, z))
    best.sort(reverse=True)
    import itertools
    seen_rows=set(); top=[]
    for b in best:
        if (b[1],b[2]) in seen_rows: continue
        seen_rows.add((b[1],b[2])); top.append(b)
    best=top
    rep.append(f'LONGEST axis runs at chest height: {best[:14]}')
    return rep, seen


def ascii_map():
    legend = {'BB_PINEAPPLE': 'P', 'BB_MOAI': 'M', 'BB_ROCK': 'o', 'BB_KELP': '|', 'BB_CORAL': 'y', 'BB_HULL': 'h',
              'BB_CHUM': 'C', 'MC_WATER': '~', 'GLASS': 'g', 'SLIDE_YELLOW': 'f', 'SLIDE_BLUE': 'f', 'RUST': 'r',
              'PALE': 'p', 'PLANK': 'k', 'WOOD': 'w', 'ROOF': 'K', 'BUS_YELLOW': 'c', 'TRUCK_RED': 'c', 'TEAL_SIDING': 'c',
              'POOL_TILE_BLUE': 'c', 'DUST_WOOD': 'w', 'DUST_CRATE': 'x', 'BB_PINE_LEAF': 'l', 'LEAVES': 'l',
              'ACCENT': 'a', 'MC_IRON': 'i', 'MC_CHEST': 'x', 'BB_SAND': 's', 'METAL': '#', 'ASPHALT': 'p', 'POOL_TILE_WHITE': 'p'}
    marks = {}
    for x, z in FUN: marks[(x, z)] = '*'
    for x, z in ALPHA: marks[(x, z)] = 'A'
    for x, z in BRAVO: marks[(x, z)] = 'N'
    for x, z in ATK: marks.setdefault((x, z), '^')
    for x, z in DEF: marks.setdefault((x, z), 'd')
    for x, _, z in POWER: marks[(x, z)] = '+'
    lines = ['       ' + ''.join(str((x // 10) % 10) if x % 10 == 0 else ' ' for x in range(SX)),
             '       ' + ''.join(str(x % 10) for x in range(SX))]
    for z in range(SZ):
        row = []
        for x in range(SX):
            if (x, z) in marks: row.append(marks[(x, z)]); continue
            h = height_at(x, z)
            e = min(x, z, SX - 1 - x, SZ - 1 - z)
            if e < 3: row.append('#'); continue
            if get(x, T, z) == 'MC_WATER': row.append('~'); continue
            if h <= T:
                m = get(x, T, z)
                row.append('=' if m == 'BB_ROAD' else '-' if m == 'PALE' and 28 <= z <= 67 else '.'); continue
            m = get(x, h, z)
            ch = legend.get(m, '?')
            # prefer the lowest solid above ground for tall stacks
            row.append(ch)
        lines.append(f'z={z:<3}  ' + ''.join(row))
    return '\n'.join(lines)


if __name__ == '__main__':
    rep, seen = main()
    print('\n'.join(problems[:60]))
    print(f'-- {len(problems)} ownership problems')
    print('\n'.join(rep))
    if '--ascii' in sys.argv:
        print(ascii_map())
