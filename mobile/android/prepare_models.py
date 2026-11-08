"""Fetch the pinned PP-OCRv6 Small weights for offline Android and iOS OCR."""

import argparse
import hashlib
from pathlib import Path
import tarfile
from urllib.error import URLError
from urllib.request import Request, urlopen


BASE_URL = "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0"
MODEL_HASHES = {
    "det": "d218f6fbf0f1c23d2161bd6ac7f5eaa6104fa89955c09290497e31008e2618e4",
    "rec": "d267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1",
}
MIRROR = {
    "det": ("28fe5895c24fd108c19eb3e8479f4ab385fbfc62", {
        "inference.onnx": "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e",
        "inference.yml": "193f435274bf9f0b5f71a929bbfbcf148282df7e633b34e7c373e8f44741b516",
    }),
    "rec": ("b8f84f0b80c529de40b4fbb3544b84fa7233a513", {
        "inference.onnx": "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634",
        "inference.yml": "ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1",
    }),
}


def download(url: str) -> bytes:
    request = Request(url, headers={"User-Agent": "PaperDock-model-setup/1.0"})
    with urlopen(request, timeout=45) as response:
        return response.read(25_000_001)


def prepare_mirror(part: str, cache: Path, destination: Path) -> None:
    revision, files = MIRROR[part]
    base_url = f"https://huggingface.co/PaddlePaddle/PP-OCRv6_small_{part}_onnx/resolve/{revision}"
    cache.mkdir(parents=True, exist_ok=True)
    for name, expected_hash in files.items():
        cached = cache / name
        data = cached.read_bytes() if cached.is_file() else download(f"{base_url}/{name}")
        if hashlib.sha256(data).hexdigest() != expected_hash:
            raise ValueError(f"Model mirror checksum mismatch: {part}/{name}")
        if not cached.is_file():
            cached.write_bytes(data)
        (destination / name).write_bytes(data)


def prepare(cache: Path, assets: Path) -> None:
    cache.mkdir(parents=True, exist_ok=True)
    for part, expected_hash in MODEL_HASHES.items():
        model = f"PP-OCRv6_small_{part}_onnx_infer"
        archive = cache / f"{model}.tar"
        destination = assets / part
        destination.mkdir(parents=True, exist_ok=True)
        if not archive.is_file():
            try:
                data = download(f"{BASE_URL}/{model}.tar")
            except (URLError, TimeoutError) as error:
                print(f"Official archive unavailable ({error}); using verified model mirror.", flush=True)
                prepare_mirror(part, cache / model, destination)
                print(f"Prepared {model}", flush=True)
                continue
            if hashlib.sha256(data).hexdigest() != expected_hash:
                raise ValueError(f"Downloaded model checksum mismatch: {model}")
            archive.write_bytes(data)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected_hash:
            raise ValueError(f"Cached model checksum mismatch: {archive}")
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
