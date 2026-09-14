#!/usr/bin/env python3
"""Independently validate an exported weapon GLB/glTF by re-importing it.

Imports the file into a fresh, empty factory scene and writes a JSON report
covering node structure, geometry, materials, images, UVs, world bounds and a
list of concrete sanity problems.  Nothing here reads repo code; the file is
the single source of truth.

Usage:
    blender --background --factory-startup --python validate-glb.py -- <file.glb> <out.json>

Fallbacks (used when the corresponding CLI argument is absent):
    OMPW_GLB   - source .glb/.gltf path
    OMPW_JSON  - report destination path

Exit codes: 0 report written, 1 bad usage / failure, 2 import or report error.
"""

from __future__ import annotations

import base64
import json
import math
import os
import struct
import sys
import traceback

import bpy
import numpy as np

# Triangle area at or below this (world space, m^2) counts as degenerate.
AREA_EPS = 1e-12

EXPECTED_PARTS = (
    "body",
    "mag",
    "bolt",
    "trigger",
    "factory-optic",
    "muzzle",
    "grip",
    "support",
    "sight",
)


# --------------------------------------------------------------------------- #
# CLI / source parsing
# --------------------------------------------------------------------------- #
def parse_cli(argv):
    """Return (source_path, report_path) from post-`--` args, env fallbacks."""
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    src = args[0] if len(args) > 0 and args[0] else os.environ.get("OMPW_GLB", "")
    dst = args[1] if len(args) > 1 and args[1] else os.environ.get("OMPW_JSON", "")
    return src, dst


def read_gltf_json(path):
    """Return the glTF JSON dict for a .gltf or binary .glb file."""
    with open(path, "rb") as handle:
        blob = handle.read()
    if blob[:4] == b"glTF":
        magic, _version, total = struct.unpack_from("<III", blob, 0)
        if magic != 0x46546C67:
            raise ValueError("not a GLB container")
        offset = 12
        while offset + 8 <= min(total, len(blob)):
            chunk_len, chunk_type = struct.unpack_from("<II", blob, offset)
            offset += 8
            if chunk_type == 0x4E4F534A:  # 'JSON'
                return json.loads(blob[offset:offset + chunk_len].decode("utf-8"))
            offset += chunk_len
        raise ValueError("GLB has no JSON chunk")
    return json.loads(blob.decode("utf-8"))


def source_node_summary(doc):
    """Top-level node names declared by the file itself (pre-import truth)."""
    nodes = doc.get("nodes", []) or []
    child_idx = set()
    for node in nodes:
        for child in node.get("children", []) or []:
            child_idx.add(child)
    top = [i for i in range(len(nodes)) if i not in child_idx]
    names = [nodes[i].get("name", "") for i in top]
    counts = {}
    for name in names:
        counts[name] = counts.get(name, 0) + 1
    return {
        "declared_top_level_nodes": names,
        "declared_node_count": len(nodes),
        "declared_duplicate_top_level_names": sorted(
            n for n, c in counts.items() if c > 1
        ),
    }


def source_image_summary(doc, source_path):
    """How each glTF image is stored: embedded bufferView or external uri."""
    images = doc.get("images", []) or []
    base = os.path.dirname(os.path.abspath(source_path))
    out = []
    for index, img in enumerate(images):
        uri = img.get("uri")
        entry = {
            "index": index,
            "declared_name": img.get("name") or os.path.basename(uri or f"image{index}"),
            "declared_mime_type": img.get("mimeType"),
            "embedded_in_buffer": "bufferView" in img,
            "declared_uri": uri,
            "uri_is_external": bool(uri) and not uri.startswith("data:"),
            "uri_is_data_uri": bool(uri) and uri.startswith("data:"),
        }
        if entry["uri_is_external"]:
            entry["resolved_uri_path"] = os.path.normpath(os.path.join(base, uri))
            entry["uri_file_exists"] = os.path.isfile(entry["resolved_uri_path"])
        out.append(entry)
    return out


def buffer_payloads(doc, source_path):
    """Raw bytes for each glTF buffer: embedded, data URI or external file."""
    with open(source_path, "rb") as handle:
        blob = handle.read()
    is_glb = blob[:4] == b"glTF"

    payloads = []
    base = os.path.dirname(os.path.abspath(source_path))
    for entry in doc.get("buffers", []) or []:
        uri = entry.get("uri")
        if uri is None:
            payloads.append(_glb_binary_chunk(blob) if is_glb else b"")
        elif uri.startswith("data:"):
            payloads.append(base64.b64decode(uri.split(",", 1)[1]))
        else:
            path = os.path.normpath(os.path.join(base, uri))
            payloads.append(open(path, "rb").read() if os.path.isfile(path) else b"")
    return payloads


def _glb_binary_chunk(blob):
    """The GLB 'BIN' chunk, or b'' when absent."""
    if blob[:4] != b"glTF" or len(blob) < 12:
        return b""
    magic, _version, total = struct.unpack_from("<III", blob, 0)
    offset = 12
    while offset + 8 <= min(total, len(blob)):
        chunk_len, chunk_type = struct.unpack_from("<II", blob, offset)
        offset += 8
        if chunk_type == 0x004E4942:  # 'BIN'
            return blob[offset:offset + chunk_len]
        offset += chunk_len
    return b""


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
    accessors = doc.get("accessors", []) or []
    if index is None or index >= len(accessors):
        return None
    accessor = accessors[index]
    view_index = accessor.get("bufferView")
    views = doc.get("bufferViews", []) or []
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


def source_geometry_summary(doc, source_path):
    """Declared triangle counts and POSITION finiteness straight from the file.

    The Blender importer silently rewrites non-finite coordinates to 0.0, so
    the file itself has to be inspected to detect that corruption class.
    """
    payloads = buffer_payloads(doc, source_path)
    accessors = doc.get("accessors", []) or []
    nodes_by_mesh = {}
    for node in doc.get("nodes", []) or []:
        if node.get("mesh") is not None:
            nodes_by_mesh.setdefault(node["mesh"], []).append(node.get("name", ""))

    meshes = []
    problems = []
    for mesh_index, mesh in enumerate(doc.get("meshes", []) or []):
        name = mesh.get("name") or f"mesh{mesh_index}"
        entry = {
            "mesh_index": mesh_index,
            "name": name,
            "node_names": nodes_by_mesh.get(mesh_index, []),
            "primitives": 0,
            "declared_triangles": 0,
            "non_finite_position_components": 0,
        }
        for primitive in mesh.get("primitives", []) or []:
            entry["primitives"] += 1
            attributes = primitive.get("attributes", {}) or {}
            indices = primitive.get("indices")
            if indices is not None and indices < len(accessors):
                entry["declared_triangles"] += int(accessors[indices].get("count", 0)) // 3
            elif attributes.get("POSITION") is not None:
                position_accessor = accessors[attributes["POSITION"]] \
                    if attributes["POSITION"] < len(accessors) else {}
                entry["declared_triangles"] += int(position_accessor.get("count", 0)) // 3

            positions = accessor_array(doc, payloads, attributes.get("POSITION"))
            if positions is None:
                continue
            finite = np.isfinite(positions)
            bad = int((~finite).sum())
            if bad:
                entry["non_finite_position_components"] += bad
                bad_rows = np.flatnonzero((~finite).any(axis=1))
                row = int(bad_rows[0]) if len(bad_rows) else -1
                problems.append({
                    "check": "non_finite_vertex_coordinates",
                    "target": f"mesh '{name}' POSITION accessor "
                              f"{attributes.get('POSITION')}",
                    "value": f"{bad} non-finite component(s) across "
                             f"{len(positions)} vertices; first bad vertex "
                             f"({row}) = {positions[row].tolist()}",
                })
        meshes.append(entry)
    return meshes, problems


def source_material_summary(doc):
    """Raw PBR values declared by the file, keyed by material name."""
    out = {}
    for index, mat in enumerate(doc.get("materials", []) or []):
        pbr = mat.get("pbrMetallicRoughness", {}) or {}
        out[mat.get("name") or f"material{index}"] = {
            "index": index,
            "baseColorFactor": pbr.get("baseColorFactor"),
            "baseColorTexture": (pbr.get("baseColorTexture") or {}).get("index"),
            "metallicFactor": pbr.get("metallicFactor"),
            "roughnessFactor": pbr.get("roughnessFactor"),
            "alphaMode": mat.get("alphaMode", "OPAQUE"),
            "doubleSided": mat.get("doubleSided", False),
            "has_emissive": "emissiveFactor" in mat
            or "emissiveTexture" in mat,
        }
    return out


# --------------------------------------------------------------------------- #
# Scene inspection helpers
# --------------------------------------------------------------------------- #
def base_name(name):
    """Strip Blender's `.001` uniqueness suffix so real duplicates surface."""
    head, dot, tail = name.rpartition(".")
    if dot and tail.isdigit() and len(tail) == 3:
        return head
    return name


def world_vertex_array(obj):
    """(n, 3) float64 array of an object's vertices in world space."""
    mesh = obj.data
    count = len(mesh.vertices)
    if count == 0:
        return np.zeros((0, 3), dtype=np.float64)
    flat = np.empty(count * 3, dtype=np.float64)
    mesh.vertices.foreach_get("co", flat)
    local = flat.reshape(count, 3)
    matrix = np.array(obj.matrix_world, dtype=np.float64)
    return local @ matrix[:3, :3].T + matrix[:3, 3]


def triangle_indices(mesh):
    """(m, 3) int array of loop-triangle vertex indices."""
    mesh.calc_loop_triangles()
    count = len(mesh.loop_triangles)
    if count == 0:
        return np.zeros((0, 3), dtype=np.int64)
    flat = np.empty(count * 3, dtype=np.int32)
    mesh.loop_triangles.foreach_get("vertices", flat)
    return flat.reshape(count, 3).astype(np.int64)


# Per-object mesh statistics cache; see `mesh_stats`.
_MESH_STATS = {}


def mesh_stats(obj):
    """Triangles plus the geometry problems found on one mesh object.
    Memoised: nodes, the per-mesh table and the sanity pass all report on the
    same imported scene, and re-running `calc_loop_triangles` per caller was
    pure duplicated work.  The process imports exactly one scene and exits.
    """
    cached = _MESH_STATS.get(obj.name)
    if cached is not None:
        return cached
    mesh = obj.data
    tris = triangle_indices(mesh)
    positions = world_vertex_array(obj)
    stats = {
        "object": obj.name,
        "name": obj.name,
        "triangles": int(len(tris)),
        "vertices": int(len(mesh.vertices)),
        "polygons": int(len(mesh.polygons)),
        "materials": [
            slot.material.name if slot.material else None
            for slot in obj.material_slots
        ],
        "uv_layers": [layer.name for layer in mesh.uv_layers],
        "non_finite_vertices": 0,
        "zero_area_triangles": 0,
    }
    if len(positions):
        finite = np.isfinite(positions).all(axis=1)
        stats["non_finite_vertices"] = int((~finite).sum())
        if indices_in_range(positions, tris):
            coords = positions[tris]
            edge1 = coords[:, 1] - coords[:, 0]
            edge2 = coords[:, 2] - coords[:, 0]
            areas = 0.5 * np.linalg.norm(np.cross(edge1, edge2), axis=1)
            stats["zero_area_triangles"] = int((areas <= AREA_EPS).sum())
    _MESH_STATS[obj.name] = stats
    return stats


def indices_in_range(positions, tris):
    """True when triangle indices stay inside the vertex array."""
    if len(tris) == 0:
        return False
    return bool(tris.max() < len(positions) and tris.min() >= 0)


def scale_problem(obj):
    """Measured value string when an object's scale is non-positive."""
    scale = tuple(float(v) for v in obj.matrix_world.to_scale())
    if any(not math.isfinite(v) or v <= 0.0 for v in scale):
        return f"world scale = {tuple(round(v, 6) for v in scale)}"
    return None


def principled_node(material):
    """The material's Principled BSDF node, or None. `use_nodes` is deprecated
    (removed in 6.0) and always True in 5.x, so read the tree directly."""
    if material is None:
        return None
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


def socket_value(socket):
    """Numeric default of a socket, or None when absent / non-scalar."""
    if socket is None:
        return None
    value = getattr(socket, "default_value", None)
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        seq = list(value)
    except TypeError:
        return None
    return [float(v) for v in seq]


def material_report(material, source_materials):
    """Imported Principled values plus the file's declared PBR factors."""
    node = principled_node(material)
    entry = {
        "name": material.name,
        "source_name": base_name(material.name),
        "blend_method": getattr(material, "blend_method", None),
        "surface_render_method": getattr(material, "surface_render_method", None),
        "use_backface_culling": bool(getattr(material, "use_backface_culling", False)),
        "has_principled": node is not None,
        "has_base_color_image": False,
        "base_color_image": None,
        "metallic": None,
        "metallic_linked": False,
        "roughness": None,
        "roughness_linked": False,
        "alpha": None,
        "declared": source_materials.get(base_name(material.name)),
    }
    if node is None:
        return entry

    base_color = node.inputs.get("Base Color")
    image = find_image_upstream(base_color)
    entry["has_base_color_image"] = image is not None
    entry["base_color_image"] = image.name if image else None
    entry["base_color_factor_imported"] = socket_value(base_color)

    for key, socket_name in (("metallic", "Metallic"), ("roughness", "Roughness"),
                             ("alpha", "Alpha")):
        socket = node.inputs.get(socket_name)
        entry[key] = socket_value(socket)
        entry[f"{key}_linked"] = bool(socket is not None and socket.is_linked)
    return entry


def image_report(image):
    """Packed/external state, byte size and pixel dimensions."""
    packed = image.packed_file
    filepath = bpy.path.abspath(image.filepath) if image.filepath else ""
    if packed is not None:
        byte_size = int(packed.size)
        storage = "packed"
    elif filepath and os.path.isfile(filepath):
        byte_size = int(os.path.getsize(filepath))
        storage = "external"
    else:
        byte_size = 0
        storage = "missing"
    return {
        "name": image.name,
        "storage": storage,
        "packed": packed is not None,
        "filepath": filepath,
        "byte_size": byte_size,
        "width": int(image.size[0]),
        "height": int(image.size[1]),
        "source": image.source,
    }


# --------------------------------------------------------------------------- #
# Report assembly
# --------------------------------------------------------------------------- #
def marker_nodes_report():
    """Geometry-free nodes: mount points that own no mesh in their subtree.

    Marker parts (muzzle, grip, support, sight) are intentionally EMPTY nodes
    carrying a transform.  Their local translation is the mount point, so it is
    reported numerically instead of being silently dropped.
    """
    markers = []
    for obj in sorted(bpy.context.scene.objects, key=lambda o: o.name):
        if obj.type == "MESH":
            continue
        if any(member.type == "MESH" for member in subtree(obj)):
            continue
        markers.append({
            "name": obj.name,
            "base_name": base_name(obj.name),
            "type": obj.type,
            "parent": obj.parent.name if obj.parent else None,
            "top_level": obj.parent is None,
            "child_count": len(obj.children),
            "location_local": [float(v) for v in obj.location],
            "location_world": [float(v) for v in obj.matrix_world.translation],
            "scale": [float(v) for v in obj.scale],
        })
    return markers


def top_level_nodes():
    return [obj for obj in bpy.context.scene.objects if obj.parent is None]


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


def nodes_report():
    """One entry per top-level node with aggregated mesh/triangle/material data."""
    entries = []
    for root in top_level_nodes():
        members = subtree(root)
        meshes = [obj for obj in members if obj.type == "MESH"]
        materials = []
        triangles = 0
        for obj in meshes:
            triangles += mesh_stats(obj)["triangles"]
            for slot in obj.material_slots:
                if slot.material and slot.material.name not in materials:
                    materials.append(slot.material.name)
        entries.append({
            "name": root.name,
            "base_name": base_name(root.name),
            "type": root.type,
            "mesh_count": len(meshes),
            "triangles": triangles,
            "materials": sorted(materials),
            "children": [obj.name for obj in members if obj is not root],
        })
    return entries


def duplicate_top_level_names(nodes, declared):
    """Real duplicates: post-import, both as-named and with suffix stripped."""
    exact = {}
    for entry in nodes:
        exact[entry["name"]] = exact.get(entry["name"], 0) + 1
    stripped = {}
    for entry in nodes:
        stripped[entry["base_name"]] = stripped.get(entry["base_name"], 0) + 1
    return sorted(set(
        [n for n, c in exact.items() if c > 1]
        + [n for n, c in stripped.items() if c > 1]
        + list(declared)
    ))


def world_bounds(mesh_objects):
    """World-space min/max/centre/size over every imported mesh."""
    chunks = []
    per_object = []
    for obj in mesh_objects:
        positions = world_vertex_array(obj)
        if not len(positions):
            continue
        finite = positions[np.isfinite(positions).all(axis=1)]
        if not len(finite):
            continue
        per_object.append((obj.name, finite.min(axis=0), finite.max(axis=0)))
        chunks.append(finite)
    if not chunks:
        return None
    stacked = np.vstack(chunks)
    minimum = stacked.min(axis=0)
    maximum = stacked.max(axis=0)
    centre = (minimum + maximum) * 0.5
    size = maximum - minimum
    return {
        "min": [float(v) for v in minimum],
        "max": [float(v) for v in maximum],
        "centre": [float(v) for v in centre],
        "size": [float(v) for v in size],
        "per_object": [
            {
                "object": name,
                "min": [float(v) for v in lo],
                "max": [float(v) for v in hi],
            }
            for name, lo, hi in sorted(per_object)
        ],
    }


def sanity_checks(mesh_objects, material_entries, duplicates, nodes,
                  source_problems=()):
    """Every problem found, each naming its object/material and measured value."""
    problems = list(source_problems)

    def add(kind, target, value):
        problems.append({"check": kind, "target": target, "value": value})

    for obj in bpy.context.scene.objects:
        bad = scale_problem(obj)
        if bad:
            add("non_positive_object_scale", obj.name, bad)

    for obj in mesh_objects:
        stats = mesh_stats(obj)
        if stats["non_finite_vertices"]:
            add("non_finite_vertices", obj.name,
                f"{stats['non_finite_vertices']} non-finite vertex coordinates "
                f"of {stats['vertices']}")
        if stats["zero_area_triangles"]:
            add("zero_area_triangles", obj.name,
                f"{stats['zero_area_triangles']} triangles with world area "
                f"<= {AREA_EPS:g} of {stats['triangles']}")
        if stats["triangles"] == 0:
            add("no_triangles", obj.name, "0 triangles")
        used = [name for name in stats["materials"] if name]
        if not used:
            add("mesh_without_material", obj.name,
                f"0 of {len(obj.material_slots)} material slots assigned")
        elif len(used) != len(obj.material_slots):
            add("empty_material_slot", obj.name,
                f"{len(obj.material_slots) - len(used)} empty slots of "
                f"{len(obj.material_slots)}")

    for report in material_entries:
        if not report["has_principled"]:
            material = bpy.data.materials.get(report["name"])
            tree = getattr(material, "node_tree", None)
            add("material_without_principled_bsdf", report["name"],
                f"{len(tree.nodes) if tree else 0} shader nodes, "
                f"no BSDF_PRINCIPLED")
        elif not report["has_base_color_image"]:
            add("material_without_base_texture", report["name"],
                f"base color image = {report['base_color_image']}")

    for name in duplicates:
        count = sum(1 for entry in nodes if entry["base_name"] == name)
        add("duplicate_node_name", name,
            f"appears {count} time(s) as a top-level node name")

    return problems


def build_report(source_path):
    doc = read_gltf_json(source_path)
    source_materials = source_material_summary(doc)
    source_geometry, source_problems = source_geometry_summary(doc, source_path)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source_path)
    _MESH_STATS.clear()

    scene_objects = list(bpy.context.scene.objects)
    mesh_objects = [obj for obj in scene_objects if obj.type == "MESH"]
    nodes = nodes_report()
    source_nodes = source_node_summary(doc)

    # Part presence uses the real (un-suffixed) name so Blender's dedup cannot
    # hide a part the exporter emitted twice.  Every imported scene object
    # counts, not just mesh-bearing subtrees: marker nodes (muzzle, grip,
    # support, sight) are deliberately geometry-free EMPTYs that carry a mount
    # point, so a mesh-derived scan would report them missing.
    present_names = {base_name(obj.name) for obj in scene_objects}
    for obj in scene_objects:
        parent = obj.parent
        while parent is not None:
            present_names.add(base_name(parent.name))
            parent = parent.parent
    # Names declared in the glTF scene graph as well, so a node the importer
    # failed to materialise still cannot silently pass as present.
    declared_top = {base_name(name) for name in
                    source_nodes["declared_top_level_nodes"]}
    declared_imported = {base_name(obj.name) for obj in top_level_nodes()}
    present_names |= declared_top & declared_imported

    materials = list(bpy.data.materials)
    material_entries = [material_report(m, source_materials) for m in materials]
    material_lookup = {entry["name"]: entry for entry in material_entries}

    meshes = []
    uv_counts = {}
    zero_uv = []
    for obj in sorted(mesh_objects, key=lambda o: o.name):
        stats = mesh_stats(obj)
        # Copy: the cached entry keeps plain material names for the sanity pass.
        entry = dict(stats)
        entry["materials"] = [
            {
                "name": name,
                "has_base_color_image": material_lookup.get(name, {}).get(
                    "has_base_color_image", False),
            }
            for name in stats["materials"]
        ]
        meshes.append(entry)
        if stats["uv_layers"]:
            for layer in stats["uv_layers"]:
                uv_counts[layer] = uv_counts.get(layer, 0) + 1
        else:
            zero_uv.append(obj.name)

    duplicates = duplicate_top_level_names(
        nodes, source_nodes["declared_duplicate_top_level_names"])
    bounds = world_bounds(mesh_objects)
    if bounds is not None:
        # glTF is Y-up; the report keeps the imported axes and re-labels them.
        bounds["game_coords_y_up"] = {
            "note": "labels as-is: game_x = x, game_y = y, game_z = z "
                    "(axis conversion is the export's responsibility)",
            "min": bounds["min"],
            "max": bounds["max"],
            "centre": bounds["centre"],
            "size": bounds["size"],
        }

    triangle_total = int(sum(m["triangles"] for m in meshes))
    images = [image_report(image) for image in bpy.data.images]
    source_images = source_image_summary(doc, source_path)
    declared_by_name = {
        os.path.basename(entry["declared_name"]): entry for entry in source_images
    }
    imported_names = {entry["name"] for entry in images}
    for entry in images:
        entry["declared"] = declared_by_name.get(entry["name"])
    for entry in source_images:
        name = os.path.basename(entry["declared_name"])
        entry["imported"] = name in imported_names
        entry["imported_name"] = name if name in imported_names else None
    unused_declared = [e["declared_name"] for e in source_images if not e["imported"]]

    report = {
        "source": {
            "path": os.path.abspath(source_path),
            "byte_size": os.path.getsize(source_path),
            "generator": (doc.get("asset") or {}).get("generator"),
            "version": (doc.get("asset") or {}).get("version"),
        },
        "source_declarations": source_nodes,
        "source_geometry": source_geometry,
        "nodes": nodes,
        "duplicate_top_level_names": duplicates,
        "parts_present": {name: (name in present_names) for name in EXPECTED_PARTS},
        "parts_missing": [n for n in EXPECTED_PARTS if n not in present_names],
        "marker_nodes_without_geometry": marker_nodes_report(),
        "materials": material_entries,
        "images": images,
        "source_images": source_images,
        "images_summary": {
            "declared_in_file": len(source_images),
            "imported_into_scene": len(imported_names),
            "declared_embedded_in_buffer": sum(
                1 for e in source_images if e["embedded_in_buffer"]),
            "declared_external_uri": sum(
                1 for e in source_images if e["uri_is_external"]),
            "declared_but_unreferenced_by_any_material": unused_declared,
            "note": "glTF images unreferenced by any material are dropped by the "
                    "importer, so `images` can be shorter than `source_images`",
        },
        "uv_layers": {
            "per_mesh": [
                {"object": m["object"], "uv_layers": m["uv_layers"],
                 "triangle_count": m["triangles"]}
                for m in meshes
            ],
            "layer_usage": uv_counts,
            "meshes_without_uv": zero_uv,
            "mesh_count_with_zero_uv_layers": len(zero_uv),
        },
        "bounds_world": bounds,
        "sanity": sanity_checks(mesh_objects, material_entries, duplicates, nodes,
                                source_problems),
        "totals": {
            "object_count": len(scene_objects),
            "mesh_object_count": len(mesh_objects),
            "non_mesh_object_count": len(scene_objects) - len(mesh_objects),
            "triangle_count": triangle_total,
            "material_count": len(materials),
            "distinct_image_count": len({i["name"] for i in images}),
        },
    }
    report["totals"]["sanity_problem_count"] = len(report["sanity"])
    return report


def sanitize(value):
    """Replace non-finite floats so the report is always strict, valid JSON.

    `json.dump` would otherwise emit bare `NaN`/`Infinity`, which most JSON
    consumers reject.
    """
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: sanitize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize(item) for item in value]
    return value


def main():
    source, destination = parse_cli(sys.argv)
    if not source or not destination:
        sys.stderr.write(
            "usage: blender --background --factory-startup --python "
            "validate-glb.py -- <file.glb|file.gltf> <out.json>\n"
            "       (fallbacks: OMPW_GLB, OMPW_JSON)\n")
        sys.exit(1)
    if not os.path.isfile(source):
        sys.stderr.write(f"error: source not found: {source}\n")
        sys.exit(2)

    try:
        report = build_report(source)
    except Exception:
        traceback.print_exc()
        sys.stderr.write(f"error: failed to validate {source}\n")
        sys.exit(2)

    directory = os.path.dirname(os.path.abspath(destination))
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(sanitize(report), handle, indent=2, sort_keys=False,
                  allow_nan=False)
        handle.write("\n")

    totals = report["totals"]
    print(f"[validate-glb] {report['source']['path']} -> {destination}")
    print(f"[validate-glb] objects={totals['object_count']} "
          f"meshes={totals['mesh_object_count']} "
          f"triangles={totals['triangle_count']} "
          f"materials={totals['material_count']} "
          f"images={totals['distinct_image_count']}")
    print(f"[validate-glb] nodes={[n['name'] for n in report['nodes']]}")
    print(f"[validate-glb] sanity problems={totals['sanity_problem_count']}")
    sys.exit(0)


if __name__ == "__main__":
    main()
