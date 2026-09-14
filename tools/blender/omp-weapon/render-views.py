#!/usr/bin/env python3
"""Render four studio review views of an OMP weapon study.

Run it against an editable study file; the script never writes to that file:

    blender --background docs/design/blender/omp-weapon/weapon.blend \
        --python tools/blender/omp-weapon/render-views.py

It finds the weapon meshes in the opened scene, bakes their evaluated
(modifier- and armature-deformed) geometry into a brand new temporary scene,
builds a camera / three-light / floor studio around it, and writes:

    render-hero.png   3/4 hero from front-left-above, 40 mm
    render-side.png   orthographic true side profile, barrel horizontal
    render-ads.png    close-up on the optic aperture from behind, 55 mm
                      (a study with no named optic gets a 35 mm sight-line
                      view of the whole weapon instead)
    render-rear.png   3/4 rear from behind-above on the right side

Environment overrides:
    OMPW_ASSET_DIR   output directory (default docs/design/blender/omp-weapon)
    OMPW_SAMPLES     Cycles samples / EEVEE render samples (default 48)
    OMPW_ENGINE      CYCLES (default) or EEVEE
    OMPW_FORCE_CPU   1 to pin Cycles to the CPU and skip Metal/GPU setup

The last line of stdout is a bare JSON summary of the written files.
"""

import json
import math
import os
import re
import sys
import time
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

# ---------------------------------------------------------------- constants

VIEW_FILES = (
    ("hero", "render-hero.png"),
    ("side", "render-side.png"),
    ("ads", "render-ads.png"),
    ("rear", "render-rear.png"),
)

# Scene-root nodes of a study built to the weapon contract. `body`, `mag`,
# `bolt`, `trigger` and `factory-optic` own the moving parts; `muzzle`, `grip`,
# `support` and `sight` are markers.
PART_NODES = frozenset(
    {"body", "mag", "bolt", "trigger", "factory-optic", "muzzle", "grip", "support", "sight"}
)

# Meshes that belong to study furniture rather than to the weapon. Furniture is
# named for what it is up front; a part like `Magazine floor plate` is not one.
STUDIO_PROP_RE = re.compile(
    r"^(studio|stage|scene|render|review|backdrop)?[\s_\-]*"
    r"(ground|floor|backdrop|cyclorama|plane|grid|shadow\s*catcher)\b", re.I)
MUZZLE_RE = re.compile(r"muzzle|barrel", re.I)
SIGHT_RE = re.compile(r"sight|optic|scope|reflex|holographic", re.I)
APERTURE_RE = re.compile(r"aperture|window|glass|reticle|lens|ring|eye\s*relief", re.I)

RES_X, RES_Y = 1600, 1000
SENSOR_WIDTH = 36.0  # mm, full-frame; the horizontal fit owns the wider axis here
SEED = 20260914

# Light power scales with the square of each light's distance so the studio
# keeps the same exposure whatever the model size.
KEY_POWER = 620.0
EDGE_POWER = 430.0
FILL_POWER = 260.0

WORLD_GREY = (0.18, 0.18, 0.185, 1.0)
FLOOR_COLOR = (0.022, 0.022, 0.025, 1.0)

# ADS view: stand just behind the optic aperture, a little above it and off to
# one side, with a longish lens so the ring reads instead of the whole weapon.
ADS_BACK_FRACTION = 0.235  # camera distance behind the aperture, / barrel length
ADS_SIDE_OFFSET = 0.30     # lateral offset, / model width
ADS_LIFT = 0.10            # height above the aperture, / model height
ADS_LENS = 55.0

Z_AXIS = Vector((0.0, 0.0, 1.0))


def die(message):
    sys.stderr.write("OMPW error: %s\n" % message)
    raise SystemExit(1)


def env_flag(name):
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def env_int(name, default):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(float(raw))
    except ValueError:
        die("%s must be an integer, got %r" % (name, raw))
    if value < 1:
        die("%s must be >= 1, got %d" % (name, value))
    return value


# ------------------------------------------------------------------- setup

ASSET_DIR = Path(os.path.abspath(os.path.expanduser(
    os.environ.get("OMPW_ASSET_DIR", "").strip() or "docs/design/blender/omp-weapon")))
SAMPLES = env_int("OMPW_SAMPLES", 48)
FORCE_CPU = env_flag("OMPW_FORCE_CPU")

_ENGINE_ALIASES = {
    "CYCLES": "CYCLES",
    "EEVEE": "BLENDER_EEVEE",
    "BLENDER_EEVEE": "BLENDER_EEVEE",
    "BLENDER_EEVEE_NEXT": "BLENDER_EEVEE",
}
_engine_raw = (os.environ.get("OMPW_ENGINE", "").strip() or "CYCLES").upper()
if _engine_raw not in _ENGINE_ALIASES:
    die("OMPW_ENGINE must be CYCLES or EEVEE, got %r" % _engine_raw)
ENGINE = _ENGINE_ALIASES[_engine_raw]


# -------------------------------------------------------- model discovery


def is_studio_prop(obj):
    return bool(STUDIO_PROP_RE.search(obj.name))


def base_name(obj):
    """`Butt pad tread.003` -> `butt pad tread`."""
    return re.sub(r"\.\d+$", "", obj.name).strip().lower()


def render_hidden_collections(scene):
    """Names of collections that the opened scene does not render."""
    hidden = set()

    def walk(layer_collection):
        collection = layer_collection.collection
        if layer_collection.exclude or collection.hide_render:
            hidden.add(collection.name)
        for child in layer_collection.children:
            walk(child)

    for layer in scene.view_layers:
        walk(layer.layer_collection)
    return hidden


def choose_parts(scene):
    """Pick the objects that make up the weapon, most explicit rule first."""
    meshes = [o for o in scene.objects if o.type == "MESH"]
    if not meshes:
        die("scene %r contains no mesh objects" % scene.name)

    # 1. The study contract: a `body` node among the scene-root part nodes, with
    #    the weapon meshes parented beneath those nodes (`body` itself may be an
    #    empty animation node rather than a mesh). Membership is decided by the
    #    hierarchy, so part names never have to look like weapon names.
    roots = [o for o in scene.objects if o.parent is None]
    if any(base_name(o) == "body" for o in roots):
        selected, pending = set(), [o for o in roots if base_name(o) in PART_NODES]
        pending.extend(o for o in roots if o.type == "MESH" and not is_studio_prop(o))
        while pending:
            node = pending.pop()
            if node in selected:
                continue
            selected.add(node)
            pending.extend(node.children)
        parts = sorted((o for o in selected if o.type == "MESH"), key=lambda o: o.name)
        if parts:
            return parts, "contract-parts"

    # 2. An authored study may instead hide the source parts and render one
    #    merged mesh; follow whatever the file itself shows.
    others = [o for o in meshes if not is_studio_prop(o)]
    hidden = render_hidden_collections(scene)
    renderable = [
        o for o in others
        if not o.hide_render and not any(c.name in hidden for c in o.users_collection)
    ]
    if renderable:
        return sorted(renderable, key=lambda o: o.name), "render-visible"

    # 3. Last resort: every mesh that is not furniture.
    return sorted(others or meshes, key=lambda o: o.name), "all-meshes"


def bake_model(scene, objects, collection):
    """Copy evaluated model geometry into the studio scene, in world space."""
    scene.frame_set(scene.frame_start)
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()

    baked, skipped = [], []
    for source in objects:
        evaluated = source.evaluated_get(depsgraph)
        try:
            mesh = bpy.data.meshes.new_from_object(
                evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
        except RuntimeError as exc:  # a modifier produced no geometry
            skipped.append("%s (%s)" % (source.name, exc))
            continue
        if not mesh.vertices:
            bpy.data.meshes.remove(mesh)
            skipped.append("%s (no geometry)" % source.name)
            continue
        mesh.transform(evaluated.matrix_world)
        mesh.update()

        node = bpy.data.objects.new(source.name, mesh)
        node.hide_render = False
        collection.objects.link(node)
        # Object-linked material overrides live on the object, not the mesh.
        for index, slot in enumerate(source.material_slots):
            if slot.link == "OBJECT" and slot.material and index < len(node.material_slots):
                node.material_slots[index].link = "OBJECT"
                node.material_slots[index].material = slot.material
        baked.append(node)

    if not baked:
        die("no renderable geometry found; skipped: %s" % (", ".join(skipped) or "nothing"))
    return baked, skipped


def points_of(obj):
    matrix = obj.matrix_world
    return [matrix @ vertex.co for vertex in obj.data.vertices]


def bounds_of(objects):
    low = Vector((math.inf,) * 3)
    high = Vector((-math.inf,) * 3)
    for obj in objects:
        for point in points_of(obj):
            for axis in range(3):
                low[axis] = min(low[axis], point[axis])
                high[axis] = max(high[axis], point[axis])
    return low, high


def box_of(obj):
    matrix = obj.matrix_world
    return [matrix @ Vector(corner) for corner in obj.bound_box]


def model_basis(scene, forward_axis_hint=Vector((0.0, 1.0, 0.0))):
    """Barrel-forward axis of the study, read from its muzzle nodes when present."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    muzzle_ys = [
        obj.evaluated_get(depsgraph).matrix_world.translation.y
        for obj in scene.objects
        if MUZZLE_RE.search(obj.name) and obj.type in {"EMPTY", "MESH"}
    ]

    if muzzle_ys:
        muzzle_y = sum(muzzle_ys) / len(muzzle_ys)
        # The muzzle sits at the far end, so it decides the forward sign.
        forward = Vector((0.0, 1.0 if muzzle_y >= 0.0 else -1.0, 0.0))
        note = "%d muzzle/barrel node(s) at y=%+.3f" % (len(muzzle_ys), muzzle_y)
    else:
        forward = forward_axis_hint.copy()
        note = "no muzzle node named; assuming +Y"

    right = forward.cross(Z_AXIS).normalized()  # +Y forward, +Z up -> +X right
    return forward, right, Z_AXIS.copy(), note


# ------------------------------------------------------------- studio rig


def look_at_matrix(forward, up_hint=Z_AXIS):
    """3x3 rotation whose local X/Y/Z axes are right/up/backward."""
    front = forward.normalized()
    side = front.cross(up_hint)
    if side.length < 1e-6:
        side = front.cross(Vector((0.0, 1.0, 0.0)))
    side.normalize()
    up = side.cross(front)
    return Matrix(((side.x, up.x, -front.x),
                   (side.y, up.y, -front.y),
                   (side.z, up.z, -front.z)))


def corner_points(low, high):
    return [Vector((x, y, z))
            for x in (low.x, high.x)
            for y in (low.y, high.y)
            for z in (low.z, high.z)]


def fitted_distance(aim, forward, corners, lens, margin):
    """Distance along `forward` at which every model corner fits the frame."""
    right = forward.cross(Z_AXIS).normalized()
    up = right.cross(forward)
    tan_x = (SENSOR_WIDTH * 0.5) / lens
    tan_y = tan_x * (RES_Y / RES_X)
    distance = 0.0
    for corner in corners:
        offset = corner - aim
        depth = offset.dot(forward)
        for lateral, tan_half in ((abs(offset.dot(right)), tan_x),
                                  (abs(offset.dot(up)), tan_y)):
            distance = max(distance, lateral / tan_half - depth)
    return max(distance, 1e-4) * margin


def aim_perspective(camera, aim, eye, lens, distance):
    """Stand at `eye` and look at `aim` from `distance` back along that axis."""
    forward = (aim - eye).normalized()
    camera.data.type = "PERSP"
    camera.data.lens = lens
    camera.data.sensor_width = SENSOR_WIDTH
    camera.matrix_world = (Matrix.Translation(aim - forward * distance)
                           @ look_at_matrix(forward).to_4x4())
    camera.data.clip_start = max(distance * 0.02, 0.005)
    camera.data.clip_end = max(distance * 4.0, 100.0)
    return distance


def aim_orthographic(camera, aim, forward, ortho_scale, depth):
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = ortho_scale
    camera.matrix_world = (Matrix.Translation(aim - forward * depth)
                           @ look_at_matrix(forward).to_4x4())
    camera.data.clip_start = 0.01 * depth
    camera.data.clip_end = 100.0 * depth


def add_area_light(collection, name, aim, offset, scale, power, color):
    location = aim + offset
    distance = offset.length
    data = bpy.data.lights.new(name, "AREA")
    data.shape = "RECTANGLE"
    data.size = scale
    data.size_y = scale * 0.62
    data.energy = power * (distance / 2.0) ** 2
    data.color = color
    node = bpy.data.objects.new(name, data)
    node.location = location
    node.rotation_euler = look_at_matrix(aim - location).to_4x4().to_euler()
    collection.objects.link(node)
    return node


def add_floor(collection, aim, span, top_z):
    mesh = bpy.data.meshes.new("OMPW floor")
    half = span * 0.5
    mesh.from_pydata([(-half, -half, 0.0), (half, -half, 0.0),
                      (half, half, 0.0), (-half, half, 0.0)], [], [(0, 1, 2, 3)])
    mesh.update()

    material = bpy.data.materials.new("OMPW floor dark")
    if not material.use_nodes:  # always node-based from Blender 5 on
        material.use_nodes = True
    for node in material.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            node.inputs["Base Color"].default_value = FLOOR_COLOR
            node.inputs["Roughness"].default_value = 0.55
            if "Metallic" in node.inputs:
                node.inputs["Metallic"].default_value = 0.0
    mesh.materials.append(material)

    node = bpy.data.objects.new("OMPW floor", mesh)
    node.location = (aim.x, aim.y, top_z)
    collection.objects.link(node)
    return node


def add_world(scene):
    world = bpy.data.worlds.new("OMPW studio world")
    if not world.use_nodes:  # always node-based from Blender 5 on
        world.use_nodes = True
    background = next(node for node in world.node_tree.nodes if node.type == "BACKGROUND")
    background.inputs["Color"].default_value = WORLD_GREY
    background.inputs["Strength"].default_value = 1.0
    scene.world = world
    return world


# ------------------------------------------------------------------ render


def configure_render(scene):
    scene.render.engine = ENGINE
    scene.render.resolution_x = RES_X
    scene.render.resolution_y = RES_Y
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.display_settings.display_device = "sRGB"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "None"

    if ENGINE == "CYCLES":
        scene.cycles.samples = SAMPLES
        scene.cycles.seed = SEED
        scene.cycles.use_animated_seed = False
        scene.cycles.use_adaptive_sampling = False
        scene.cycles.use_denoising = True
        if FORCE_CPU:
            scene.cycles.device = "CPU"
    else:
        scene.eevee.taa_render_samples = SAMPLES


def render_view(scene, camera, path):
    scene.camera = camera
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)

    image = bpy.data.images.load(str(path), check_existing=False)
    try:
        return int(image.size[0]), int(image.size[1])
    finally:
        bpy.data.images.remove(image)


def main():
    started = time.time()
    source_scene = bpy.context.scene
    source_window = bpy.context.window
    original_frame = source_scene.frame_current
    ASSET_DIR.mkdir(parents=True, exist_ok=True)

    parts, strategy = choose_parts(source_scene)
    forward, right, up, forward_note = model_basis(source_scene)

    studio = bpy.data.scenes.new("OMPW | weapon review studio")
    weapon_collection = bpy.data.collections.new("OMPW weapon")
    rig_collection = bpy.data.collections.new("OMPW studio rig")
    studio.collection.children.link(weapon_collection)
    studio.collection.children.link(rig_collection)
    configure_render(studio)
    add_world(studio)

    baked, skipped = bake_model(source_scene, parts, weapon_collection)
    source_scene.frame_set(original_frame)  # leave the opened study as we found it
    low, high = bounds_of(baked)
    aim = (low + high) * 0.5
    corners = corner_points(low, high)
    offsets = [corner - aim for corner in corners]
    along = [offset.dot(forward) for offset in offsets]
    across = [offset.dot(right) for offset in offsets]
    rising = [offset.dot(up) for offset in offsets]
    length = max(along) - min(along)
    width = max(across) - min(across)
    height = max(rising) - min(rising)
    if length <= 0.0 or height <= 0.0:
        die("weapon geometry is degenerate: %s .. %s" % (tuple(low), tuple(high)))

    # Sight line: the optic/sight nodes give the aperture the ADS view frames.
    sight_nodes = [o for o in baked if SIGHT_RE.search(o.name)]
    sight_reference = "sight node" if sight_nodes else "model top"
    sight_points = [point for node in (sight_nodes or baked) for point in box_of(node)]
    sight_top = max(point.z for point in sight_points)

    # The ADS view frames the optic aperture: prefer the node that names one,
    # then the sight nodes, then simply the top band of the model (a merged
    # mesh study has no part names left to read).
    aperture_nodes = [o for o in sight_nodes if APERTURE_RE.search(o.name)]
    if aperture_nodes:
        aperture_reference = "aperture node (%s)" % ", ".join(
            sorted(node.name for node in aperture_nodes)[:3])
        aperture_points = [point for node in aperture_nodes for point in box_of(node)]
    elif sight_nodes:
        aperture_reference = "sight nodes"
        aperture_points = sight_points
    else:
        aperture_reference = "top band of the model"
        cut = sight_top - height * 0.05
        aperture_points = [point for node in baked for point in points_of(node)
                           if point.z >= cut]

    aperture_low = Vector((min(p.x for p in aperture_points),
                           min(p.y for p in aperture_points),
                           min(p.z for p in aperture_points)))
    aperture_high = Vector((max(p.x for p in aperture_points),
                            max(p.y for p in aperture_points),
                            max(p.z for p in aperture_points)))
    aperture = (aperture_low + aperture_high) * 0.5
    aperture_high_z = aperture_high.z

    camera = bpy.data.objects.new("OMPW camera", bpy.data.cameras.new("OMPW camera"))
    rig_collection.objects.link(camera)

    scale = max(length, height)
    radius = 0.5 * (high - low).length
    light_aim = aim + up * (height * 0.05)
    add_area_light(rig_collection, "OMPW key", light_aim,
                   (forward * 1.30 - right * 1.10 + up * 1.50).normalized() * (1.90 * scale),
                   1.15 * scale, KEY_POWER, (1.0, 0.98, 0.95))
    add_area_light(rig_collection, "OMPW edge", light_aim,
                   (-forward * 1.25 + right * 1.40 + up * 1.00).normalized() * (2.00 * scale),
                   0.85 * scale, EDGE_POWER, (0.94, 0.96, 1.0))
    add_area_light(rig_collection, "OMPW fill", light_aim,
                   (forward * 0.85 + right * 1.50 + up * 0.35).normalized() * (2.20 * scale),
                   2.00 * scale, FILL_POWER, (1.0, 1.0, 1.0))
    add_floor(rig_collection, aim, 10.0 * scale, low.z - 0.002 * scale)

    bpy.context.window.scene = studio

    def whole_model_distance(view_aim, eye, lens):
        """Back the camera off the aim point until every corner fits."""
        direction = (view_aim - eye).normalized()
        return max(fitted_distance(view_aim, direction, corners, lens, 1.10),
                   1.05 * radius)

    hero_eye = aim + (forward * 0.95 - right * 1.05 + up * 0.55).normalized()
    rear_eye = aim + (-forward * 0.95 + right * 1.05 + up * 0.55).normalized()

    # ADS view. When the study names its optic the shot is a close-up on the
    # aperture ring, standing just behind it, a little above and off to one
    # side. A merged-mesh study has no such node, so fall back to a sight-line
    # view that keeps the whole weapon readable from behind and above.
    if aperture_nodes or sight_nodes:
        ads_lens = ADS_LENS
        ads_eye = Vector((aperture.x + width * ADS_SIDE_OFFSET,
                          aperture.y - forward.y * length * ADS_BACK_FRACTION,
                          aperture.z + height * ADS_LIFT))
        ads_aim = aperture + forward * (length * 0.05)
        ads_distance = (ads_aim - ads_eye).length
    else:
        ads_lens = 35.0
        ads_eye = Vector((aim.x, aim.y - forward.y * length * 0.55,
                          sight_top + height * 0.05))
        ads_aim = Vector((aim.x, aim.y + forward.y * length * 0.90,
                          sight_top - height * 0.02))
        ads_distance = max((ads_aim - ads_eye).length,
                           whole_model_distance(ads_aim, ads_eye, ads_lens))

    views = {
        "hero": {"aim": aim, "eye": hero_eye, "lens": 40.0,
                 "distance": whole_model_distance(aim, hero_eye, 40.0)},
        "side": {"aim": aim, "forward": -right, "ortho": 1.15 * length},
        "ads": {"aim": ads_aim, "eye": ads_eye, "lens": ads_lens,
                "distance": ads_distance},
        "rear": {"aim": aim, "eye": rear_eye, "lens": 40.0,
                 "distance": whole_model_distance(aim, rear_eye, 40.0)},
    }

    outputs = []
    for view, filename in VIEW_FILES:
        spec = views[view]
        if "ortho" in spec:
            aim_orthographic(camera, spec["aim"], spec["forward"], spec["ortho"],
                             depth=3.0 * scale)
        else:
            aim_perspective(camera, spec["aim"], spec["eye"], spec["lens"],
                            spec["distance"])
        path = ASSET_DIR / filename
        width_px, height_px = render_view(studio, camera, path)
        outputs.append({
            "view": view,
            "path": str(path),
            "width": width_px,
            "height": height_px,
            "bytes": path.stat().st_size,
            "camera": {
                "type": camera.data.type,
                "lens_mm": round(camera.data.lens, 3) if camera.data.type == "PERSP" else None,
                "ortho_scale": round(camera.data.ortho_scale, 4) if camera.data.type == "ORTHO" else None,
                "distance": round(spec.get("distance", 3.0 * scale), 4),
                "location": [round(value, 4) for value in camera.location],
                "aim": [round(value, 4) for value in spec["aim"]],
            },
        })
        print("OMPW rendered %-5s -> %s" % (view, path))

    summary = {
        "script": "tools/blender/omp-weapon/render-views.py",
        "source_file": bpy.data.filepath,
        "source_scene": source_scene.name,
        "model_selection": strategy,
        "model_parts": len(baked),
        "model_parts_skipped": skipped,
        "forward_axis": "+Y" if forward.y > 0 else "-Y",
        "forward_note": forward_note,
        "sight_reference": sight_reference,
        "aperture_reference": aperture_reference,
        "aperture_center": [round(value, 4) for value in aperture],
        "bounds_min": [round(value, 4) for value in low],
        "bounds_max": [round(value, 4) for value in high],
        "extents": {"length": round(length, 4), "width": round(width, 4),
                    "height": round(height, 4)},
        "engine": ENGINE,
        "samples": SAMPLES,
        "force_cpu": FORCE_CPU,
        "resolution": [RES_X, RES_Y],
        "seed": SEED,
        "view_transform": studio.view_settings.view_transform,
        "duration_s": round(time.time() - started, 2),
        "outputs": outputs,
    }
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
