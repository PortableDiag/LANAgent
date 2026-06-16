# VRM Avatar Guide

How to find, download, and add VRM avatar models to LANAgent.

## What is VRM?

VRM is a 3D avatar format based on glTF2. It includes:
- **Skeleton** (humanoid bones) for animation
- **Expressions** (blend shapes) for facial animation
- **Spring bones** for hair/cloth physics
- **Look-at** for eye tracking
- **Materials** optimized for real-time rendering

**Always use VRM 1.0** — it has standardized bone naming, better expression support, and proper animation retargeting. VRM 0.x models have compatibility issues.

## Finding Models on VRoid Hub

1. Go to [VRoid Hub](https://hub.vroid.com/en)
2. Browse characters or search
3. Click a model to view its page
4. The URL format is: `https://hub.vroid.com/en/characters/{charId}/models/{modelId}`

### Checking Model Quality

On the model page, look for:
- **VRM version**: The 3D viewer should show the version. Prefer VRM 1.0
- **Expression preview**: Click expression buttons to see if the model has good blend shapes
- **Spring bones**: Hair/cloth that moves = spring bones present
- **License**: Check the "Conditions of Use" section — most VRoid Hub models are free for personal use

### Downloading

1. You must be logged in to VRoid Hub
2. Click the **Download** button on the model page
3. The file saves as `{modelId}.vrm` (e.g., `780423365268674163.vrm`)

## Extracting Model Info

Use this Python script to extract all metadata from a VRM file:

```python
import struct, json, os

def inspect_vrm(filepath):
    with open(filepath, 'rb') as f:
        magic = f.read(4)
        if magic != b'glTF':
            print(f'Not a valid glTF/VRM file')
            return
        version = struct.unpack('<I', f.read(4))[0]
        total_len = struct.unpack('<I', f.read(4))[0]
        chunk_len = struct.unpack('<I', f.read(4))[0]
        f.read(4)  # chunk type
        data = json.loads(f.read(chunk_len))

    exts = data.get('extensions', {})

    # Detect VRM version
    if 'VRMC_vrm' in exts:
        vrm_ver = '1.0'
        meta = exts['VRMC_vrm'].get('meta', {})
        expressions = exts['VRMC_vrm'].get('expressions', {})
        preset_exprs = list(expressions.get('preset', {}).keys())
        custom_exprs = list(expressions.get('custom', {}).keys())
        humanoid = exts['VRMC_vrm'].get('humanoid', {})
        bone_count = len(humanoid.get('humanBones', {}))
        spring_ext = exts.get('VRMC_springBone', {})
        spring_count = len(spring_ext.get('springs', []))
    elif 'VRM' in exts:
        vrm_ver = '0.x'
        meta = exts['VRM'].get('meta', {})
        groups = exts['VRM'].get('blendShapeMaster', {}).get('blendShapeGroups', [])
        preset_exprs = [g.get('presetName', '') for g in groups if g.get('presetName')]
        custom_exprs = [g.get('name', '') for g in groups if not g.get('presetName')]
        humanoid = exts['VRM'].get('humanoid', {})
        bone_count = len(humanoid.get('humanBones', []))
        secondary = exts['VRM'].get('secondaryAnimation', {})
        spring_count = len(secondary.get('boneGroups', []))
    else:
        print('No VRM extension found')
        return

    size_mb = round(os.path.getsize(filepath) / 1024 / 1024, 1)

    print(f'=== {os.path.basename(filepath)} ===')
    print(f'  VRM Version: {vrm_ver}')
    print(f'  Size: {size_mb} MB')
    print(f'  Name: {meta.get("name", "unnamed")}')
    print(f'  Authors: {meta.get("authors", meta.get("author", "?"))}')
    print(f'  License: {meta.get("licenseUrl", meta.get("licenseName", "?"))}')
    print(f'  Credit required: {meta.get("creditNotation", "?")}')
    print(f'  Bones: {bone_count}')
    print(f'  Spring bones: {spring_count}')
    print(f'  Preset expressions: {preset_exprs}')
    if custom_exprs:
        print(f'  Custom expressions: {custom_exprs}')
    print()

    # Output manifest entry
    source_id = os.path.basename(filepath).replace('.vrm', '')
    suggested_id = meta.get('name', source_id).lower().replace(' ', '_')[:20]
    print(f'  Suggested manifest entry:')
    print(f'  {{')
    print(f'    "id": "{suggested_id}",')
    print(f'    "name": "{meta.get("name", "Unknown")}",')
    print(f'    "file": "{suggested_id}.vrm",')
    print(f'    "sizeMB": {size_mb},')
    print(f'    "vrmVersion": "{vrm_ver}",')
    print(f'    "expressions": {json.dumps(preset_exprs)},')
    if custom_exprs:
        print(f'    "customExpressions": {json.dumps(custom_exprs)},')
    print(f'    "boneCount": {bone_count},')
    print(f'    "springBoneCount": {spring_count},')
    print(f'    "description": "...",')
    print(f'    "sourceId": "{source_id}"')
    print(f'  }}')

# Usage:
# inspect_vrm('/path/to/model.vrm')
```

Save this as `scripts/inspect-vrm.py` and run:
```bash
python3 scripts/inspect-vrm.py /path/to/downloaded.vrm
```

## Adding a Model to LANAgent

### 1. Copy the VRM file

```bash
# Choose a short lowercase name
cp /path/to/downloaded.vrm data/vrm-models/mymodel.vrm
```

### 2. Add to the manifest

Edit `src/interfaces/web/public/vrm-manifest.json` and add an entry. Use the inspect script output as a template:

```json
{
  "id": "mymodel",
  "name": "My Model",
  "file": "mymodel.vrm",
  "sizeMB": 15.0,
  "vrmVersion": "1.0",
  "expressions": ["happy", "angry", "sad", "relaxed", "surprised", "aa", "ih", "ou", "ee", "oh", "blink", "blinkLeft", "blinkRight", "neutral"],
  "boneCount": 54,
  "springBoneCount": 20,
  "description": "Description here",
  "sourceId": "780423365268674163"
}
```

### 3. Sync the data manifest

The web server serves VRM models from `DATA_PATH/vrm-models/`, not the public directory. Keep both in sync:

```bash
cp src/interfaces/web/public/vrm-manifest.json data/vrm-models/manifest.json
```

### 4. Deploy to production

If running via deployment scripts:
```bash
./scripts/deployment/deploy-files.sh data/vrm-models/mymodel.vrm src/interfaces/web/public/vrm-manifest.json
```

Or copy manually to your server's data directory. No restart needed — static files.

### 5. Verify

```bash
curl -s http://localhost:3000/vrm-models/manifest.json | python3 -m json.tool
```

## VRM Compatibility Checklist

For best results with LANAgent's avatar system:

| Feature | Required | Notes |
|---------|----------|-------|
| VRM 1.0 | Yes | VRM 0.x has broken arm rotations |
| `blink` expression | Yes | Used for automatic blink cycle |
| `aa`, `ih`, `ou`, `ee`, `oh` | Recommended | Used for lip sync |
| `happy`, `angry`, `sad` | Recommended | Used for emotion display |
| Spring bones | Optional | Hair/cloth physics |
| < 20MB | Recommended | Larger models load slowly |

## VRMA Animations

Animations are stored in `data/vrm-models/animations/` as `.vrma` files (VRM Animation format — glTF2 with `VRMC_vrm_animation` extension).

### Sources

| Source | URL | License |
|--------|-----|---------|
| VRoid Hub Official | `https://hub.vroid.com/public/animations/VRMA_01.vrma` (01-07) | pixiv Inc., credit required |
| tk256ailab/vrm-viewer | GitHub repo | MIT |
| DavinciDreams/3dchat | GitHub repo (Mixamo conversions) | Mixamo royalty-free |

### Converting Mixamo to VRMA

1. Download an animation from [Mixamo](https://www.mixamo.com/) as FBX
2. Use [fbx2vrma-converter](https://github.com/tk256ailab/fbx2vrma-converter) to convert
3. Place the `.vrma` file in `data/vrm-models/animations/`
4. Add it to the animation list in `avatar.html` and/or `playground.html`

## Architecture

| Component | File | Purpose |
|-----------|------|---------|
| VRM manifest | `src/interfaces/web/public/vrm-manifest.json` | Model catalog |
| Data manifest | `data/vrm-models/manifest.json` | Served by web server |
| VRM files | `data/vrm-models/*.vrm` | Model files |
| Animations | `data/vrm-models/animations/*.vrma` | Animation clips |
| Avatar Designer | `src/interfaces/web/public/avatar.html` | Model selection, customization, bust render |
| Playground | `src/interfaces/web/public/playground.html` | Interactive 3D with activities |
| Static route | `webInterface.js` line 82 | `app.use('/vrm-models', express.static(...))` |
| Active model API | `GET/PUT /api/agent/vrm` | Persists selection in MongoDB |
| Active model field | `Agent.activeVRMModel` | Database field |
