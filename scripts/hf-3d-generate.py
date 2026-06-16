#!/usr/bin/env python3
"""
HuggingFace 3D model generation helper.
Called by avatarService.js via child_process.execFile.

Usage: python3 hf-3d-generate.py <input_image_path> <output_glb_path>

Environment: HF_TOKEN or HUGGINGFACE_TOKEN must be set.

Exit codes: 0 = success, 1 = error (message on stderr)
"""
import sys
import os
import json
import shutil
import time
import urllib.request
import io
import contextlib


def download_glb(file_info, output_path, space_url, hf_token):
    """Download GLB file from Gradio result."""
    if isinstance(file_info, dict):
        glb_path = file_info.get('value', file_info.get('path', ''))
    elif isinstance(file_info, str):
        glb_path = file_info
    else:
        raise ValueError(f"Unexpected result type: {type(file_info)}")

    if not glb_path or not glb_path.endswith(('.glb', '.obj')):
        raise ValueError(f"No GLB in result: {str(file_info)[:200]}")

    # Construct download URL
    if glb_path.startswith('http'):
        url = glb_path
    else:
        url = f"{space_url}/file={glb_path}"

    req = urllib.request.Request(url)
    if hf_token:
        req.add_header('Authorization', f'Bearer {hf_token}')

    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()

    if len(data) < 100:
        raise ValueError(f"GLB file too small: {len(data)} bytes")

    with open(output_path, 'wb') as f:
        f.write(data)

    return len(data)


def _quiet_client(space_id, hf_token=None):
    """Create Gradio client without polluting stdout (Gradio prints 'Loaded as ...' etc)."""
    from gradio_client import Client
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):
        client = Client(space_id)
    # Log captured output to stderr instead
    cap = captured.getvalue().strip()
    if cap:
        print(f"[gradio] {cap}", file=sys.stderr)
    return client


def try_hunyuan3d_21(input_path, output_path, hf_token):
    """Try Hunyuan3D-2.1 (Pro tier, 180s GPU)."""
    from gradio_client import handle_file

    space_id = 'tencent/Hunyuan3D-2.1'
    print(f"Connecting to {space_id}...", file=sys.stderr)
    client = _quiet_client(space_id)

    print("Generating 3D model (60-120s)...", file=sys.stderr)
    with contextlib.redirect_stdout(io.StringIO()):
        result = client.predict(
            image=handle_file(input_path),
            steps=30,
            guidance_scale=5.0,
            seed=1234,
            octree_resolution=256,
            check_box_rembg=True,
            num_chunks=8000,
            randomize_seed=False,
            api_name='/generation_all'
        )

    # Result: (white_mesh, textured_mesh, viewer_html, stats, seed)
    if isinstance(result, tuple) and len(result) >= 2:
        glb_info = result[1]  # textured_mesh
    else:
        glb_info = result

    size = download_glb(glb_info, output_path, f"https://tencent-hunyuan3d-2-1.hf.space", hf_token)
    return size


def try_hunyuan3d_2(input_path, output_path, hf_token):
    """Try Hunyuan3D-2 (free tier compatible)."""
    from gradio_client import handle_file

    space_id = 'tencent/Hunyuan3D-2'
    print(f"Connecting to {space_id}...", file=sys.stderr)
    client = _quiet_client(space_id)

    print("Generating 3D model...", file=sys.stderr)
    with contextlib.redirect_stdout(io.StringIO()):
        result = client.predict(
            caption='',
            image=handle_file(input_path),
            steps=30,
            guidance_scale=5.0,
            seed=1234,
            octree_resolution=256,
            check_box_rembg=True,
            num_chunks=8000,
            randomize_seed=False,
            api_name='/generation_all'
        )

    if isinstance(result, tuple) and len(result) >= 2:
        glb_info = result[1]
    else:
        glb_info = result

    size = download_glb(glb_info, output_path, f"https://tencent-hunyuan3d-2.hf.space", hf_token)
    return size


def try_trellis(input_path, output_path, hf_token):
    """Try TRELLIS community Space."""
    from gradio_client import handle_file

    space_id = 'trellis-community/TRELLIS'
    print(f"Connecting to {space_id}...", file=sys.stderr)
    client = _quiet_client(space_id)

    # Start session first
    with contextlib.redirect_stdout(io.StringIO()):
        client.predict(api_name='/start_session')

    print("Generating 3D model...", file=sys.stderr)
    with contextlib.redirect_stdout(io.StringIO()):
        result = client.predict(
            image=handle_file(input_path),
            multiimages=[],
            seed=0,
            ss_guidance_strength=7.5,
            ss_sampling_steps=12,
            slat_guidance_strength=3.0,
            slat_sampling_steps=12,
            multiimage_algo='stochastic',
            mesh_simplify=0.95,
            texture_size='1024',
            api_name='/generate_and_extract_glb'
        )

    # Find GLB in result
    if isinstance(result, tuple):
        for item in result:
            if isinstance(item, str) and item.endswith('.glb'):
                size = download_glb(item, output_path, f"https://trellis-community-trellis.hf.space", hf_token)
                return size
            if isinstance(item, dict):
                val = item.get('value', item.get('path', ''))
                if val.endswith('.glb'):
                    size = download_glb(item, output_path, f"https://trellis-community-trellis.hf.space", hf_token)
                    return size
        raise ValueError(f"No GLB found in TRELLIS result: {str(result)[:300]}")
    else:
        size = download_glb(result, output_path, f"https://trellis-community-trellis.hf.space", hf_token)
        return size


def main():
    if len(sys.argv) != 3:
        print("Usage: python3 hf-3d-generate.py <input_image> <output_glb>", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    hf_token = os.environ.get('HUGGINGFACE_TOKEN') or os.environ.get('HF_TOKEN')
    if not hf_token:
        print("Error: HUGGINGFACE_TOKEN or HF_TOKEN env var required", file=sys.stderr)
        sys.exit(1)

    # Set HF_TOKEN for gradio_client auto-detection
    os.environ['HF_TOKEN'] = hf_token

    if not os.path.exists(input_path):
        print(f"Error: Input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    # Cascade: try each Space in order
    spaces = [
        ('Hunyuan3D-2.1', try_hunyuan3d_21),
        ('Hunyuan3D-2', try_hunyuan3d_2),
        ('TRELLIS', try_trellis),
    ]

    last_error = None
    for name, fn in spaces:
        try:
            print(f"Trying {name}...", file=sys.stderr)
            start = time.time()
            size = fn(input_path, output_path, hf_token)
            elapsed = time.time() - start
            # Output JSON result to stdout
            print(json.dumps({
                'success': True,
                'space': name,
                'size': size,
                'elapsed': round(elapsed, 1),
                'path': output_path
            }))
            sys.exit(0)
        except Exception as e:
            last_error = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
            print(f"{name} failed: {last_error[:300]}", file=sys.stderr)

    # All failed
    print(json.dumps({
        'success': False,
        'error': last_error or 'All spaces failed'
    }))
    sys.exit(1)


if __name__ == '__main__':
    main()
