#!/bin/bash
# Dev remote operations — edit and re-run without param approval
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Deploy original Blender models + manifest + avatar.html
cd "$PROJECT_DIR"
"$SCRIPT_DIR/deployment/deploy-files.sh" --no-restart \
  data/glb-models/survival_girl.glb \
  data/glb-models/survival_girl_2k.glb \
  src/interfaces/web/public/avatar.html \
  src/interfaces/web/public/glb-manifest.json

echo "Done! Hard refresh browser."
