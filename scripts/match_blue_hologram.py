#!/usr/bin/env python3
"""Copy the Obsidian hologram maps onto the matching BILT Blue material."""

import copy
import json
import struct
import sys
from pathlib import Path

GLB_HEADER = struct.Struct("<4sII")
CHUNK_HEADER = struct.Struct("<I4s")
ALIGNMENT = 4


def align(value):
    return (value + ALIGNMENT - 1) & ~(ALIGNMENT - 1)


def read_glb(path):
    data = Path(path).read_bytes()
    magic, version, total_length = GLB_HEADER.unpack_from(data)
    if magic != b"glTF" or version != 2 or total_length != len(data):
        raise ValueError(f"{path}: expected a complete glTF 2.0 binary file")

    chunks = []
    offset = GLB_HEADER.size
    while offset < len(data):
        length, chunk_type = CHUNK_HEADER.unpack_from(data, offset)
        start = offset + CHUNK_HEADER.size
        end = start + length
        if end > len(data):
            raise ValueError(f"{path}: GLB chunk extends past end of file")
        chunks.append((chunk_type, data[start:end]))
        offset = end

    json_index = next((i for i, (kind, _) in enumerate(chunks) if kind == b"JSON"), None)
    bin_index = next((i for i, (kind, _) in enumerate(chunks) if kind == b"BIN\0"), None)
    if json_index is None or bin_index is None:
        raise ValueError(f"{path}: GLB must contain JSON and BIN chunks")
    document = json.loads(chunks[json_index][1].rstrip(b" \0").decode("utf-8"))
    return chunks, json_index, bin_index, document


def hologram_material(document, path):
    matches = [
        material for material in document.get("materials", [])
        if material.get("name", "").lower().startswith("hologram_2.")
    ]
    if len(matches) != 1:
        raise ValueError(f"{path}: expected one Hologram_2 material, found {len(matches)}")
    return matches[0]


def image_bytes(document, binary, texture_info, path, role):
    if not texture_info or "index" not in texture_info:
        raise ValueError(f"{path}: hologram is missing its {role} texture")
    texture = document["textures"][texture_info["index"]]
    image_index = texture.get("source")
    if image_index is None:
        raise ValueError(f"{path}: hologram {role} texture has no source image")
    image = document["images"][image_index]
    if image.get("mimeType") != "image/png" or "bufferView" not in image:
        raise ValueError(f"{path}: expected an embedded PNG for hologram {role}")
    buffer_view = document["bufferViews"][image["bufferView"]]
    start = buffer_view.get("byteOffset", 0)
    end = start + buffer_view["byteLength"]
    if end > len(binary):
        raise ValueError(f"{path}: hologram {role} image exceeds the binary chunk")
    return bytes(binary[start:end]), image, texture


def texture_info_at(material, role):
    pbr = material.setdefault("pbrMetallicRoughness", {})
    clearcoat = material.setdefault("extensions", {}).setdefault("KHR_materials_clearcoat", {})
    paths = {
        "baseColor": (pbr, "baseColorTexture"),
        "metallicRoughness": (pbr, "metallicRoughnessTexture"),
        "clearcoat": (clearcoat, "clearcoatTexture"),
        "clearcoatRoughness": (clearcoat, "clearcoatRoughnessTexture"),
    }
    owner, key = paths[role]
    return owner, key, owner.get(key)


def main():
    blue_path = Path(sys.argv[1] if len(sys.argv) > 1 else "bilt-blue-2k.glb")
    obsidian_path = Path(sys.argv[2] if len(sys.argv) > 2 else "obsidian-2k.glb")
    blue_chunks, blue_json_index, blue_bin_index, blue_doc = read_glb(blue_path)
    _, _, _, obsidian_doc = read_glb(obsidian_path)

    blue_material = hologram_material(blue_doc, blue_path)
    obsidian_material = hologram_material(obsidian_doc, obsidian_path)
    blue_binary = bytearray(blue_chunks[blue_bin_index][1])
    obsidian_binary = None
    obsidian_raw = Path(obsidian_path).read_bytes()
    offset = GLB_HEADER.size
    while offset < len(obsidian_raw):
        length, chunk_type = CHUNK_HEADER.unpack_from(obsidian_raw, offset)
        start = offset + CHUNK_HEADER.size
        if chunk_type == b"BIN\0":
            obsidian_binary = obsidian_raw[start:start + length]
            break
        offset = start + length
    if obsidian_binary is None:
        raise ValueError(f"{obsidian_path}: missing BIN chunk")

    # Copy each Obsidian map into a new embedded Blue image, then point only the
    # Blue hologram material at it. Other Blue card maps remain untouched.
    new_image_by_source = {}
    new_texture_by_source = {}
    copied_bytes = 0
    for role in ("baseColor", "metallicRoughness", "clearcoat", "clearcoatRoughness"):
        blue_owner, blue_key, blue_info = texture_info_at(blue_material, role)
        _, _, obsidian_info = texture_info_at(obsidian_material, role)
        if not obsidian_info:
            if blue_info:
                blue_owner.pop(blue_key, None)
            continue

        png, source_image, source_texture = image_bytes(
            obsidian_doc, obsidian_binary, obsidian_info, obsidian_path, role
        )
        source_image_key = source_texture["source"]
        if source_image_key not in new_image_by_source:
            while len(blue_binary) % ALIGNMENT:
                blue_binary.append(0)
            image_offset = len(blue_binary)
            blue_binary.extend(png)
            copied_bytes += len(png)
            view_index = len(blue_doc["bufferViews"])
            blue_doc["bufferViews"].append({
                "buffer": 0,
                "byteOffset": image_offset,
                "byteLength": len(png),
            })
            image = {
                "name": source_image.get("name", f"Obsidian Hologram {role}"),
                "mimeType": "image/png",
                "bufferView": view_index,
            }
            image_index = len(blue_doc["images"])
            blue_doc["images"].append(image)
            new_image_by_source[source_image_key] = image_index

        sampler_key = source_texture.get("sampler")
        texture_key = (source_image_key, sampler_key)
        if texture_key not in new_texture_by_source:
            texture = {key: copy.deepcopy(value) for key, value in source_texture.items() if key != "source"}
            texture["source"] = new_image_by_source[source_image_key]
            if sampler_key is not None:
                sampler = obsidian_doc["samplers"][sampler_key]
                sampler_copy_key = json.dumps(sampler, sort_keys=True)
                target_samplers = blue_doc.setdefault("samplers", [])
                existing = next((i for i, item in enumerate(target_samplers) if item == sampler), None)
                if existing is None:
                    existing = len(target_samplers)
                    target_samplers.append(copy.deepcopy(sampler))
                texture["sampler"] = existing
            texture_index = len(blue_doc["textures"])
            blue_doc["textures"].append(texture)
            new_texture_by_source[texture_key] = texture_index

        blue_owner[blue_key] = copy.deepcopy(blue_info)
        blue_owner[blue_key]["index"] = new_texture_by_source[texture_key]

    # Match scalar PBR and clearcoat values too, while retaining the Blue material name.
    blue_pbr = blue_material.setdefault("pbrMetallicRoughness", {})
    obsidian_pbr = obsidian_material.get("pbrMetallicRoughness", {})
    for key in ("baseColorFactor", "metallicFactor", "roughnessFactor"):
        if key in obsidian_pbr:
            blue_pbr[key] = copy.deepcopy(obsidian_pbr[key])
        else:
            blue_pbr.pop(key, None)
    for key in ("doubleSided", "alphaMode", "alphaCutoff"):
        if key in obsidian_material:
            blue_material[key] = copy.deepcopy(obsidian_material[key])
        else:
            blue_material.pop(key, None)
    blue_clearcoat = blue_material.setdefault("extensions", {}).setdefault("KHR_materials_clearcoat", {})
    obsidian_clearcoat = obsidian_material.get("extensions", {}).get("KHR_materials_clearcoat", {})
    for key in ("clearcoatFactor", "clearcoatRoughnessFactor"):
        if key in obsidian_clearcoat:
            blue_clearcoat[key] = copy.deepcopy(obsidian_clearcoat[key])
        else:
            blue_clearcoat.pop(key, None)

    blue_doc["buffers"][0]["byteLength"] = len(blue_binary)
    json_bytes = json.dumps(blue_doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % ALIGNMENT)
    blue_chunks[blue_json_index] = (b"JSON", json_bytes)
    blue_chunks[blue_bin_index] = (b"BIN\0", bytes(blue_binary))

    output = bytearray(GLB_HEADER.pack(b"glTF", 2, 0))
    for chunk_type, payload in blue_chunks:
        output.extend(CHUNK_HEADER.pack(len(payload), chunk_type))
        output.extend(payload)
    struct.pack_into("<I", output, 8, len(output))
    blue_path.write_bytes(output)
    print(
        f"Matched BILT Blue hologram to Obsidian: copied {len(new_image_by_source)} maps "
        f"({copied_bytes:,} bytes); output GLB is {len(output):,} bytes."
    )


if __name__ == "__main__":
    main()
