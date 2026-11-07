"""Fetch the pinned upstream PP-OCRv6 tiny ONNX files needed for offline OCR."""

import argparse
import hashlib
from pathlib import Path
import tarfile
from urllib.request import urlopen


BASE_URL = "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0"
MODEL_HASHES = {
    "det": "ff6ab415b0a6e0c488550f2fb5d5046f1719848df220b2dc21b56402a65bc05d",
    "rec": "1e13b22717b1edd89d4cde4fda272b6c17d5b505c97c2baea99da1a3a2d54b29",
}


def prepare(cache: Path, assets: Path) -> None:
    cache.mkdir(parents=True, exist_ok=True)
    for part, expected_hash in MODEL_HASHES.items():
        model = f"PP-OCRv6_tiny_{part}_onnx_infer"
        archive = cache / f"{model}.tar"
        if not archive.is_file():
            with urlopen(f"{BASE_URL}/{model}.tar", timeout=90) as response:
                data = response.read(10_000_001)
            if hashlib.sha256(data).hexdigest() != expected_hash:
                raise ValueError(f"Downloaded model checksum mismatch: {model}")
            archive.write_bytes(data)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected_hash:
            raise ValueError(f"Cached model checksum mismatch: {archive}")
        destination = assets / part
        destination.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive, "r:") as package:
            files = ("inference.onnx", "inference.yml") if part == "rec" else ("inference.onnx",)
            for filename in files:
                member = package.getmember(f"{model}/{filename}")
                if not member.isfile():
                    raise ValueError(f"Unexpected model archive entry: {member.name}")
                with package.extractfile(member) as source:
                    (destination / filename).write_bytes(source.read())
        print(f"Prepared {model}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=Path.home() / ".cache/paperdock-models")
    options = parser.parse_args()
    root = Path(__file__).resolve().parent
    prepare(options.cache, root / "vendor/ppocr-sdk/src/main/assets/models")
