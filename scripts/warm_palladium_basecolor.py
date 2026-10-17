import io
import json
import os
import struct
import sys
import tempfile

from PIL import Image, ImageEnhance


MATERIAL_TOKEN = "full-card"
IMAGE_MARKER = "biltPalladiumWarmSilverVersion"
VERSION = "warm-silver-1"
SATURATION = 1.18
CHANNEL_GAIN = (1.03, 1.012, 0.97)


def read_glb(path):
    with open(path, "rb") as source:
        data = source.read()
    if len(data) < 28 or data[:4] != b"glTF":
        raise ValueError(f"{path} is not a GLB file")
    version, declared_length = struct.unpack_from("<II", data, 4)
    if version != 2 or declared_length != len(data):
        raise ValueError(f"{path} has an invalid GLB header")

    json_length = struct.unpack_from("<I", data, 12)[0]
    if data[16:20] != b"JSON":
        raise ValueError(f"{path} does not start with a JSON chunk")
    document = json.loads(data[20:20 + json_length])

    bin_header = 20 + json_length
    if data[bin_header + 4:bin_header + 8] != b"BIN\x00":
        raise ValueError(f"{path} is missing its GLB BIN chunk")
    bin_length = struct.unpack_from("<I", data, bin_header)[0]
    bin_start = bin_header + 8
    binary = bytearray(data[bin_start:bin_start + bin_length])
    if len(binary) != bin_length:
        raise ValueError(f"{path} has a truncated BIN chunk")
    return document, binary


def warm_silver_png(png_bytes):
    with Image.open(io.BytesIO(png_bytes)) as source:
        source.load()
        if source.format != "PNG":
            raise ValueError(f"Expected embedded PNG base-colour texture, got {source.format}")
        rgba = source.convert("RGBA")

    red, green, blue, alpha = rgba.split()
    colour = Image.merge("RGB", (red, green, blue))
    colour = ImageEnhance.Color(colour).enhance(SATURATION)
    channels = colour.split()
    warmed = tuple(
        channel.point(lambda value, gain=gain: max(0, min(255, int(round(value * gain)))))
        for channel, gain in zip(channels, CHANNEL_GAIN)
    )
    result = Image.merge("RGBA", (*warmed, alpha))
    output = io.BytesIO()
    result.save(output, format="PNG", optimize=True)
    return output.getvalue(), rgba.size


def material_base_colour_image(material, textures, images):
    pbr = material.get("pbrMetallicRoughness", {})
    info = pbr.get("baseColorTexture")
    if not info:
        return None, None
    texture_index = info.get("index")
    if texture_index is None or not 0 <= texture_index < len(textures):
        raise ValueError(f"Invalid base-colour texture in material {material.get('name', '')!r}")
    texture = textures[texture_index]
    image_index = texture.get("source")
    if image_index is None:
        raise ValueError("Palladium base-colour texture must use a standard embedded image source")
    if not 0 <= image_index < len(images):
        raise ValueError("Palladium base-colour image index is out of range")
    return texture_index, image_index


def encode_glb(document, binary, replacements):
    records = []
    appended_views = []
    for index, view in enumerate(document.get("bufferViews", [])):
        if view.get("_appendBytes"):
            appended_views.append(index)
            continue
        if view.get("buffer", 0) != 0:
            raise ValueError("Only the single embedded GLB buffer is supported")
        offset = int(view.get("byteOffset", 0))
        length = int(view["byteLength"])
        if offset < 0 or length < 0 or offset + length > len(binary):
            raise ValueError(f"Invalid bufferView {index}")
        records.append((offset, index, length))

    records.sort()
    new_binary = bytearray()
    cursor = 0
    for offset, index, length in records:
        if offset < cursor:
            raise ValueError(f"Overlapping bufferView at index {index}")
        new_binary.extend(binary[cursor:offset])
        while len(new_binary) % 4:
            new_binary.append(0)
        view = document["bufferViews"][index]
        view["byteOffset"] = len(new_binary)
        payload = replacements.get(index, binary[offset:offset + length])
        view["byteLength"] = len(payload)
        new_binary.extend(payload)
        cursor = offset + length

    new_binary.extend(binary[cursor:])
    for index in appended_views:
        while len(new_binary) % 4:
            new_binary.append(0)
        view = document["bufferViews"][index]
        payload = replacements.get(index)
        if payload is None:
            raise ValueError(f"Missing appended image bytes for bufferView {index}")
        view.pop("_appendBytes", None)
        view["byteOffset"] = len(new_binary)
        view["byteLength"] = len(payload)
        new_binary.extend(payload)
    while len(new_binary) % 4:
        new_binary.append(0)
    document["buffers"][0]["byteLength"] = len(new_binary)

    json_bytes = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    bin_bytes = bytes(new_binary)
    total_length = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    return (
        struct.pack("<4sII", b"glTF", 2, total_length)
        + struct.pack("<I4s", len(json_bytes), b"JSON")
        + json_bytes
        + struct.pack("<I4s", len(bin_bytes), b"BIN\x00")
        + bin_bytes
    )


def tint_palladium(path):
    document, binary = read_glb(path)
    materials = document.get("materials", [])
    textures = document.get("textures", [])
    images = document.get("images", [])
    targets = [
        material for material in materials
        if "palladium" in material.get("name", "").lower()
        and MATERIAL_TOKEN in material.get("name", "").lower()
    ]
    if len(targets) != 1:
        found = [material.get("name", "") for material in targets]
        raise ValueError(f"Expected one Palladium full-card material, found {len(found)}: {found}")

    target = targets[0]
    texture_index, image_index = material_base_colour_image(target, textures, images)
    if texture_index is None:
        raise ValueError(f"Material {target.get('name', '')!r} has no base-colour texture")

    source_image = images[image_index]
    extras = source_image.get("extras", {})
    existing = extras.get(IMAGE_MARKER)
    if existing == VERSION:
        print("Palladium brushed metal base colour already has the warm silver finish.")
        return
    if existing is not None:
        raise ValueError(f"Unsupported previous Palladium colour adjustment: {existing}")

    view_index = source_image.get("bufferView")
    if view_index is None or not 0 <= view_index < len(document.get("bufferViews", [])):
        raise ValueError("Palladium base-colour image is not embedded in a GLB bufferView")
    view = document["bufferViews"][view_index]
    if view.get("buffer", 0) != 0:
        raise ValueError("Palladium base-colour image is not in the GLB buffer")
    offset = int(view.get("byteOffset", 0))
    length = int(view["byteLength"])
    original_png = bytes(binary[offset:offset + length])
    if len(original_png) != length:
        raise ValueError("Palladium base-colour PNG is truncated")
    updated_png, dimensions = warm_silver_png(original_png)

    # If the baked image is shared by other materials, clone its image and
    # texture so only the Palladium full-card body receives the colour change.
    shared = []
    for material in materials:
        if material is target:
            continue
        other_texture, other_image = material_base_colour_image(material, textures, images)
        if other_image == image_index:
            shared.append(material.get("name", "unnamed material"))

    if shared:
        new_image = dict(source_image)
        new_image["name"] = (source_image.get("name") or "Palladium base colour") + " warm silver"
        new_image["bufferView"] = len(document["bufferViews"])
        new_image["extras"] = dict(new_image.get("extras") or {})
        new_image["extras"][IMAGE_MARKER] = VERSION
        new_image["extras"]["biltPalladiumBaseColorSaturation"] = SATURATION
        new_image["extras"]["biltPalladiumWarmChannelGain"] = list(CHANNEL_GAIN)
        new_view_index = len(document["bufferViews"])
        document["bufferViews"].append({"buffer": 0, "byteLength": len(updated_png), "_appendBytes": True})
        replacements[new_view_index] = updated_png
        document["images"].append(new_image)

        new_texture = dict(textures[texture_index])
        new_texture["source"] = len(document["images"]) - 1
        document["textures"].append(new_texture)
        target["pbrMetallicRoughness"]["baseColorTexture"]["index"] = len(document["textures"]) - 1
    else:
        source_image["extras"] = dict(source_image.get("extras") or {})
        source_image["extras"][IMAGE_MARKER] = VERSION
        source_image["extras"]["biltPalladiumBaseColorSaturation"] = SATURATION
        source_image["extras"]["biltPalladiumWarmChannelGain"] = list(CHANNEL_GAIN)
        source_image["name"] = (source_image.get("name") or "Palladium base colour") + " warm silver"
        replacements[view_index] = updated_png

    # Repacking keeps image bytes and all mesh data valid after PNG compression changes.
    output = encode_glb(document, binary, replacements)
    directory = os.path.dirname(os.path.abspath(path))
    descriptor, temporary = tempfile.mkstemp(prefix=".palladium-warm-silver-", suffix=".glb", dir=directory)
    try:
        with os.fdopen(descriptor, "wb") as destination:
            destination.write(output)
        os.replace(temporary, path)
    except Exception:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise

    route = "isolated to the full-card material" if shared else "applied to the full-card material"
    print(
        f"Added a subtle warm silver tint to the Palladium brushed metal base colour "
        f"({dimensions[0]}x{dimensions[1]}, {SATURATION:.0%} colour saturation adjustment; "
        f"channel gains R {CHANNEL_GAIN[0]:.3f}, G {CHANNEL_GAIN[1]:.3f}, B {CHANNEL_GAIN[2]:.3f}); "
        f"{route}. Roughness, metallic and normal textures are unchanged."
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: warm_palladium_basecolor.py palladium-2k.glb")
    tint_palladium(sys.argv[1])
