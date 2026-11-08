"""PaperDock Windows desktop launcher and PyInstaller entry point."""
from __future__ import annotations

import os
import base64
import json
import threading
import uuid
import tempfile
import shutil
import subprocess
import sys
import time
import urllib.request
import logging
from logging.handlers import RotatingFileHandler
from contextlib import contextmanager
from pathlib import Path


def resource_root() -> Path:
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


APP_ROOT = resource_root()


def writable_data_root() -> Path:
    preferred = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "PaperDock"
    try:
        preferred.mkdir(parents=True, exist_ok=True)
        probe = preferred / ".write-test"
        probe.write_bytes(b"")
        probe.unlink()
        return preferred
    except OSError:
        # Some controlled-folder setups deny AppData. A portable installation
        # beside the executable remains fully offline and avoids that failure.
        fallback_base = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else APP_ROOT
        fallback = fallback_base / "PaperDockData"
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


DATA_ROOT = writable_data_root()
LOG = logging.getLogger('paperdock.desktop')


def configure_logging() -> None:
    role = 'backend' if '--backend' in sys.argv else 'desktop'
    handler = RotatingFileHandler(DATA_ROOT / f'{role}.log', maxBytes=2_000_000, backupCount=3, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s pid=%(process)d %(message)s'))
    logging.getLogger().addHandler(handler)
    logging.getLogger().setLevel(logging.INFO)
    def thread_error(args):
        LOG.error('Unhandled thread exception', exc_info=(args.exc_type, args.exc_value, args.exc_traceback))
    threading.excepthook = thread_error


@contextmanager
def single_instance():
    # Windows releases the byte-range lock even after a crash. Never delete the
    # lock file: deleting it could let two processes lock different files.
    import msvcrt
    with (DATA_ROOT / 'desktop.lock').open('a+b') as lock:
        if lock.tell() == 0:
            lock.write(b'0')
            lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise RuntimeError('PaperDock 已经运行，请切回已有窗口，不要重复启动。') from error
        try:
            yield
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


class DesktopApi:
    def __init__(self):
        self._lock = threading.RLock()
        self._history = DATA_ROOT / 'downloads.json'

    def list_downloads(self):
        with self._lock:
            try:
                records = json.loads(self._history.read_text(encoding='utf-8'))
                return [item for item in records if isinstance(item, dict) and isinstance(item.get('path'), str) and isinstance(item.get('name'), str) and isinstance(item.get('id'), str)][:200]
            except (OSError, ValueError, TypeError):
                return []

    def open_download(self, record_id: str, folder: bool = False):
        record = next((item for item in self.list_downloads() if item['id'] == record_id), None)
        if not record:
            return {'error': '找不到这条保存记录。'}
        path = Path(record['path'])
        try:
            if folder:
                if not path.parent.is_dir():
                    return {'error': '保存文件夹已移动或删除。'}
                os.startfile(str(path.parent))
            else:
                if not path.is_file():
                    return {'error': '文件已移动或删除，请检查保存位置。'}
                if path.suffix.lower() not in {'.pdf', '.txt', '.docx', '.xlsx', '.zip', '.json', '.png', '.jpg', '.jpeg'}:
                    return {'error': '此文件类型请从所在文件夹手动打开。'}
                os.startfile(str(path))
            LOG.info('Opened download target folder=%s', folder)
            return {'ok': True}
        except OSError as error:
            return {'error': str(error)}

    def save_file(self, name: str, encoded: str):
        """Only write to the destination explicitly chosen in the native dialog."""
        import webview
        selected = webview.windows[0].create_file_dialog(
            webview.SAVE_DIALOG, save_filename=Path(name).name
        )
        if not selected:
            return {"cancelled": True}
        destination = Path(selected if isinstance(selected, str) else selected[0])
        temporary = None
        try:
            data = base64.b64decode(encoded, validate=True)
            with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as output:
                temporary = output.name
                output.write(data)
            os.replace(temporary, destination)
            record = {'id': uuid.uuid4().hex, 'name': destination.name, 'path': str(destination), 'status': '已保存'}
            try:
                with self._lock:
                    records = [record, *self.list_downloads()][:200]
                    with tempfile.NamedTemporaryFile(dir=DATA_ROOT, mode='w', encoding='utf-8', delete=False) as history:
                        json.dump(records, history, ensure_ascii=False)
                    os.replace(history.name, self._history)
            except OSError:
                return {"path": str(destination), "size": len(data), "warning": "文件已保存，但下载记录写入失败。"}
            return {"path": str(destination), "size": len(data), "record_id": record['id']}
        except Exception as error:
            if temporary and Path(temporary).exists():
                Path(temporary).unlink()
            return {"error": str(error)}


def configure_environment() -> None:
    os.environ["PAPERDOCK_DATA_DIR"] = str(DATA_ROOT)
    os.environ["PAPERDOCK_STATIC_DIR"] = str(APP_ROOT / "desktop-dist")
    bundled_models = APP_ROOT / "runtime-cache" / "paddlex"
    local_models = DATA_ROOT / "runtime-cache" / "paddlex"
    if bundled_models.is_dir() and not local_models.exists():
        shutil.copytree(bundled_models, local_models)


def run_backend() -> None:
    # PaddleX writes model download progress even in the windowed executable.
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")
    configure_environment()
    if os.name == "nt" and not str(DATA_ROOT.resolve()).isascii():
        # Paddle's Windows runtime can open relative model paths in this directory.
        os.chdir(DATA_ROOT)
    import uvicorn

    # In a PyInstaller --windowed build, sys.stderr can be None. Uvicorn's
    # default logging formatter calls ``isatty`` on that stream and aborts
    # startup, so keep the local backend quiet instead of configuring it.
    uvicorn.run(
        "backend.app:app",
        host="127.0.0.1",
        port=8001,
        log_level="warning",
        log_config=None,
    )


def wait_for_service(backend, instance_id: str, timeout_seconds: int = 25) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if backend.poll() is not None:
            raise RuntimeError('本地后台提前退出，可能已有旧版程序占用端口。请关闭旧版或重启电脑后再试。')
        try:
            with urllib.request.urlopen("http://127.0.0.1:8001/health", timeout=1) as response:
                data = json.load(response)
        except Exception:
            time.sleep(0.25)
            continue
        if data.get('desktop_instance') != instance_id or data.get('pid') != backend.pid:
            raise RuntimeError('本地端口被旧版 PaperDock 或其他服务占用。为避免误连，已停止启动；请关闭旧版或重启电脑后再试。')
        return backend.poll() is None
    return False


def stop_backend(backend):
    if backend.poll() is None:
        LOG.info('Stopping owned backend pid=%s', backend.pid)
        backend.terminate()
        try:
            backend.wait(timeout=5)
        except subprocess.TimeoutExpired:
            backend.kill()
            backend.wait(timeout=5)
    LOG.info('Backend exit code=%s', backend.returncode)


def launch_desktop() -> None:
    configure_environment()
    command = [sys.executable, "--backend"] if getattr(sys, "frozen", False) else [sys.executable, str(Path(__file__).resolve()), "--backend"]
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    instance_id = uuid.uuid4().hex
    environment = dict(os.environ, PAPERDOCK_INSTANCE_ID=instance_id)
    backend = subprocess.Popen(command, cwd=str(APP_ROOT), creationflags=creation_flags, env=environment)
    LOG.info('Started owned backend pid=%s', backend.pid)
    try:
        if not wait_for_service(backend, instance_id):
            raise RuntimeError('PaperDock 本地服务启动超时，请查看 backend.log。')
        import webview

        # The WebView keeps a persistent HTTP cache. A build stamp in the URL makes
        # an upgraded installation load its new UI instead of a cached old page.
        index = APP_ROOT / "desktop-dist" / "index.html"
        build = int(index.stat().st_mtime) if index.exists() else 0
        window = webview.create_window("PaperDock", f"http://127.0.0.1:8001/desktop/?build={build}", js_api=DesktopApi(), width=1440, height=960, min_size=(1000, 700))
        window.events.closing += lambda: LOG.info('Window closing requested')
        window.events.closed += lambda: LOG.info('Window closed')
        LOG.info('Starting desktop event loop')
        webview.start(private_mode=False, storage_path=str(DATA_ROOT / 'webview'))
        LOG.info('Desktop event loop returned')
    finally:
        stop_backend(backend)


if __name__ == "__main__":
    configure_logging()
    LOG.info('Process starting')
    try:
        if "--backend" in sys.argv:
            run_backend()
        else:
            with single_instance():
                launch_desktop()
    except Exception as error:
        LOG.exception('Process failed')
        if '--backend' not in sys.argv and os.name == 'nt':
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, f'{error}\n\n日志目录：{DATA_ROOT}', 'PaperDock 启动失败', 0x10)
        sys.exit(1)
    finally:
        LOG.info('Process exiting')
