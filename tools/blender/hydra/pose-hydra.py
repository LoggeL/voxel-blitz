#!/usr/bin/env python3
"""Articulation proof shots of the HYDRA study (rotor / bolt / home).

Usage:
    blender --background --factory-startup docs/design/blender/hydra/hydra.blend \\
        --python tools/blender/hydra/pose-hydra.py

The study bakes the triple barrel bundle STATIC into the body node (the
runtime spins its own minigun_rotor group child of body every frame:
heavy-weapon-animation.js ``rotor.rotation.z += dt * spin * 42``), so the
GLB carries no rotor node. To prove the cluster articulates cleanly about
the bore axis, this script rigidly rotates the rotor-mounted *objects*
(barrel bundle, three muzzle mouths, per-tube brakes) 120 degrees about the
bore line x=0, z=0.055, and stages the game bolt throw (defs.js minigun
boltTravel 0.075, game +z rearward == authoring -y).

Only object transforms move. No mesh data, materials, lights, or hierarchy
are touched: every posed object keeps location (0,0,0)-relative baked verts
and gets a LocRot rigid motion about the bore axis; the bolt throw moves the
`bolt` group empty, whose children ride along.

Frames (left-front-top articulation camera, study lighting):
    pose-rotor120.png   rotor cluster +120 deg about the bore, bolt home
    pose-boltback.png   rotor home, bolt back 0.075 (full boltTravel throw)
    pose-home.png       everything at identity (reference)
"""

import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

DOCS = None
for arg in sys.argv:
    if arg.endswith("hydra.blend"):
        DOCS = Path(arg).parent
if DOCS is None:
    DOCS = Path("/Users/logge/Documents/Projects/voxel-blitz/docs/design/blender/hydra")

# --- frozen contract values (mirrors build-hydra.py) -------------------------
BORE_X, BORE_Z = 0.000, 0.055  # bore axis in authoring space
BOLT_TRAVEL = 0.075            # defs.js minigun boltTravel (m)
ROTOR_DEG = 120.0              # one cluster pitch: tubes sit 120 deg apart

ROTOR_OBJECTS = (
    "Rotor barrel bundle",
    "Muzzle mouth 1",
    "Muzzle mouth 2",
    "Muzzle mouth 3",
    "Muzzle brakes",
)

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 40
scene.cycles.use_denoising = True
scene.cycles.device = "CPU"
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"

# --- study lighting (same rig as render-hydra.py) ----------------------------


def area_light(name, location, energy, size=1.4, colour=(1, 1, 1, 1)):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.size = size
    data.color = colour[:3]
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    scene.collection.objects.link(obj)
    return obj

area_light("HYDRA key", (2.2, 1.6, 2.4), 900)
area_light("HYDRA fill", (-2.4, -0.6, 1.1), 320, size=2.4, colour=(0.82, 0.88, 1.0, 1))
area_light("HYDRA rim", (-0.9, -2.2, 1.8), 420, size=1.6, colour=(1.0, 0.94, 0.86, 1))

# --- articulation camera: front-left-top, sees muzzle faces + bolt handle ---
cam_data = bpy.data.cameras.new("HYDRA articulation camera")
cam = bpy.data.objects.new("HYDRA articulation camera", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam_pos, cam_target, cam_lens = (-1.05, 1.95, 0.72), (0.0, 0.38, 0.0), 62
cam.location = Vector(cam_pos)
cam.rotation_euler = (Vector(cam_target) - Vector(cam_pos)).to_track_quat("-Z", "Y").to_euler()
cam_data.lens = cam_lens

# --- rigid pose helpers (object transforms only, never mesh verts) -----------
studied = bpy.context.scene
_empties = {o.name: o for o in studied.objects if o.type == "EMPTY"}
_objects = {o.name: o for o in studied.objects}

missing = [n for n in ("bolt",) + ROTOR_OBJECTS if n not in {**_empties, **_objects}]
if missing:
    raise RuntimeError(f"pose-hydra: study is missing nodes: {missing}")

bolt_empty = _empties["bolt"]
rotor_objs = [_objects[n] for n in ROTOR_OBJECTS]

# Rigid 120-deg spin about the bore line: world p -> R@(p-c)+c with
# c=(0,0,BORE_Z). Authored objects carry world-baked verts at identity, so
# each object takes rotation R and location c-R@c (uniform: all start at 0).
theta = math.radians(ROTOR_DEG)
spin = Matrix.Rotation(theta, 4, "Y")
axis_point = Vector((0.0, 0.0, BORE_Z))
spin_offset = axis_point - spin @ axis_point


def rotor_120():
    for obj in rotor_objs:
        obj.rotation_euler = (0.0, theta, 0.0)
        obj.location = spin_offset


def rotor_home():
    for obj in rotor_objs:
        obj.rotation_euler = (0.0, 0.0, 0.0)
        obj.location = (0.0, 0.0, 0.0)


def bolt_back():
    bolt_empty.location = (0.0, -BOLT_TRAVEL, 0.0)


def bolt_home():
    bolt_empty.location = (0.0, 0.0, 0.0)


FRAMES = (
    ("pose-rotor120", rotor_120, bolt_home),
    ("pose-boltback", rotor_home, bolt_back),
    ("pose-home", rotor_home, bolt_home),
)

for stem, pose_rotor, pose_bolt in FRAMES:
    pose_rotor()
    pose_bolt()
    bpy.context.view_layer.update()
    # Paranoia: confirm the bore axis never translated (rotation about the
    # line, not a swing) and the bolt throw is exact. Tolerance is 1e-6:
    # object locations are float32, so 0.075 reads back as 0.075000003.
    want_rotor = spin_offset if stem == "pose-rotor120" else Vector((0.0, 0.0, 0.0))
    for obj in rotor_objs:
        assert (Vector(obj.location) - want_rotor).length < 1e-6, obj.name
    assert abs(bolt_empty.location[1] - (-BOLT_TRAVEL if stem == "pose-boltback" else 0.0)) < 1e-6
    scene.render.filepath = str(DOCS / f"{stem}.png")
    bpy.ops.render.render(write_still=True)
    print(f"POSE_SAVED {stem}.png")

# Leave the study untouched for whoever opens it next.
rotor_home()
bolt_home()
print("HYDRA-POSE-DONE")
