"""Fit the field operator's actual jacket into the first-person arm frames."""
from math import pi, sin, cos

from rivet.arms import build_arms
from rivet.model import MeshModel, unit


def build_sleeves(model):
    source = MeshModel()
    build_arms(source)
    materials = {'dark': 'suit fabric', 'suit': 'patrol blue', 'ink': 'transfer',
                 'cloth': 'glove liner', 'rubber': 'ceramic armor', 'orange': 'knuckle plate'}
    for piece in source.pieces:
        if piece.part not in ('rElbow', 'rArm'):
            continue
        forearm = piece.part == 'rElbow'
        part, label = ('forearm', 'Forearm') if forearm else ('upperarm', 'Upper arm')
        vertices = []
        normals = [] if piece.normals else None
        across, above, along = (.69, .72, .31/.34) if forearm else (.60, .62, 1)
        for index, (x, y, z) in enumerate(piece.verts):
            # In first person the hand is the fixed end of the chain. The
            # wrist becomes z=0 and the wearer's outer arm faces +Y. Flatten
            # the bulky inside shoulder gusset where it meets the body.
            centre = 0 if forearm else min(1, max(0, (y+.13)/.16)) * -.068
            vertices.append((z*across, (x-centre)*above, (y+.34)*along))
            if normals is not None:
                nx, ny, nz = piece.normals[index]
                slope = -.068/.16 if not forearm and -.13 < y < .03 else 0
                normals.append(unit((nz/across, nx/above, (ny+slope*nx)/along)))
        model.mesh(part, label+' '+piece.name, materials[piece.mat], vertices, piece.faces,
                   piece.smooth, normals=normals, uvs=piece.uvs)

    # This cap allows the first-person rig to stretch its upper arm into a
    # fixed shoulder. The panelled cloth and sewn edge sit beneath the yoke.
    part = 'shoulder'
    sections = [(-.077,.031,.029),(-.065,.047,.035),(-.041,.054,.047),
                (-.016,.059,.057),(.006,.058,.059),(.023,.053,.048),
                (.040,.039,.037),(.053,.023,.024),(.058,.007,.009)]
    verts, faces = [], []
    count = 24
    for z, rx, ry in sections:
        for i in range(count):
            a = i*2*pi/count
            verts.append((rx*cos(a), ry*sin(a), z))
    for j in range(len(sections)-1):
        for i in range(count):
            a = j*count+i
            b = j*count+(i+1)%count
            faces.append((a,b,b+count,a+count))
    faces.extend([tuple(reversed(range(count))),tuple(range(len(verts)-count,len(verts)))])
    model.mesh(part,'Shoulder jacket lining','suit fabric',verts,faces)
    section = [(.040*cos(a),.038*sin(a),.039) for a in [i*2*pi/count for i in range(count)]]
    model.tube(part, 'Shoulder bound panel seam','glove liner',section+[section[0]],.0017,6)
