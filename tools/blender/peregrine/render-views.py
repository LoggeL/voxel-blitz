#!/usr/bin/env python3
"""Render four studio review views of the PEREGRINE sniper study.

Run it against the editable study file; the script never writes to that file,
never touches the KESTREL / RIVET studies that share the same .blend, and
renders from a temporary scene of its own:

    PREG_SAMPLES=64 PREG_FORCE_CPU=1 blender --background \
        docs/design/blender/peregrine/peregrine.blend \
        --python tools/blender/peregrine/render-views.py

It selects the scene named 'PEREGRINE | Voxel Blitz sniper study' (or the first
scene whose name starts with PEREGRINE), takes the weapon meshes from the
`body` / `mag` / `bolt` / `trigger` / `factory-optic` / `extra` part hierarchy
(plus any mesh carrying a `part` custom property), bakes their evaluated
(modifier-applied) geometry into a brand new temporary scene, builds a camera /
three-light / floor studio around it, frames every shot from the model's own
measured bounding box, and writes:

    render-hero.png   3/4 hero from front-left-above, 40 mm: muzzle, exposed
                      fluted bore, long bolt handle and skeletal stock
    render-side.png   orthographic true side profile from the gun's right, so
                      the whole 1.12 m silhouette lies on the frame's wide axis
    render-ads.png    the sight picture: camera exactly on the optical axis,
                      0.114 m behind the rear lens, 60 mm, so the eyepiece ring
                      overflows the frame and the tube bore and objective sit
                      concentric down the middle (a fitted end-on shot only
                      projects the rifle's cross-section and collapses)
    render-rear.png   3/4 rear from behind-left-above, 40 mm: bolt shroud,
                      eyepiece, cheek riser, recoil pad and the stock triangle

The three `extra` stripper rounds are excluded by default: the runtime hides
them outside the reload animation and, parked on their authored positions, they
float in mid-air over the receiver and read as a modelling fault in a review
render. PREG_ROUNDS=1 puts them back in for a reload-choreography check.

Environment overrides:
    PREG_ASSET_DIR   output directory (default docs/design/blender/peregrine)
    PREG_SAMPLES     Cycles samples (default 48)
    PREG_FORCE_CPU   1 to pin Cycles to the CPU and skip Metal/GPU device setup
    PREG_ROUNDS      1 to render the three `extra` stripper rounds as well
    PREG_MARGIN      framing air as a multiple of the fitted box (default 1.12)

The last line of stdout is a one-line JSON summary of the written files.
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

SCENE_NAME = "PEREGRINE | Voxel Blitz sniper study"
SCENE_PREFIX = "PEREGRINE"

# The study's own root nodes, as the game consumes them. Blender appends a
# numeric suffix to a name another open study already owns (`muzzle.001`), so
# every contract name is compared with its suffix stripped.
PART_GROUPS = ("body", "mag", "bolt", "trigger", "factory-optic", "extra")
MARKER_NODES = ("muzzle", "grip", "support", "sight")
ROUND_GROUP = "extra"
OPTIC_GROUP = "factory-optic"
GLASS_MATERIAL = "optic glass"

# Meshes that belong to study furniture rather than to the weapon. Furniture is
# named for what it is up front; a part like `Magazine floor plate` is not one.
STUDIO_PROP_RE = re.compile(
    r"^(studio|stage|scene|render|review|backdrop)?[\s_\-]*"
    r"(ground|floor|backdrop|cyclorama|plane|grid|shadow\s*catcher)\b", re.I)

RES_X, RES_Y = 1600, 1000
SENSOR_WIDTH = 36.0   # mm, full-frame; sensor_fit HORIZONTAL owns the wide axis
SEED = 20260914

# Light power scales with the square of each light's distance so the studio
# keeps the same exposure whatever the model size.
KEY_POWER = 620.0
EDGE_POWER = 430.0
FILL_POWER = 300.0

# Dim ambient on purpose: the runtime scene has no environment map, so the
# renders must not sell light the game cannot deliver.
WORLD_GREY = (0.15, 0.15, 0.16, 1.0)
FLOOR_COLOR = (0.022, 0.022, 0.025, 1.0)

# Clear radius the brief freezes for the objective: the sight line is audited
# against it, and the ADS shot is the visual proof of the same number.
SIGHT_CLEAR_RADIUS = 0.040

HERO_LENS = 40.0
REAR_LENS = 40.0
ADS_LENS = 60.0
# ADS is the sight picture: the camera stands on the frozen optical axis itself,
# behind the rear lens, looking straight down the tube. At this stand-off the
# eyepiece ring (0.0395 radius, measured on the model) just overflows the frame
# and the tube bore and the objective lens sit concentric behind it down the
# middle, which is the clear sight line the view exists to show. Anywhere
# further back is useless: end-on, a 1.12 m rifle only projects its 0.18 x
# 0.42 m cross-section, so the whole weapon collapses into a blob in an empty
# frame - which is exactly what a fitted end-on shot produced.
ADS_STANDOFF = 0.227   # eye stand-off behind the rear lens, / sight length

Z_AXIS = Vector((0.0, 0.0, 1.0))


def die(message):
    sys.stderr.write("PREG error: %s\n" % message)
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


def env_float(name, default):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        die("%s must be a number, got %r" % (name, raw))
    if not math.isfinite(value) or value <= 0.0:
        die("%s must be > 0, got %r" % (name, raw))
    return value


# ------------------------------------------------------------------- setup

ASSET_DIR = Path(os.path.abspath(os.path.expanduser(
    os.environ.get("PREG_ASSET_DIR", "").strip() or "docs/design/blender/peregrine")))
SAMPLES = env_int("PREG_SAMPLES", 48)
FORCE_CPU = env_flag("PREG_FORCE_CPU")
SHOW_ROUNDS = env_flag("PREG_ROUNDS")
MARGIN = env_float("PREG_MARGIN", 1.12)
ORTHO_MARGIN = 1.0 + (MARGIN - 1.0) * 0.6


# -------------------------------------------------------- model discovery


def base_name(obj):
    """`Round 1.002` -> `round 1`."""
    return re.sub(r"\.\d+$", "", obj.name).strip().lower()


def is_studio_prop(obj):
    return bool(STUDIO_PROP_RE.search(obj.name))


def round_mesh(obj):
    """A mesh of the `extra` stripper-round group, however it is parented."""
    return obj.type == "MESH" and (
        obj.get("part") == ROUND_GROUP
        or (obj.parent is not None and base_name(obj.parent) == ROUND_GROUP))


def choose_scene():
    """The PEREGRINE study only; the file also holds the KESTREL/RIVET studies."""
    scene = bpy.data.scenes.get(SCENE_NAME)
    if scene is not None:
        return scene, "exact-name"
    for candidate in bpy.data.scenes:
        if candidate.name.startswith(SCENE_PREFIX):
            return candidate, "prefix"
    die("no scene named %r (or starting with %r) in %s"
        % (SCENE_NAME, SCENE_PREFIX, bpy.data.filepath or "the loaded file"))


def choose_parts(scene):
    """Pick the weapon meshes from the study hierarchy, most explicit rule first."""
    meshes = [o for o in scene.objects if o.type == "MESH"]
    if not meshes:
        die("scene %r contains no mesh objects" % scene.name)

    roots = [o for o in scene.objects if o.parent is None]
    groups = [o for o in roots if base_name(o) in PART_GROUPS]
    selected = []
    strategy = "all-meshes"

    if groups:
        # 1. The study contract: the part empties own every weapon mesh.
        #    Membership is decided by the hierarchy, so no part name has to look
        #    like a weapon name.
        pending, seen = list(groups), set()
        while pending:
            node = pending.pop()
            if node in seen:
                continue
            seen.add(node)
            pending.extend(node.children)
            if node.type == "MESH":
                selected.append(node)
        # 2. Belt and braces: a mesh that fell out of the hierarchy but still
        #    carries the `part` custom property the exporter writes.
        for mesh in meshes:
            if mesh not in selected and mesh.get("part") in PART_GROUPS:
                selected.append(mesh)
        strategy = "contract-parts"

    if not selected:
        # 3. Last resort: an authored file with no part hierarchy at all.
        others = [o for o in meshes if not is_studio_prop(o)]
        renderable = [o for o in others if not o.hide_render]
        selected = renderable or others or meshes

    hidden = [o.name for o in selected if o.hide_render]
    keep = [o for o in selected if not o.hide_render]
    rounds = [o for o in keep if round_mesh(o)]
    if not SHOW_ROUNDS:
        keep = [o for o in keep if o not in rounds]
    if not keep:
        die("scene %r has no renderable weapon meshes" % scene.name)
    return sorted(keep, key=lambda o: o.name), strategy, rounds, hidden


def bake_model(objects, collection):
    """Copy evaluated model geometry into the studio scene, in world space."""
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
        baked.append((source, node))

    if not baked:
        die("no renderable geometry found; skipped: %s" % (", ".join(skipped) or "nothing"))
    return baked, skipped


def points_of(obj):
    matrix = obj.matrix_world
    return [matrix @ vertex.co for vertex in obj.data.vertices]


def bounds_of(nodes):
    low = Vector((math.inf,) * 3)
    high = Vector((-math.inf,) * 3)
    for node in nodes:
        for point in points_of(node):
            for axis in range(3):
                low[axis] = min(low[axis], point[axis])
                high[axis] = max(high[axis], point[axis])
    return low, high


def box_of(obj):
    matrix = obj.matrix_world
    return [matrix @ Vector(corner) for corner in obj.bound_box]


def centre_of(obj):
    corners = box_of(obj)
    return sum(corners, Vector((0.0, 0.0, 0.0))) / len(corners)


def corner_points(low, high):
    return [Vector((x, y, z))
            for x in (low.x, high.x)
            for y in (low.y, high.y)
            for z in (low.z, high.z)]


def model_basis():
    """The study is authored +Y barrel / +Z up / +X right, and the contract
    freezes the muzzle on +Y, so the basis is fixed rather than guessed."""
    forward = Vector((0.0, 1.0, 0.0))
    right = forward.cross(Z_AXIS).normalized()
    return forward, right, Z_AXIS.copy()


def optical_axis(pairs):
    """Optical axis from the two optic-glass lenses: the model's own evidence.

    The study marks its lens meshes with the `peregrine_material` property, so
    the axis is read off the geometry instead of an English node name. The
    `sight` marker and the barrel direction are the fallbacks.
    """
    glass = [(source, node) for (source, node) in pairs
             if source.get("peregrine_material") == GLASS_MATERIAL]
    if len(glass) < 2:
        return None, None, None, "no optic glass (%d lens mesh(es))" % len(glass)

    centres = sorted((centre_of(node) for _source, node in glass),
                     key=lambda point: point.y)
    rear, front = centres[0], centres[-1]
    axis = (front - rear).normalized()
    return rear, front, axis, ("%d optic glass mesh(es): rear lens y=%+.3f, "
                               "front lens y=%+.3f, tube %.3f m"
                               % (len(glass), rear.y, front.y, (front - rear).length))


def sight_line_audit(pairs, origin, axis, span, radius):
    """Vertices of non-optic parts that intrude on the frozen sight line."""
    offenders = []
    for source, node in pairs:
        if source.get("part") == OPTIC_GROUP:
            continue  # the optic is what the sight line runs through
        for point in points_of(node):
            offset = point - origin
            along = offset.dot(axis)
            if along < 0.0 or along > span:
                continue
            if (offset - axis * along).length < radius:
                offenders.append(source.name)
    return sorted(set(offenders))


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


def fitted_distance(aim, forward, corners, lens, margin):
    """Distance along `forward` at which every model corner fits the frame.

    `forward` is the camera's own view direction, so a corner sits
    `distance + offset.dot(forward)` deep in the frame and the corner nearest
    the camera is the one that decides the framing.
    """
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


def fitted_ortho_scale(aim, forward, corners, margin):
    """Ortho scale that fits the measured box, whichever axis is the long one."""
    right = forward.cross(Z_AXIS).normalized()
    up = right.cross(forward)
    half_x = max(abs((corner - aim).dot(right)) for corner in corners)
    half_y = max(abs((corner - aim).dot(up)) for corner in corners)
    return 2.0 * max(half_x, half_y * RES_X / RES_Y) * margin


def aim_perspective(camera, aim, eye, lens, distance):
    """Stand at `aim + eye * distance` and look back at `aim`.

    `eye` points from the aim towards the camera, so the camera ends up on the
    side the caller asked for and looks along the negative of that direction.
    """
    unit = eye.normalized()
    forward = -unit
    camera.data.type = "PERSP"
    camera.data.lens = lens
    camera.data.sensor_width = SENSOR_WIDTH
    camera.data.sensor_fit = "HORIZONTAL"
    camera.data.clip_start = max(distance * 0.02, 0.005)
    camera.data.clip_end = max(distance * 4.0, 100.0)
    camera.matrix_world = (Matrix.Translation(aim + unit * distance)
                           @ look_at_matrix(forward).to_4x4())


def aim_orthographic(camera, aim, forward, ortho_scale, depth):
    camera.data.type = "ORTHO"
    camera.data.sensor_fit = "HORIZONTAL"
    camera.data.ortho_scale = ortho_scale
    camera.data.clip_start = 0.01 * depth
    camera.data.clip_end = 100.0 * depth
    camera.matrix_world = (Matrix.Translation(aim - forward.normalized() * depth)
                           @ look_at_matrix(forward).to_4x4())


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
    mesh = bpy.data.meshes.new("PREG floor")
    half = span * 0.5
    mesh.from_pydata([(-half, -half, 0.0), (half, -half, 0.0),
                      (half, half, 0.0), (-half, half, 0.0)], [], [(0, 1, 2, 3)])
    mesh.update()

    material = bpy.data.materials.new("PREG floor dark")
    material.use_nodes = True
    for node in material.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            node.inputs["Base Color"].default_value = FLOOR_COLOR
            node.inputs["Roughness"].default_value = 0.55
            if "Metallic" in node.inputs:
                node.inputs["Metallic"].default_value = 0.0
    mesh.materials.append(material)

    node = bpy.data.objects.new("PREG floor", mesh)
    node.location = (aim.x, aim.y, top_z)
    collection.objects.link(node)
    return node


def add_world(scene):
    world = bpy.data.worlds.new("PREG studio world")
    world.use_nodes = True
    background = next(node for node in world.node_tree.nodes if node.type == "BACKGROUND")
    background.inputs["Color"].default_value = WORLD_GREY
    background.inputs["Strength"].default_value = 1.0
    scene.world = world
    return world


# ------------------------------------------------------------------ render


def configure_render(scene):
    scene.render.engine = "CYCLES"
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
    scene.cycles.samples = SAMPLES
    scene.cycles.seed = SEED
    scene.cycles.use_animated_seed = False
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.use_denoising = True
    if FORCE_CPU:
        scene.cycles.device = "CPU"


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
    source_scene, scene_rule = choose_scene()
    source_objects = set(source_scene.objects)
    ASSET_DIR.mkdir(parents=True, exist_ok=True)

    parts, strategy, rounds, hidden = choose_parts(source_scene)
    forward, right, up = model_basis()

    studio = bpy.data.scenes.new("PREG | sniper review studio")
    weapon_collection = bpy.data.collections.new("PREG weapon")
    rig_collection = bpy.data.collections.new("PREG studio rig")
    studio.collection.children.link(weapon_collection)
    studio.collection.children.link(rig_collection)
    configure_render(studio)
    add_world(studio)

    pairs, skipped = bake_model(parts, weapon_collection)
    baked = [node for _source, node in pairs]
    low, high = bounds_of(baked)
    aim = (low + high) * 0.5
    corners = corner_points(low, high)
    length = high.y - low.y
    width = high.x - low.x
    height = high.z - low.z
    if length <= 0.0 or height <= 0.0:
        die("weapon geometry is degenerate: %s .. %s" % (tuple(low), tuple(high)))
    scale = max(length, height)
    radius = 0.5 * (high - low).length

    # Optical axis first, because the ADS shot is aimed along it, then the
    # sight-line audit that same shot is the visual proof of.
    rear_lens, front_lens, axis, axis_note = optical_axis(pairs)
    if rear_lens is None:
        marker = next((o for o in source_scene.objects
                       if base_name(o) == "sight" and o.type == "EMPTY"), None)
        rear_lens = (marker.matrix_world.translation.copy() if marker
                     else Vector((0.0, low.y + 0.20 * length, high.z)))
        front_lens = rear_lens + forward * (0.45 * length)
        axis = forward.copy()
        axis_note += "; fell back to the %s" % ("sight marker" if marker else "model top")
    axis = axis.normalized()
    exit_along = (high - rear_lens).dot(axis)
    blockers = sight_line_audit(pairs, rear_lens, axis, exit_along, SIGHT_CLEAR_RADIUS)

    camera = bpy.data.objects.new("PREG camera", bpy.data.cameras.new("PREG camera"))
    rig_collection.objects.link(camera)

    light_aim = aim + up * (height * 0.05)
    add_area_light(rig_collection, "PREG key", light_aim,
                   (forward * 1.30 - right * 1.10 + up * 1.50).normalized() * (1.90 * scale),
                   1.15 * scale, KEY_POWER, (1.0, 0.98, 0.95))
    add_area_light(rig_collection, "PREG edge", light_aim,
                   (-forward * 1.25 + right * 1.40 + up * 1.00).normalized() * (2.00 * scale),
                   0.85 * scale, EDGE_POWER, (0.94, 0.96, 1.0))
    add_area_light(rig_collection, "PREG fill", light_aim,
                   (forward * 0.85 + right * 1.50 + up * 0.35).normalized() * (2.20 * scale),
                   2.00 * scale, FILL_POWER, (1.0, 1.0, 1.0))
    add_floor(rig_collection, aim, 10.0 * scale, low.z - 0.002 * scale)

    bpy.context.window.scene = studio

    def body_distance(view_aim, eye, lens):
        """Back the camera off the aim until every measured corner fits."""
        return max(fitted_distance(view_aim, -eye.normalized(), corners, lens, MARGIN),
                   1.05 * radius)

    # Each entry points from the aim towards the camera.
    hero_eye = (forward * 0.95 - right * 1.05 + up * 0.55).normalized()
    # Rear reads the same action flank as the hero, from the stock end: bolt
    # shroud, eyepiece, cheek riser, recoil pad and the open stock triangle.
    rear_eye = (-forward * 0.95 - right * 1.05 + up * 0.55).normalized()
    # ADS: exactly on the frozen optical axis, looking down it from behind the
    # eyepiece. The stand-off is a fraction of the measured sight length rather
    # than a fixed metre value, so the shot survives small model changes.
    ads_aim = rear_lens.copy()
    ads_eye = -axis
    ads_distance = ADS_STANDOFF * (front_lens - rear_lens).length

    views = {
        "hero": {"aim": aim, "eye": hero_eye, "lens": HERO_LENS,
                 "distance": body_distance(aim, hero_eye, HERO_LENS)},
        "side": {"aim": aim, "forward": -right,
                 "ortho": fitted_ortho_scale(aim, -right, corners, ORTHO_MARGIN)},
        "ads": {"aim": ads_aim, "eye": ads_eye, "lens": ADS_LENS,
                "distance": ads_distance},
        "rear": {"aim": aim, "eye": rear_eye, "lens": REAR_LENS,
                 "distance": body_distance(aim, rear_eye, REAR_LENS)},
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
        print("PREG rendered %-5s -> %s" % (view, path))

    summary = {
        "script": "tools/blender/peregrine/render-views.py",
        "source_file": bpy.data.filepath,
        "source_scene": source_scene.name,
        "scene_rule": scene_rule,
        "scenes_in_file": sorted(scene.name for scene in bpy.data.scenes
                                if scene is not studio),
        "model_selection": strategy,
        "model_parts": len(baked),
        "model_parts_skipped": skipped,
        "model_parts_hidden": hidden,
        "part_groups_present": sorted(base_name(o) for o in source_objects
                                      if o.parent is None and base_name(o) in PART_GROUPS),
        "marker_nodes_present": sorted(base_name(o) for o in source_objects
                                       if o.parent is None and base_name(o) in MARKER_NODES),
        "rounds_total": len(rounds),
        "rounds_rendered": SHOW_ROUNDS,
        "rounds_note": ("rendered" if SHOW_ROUNDS else
                        "excluded: the runtime hides them outside the reload "
                        "animation and their authored positions float over the receiver"),
        "bounds_min": [round(value, 4) for value in low],
        "bounds_max": [round(value, 4) for value in high],
        "extents": {"length_y": round(length, 4), "width_x": round(width, 4),
                    "height_z": round(height, 4)},
        "optical_axis": {
            "source": axis_note,
            "origin": [round(value, 4) for value in rear_lens],
            "direction": [round(value, 4) for value in axis],
        },
        "ads_framing": {
            "note": "sight picture: camera on the optical axis behind the rear lens",
            "off_axis_deg": round(math.degrees(
                math.acos(max(-1.0, min(1.0, (axis * -1.0).dot(ads_eye))))), 2),
            "aim": [round(value, 4) for value in ads_aim],
        },
        "sight_line": {
            "clear_radius": SIGHT_CLEAR_RADIUS,
            "span_forward_of_rear_lens": round(exit_along, 4),
            "blocked_by": blockers,
        },
        "engine": "CYCLES",
        "samples": SAMPLES,
        "force_cpu": FORCE_CPU,
        "resolution": [RES_X, RES_Y],
        "resolution_ok": all(o["width"] >= RES_X and o["height"] >= RES_Y for o in outputs),
        "seed": SEED,
        "view_transform": studio.view_settings.view_transform,
        "margin": MARGIN,
        "duration_s": round(time.time() - started, 2),
        "outputs": outputs,
    }
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
