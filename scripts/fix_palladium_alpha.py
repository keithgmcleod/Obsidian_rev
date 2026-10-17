import json
import os
import struct
import sys
import tempfile


def patch_glb(path):
    with open(path, "rb") as source:
        data = source.read()

    if len(data) < 20 or data[:4] != b"glTF":
        raise ValueError(f"{path} is not a GLB file")

    version, declared_length = struct.unpack_from("<II", data, 4)
    if version != 2 or declared_length != len(data):
        raise ValueError(f"{path} has an invalid GLB header")

    json_length = struct.unpack_from("<I", data, 12)[0]
    if data[16:20] != b"JSON":
        raise ValueError(f"{path} does not start with a JSON chunk")

    document = json.loads(data[20:20 + json_length])
    changed = []
    for material in document.get("materials", []):
        name = material.get("name", "")
        if name.startswith("Palladium ") and "flattened PBR" in name:
            material["alphaMode"] = "OPAQUE"
            material.pop("alphaCutoff", None)
            changed.append(name)

    if not changed:
        raise ValueError("No flattened Palladium materials found to patch")

    json_bytes = json.dumps(document, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    tail = data[20 + json_length:]
    output = (
        struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(json_bytes) + len(tail))
        + struct.pack("<I4s", len(json_bytes), b"JSON")
        + json_bytes
        + tail
    )

    directory = os.path.dirname(os.path.abspath(path))
    fd, temporary = tempfile.mkstemp(prefix=".palladium-", suffix=".glb", dir=directory)
    try:
        with os.fdopen(fd, "wb") as destination:
            destination.write(output)
        os.replace(temporary, path)
    except Exception:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise

    print(f"Set {len(changed)} baked Palladium materials to OPAQUE:")
    for name in changed:
        print(f"  {name}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: fix_palladium_alpha.py palladium-2k.glb")
    patch_glb(sys.argv[1])
