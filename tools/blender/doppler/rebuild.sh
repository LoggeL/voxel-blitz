#!/bin/sh
# Rebuild the SP-2 DOPPLER end to end: decals, study + bake, runtime export, proof renders.
#   tools/blender/doppler/rebuild.sh [--fast] [--size 2048]
set -e
cd "$(dirname "$0")/../../.."
BLENDER="${BLENDER:-blender}"
python3 tools/blender/doppler/make-decals.py
"$BLENDER" --background --factory-startup --python-exit-code 1 --python tools/blender/doppler/build-doppler.py -- "$@" 2>&1 | grep -E '^\[doppler\]|Error|Traceback|^  File' || true
"$BLENDER" --background --factory-startup docs/design/blender/doppler/doppler.blend --python-exit-code 1 --python tools/blender/doppler/export-doppler.py 2>&1 | grep -E '^\[export\]|Error|Traceback|^  File' || true
