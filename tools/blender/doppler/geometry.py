"""SP-2 DOPPLER geometry, authored in game gun space (+x right, +y up, -z muzzle).

Layout shorthand used throughout: u = -z (metres toward the muzzle), v = y.
The rifle is a fixed carrier chassis (`body`) around a recoiling firing unit
(`unit`: receiver, barrel, brake) that slides UNIT_TRAVEL back on a guide rod.
"""
import math

import bmesh
from mathutils import Matrix, Vector

import hardsurface as hs

BORE_Y = 0.050
ROD_Y = 0.012
MUZZLE_U = 0.660
SIGHT_Y = 0.142
W = 0.0255          # chassis outer half width
WT = 0.0036         # chassis wall
SKIN = 0.0015       # outer wall layer; pockets and window steps are milled through it
TOP = 0.0945        # chassis deck top
SHOULDER = 0.0865   # where the wall turns into the 45 degree shoulder
RAIL_TOP = 0.1035
UNIT_TRAVEL = 0.016
BOLT_HOME_U = 0.210
PORT_U, PORT_V, PORT_R = 0.028, 0.050, 0.0215
MAG_CANT = 9.0      # degrees, magazine floor toward -x
MAG_TOP = (0.0, -0.020, -0.220)
MARKERS = {
    'muzzle': (0.0, BORE_Y, -MUZZLE_U),
    'sight': (0.0, SIGHT_Y, -0.180),
    'grip': (0.045, 0.015, -0.090),
    'support': (-0.050, -0.020, -0.410),
    'pulley': (0.0, PORT_V, -PORT_U),
    'spring': (0.0, ROD_Y, -0.352),
    'eject': (0.030, 0.062, -0.198),
}


def new():
    return bmesh.new()


def zy(x=0.0):
    return hs.plane_zy(x)


def screw(bm, u, v, x, r=0.0031, proud=0.0011, axis=1, seg=8):
    """Socket-head screw seated on a chassis wall; axis +1 faces +x."""
    s = 1 if axis > 0 else -1
    m = hs.frame((x, v, -u), (0, 1, 0), (0, 0, 1)) if s > 0 else hs.frame((x, v, -u), (0, -1, 0), (0, 0, 1))
    # local z = +/-x after the frame: frame columns are x', y', x' cross y'
    prof = [(proud - 0.0009, 0), (proud - 0.0009, r * 0.52), (proud, r * 0.60), (proud, r - 0.0004),
            (proud - 0.0004, r), (-0.0002, r)]
    hs.lathe(bm, prof, seg=seg, matrix=m)


def build(st):
    """Populate the hardsurface.Study with every part of the rifle."""
    chassis(st)
    lower(st)
    stock(st)
    rail_and_sights(st)
    optic(st)
    unit(st)
    bolt_and_trigger(st)
    pulley(st)
    magazine(st)


# ------------------------------------------------------------------ chassis
def wall_outline():
    pts = [(-0.010, 0.000), (-0.010, SHOULDER), (0.526, SHOULDER), (0.545, 0.068), (0.545, 0.004),
           (0.529, -0.012), (0.292, -0.012), (0.276, -0.024), (0.006, -0.024)]
    radii = [0.004, 0.0, 0.0, 0.004, 0.004, 0.004, 0.006, 0.004, 0.010]
    return hs.fillet(pts, radii, steps=4)


def grown(points, amount):
    """Push a convex outline outward from its centroid (window steps in the outer skin)."""
    cx = sum(p[0] for p in points) / len(points)
    cy = sum(p[1] for p in points) / len(points)
    out = []
    for u, v in points:
        du, dv = u - cx, v - cy
        out.append((u + amount * (1 if du > 0 else -1), v + amount * (1 if dv > 0 else -1)))
    return out


MECH_WINDOW = [(0.118, 0.032), (0.262, 0.032), (0.290, 0.078), (0.118, 0.078)]
TRUSS_WINDOW = [(0.302, 0.008), (0.520, 0.008), (0.520, 0.072), (0.330, 0.072)]


def wall_holes(skin):
    """Through-holes of a chassis wall; the outer skin also carries steps and milled pockets."""
    g = 0.0013 if skin else 0.0
    holes = [hs.circle(PORT_U, PORT_V, PORT_R + g * 0.0, 40)]
    holes.append(hs.fillet(grown(MECH_WINDOW, g), 0.0075 + g, 5))
    holes.append(hs.fillet(grown(TRUSS_WINDOW, g), 0.0075 + g, 5))
    for i in range(3):
        holes.append(hs.slot(0.368 + i * 0.058, 0.0795, 0.044 + 2 * g, 0.0056 + 2 * g, 5))
    for i in range(4):
        holes.append(hs.slot(0.352 + i * 0.049, -0.0022, 0.036 + 2 * g, 0.0056 + 2 * g, 5))
    holes.append(hs.slot(0.080, -0.013, 0.020, 0.0056, 5))   # selector axle slot
    if skin:
        holes.append(hs.fillet(hs.rect(0.0545, 0.0290, 0.1155, 0.0750), 0.004, 4))      # name plate pocket
        holes.append(hs.fillet([(0.128, 0.0105), (0.262, 0.0105), (0.270, 0.0250), (0.128, 0.0250)], 0.003, 3))
        holes.append(hs.fillet([(0.300, 0.0770), (0.322, 0.0770), (0.3275, 0.0835), (0.300, 0.0835)], 0.0018, 2))
        holes.append(hs.fillet(hs.rect(0.010, -0.018, 0.058, 0.014), 0.004, 3))          # rear lightening pocket
    return holes


def octagon(hw, y0, y1, ch):
    return [(-hw + ch, y0), (hw - ch, y0), (hw, y0 + ch), (hw, y1 - ch), (hw - ch, y1), (-hw + ch, y1),
            (-hw, y1 - ch), (-hw, y0 + ch)]


def chassis(st):
    for side, name in ((-1, 'left'), (1, 'right')):
        core = WT - SKIN
        bm = new()
        hs.plate(bm, wall_outline(), wall_holes(False), core, 0.0005, 1, zy(side * (W - SKIN - core / 2)))
        st.add(bm, f'chassis wall {name}', 'body', 'cerakote', texel=2.0)
        bm = new()
        hs.plate(bm, wall_outline(), wall_holes(True), SKIN, 0.0006, 1, zy(side * (W - SKIN / 2)))
        st.add(bm, f'chassis skin {name}', 'body', 'cerakote', texel=1.9)
        # 45 degree shoulder between the wall and the deck
        bm = new()
        ch = 0.0080
        m = hs.rot('Z', -45 * side, (side * (W - ch / 2), SHOULDER + ch / 2, 0))
        hs.box(bm, (WT, ch * math.sqrt(2) + 0.0012, 0.536), (side * (W - ch / 2 - 0.0010), SHOULDER + ch / 2 - 0.0010, -0.258),
               0.0007, 2, m)
        st.add(bm, f'chassis shoulder {name}', 'body', 'cerakote', texel=1.2)
        # lower shoulder of the fore-end
        bm = new()
        ch = 0.0060
        m = hs.rot('Z', 45 * side, (side * (W - ch / 2), -0.012 + ch / 2, 0))
        hs.box(bm, (WT, ch * math.sqrt(2) + 0.0010, 0.236), (side * (W - ch / 2 - 0.0008), -0.012 + ch / 2 + 0.0008, -0.412),
               0.0006, 2, m)
        st.add(bm, f'chassis keel {name}', 'body', 'cerakote')

    # deck: full length, vented beside the rail over the fore-end
    bm = new()
    hw = W - 0.0075
    deck = hs.rect(-hw, -0.010, hw, 0.528, 0.002)
    holes = [hs.slot(side * 0.0142, 0.330 + i * 0.052, 0.036, 0.0042, 4, math.pi / 2)
             for side in (-1, 1) for i in range(4)]
    hs.plate(bm, deck, holes, WT, 0.0007, 2, hs.plane_xz(TOP - WT / 2))
    st.add(bm, 'chassis deck', 'body', 'cerakote', texel=1.2)

    # belly: fore-end floor with M-LOK slots
    bm = new()
    hw = W - 0.0055
    belly = hs.rect(-hw, 0.290, hw, 0.529, 0.002)
    holes = [hs.slot(0.0, 0.336 + i * 0.047, 0.032, 0.0070, 5, math.pi / 2) for i in range(4)]
    hs.plate(bm, belly, holes, WT, 0.0007, 2, hs.plane_xz(-0.012 + WT / 2))
    st.add(bm, 'chassis belly', 'body', 'cerakote', texel=0.8)

    # bulkheads: front cap around the barrel, mid web behind the truss, rear cap
    sect = octagon(W - 0.0008, 0.0035, 0.0685, 0.0040)
    bm = new()
    hs.plate(bm, hs.fillet(sect, 0.0015, 2), [hs.circle(0, BORE_Y, 0.0140, 32), hs.circle(0, ROD_Y, 0.0052, 16)],
             0.0070, 0.0010, 2, hs.plane_xy(-0.5415))
    st.add(bm, 'front cap', 'body', 'cerakote', texel=1.3)
    # sloped nose plates closing the chamfered front of the fore-end
    bm = new()
    hs.box(bm, (2 * W - 0.0016, WT, 0.0300), (0, 0.0822, -0.5362), 0.0007, 2, hs.rot('X', -49.8, (0, 0.0822, -0.5362)))
    hs.box(bm, (2 * W - 0.0016, WT, 0.0236), (0, -0.0052, -0.5378), 0.0007, 2, hs.rot('X', 45.0, (0, -0.0052, -0.5378)))
    st.add(bm, 'nose plates', 'body', 'cerakote', texel=1.2)
    bm = new()
    for x, y in ((-0.0170, 0.058), (0.0170, 0.058), (-0.0170, 0.026), (0.0170, 0.026)):
        m = hs.frame((x, y, -0.5452), (1, 0, 0), (0, -1, 0))      # local z = -game z
        hs.lathe(bm, [(0.0003, 0), (0.0003, 0.0015), (0.0011, 0.0017), (0.0011, 0.0024), (0.0007, 0.0028), (-0.0004, 0.0028),
                      (-0.0004, 0)], seg=10, matrix=m)
    st.add(bm, 'front cap screws', 'body', 'nitride')
    # brass deflector behind the ejection window (right wall)
    bm = new()
    hs.box(bm, (0.0050, 0.0200, 0.0130), (W + 0.0016, 0.0620, -0.1100), 0.0014, 2, hs.rot('Y', -24, (W, 0.062, -0.110)))
    st.add(bm, 'case deflector', 'body', 'nitride', texel=1.2)
    bm = new()
    sect2 = octagon(W - 0.0030, -0.010, TOP - 0.0030, 0.0060)
    hs.plate(bm, sect2, [hs.circle(0, BORE_Y, 0.0170, 28), hs.circle(0, ROD_Y, 0.0048, 14)], 0.0050, 0.0006, 1,
             hs.plane_xy(-0.2960))
    st.add(bm, 'mid web', 'body', 'cerakote', texel=0.7)
    bm = new()
    rear = octagon(W - 0.0008, 0.0005, TOP - 0.0008, 0.0072)
    hs.plate(bm, hs.fillet(rear, 0.0015, 2), [], 0.0080, 0.0012, 2, hs.plane_xy(0.0100))
    st.add(bm, 'rear cap', 'body', 'cerakote', texel=1.2)

    # receiver floor between the walls (closes the view from below, carries the lower)
    bm = new()
    hs.box(bm, (2 * (W - WT) + 0.0004, 0.0040, 0.176), (0, -0.0215, -0.094), 0.0006, 1)
    st.add(bm, 'receiver floor', 'body', 'cerakote', texel=0.6)

    # fixed guide rod, its rear stop and the buffer spring
    bm = new()
    hs.cyl(bm, (0, ROD_Y, -0.296), (0, ROD_Y, -0.545), 0.0036, 14, 0.0004)
    hs.cyl(bm, (0, ROD_Y, -0.338), (0, ROD_Y, -0.352), 0.0076, 16, 0.0008)
    hs.cyl(bm, (0, ROD_Y, -0.545), (0, ROD_Y, -0.551), 0.0056, 6, 0.0006)
    st.add(bm, 'guide rod', 'body', 'steel')
    bm = new()
    hs.sweep(bm, hs.helix((0, ROD_Y, -0.352), (0, ROD_Y, -0.456), 0.0062, 11, 9), 0.00110, 5)
    st.add(bm, 'buffer spring', 'spring', 'steel', weighted=False, smooth=60)

    # port bezels (the glass disc is added in pulley())
    for side in (-1, 1):
        bm = new()
        m = hs.frame((side * (W + 0.0001), PORT_V, -PORT_U), (0, 1, 0), (0, 0, 1) if side > 0 else (0, 0, -1))
        prof = [(0, PORT_R - 0.0012), (0.0016, PORT_R - 0.0004), (0.0016, PORT_R + 0.0034), (0, PORT_R + 0.0046)]
        hs.lathe(bm, prof, seg=40, matrix=m, closed=True)
        st.add(bm, f'port bezel {"left" if side < 0 else "right"}', 'body', 'nitride', texel=1.4)
        bm = new()
        for k in range(6):
            a = math.radians(30 + 60 * k)
            screw(bm, PORT_U + math.cos(a) * (PORT_R + 0.0018), PORT_V + math.sin(a) * (PORT_R + 0.0018),
                  side * (W + 0.0016), 0.0013, 0.0006, side, 6)
        st.add(bm, f'port screws {"left" if side < 0 else "right"}', 'body', 'steel')

    # wall fasteners
    spots = [(0.000, 0.078), (0.000, 0.010), (0.109, 0.0825), (0.104, -0.014), (0.276, 0.010), (0.300, 0.080),
             (0.532, 0.078), (0.532, 0.000), (0.296, -0.004), (0.068, 0.020), (0.200, -0.014)]
    for side in (-1, 1):
        bm = new()
        for u, v in spots:
            screw(bm, u, v, side * W, 0.0030, 0.0011, side)
        st.add(bm, f'wall screws {"left" if side < 0 else "right"}', 'body', 'nitride', texel=1.2)

    # QD sling cups
    bm = new()
    for side in (-1, 1):
        m = hs.frame((side * W, 0.018, -0.500), (0, 1, 0), (0, 0, 1) if side > 0 else (0, 0, -1))
        hs.lathe(bm, [(0.0012, 0.0030), (0.0012, 0.0058), (0, 0.0068), (-0.001, 0.0068), (-0.001, 0.0030)], seg=18,
                 matrix=m, closed=True)
    st.add(bm, 'sling cups', 'body', 'nitride')


# ------------------------------------------------------------------ lower
def lower(st):
    # trigger housing
    bm = new()
    housing = hs.fillet([(0.010, -0.020), (0.180, -0.020), (0.180, -0.041), (0.104, -0.041), (0.046, -0.041),
                         (0.012, -0.031)], [0.002, 0.002, 0.003, 0, 0.006, 0.006], 3)
    hs.plate(bm, housing, [], 0.0420, 0.0014, 2, zy(0))
    st.add(bm, 'trigger housing', 'body', 'polymer', texel=1.1)

    # trigger guard
    bm = new()
    guard = hs.fillet([(0.100, -0.039), (0.183, -0.039), (0.183, -0.052), (0.174, -0.0755), (0.116, -0.0755),
                       (0.100, -0.060)], [0, 0, 0.004, 0.010, 0.010, 0.004], 4)
    hole = hs.fillet([(0.110, -0.043), (0.177, -0.043), (0.177, -0.052), (0.170, -0.0705), (0.119, -0.0705),
                      (0.110, -0.058)], 0.0075, 4)
    hs.plate(bm, guard, [hole], 0.0150, 0.0014, 2, zy(0))
    st.add(bm, 'trigger guard', 'body', 'polymer')

    # pistol grip: lofted, raked, with a palm swell and two finger grooves
    bm = new()
    stations = [  # v, centre u, half depth, half width, front groove
        (-0.036, 0.0840, 0.0330, 0.0156, 0.0000),
        (-0.044, 0.0808, 0.0296, 0.0154, 0.0000),
        (-0.054, 0.0770, 0.0268, 0.0157, 0.0010),
        (-0.066, 0.0726, 0.0262, 0.0165, 0.0000),
        (-0.080, 0.0676, 0.0272, 0.0174, 0.0012),
        (-0.094, 0.0626, 0.0282, 0.0180, 0.0000),
        (-0.108, 0.0576, 0.0286, 0.0180, 0.0010),
        (-0.122, 0.0526, 0.0286, 0.0176, 0.0000),
        (-0.136, 0.0478, 0.0292, 0.0174, 0.0000),
        (-0.147, 0.0440, 0.0308, 0.0178, 0.0000),
        (-0.1525, 0.0424, 0.0300, 0.0170, 0.0000),
    ]
    sections = []
    for v, cu, hd, hw_, groove in stations:
        ring = []
        for px, pu in hs.superellipse(hw_, hd, 28, 2.7):
            du = pu
            if pu > hd * 0.55:
                du -= groove * (pu - hd * 0.55) / (hd * 0.45)
            if pu < 0:              # backstrap is rounder than the front strap
                px *= 1.0 - 0.10 * (-pu / hd)
            ring.append((px, v, -(cu + du)))
        sections.append(ring)
    hs.loft(bm, sections)
    st.add(bm, 'pistol grip', 'body', 'stipple', smooth=60, texel=1.3)

    # beavertail and grip cap
    bm = new()
    tang = hs.fillet([(0.012, -0.022), (0.050, -0.022), (0.052, -0.040), (0.034, -0.046), (0.016, -0.036)], 0.004, 3)
    hs.plate(bm, tang, [], 0.0300, 0.0020, 2, zy(0))
    st.add(bm, 'beavertail', 'body', 'polymer')
    bm = new()
    cap = [(px, -0.1535, -(0.0422 + pu)) for px, pu in hs.superellipse(0.0176, 0.0312, 28, 2.7)]
    cap2 = [(px * 0.94, -0.1582, -(0.0412 + pu * 0.94)) for px, pu in hs.superellipse(0.0176, 0.0312, 28, 2.7)]
    hs.loft(bm, [cap, cap2])
    st.add(bm, 'grip cap', 'body', 'orange', smooth=50)

    bm = new()
    for side in (-1, 1):
        for u, v in ((0.060, -0.030), (0.126, -0.028), (0.166, -0.030)):
            screw(bm, u, v, side * 0.0210, 0.0024, 0.0006, side, 8)
    st.add(bm, 'housing pins', 'body', 'steel')

    # canted magazine well collar (same cant as the magazine)
    cant = hs.rot('Z', MAG_CANT, MAG_TOP)
    bm = new()
    outer = hs.fillet(hs.rect(-0.0185, 0.180, 0.0185, 0.264), 0.005, 3)
    inner = hs.fillet(hs.rect(-0.0142, 0.185, 0.0142, 0.259), 0.004, 3)
    hs.plate(bm, outer, [inner], 0.0260, 0.0012, 2, cant @ hs.plane_xz(-0.035))
    st.add(bm, 'magazine well', 'body', 'polymer', texel=1.1)
    # flared lip
    bm = new()
    outer = hs.fillet(hs.rect(-0.0200, 0.178, 0.0200, 0.266), 0.006, 3)
    inner = hs.fillet(hs.rect(-0.0150, 0.184, 0.0150, 0.260), 0.004, 3)
    hs.plate(bm, outer, [inner], 0.0050, 0.0016, 2, cant @ hs.plane_xz(-0.0495))
    st.add(bm, 'magazine well lip', 'body', 'polymer')

    # selector (both sides), magazine release paddle, bolt catch
    for side in (-1, 1):
        bm = new()
        x = side * (W + 0.0004)
        m = hs.frame((x, -0.013, -0.080), (0, 1, 0), (0, 0, 1) if side > 0 else (0, 0, -1))
        hs.lathe(bm, [(0.0032, 0), (0.0032, 0.0048), (0.0024, 0.0056), (0, 0.0056)], seg=18, matrix=m)
        lever = hs.fillet([(0.078, -0.0160), (0.102, -0.0148), (0.103, -0.0112), (0.078, -0.0100)], 0.0015, 2)
        hs.plate(bm, lever, [], 0.0030, 0.0008, 1, zy(x + side * 0.0034))
        st.add(bm, f'selector {"left" if side < 0 else "right"}', 'body', 'nitride', texel=1.3)
        bm = new()
        m = hs.frame((side * (W + 0.0002), -0.0135, -0.1145), (0, 1, 0), (0, 0, 1) if side > 0 else (0, 0, -1))
        hs.lathe(bm, [(0.0008, 0), (0.0008, 0.0021), (0, 0.0025)], seg=14, matrix=m)
        st.add(bm, f'selector dot {"left" if side < 0 else "right"}', 'body', 'orange')
    bm = new()
    hs.box(bm, (0.0120, 0.0240, 0.0050), (0, -0.0560, -0.1835), 0.0012, 2, hs.rot('X', -12, (0, -0.045, -0.1835)))
    st.add(bm, 'magazine paddle', 'body', 'nitride')
    bm = new()
    hs.box(bm, (0.0030, 0.0150, 0.0240), (-W - 0.0014, 0.014, -0.150), 0.0010, 2)
    hs.box(bm, (0.0042, 0.0090, 0.0100), (-W - 0.0026, 0.008, -0.142), 0.0012, 2)
    st.add(bm, 'bolt catch', 'body', 'nitride')

    # angled hand stop under the fore-end
    bm = new()
    stop = hs.fillet([(0.296, -0.0105), (0.356, -0.0105), (0.354, -0.020), (0.326, -0.047), (0.312, -0.047),
                      (0.298, -0.022)], [0, 0, 0.003, 0.006, 0.005, 0.004], 4)
    hs.plate(bm, stop, [hs.fillet([(0.308, -0.019), (0.340, -0.019), (0.324, -0.036), (0.314, -0.036)], 0.003, 3)],
             0.0230, 0.0018, 2, zy(0))
    st.add(bm, 'hand stop', 'body', 'polymer', texel=1.1)
    bm = new()
    for k in range(4):   # traction ribs on the rear face
        t = k / 3
        u = 0.3215 - t * 0.016
        v = -0.0440 + t * 0.018
        hs.box(bm, (0.0210, 0.0016, 0.0022), (0, v, -u + 0.0015), 0.0005, 1, hs.rot('X', 52, (0, v, -u)))
    st.add(bm, 'hand stop ribs', 'body', 'rubber')
    bm = new()
    for u in (0.306, 0.346):
        screw_y(bm, u, -0.0108)
    st.add(bm, 'hand stop screws', 'body', 'nitride')


def screw_y(bm, u, y, r=0.0028):
    """Screw head seated on a downward facing surface."""
    m = hs.frame((0, y, -u), (1, 0, 0), (0, 0, 1))   # local z = x cross z = -y
    hs.lathe(bm, [(0.0003, 0), (0.0003, r * 0.55), (0.0011, r * 0.62), (0.0011, r - 0.0004), (0.0007, r), (-0.0004, r),
                  (-0.0004, 0)], seg=10, matrix=m)


# ------------------------------------------------------------------ stock
def stock(st):
    # hinge block bolted to the rear cap, with a three-knuckle hinge on the right
    bm = new()
    hs.plate(bm, hs.fillet(octagon(0.0190, 0.014, 0.084, 0.006), 0.001, 2), [], 0.0220, 0.0012, 2, hs.plane_xy(0.0290))
    st.add(bm, 'hinge block', 'body', 'nitride', texel=1.1)
    bm = new()
    for v0, v1 in ((0.016, 0.034), (0.0355, 0.0625), (0.064, 0.082)):
        hs.cyl(bm, (0.0215, v0, 0.0290), (0.0215, v1, 0.0290), 0.0066, 18, 0.0008)
    hs.cyl(bm, (0.0215, 0.0125, 0.0290), (0.0215, 0.0855, 0.0290), 0.0030, 10, 0.0006)
    st.add(bm, 'hinge knuckles', 'body', 'nitride')
    bm = new()
    hs.box(bm, (0.0060, 0.0260, 0.0130), (-0.0200, 0.049, 0.0310), 0.0012, 2)
    hs.cyl(bm, (-0.0235, 0.049, 0.0310), (-0.0262, 0.049, 0.0310), 0.0052, 14, 0.0006)
    st.add(bm, 'stock latch', 'body', 'steel')

    # skeletal stock body (u is negative behind the receiver)
    bm = new()
    outer = hs.fillet([(-0.040, 0.081), (-0.258, 0.084), (-0.258, -0.066), (-0.238, -0.066), (-0.072, 0.012),
                       (-0.040, 0.012)], [0.003, 0.004, 0.004, 0.006, 0.012, 0.003], 4)
    tri = hs.fillet([(-0.098, 0.060), (-0.236, 0.062), (-0.236, -0.040), (-0.110, 0.022)], 0.008, 4)
    web = hs.fillet([(-0.052, 0.060), (-0.084, 0.060), (-0.094, 0.026), (-0.052, 0.026)], 0.006, 4)
    sling = hs.slot(-0.2475, -0.036, 0.022, 0.0060, 5, math.pi / 2)
    hs.plate(bm, outer, [tri, web, sling], 0.0230, 0.0024, 2, zy(0))
    st.add(bm, 'stock body', 'body', 'polymer', texel=1.0)
    # raised flanges along the struts (I-beam look) and steel inlays on the comb
    bm = new()
    for side in (-1, 1):
        hs.plate(bm, hs.slot(-0.160, 0.0715, 0.140, 0.0070, 5), [], 0.0016, 0.0005, 1, zy(side * 0.0116))
    st.add(bm, 'stock inlays', 'body', 'nitride', texel=0.8)
    bm = new()
    for side in (-1, 1):
        m = hs.frame((side * 0.0115, -0.052, 0.2475), (0, 1, 0), (0, 0, 1) if side > 0 else (0, 0, -1))
        hs.lathe(bm, [(0.0010, 0.0030), (0.0010, 0.0056), (0, 0.0066), (-0.001, 0.0066), (-0.001, 0.0030)], seg=18,
                 matrix=m, closed=True)
    st.add(bm, 'stock sling cups', 'body', 'nitride')

    # butt pad with rear ribs
    bm = new()
    pad = [(-0.258, 0.090), (-0.258, -0.068)]
    n = 9
    for k in range(n):
        v0 = -0.068 + (0.158 * k) / n
        v1 = -0.068 + (0.158 * (k + 1)) / n
        pad += [(-0.2775, v0 + 0.002), (-0.2775, v1 - 0.0052), (-0.2735, v1 - 0.0040), (-0.2735, v1 - 0.0012)]
    pad = pad[:-2] + [(-0.2775, 0.088)]
    hs.plate(bm, hs.fillet(pad, 0.0010, 1), [], 0.0300, 0.0026, 2, zy(0))
    st.add(bm, 'butt pad', 'body', 'rubber', texel=1.0)

    # cheek riser on two posts with a detent wheel
    bm = new()
    for u in (-0.102, -0.186):
        hs.cyl(bm, (0, 0.078, -u), (0, 0.1005, -u), 0.0042, 12, 0.0005)
        hs.box(bm, (0.0150, 0.0050, 0.0150), (0, 0.0860, -u), 0.0010, 1)
    st.add(bm, 'riser posts', 'body', 'steel')
    bm = new()
    hs.cyl(bm, (-0.0075, 0.0905, 0.144), (0.0075, 0.0905, 0.144), 0.0086, 20, 0.0010)
    st.add(bm, 'riser wheel', 'body', 'knurl', texel=1.2)
    bm = new()
    sections = []
    for u, s in ((-0.068, 0.55), (-0.074, 0.86), (-0.086, 1.0), (-0.204, 1.0), (-0.216, 0.86), (-0.222, 0.55)):
        ring = []
        for px, pv in hs.superellipse(0.0168 * (0.80 + 0.20 * s), 0.0080 * s, 22, 2.6):
            ring.append((px, 0.1085 + pv + (0.0080 - 0.0080 * s) * 0.3, -u))
        sections.append(ring)
    hs.loft(bm, sections)
    st.add(bm, 'cheek riser', 'body', 'rubber', smooth=62, texel=1.1)


# ------------------------------------------------------------------ rail and backup sights
def rail_and_sights(st):
    bm = new()
    hs.box(bm, (0.0158, 0.0044, 0.540), (0, TOP + 0.0020, -0.262), 0.0006, 1)
    st.add(bm, 'rail base', 'body', 'nitride', texel=0.6)
    bm = new()
    u = -0.006
    while u < 0.530:
        prof = [(-0.0106, 0.0), (-0.0106, 0.0022), (-0.0084, 0.0046), (0.0084, 0.0046), (0.0106, 0.0022), (0.0106, 0.0),
                (0.0080, -0.0022), (-0.0080, -0.0022)]
        hs.plate(bm, [(p[0], TOP + 0.0044 + p[1]) for p in prof], [], 0.0053, 0.0, 1, hs.plane_xy(-u - 0.0026))
        u += 0.0100
    st.add(bm, 'rail lugs', 'body', 'nitride', texel=0.6)

    # folded rear backup sight
    bm = new()
    hs.box(bm, (0.0230, 0.0052, 0.0300), (0, RAIL_TOP + 0.0026, -0.014), 0.0010, 2)
    hs.box(bm, (0.0150, 0.0060, 0.0360), (0, RAIL_TOP + 0.0080, -0.032), 0.0012, 2)
    hs.cyl(bm, (-0.0130, RAIL_TOP + 0.0050, -0.000), (0.0130, RAIL_TOP + 0.0050, -0.000), 0.0030, 10, 0.0005)
    hs.cyl(bm, (0.0115, RAIL_TOP + 0.0080, -0.040), (0.0160, RAIL_TOP + 0.0080, -0.040), 0.0044, 12, 0.0006)
    st.add(bm, 'rear sight', 'body', 'nitride', texel=1.0)
    # folded front sight
    bm = new()
    hs.box(bm, (0.0230, 0.0052, 0.0260), (0, RAIL_TOP + 0.0026, -0.500), 0.0010, 2)
    hs.box(bm, (0.0120, 0.0056, 0.0300), (0, RAIL_TOP + 0.0078, -0.488), 0.0012, 2)
    hs.cyl(bm, (-0.0130, RAIL_TOP + 0.0050, -0.512), (0.0130, RAIL_TOP + 0.0050, -0.512), 0.0030, 10, 0.0005)
    st.add(bm, 'front sight', 'body', 'nitride', texel=1.0)


# ------------------------------------------------------------------ optic
def optic(st):
    cu, r_out, r_in = 0.180, 0.0205, 0.0170
    # clamp mount
    bm = new()
    hs.box(bm, (0.0260, 0.0076, 0.0620), (0, RAIL_TOP + 0.0036, -cu), 0.0012, 2)
    hs.box(bm, (0.0190, 0.0150, 0.0480), (0, RAIL_TOP + 0.0120, -cu), 0.0016, 2)
    for u in (cu - 0.020, cu + 0.020):
        hs.cyl(bm, (0.0128, RAIL_TOP + 0.0034, -u), (0.0172, RAIL_TOP + 0.0034, -u), 0.0044, 6, 0.0006)
    st.add(bm, 'optic mount', 'factory-optic', 'nitride', texel=1.1)

    # octagonal prism housing, hollow so the eye looks straight through
    bm = new()
    m = Matrix.Translation((0, SIGHT_Y, -cu))
    prof = [(0.046, r_in), (0.048, r_in + 0.0012), (0.048, r_out - 0.0010), (0.045, r_out), (-0.034, r_out),
            (-0.040, r_out - 0.0026), (-0.046, r_out - 0.0026), (-0.046, r_in - 0.0020), (-0.040, r_in - 0.0020),
            (-0.036, r_in)]
    # lathe z is game z: forward is negative, so mirror the profile
    hs.lathe(bm, [(-z, r) for z, r in prof], seg=8, matrix=m, closed=True, phase=math.pi / 8)
    st.add(bm, 'optic housing', 'factory-optic', 'teal', smooth=30, texel=1.5)
    # objective hood ring and eyepiece ring
    bm = new()
    hs.tube(bm, (0, SIGHT_Y, -(cu + 0.046)), (0, SIGHT_Y, -(cu + 0.058)), 0.0200, 0.0172, 24, 0.0008)
    hs.tube(bm, (0, SIGHT_Y, -(cu - 0.052)), (0, SIGHT_Y, -(cu - 0.036)), 0.0188, 0.0150, 24, 0.0010)
    st.add(bm, 'optic rings', 'factory-optic', 'rubber', texel=1.2)
    # elevation turret and side brightness dial
    bm = new()
    hs.cyl(bm, (0, SIGHT_Y + 0.0185, -(cu - 0.004)), (0, SIGHT_Y + 0.0300, -(cu - 0.004)), 0.0092, 20, 0.0010)
    hs.cyl(bm, (0, SIGHT_Y + 0.0300, -(cu - 0.004)), (0, SIGHT_Y + 0.0325, -(cu - 0.004)), 0.0072, 20, 0.0008)
    hs.cyl(bm, (0.0185, SIGHT_Y, -(cu - 0.004)), (0.0300, SIGHT_Y, -(cu - 0.004)), 0.0110, 22, 0.0010)
    hs.cyl(bm, (0.0300, SIGHT_Y, -(cu - 0.004)), (0.0322, SIGHT_Y, -(cu - 0.004)), 0.0080, 22, 0.0008)
    st.add(bm, 'optic dials', 'factory-optic', 'knurl', texel=1.3)
    # lenses (runtime glass) and the reticle carrier
    bm = new()
    hs.cyl(bm, (0, SIGHT_Y, -(cu + 0.0445)), (0, SIGHT_Y, -(cu + 0.0455)), r_in, 28, 0.0)
    st.add(bm, 'objective lens', 'factory-optic', 'lens', weighted=False)
    bm = new()
    hs.cyl(bm, (0, SIGHT_Y, -(cu - 0.0440)), (0, SIGHT_Y, -(cu - 0.0430)), r_in - 0.0020, 28, 0.0)
    st.add(bm, 'eyepiece lens', 'factory-optic', 'lens', weighted=False)


# ------------------------------------------------------------------ recoiling unit
def figure_eight(r, gap, n=22, waist=0.0030):
    """Outline of two stacked lobes (centres 0 and -gap) with a filleted waist."""
    half = math.acos(gap / (2 * r))
    pts = []
    a0 = -math.pi / 2 + half             # right waist on the top lobe, angle from +x
    a1 = 1.5 * math.pi - half            # left waist, counter-clockwise over the crown
    for k in range(n + 1):
        a = a0 + (a1 - a0) * k / n
        pts.append((r * math.cos(a), r * math.sin(a)))
    b0 = math.pi / 2 + half              # left waist on the bottom lobe
    b1 = 2.5 * math.pi - half            # back round the floor to the right waist
    for k in range(1, n):
        a = b0 + (b1 - b0) * k / n
        pts.append((r * math.cos(a), -gap + r * math.sin(a)))
    radii = [0.0] * len(pts)
    radii[0] = radii[n] = waist
    return hs.fillet(pts, radii, 3)


def fluted(bm, origin, u0, u1, r, depth, count=6, seg=36, run=0.012):
    """Barrel section with scalloped flutes that feather out at both ends."""
    rings = []
    stations = [u0, u0 + run * 0.35, u0 + run, u1 - run, u1 - run * 0.35, u1]
    amounts = [0.0, 0.45, 1.0, 1.0, 0.45, 0.0]
    for u, amt in zip(stations, amounts):
        ring = []
        for k in range(seg):
            a = hs.TAU * k / seg
            f = 0.5 - 0.5 * math.cos(a * count)
            f = max(0.0, (f - 0.30) / 0.70) ** 0.8
            rr = r - depth * amt * f
            ring.append((origin[0] + rr * math.cos(a), origin[1] + rr * math.sin(a), -u))
        rings.append(ring)
    hs.loft(bm, rings, cap=False)


def unit(st):
    S = 'unit'
    # hollow receiver: two walls, roof, floor, front trunnion block, rear recoil housing
    hw, y0, y1, t = 0.0172, 0.028, 0.082, 0.0030
    bm = new()
    right = hs.fillet(hs.rect(0.100, y0, 0.300, y1), 0.003, 2)
    hs.plate(bm, right, [hs.fillet(hs.rect(0.166, 0.050, 0.232, 0.0745), 0.004, 3)], t, 0.0007, 2, zy(hw - t / 2))
    st.add(bm, 'unit wall right', S, 'nitride', texel=1.4)
    bm = new()
    hs.plate(bm, right, [hs.slot(0.172, 0.0660, 0.118, 0.0084, 5)], t, 0.0007, 2, zy(-hw + t / 2))
    st.add(bm, 'unit wall left', S, 'nitride', texel=1.4)
    bm = new()
    hs.box(bm, (2 * hw - 0.0012, t, 0.200), (0, y1 - t / 2, -0.200), 0.0007, 2)
    hs.box(bm, (2 * hw - 0.0012, t, 0.200), (0, y0 + t / 2, -0.200), 0.0007, 2)
    st.add(bm, 'unit roof and floor', S, 'nitride', texel=0.7)
    bm = new()
    hs.plate(bm, hs.fillet(octagon(hw + 0.0006, y0 - 0.0006, y1 + 0.0006, 0.005), 0.001, 2), [], 0.030, 0.0010, 2,
             hs.plane_xy(-0.2870))
    st.add(bm, 'trunnion', S, 'nitride', texel=1.1)
    bm = new()
    hs.plate(bm, hs.fillet(octagon(0.0105, 0.034, 0.078, 0.004), 0.001, 2), [], 0.088, 0.0010, 2, hs.plane_xy(-0.060))
    hs.box(bm, (2 * hw, y1 - y0, 0.0060), (0, (y0 + y1) / 2, -0.1030), 0.0010, 2)
    st.add(bm, 'recoil housing', S, 'nitride', texel=0.8)
    # polished slide rails on the unit flanks
    bm = new()
    for side in (-1, 1):
        hs.box(bm, (0.0022, 0.0050, 0.196), (side * (hw + 0.0010), 0.040, -0.200), 0.0006, 1)
    st.add(bm, 'slide rails', S, 'steel')
    # dark interior backdrop so the open port reads as depth
    bm = new()
    hs.box(bm, (0.0010, y1 - y0 - 0.008, 0.190), (-hw + t + 0.0006, (y0 + y1) / 2, -0.200), 0.0, 1)
    st.add(bm, 'unit interior', S, 'void', texel=0.4)

    # barrel
    o = (0, BORE_Y, 0)
    bm = new()
    prof = [(0.296, 0.0), (0.296, 0.0150), (0.326, 0.0150), (0.3285, 0.0140), (0.3310, 0.0125), (0.3340, 0.0118)]
    hs.lathe(bm, [(-u, r) for u, r in prof], origin=o, seg=36)
    fluted(bm, o, 0.3340, 0.4720, 0.0118, 0.0024)
    prof = [(0.4720, 0.0118), (0.4750, 0.0118), (0.4760, 0.0128), (0.4780, 0.0166), (0.5080, 0.0166), (0.5100, 0.0150),
            (0.5110, 0.0105), (0.5860, 0.0102), (0.5875, 0.0128), (0.5920, 0.0156), (0.5985, 0.0156), (0.5990, 0.0140), (0.5990, 0.0)]
    hs.lathe(bm, [(-u, r) for u, r in prof], origin=o, seg=36)
    st.add(bm, 'barrel', S, 'nitride', smooth=45, texel=1.3)

    # gas block clamp, its screws and the bracket that rides the guide rod
    bm = new()
    hs.box(bm, (0.0150, 0.0100, 0.0300), (0, BORE_Y + 0.0190, -0.4930), 0.0012, 2)
    hs.cyl(bm, (0, BORE_Y + 0.0210, -0.4780), (0, BORE_Y + 0.0210, -0.4560), 0.0036, 12, 0.0005)
    st.add(bm, 'gas block', S, 'nitride', texel=1.1)
    bm = new()
    bracket = hs.fillet([(-0.0105, ROD_Y - 0.0100), (0.0105, ROD_Y - 0.0100), (0.0125, BORE_Y - 0.0080),
                         (-0.0125, BORE_Y - 0.0080)], 0.003, 3)
    hs.plate(bm, bracket, [hs.circle(0, ROD_Y, 0.0044, 16)], 0.0120, 0.0010, 2, hs.plane_xy(-0.4620))
    hs.plate(bm, bracket, [hs.circle(0, ROD_Y, 0.0044, 16)], 0.0100, 0.0010, 2, hs.plane_xy(-0.3160))
    st.add(bm, 'rod brackets', S, 'nitride', texel=1.1)
    bm = new()
    for u in (0.4620, 0.3160):
        for side in (-1, 1):
            screw(bm, u, BORE_Y - 0.0150, side * 0.0122, 0.0022, 0.0009, side)
    st.add(bm, 'bracket screws', S, 'steel')

    # two-chamber figure-eight brake: three baffles on four spines, tapered rear collar
    gap = 0.0280
    outline = figure_eight(0.0192, gap, 15)
    holes_first = [hs.circle(0, 0, 0.0070, 16), hs.circle(0, -gap, 0.0096, 16)]
    holes = [hs.circle(0, 0, 0.0066, 16), hs.circle(0, -gap, 0.0124, 18)]
    bm = new()
    for u0, u1, hh in ((0.5985, 0.6150, holes_first), (0.6220, 0.6385, holes), (0.6455, 0.6600, holes)):
        m = Matrix.Translation((0, BORE_Y, 0)) @ hs.plane_xy(-(u0 + u1) / 2)
        hs.plate(bm, outline, hh, u1 - u0, 0.0012, 1, m)
    for x, y, sx, sy in ((0, 0.0162, 0.0150, 0.0052), (0, -gap - 0.0162, 0.0150, 0.0052),
                         (0.0128, -gap / 2, 0.0056, 0.0090), (-0.0128, -gap / 2, 0.0056, 0.0090)):
        hs.box(bm, (sx, sy, 0.0600), (x, BORE_Y + y, -0.6290), 0.0010, 2)
    st.add(bm, 'muzzle brake', S, 'titanium', texel=1.7)

    # cable: two runs from the housing anchor back to the pulley wheel
    bm = new()
    for dv in (0.0118, -0.0118):
        for side in (-1, 1):
            hs.cyl(bm, (side * 0.0150, PORT_V + dv, -PORT_U), (side * 0.0150, PORT_V + dv, -0.1010), 0.00085, 6, 0.0)
    for side in (-1, 1):
        hs.box(bm, (0.0050, 0.0300, 0.0060), (side * 0.0150, PORT_V, -0.1010), 0.0008, 1)
    st.add(bm, 'cable runs', S, 'steel', weighted=False)


# ------------------------------------------------------------------ bolt, trigger
def bolt_and_trigger(st):
    bm = new()
    hs.cyl(bm, (0, 0.062, -0.122), (0, 0.062, -0.236), 0.0108, 20, 0.0012)
    hs.box(bm, (0.0240, 0.0060, 0.0600), (0, 0.0745, -0.180), 0.0010, 1)
    st.add(bm, 'bolt carrier', 'bolt', 'steel', texel=1.2)
    bm = new()
    hs.box(bm, (0.0220, 0.0064, 0.0100), (-0.0220, 0.0660, -BOLT_HOME_U), 0.0010, 2)
    hs.cyl(bm, (-0.0330, 0.0660, -(BOLT_HOME_U - 0.013)), (-0.0330, 0.0660, -(BOLT_HOME_U + 0.013)), 0.0056, 16, 0.0012)
    st.add(bm, 'charging handle', 'bolt', 'knurl', texel=1.4)

    bm = new()
    blade = hs.fillet([(0.1260, -0.0380), (0.1345, -0.0380), (0.1335, -0.0500), (0.1380, -0.0625), (0.1345, -0.0640),
                       (0.1270, -0.0520)], 0.0028, 3)
    hs.plate(bm, blade, [], 0.0064, 0.0014, 2, zy(0))
    st.add(bm, 'trigger blade', 'trigger', 'steel', texel=1.3)


# ------------------------------------------------------------------ pulley
def pulley(st):
    for side in (-1, 1):
        x = side * 0.0150
        bm = new()
        m = hs.frame((x, PORT_V, -PORT_U), (0, 1, 0), (0, 0, 1) if side > 0 else (0, 0, -1))
        # grooved sheave with five lightening holes, modelled as a spoked wheel
        prof = [(-0.0026, 0.0104), (-0.0026, 0.0135), (-0.0014, 0.0135), (-0.0008, 0.0116), (0.0008, 0.0116),
                (0.0014, 0.0135), (0.0026, 0.0135), (0.0026, 0.0104)]
        hs.lathe(bm, prof, seg=30, matrix=m, closed=True)
        st.add(bm, f'pulley rim {"left" if side < 0 else "right"}', 'pulley', 'steel', texel=1.5)
        bm = new()
        spokes = []
        for k in range(5):
            a = hs.TAU * k / 5
            spokes.append(hs.circle(0.0074 * math.cos(a), 0.0074 * math.sin(a), 0.0033, 10))
        hs.plate(bm, hs.circle(0, 0, 0.0122, 30), spokes, 0.0018, 0.0004, 1,
                 hs.frame((x, PORT_V, -PORT_U), (0, 1, 0), (0, 0, 1)))
        st.add(bm, f'pulley web {"left" if side < 0 else "right"}', 'pulley', 'brass', texel=1.5)
        bm = new()
        hs.cyl(bm, (x - side * 0.0030, PORT_V, -PORT_U), (x + side * 0.0046, PORT_V, -PORT_U), 0.0036, 6, 0.0006)
        st.add(bm, f'pulley hub {"left" if side < 0 else "right"}', 'pulley', 'steel')
        # glass disc in the wall port
        bm = new()
        xg = side * (W - WT * 0.5)
        hs.cyl(bm, (xg - side * 0.0006, PORT_V, -PORT_U), (xg + side * 0.0006, PORT_V, -PORT_U), PORT_R + 0.0004, 40, 0.0)
        st.add(bm, f'port glass {"left" if side < 0 else "right"}', 'body', 'glass', weighted=False)
    # fixed axle through both sheaves and the cable wrap behind each wheel
    bm = new()
    hs.cyl(bm, (-W + WT, PORT_V, -PORT_U), (W - WT, PORT_V, -PORT_U), 0.0020, 8, 0.0)
    for side in (-1, 1):
        arc = [(side * 0.0150, PORT_V + 0.0118 * math.cos(a), -PORT_U + 0.0118 * math.sin(a))
               for a in [math.pi * k / 12 for k in range(13)]]
        hs.sweep(bm, arc, 0.00085, 6)
    st.add(bm, 'pulley axle and wrap', 'body', 'steel', weighted=False)


# ------------------------------------------------------------------ magazine
MAG_ROUNDS = 30
ROUND_STEP = 0.0056


def mag_curve(s):
    """Centreline of the magazine: s metres below the top; returns (u, v, rake radians)."""
    radius = 1.10
    a = s / radius
    u = 0.220 + 0.002 + radius * (1 - math.cos(a)) + s * math.tan(math.radians(7.0))
    v = -0.020 - radius * math.sin(a)
    return u, v, a + math.radians(7.0)


def mag_matrix():
    return hs.rot('Z', MAG_CANT, MAG_TOP)


def cartridge(bm, matrix):
    prof = [(0.0000, 0.0), (0.0000, 0.0048), (0.0008, 0.0055), (0.0320, 0.0054), (0.0362, 0.0040), (0.0410, 0.0039)]
    hs.lathe(bm, [(-z, r) for z, r in prof], seg=8, matrix=matrix)


def bullet(bm, matrix):
    prof = [(0.0408, 0.0034), (0.0465, 0.0032), (0.0535, 0.0019), (0.0572, 0.0)]
    hs.lathe(bm, [(-z, r) for z, r in prof], seg=7, matrix=matrix)


def round_matrix(index):
    """Pose of round `index` (0 = top of the stack) inside the magazine frame."""
    s = 0.018 + index * ROUND_STEP
    u, v, rake = mag_curve(s)
    side = -1 if index % 2 else 1
    base = Matrix.Translation((side * 0.0047, v, -(u - 0.0290)))
    return base @ Matrix.Rotation(-rake, 4, 'X')


def magazine(st):
    cant = mag_matrix()
    # translucent body: lofted along the curved centreline
    bm = new()
    sections = []
    steps = 16
    length = 0.192
    for k in range(steps + 1):
        s = -0.004 + length * k / steps
        u, v, rake = mag_curve(s)
        fwd = Vector((0, -math.sin(rake), -math.cos(rake)))      # along the cartridge
        ring = hs.section((0, v, -u), (1, 0, 0), fwd, hs.superellipse(0.0128, 0.0335, 26, 4.2))
        sections.append(ring)
    hs.loft(bm, sections, matrix=cant)
    st.add(bm, 'magazine body', 'mag', 'smoke', smooth=55, weighted=False)
    # witness ribs
    bm = new()
    for s in (0.050, 0.086, 0.122, 0.158):
        u, v, rake = mag_curve(s)
        fwd = Vector((0, -math.sin(rake), -math.cos(rake)))
        down = Vector((0, -math.cos(rake), math.sin(rake)))
        rings = []
        for off, grow in ((-0.0022, 0.0), (-0.0012, 0.0010), (0.0012, 0.0010), (0.0022, 0.0)):
            c = Vector((0, v, -u)) + down * off
            rings.append(hs.section(c, (1, 0, 0), fwd, hs.superellipse(0.0128 + grow, 0.0335 + grow, 26, 4.2)))
        hs.loft(bm, rings, cap=False, matrix=None)
    bm.transform(cant)
    st.add(bm, 'magazine ribs', 'mag', 'smoke', smooth=55, weighted=False)

    # floor plate and latch
    bm = new()
    u, v, rake = mag_curve(length - 0.004)
    fwd = Vector((0, -math.sin(rake), -math.cos(rake)))
    down = Vector((0, -math.cos(rake), math.sin(rake)))
    rings = []
    for off, grow in ((-0.0030, 0.0006), (0.0000, 0.0026), (0.0060, 0.0026), (0.0086, 0.0010)):
        c = Vector((0, v, -u)) + down * off
        rings.append(hs.section(c, (1, 0, 0), fwd, hs.superellipse(0.0128 + grow, 0.0335 + grow, 26, 4.2)))
    hs.loft(bm, rings, matrix=cant)
    st.add(bm, 'magazine floor', 'mag', 'polymer', smooth=50, texel=1.1)
    bm = new()
    c = Vector((0, v, -u)) + down * 0.0090
    hs.box(bm, (0.0120, 0.0020, 0.0160), tuple(c), 0.0006, 1, cant)
    st.add(bm, 'magazine latch', 'mag', 'orange')
    # steel feed lips
    bm = new()
    u, v, rake = mag_curve(-0.002)
    for side in (-1, 1):
        hs.box(bm, (0.0030, 0.0090, 0.0560), (side * 0.0102, v + 0.0010, -u + 0.004), 0.0008, 1,
               cant @ hs.rot('X', -math.degrees(rake), (0, v, -u)))
    st.add(bm, 'feed lips', 'mag', 'nitride')

    # follower: authored under the last round of a full stack, moved by the runtime
    bm = new()
    s = 0.018 + MAG_ROUNDS * ROUND_STEP + 0.002
    u, v, rake = mag_curve(s)
    hs.box(bm, (0.0200, 0.0090, 0.0560), (0, v, -u), 0.0014, 2, cant @ hs.rot('X', -math.degrees(rake), (0, v, -u)))
    ob = st.add(bm, 'follower', 'follower', 'orange')
    ob['followerPath'] = [list(_follower_point(n, cant)) for n in range(MAG_ROUNDS + 1)]

    # one cartridge (the top of the stack) is baked; the runtime instances the rest from
    # `roundMatrices`, so a spent round is one instance fewer and the atlas pays for one round
    first = cant @ round_matrix(0)
    inverse = first.inverted()
    relative = [(cant @ round_matrix(i)) @ inverse for i in range(MAG_ROUNDS)]
    flat = [float(m[r][c]) for m in relative for c in range(4) for r in range(4)]   # column-major, game space
    for kind, builder, mat in (('case', cartridge, 'brass'), ('bullet', bullet, 'copper')):
        bm = new()
        builder(bm, first)
        ob = st.add(bm, f'cartridge {kind}', 'rounds', mat, smooth=50, weighted=False, texel=1.2)
        ob['roundMatrices'] = flat


def _follower_point(rounds_left, cant):
    """Follower origin offset (game space) from its authored full-magazine pose for a given load."""
    full = 0.018 + MAG_ROUNDS * ROUND_STEP + 0.002
    s = 0.018 + rounds_left * ROUND_STEP + 0.002
    u0, v0, r0 = mag_curve(full)
    u1, v1, r1 = mag_curve(s)
    a = cant @ Vector((0, v0, -u0))
    b = cant @ Vector((0, v1, -u1))
    return (b.x - a.x, b.y - a.y, b.z - a.z, r1 - r0)
