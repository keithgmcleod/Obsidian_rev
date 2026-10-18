import json
import os
import struct
import sys
import tempfile


def remove_edge_bump(path):
    with open(path, "rb") as source:
        data = source.read()

    if len(data) < 20 or data[:4] != b"glTF":
        raise ValueError(f"{path} is not a GLB file")

    version, declared_length = struct.unpack_from("<II", data, 4)
    if version != 2 or declared_length != len(data):
        raise ValueError(f"{path} has an invalid GLB header")

    json_length = struct.unpack_from("<I", data, 12)[0]
    if data[16:20] != b"JSON":
        raise ValueError(f"{path} does not start with a GLB JSON chunk")

    document = json.loads(data[20:20 + json_length])
    edge_materials = [
        material for material in document.get("materials", [])
        if "edge" in material.get("name", "").casefold()
    ]
    if not edge_materials:
        material_names = [material.get("name", "") for material in document.get("materials", [])]
        raise ValueError(f"No edge material found in Palladium GLB; materials: {material_names}")

    removed = []
    for material in edge_materials:
        material_name = material.get("name", "<unnamed edge material>")
        normal_texture = material.pop("normalTexture", None)
        if normal_texture is not None:
            removed.append(f"{material_name}: normalTexture")

        extensions = material.get("extensions", {})
        clearcoat = extensions.get("KHR_materials_clearcoat", {})
        if clearcoat.pop("clearcoatNormalTexture", None) is not None:
            removed.append(f"{material_name}: clearcoatNormalTexture")
        if not clearcoat:
            extensions.pop("KHR_materials_clearcoat", None)
        if not extensions:
            material.pop("extensions", None)

    if not removed:
        names = [material.get("name", "<unnamed>") for material in edge_materials]
        print(f"Found Palladium edge material(s) {names}; no normal or clearcoat normal maps were present.")
        return

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
    fd, temporary = tempfile.mkstemp(prefix=".palladium-edge-bump-", suffix=".glb", dir=directory)
    try:
        with os.fdopen(fd, "wb") as destination:
            destination.write(output)
        os.replace(temporary, path)
    except Exception:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise

    print("Removed Palladium edge normal map(s):")
    for item in removed:
        print(f"  {item}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: remove_palladium_edge_bump.py palladium-2k.glb")
    remove_edge_bump(sys.argv[1])
