import io
import json
import math
import os
import struct
import sys
import tempfile

from PIL import Image


SIDE_UV_BOUNDS = (
    -0.014158319681882858,
    0.02377706952393055,
    -0.029093924909830093,
    1.0290940999984741,
)
SIDE_BUMP_MARKER = "biltPalladiumSideBumpRemoved"


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
        raise ValueError(f"{path} does not start with a GLB JSON chunk")
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


def make_glb(document, binary):
    view_records = []
    for index, view in enumerate(document.get("bufferViews", [])):
        if view.get("buffer", 0) != 0:
            raise ValueError("Only the single GLB buffer is supported")
        offset = view.get("byteOffset", 0)
        length = view["byteLength"]
        if offset < 0 or length < 0 or offset + length > len(binary):
            raise ValueError(f"Invalid bufferView {index}")
        view_records.append((offset, index, length))

    view_records.sort()
    previous_end = 0
    result_bin = bytearray()
    for old_offset, index, length in view_records:
        if old_offset < previous_end:
            raise ValueError(f"Overlapping bufferView at index {index}")
        view = document["bufferViews"][index]
        payload = view.pop("_replacementBytes", None)
        if payload is None:
            payload = binary[old_offset:old_offset + length]
        while len(result_bin) % 4:
            result_bin.append(0)
        view["byteOffset"] = len(result_bin)
        view["byteLength"] = len(payload)
        result_bin.extend(payload)
        previous_end = old_offset + length

    if previous_end < len(binary):
        while len(result_bin) % 4:
            result_bin.append(0)
        result_bin.extend(binary[previous_end:])
    while len(result_bin) % 4:
        result_bin.append(0)

    document["buffers"][0]["byteLength"] = len(result_bin)
    json_bytes = json.dumps(document, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    bin_bytes = bytes(result_bin)
    return (
        struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(json_bytes) + 8 + len(bin_bytes))
        + struct.pack("<I4s", len(json_bytes), b"JSON")
        + json_bytes
        + struct.pack("<I4s", len(bin_bytes), b"BIN\x00")
        + bin_bytes
    )


def flatten_edge_normal(image):
    width, height = image.size
    if width < 2 or height < 1:
        raise ValueError("Normal texture dimensions are too small")
    if image.mode not in ("RGB", "RGBA"):
        raise ValueError(f"Expected RGB/RGBA normal PNG, got {image.mode}")

    min_u, max_u, _, _ = SIDE_UV_BOUNDS
    # The Blender edge UV strip crosses the repeating U seam. Flatten both
    # sides of that seam and include a two-pixel gutter for bilinear sampling.
    left_end = min(width, max(0, math.ceil(max_u * width) + 2))
    right_start = max(0, min(width, math.floor((1.0 + min_u) * width) - 2))
    pixels = image.load()
    neutral = (128, 128, 255)
    for y in range(height):
        for x in range(left_end):
            pixel = pixels[x, y]
            pixels[x, y] = neutral if len(pixel) == 3 else neutral + (pixel[3],)
        for x in range(right_start, width):
            pixel = pixels[x, y]
            pixels[x, y] = neutral if len(pixel) == 3 else neutral + (pixel[3],)
    return width, height, left_end, right_start


def remove_edge_bump(path):
    document, binary = read_glb(path)
    candidates = [
        material for material in document.get("materials", [])
        if "palladium" in material.get("name", "").casefold()
        and "full-card" in material.get("name", "").casefold()
    ]
    if len(candidates) != 1:
        names = [material.get("name", "") for material in document.get("materials", [])]
        raise ValueError(f"Expected one Palladium full-card material; found {len(candidates)}. Materials: {names}")

    material = candidates[0]
    texture_info = material.get("normalTexture")
    if texture_info is None:
        raise ValueError(f"{material.get('name')} has no normalTexture to smooth")
    texture = document["textures"][texture_info["index"]]
    image = document["images"][texture["source"]]
    extras = image.setdefault("extras", {})
    view_index = image.get("bufferView")
    if view_index is None:
        raise ValueError("The Palladium full-card normal image is not embedded in the GLB buffer")
    view = document["bufferViews"][view_index]
    offset = view.get("byteOffset", 0)
    length = view["byteLength"]
    source_png = bytes(binary[offset:offset + length])

    with Image.open(io.BytesIO(source_png)) as source:
        source.load()
        normal = source.copy()
    width, height, left_end, right_start = flatten_edge_normal(normal)

    output = io.BytesIO()
    normal.save(output, format="PNG", optimize=True)
    extras[SIDE_BUMP_MARKER] = True
    extras["biltPalladiumSideUvBounds"] = list(SIDE_UV_BOUNDS)
    extras["biltPalladiumNeutralizedNormalColumns"] = [left_end, right_start, width]
    image["name"] = "Palladium normal map; front relief reduced and card edge bump removed"
    view["_replacementBytes"] = output.getvalue()

    rebuilt = make_glb(document, binary)
    directory = os.path.dirname(os.path.abspath(path))
    fd, temporary = tempfile.mkstemp(prefix=".palladium-edge-normal-", suffix=".glb", dir=directory)
    try:
        with os.fdopen(fd, "wb") as destination:
            destination.write(rebuilt)
        os.replace(temporary, path)
    except Exception:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise

    print(
        f"Removed normal-map bump from the Palladium card edge UV strip "
        f"(U={SIDE_UV_BOUNDS[0]:.5f}..{SIDE_UV_BOUNDS[1]:.5f}); "
        f"neutralized texture columns 0..{left_end - 1} and {right_start}..{width - 1} "
        f"on the {width}x{height} full-card normal map. "
        "The face material and base-colour/roughness maps are unchanged."
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: remove_palladium_edge_bump.py palladium-2k.glb")
    remove_edge_bump(sys.argv[1])
