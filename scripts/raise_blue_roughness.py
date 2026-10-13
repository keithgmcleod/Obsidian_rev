#!/usr/bin/env python3
"""Raise the BILT Blue GLB roughness texture by 10 percent."""

import io
import json
import struct
import sys
from pathlib import Path

from PIL import Image

GLB_HEADER = struct.Struct("<4sII")
CHUNK_HEADER = struct.Struct("<I4s")
ROUGHNESS_MULTIPLIER = 1.10


def align4(value: int) -> int:
    return (value + 3) & ~3


def read_glb(path: Path):
    data = path.read_bytes()
    magic, version, total_length = GLB_HEADER.unpack_from(data)
    if magic != b"glTF" or version != 2 or total_length != len(data):
        raise ValueError("Expected a complete glTF 2.0 binary file")

    chunks = []
    offset = GLB_HEADER.size
    while offset < len(data):
        length, chunk_type = CHUNK_HEADER.unpack_from(data, offset)
        start = offset + CHUNK_HEADER.size
        end = start + length
        if end > len(data):
            raise ValueError("GLB chunk extends past end of file")
        chunks.append((chunk_type, data[start:end]))
        offset = end

    json_index = next((i for i, (kind, _) in enumerate(chunks) if kind == b"JSON"), None)
    bin_index = next((i for i, (kind, _) in enumerate(chunks) if kind == b"BIN\0"), None)
    if json_index is None or bin_index is None:
        raise ValueError("GLB must contain JSON and BIN chunks")

    document = json.loads(chunks[json_index][1].rstrip(b"\0 ").decode("utf-8"))
    return chunks, json_index, bin_index, document


def blue_orm_image(document):
    blue_materials = [
        material for material in document.get("materials", [])
        if material.get("name", "").startswith("BLUE_WEB4K_PBR_")
    ]
    if len(blue_materials) != 3:
        raise ValueError(f"Expected 3 BILT Blue materials; found {len(blue_materials)}")

    image_indices = set()
    for material in blue_materials:
        pbr = material.get("pbrMetallicRoughness", {})
        texture_info = pbr.get("metallicRoughnessTexture")
        if not texture_info:
            raise ValueError(f"Missing roughness map on {material['name']}")
        texture_index = texture_info["index"]
        image_indices.add(document["textures"][texture_index]["source"])

    if len(image_indices) != 1:
        raise ValueError("BILT Blue materials do not share one ORM texture")

    image_index = image_indices.pop()
    image = document["images"][image_index]
    if image.get("mimeType") != "image/png" or "bufferView" not in image:
        raise ValueError("Expected the embedded BILT Blue ORM map to be a PNG")
    return image["bufferView"]


def raise_green_channel(png_bytes: bytes) -> bytes:
    with Image.open(io.BytesIO(png_bytes)) as source:
        if source.mode not in ("RGB", "RGBA"):
            raise ValueError(f"Expected an RGB or RGBA ORM map; got {source.mode}")
        source.load()
        channels = list(source.split())
        green = channels[1].point(
            lambda value: min(255, int(value * ROUGHNESS_MULTIPLIER + 0.5))
        )
        channels[1] = green
        updated = Image.merge(source.mode, channels)
        output = io.BytesIO()
        updated.save(output, format="PNG", optimize=False)
        return output.getvalue()


def main():
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "bilt-blue-2k.glb")
    chunks, json_index, bin_index, document = read_glb(path)
    binary = chunks[bin_index][1]

    view_index = blue_orm_image(document)
    view = document["bufferViews"][view_index]
    image_offset = view.get("byteOffset", 0)
    image_length = view["byteLength"]
    old_aligned_end = align4(image_offset + image_length)
    if old_aligned_end > len(binary):
        raise ValueError("BILT Blue ORM map extends past the GLB binary chunk")

    updated_png = raise_green_channel(binary[image_offset:image_offset + image_length])
    new_aligned_png = updated_png + b"\0" * ((-len(updated_png)) % 4)
    delta = len(new_aligned_png) - (old_aligned_end - image_offset)
    new_binary = binary[:image_offset] + new_aligned_png + binary[old_aligned_end:]

    view["byteLength"] = len(updated_png)
    for other_index, other_view in enumerate(document["bufferViews"]):
        if other_index != view_index:
            other_offset = other_view.get("byteOffset", 0)
            if other_offset >= old_aligned_end:
                other_view["byteOffset"] = other_offset + delta
    document["buffers"][0]["byteLength"] = len(new_binary)

    json_bytes = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    chunks[json_index] = (b"JSON", json_bytes)
    chunks[bin_index] = (b"BIN\0", new_binary)

    output = bytearray(GLB_HEADER.pack(b"glTF", 2, 0))
    for chunk_type, payload in chunks:
        output.extend(CHUNK_HEADER.pack(len(payload), chunk_type))
        output.extend(payload)
    struct.pack_into("<I", output, 8, len(output))
    path.write_bytes(output)

    print(
        f"Raised the BILT Blue ORM roughness channel by 10% "
        f"({len(updated_png):,} byte PNG; {len(output):,} byte GLB)."
    )


if __name__ == "__main__":
    main()
