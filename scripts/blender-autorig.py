#!/usr/bin/env python3
"""
Blender headless auto-rigging script for humanoid avatar meshes.
Imports a GLB, creates a humanoid armature sized to the mesh,
parents with automatic weights, and exports a rigged GLB.

Usage: blender --background --python blender-autorig.py -- <input.glb> <output.glb>

The script reads args after '--' to avoid Blender consuming them.
"""
import bpy
import sys
import json
import os
import math
from mathutils import Vector

def clear_scene():
    """Remove all default objects."""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()

def import_glb(filepath):
    """Import GLB and return the mesh object."""
    bpy.ops.import_scene.gltf(filepath=filepath)

    mesh_obj = None
    for obj in bpy.context.scene.objects:
        if obj.type == 'MESH':
            if mesh_obj is None or len(obj.data.vertices) > len(mesh_obj.data.vertices):
                mesh_obj = obj  # Pick largest mesh

    if not mesh_obj:
        raise ValueError("No mesh found in GLB file")

    return mesh_obj

def get_mesh_bounds(mesh_obj):
    """Get world-space bounding box of mesh."""
    bbox = [mesh_obj.matrix_world @ Vector(corner) for corner in mesh_obj.bound_box]
    min_v = Vector((min(v.x for v in bbox), min(v.y for v in bbox), min(v.z for v in bbox)))
    max_v = Vector((max(v.x for v in bbox), max(v.y for v in bbox), max(v.z for v in bbox)))
    size = max_v - min_v
    center = (min_v + max_v) / 2
    return min_v, max_v, size, center

def create_humanoid_armature(min_v, max_v, size, center):
    """Create a humanoid armature scaled to the mesh bounds."""
    height = size.z if size.z > size.y else size.y  # Z-up or Y-up
    is_z_up = size.z >= size.y

    # Determine which axis is up
    if is_z_up:
        up = 2  # Z
        fwd = 1  # Y
        bottom = min_v.z
        top = max_v.z
    else:
        up = 1  # Y
        fwd = 2  # Z
        bottom = min_v.y
        top = max_v.y

    cx, cy = center.x, center[1 if is_z_up else 2]  # center on non-up axes

    # Proportions relative to height (approximate humanoid ratios)
    def pos(x_off, up_frac, fwd_off=0):
        """Create a position vector given x offset, up fraction (0=bottom, 1=top), and forward offset."""
        p = [0, 0, 0]
        p[0] = cx + x_off  # X is always side-to-side
        p[up] = bottom + height * up_frac
        p[fwd] = cy + fwd_off
        return Vector(p)

    # Shoulder width estimate
    sw = size.x * 0.35
    # Hip width estimate
    hw = size.x * 0.15

    bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
    armature_obj = bpy.context.active_object
    armature_obj.name = 'Armature'
    armature = armature_obj.data
    armature.name = 'Armature'

    # Remove the default bone
    for bone in armature.edit_bones:
        armature.edit_bones.remove(bone)

    # Create bones with humanoid proportions
    bones = {}

    def add_bone(name, head_pos, tail_pos, parent_name=None, connect=False):
        bone = armature.edit_bones.new(name)
        bone.head = head_pos
        bone.tail = tail_pos
        if parent_name and parent_name in bones:
            bone.parent = bones[parent_name]
            bone.use_connect = connect
        bones[name] = bone
        return bone

    # Spine chain
    add_bone('Hips', pos(0, 0.45), pos(0, 0.50))
    add_bone('Spine', pos(0, 0.50), pos(0, 0.58), 'Hips', True)
    add_bone('Chest', pos(0, 0.58), pos(0, 0.70), 'Spine', True)
    add_bone('Neck', pos(0, 0.70), pos(0, 0.78), 'Chest', True)
    add_bone('Head', pos(0, 0.78), pos(0, 0.95), 'Neck', True)

    # Left arm
    add_bone('LeftShoulder', pos(0, 0.68), pos(sw * 0.4, 0.68), 'Chest')
    add_bone('LeftUpperArm', pos(sw * 0.4, 0.68), pos(sw, 0.68), 'LeftShoulder', True)
    add_bone('LeftLowerArm', pos(sw, 0.68), pos(sw * 1.4, 0.50), 'LeftUpperArm', True)
    add_bone('LeftHand', pos(sw * 1.4, 0.50), pos(sw * 1.55, 0.45), 'LeftLowerArm', True)

    # Right arm
    add_bone('RightShoulder', pos(0, 0.68), pos(-sw * 0.4, 0.68), 'Chest')
    add_bone('RightUpperArm', pos(-sw * 0.4, 0.68), pos(-sw, 0.68), 'RightShoulder', True)
    add_bone('RightLowerArm', pos(-sw, 0.68), pos(-sw * 1.4, 0.50), 'RightUpperArm', True)
    add_bone('RightHand', pos(-sw * 1.4, 0.50), pos(-sw * 1.55, 0.45), 'RightLowerArm', True)

    # Left leg
    add_bone('LeftUpperLeg', pos(hw, 0.45), pos(hw, 0.24), 'Hips')
    add_bone('LeftLowerLeg', pos(hw, 0.24), pos(hw, 0.05), 'LeftUpperLeg', True)
    add_bone('LeftFoot', pos(hw, 0.05), pos(hw, 0.0, height * 0.06), 'LeftLowerLeg', True)

    # Right leg
    add_bone('RightUpperLeg', pos(-hw, 0.45), pos(-hw, 0.24), 'Hips')
    add_bone('RightLowerLeg', pos(-hw, 0.24), pos(-hw, 0.05), 'RightUpperLeg', True)
    add_bone('RightFoot', pos(-hw, 0.05), pos(-hw, 0.0, height * 0.06), 'RightLowerLeg', True)

    bpy.ops.object.mode_set(mode='OBJECT')
    return armature_obj

def parent_mesh_to_armature(mesh_obj, armature_obj):
    """Parent mesh to armature with automatic weights."""
    # Deselect all
    bpy.ops.object.select_all(action='DESELECT')

    # Select mesh first, then armature (armature must be active)
    mesh_obj.select_set(True)
    armature_obj.select_set(True)
    bpy.context.view_layer.objects.active = armature_obj

    # Parent with automatic weights
    try:
        bpy.ops.object.parent_set(type='ARMATURE_AUTO')
        print("Auto-weights applied successfully", file=sys.stderr)
    except RuntimeError as e:
        # Auto weights can fail on complex meshes — try envelope weights as fallback
        print(f"Auto-weights failed ({e}), trying envelope weights...", file=sys.stderr)
        bpy.ops.object.parent_set(type='ARMATURE_ENVELOPE')
        print("Envelope weights applied as fallback", file=sys.stderr)

def export_glb(filepath, armature_obj):
    """Export scene as GLB with armature and animations."""
    # Select everything for export
    bpy.ops.object.select_all(action='SELECT')

    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format='GLB',
        use_selection=False,
        export_animations=True,
        export_skins=True,
        export_apply=False,  # Don't apply modifiers (preserve armature)
    )

def main():
    # Parse args after '--'
    argv = sys.argv
    if '--' in argv:
        args = argv[argv.index('--') + 1:]
    else:
        print(json.dumps({'success': False, 'error': 'Usage: blender --background --python autorig.py -- <input.glb> <output.glb>'}))
        sys.exit(1)

    if len(args) != 2:
        print(json.dumps({'success': False, 'error': f'Expected 2 args (input output), got {len(args)}'}))
        sys.exit(1)

    input_path = args[0]
    output_path = args[1]

    if not os.path.exists(input_path):
        print(json.dumps({'success': False, 'error': f'Input file not found: {input_path}'}))
        sys.exit(1)

    try:
        print(f"Auto-rigging: {input_path} -> {output_path}", file=sys.stderr)

        # Clear default scene
        clear_scene()

        # Import GLB
        print("Importing GLB...", file=sys.stderr)
        mesh_obj = import_glb(input_path)
        vertex_count = len(mesh_obj.data.vertices)
        print(f"Mesh: {mesh_obj.name}, {vertex_count} vertices", file=sys.stderr)

        # Get bounds
        min_v, max_v, size, center = get_mesh_bounds(mesh_obj)
        height = max(size.x, size.y, size.z)
        print(f"Bounds: min={min_v}, max={max_v}, size={size}, height={height:.3f}", file=sys.stderr)

        # Create armature
        print("Creating humanoid armature...", file=sys.stderr)
        armature_obj = create_humanoid_armature(min_v, max_v, size, center)
        bone_count = len(armature_obj.data.bones)
        print(f"Armature: {bone_count} bones", file=sys.stderr)

        # Parent with automatic weights
        print("Applying automatic weights...", file=sys.stderr)
        parent_mesh_to_armature(mesh_obj, armature_obj)

        # Export
        print("Exporting rigged GLB...", file=sys.stderr)
        export_glb(output_path, armature_obj)

        output_size = os.path.getsize(output_path)
        print(f"Export complete: {output_size} bytes", file=sys.stderr)

        # Output JSON result
        print(json.dumps({
            'success': True,
            'vertices': vertex_count,
            'bones': bone_count,
            'size': output_size,
            'height': round(height, 3)
        }))

    except Exception as e:
        print(json.dumps({
            'success': False,
            'error': f'{type(e).__name__}: {e}'
        }))
        sys.exit(1)

if __name__ == '__main__':
    main()
