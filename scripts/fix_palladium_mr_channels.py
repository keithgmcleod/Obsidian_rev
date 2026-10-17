#!/usr/bin/env python3
"""Repair Palladium GLB metallic-roughness texture channel packing.

The source bake stored metallic in red and roughness in green. glTF 2.0 reads
roughness from G and metallic from B, so this pass moves R to B for Palladium
materials while leaving roughness and the existing 2K texture detail untouched.
"""
import io
import json
import os
import struct
import sys
import tempfile

from PIL import Image, ImageStat


def parse_glb(data):
    if len(data) < 20 or data[:4] != b"glTF":
        raise ValueError("Input is not a GLB file")
    magic, version, total_length = struct.unpack_from("<4sII", data, 0)
    if version != 2 or total_length != len(data):
        raise ValueError("Input has an invalid GLB 2.0 header")

    chunks = {}
    offset = 12
    while offset < len(data):
        if offset + 8 > len(data):
            raise ValueError("Truncated GLB chunk header")
        length, chunk_type = struct.unpack_from("<I4s", data, offset)
        offset += 8
        chunks[chunk_type] = data[offset:offset + length]
        if len(chunks[chunk_type]) != length:
            raise ValueError("Truncated GLB chunk payload")
        offset += length

    if b"JSON" not in chunks or b"BIN\x00" not in chunks:
        raise ValueError("Expected JSON and BIN chunks")
    document = json.loads(chunks[b"JSON"].rstrip(b" \t\r\n\x00"))
    return document, chunks[b"BIN\x00"]


def make_glb(document, binary):
    document["buffers"][0]["byteLength"] = len(binary)
    json_bytes = json.dumps(
        document, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    binary += b"\x00" * ((-len(binary)) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(binary)
    return (
        struct.pack("<4sII", b"glTF", 2, total)
        + struct.pack("<I4s", len(json_bytes), b"JSON")
        + json_bytes
        + struct.pack("<I4s", len(binary), b"BIN\x00")
        + binary
    )


def channel_stats(channel):
    stats = ImageStat.Stat(channel)
    low, high = channel.getextrema()
    return {
        "mean": stats.mean[0],
        "stddev": stats.stddev[0],
        "min": low,
        "max": high,
    }


def repack_image(png_bytes, image_name):
    image = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    red, green, blue, alpha = image.split()
    red_stats = channel_stats(red)
    blue_stats = channel_stats(blue)

    # The previous bake placed metallic in R and left the glTF metallic B
    # channel empty. Guard against touching maps that are already packed.
    if blue_stats["max"] <= 2 and red_stats["max"] > 8 and red_stats["stddev"] > 0.5:
        empty_red = Image.new("L", image.size, 0)
        packed = Image.merge("RGBA", (empty_red, green, red, alpha))
        output = io.BytesIO()
        packed.save(output, format="PNG", optimize=True)
        print(
            f"Repacked {image_name}: metallic R -> glTF B; "
            f"R mean {red_stats['mean']:.2f}, G mean {channel_stats(green)['mean']:.2f}"
        )
        return output.getvalue(), True

    print(
        f"Skipped {image_name}: R={red_stats['mean']:.2f} "
        f"(sd {red_stats['stddev']:.2f}), B={blue_stats['mean']:.2f} "
        f"(sd {blue_stats['stddev']:.2f})"
    )
    return png_bytes, False


def fix_glb(path):
    with open(path, "rb") as source:
        original = source.read()
    document, binary_chunk = parse_glb(original)

    if len(document.get("buffers", [])) != 1:
        raise ValueError("Expected one embedded GLB buffer")
    logical_length = document["buffers"][0]["byteLength"]
    if logical_length > len(binary_chunk):
        raise ValueError("GLB buffer length exceeds its binary chunk")
    old_binary = binary_chunk[:logical_length]

    target_views = {}
    materials = document.get("materials", [])
    textures = document.get("textures", [])
    images = document.get("images", [])
    for material in materials:
        if "palladium" not in material.get("name", "").lower():
            continue
        info = material.get("pbrMetallicRoughness", {}).get("metallicRoughnessTexture")
        if not info:
            continue
        texture_index = info["index"]
        image_index = textures[texture_index].get("source")
        if image_index is None or image_index >= len(images):
            continue
        image = images[image_index]
        view_index = image.get("bufferView")
        if view_index is None:
            raise ValueError(f"{image.get('name', 'Palladium image')} is not embedded")
        target_views[view_index] = image.get("name", material.get("name", "Palladium"))

    if not target_views:
        raise ValueError("No embedded Palladium metallic-roughness textures found")

    replacements = {}
    changed = 0
    for view_index, image_name in target_views.items():
        view = document["bufferViews"][view_index]
        start = int(view.get("byteOffset", 0))
        length = int(view["byteLength"])
        end = start + length
        if start < 0 or end > len(old_binary):
            raise ValueError(f"Invalid bufferView bounds for {image_name}")
        updated, did_change = repack_image(old_binary[start:end], image_name)
        if did_change:
            replacements[view_index] = updated
            changed += 1

    if not changed:
        raise ValueError("No Palladium metallic maps needed channel repacking")

    ordered_views = sorted(
        enumerate(document.get("bufferViews", [])),
        key=lambda item: (int(item[1].get("byteOffset", 0)), item[0]),
    )
    new_binary = bytearray()
    cursor = 0
    for view_index, view in ordered_views:
        start = int(view.get("byteOffset", 0))
        old_length = int(view["byteLength"])
        end = start + old_length
        if start < cursor or end > len(old_binary):
            raise ValueError("Overlapping or out-of-range GLB bufferViews")
        new_binary.extend(old_binary[cursor:start])
        view["byteOffset"] = len(new_binary)
        if view_index in replacements:
            image_bytes = replacements[view_index]
            view["byteLength"] = len(image_bytes)
            new_binary.extend(image_bytes)
            new_binary.extend(b"\x00" * ((-len(new_binary)) % 4))
        else:
            new_binary.extend(old_binary[start:end])
        cursor = end

    new_binary.extend(old_binary[cursor:])
    output = make_glb(document, bytes(new_binary))

    directory = os.path.dirname(os.path.abspath(path))
    descriptor, temporary = tempfile.mkstemp(
        prefix=".palladium-mr-", suffix=".glb", dir=directory
    )
    try:
        with os.fdopen(descriptor, "wb") as destination:
            destination.write(output)
        os.replace(temporary, path)
    except Exception:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise

    print(f"Updated {changed} of {len(target_views)} Palladium metallic-roughness maps")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: fix_palladium_mr_channels.py palladium-2k.glb")
    fix_glb(sys.argv[1])
