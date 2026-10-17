import io
import json
import math
import os
import struct
import sys
import tempfile

from PIL import Image


STRENGTH = 0.10
EDGE_FADE_PIXELS = 24
FRONT_UV_BOUNDS = (
    0.021611575037240982,
    0.49026018381118774,
    0.07058554887771606,
    0.9430138468742371,
)
STRENGTH_MARKER = "biltFrontNormalReliefStrength"
EDGE_MARKER = "biltFrontNormalEdgeFadePixels"


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


def local_edge_strength(u, v, width, height):
    min_u, max_u, min_v, max_v = FRONT_UV_BOUNDS
    signed_distance = min(
        (u - min_u) * width,
        (max_u - u) * width,
        (v - min_v) * height,
        (max_v - v) * height,
    )
    if signed_distance <= 0:
        return 0.0
    if signed_distance >= EDGE_FADE_PIXELS:
        return 1.0
    t = signed_distance / EDGE_FADE_PIXELS
    return t * t * (3.0 - 2.0 * t)


def attenuate_front_normals(png_bytes, already_at_target_strength):
    with Image.open(io.BytesIO(png_bytes)) as source:
        source.load()
        if source.mode not in ("RGB", "RGBA"):
            raise ValueError(f"Expected RGB normal PNG, got {source.mode}")
        image = source.copy()

    width, height = image.size
    if width < 2 or height < 1:
        raise ValueError("Normal texture dimensions are too small")
    split_x = width // 2
    pixels = image.load()
    neutral = (128.0 / 255.0 * 2.0 - 1.0, 128.0 / 255.0 * 2.0 - 1.0, 1.0)

    for y in range(height):
        v = 1.0 - ((y + 0.5) / height)
        for x in range(split_x):
            u = (x + 0.5) / width
            edge_strength = local_edge_strength(u, v, width, height)
            if already_at_target_strength and edge_strength >= 1.0:
                continue
            strength = edge_strength if already_at_target_strength else STRENGTH * edge_strength
            pixel = pixels[x, y]
            nx = (pixel[0] / 255.0 * 2.0 - 1.0) * strength + neutral[0] * (1.0 - strength)
            ny = (pixel[1] / 255.0 * 2.0 - 1.0) * strength + neutral[1] * (1.0 - strength)
            nz = (pixel[2] / 255.0 * 2.0 - 1.0) * strength + neutral[2] * (1.0 - strength)
            length = math.sqrt(nx * nx + ny * ny + nz * nz)
            if length:
                nx /= length
                ny /= length
                nz /= length
            rgb = (
                max(0, min(255, int(round((nx * 0.5 + 0.5) * 255.0)))),
                max(0, min(255, int(round((ny * 0.5 + 0.5) * 255.0)))),
                max(0, min(255, int(round((nz * 0.5 + 0.5) * 255.0)))),
            )
            pixels[x, y] = rgb if len(pixel) == 3 else rgb + (pixel[3],)

    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    return output.getvalue(), width, height, split_x


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


def reduce_front_relief(path):
    document, binary = read_glb(path)
    material = document["materials"][0]
    texture_index = material["normalTexture"]["index"]
    image_index = document["textures"][texture_index]["source"]
    image = document["images"][image_index]
    extras = image.setdefault("extras", {})
    already_at_target_strength = (
        abs(float(extras.get(STRENGTH_MARKER, 1.0)) - STRENGTH) < 1e-9
    )
    if (
        already_at_target_strength
        and int(extras.get(EDGE_MARKER, -1)) == EDGE_FADE_PIXELS
    ):
        print("Palladium front relief already has the 10 percent strength and smooth edge fade.")
        return

    view_index = image["bufferView"]
    view = document["bufferViews"][view_index]
    offset = view.get("byteOffset", 0)
    length = view["byteLength"]
    original_png = bytes(binary[offset:offset + length])
    updated_png, width, height, split_x = attenuate_front_normals(
        original_png, already_at_target_strength
    )

    extras[STRENGTH_MARKER] = STRENGTH
    extras[EDGE_MARKER] = EDGE_FADE_PIXELS
    extras["biltFrontUvBounds"] = list(FRONT_UV_BOUNDS)
    image["name"] = "Palladium 2K tangent normal; front relief 10 percent with smooth edge fade"
    view["_replacementBytes"] = updated_png
    output = make_glb(document, binary)

    directory = os.path.dirname(os.path.abspath(path))
    fd, temporary = tempfile.mkstemp(prefix=".palladium-front-normal-", suffix=".glb", dir=directory)
    try:
        with os.fdopen(fd, "wb") as destination:
            destination.write(output)
        os.replace(temporary, path)
    except Exception:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise

    print(
        f"Set Palladium front normal relief to {STRENGTH:.0%}, with a smooth "
        f"{EDGE_FADE_PIXELS}-pixel fade at the Blender UV perimeter "
        f"(u={FRONT_UV_BOUNDS[0]:.4f}..{FRONT_UV_BOUNDS[1]:.4f}, "
        f"v={FRONT_UV_BOUNDS[2]:.4f}..{FRONT_UV_BOUNDS[3]:.4f}); "
        "back and other card textures are unchanged."
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: reduce_palladium_front_normal.py palladium-2k.glb")
    reduce_front_relief(sys.argv[1])
