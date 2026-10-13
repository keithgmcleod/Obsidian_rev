#!/usr/bin/env python3
"""Increase BILT Obsidian body roughness by 50%, preserving hologram and clip."""

import io
import json
import struct
import sys
from pathlib import Path

from PIL import Image

GLB_HEADER = struct.Struct("<4sII")
CHUNK_HEADER = struct.Struct("<I4s")
ROUGHNESS_MULTIPLIER = 1.5


def align4(value):
    return (value + 3) & ~3


def read_glb(path):
    data = Path(path).read_bytes()
    magic, version, total = GLB_HEADER.unpack_from(data)
    if magic != b"glTF" or version != 2 or total != len(data):
        raise ValueError(f"{path}: expected a complete glTF 2.0 binary file")
    chunks = []
    offset = GLB_HEADER.size
    while offset < len(data):
        length, kind = CHUNK_HEADER.unpack_from(data, offset)
        start = offset + CHUNK_HEADER.size
        end = start + length
        if end > len(data):
            raise ValueError(f"{path}: chunk extends past end of file")
        chunks.append((kind, data[start:end]))
        offset = end
    json_index = next((i for i, (kind, _) in enumerate(chunks) if kind == b"JSON"), None)
    bin_index = next((i for i, (kind, _) in enumerate(chunks) if kind == b"BIN\0"), None)
    if json_index is None or bin_index is None:
        raise ValueError(f"{path}: GLB must contain JSON and BIN chunks")
    document = json.loads(chunks[json_index][1].rstrip(b" \0").decode("utf-8"))
    return chunks, json_index, bin_index, document


def roughen_png(png_bytes):
    with Image.open(io.BytesIO(png_bytes)) as source:
        if source.mode not in ("RGB", "RGBA"):
            raise ValueError(f"Expected RGB/RGBA ORM image, got {source.mode}")
        source.load()
        channels = list(source.split())
        channels[1] = channels[1].point(
            lambda value: min(255, int(value * ROUGHNESS_MULTIPLIER + 0.5))
        )
        output = io.BytesIO()
        Image.merge(source.mode, channels).save(output, format="PNG", optimize=False)
        return output.getvalue()


def roughen_texture_info(document, binary, texture_info, label):
    if not texture_info or "index" not in texture_info:
        return False
    texture = document["textures"][texture_info["index"]]
    image_index = texture.get("source")
    if image_index is None:
        raise ValueError(f"{label}: texture has no source image")
    image = document["images"][image_index]
    if image.get("mimeType") != "image/png" or "bufferView" not in image:
        raise ValueError(f"{label}: expected an embedded PNG texture")
    view = document["bufferViews"][image["bufferView"]]
    start = view.get("byteOffset", 0)
    end = start + view["byteLength"]
    if end > len(binary):
        raise ValueError(f"{label}: texture extends past the GLB binary chunk")

    updated_png = roughen_png(binary[start:end])
    while len(binary) % 4:
        binary.append(0)
    new_offset = len(binary)
    binary.extend(updated_png)
    new_view_index = len(document["bufferViews"])
    document["bufferViews"].append({
        "buffer": 0,
        "byteOffset": new_offset,
        "byteLength": len(updated_png),
    })
    new_image = copy_image = dict(image)
    new_image["name"] = f'{image.get("name", label)}_roughness_plus50'
    new_image["bufferView"] = new_view_index
    new_image_index = len(document["images"])
    document["images"].append(new_image)
    new_texture = dict(texture)
    new_texture["source"] = new_image_index
    new_texture_index = len(document["textures"])
    document["textures"].append(new_texture)
    texture_info["index"] = new_texture_index
    return True


def is_card_body_material(material):
    name = material.get("name", "").lower()
    if "hologram" in name or "clip" in name:
        return False
    return "obsidian" in name or name.startswith(("left_", "middle_", "right_"))


def main():
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "obsidian-2k.glb")
    chunks, json_index, bin_index, document = read_glb(path)
    binary = bytearray(chunks[bin_index][1])
    updated_maps = 0
    updated_factors = 0
    material_count = 0

    for material in document.get("materials", []):
        if not is_card_body_material(material):
            continue
        material_count += 1
        pbr = material.setdefault("pbrMetallicRoughness", {})
        mr_info = pbr.get("metallicRoughnessTexture")
        if mr_info:
            updated_maps += roughen_texture_info(document, binary, mr_info, material.get("name", "card"))
        else:
            current = pbr.get("roughnessFactor", 1.0)
            pbr["roughnessFactor"] = min(1.0, current * ROUGHNESS_MULTIPLIER)
            updated_factors += 1

        clearcoat = material.get("extensions", {}).get("KHR_materials_clearcoat", {})
        coat_info = clearcoat.get("clearcoatRoughnessTexture")
        if coat_info:
            updated_maps += roughen_texture_info(document, binary, coat_info, material.get("name", "card") + " clearcoat")
        elif "clearcoatRoughnessFactor" in clearcoat:
            clearcoat["clearcoatRoughnessFactor"] = min(
                1.0, clearcoat["clearcoatRoughnessFactor"] * ROUGHNESS_MULTIPLIER
            )

    if material_count == 0:
        raise ValueError("No Obsidian card body materials were found")
    document["buffers"][0]["byteLength"] = len(binary)
    json_bytes = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    chunks[json_index] = (b"JSON", json_bytes)
    chunks[bin_index] = (b"BIN\0", bytes(binary))

    output = bytearray(GLB_HEADER.pack(b"glTF", 2, 0))
    for kind, payload in chunks:
        output.extend(CHUNK_HEADER.pack(len(payload), kind))
        output.extend(payload)
    struct.pack_into("<I", output, 8, len(output))
    path.write_bytes(output)
    print(
        f"Increased roughness by 50% for {material_count} Obsidian body materials; "
        f"updated {updated_maps} roughness maps and {updated_factors} scalar-only materials."
    )


if __name__ == "__main__":
    main()
