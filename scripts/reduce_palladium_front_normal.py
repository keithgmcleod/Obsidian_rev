import io
import json
import math
import os
import struct
import sys
import tempfile

from PIL import Image


STRENGTH = 0.10
FRONT_U_SPLIT = 0.5
MARKER = "biltFrontNormalReliefStrength"


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


def attenuate_front_normals(png_bytes):
    with Image.open(io.BytesIO(png_bytes)) as source:
        source.load()
        if source.mode not in ("RGB", "RGBA"):
            raise ValueError(f"Expected RGB normal PNG, got {source.mode}")
        image = source.copy()

    width, height = image.size
    if width < 2 or height < 1:
        raise ValueError("Normal texture dimensions are too small")
    split_x = int(width * FRONT_U_SPLIT)
    pixels = image.load()
    neutral_x = (128.0 / 255.0) * 2.0 - 1.0
    neutral_y = neutral_x

    for y in range(height):
        for x in range(split_x):
            pixel = pixels[x, y]
            nx = (pixel[0] / 255.0 * 2.0 - 1.0) * STRENGTH + neutral_x * (1.0 - STRENGTH)
            ny = (pixel[1] / 255.0 * 2.0 - 1.0) * STRENGTH + neutral_y * (1.0 - STRENGTH)
            nz = (pixel[2] / 255.0 * 2.0 - 1.0) * STRENGTH + (1.0 - STRENGTH)
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
    output = (
        struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(json_bytes) + 8 + len(bin_bytes))
        + struct.pack("<I4s", len(json_bytes), b"JSON")
        + json_bytes
        + struct.pack("<I4s", len(bin_bytes), b"BIN\x00")
        + bin_bytes
    )
    return output


def reduce_front_relief(path):
    document, binary = read_glb(path)
    material = document["materials"][0]
    texture_index = material["normalTexture"]["index"]
    image_index = document["textures"][texture_index]["source"]
    image = document["images"][image_index]
    extras = image.setdefault("extras", {})
    if abs(float(extras.get(MARKER, 1.0)) - STRENGTH) < 1e-9:
        print("Palladium front normal relief is already at 10 percent.")
        return

    view_index = image["bufferView"]
    view = document["bufferViews"][view_index]
    offset = view.get("byteOffset", 0)
    length = view["byteLength"]
    original_png = bytes(binary[offset:offset + length])
    updated_png, width, height, split_x = attenuate_front_normals(original_png)

    extras[MARKER] = STRENGTH
    extras["biltFrontUvRange"] = [0.0, FRONT_U_SPLIT]
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
        f"Reduced Palladium front normal relief to {STRENGTH:.0%} "
        f"on x=0..{split_x-1} of {width} pixels ({height} px high); "
        "back and other card textures are unchanged."
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: reduce_palladium_front_normal.py palladium-2k.glb")
    reduce_front_relief(sys.argv[1])
