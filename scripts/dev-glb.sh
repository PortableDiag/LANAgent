#!/bin/bash
# Build model + animations from Unity FBX (same source = matching coordinates)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$PROJECT_DIR/data/glb-models"
ANIM_DIR="$OUT_DIR/animations"
UNITY_FBX="/home/null/Downloads/3D_Models/unity_fbx"
TEX_DIR="/home/null/Downloads/3D_Models/unity_textures"
MIXAMO_DIR="/home/null/Downloads/3D_Models"
mkdir -p "$ANIM_DIR"

cat > /tmp/build_glb.py << 'PYEOF'
import bpy, os, sys

OUT_DIR = sys.argv[-3]
TEX_DIR = sys.argv[-2]
MODE = sys.argv[-1]  # "model" or "anim:filename"
UNITY_FBX = "/home/null/Downloads/3D_Models/unity_fbx"
MIXAMO_DIR = "/home/null/Downloads/3D_Models"

# Clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

if MODE == "model":
    # === BUILD MODEL GLB FROM UNITY FBX ===
    bpy.ops.import_scene.fbx(filepath=f'{UNITY_FBX}/SK_SurvivalGirl.fbx')

    # Remove stray Cube
    for obj in list(bpy.data.objects):
        if obj.name == 'Cube':
            bpy.data.objects.remove(obj, do_unlink=True)

    # Connect textures to materials
    for mat in bpy.data.materials:
        if not mat.node_tree: continue
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        principled = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if not principled: continue

        mat_base = mat.name.replace('M_SG_', '').replace('M_CG_', '')

        # Map material names to texture prefixes
        tex_map = {
            'Body': 'T_Body', 'BodySafe': 'T_BodySafe', 'Head': 'T_Head',
            'Hair': 'T_Hair', 'Eyes': 'T_Eyes', 'EyesShadow': 'T_EyesShadow',
            'Teeth': 'T_Teeth', 'Lashes': 'T_Lashes', 'Pants': 'T_Pants',
            'TankTop': 'T_TankTop', 'Sneakers': 'T_Sneakers', 'Backpack': 'T_Backpack',
            'Respirator': 'T_Respirator', 'Underwear': 'T_Underwear', 'Pubic': 'T_Pubic'
        }

        prefix = tex_map.get(mat_base)
        if not prefix: continue

        # Load and connect BaseColor
        bc_path = os.path.join(TEX_DIR, f'{prefix}_BaseColor.png')
        if os.path.exists(bc_path):
            img = bpy.data.images.load(bc_path)
            tex_node = nodes.new('ShaderNodeTexImage')
            tex_node.image = img
            for link in list(principled.inputs['Base Color'].links): links.remove(link)
            links.new(tex_node.outputs['Color'], principled.inputs['Base Color'])

        # Load and connect Normal
        nm_path = os.path.join(TEX_DIR, f'{prefix}_NormalOpenGL.png')
        if os.path.exists(nm_path):
            img = bpy.data.images.load(nm_path)
            tex_node = nodes.new('ShaderNodeTexImage')
            tex_node.image = img
            tex_node.image.colorspace_settings.name = 'Non-Color'
            nm_node = nodes.new('ShaderNodeNormalMap')
            links.new(tex_node.outputs['Color'], nm_node.inputs['Color'])
            for link in list(principled.inputs['Normal'].links): links.remove(link)
            links.new(nm_node.outputs['Normal'], principled.inputs['Normal'])

        # Set material properties
        if 'EyesGlass' in mat.name:
            principled.inputs['Alpha'].default_value = 0.0
            mat.blend_method = 'BLEND'
        elif 'EyesShadow' in mat.name:
            principled.inputs['Alpha'].default_value = 0.2
            mat.blend_method = 'BLEND'
        elif 'Lash' in mat.name:
            mat.blend_method = 'CLIP'
            mat.alpha_threshold = 0.5
        elif 'Hair' in mat.name:
            mat.blend_method = 'CLIP'
            mat.alpha_threshold = 0.4
            mat.use_backface_culling = True
            # Hair alpha texture
            alpha_path = os.path.join(TEX_DIR, 'T_Hair_Alpha.png')
            if os.path.exists(alpha_path):
                alpha_img = bpy.data.images.load(alpha_path)
                alpha_node = nodes.new('ShaderNodeTexImage')
                alpha_node.image = alpha_img
                alpha_node.image.colorspace_settings.name = 'Non-Color'
                for link in list(principled.inputs['Alpha'].links): links.remove(link)
                links.new(alpha_node.outputs['Color'], principled.inputs['Alpha'])
        else:
            mat.blend_method = 'OPAQUE'

        # Non-metallic for skin/eyes/teeth
        if mat_base in ('Body', 'BodySafe', 'Head', 'Eyes', 'Teeth'):
            principled.inputs['Metallic'].default_value = 0.0
            for link in list(principled.inputs['Metallic'].links): links.remove(link)

        print(f'  Material: {mat.name} -> {prefix}')

    # Export model GLB
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT_DIR, 'survival_girl_unity.glb'),
        export_format='GLB', use_selection=True,
        export_skins=True, export_morph=True,
        export_morph_normal=False, export_morph_tangent=False,
        export_animations=False, export_materials='EXPORT',
        export_image_format='AUTO', export_texcoords=True,
        export_normals=True, export_colors=False, export_apply=False
    )
    print('Model GLB exported!')

else:
    # === CONVERT MIXAMO ANIMATION FBX TO GLB ===
    fbx_file = MODE.split(':', 1)[1]
    bpy.ops.import_scene.fbx(filepath=fbx_file)

    for obj in bpy.data.objects:
        if obj.type == 'ARMATURE' and obj.animation_data:
            action = obj.animation_data.action
            if action:
                print(f'  Animation: {action.name} ({action.frame_range[0]:.0f}-{action.frame_range[1]:.0f})')

    safename = os.path.splitext(os.path.basename(fbx_file))[0].replace(' ', '_').lower()
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(ANIM_DIR, f'{safename}.glb'),
        export_format='GLB', use_selection=True,
        export_skins=True, export_morph=False,
        export_animations=True, export_materials='NONE',
        export_texcoords=False, export_normals=False, export_colors=False
    )
    print(f'Animation exported: {safename}.glb')

PYEOF

# Step 1: Build model from Unity FBX + textures
echo "=== Building model GLB from Unity FBX ==="
blender --background --python /tmp/build_glb.py -- "$OUT_DIR" "$TEX_DIR" "model" 2>&1 | grep -E '(Material:|exported|Error:.*not|Traceback)'

# Step 2: Convert each Mixamo animation
echo ""
echo "=== Converting Mixamo animations ==="
for fbx in "$MIXAMO_DIR/Idle.fbx" "$MIXAMO_DIR/Idle2.fbx" "$MIXAMO_DIR/Happy Idle.fbx" "$MIXAMO_DIR/Standing Idle To Fight Idle.fbx"; do
    [ ! -f "$fbx" ] && continue
    echo "  Converting: $(basename "$fbx")"
    blender --background --python /tmp/build_glb.py -- "$OUT_DIR" "$TEX_DIR" "anim:$fbx" 2>&1 | grep -E '(Animation:|exported|Error)'
done

chmod 644 "$OUT_DIR"/*.glb "$ANIM_DIR"/*.glb 2>/dev/null
echo ""
echo "=== Results ==="
ls -lh "$OUT_DIR/survival_girl_unity.glb"
ls -lh "$ANIM_DIR/"*.glb
echo "Done!"
