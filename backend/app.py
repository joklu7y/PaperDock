"""PaperDock local OCR service. Run with: .venv\\Scripts\\python -m uvicorn backend.app:app --port 8001"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any

import cv2
import fitz
import numpy as np
from docx import Document
from docx.oxml.ns import qn
from docx.shared import Inches, Pt
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from openpyxl import Workbook

# A packaged desktop app stores writable jobs and cached models in the user's
# local app-data folder, while static UI assets stay beside the executable.
SOURCE_ROOT = Path(__file__).resolve().parents[1]
ROOT = Path(os.environ.get("PAPERDOCK_DATA_DIR", SOURCE_ROOT)).resolve()
DESKTOP_FRONTEND = Path(os.environ.get("PAPERDOCK_STATIC_DIR", SOURCE_ROOT / "desktop-dist")).resolve()
RUNTIME = ROOT / "runtime-cache"
PADDLE_CACHE = RUNTIME / "paddlex"
JOBS = ROOT / "runtime-jobs"
PROJECTS = ROOT / "projects"
WATERMARK_FONTS = [
    Path(r"C:\Windows\Fonts\msyh.ttc"),
    Path(r"C:\Windows\Fonts\segoeui.ttf"),
    Path(r"C:\Windows\Fonts\seguiemj.ttf"),
]
SECURITY_MARKER = "PaperDock Secure PDF AES-256"
RUNTIME.mkdir(exist_ok=True)
PADDLE_CACHE.mkdir(parents=True, exist_ok=True)
JOBS.mkdir(exist_ok=True)
PROJECTS.mkdir(exist_ok=True)
# PaddleX defaults to ~/.paddlex, which can be denied by Windows controlled
# folder access. Keep both model files and temporary download data within the
# PaperDock workspace. BOS is Paddle's own model host and avoids the default
# Hugging Face connectivity probe on otherwise healthy networks.
cache_for_engine = PADDLE_CACHE
if os.name == "nt" and not str(PADDLE_CACHE).isascii() and ROOT == Path.cwd().resolve():
    cache_for_engine = PADDLE_CACHE.relative_to(ROOT)
os.environ["PADDLE_PDX_CACHE_HOME"] = str(cache_for_engine)
os.environ["PADDLE_PDX_MODEL_SOURCE"] = "bos"
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "true"
# oneDNN + the new PIR executor trigger an unsupported CPU attribute on this
# Windows Paddle build. Standard CPU inference is slower but stable.
os.environ["PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT"] = "false"
os.environ["FLAGS_enable_pir_api"] = "0"
os.environ["FLAGS_enable_pir_in_executor"] = "0"

def cleanup_old_jobs(days: int = 7) -> None:
    cutoff = time.time() - days * 86400
    for item in JOBS.iterdir():
        if item.is_dir() and item.stat().st_mtime < cutoff:
            shutil.rmtree(item, ignore_errors=True)

cleanup_old_jobs()

app = FastAPI(title="PaperDock Local OCR")
from backend.wallpaper import router as wallpaper_router, cancel_for_document
app.include_router(wallpaper_router)

@app.middleware('http')
async def prioritize_documents(request, call_next):
    if request.method == 'POST' and not request.url.path.startswith('/wallpaper/'):
        cancel_for_document()
    return await call_next(request)

@app.middleware('http')
async def revalidate_desktop_page(request, call_next):
    # Hashed files under /desktop/assets/ may be cached; the page itself must be
    # revalidated so an upgraded installation never shows the previous UI.
    response = await call_next(request)
    path = request.url.path
    if path.startswith('/desktop') and not path.startswith('/desktop/assets/'):
        response.headers['Cache-Control'] = 'no-cache'
    return response
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"], allow_methods=["*"], allow_headers=["*"], expose_headers=["Content-Disposition", "X-PaperDock-Conversion-Mode", "X-PaperDock-Tables", "X-PaperDock-Added", "X-PaperDock-Filled", "X-PaperDock-Repair"])
_engines: dict[str, Any] = {}

def engine(language: str):
    """Load models only on first OCR request, so the API starts quickly."""
    from paddleocr import PaddleOCR
    lang = "en" if language == "en" else "ch"
    if lang not in _engines:
        try:
            # Deskewing and denoising are handled locally in preprocess(). Keep
            # the first-download footprint small by not loading three optional
            # document-restoration models for every recognition request.
            _engines[lang] = PaddleOCR(
                lang=lang,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
            )
        except Exception as error:
            detail = str(error).replace("\n", " ")[:240]
            # PaddleOCR wraps import/runtime failures in a generic dependency
            # error. Preserve its direct cause so packaged desktop builds can
            # report the missing runtime component instead of a misleading
            # network/model-download message.
            cause = error.__cause__ or error.__context__
            if cause:
                cause_detail = f"{type(cause).__name__}: {cause}".replace("\n", " ")[:240]
                detail = f"{detail}（底层原因：{cause_detail}）"
            raise RuntimeError(f"OCR 模型初始化失败：{detail}。模型缓存位置：{PADDLE_CACHE}") from error
    return _engines[lang]

def preprocess(image_path: Path) -> np.ndarray:
    image = cv2.imdecode(np.fromfile(str(image_path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("无法读取图片")
    # Camera photos are often much larger than the OCR model needs. Limit the
    # longest side to keep handwritten-note recognition responsive.
    height, width = image.shape[:2]
    longest = max(height, width)
    if longest > 2200:
        scale = 2200 / longest
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.fastNlMeansDenoising(gray, None, 6, 7, 21)
    coords = np.column_stack(np.where(gray < 180))
    if len(coords) > 100:
        angle = cv2.minAreaRect(coords)[-1]
        angle = -(90 + angle) if angle < -45 else -angle
        # minAreaRect may return ±90° for an upright portrait page. Only deskew
        # a small camera tilt; never rotate an otherwise correct page sideways.
        if abs(angle) <= 15:
            matrix = cv2.getRotationMatrix2D((gray.shape[1] / 2, gray.shape[0] / 2), angle, 1.0)
            image = cv2.warpAffine(image, matrix, (gray.shape[1], gray.shape[0]), borderMode=cv2.BORDER_REPLICATE)
    # Improve uneven phone lighting without discarding red or black pen strokes.
    # Ruled-paper removal is deliberately avoided: it can erase horizontal
    # handwriting strokes such as 一 and 三.
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    lightness, channel_a, channel_b = cv2.split(lab)
    lightness = cv2.createCLAHE(clipLimit=1.6, tileGridSize=(8, 8)).apply(lightness)
    return cv2.cvtColor(cv2.merge((lightness, channel_a, channel_b)), cv2.COLOR_LAB2BGR)

def render_pdf_page(page: fitz.Page, folder: Path, number: int) -> Path:
    output = folder / f"page-{number}.png"
    page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).save(str(output))
    return output


def pdf_to_images(source: Path, folder: Path) -> list[Path]:
    with fitz.open(source) as pdf:
        return [render_pdf_page(page, folder, number) for number, page in enumerate(pdf, 1)]

def read_result(result: Any) -> list[dict[str, Any]]:
    """Normalize PaddleOCR 3 result formats without depending on private objects."""
    raw = getattr(result, "json", result)
    if callable(raw): raw = raw()
    if isinstance(raw, str): raw = json.loads(raw)
    if not isinstance(raw, dict): return []
    def find(obj: Any, key: str):
        if isinstance(obj, dict):
            if key in obj: return obj[key]
            for value in obj.values():
                found = find(value, key)
                if found is not None: return found
        return None
    texts = find(raw, "rec_texts") or []
    scores = find(raw, "rec_scores") or []
    boxes = find(raw, "rec_boxes") or []
    lines = [{"text": str(text), "score": round(float(scores[i]) if i < len(scores) else 0, 3), "box": boxes[i] if i < len(boxes) else None} for i, text in enumerate(texts)]
    return sort_reading_order(lines)


def box_geometry(box: Any) -> tuple[float, float, float] | None:
    """Return left, top and height for both Paddle box formats."""
    if box is None:
        return None
    try:
        values = np.asarray(box, dtype=float)
        if values.ndim == 1 and len(values) >= 4:
            # PaddleOCR's rec_boxes format is [top, left, bottom, right].
            return float(values[1]), float(values[0]), max(1.0, float(values[2] - values[0]))
        if values.ndim == 2 and values.shape[1] >= 2:
            return float(values[:, 0].min()), float(values[:, 1].min()), max(1.0, float(values[:, 1].max() - values[:, 1].min()))
    except (TypeError, ValueError):
        return None
    return None


def sort_reading_order(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalize OCR output into the natural top-to-bottom, left-to-right order."""
    measured = [(line, box_geometry(line.get("box"))) for line in lines]
    if not any(geometry for _, geometry in measured):
        return lines
    heights = [geometry[2] for _, geometry in measured if geometry]
    row_tolerance = max(8.0, float(np.median(heights)) * 0.65) if heights else 18.0
    rows: list[list[tuple[dict[str, Any], tuple[float, float, float]]]] = []
    for line, geometry in sorted((item for item in measured if item[1]), key=lambda item: item[1][1]):
        if not rows or abs(geometry[1] - np.mean([entry[1][1] for entry in rows[-1]])) > row_tolerance:
            rows.append([])
        rows[-1].append((line, geometry))
    ordered = [line for row in rows for line, _ in sorted(row, key=lambda entry: entry[1][0])]
    ordered.extend(line for line, geometry in measured if not geometry)
    return ordered

def set_cjk_font(document: Document) -> None:
    """Use a Windows CJK font for generated Word files when available."""
    style = document.styles["Normal"]
    style.font.name = "Microsoft YaHei"
    style.font.size = Pt(10.5)
    style._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")

def write_exports(job: Path, text: str) -> dict[str, str]:
    (job / "result.txt").write_text(text, encoding="utf-8")
    doc = Document(); set_cjk_font(doc); doc.add_paragraph(text); doc.save(job / "result.docx")
    wb = Workbook(); ws = wb.active; ws.title = "OCR 文本"
    for row, line in enumerate(text.splitlines(), 1): ws.cell(row, 1, line)
    wb.save(job / "result.xlsx")
    return {"txt": "result.txt", "docx": "result.docx", "xlsx": "result.xlsx"}

def text_encoding_is_unreliable(text: str) -> bool:
    """Detect the common broken ToUnicode mapping shown as squares in extracted text."""
    visible = [char for char in text if not char.isspace()]
    if not visible:
        return True
    broken = sum(char in {"□", "\ufffd"} for char in visible)
    return broken >= 3 and broken / len(visible) >= 0.01

def ocr_image_lines(image_path: Path) -> list[str]:
    image = preprocess(image_path)
    return [line["text"] for item in engine("ch").predict(image) for line in read_result(item)]


def ocr_pdf_text(source: Path, job: Path) -> str:
    """OCR rendered PDF pages when its embedded text encoding is unusable."""
    pages = pdf_to_images(source, job)
    lines: list[str] = []
    for page_no, image_path in enumerate(pages, 1):
        lines.extend(ocr_image_lines(image_path))
        if page_no < len(pages):
            lines.append("")
    return "\n".join(lines).strip()


def pdf_text_for_export(source: Path, job: Path) -> str:
    """Keep native text and recognize pages whose text layer is unusable."""
    pages: list[str] = []
    with fitz.open(source) as pdf:
        for number, page in enumerate(pdf, 1):
            text = page.get_text()
            if text_encoding_is_unreliable(text):
                try:
                    image = render_pdf_page(page, job, number)
                    text = "\n".join(ocr_image_lines(image))
                except RuntimeError as error:
                    raise HTTPException(503, f"PDF 第 {number} 页文字识别失败：{error}") from error
            pages.append(text)
    text = "\n\n".join(pages)
    if text_encoding_is_unreliable(text):
        raise HTTPException(422, "PDF 中未提取到可用文字，请检查页面内容和扫描清晰度。")
    return text


def write_pdf_word(source: Path, job: Path) -> tuple[Path, str]:
    """Export editable text when possible; never put corrupted PDF glyphs in Word."""
    with fitz.open(source) as pdf:
        page_text = [page.get_text() for page in pdf]
    text = "\n\n".join(page_text).strip()
    doc = Document()
    set_cjk_font(doc)
    output = job / "converted.docx"
    if not text_encoding_is_unreliable(text):
        for index, content in enumerate(page_text):
            doc.add_paragraph(content)
            if index < len(page_text) - 1:
                doc.add_page_break()
        doc.save(output)
        return output, "editable-text"

    # A malformed embedded character map cannot be repaired by changing Word fonts.
    # Prefer OCR, but preserve a clean readable document if the offline model is absent.
    try:
        ocr_text = ocr_pdf_text(source, job)
        if ocr_text and not text_encoding_is_unreliable(ocr_text):
            doc.add_paragraph(ocr_text)
            doc.save(output)
            return output, "ocr-text"
    except RuntimeError:
        pass

    doc.add_paragraph("此 PDF 的内嵌文字编码异常，已保留高清页面图像，避免出现乱码。安装本地 OCR 模型后可再次转换为可编辑文字。")
    with fitz.open(source) as pdf:
        for index, page in enumerate(pdf):
            image_path = job / f"word-page-{index + 1}.png"
            page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).save(str(image_path))
            doc.add_picture(str(image_path), width=Inches(6.15))
            if index < len(pdf) - 1:
                doc.add_page_break()
    doc.save(output)
    return output, "page-images"

def safe_job(job_id: str) -> Path:
    path = JOBS / job_id
    if not path.is_dir() or path.parent != JOBS:
        raise HTTPException(404, "任务不存在")
    return path

def process_file(file: UploadFile, language: str) -> dict[str, Any]:
    suffix = Path(file.filename or "upload").suffix.lower()
    if suffix not in {".pdf", ".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"}:
        raise HTTPException(415, f"不支持 {suffix or '此'} 文件格式")
    job = JOBS / uuid.uuid4().hex; job.mkdir()
    source = job / f"source{suffix}"
    with source.open("wb") as target: shutil.copyfileobj(file.file, target)
    try:
        pages = pdf_to_images(source, job) if suffix == ".pdf" else [source]
        all_lines: list[dict[str, Any]] = []
        for page_no, page in enumerate(pages, 1):
            image = preprocess(page)
            for item in engine(language).predict(image):
                for line in read_result(item): line["page"] = page_no; all_lines.append(line)
    except RuntimeError as error:
        shutil.rmtree(job, ignore_errors=True)
        if "onednn" in str(error).lower() or "convertpirattribute" in str(error).lower():
            raise HTTPException(503, "OCR 推理引擎兼容性错误，已自动切换为稳定 CPU 模式；请重新开始识别。") from error
        raise HTTPException(503, str(error)) from error
    # read_result() has already ordered each page. Preserve PDF page order when
    # a multi-page document is processed.
    all_lines.sort(key=lambda line: line["page"])
    text = "\n".join(x["text"] for x in all_lines)
    return {"job_id": job.name, "filename": file.filename, "pages": len(pages), "text": text, "lines": all_lines, "exports": write_exports(job, text)}

@app.get("/health")
def health():
    return {"status": "ready", "desktop_instance": os.environ.get("PAPERDOCK_INSTANCE_ID"), "pid": os.getpid(), "engine": "PaddleOCR", "models_loaded": list(_engines), "model_cache": str(RUNTIME), "note": "首次识别会下载模型；完成后可离线使用。"}

@app.post("/ocr")
def ocr(file: UploadFile = File(...), language: str = Form("ch")):
    return process_file(file, language)

@app.post("/ocr/batch")
async def ocr_batch(files: list[UploadFile] = File(...), language: str = Form("ch")):
    if not files:
        raise HTTPException(400, "请先选择 PDF 或图片")
    if len(files) > 10:
        raise HTTPException(400, "批量识别一次最多处理 10 个文件")

    # Each source keeps its own job for recovery/debugging, while this parent
    # job owns the combined text and exports shown in the correction panel.
    combined_job = JOBS / uuid.uuid4().hex
    combined_job.mkdir()
    results: list[dict[str, Any]] = []
    sections: list[str] = []
    all_lines: list[dict[str, Any]] = []
    total_pages = 0
    try:
        for file in files:
            item = process_file(file, language)
            results.append(item)
            filename = item.get("filename") or "未命名文件"
            file_text = item.get("text") or ""
            sections.append(f"【文件：{filename}】\n{file_text}".rstrip())
            for line in item.get("lines", []):
                merged_line = dict(line)
                merged_line["page"] = int(merged_line.get("page", 1)) + total_pages
                merged_line["filename"] = filename
                all_lines.append(merged_line)
            total_pages += int(item.get("pages", 0))
    except Exception:
        shutil.rmtree(combined_job, ignore_errors=True)
        raise

    text = "\n\n".join(section for section in sections if section)
    exports = write_exports(combined_job, text)
    return {
        "job_id": combined_job.name,
        "filename": f"批量识别（{len(results)} 个文件）",
        "pages": total_pages,
        "text": text,
        "lines": all_lines,
        "exports": exports,
        "results": [
            {"filename": item.get("filename"), "pages": item.get("pages"), "job_id": item.get("job_id")}
            for item in results
        ],
    }


@app.post("/ocr/combine")
async def combine_ocr_exports(payload: dict[str, Any]):
    """Create one export from individually processed OCR items.

    The desktop UI deliberately calls /ocr one file at a time so it can show
    real progress and let a failed file be retried without repeating the
    successful items. This endpoint owns the final combined export.
    """
    raw_items = payload.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise HTTPException(400, "请至少提供一份已识别文件")
    items: list[dict[str, Any]] = []
    sections: list[str] = []
    page_total = 0
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        filename = str(raw.get("filename") or "未命名文件")
        text = str(raw.get("text") or "")
        pages = max(0, int(raw.get("pages") or 0))
        items.append({"filename": filename, "text": text, "pages": pages, "job_id": str(raw.get("job_id") or ""), "lines": raw.get("lines", [])})
        sections.append(f"【文件：{filename}】\n{text}".rstrip())
        page_total += pages
    if not items:
        raise HTTPException(400, "没有可导出的识别结果")
    job = JOBS / uuid.uuid4().hex
    job.mkdir()
    text = "\n\n".join(sections)
    return {
        "job_id": job.name,
        "filename": f"批量识别（{len(items)} 个文件）",
        "pages": page_total,
        "text": text,
        "items": items,
        "exports": write_exports(job, text),
    }

@app.post("/exports/{job_id}")
async def rewrite_exports(job_id: str, payload: dict[str, str]):
    job = safe_job(job_id)
    text = payload.get("text", "")
    return {"job_id": job_id, "exports": write_exports(job, text)}

@app.post("/projects/{name}")
async def save_project(name: str, payload: dict[str, Any]):
    safe_name = "".join(c for c in name if c.isalnum() or c in "-_ ").strip()[:80] or "ocr-project"
    path = PROJECTS / f"{safe_name}.paperdock.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"project": path.name}

@app.get("/projects")
def list_projects():
    return {"projects": [p.name for p in PROJECTS.glob("*.paperdock.json")]}

@app.get("/download/{job_id}/{name}")
def download(job_id: str, name: str):
    if name not in {"result.txt", "result.docx", "result.xlsx"}: raise HTTPException(404, "文件不存在")
    path = JOBS / job_id / name
    if not path.exists(): raise HTTPException(404, "任务已不存在")
    return FileResponse(path, filename=name)

@app.post("/pdf/merge")
async def merge_pdfs(files: list[UploadFile] = File(...)):
    if len(files) < 2: raise HTTPException(400, "至少选择两份 PDF")
    if len(files) > 10: raise HTTPException(400, "一次最多合并 10 份 PDF")
    job = JOBS / uuid.uuid4().hex; job.mkdir(); output = job / "merged.pdf"
    merged = fitz.open()
    try:
        for upload in files:
            if Path(upload.filename or "").suffix.lower() != ".pdf": raise HTTPException(415, "仅支持 PDF")
            source = job / f"{uuid.uuid4().hex}.pdf"
            with source.open("wb") as target: shutil.copyfileobj(upload.file, target)
            with fitz.open(source) as document: merged.insert_pdf(document)
        merged.save(output)
    finally: merged.close()
    return FileResponse(output, filename="merged.pdf")

def normalize_form_text(value: str) -> str:
    """Repair multipart form text that was decoded as Latin-1 by some clients."""
    try:
        return value.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value

def selected_pdf_pages(raw: str, page_count: int, *, required: bool = False) -> list[int]:
    value = normalize_form_text(raw).strip()
    if not value:
        if required:
            raise HTTPException(400, "请填写需要处理的页码，例如 1,3,5")
        return list(range(page_count))
    selected: set[int] = set()
    # Split on any non-digit. This accepts Chinese/English punctuation and
    # remains compatible with clients that encode full-width commas differently.
    parts = [part for part in re.split(r"\D+", value) if part]
    if not parts:
        raise HTTPException(400, "页码格式不正确，请使用 1,3,5 的格式")
    for part in parts:
        if int(part) < 1:
            raise HTTPException(400, "页码必须从 1 开始")
        selected.add(int(part) - 1)
    if any(index >= page_count for index in selected):
        raise HTTPException(400, f"页码超出范围：此 PDF 共 {page_count} 页")
    return sorted(selected)

def insert_unicode_watermark(page: fitz.Page, text: str) -> None:
    """Draw a repeated, semi-transparent 30° watermark across an entire page."""
    # The built-in CJK font keeps ordinary Chinese watermarks small. Windows
    # fonts are only embedded for characters it cannot provide (for example
    # emoji), preserving the promised arbitrary-text fallback.
    available: list[tuple[int, Path | None, fitz.Font]] = [(0, None, fitz.Font(fontname="china-s"))]
    available.extend((index + 1, path, fitz.Font(fontfile=str(path))) for index, path in enumerate(WATERMARK_FONTS) if path.exists())
    page_rect = page.rect
    font_size = max(30, min(52, min(page_rect.width, page_rect.height) / 12))
    # Start beyond both left corners and repeat enough times to span every page
    # size, including A3 landscape documents.
    repeated = (f"  {text}  " * 5).strip()
    angle = fitz.Matrix(1, 1).prerotate(-30)
    fill_color = (0.38, 0.42, 0.44)
    baselines = range(int(-page_rect.height * 0.12), int(page_rect.height * 1.25), max(1, int(font_size * 2.25)))
    if not available:
        for baseline in baselines:
            point = fitz.Point(-page_rect.width * 0.28, baseline)
            page.insert_text(point, repeated, fontsize=font_size, color=fill_color, fill_opacity=0.36, morph=(point, angle), overlay=True)
        return
    groups: list[tuple[int, str]] = []
    for char in repeated:
        selected = next((item for item in available if item[2].has_glyph(ord(char))), available[0])
        if groups and groups[-1][0] == selected[0]:
            groups[-1] = (selected[0], groups[-1][1] + char)
        else:
            groups.append((selected[0], char))
    # Register each fallback font once on this page. Passing fontfile to every
    # repeated line would embed the same CJK font many times and bloat output.
    for font_index in {index for index, _ in groups}:
        _, font_path, _ = next(item for item in available if item[0] == font_index)
        if font_path is not None:
            page.insert_font(fontname=f"pdwm{font_index}", fontfile=str(font_path))
    for baseline in baselines:
        start = fitz.Point(-page_rect.width * 0.28, baseline)
        x = start.x
        for font_index, chunk in groups:
            _, font_path, font = next(item for item in available if item[0] == font_index)
            point = fitz.Point(x, start.y)
            font_name = "china-s" if font_path is None else f"pdwm{font_index}"
            page.insert_text(point, chunk, fontsize=font_size, fontname=font_name, color=fill_color, fill_opacity=0.36, morph=(point, angle), overlay=True)
            x += font.text_length(chunk, fontsize=font_size)

def flatten_to_image_pdf(document: fitz.Document, output: Path) -> None:
    """Rasterize every rendered page so the watermark becomes part of its pixels."""
    flattened = fitz.open()
    try:
        for page in document:
            source_rect = page.rect
            # 144 DPI keeps fine text readable while avoiding unbounded PNG size.
            pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            image_page = flattened.new_page(width=source_rect.width, height=source_rect.height)
            image_page.insert_image(image_page.rect, stream=pixmap.tobytes("jpeg", jpg_quality=92))
        flattened.save(output, garbage=4, deflate=True)
    finally:
        flattened.close()

@app.post("/pdf/transform")
async def transform_pdf(
    file: UploadFile = File(...), action: str = Form(...), pages: str = Form(""),
    degrees: int = Form(90), watermark_text: str = Form("PaperDock"),
    watermark_x: float = Form(36), watermark_y: float = Form(36), crop_margin: float = Form(0),
):
    if Path(file.filename or "").suffix.lower() != ".pdf": raise HTTPException(415, "仅支持 PDF")
    job = JOBS / uuid.uuid4().hex; job.mkdir(); source = job / "source.pdf"; output = job / "processed.pdf"
    with source.open("wb") as target: shutil.copyfileobj(file.file, target)
    document = fitz.open(source)
    filename = "processed.pdf"
    try:
        if not len(document): raise HTTPException(400, "PDF 没有可处理的页面")
        targets = selected_pdf_pages(pages, len(document), required=action in {"delete", "extract"})
        if action == "rotate":
            if degrees not in {0, 90, 180, 270, 360}: raise HTTPException(400, "旋转角度只能是 0、90、180、270 或 360")
            for index in targets: document[index].set_rotation(degrees % 360)
        elif action == "delete":
            if len(targets) == len(document): raise HTTPException(400, "不能删除全部页面")
            for index in reversed(targets): document.delete_page(index)
        elif action == "extract":
            copy = fitz.open()
            try:
                for index in targets: copy.insert_pdf(document, from_page=index, to_page=index)
                copy.save(output)
            finally:
                copy.close()
            filename = "extracted.pdf"
        elif action == "watermark":
            watermark_text = normalize_form_text(watermark_text)
            if not watermark_text.strip(): raise HTTPException(400, "请输入水印文字")
            # Page selection applies only to watermark drawing. The final PDF
            # is intentionally rasterized page-by-page, making the watermark
            # part of the image pixels rather than an editable text layer.
            for index in targets:
                insert_unicode_watermark(document[index], watermark_text.strip())
            flatten_to_image_pdf(document, output)
            document.close()
            return FileResponse(output, filename="paperdock-watermarked-flat.pdf")
        elif action == "crop":
            if crop_margin < 0: raise HTTPException(400, "裁切边距不能小于 0")
            for index in targets:
                page = document[index]
                box = fitz.Rect(page.rect.x0 + crop_margin, page.rect.y0 + crop_margin, page.rect.x1 - crop_margin, page.rect.y1 - crop_margin)
                if box.width <= 20 or box.height <= 20: raise HTTPException(400, "裁切边距过大")
                page.set_cropbox(box)
        else: raise HTTPException(400, "不支持的 PDF 操作")
        if action != "extract": document.save(output)
    finally:
        if not document.is_closed: document.close()
    return FileResponse(output, filename=filename)

@app.post("/convert")
async def convert_file(files: list[UploadFile] = File(...), target: str = Form(...)):
    if not files:
        raise HTTPException(400, "请至少选择一个文件")
    if len(files) > 10:
        raise HTTPException(400, "图片转 PDF 一次最多上传 10 张图片")
    suffix = Path(files[0].filename or "upload").suffix.lower()
    job = JOBS / uuid.uuid4().hex; job.mkdir()
    sources: list[Path] = []
    for index, upload in enumerate(files, 1):
        upload_suffix = Path(upload.filename or "upload").suffix.lower()
        source = job / f"source-{index}{upload_suffix}"
        with source.open("wb") as target_file: shutil.copyfileobj(upload.file, target_file)
        sources.append(source)
    source = sources[0]
    image_types = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"}
    if target == "pdf" and all(path.suffix.lower() in image_types for path in sources):
        image = fitz.open()
        try:
            for image_path in sources:
                with fitz.open(image_path) as input_image:
                    rect = input_image[0].rect
                page = image.new_page(width=rect.width, height=rect.height)
                page.insert_image(page.rect, filename=str(image_path))
            output = job / "converted.pdf"
            image.save(output)
        finally:
            image.close()
    elif len(files) != 1:
        raise HTTPException(400, "除图片转 PDF 外，其他转换每次只能选择一个文件")
    elif suffix == ".pdf" and target in {"txt", "xlsx"}:
        text = pdf_text_for_export(source, job)
        if target == "txt":
            output = job / "converted.txt"
            output.write_text(text, encoding="utf-8")
        else:
            output = job / write_exports(job, text)["xlsx"]
    elif suffix == ".pdf" and target == "docx":
        output, mode = write_pdf_word(source, job)
        response = FileResponse(output, filename=output.name)
        response.headers["X-PaperDock-Conversion-Mode"] = mode
        return response
    elif suffix == ".pdf" and target == "images":
        archive = job / "pages.zip"
        with fitz.open(source) as pdf, zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for number, page in enumerate(pdf, 1):
                image_path = job / f"page-{number}.png"; page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).save(image_path); bundle.write(image_path, image_path.name)
        output = archive
    else:
        raise HTTPException(415, "此输入格式暂不支持该输出格式")
    return FileResponse(output, filename=output.name)

def validate_strong_password(value: str, label: str) -> None:
    """Require a high-strength password without restricting usable symbols."""
    if len(value) < 12:
        raise HTTPException(400, f"{label}至少需要 12 个字符")
    if not any(char.isupper() for char in value):
        raise HTTPException(400, f"{label}需包含大写字母")
    if not any(char.islower() for char in value):
        raise HTTPException(400, f"{label}需包含小写字母")
    if not any(char.isdigit() for char in value):
        raise HTTPException(400, f"{label}需包含数字")
    if not any(not char.isalnum() for char in value):
        raise HTTPException(400, f"{label}需包含符号；中文、表情和常见符号均可使用")


def security_permissions(value: str) -> int:
    """Build the permissions bitmask passed to the AES-256 PDF encryption handler."""
    try:
        selected = set(json.loads(value or "[]"))
    except (TypeError, json.JSONDecodeError) as error:
        raise HTTPException(400, "权限设置格式错误") from error
    allowed = 0
    if "copy" in selected:
        allowed |= fitz.PDF_PERM_COPY | fitz.PDF_PERM_ACCESSIBILITY
    if "print" in selected:
        allowed |= fitz.PDF_PERM_PRINT | fitz.PDF_PERM_PRINT_HQ
    if "modify" in selected:
        allowed |= fitz.PDF_PERM_MODIFY | fitz.PDF_PERM_ANNOTATE | fitz.PDF_PERM_FORM | fitz.PDF_PERM_ASSEMBLE
    return allowed


def is_paperdock_secured(document: fitz.Document) -> bool:
    return SECURITY_MARKER in str((document.metadata or {}).get("producer", ""))


@app.post("/security/{operation}")
async def security_pdf(operation: str, file: UploadFile = File(...), password: str = Form(""), owner_password: str = Form(""), redact_text: str = Form(""), permissions: str = Form("[]")):
    if Path(file.filename or "").suffix.lower() != ".pdf": raise HTTPException(415, "仅支持 PDF")
    job = JOBS / uuid.uuid4().hex; job.mkdir(); source = job / "source.pdf"; output = job / "secured.pdf"
    with source.open("wb") as target: shutil.copyfileobj(file.file, target)
    document = fitz.open(source)
    if operation == "protect":
        if document.needs_pass:
            document.close(); raise HTTPException(400, "已有密码的 PDF 请先通过“移除已有密码”生成未加密副本后再重新加密")
        validate_strong_password(password, "打开密码")
        validate_strong_password(owner_password, "所有者密码")
        if password == owner_password:
            document.close(); raise HTTPException(400, "所有者密码必须与打开密码不同")
        metadata = dict(document.metadata or {})
        metadata["producer"] = SECURITY_MARKER
        document.set_metadata(metadata)
        document.save(
            output,
            encryption=fitz.PDF_ENCRYPT_AES_256,
            owner_pw=owner_password,
            user_pw=password,
            permissions=security_permissions(permissions),
            garbage=4,
            deflate=True,
        )
    elif operation == "unlock":
        if not document.needs_pass:
            document.close(); raise HTTPException(400, "该 PDF 未设置密码，无需移除")
        # Authenticate before looking at the marker. The user password is the only
        # accepted credential for this operation; owner passwords cannot unlock it.
        authentication = document.authenticate(password)
        if not authentication or authentication not in (2, 6):
            document.close(); raise HTTPException(401, "请输入正确的打开密码，所有者密码不能用于移除密码")
        if not is_paperdock_secured(document):
            document.close(); raise HTTPException(403, "为保护外部文件，仅支持移除 PaperDock 自己加密生成的 PDF")
        document.save(output, encryption=fitz.PDF_ENCRYPT_NONE, garbage=4, deflate=True)
    elif operation == "clean-metadata":
        if document.needs_pass and not document.authenticate(password):
            document.close(); raise HTTPException(401, "PDF 密码不正确")
        # Standard Info metadata and XMP are independent PDF stores. Clear both
        # and fully rewrite the file so stale objects / the former document ID
        # are discarded instead of being retained as an incremental revision.
        document.set_metadata({key: "" for key in document.metadata})
        if document.xref_xml_metadata():
            document.del_xml_metadata()
        document.save(output, garbage=4, clean=True, deflate=True, no_new_id=False)
    elif operation == "redact":
        if document.needs_pass and not document.authenticate(password):
            document.close(); raise HTTPException(401, "PDF 密码不正确")
        terms = [x.strip() for x in redact_text.splitlines() if x.strip()]
        if not terms: document.close(); raise HTTPException(400, "请输入需要永久涂黑的文字")
        # Search the complete file before changing any page. This avoids a
        # misleading partial output when a requested term does not exist.
        matches: dict[str, list[tuple[int, fitz.Rect]]] = {term: [] for term in terms}
        for page_number, page in enumerate(document):
            for term in terms:
                matches[term].extend((page_number, rect) for rect in page.search_for(term))
        missing = [term for term, locations in matches.items() if not locations]
        if missing:
            document.close()
            raise HTTPException(404, f"以下内容无法在 PDF 中找到：{'；'.join(missing)}。未生成新 PDF。")
        for page_number, page in enumerate(document):
            for term in terms:
                for found_page, rect in matches[term]:
                    if found_page == page_number:
                        page.add_redact_annot(rect, fill=(0, 0, 0))
            page.apply_redactions()
        document.save(output)
    else:
        document.close(); raise HTTPException(404, "未知安全操作")
    document.close(); return FileResponse(output, filename=output.name)

# Layout, tables, annotations, forms, compare and other tools reuse the OCR
# helpers defined above, so they are imported only after them.
from backend.tools import router as tools_router
app.include_router(tools_router)

# Registered last so API routes above keep their normal paths. The desktop
# wrapper loads this same built UI at /desktop/ without Node or a browser.
if DESKTOP_FRONTEND.is_dir():
    app.mount("/desktop", StaticFiles(directory=str(DESKTOP_FRONTEND), html=True), name="desktop")
