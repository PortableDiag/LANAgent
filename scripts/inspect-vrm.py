#!/usr/bin/env python3
"""Inspect a VRM file and output metadata + suggested manifest entry."""
import struct, json, os, sys

def inspect_vrm(filepath):
    with open(filepath, 'rb') as f:
        magic = f.read(4)
        if magic != b'glTF':
            print(f'Not a valid glTF/VRM file')
            return
        f.read(4); f.read(4)
        chunk_len = struct.unpack('<I', f.read(4))[0]
        f.read(4)
        data = json.loads(f.read(chunk_len))

    exts = data.get('extensions', {})

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
    source_id = os.path.basename(filepath).replace('.vrm', '')
    name = meta.get('name', 'Unknown')
    suggested_id = name.lower().replace(' ', '_')[:20].rstrip('_')

    print(f'=== {os.path.basename(filepath)} ===')
    print(f'  VRM Version: {vrm_ver}')
    print(f'  Size: {size_mb} MB')
    print(f'  Name: {name}')
    print(f'  Authors: {meta.get("authors", meta.get("author", "?"))}')
    print(f'  License: {meta.get("licenseUrl", meta.get("licenseName", "?"))}')
    print(f'  Credit required: {meta.get("creditNotation", "?")}')
    print(f'  Bones: {bone_count}')
    print(f'  Spring bones: {spring_count}')
    print(f'  Preset expressions: {preset_exprs}')
    if custom_exprs:
        print(f'  Custom expressions: {custom_exprs}')

    # Compatibility check
    issues = []
    if vrm_ver != '1.0':
        issues.append('VRM 0.x — arm rotation issues likely')
    if 'blink' not in preset_exprs:
        issues.append('Missing blink expression')
    lip_sync = {'aa', 'ih', 'ou', 'ee', 'oh'}
    missing_lip = lip_sync - set(preset_exprs)
    if missing_lip:
        issues.append(f'Missing lip sync expressions: {missing_lip}')
    if size_mb > 30:
        issues.append(f'Large file ({size_mb}MB) — may load slowly')

    if issues:
        print(f'\n  ⚠ Compatibility issues:')
        for i in issues:
            print(f'    - {i}')
    else:
        print(f'\n  ✓ Full compatibility')

    # Manifest entry
    entry = {
        "id": suggested_id,
        "name": name,
        "file": f"{suggested_id}.vrm",
        "sizeMB": size_mb,
        "vrmVersion": vrm_ver,
        "expressions": preset_exprs,
        "boneCount": bone_count,
        "springBoneCount": spring_count,
        "description": "...",
        "sourceId": source_id
    }
    if custom_exprs:
        entry["customExpressions"] = custom_exprs

    print(f'\n  Manifest entry (copy to vrm-manifest.json):')
    print(f'  {json.dumps(entry, indent=2)}')
    print(f'\n  Copy command:')
    print(f'  cp "{filepath}" data/vrm-models/{suggested_id}.vrm')

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <file.vrm> [file2.vrm ...]')
        sys.exit(1)
    for path in sys.argv[1:]:
        inspect_vrm(path)
        print()
