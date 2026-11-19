"""Re-export the edited RIVET scene, with its packed textures and animations.

blender --background docs/design/blender/rivet/rivet.blend --python tools/blender/texture-and-export.py
"""
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rivet.blender_scene import OUT, scene_rig
from rivet.standalone import export_skin

export_skin(bpy.context.scene, scene_rig(bpy.context.scene), OUT)
