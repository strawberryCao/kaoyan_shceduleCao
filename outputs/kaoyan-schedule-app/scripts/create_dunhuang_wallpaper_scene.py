import argparse
import math
import os
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector

RIBBONS = []
DUST = None
TOTAL_FRAMES = 480
FPS = 30


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    parser = argparse.ArgumentParser(description="Create a Dunhuang dynamic wallpaper loop in Blender.")
    parser.add_argument("--image", required=True, help="Input Dunhuang still image path")
    parser.add_argument("--output", required=True, help="Output mp4 path")
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--seconds", type=int, default=16)
    parser.add_argument("--quality", choices=["draft", "medium", "high"], default="medium")
    return parser.parse_args(argv)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for block in bpy.data.meshes:
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in bpy.data.materials:
        if block.users == 0:
            bpy.data.materials.remove(block)


def set_origin_camera(width, height):
    camera_data = bpy.data.cameras.new("Camera")
    camera = bpy.data.objects.new("Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (0.0, -8.2, 0.05)
    camera.rotation_euler = (math.radians(90), 0, 0)
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 5.65
    bpy.context.scene.camera = camera

    area = bpy.data.lights.new("Warm Key", type="AREA")
    area.energy = 420
    area.size = 6.0
    light = bpy.data.objects.new("Warm Key", area)
    bpy.context.collection.objects.link(light)
    light.location = (-2.4, -3.4, 3.8)

    fill_data = bpy.data.lights.new("Soft Fill", type="POINT")
    fill_data.energy = 55
    fill = bpy.data.objects.new("Soft Fill", fill_data)
    bpy.context.collection.objects.link(fill)
    fill.location = (3.8, -2.8, 1.2)


def make_emission_image_material(name, image_path):
    image = bpy.data.images.load(image_path)
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = 1.0
    output = nodes.new("ShaderNodeOutputMaterial")
    material.node_tree.links.new(tex.outputs["Color"], emission.inputs["Color"])
    material.node_tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material, image


def make_principled_material(name, color, alpha=1.0, roughness=0.82, metallic=0.0):
    material = bpy.data.materials.new(name)
    material.diffuse_color = color
    material.use_nodes = True
    material.blend_method = "BLEND"
    material.use_screen_refraction = False
    material.show_transparent_back = True
    try:
        material.surface_render_method = "BLENDED"
    except Exception:
        pass
    nodes = material.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    if bsdf:
        if "Base Color" in bsdf.inputs:
            bsdf.inputs["Base Color"].default_value = color
        if "Alpha" in bsdf.inputs:
            bsdf.inputs["Alpha"].default_value = alpha
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = roughness
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = metallic
    return material


def create_background(image_path, width, height):
    mat, _image = make_emission_image_material("Dunhuang Source Image", image_path)
    aspect = width / height
    plane_h = 5.65
    plane_w = plane_h * aspect
    mesh = bpy.data.meshes.new("BackgroundMesh")
    verts = [(-plane_w / 2, 1.55, -plane_h / 2), (plane_w / 2, 1.55, -plane_h / 2), (plane_w / 2, 1.55, plane_h / 2), (-plane_w / 2, 1.55, plane_h / 2)]
    faces = [(0, 1, 2, 3)]
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    mesh.uv_layers.new(name="UVMap")
    uv_data = mesh.uv_layers.active.data
    for loop, uv in zip(uv_data, [(0, 0), (1, 0), (1, 1), (0, 1)]):
        loop.uv = uv
    obj = bpy.data.objects.new("Dunhuang Background", mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def create_ribbon(name, length, width, base_y, base_z, phase, material, x_offset=0.0, tilt=0.0):
    nx = 150
    ny = 10
    mesh = bpy.data.meshes.new(name + "Mesh")
    verts = []
    faces = []
    uvs = []
    for ix in range(nx + 1):
        u = ix / nx
        x = (u - 0.5) * length + x_offset
        center_z = base_z + math.sin(u * math.tau * 1.25 + phase) * 0.18
        center_y = base_y + math.sin(u * math.tau * 0.75 + phase * 0.8) * 0.05
        for iy in range(ny + 1):
            v = iy / ny
            edge = (v - 0.5) * width
            taper = math.sin(u * math.pi) ** 0.28
            verts.append((x, center_y + edge * math.sin(tilt) * 0.12, center_z + edge * taper))
            uvs.append((u, v))
    for ix in range(nx):
        for iy in range(ny):
            a = ix * (ny + 1) + iy
            faces.append((a, a + 1, a + ny + 2, a + ny + 1))
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    mesh.uv_layers.new(name="UVMap")
    for loop in mesh.loops:
        mesh.uv_layers.active.data[loop.index].uv = uvs[loop.vertex_index]
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    RIBBONS.append({
        "obj": obj,
        "length": length,
        "width": width,
        "base_y": base_y,
        "base_z": base_z,
        "phase": phase,
        "x_offset": x_offset,
        "tilt": tilt,
        "nx": nx,
        "ny": ny,
        "original_uvs": uvs,
    })
    return obj


def create_dust_mesh(count, material):
    mesh = bpy.data.meshes.new("DustMesh")
    verts = []
    faces = []
    states = []
    for i in range(count):
        x = random.uniform(-5.4, 5.4)
        y = random.uniform(-0.8, 0.95)
        z = random.uniform(-2.8, 2.7)
        size = random.uniform(0.006, 0.022)
        seed = random.random() * math.tau
        base = len(verts)
        verts.extend([
            (x - size, y, z - size),
            (x + size, y, z - size),
            (x + size, y, z + size),
            (x - size, y, z + size),
        ])
        faces.append((base, base + 1, base + 2, base + 3))
        states.append({"x": x, "y": y, "z": z, "size": size, "seed": seed, "speed": random.uniform(0.010, 0.036)})
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Slow Floating Sand", mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    return {"obj": obj, "states": states}


def update_ribbon_vertices(frame):
    t = ((frame - 1) % TOTAL_FRAMES) / TOTAL_FRAMES
    loop = math.tau * t
    for data in RIBBONS:
        mesh = data["obj"].data
        nx = data["nx"]
        ny = data["ny"]
        for ix in range(nx + 1):
            u = ix / nx
            x = (u - 0.5) * data["length"] + data["x_offset"]
            long_wave = math.sin(u * math.tau * 1.28 + data["phase"] + loop)
            cross_wave = math.sin(u * math.tau * 3.10 + data["phase"] * 1.7 - loop * 0.72)
            center_z = data["base_z"] + long_wave * 0.22 + cross_wave * 0.045
            center_y = data["base_y"] + math.sin(u * math.tau * 0.85 + data["phase"] * 0.8 + loop * 0.45) * 0.070
            for iy in range(ny + 1):
                v = iy / ny
                edge = (v - 0.5) * data["width"]
                taper = math.sin(u * math.pi) ** 0.32
                fold = math.sin(v * math.pi + u * math.tau * 2.0 + loop * 1.25 + data["phase"]) * 0.055
                index = ix * (ny + 1) + iy
                mesh.vertices[index].co = (x, center_y + edge * math.sin(data["tilt"]) * 0.12 + fold, center_z + edge * taper + fold * 0.6)
        mesh.update()


def update_dust_vertices(frame):
    if not DUST:
        return
    t = ((frame - 1) % TOTAL_FRAMES) / TOTAL_FRAMES
    loop = math.tau * t
    mesh = DUST["obj"].data
    for i, state in enumerate(DUST["states"]):
        drift = loop + state["seed"]
        x = state["x"] + math.sin(drift * 0.55) * 0.28 + t * state["speed"] * 18.0
        z = state["z"] + math.sin(drift * 1.1) * 0.055 + math.cos(drift * 0.35) * 0.09
        y = state["y"] + math.sin(drift * 0.72) * 0.04
        if x > 5.5:
            x -= 11.0
        size = state["size"] * (1.0 + 0.45 * math.sin(drift * 1.7))
        base = i * 4
        mesh.vertices[base].co = (x - size, y, z - size)
        mesh.vertices[base + 1].co = (x + size, y, z - size)
        mesh.vertices[base + 2].co = (x + size, y, z + size)
        mesh.vertices[base + 3].co = (x - size, y, z + size)
    mesh.update()


def frame_handler(scene):
    frame = scene.frame_current
    update_ribbon_vertices(frame)
    update_dust_vertices(frame)


def configure_render(args):
    global TOTAL_FRAMES, FPS
    FPS = args.fps
    TOTAL_FRAMES = args.seconds * args.fps
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = TOTAL_FRAMES
    scene.frame_set(1)
    scene.render.fps = args.fps
    scene.render.resolution_x = args.width
    scene.render.resolution_y = args.height
    scene.render.resolution_percentage = 100

    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        scene.render.engine = "BLENDER_EEVEE"

    if hasattr(scene, "eevee"):
        try:
            scene.eevee.taa_render_samples = 64 if args.quality == "high" else 32 if args.quality == "medium" else 16
        except Exception:
            pass
        try:
            scene.eevee.use_bloom = True
            scene.eevee.bloom_intensity = 0.045
            scene.eevee.bloom_radius = 5.5
        except Exception:
            pass

    scene.view_settings.view_transform = "Filmic"
    scene.view_settings.look = "Medium High Contrast"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(output_path)
    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "MEDIUM" if args.quality != "high" else "HIGH"
    scene.render.ffmpeg.ffmpeg_preset = "GOOD"


def main():
    args = parse_args()
    clear_scene()
    configure_render(args)
    set_origin_camera(args.width, args.height)
    create_background(args.image, args.width, args.height)

    silk_mat_a = make_principled_material("Warm Translucent Silk A", (1.0, 0.78, 0.42, 0.28), 0.28, 0.58)
    silk_mat_b = make_principled_material("Soft Ivory Silk B", (1.0, 0.92, 0.72, 0.18), 0.18, 0.64)
    dust_mat = make_principled_material("Fine Sand Dust", (1.0, 0.78, 0.42, 0.22), 0.22, 0.88)

    create_ribbon("Main Silk Stream", 8.8, 0.78, -0.16, -0.18, 0.15, silk_mat_a, x_offset=-0.65, tilt=-0.45)
    create_ribbon("Far Silk Stream", 6.7, 0.55, 0.12, 1.02, 2.4, silk_mat_b, x_offset=1.35, tilt=0.38)
    create_ribbon("Low Silk Whisper", 7.6, 0.36, 0.05, -1.65, 4.1, silk_mat_b, x_offset=1.05, tilt=-0.22)

    global DUST
    DUST = create_dust_mesh(520 if args.quality == "high" else 360 if args.quality == "medium" else 220, dust_mat)

    bpy.app.handlers.frame_change_pre.clear()
    bpy.app.handlers.frame_change_pre.append(frame_handler)
    bpy.context.scene.frame_set(1)
    frame_handler(bpy.context.scene)

    blend_path = Path(args.output).with_suffix(".blend")
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    bpy.ops.render.render(animation=True)


if __name__ == "__main__":
    main()
