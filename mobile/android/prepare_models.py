"""Fetch the pinned PP-OCRv6 Small weights for offline Android and iOS OCR."""

import argparse
import hashlib
from pathlib import Path
import tarfile
from urllib.request import urlopen


BASE_URL = "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0"
MODEL_HASHES = {
    "det": "d218f6fbf0f1c23d2161bd6ac7f5eaa6104fa89955c09290497e31008e2618e4",
    "rec": "d267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1",
}


def prepare(cache: Path, assets: Path) -> None:
    cache.mkdir(parents=True, exist_ok=True)
    for part, expected_hash in MODEL_HASHES.items():
        model = f"PP-OCRv6_small_{part}_onnx_infer"
        archive = cache / f"{model}.tar"
        if not archive.is_file():
            with urlopen(f"{BASE_URL}/{model}.tar", timeout=90) as response:
                data = response.read(25_000_001)
            if hashlib.sha256(data).hexdigest() != expected_hash:
                raise ValueError(f"Downloaded model checksum mismatch: {model}")
            archive.write_bytes(data)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected_hash:
            raise ValueError(f"Cached model checksum mismatch: {archive}")
        destination = assets / part
        destination.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive, "r:") as package:
            for filename in ("inference.onnx", "inference.yml"):
                member = package.getmember(f"{model}/{filename}")
                if not member.isfile():
                    raise ValueError(f"Unexpected model archive entry: {member.name}")
                with package.extractfile(member) as source:
                    (destination / filename).write_bytes(source.read())
        print(f"Prepared {model}", flush=True)


if __name__ == "__main__":
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=Path.home() / ".cache/paperdock-models")
    parser.add_argument("--assets", type=Path, default=root / "vendor/ppocr-sdk/src/main/assets/models")
    options = parser.parse_args()
    prepare(options.cache, options.assets)
