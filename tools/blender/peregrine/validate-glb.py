#!/usr/bin/env python3
"""Independently validate the PEREGRINE delivery by re-importing it fresh.

Both delivered artefacts are loaded into a brand-new empty factory scene and
measured against the frozen runtime contract in
`docs/design/blender/peregrine/build-request.md`:

  * `docs/design/blender/peregrine/peregrine.glb`      (embedded textures)
  * `public/assets/blender/peregrine.gltf` + sibling   (external .bin/textures)

Nothing here trusts the build scripts: the delivered files are the only input.
Every contract item becomes a named boolean check carrying the value that was
actually measured, so a failing check can never be mistaken for a pass.

Blender's glTF importer bakes the Y-up -> Z-up conversion into the imported mesh
data and object transforms, so every measurement below is converted back to the
gun-local runtime frame (-Z forward, +Y up, +X right) with:

    game_x = blender_x,  game_y = blender_z,  game_z = -blender_y

Usage:
    blender --background --factory-startup --python validate-glb.py -- \\
        [<peregrine.glb> <peregrine.gltf> <validation.json>]

Fallbacks (used when the corresponding CLI argument is absent):
    PEREGRINE_GLB, PEREGRINE_GLTF, PEREGRINE_JSON

Exit codes: 0 report written (pass or fail), 1 bad usage, 2 import/report error.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import struct
import sys
import traceback

import bpy
import numpy as np
from mathutils import Matrix

# --------------------------------------------------------------------------- #
# Frozen contract
# --------------------------------------------------------------------------- #
REPO_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_GLB = os.path.join(
    REPO_ROOT, "docs", "design", "blender", "peregrine", "peregrine.glb")
DEFAULT_GLTF = os.path.join(
    REPO_ROOT, "public", "assets", "blender", "peregrine.gltf")
DEFAULT_JSON = os.path.join(
    REPO_ROOT, "docs", "design", "blender", "peregrine", "validation.json")

# Top-level glTF node names: six mesh-bearing parts plus four non-mesh markers.
PARTS = ("body", "mag", "bolt", "trigger", "factory-optic", "extra")
MARKERS = ("muzzle", "grip", "support", "sight")
EXPECTED_TOP_LEVEL = frozenset(PARTS) | frozenset(MARKERS)
# Parts whose node transform must be identity (vertices baked into gun space).
IDENTITY_PARTS = ("body", "mag", "bolt", "trigger", "factory-optic")

ANCHORS = {
    "muzzle": (0.000, 0.055, -0.760),
    "grip": (0.045, 0.020, -0.130),
    "support": (-0.055, -0.010, -0.480),
}
SIGHT_Y = 0.205
FORWARD_MOST_Z = -0.760
BORE_AXIS_XY = (0.0, 0.055)
BORE_RADIUS = 0.0210

ROUNDS = ("Round 1", "Round 2", "Round 3")
# Authored pose: staged side by side in the mount-base tray between the
# uprights. The runtime builder re-poses every round on load (peregrine.js
# CARTRIDGE_*), so this pins the file pose only.
ROUND_TRANSLATIONS = {
    "Round 1": (-0.014, 0.1295, -0.030),
    "Round 2": (0.0, 0.1295, -0.030),
    "Round 3": (0.014, 0.1295, -0.030),
}
ROUND_SIZE = (0.012, 0.012, 0.050)   # 12 mm x 12 mm x 50 mm along the bore
ROUND_SIZE_TOL = 0.20                # "about 12 x 12 x 50 mm" -> +/- 20 %

TRIANGLE_MIN, TRIANGLE_MAX = 10000, 20000
# The frozen delivered count, agreed by both files.  (19,808: full-length
# mount base, third forward ring, rounds staged in the mount tray.)
EXPECTED_TRIANGLES = 19808
EXPECTED_PRIMITIVES = 19
EXPECTED_IMAGES = 6
PRIMITIVE_BUDGET = 24
MATERIAL_BUDGET = 8

# material name -> texture stem (None = untextured)
MATERIAL_TEXTURE_MAP = {
    "PEREGRINE | gunmetal": "worn-gunmetal",
    "PEREGRINE | orange paint": "orange-painted-metal",
    "PEREGRINE | ivory coating": "ivory-armor",
    "PEREGRINE | petrol fabric": "petrol-ballistic-fabric",
    "PEREGRINE | tan webbing": "tan-webbing",
    "PEREGRINE | rubber": "worn-rubber",
    "PEREGRINE | optic glass": None,
}
OPTIC_GLASS = "PEREGRINE | optic glass"

# Tolerances.  Coordinates: 1e-5 m = 0.01 mm, far above float32 round-trip
# error (~1e-8 at these magnitudes) and far below any visible placement error.
COORD_TOL = 1e-5
IDENTITY_TOL = 1e-6
# Finite-difference window for "the vertices forming the muzzle face".
FACE_EPS = 1e-4
# Triangle area at or below this (m^2) counts as exactly degenerate.
AREA_EPS = 1e-12

# Blender -> gun-local rotation (+90 deg about X), as a 4x4.
_GUN_FROM_BLENDER = np.array([
    [1.0, 0.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0],
    [0.0, -1.0, 0.0, 0.0],
    [0.0, 0.0, 0.0, 1.0],
], dtype=np.float64)


# --------------------------------------------------------------------------- #
# CLI / source parsing
# --------------------------------------------------------------------------- #
def parse_cli(argv):
    """Return (glb, gltf, json) from post-`--` args with repo-root defaults."""
    args = argv[argv.index("--") + 1:] if "--" in argv else []

    def pick(index, env, default):
        if len(args) > index and args[index]:
            return args[index]
        return os.environ.get(env) or default

    return (pick(0, "PEREGRINE_GLB", DEFAULT_GLB),
            pick(1, "PEREGRINE_GLTF", DEFAULT_GLTF),
            pick(2, "PEREGRINE_JSON", DEFAULT_JSON))


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_gltf_json(path):
    """Return the glTF JSON dict for a .gltf or binary .glb file."""
    with open(path, "rb") as handle:
        blob = handle.read()
    if blob[:4] == b"glTF":
        return json.loads(glb_json_chunk(blob).decode("utf-8"))
    return json.loads(blob.decode("utf-8"))


def glb_chunks(blob):
    """Yield (chunk_type, payload) for every chunk of a GLB container."""
    if blob[:4] != b"glTF" or len(blob) < 12:
        return
    _magic, _version, total = struct.unpack_from("<III", blob, 0)
    offset = 12
    while offset + 8 <= min(total, len(blob)):
        chunk_len, chunk_type = struct.unpack_from("<II", blob, offset)
        offset += 8
        yield chunk_type, blob[offset:offset + chunk_len]
        offset += chunk_len


def glb_json_chunk(blob):
    for chunk_type, payload in glb_chunks(blob):
        if chunk_type == 0x4E4F534A:          # 'JSON'
            return payload
    raise ValueError("GLB has no JSON chunk")


def glb_binary_chunk(blob):
    for chunk_type, payload in glb_chunks(blob):
        if chunk_type == 0x004E4942:          # 'BIN'
            return payload
    return b""


def buffer_payloads(doc, source_path):
    """Raw bytes for each glTF buffer: embedded, data URI or external file."""
    with open(source_path, "rb") as handle:
        blob = handle.read()
    is_glb = blob[:4] == b"glTF"
    base = os.path.dirname(os.path.abspath(source_path))

    payloads = []
    for entry in doc.get("buffers") or []:
        uri = entry.get("uri")
        if uri is None:
            payloads.append(glb_binary_chunk(blob) if is_glb else b"")
        elif uri.startswith("data:"):
            payloads.append(base64.b64decode(uri.split(",", 1)[1]))
        else:
            path = os.path.normpath(os.path.join(base, uri))
            payloads.append(open(path, "rb").read() if os.path.isfile(path)
                            else b"")
    return payloads


COMPONENT_DTYPES = {
    5120: np.int8, 5121: np.uint8, 5122: np.int16,
    5123: np.uint16, 5125: np.uint32, 5126: np.float32,
}
TYPE_COMPONENTS = {
    "SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4,
    "MAT2": 4, "MAT3": 9, "MAT4": 16,
}


def accessor_array(doc, payloads, index):
    """Decode one accessor into an (count, components) numpy array, or None."""
    accessors = doc.get("accessors") or []
    if index is None or index >= len(accessors):
        return None
    accessor = accessors[index]
    view_index = accessor.get("bufferView")
    views = doc.get("bufferViews") or []
    if view_index is None or view_index >= len(views):
        return None
    view = views[view_index]
    buffer_index = view.get("buffer", 0)
    if buffer_index >= len(payloads) or not payloads[buffer_index]:
        return None

    dtype = COMPONENT_DTYPES.get(accessor.get("componentType"))
    components = TYPE_COMPONENTS.get(accessor.get("type"))
    count = int(accessor.get("count", 0))
    if dtype is None or not components or count <= 0:
        return None

    item_size = np.dtype(dtype).itemsize * components
    stride = int(view.get("byteStride") or item_size)
    start = int(view.get("byteOffset", 0)) + int(accessor.get("byteOffset", 0))
    end = start + stride * (count - 1) + item_size
    payload = payloads[buffer_index]
    if end > len(payload):
        return None

    if stride == item_size:
        flat = np.frombuffer(payload, dtype=dtype, count=count * components,
                             offset=start)
        return flat.reshape(count, components)
    rows = np.lib.stride_tricks.as_strided(
        np.frombuffer(payload, dtype=np.uint8), shape=(count, item_size),
        strides=(stride, 1), writeable=False).copy()
    return np.frombuffer(rows.tobytes(), dtype=dtype).reshape(count, components)


def primitive_triangles(doc, primitive):
    """Triangle count declared by one primitive's index/position accessor."""
    accessors = doc.get("accessors") or []
    index = primitive.get("indices")
    if index is None:
        index = (primitive.get("attributes") or {}).get("POSITION")
    if index is None or index >= len(accessors):
        return 0
    return int(accessors[index].get("count", 0)) // 3


def texture_stem(entry):
    """Lower-case stem of a glTF image entry: uri basename, else name."""
    if entry is None:
        return None
    uri = entry.get("uri")
    source = uri if uri and not uri.startswith("data:") else entry.get("name")
    if not source:
        return None
    return os.path.splitext(os.path.basename(source))[0].lower()


def source_summary(doc, source_path, kind):
    """Everything the delivered file declares, before Blender touches it."""
    nodes = doc.get("nodes") or []
    meshes = doc.get("meshes") or []
    accessors = doc.get("accessors") or []
    images = doc.get("images") or []
    textures = doc.get("textures") or []
    payloads = buffer_payloads(doc, source_path)
    base = os.path.dirname(os.path.abspath(source_path))

    child_index = set()
    for node in nodes:
        for child in node.get("children") or []:
            child_index.add(child)

    def node_entry(index):
        node = nodes[index]
        return {
            "index": index,
            "name": node.get("name"),
            "mesh": node.get("mesh"),
            "children": list(node.get("children") or []),
            "translation": node.get("translation"),
            "rotation": node.get("rotation"),
            "scale": node.get("scale"),
            "has_matrix": "matrix" in node,
        }

    top_nodes = [node_entry(i) for i in range(len(nodes))
                 if i not in child_index]

    # Per top-level node: primitives + declared triangles over its whole subtree.
    tree = []
    for entry in top_nodes:
        primitives = 0
        triangles = 0
        mesh_names = []
        stack = [entry["index"]]
        while stack:
            node = nodes[stack.pop()]
            mesh_index = node.get("mesh")
            if mesh_index is not None and mesh_index < len(meshes):
                mesh = meshes[mesh_index]
                mesh_names.append(mesh.get("name") or f"mesh{mesh_index}")
                for primitive in mesh.get("primitives") or []:
                    primitives += 1
                    triangles += primitive_triangles(doc, primitive)
            stack.extend(node.get("children") or [])
        tree.append({
            "name": entry["name"],
            "primitives": primitives,
            "declared_triangles": triangles,
            "mesh_names": mesh_names,
            "translation": entry["translation"],
            "has_matrix": entry["has_matrix"],
        })

    # Material -> base-colour texture, as declared by the file.
    image_entries = []
    for index, image in enumerate(images):
        uri = image.get("uri")
        item = {
            "index": index,
            "name": image.get("name"),
            "uri": uri,
            "mime_type": image.get("mimeType"),
            "embedded_buffer_view": "bufferView" in image,
            "stem": texture_stem(image),
        }
        if uri and not uri.startswith("data:"):
            item["resolved_path"] = os.path.normpath(os.path.join(base, uri))
            item["file_exists"] = os.path.isfile(item["resolved_path"])
            item["byte_size"] = (os.path.getsize(item["resolved_path"])
                                 if item["file_exists"] else 0)
        elif item["embedded_buffer_view"]:
            view_index = image.get("bufferView")
            views = doc.get("bufferViews") or []
            if view_index is not None and view_index < len(views):
                item["byte_size"] = int(views[view_index].get("byteLength", 0))
        image_entries.append(item)

    materials = []
    for index, material in enumerate(doc.get("materials") or []):
        pbr = material.get("pbrMetallicRoughness") or {}
        texture_ref = pbr.get("baseColorTexture") or {}
        texture_index = texture_ref.get("index")
        image_index = None
        if texture_index is not None and texture_index < len(textures):
            image_index = (textures[texture_index] or {}).get("source")
        image = (images[image_index]
                 if image_index is not None and image_index < len(images)
                 else None)
        materials.append({
            "index": index,
            "name": material.get("name"),
            "alpha_mode": material.get("alphaMode", "OPAQUE"),
            "base_color_texture_index": texture_index,
            "base_color_image_index": image_index,
            "base_color_image": texture_stem(image),
            "base_color_factor": pbr.get("baseColorFactor"),
            "metallic_factor": pbr.get("metallicFactor"),
            "roughness_factor": pbr.get("roughnessFactor"),
            "double_sided": material.get("doubleSided", False),
        })

    # Per-primitive declared geometry, including non-finite POSITION detection:
    # the importer silently rewrites NaN/Inf to 0.0, so the file itself must be
    # inspected for that corruption class.  Degenerate triangles are counted
    # here too: Blender's mesh validation drops them on import, so the number
    # the file declares and the number that survives reimport can differ.
    geometry = []
    non_finite = 0
    uv_less = []
    degenerate_totals = {"repeated_index": 0, "zero_area": 0,
                         "duplicate_position_faces": 0}
    for mesh_index, mesh in enumerate(meshes):
        name = mesh.get("name") or f"mesh{mesh_index}"
        entry = {
            "mesh_index": mesh_index,
            "name": name,
            "primitives": len(mesh.get("primitives") or []),
            "declared_triangles": 0,
            "non_finite_position_components": 0,
            "repeated_index_triangles": 0,
            "zero_area_triangles": 0,
            "duplicate_position_faces": 0,
            "primitive_modes": [],
            "has_uv": True,
        }
        for primitive in mesh.get("primitives") or []:
            attributes = primitive.get("attributes") or {}
            mode = primitive.get("mode", 4)
            entry["primitive_modes"].append(mode)
            entry["declared_triangles"] += primitive_triangles(doc, primitive)
            if "TEXCOORD_0" not in attributes:
                entry["has_uv"] = False
            positions = accessor_array(doc, payloads, attributes.get("POSITION"))
            if positions is None:
                continue
            bad = int((~np.isfinite(positions)).sum())
            if bad:
                entry["non_finite_position_components"] += bad
                non_finite += bad
                row = int(np.flatnonzero((~np.isfinite(positions)).any(axis=1))[0])
                entry["first_non_finite_vertex"] = {
                    "index": row,
                    "position": [float(v) for v in positions[row]],
                }

            indices = accessor_array(doc, payloads, primitive.get("indices"))
            if mode != 4 or indices is None or len(indices) < 3:
                continue
            tri = indices[:len(indices) // 3 * 3].reshape(-1, 3).astype(np.int64)
            if tri.max(initial=-1) >= len(positions) or tri.min(initial=0) < 0:
                entry["index_out_of_range"] = True
                continue
            corners = positions[tri].astype(np.float64)
            repeated = int(((tri[:, 0] == tri[:, 1]) | (tri[:, 1] == tri[:, 2])
                            | (tri[:, 0] == tri[:, 2])).sum())
            areas = 0.5 * np.linalg.norm(
                np.cross(corners[:, 1] - corners[:, 0],
                         corners[:, 2] - corners[:, 0]), axis=1)
            zero_area = int((areas <= AREA_EPS).sum())
            seen = {}
            for triangle in tri:
                key = tuple(sorted(int(v) for v in triangle))
                seen[key] = seen.get(key, 0) + 1
            duplicate_faces = sum(v - 1 for v in seen.values() if v > 1)
            entry["repeated_index_triangles"] += repeated
            entry["zero_area_triangles"] += zero_area
            entry["duplicate_position_faces"] += duplicate_faces
        degenerate_totals["repeated_index"] += entry["repeated_index_triangles"]
        degenerate_totals["zero_area"] += entry["zero_area_triangles"]
        degenerate_totals["duplicate_position_faces"] += \
            entry["duplicate_position_faces"]
        if not entry["has_uv"]:
            uv_less.append(name)
        geometry.append(entry)

    buffers = []
    for index, buffer in enumerate(doc.get("buffers") or []):
        uri = buffer.get("uri")
        item = {
            "index": index,
            "uri": uri,
            "declared_byte_length": buffer.get("byteLength"),
            "payload_byte_length": len(payloads[index]) if index < len(payloads)
            else 0,
            "embedded": uri is None,
        }
        if uri and not uri.startswith("data:"):
            item["resolved_path"] = os.path.normpath(os.path.join(base, uri))
            item["file_exists"] = os.path.isfile(item["resolved_path"])
        buffers.append(item)

    return {
        "kind": kind,
        "generator": (doc.get("asset") or {}).get("generator"),
        "gltf_version": (doc.get("asset") or {}).get("version"),
        "scene_name": ((doc.get("scenes") or [{}])[
            doc.get("scene", 0) if doc.get("scene") is not None else 0] or {}
        ).get("name"),
        "scene_extras": ((doc.get("scenes") or [{}])[
            doc.get("scene", 0) if doc.get("scene") is not None else 0] or {}
        ).get("extras"),
        "node_count": len(nodes),
        "mesh_count": len(meshes),
        "top_level_nodes": top_nodes,
        "top_level_node_names": [entry["name"] for entry in top_nodes],
        "expected_top_level_node_names": sorted(EXPECTED_TOP_LEVEL),
        "tree": tree,
        "materials": materials,
        "images": image_entries,
        "buffers": buffers,
        "geometry": geometry,
        "declared_triangle_total": int(sum(g["declared_triangles"]
                                           for g in geometry)),
        "declared_primitive_total": int(sum(g["primitives"] for g in geometry)),
        "declared_degenerate_triangles": degenerate_totals,
        "declared_non_finite_position_components": non_finite,
        "declared_meshes_without_uv": uv_less,
        "glb_binary_chunk_bytes": (len(glb_binary_chunk(open(source_path, "rb")
                                                        .read()))
                                   if kind == "glb" else None),
    }


# --------------------------------------------------------------------------- #
# Scene inspection helpers
# --------------------------------------------------------------------------- #
def base_name(name):
    """Strip Blender's `.001` uniqueness suffix so real duplicates surface."""
    head, dot, tail = name.rpartition(".")
    if dot and tail.isdigit() and len(tail) == 3:
        return head
    return name


_GUN_ROT = Matrix(_GUN_FROM_BLENDER.tolist())
_GUN_ROT_INV = _GUN_ROT.inverted()


def gun_matrix(obj):
    """The object's own transform expressed in the gun-local runtime frame.

    Positions convert as `p_gun = R p_blender`, so a *transform* converts by
    conjugation, `M_gun = R M R^-1`.  Left-multiplying alone would report the
    frame change itself as though it were a transform on the object, making
    every identity node look rotated by 90 degrees.
    """
    return _GUN_ROT @ obj.matrix_world @ _GUN_ROT_INV


def gun_vertex_array(obj):
    """(n, 3) float64 world vertices of `obj` in the gun-local frame."""
    mesh = obj.data
    count = len(mesh.vertices)
    if count == 0:
        return np.zeros((0, 3), dtype=np.float64)
    flat = np.empty(count * 3, dtype=np.float64)
    mesh.vertices.foreach_get("co", flat)
    local = flat.reshape(count, 3) @ _GUN_FROM_BLENDER[:3, :3].T
    matrix = np.array(gun_matrix(obj), dtype=np.float64)
    return local @ matrix[:3, :3].T + matrix[:3, 3]


def gun_local_array(obj):
    """(n, 3) mesh-local vertices of `obj`, re-oriented into the gun frame.

    Used to measure "geometry centred on its own origin": the mesh's own
    coordinates, independent of whatever transform the node carries.
    """
    mesh = obj.data
    count = len(mesh.vertices)
    if count == 0:
        return np.zeros((0, 3), dtype=np.float64)
    flat = np.empty(count * 3, dtype=np.float64)
    mesh.vertices.foreach_get("co", flat)
    return flat.reshape(count, 3) @ _GUN_FROM_BLENDER[:3, :3].T


def triangle_indices(mesh):
    """(m, 3) int array of loop-triangle vertex indices."""
    mesh.calc_loop_triangles()
    count = len(mesh.loop_triangles)
    if count == 0:
        return np.zeros((0, 3), dtype=np.int64)
    flat = np.empty(count * 3, dtype=np.int32)
    mesh.loop_triangles.foreach_get("vertices", flat)
    return flat.reshape(count, 3).astype(np.int64)


# Per-object mesh statistics cache; see `mesh_stats`.  Cleared between imports.
_MESH_STATS = {}


def mesh_stats(obj):
    """Triangles, vertices, UV layers and finite-coordinate state of a mesh."""
    cached = _MESH_STATS.get(obj.name)
    if cached is not None:
        return cached
    mesh = obj.data
    tris = triangle_indices(mesh)
    positions = gun_vertex_array(obj)
    stats = {
        "name": obj.name,
        "triangles": int(len(tris)),
        "vertices": int(len(mesh.vertices)),
        "polygons": int(len(mesh.polygons)),
        "materials": [slot.material.name if slot.material else None
                      for slot in obj.material_slots],
        "uv_layers": [layer.name for layer in mesh.uv_layers],
        "non_finite_vertices": 0,
        "uv_layer_count": len(mesh.uv_layers),
    }
    if len(positions):
        stats["non_finite_vertices"] = int((~np.isfinite(positions)).all(
            axis=1).sum())
        if stats["non_finite_vertices"] == 0 and len(tris):
            stats["non_finite_vertices"] = int(
                (~np.isfinite(positions[tris])).sum())
    _MESH_STATS[obj.name] = stats
    return stats


def bounds(positions):
    """min/max/centre/size of an (n, 3) array, or None when empty."""
    if not len(positions):
        return None
    finite = positions[np.isfinite(positions).all(axis=1)]
    if not len(finite):
        return None
    minimum = finite.min(axis=0)
    maximum = finite.max(axis=0)
    return {
        "min": [float(v) for v in minimum],
        "max": [float(v) for v in maximum],
        "centre": [float(v) for v in (minimum + maximum) * 0.5],
        "size": [float(v) for v in (maximum - minimum)],
    }


def scale_problem(obj):
    """Measured string when an object's gun-local scale is non-positive."""
    scale = tuple(float(v) for v in gun_matrix(obj).to_scale())
    if any(not math.isfinite(v) or v <= 0.0 for v in scale):
        return f"scale = {tuple(round(v, 6) for v in scale)}"
    return None


def transform_report(obj):
    """Gun-local transform of one object, decomposed."""
    matrix = gun_matrix(obj)
    return {
        "translation": [float(v) for v in matrix.to_translation()],
        "rotation_quaternion": [float(v) for v in matrix.to_quaternion()],
        "scale": [float(v) for v in matrix.to_scale()],
    }


def is_identity(matrix):
    translation = matrix.to_translation()
    quaternion = matrix.to_quaternion()
    scale = matrix.to_scale()
    return (translation.length <= IDENTITY_TOL
            and abs(quaternion.angle) <= IDENTITY_TOL
            and all(abs(s - 1.0) <= IDENTITY_TOL for s in scale))


def subtree(root):
    """Root plus all descendants, walking the parent chain."""
    found = [root]
    stack = [root]
    while stack:
        obj = stack.pop()
        for child in obj.children:
            found.append(child)
            stack.append(child)
    return found


def top_level_nodes():
    return [obj for obj in bpy.context.scene.objects if obj.parent is None]


def find_object(name):
    """First scene object whose name (or de-suffixed name) equals `name`."""
    for obj in bpy.context.scene.objects:
        if obj.name == name or base_name(obj.name) == name:
            return obj
    return None


def principled_node(material):
    """The material's Principled BSDF node, or None.

    `use_nodes` is deprecated (removed in 6.0) and always True in 5.x, so the
    node tree is read directly.
    """
    tree = getattr(material, "node_tree", None)
    if tree is None:
        return None
    for node in tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            return node
    return None


def find_image_upstream(socket, max_depth=8):
    """First image datablock reachable upstream of a socket, else None."""
    if not socket or not socket.is_linked:
        return None
    seen = set()
    frontier = [(link.from_node, 0) for link in socket.links]
    while frontier:
        node, depth = frontier.pop(0)
        if node is None or id(node) in seen or depth > max_depth:
            continue
        seen.add(id(node))
        if node.type == "TEX_IMAGE":
            return node.image
        for inlet in getattr(node, "inputs", []):
            for link in inlet.links:
                frontier.append((link.from_node, depth + 1))
    return None


def image_stem(image):
    """Lower-case stem of an imported image (filepath first, then name)."""
    if image is None:
        return None
    source = image.filepath or image.name
    if not source:
        return None
    return os.path.splitext(os.path.basename(source))[0].lower()


def image_report(image):
    """Packed/external state, byte size and pixel dimensions."""
    packed = image.packed_file
    filepath = bpy.path.abspath(image.filepath) if image.filepath else ""
    if packed is not None:
        byte_size, storage = int(packed.size), "packed"
    elif filepath and os.path.isfile(filepath):
        byte_size, storage = int(os.path.getsize(filepath)), "external"
    else:
        byte_size, storage = 0, "missing"
    return {
        "name": image.name,
        "stem": image_stem(image),
        "storage": storage,
        "packed": packed is not None,
        "filepath": filepath,
        "byte_size": byte_size,
        "width": int(image.size[0]),
        "height": int(image.size[1]),
        "source": image.source,
    }


# --------------------------------------------------------------------------- #
# Import + measurement
# --------------------------------------------------------------------------- #
def import_into_empty_scene(path):
    """Drop to an empty factory scene and import `path` into it."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _MESH_STATS.clear()
    bpy.ops.import_scene.gltf(filepath=path)


def measure_scene(doc, source_path, kind):
    """Collect every imported measurement used by the contract checks."""
    scene_objects = sorted(bpy.context.scene.objects, key=lambda o: o.name)
    mesh_objects = [obj for obj in scene_objects if obj.type == "MESH"]

    objects = []
    for obj in scene_objects:
        entry = {
            "name": obj.name,
            "base_name": base_name(obj.name),
            "type": obj.type,
            "parent": obj.parent.name if obj.parent else None,
            "children": sorted(child.name for child in obj.children),
            "top_level": obj.parent is None,
            "transform_gun_local": transform_report(obj),
        }
        if obj.type == "MESH":
            stats = mesh_stats(obj)
            entry.update({
                "triangles": stats["triangles"],
                "vertices": stats["vertices"],
                "polygons": stats["polygons"],
                "materials": list(stats["materials"]),
                "uv_layers": list(stats["uv_layers"]),
                "non_finite_vertices": stats["non_finite_vertices"],
                "geometry_bounds_own_frame": bounds(gun_local_array(obj)),
                "world_bounds_gun_local": bounds(gun_vertex_array(obj)),
            })
        objects.append(entry)

    # Per top-level node: aggregated triangles, primitives and materials.
    trees = []
    for root in top_level_nodes():
        members = subtree(root)
        meshes = [obj for obj in members if obj.type == "MESH"]
        materials = []
        for obj in meshes:
            for name in mesh_stats(obj)["materials"]:
                if name and name not in materials:
                    materials.append(name)
        trees.append({
            "name": root.name,
            "type": root.type,
            "mesh_names": sorted(obj.name for obj in meshes),
            "triangles": int(sum(mesh_stats(obj)["triangles"] for obj in meshes)),
            "vertices": int(sum(mesh_stats(obj)["vertices"] for obj in meshes)),
            "materials": sorted(materials),
        })

    materials = []
    for material in sorted(bpy.data.materials, key=lambda m: m.name):
        node = principled_node(material)
        base_color = node.inputs.get("Base Color") if node else None
        image = find_image_upstream(base_color)
        materials.append({
            "name": material.name,
            "has_principled_bsdf": node is not None,
            "base_color_image": image.name if image else None,
            "base_color_image_stem": image_stem(image),
            "blend_method": getattr(material, "blend_method", None),
            "surface_render_method": getattr(material, "surface_render_method",
                                             None),
            "use_backface_culling": bool(
                getattr(material, "use_backface_culling", False)),
            "metallic": (float(node.inputs["Metallic"].default_value)
                         if node and node.inputs.get("Metallic") else None),
            "roughness": (float(node.inputs["Roughness"].default_value)
                          if node and node.inputs.get("Roughness") else None),
            "alpha": (float(node.inputs["Alpha"].default_value)
                      if node and node.inputs.get("Alpha") else None),
        })

    # Anchors, measured from the imported node transforms.
    anchors = {}
    for name in MARKERS:
        obj = find_object(name)
        anchors[name] = {
            "object": obj.name if obj else None,
            "present": obj is not None,
            "translation_gun_local": ([float(v) for v in
                                       gun_matrix(obj).to_translation()]
                                      if obj else None),
            "type": obj.type if obj else None,
        }

    # Muzzle face: the ring of vertices at the forward-most z.
    positions = [gun_vertex_array(obj) for obj in mesh_objects]
    positions = [p for p in positions if len(p)]
    all_vertices = np.vstack(positions) if positions else np.zeros((0, 3))
    finite_rows = all_vertices[np.isfinite(all_vertices).all(axis=1)] \
        if len(all_vertices) else all_vertices
    muzzle_face = None
    if len(finite_rows):
        forward_z = float(finite_rows[:, 2].min())
        face = finite_rows[finite_rows[:, 2] <= forward_z + FACE_EPS]
        axis_x, axis_y = BORE_AXIS_XY
        radii = np.hypot(face[:, 0] - axis_x, face[:, 1] - axis_y)
        muzzle_face = {
            "forward_most_z": forward_z,
            "vertex_count": int(len(face)),
            "extent_centre_xy": [
                float((face[:, 0].min() + face[:, 0].max()) * 0.5),
                float((face[:, 1].min() + face[:, 1].max()) * 0.5),
            ],
            "centroid_xyz": [float(v) for v in face.mean(axis=0)],
            "max_radius_from_contract_axis": float(radii.max()),
            "min_radius_from_contract_axis": float(radii.min()),
        }

    extra = extra_report(doc, kind)

    return {
        "scene": {
            "object_count": len(scene_objects),
            "mesh_object_count": len(mesh_objects),
            "non_mesh_object_count": len(scene_objects) - len(mesh_objects),
            "top_level_node_names": sorted(obj.name for obj in top_level_nodes()),
        },
        "objects": objects,
        "nodes": trees,
        "materials": materials,
        "images": [image_report(image) for image in
                   sorted(bpy.data.images, key=lambda i: i.name)],
        "anchors": anchors,
        "muzzle_face": muzzle_face,
        "bounds_gun_local": bounds(finite_rows),
        "extra": extra,
        "totals": {
            "triangles": int(sum(mesh_stats(obj)["triangles"]
                                 for obj in mesh_objects)),
            "vertices": int(sum(mesh_stats(obj)["vertices"]
                                for obj in mesh_objects)),
            "mesh_objects": len(mesh_objects),
            "material_count": len(bpy.data.materials),
            "image_count": len(bpy.data.images),
            "uv_less_meshes": sorted(obj.name for obj in mesh_objects
                                     if not mesh_stats(obj)["uv_layers"]),
            "non_finite_vertices": int(sum(
                mesh_stats(obj)["non_finite_vertices"] for obj in mesh_objects)),
            "non_positive_scales": sorted(
                obj.name for obj in scene_objects if scale_problem(obj)),
        },
    }


def extra_report(doc, kind):
    """`extra`: identity group with exactly three centred, directly-parented rounds."""
    node = find_object("extra")
    entry = {
        "present": node is not None,
        "type": node.type if node else None,
        "identity_transform": is_identity(gun_matrix(node)) if node else False,
        "transform_gun_local": transform_report(node) if node else None,
        "direct_children": sorted(child.name for child in node.children) if node
        else [],
        "rounds": [],
    }
    meshes = doc.get("meshes") or []
    node_by_name = {node.get("name"): node for node in (doc.get("nodes") or [])}
    for name in ROUNDS:
        child = find_object(name)
        declared = node_by_name.get(name) or {}
        mesh_index = declared.get("mesh")
        mesh = (meshes[mesh_index]
                if mesh_index is not None and mesh_index < len(meshes) else None)
        record = {
            "name": name,
            "present": child is not None,
            "parent": child.parent.name if child and child.parent else None,
            "declared_primitives": len(mesh.get("primitives") or [])
            if mesh is not None else None,
            "declared_translation": declared.get("translation"),
            "declared_rotation": declared.get("rotation"),
            "declared_scale": declared.get("scale"),
            "node_identity_rotation_scale": None,
            "geometry_centre_own_frame": None,
            "geometry_size_own_frame": None,
        }
        if child is not None:
            matrix = gun_matrix(child)
            record["world_translation_gun_local"] = [
                float(v) for v in matrix.to_translation()]
            record["node_identity_rotation_scale"] = (
                abs(matrix.to_quaternion().angle) <= IDENTITY_TOL
                and all(abs(s - 1.0) <= IDENTITY_TOL
                        for s in matrix.to_scale()))
            own = bounds(gun_local_array(child))
            record["geometry_centre_own_frame"] = own["centre"] if own else None
            record["geometry_size_own_frame"] = own["size"] if own else None
            record["triangles"] = mesh_stats(child)["triangles"]
            record["uv_layers"] = list(mesh_stats(child)["uv_layers"])
        entry["rounds"].append(record)
    return entry


# --------------------------------------------------------------------------- #
# Checks
# --------------------------------------------------------------------------- #
class Checks:
    """Named boolean results, each carrying the value it was measured from.

    Two tiers.  `contract` entries are the frozen delivery contract and drive
    `passed`/`failures`.  `advisory` entries are measured findings outside the
    contract: they are reported with their measured value and listed in
    `advisory_findings` when they do not hold, but they never turn the delivery
    red.  Nothing is suppressed either way -- an advisory finding that does not
    hold is still printed and still carries its numbers.
    """

    def __init__(self, target):
        self.target = target
        self.items = {}
        self.advisory = {}

    def add(self, name, passed, measured, expected=None, note=None,
            tier="contract"):
        entry = {"passed": bool(passed), "measured": measured}
        if expected is not None:
            entry["expected"] = expected
        if note:
            entry["note"] = note
        (self.advisory if tier == "advisory" else self.items)[name] = entry

    def close(self, name, measured, expected, tol, note=None,
              tier="contract"):
        """Numeric comparison with an absolute tolerance."""
        if isinstance(measured, (list, tuple)) and isinstance(
                expected, (list, tuple)):
            ok = (len(measured) == len(expected)
                  and all(a is not None and b is not None
                          and abs(a - b) <= tol
                          for a, b in zip(measured, expected)))
        elif measured is None or expected is None:
            ok = False
        else:
            ok = abs(measured - expected) <= tol
        self.add(name, ok, measured, expected, note, tier)

    def _failures(self, collection):
        return [{"target": self.target, "check": name,
                 "expected": entry.get("expected"), "measured": entry["measured"]}
                for name, entry in collection.items() if not entry["passed"]]

    def failures(self):
        return self._failures(self.items)

    def advisory_findings(self):
        return self._failures(self.advisory)


def coordinate_string(values):
    return [round(float(v), 8) for v in values]


def run_checks(target, kind, source, scene):
    """Every frozen-contract assertion, for one delivered file."""
    checks = Checks(target)
    totals = scene["totals"]
    anchor = scene["anchors"]
    face = scene["muzzle_face"]
    extra = scene["extra"]

    # -- structure ---------------------------------------------------------- #
    actual_names = scene["scene"]["top_level_node_names"]
    checks.add(
        "top_level_node_names_exact",
        sorted(actual_names) == sorted(EXPECTED_TOP_LEVEL),
        sorted(actual_names),
        sorted(EXPECTED_TOP_LEVEL),
        "body, mag, bolt, trigger, factory-optic, extra + muzzle, grip, "
        "support, sight and nothing else",
    )
    duplicates = sorted({name for name in actual_names
                         if actual_names.count(name) > 1})
    checks.add("no_duplicate_top_level_node_names", not duplicates,
               duplicates, [])

    declared_identity = {}
    imported_identity = {}
    for name in IDENTITY_PARTS:
        node = next((entry for entry in source["top_level_nodes"]
                     if entry["name"] == name), None)
        declared_identity[name] = bool(
            node is not None
            and not node["has_matrix"]
            and (node["translation"] in (None, [0, 0, 0]))
            and (node["rotation"] in (None, [0, 0, 0, 1]))
            and (node["scale"] in (None, [1, 1, 1])))
        obj = find_object(name)
        imported_identity[name] = bool(obj is not None
                                       and is_identity(gun_matrix(obj)))
    checks.add(
        "part_nodes_identity_transform",
        all(declared_identity.values()) and all(imported_identity.values()),
        {"declared": declared_identity, "imported_after_reimport":
         imported_identity},
        {name: True for name in IDENTITY_PARTS},
        "vertices baked into gun-local space: part nodes carry no transform",
    )

    # -- anchors ------------------------------------------------------------ #
    for name in ("muzzle", "grip", "support"):
        measured = anchor[name]["translation_gun_local"]
        checks.close(f"anchor_{name}", measured, list(ANCHORS[name]), COORD_TOL,
                     None if measured else "marker node missing after import")

    sight = anchor["sight"]["translation_gun_local"]
    checks.close("anchor_sight_y", sight[1] if sight else None, SIGHT_Y,
                 COORD_TOL, None if sight else "marker node missing after import")

    # Reimport must agree with what the file itself declares.
    worst = 0.0
    worst_name = None
    for entry in source["top_level_nodes"]:
        declared = entry["translation"]
        if declared is None:
            continue
        measured = anchor.get(entry["name"], {}).get("translation_gun_local")
        if measured is None:
            continue
        delta = max(abs(a - b) for a, b in zip(measured, declared))
        if delta > worst:
            worst, worst_name = delta, entry["name"]
    checks.add(
        "reimport_agrees_with_declared_translations", worst <= COORD_TOL,
        {"max_abs_delta": worst, "node": worst_name},
        f"<= {COORD_TOL:g} m",
        "Blender's importer must reproduce the file's own node translations",
    )

    # -- forward-most geometry / bore axis ---------------------------------- #
    forward_z = face["forward_most_z"] if face else None
    checks.close("forward_most_vertex_z", forward_z, FORWARD_MOST_Z, COORD_TOL,
                 "forward-most vertex of the whole model")
    checks.close("muzzle_face_centre_on_bore_axis",
                 face["extent_centre_xy"] if face else None,
                 list(BORE_AXIS_XY), 1e-4,
                 "midpoint of the muzzle-face vertex extents")
    checks.add("muzzle_radius_within_bore_radius",
               bool(face) and face["max_radius_from_contract_axis"]
               <= BORE_RADIUS + 1e-4,
               face["max_radius_from_contract_axis"] if face else None,
               f"<= {BORE_RADIUS}",
               "nothing on the muzzle may exceed the exposed bore radius")

    # -- budgets and declared counts ---------------------------------------- #
    triangles = totals["triangles"]
    declared_triangles = source["declared_triangle_total"]
    primitives = source["declared_primitive_total"]
    checks.add("triangle_budget_10k_to_20k",
               TRIANGLE_MIN <= declared_triangles <= TRIANGLE_MAX,
               declared_triangles, [TRIANGLE_MIN, TRIANGLE_MAX],
               f"triangles declared by the file; {triangles} survive reimport")
    checks.add("expected_triangle_count",
               declared_triangles == EXPECTED_TRIANGLES, declared_triangles,
               EXPECTED_TRIANGLES,
               f"{triangles} survive reimport; the frozen delivered count, "
               f"agreed by both files")
    checks.add("primitive_budget_max_24", primitives <= PRIMITIVE_BUDGET,
               primitives, f"<= {PRIMITIVE_BUDGET}",
               "glTF draw primitives declared by the file")
    checks.add("expected_primitive_count", primitives == EXPECTED_PRIMITIVES,
               primitives, EXPECTED_PRIMITIVES)
    checks.add("material_budget_max_8",
               totals["material_count"] <= MATERIAL_BUDGET,
               totals["material_count"], f"<= {MATERIAL_BUDGET}")
    checks.add("expected_material_count_7",
               totals["material_count"] == len(MATERIAL_TEXTURE_MAP),
               totals["material_count"], len(MATERIAL_TEXTURE_MAP))
    checks.add("expected_image_count",
               totals["image_count"] == EXPECTED_IMAGES,
               totals["image_count"], EXPECTED_IMAGES)
    degenerate = source["declared_degenerate_triangles"]
    checks.add(
        "degenerate_triangles_in_source",
        degenerate["repeated_index"] == 0 and degenerate["zero_area"] == 0,
        degenerate, {"repeated_index": 0, "zero_area": 0},
        "sub-micron sliver triangles collapse to repeated indices once "
        "positions/normals/UVs are deduplicated.  The build owner classified "
        "these as accepted at freeze: invisible, ~0.9 kB of index buffer, and "
        "dropped by Blender's mesh validation on import.  Measured and "
        "reported, not counted against the delivery.",
        tier="advisory",
    )
    checks.add(
        "reimport_reproduces_declared_triangles",
        triangles == source["declared_triangle_total"], triangles,
        source["declared_triangle_total"],
        "a strict reimport reproduces every triangle; the shortfall is exactly "
        "the degenerate triangles above, which Blender's mesh validation drops",
        tier="advisory",
    )

    # -- geometry integrity -------------------------------------------------- #
    checks.add("every_mesh_has_uv_layer", not totals["uv_less_meshes"],
               totals["uv_less_meshes"], [],
               f"{totals['mesh_objects']} mesh objects inspected")
    checks.add("no_non_finite_coordinates",
               totals["non_finite_vertices"] == 0
               and source["declared_non_finite_position_components"] == 0,
               {"imported": totals["non_finite_vertices"],
                "declared_in_file":
                    source["declared_non_finite_position_components"]}, 0)
    checks.add("no_non_positive_or_negative_scales",
               not totals["non_positive_scales"],
               totals["non_positive_scales"], [],
               f"{scene['scene']['object_count']} objects inspected")

    # -- materials and textures --------------------------------------------- #
    declared_map = {material["name"]: material["base_color_image"]
                    for material in source["materials"]}
    imported_map = {material["name"]: material["base_color_image_stem"]
                    for material in scene["materials"]}
    checks.add("material_texture_map_exact_declared",
               declared_map == MATERIAL_TEXTURE_MAP, declared_map,
               MATERIAL_TEXTURE_MAP)
    checks.add("material_texture_map_exact_imported",
               imported_map == MATERIAL_TEXTURE_MAP, imported_map,
               MATERIAL_TEXTURE_MAP)

    glass = next((material for material in source["materials"]
                  if material["name"] == OPTIC_GLASS), None)
    checks.add(
        "optic_glass_blend_without_texture",
        bool(glass) and glass["alpha_mode"] == "BLEND"
        and glass["base_color_texture_index"] is None,
        {"alpha_mode": glass["alpha_mode"] if glass else None,
         "base_color_texture_index": glass["base_color_texture_index"]
         if glass else None},
        {"alpha_mode": "BLEND", "base_color_texture_index": None},
    )

    # -- extra / stripper rounds --------------------------------------------- #
    checks.add("extra_identity_group_transform",
               extra["present"] and extra["identity_transform"],
               extra["transform_gun_local"], "identity")
    checks.add("extra_three_mesh_children_direct",
               sorted(extra["direct_children"]) == sorted(ROUNDS)
               and all(round_["present"] and round_["parent"] == "extra"
                       for round_ in extra["rounds"]),
               extra["direct_children"], sorted(ROUNDS),
               "direct children of `extra`, no intermediate node")
    checks.add(
        "extra_rounds_single_primitive",
        all(round_["declared_primitives"] == 1 for round_ in extra["rounds"]),
        {round_["name"]: round_["declared_primitives"]
         for round_ in extra["rounds"]},
        {name: 1 for name in ROUNDS},
    )
    centred = {}
    sizes = {}
    for round_ in extra["rounds"]:
        centre = round_["geometry_centre_own_frame"]
        size = round_["geometry_size_own_frame"]
        centred[round_["name"]] = (
            [round(float(v), 8) for v in centre] if centre else None)
        sizes[round_["name"]] = ([round(float(v), 6) for v in size]
                                 if size else None)
    checks.add(
        "round_geometry_centred_on_origin",
        all(centre is not None
            and max(abs(v) for v in centre) <= COORD_TOL
            for centre in centred.values()),
        centred, [0.0, 0.0, 0.0],
        "geometry in the round's own frame (placement lives on the node)",
    )
    checks.add(
        "round_dimensions_about_12x12x50mm",
        all(size is not None
            and all(abs(a - b) <= ROUND_SIZE_TOL * b
                    for a, b in zip(size, ROUND_SIZE))
            for size in sizes.values()),
        sizes, list(ROUND_SIZE),
        f"gun-frame size, tolerance +/- {int(ROUND_SIZE_TOL * 100)} %",
    )
    checks.add(
        "round_placement_node_translation",
        all(round_["world_translation_gun_local"] is not None
            and max(abs(a - b) for a, b in
                    zip(round_["world_translation_gun_local"],
                        ROUND_TRANSLATIONS[round_["name"]])) <= COORD_TOL
            for round_ in extra["rounds"]),
        {round_["name"]: coordinate_string(round_["world_translation_gun_local"])
         for round_ in extra["rounds"]
         if round_["world_translation_gun_local"]},
        {name: list(value) for name, value in ROUND_TRANSLATIONS.items()},
    )
    checks.add(
        "round_nodes_identity_rotation_and_scale",
        all(round_["node_identity_rotation_scale"] for round_ in extra["rounds"]),
        {round_["name"]: round_["node_identity_rotation_scale"]
         for round_ in extra["rounds"]},
        {name: True for name in ROUNDS},
    )

    # -- file-format specific ------------------------------------------------ #
    if kind == "glb":
        images = source["images"]
        checks.add("glb_images_embedded_in_buffer",
                   bool(images) and all(image["embedded_buffer_view"]
                                        and image["uri"] is None
                                        for image in images),
                   [{"name": image["name"],
                     "embedded": image["embedded_buffer_view"],
                     "uri": image["uri"],
                     "byte_size": image.get("byte_size")}
                    for image in images],
                   "6 embedded JPEGs, no external uri")
        buffers = source["buffers"]
        checks.add("glb_single_embedded_buffer",
                   len(buffers) == 1 and buffers[0]["embedded"]
                   and buffers[0]["payload_byte_length"]
                   == buffers[0]["declared_byte_length"],
                   buffers, "one embedded BIN chunk matching its byteLength")
    else:
        buffers = source["buffers"]
        checks.add(
            "runtime_buffer_is_sibling_bin",
            len(buffers) == 1 and buffers[0]["uri"] == "peregrine.bin"
            and buffers[0].get("file_exists") is True
            and buffers[0]["declared_byte_length"]
            == buffers[0]["payload_byte_length"],
            buffers, "one buffer, uri 'peregrine.bin', sibling file present")
        images = source["images"]
        expected_uris = {f"textures/{stem}.jpg" for stem in
                         MATERIAL_TEXTURE_MAP.values() if stem}
        measured_uris = {image["uri"] for image in images}
        checks.add(
            "runtime_image_uris_textures_stem_jpg",
            measured_uris == expected_uris,
            sorted(measured_uris), sorted(expected_uris),
            "the runtime map cache keys on exactly these uri strings",
        )
        checks.add(
            "runtime_texture_files_exist",
            bool(images) and all(image.get("file_exists") for image in images),
            {image["uri"]: image.get("file_exists") for image in images},
            {uri: True for uri in sorted(expected_uris)},
        )
        checks.add(
            "runtime_image_count",
            len(images) == EXPECTED_IMAGES, len(images), EXPECTED_IMAGES,
        )

    return checks


# --------------------------------------------------------------------------- #
# Report assembly
# --------------------------------------------------------------------------- #
def input_manifest(path, source):
    """Every file whose bytes the measurement depends on, keyed by path.

    For the runtime glTF that is the .gltf plus its sibling .bin and the six
    texture JPEGs the importer resolves; for the GLB it is the single file.
    """
    paths = {os.path.abspath(path)}
    for entry in (source["buffers"] or []) + (source["images"] or []):
        resolved = entry.get("resolved_path")
        if resolved and os.path.isfile(resolved):
            paths.add(os.path.abspath(resolved))
    return {item: sha256_file(item) for item in sorted(paths)}


def build_target(path, kind):
    # Hash every input before and after: the delivered files are authored by a
    # concurrent agent, and a report measured across a rewrite is worthless.
    doc = read_gltf_json(path)
    source = source_summary(doc, path, kind)
    before = input_manifest(path, source)
    import_into_empty_scene(path)
    scene = measure_scene(doc, path, kind)
    checks = run_checks("glb" if kind == "glb" else "runtime_gltf", kind,
                        source, scene)
    after = input_manifest(path, source)
    changed = sorted(item for item in after if before.get(item) != after[item])
    failures = checks.failures()
    advisory_findings = checks.advisory_findings()
    degenerate = source["declared_degenerate_triangles"]
    return {
        "path": os.path.abspath(path),
        "kind": kind,
        "byte_size": os.path.getsize(path),
        "sha256": after[os.path.abspath(path)],
        "sha256_before_measurement": before[os.path.abspath(path)],
        "unchanged_during_measurement": not changed,
        "measurement_inputs": after,
        "inputs_changed_during_measurement": changed,
        "mtime": os.path.getmtime(path),
        "passed": not failures,
        "failure_count": len(failures),
        "failures": failures,
        "advisory_findings": advisory_findings,
        "triangle_accounting": {
            "declared_in_file": source["declared_triangle_total"],
            "imported_after_reimport": scene["totals"]["triangles"],
            "dropped_by_import": (source["declared_triangle_total"]
                                  - scene["totals"]["triangles"]),
            "repeat_index_triangles": degenerate["repeated_index"],
            "zero_area_triangles": degenerate["zero_area"],
            "duplicate_position_faces": degenerate["duplicate_position_faces"],
        },
        "source_declarations": source,
        "imported": scene,
        "checks": checks.items,
        "advisory_checks": checks.advisory,
    }


def sanitize(value):
    """Replace non-finite floats so the report is always strict, valid JSON."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: sanitize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize(item) for item in value]
    return value


def main():
    glb_path, gltf_path, json_path = parse_cli(sys.argv)
    for path in (glb_path, gltf_path):
        if not os.path.isfile(path):
            sys.stderr.write(f"error: source not found: {path}\n")
            sys.exit(2)

    command = ("blender --background --factory-startup --python "
               "tools/blender/peregrine/validate-glb.py -- "
               f"{os.path.relpath(glb_path, REPO_ROOT)} "
               f"{os.path.relpath(gltf_path, REPO_ROOT)} "
               f"{os.path.relpath(json_path, REPO_ROOT)}")

    try:
        glb = build_target(glb_path, "glb")
        runtime = build_target(gltf_path, "gltf")
    except Exception:
        traceback.print_exc()
        sys.stderr.write("error: peregrine validation failed to complete\n")
        sys.exit(2)

    bin_path = os.path.join(os.path.dirname(gltf_path),
                            os.path.basename(gltf_path).replace(".gltf", ".bin"))
    delivered = {
        "glb": {"path": os.path.abspath(glb_path),
                "byte_size": os.path.getsize(glb_path),
                "sha256": glb["sha256"],
                "mtime": glb["mtime"],
                "unchanged_during_measurement":
                    glb["unchanged_during_measurement"]},
        "gltf": {"path": os.path.abspath(gltf_path),
                 "byte_size": os.path.getsize(gltf_path),
                 "sha256": runtime["sha256"],
                 "mtime": runtime["mtime"],
                 "unchanged_during_measurement":
                     runtime["unchanged_during_measurement"]},
    }
    if os.path.isfile(bin_path):
        changed = runtime["inputs_changed_during_measurement"]
        delivered["bin"] = {"path": os.path.abspath(bin_path),
                            "byte_size": os.path.getsize(bin_path),
                            "sha256": sha256_file(bin_path),
                            "mtime": os.path.getmtime(bin_path),
                            "unchanged_during_measurement":
                                os.path.abspath(bin_path) not in changed}

    failures = glb["failures"] + runtime["failures"]
    advisory = glb["advisory_findings"] + runtime["advisory_findings"]
    report = {
        "tool": "tools/blender/peregrine/validate-glb.py",
        "purpose": "independent fresh-scene reimport check of the PEREGRINE "
                   "delivery against docs/design/blender/peregrine/"
                   "build-request.md",
        "command": command,
        "blender_version": bpy.app.version_string,
        "blender_version_tuple": list(bpy.app.version),
        "gun_local_frame": "-Z forward, +Y up, +X right "
                           "(game_x = x, game_y = z, game_z = -y)",
        "tolerances": {
            "coordinate_m": COORD_TOL,
            "identity": IDENTITY_TOL,
            "muzzle_face_epsilon_m": FACE_EPS,
            "round_size_relative": ROUND_SIZE_TOL,
        },
        "expectations": {
            "triangles": EXPECTED_TRIANGLES,
            "primitives": EXPECTED_PRIMITIVES,
            "materials": len(MATERIAL_TEXTURE_MAP),
            "images": EXPECTED_IMAGES,
            "triangle_budget": [TRIANGLE_MIN, TRIANGLE_MAX],
            "primitive_budget": PRIMITIVE_BUDGET,
            "material_budget": MATERIAL_BUDGET,
        },
        "delivered_files": delivered,
        "passed": not failures,
        "failure_count": len(failures),
        "failures": failures,
        "advisory_findings": advisory,
        "advisory_finding_count": len(advisory),
        "targets": {"glb": glb, "runtime_gltf": runtime},
    }

    directory = os.path.dirname(os.path.abspath(json_path))
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(json_path, "w", encoding="utf-8") as handle:
        json.dump(sanitize(report), handle, indent=2, sort_keys=False,
                  allow_nan=False)
        handle.write("\n")

    def target_summary(target):
        accounting = target["triangle_accounting"]
        return {
            "triangles_declared": accounting["declared_in_file"],
            "triangles_imported": accounting["imported_after_reimport"],
            "degenerate_triangles": (accounting["repeat_index_triangles"]
                                     + accounting["zero_area_triangles"]),
            "primitives": target["source_declarations"]
                                  ["declared_primitive_total"],
            "materials": target["imported"]["totals"]["material_count"],
            "images": target["imported"]["totals"]["image_count"],
            "sha256": target["sha256"],
            "unchanged_during_measurement": target[
                "unchanged_during_measurement"],
        }

    summary = {
        "passed": report["passed"],
        "failures": [f"{f['target']}:{f['check']}" for f in failures],
        "advisory": [f"{f['target']}:{f['check']}" for f in advisory],
        "glb": target_summary(glb),
        "runtime_gltf": target_summary(runtime),
        "report": os.path.abspath(json_path),
    }
    print(f"[peregrine-validate] {json.dumps(summary, sort_keys=False)}")
    for failure in failures:
        print(f"[peregrine-validate] FAIL {failure['target']}: "
              f"{failure['check']} measured={failure['measured']!r} "
              f"expected={failure['expected']!r}")
    for finding in advisory:
        print(f"[peregrine-validate] ADVISORY {finding['target']}: "
              f"{finding['check']} measured={finding['measured']!r} "
              f"expected={finding['expected']!r}")
    print("[peregrine-validate] nodes: "
          + json.dumps({target["kind"]: target["imported"]["nodes"]
                        for target in (glb, runtime)}))
    sys.exit(0)


if __name__ == "__main__":
    main()
