"""Bounded, offline wallpaper transcoding. Original files are never modified."""
import asyncio
import os
import re
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import imageio_ffmpeg
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

MAX_BYTES = 1024 ** 3
MAX_SECONDS = 300
router = APIRouter(prefix='/wallpaper')
gate = asyncio.Lock()
active_process = None
jobs: dict[str, dict] = {}

def cancel_for_document():
    """Stop conversion before a CPU-heavy synchronous document handler starts."""
    if active_process is not None and active_process.returncode is None:
        try:
            active_process.kill()
        except ProcessLookupError:
            pass

def directory():
    root = Path(os.environ.get('PAPERDOCK_DATA_DIR', Path(__file__).resolve().parents[1])) / 'wallpapers'
    root.mkdir(parents=True, exist_ok=True)
    return root

def job_file(token: str):
    return directory() / (token + '.json')

def read_metadata(token: str):
    try:
        import json
        return json.loads(job_file(token).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None

def write_metadata(token: str, value: dict):
    import json
    job_file(token).write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')

def dimensions(width, height, low):
    # No upscaling. Portrait videos receive the same pixel budget as landscape.
    long, short = (1280, 720) if low else (1920, 1080)
    ratio = min(1, long / max(width, height), short / min(width, height))
    return max(2, int(width * ratio) // 2 * 2), max(2, int(height * ratio) // 2 * 2)

async def execute(args, request, timeout=900):
    global active_process
    flags = (subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS) if os.name == 'nt' else 0
    process = await asyncio.create_subprocess_exec(imageio_ffmpeg.get_ffmpeg_exe(), *args,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE, creationflags=flags)
    active_process = process
    task = asyncio.create_task(process.communicate())
    started = time.monotonic()
    try:
        while not task.done():
            if await request.is_disconnected():
                raise HTTPException(499, '已取消视频优化。')
            if time.monotonic() - started > timeout:
                raise HTTPException(408, '优化超时，请使用较短的视频。')
            await asyncio.wait({task}, timeout=.25)
        _, error = await task
        return process.returncode, error.decode('utf-8', errors='replace')
    finally:
        if process.returncode is None:
            process.kill()
        await process.wait()
        await task
        if active_process is process:
            active_process = None

async def transcode(args, request, token: str, duration: float, timeout=900):
    """Run FFmpeg while publishing bounded local progress for the desktop UI."""
    global active_process
    flags = (subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS) if os.name == 'nt' else 0
    process = await asyncio.create_subprocess_exec(imageio_ffmpeg.get_ffmpeg_exe(), *args,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE, creationflags=flags)
    active_process = process
    started = time.monotonic()
    error: list[str] = []
    try:
        while process.returncode is None:
            if await request.is_disconnected(): raise HTTPException(499, '已取消视频优化。')
            if time.monotonic() - started > timeout: raise HTTPException(408, '优化超时，请使用较短的视频。')
            try: line = await asyncio.wait_for(process.stderr.readline(), .25)
            except asyncio.TimeoutError: continue
            if not line: continue
            text = line.decode('utf-8', errors='replace').strip()
            error.append(text)
            if text.startswith('out_time_ms='):
                try: jobs[token]['progress'] = min(99, max(1, int(int(text[12:]) / 1_000_000 / duration * 100)))
                except (ValueError, KeyError): pass
        return await process.wait(), '\n'.join(error)
    finally:
        if process.returncode is None: process.kill()
        await process.wait()
        if active_process is process: active_process = None

@router.post('/video')
async def import_video(request: Request, low: bool = False, token: str | None = None):
    # Only one video conversion at a time; never queue several GB in RAM.
    if gate.locked():
        raise HTTPException(409, '另一个视频正在优化，请稍后再试。')
    async with gate:
        root = directory()
        token = token if token and re.fullmatch(r'[a-f0-9]{32}', token) else uuid.uuid4().hex
        jobs[token] = {'state': 'uploading', 'progress': 0, 'updated': time.time()}
        source, output = root / (token + '.upload'), root / (token + '.mp4')
        success = False
        try:
            total = 0
            with source.open('wb') as stream:
                async for chunk in request.stream():
                    total += len(chunk)
                    if total > MAX_BYTES:
                        raise HTTPException(413, '视频不能超过 1 GB（1024 MB）。')
                    stream.write(chunk)
            jobs[token].update(state='analyzing', progress=0)
            with source.open('rb') as stream:
                header = stream.read(16)
            fmt = 'mov' if header[4:8] == b'ftyp' else 'matroska' if header[:4] == b'\x1aE\xdf\xa3' else None
            if not fmt:
                raise HTTPException(400, '请选择有效的 MP4 或 WebM 视频。')
            base = ['-hide_banner', '-nostdin', '-threads', '2', '-protocol_whitelist', 'file,pipe', '-f', fmt, '-i', str(source)]
            _, info = await execute(base, request, 30)
            duration = re.search(r'Duration: (\d+):(\d+):(\d+(?:\.\d+)?)', info)
            size = re.search(r'Video:.*?\b(\d{2,5})x(\d{2,5})\b', info)
            if not duration or not size:
                raise HTTPException(400, '无法确认视频时长或尺寸，请换一个文件。')
            seconds = float(duration[1]) * 3600 + float(duration[2]) * 60 + float(duration[3])
            if not 0 < seconds <= MAX_SECONDS:
                raise HTTPException(400, '视频时长必须在 5 分钟以内。')
            width, height = map(int, size.groups())
            if width * height > 7680 * 4320:
                raise HTTPException(400, '视频尺寸过大，最高支持 8K 像素量。')
            low = low or (os.cpu_count() or 2) <= 4
            w, h = dimensions(width, height, low)
            # Preserve slower frame rates; cap high rates, never synthesize frames.
            match = re.search(r'([\d.]+) fps', info)
            fps = min(float(match[1]), 24 if low else 30) if match else (24 if low else 30)
            # maxrate bounds the estimate; actual H.264 output is normally smaller.
            estimated_bytes = int(seconds * (4_000_000 if low else 6_000_000) / 8)
            jobs[token].update(state='optimizing', progress=0, original={'width': width, 'height': height, 'seconds': round(seconds, 1), 'bytes': total}, output={'width': w, 'height': h, 'fps': fps, 'estimated_bytes': estimated_bytes})
            code, _ = await transcode(base + ['-progress', 'pipe:2', '-nostats', '-map', '0:v:0', '-an', '-sn', '-dn', '-t', '300',
                '-vf', f'scale={w}:{h}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps={fps}',
                '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '23',
                '-maxrate', '4M' if low else '6M', '-bufsize', '8M' if low else '12M',
                '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-map_metadata', '-1', '-y', str(output)], request, token, seconds)
            if code or not output.exists() or output.stat().st_size == 0:
                raise HTTPException(400, '视频优化失败，原壁纸保持不变。')
            success = True
            metadata = {'id': token, 'created': datetime.now(timezone.utc).isoformat(), 'original': jobs[token]['original'], 'output': {**jobs[token]['output'], 'bytes': output.stat().st_size}}
            write_metadata(token, metadata)
            jobs[token].update(state='done', progress=100, metadata=metadata)
            return {'id': token, 'message': f'已生成流畅优先副本（{w}×{h}、{fps:g} fps，无音轨）。原视频未修改。', 'metadata': metadata}
        finally:
            source.unlink(missing_ok=True)
            if not success:
                output.unlink(missing_ok=True)
                jobs[token] = {'state': 'failed', 'progress': 0, 'updated': time.time()}

@router.get('/status/{token}')
def video_status(token: str):
    if not re.fullmatch(r'[a-f0-9]{32}', token): raise HTTPException(404)
    value = jobs.get(token)
    if value: return value
    metadata = read_metadata(token)
    if metadata: return {'state': 'done', 'progress': 100, 'metadata': metadata}
    raise HTTPException(404, '任务不存在或已结束。')

@router.get('/videos')
def video_list():
    values = [read_metadata(path.stem) for path in directory().glob('*.json')]
    return {'videos': sorted([item for item in values if item], key=lambda item: item.get('created', ''), reverse=True)}

@router.delete('/video/{token}')
def delete_video(token: str):
    if not re.fullmatch(r'[a-f0-9]{32}', token): raise HTTPException(404)
    output, metadata = directory() / (token + '.mp4'), job_file(token)
    if not output.exists() and not metadata.exists(): raise HTTPException(404, '本地视频不存在。')
    output.unlink(missing_ok=True); metadata.unlink(missing_ok=True); jobs.pop(token, None)
    return {'ok': True}

@router.get('/video/{token}')
def video_file(token: str):
    if not re.fullmatch(r'[a-f0-9]{32}', token):
        raise HTTPException(404)
    path = directory() / (token + '.mp4')
    if not path.is_file():
        raise HTTPException(404, '本地视频不存在，请重新导入。')
    return FileResponse(path, media_type='video/mp4')
