"""PaperDock document tools: layout restore, tables, page organizer, annotations,
forms, signatures, compare, repair and extra export formats.

Registered by backend.app after its shared OCR helpers are defined.
"""
from __future__ import annotations

import base64
import difflib
import hashlib
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
from docx.shared import Inches
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from openpyxl import Workbook

from backend.app import JOBS, engine, normalize_form_text, preprocess, read_result, selected_pdf_pages, set_cjk_font, text_encoding_is_unreliable

router = APIRouter()
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"}
CJK = re.compile(r"[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]")
COLORS = {
    "yellow": (1.0, 0.82, 0.1), "green": (0.2, 0.75, 0.35), "blue": (0.1, 0.45, 0.91),
    "red": (0.86, 0.2, 0.18), "pink": (0.95, 0.4, 0.7), "black": (0.1, 0.1, 0.1),
}
STATUS_PREFIX = "状态："


# ---------- shared helpers ----------

def new_job() -> Path:
    job = JOBS / uuid.uuid4().hex
    job.mkdir()
    return job


def save_upload(upload: UploadFile, job: Path, stem: str = "source", allowed: set[str] | None = None) -> Path:
    suffix = Path(upload.filename or "").suffix.lower()
    if allowed is not None and suffix not in allowed:
        raise HTTPException(415, f"不支持 {suffix or '此'} 文件格式")
    path = job / f"{stem}{suffix}"
    with path.open("wb") as target:
        shutil.copyfileobj(upload.file, target)
    return path


def open_pdf(path: Path) -> fitz.Document:
    try:
        document = fitz.open(path)
    except Exception as error:
        raise HTTPException(400, "无法打开该 PDF，可以先用“修复 PDF”处理后再试") from error
    if document.needs_pass:
        document.close()
        raise HTTPException(400, "该 PDF 设有打开密码，请先在安全中心移除密码")
    if not len(document):
        document.close()
        raise HTTPException(400, "PDF 没有可处理的页面")
    return document


def parse_json(raw: str, label: str) -> Any:
    try:
        return json.loads(normalize_form_text(raw or ""))
    except json.JSONDecodeError as error:
        raise HTTPException(400, f"{label}格式错误") from error


def rect_of(box: Any) -> tuple[float, float, float, float] | None:
    """PaddleOCR rec_boxes are [x0, y0, x1, y1]; polygons are point lists."""
    if box is None:
        return None
    try:
        values = np.asarray(box, dtype=float)
    except (TypeError, ValueError):
        return None
    if values.ndim == 1 and len(values) >= 4:
        return float(values[0]), float(values[1]), float(values[2]), float(values[3])
    if values.ndim == 2 and values.shape[1] >= 2:
        return float(values[:, 0].min()), float(values[:, 1].min()), float(values[:, 0].max()), float(values[:, 1].max())
    return None


def tidy_ocr(text: str) -> str:
    """Drop the stray spaces the recognizer inserts around CJK characters and in decimals."""
    text = re.sub(r"(?<=[\u3400-\u9fff])\s+|\s+(?=[\u3400-\u9fff])", "", text)
    # A number split inside Chinese text, e.g. "第1 3行" → "第13行".
    text = re.sub(r"(?<=[\u3400-\u9fff])(\d+)\s+(?=\d+[\u3400-\u9fff])", r"\1", text)
    return re.sub(r"(?<=\d)\s*\.\s+(?=\d)", ".", text).strip()


def ocr_image(path: Path, language: str) -> tuple[list[dict[str, Any]], np.ndarray]:
    """OCR an image after the standard cleanup; boxes refer to the cleaned image."""
    image = preprocess(path)
    lines: list[dict[str, Any]] = []
    try:
        for item in engine(language).predict(image):
            lines.extend(read_result(item))
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from error
    for line in lines:
        line["rect"] = rect_of(line.get("box"))
        line["text"] = tidy_ocr(line["text"])
    return [line for line in lines if line["rect"]], image


def render_page(page: fitz.Page, path: Path, zoom: float = 2) -> Path:
    page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False).save(str(path))
    return path


def page_needs_ocr(page: fitz.Page) -> bool:
    text = page.get_text().strip()
    return not text or text_encoding_is_unreliable(text)


def join_lines(lines: list[str]) -> str:
    text = ""
    for line in (item.strip() for item in lines):
        if not line:
            continue
        if text and not (CJK.search(text[-1]) or CJK.search(line[0])):
            text += " "
        text += line
    return text


# ---------- layout restoration ----------

def reading_order(blocks: list[dict[str, Any]], width: float) -> list[dict[str, Any]]:
    """Order blocks top-to-bottom; within bands between full-width blocks,
    detect vertical gutters and read each column before the next one."""
    ordered: list[dict[str, Any]] = []
    band: list[dict[str, Any]] = []

    def flush() -> None:
        ordered.extend(column_order(band, width))
        band.clear()

    for block in sorted(blocks, key=lambda b: (b["bbox"][1], b["bbox"][0])):
        x0, _, x1, _ = block["bbox"]
        if x1 - x0 > width * 0.55:
            flush()
            ordered.append(block)
        else:
            band.append(block)
    flush()
    return ordered


def row_sort(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    heights = [b["bbox"][3] - b["bbox"][1] for b in blocks] or [10]
    tolerance = max(4.0, float(np.median(heights)) * 0.6)
    return sorted(blocks, key=lambda b: (round(b["bbox"][1] / tolerance), b["bbox"][0]))


def column_order(blocks: list[dict[str, Any]], width: float) -> list[dict[str, Any]]:
    if len(blocks) < 6:
        return row_sort(blocks)
    bins = 240
    cover = np.zeros(bins, dtype=bool)
    for block in blocks:
        x0, _, x1, _ = block["bbox"]
        cover[max(0, int(x0 / width * bins)):min(bins, int(np.ceil(x1 / width * bins)))] = True
    occupied = np.flatnonzero(cover)
    if not len(occupied):
        return row_sort(blocks)
    cuts: list[float] = []
    gap_start = None
    for index in range(occupied[0], occupied[-1] + 1):
        if not cover[index]:
            gap_start = index if gap_start is None else gap_start
        else:
            if gap_start is not None and index - gap_start >= 2:
                cuts.append((gap_start + index) / 2 / bins * width)
            gap_start = None
    edges = [-1e9, *cuts, 1e9]
    columns = [[b for b in blocks if edges[k] <= (b["bbox"][0] + b["bbox"][2]) / 2 < edges[k + 1]] for k in range(len(edges) - 1)]
    top = min(b["bbox"][1] for b in blocks)
    bottom = max(b["bbox"][3] for b in blocks)
    span = max(1.0, bottom - top)
    # A real text column is tall; a gap between table cells or two words is not.
    is_columns = len(columns) > 1 and all(
        len(col) >= 3 and (max(b["bbox"][3] for b in col) - min(b["bbox"][1] for b in col)) >= span * 0.4 for col in columns
    )
    if not is_columns:
        return row_sort(blocks)
    return [block for column in columns for block in row_sort(column)]


def page_layout(page: fitz.Page, job: Path, language: str, page_no: int) -> dict[str, list[dict[str, Any]]]:
    """Return header/body/footer items: text, image and table blocks."""
    blocks: list[dict[str, Any]] = []
    if page_needs_ocr(page):
        rendered = render_page(page, job / f"layout-{page_no}.png")
        lines, image = ocr_image(rendered, language)
        height, width = image.shape[:2]
        blocks = [{"kind": "text", "bbox": line["rect"], "text": line["text"]} for line in lines]
    else:
        width, height = page.rect.width, page.rect.height
        tables = []
        try:
            tables = [t for t in page.find_tables().tables if t.row_count >= 2 and t.col_count >= 2]
        except Exception:
            tables = []
        table_rects = [fitz.Rect(t.bbox) for t in tables]
        for table in tables:
            rows = [[(cell or "").strip() for cell in row] for row in table.extract()]
            blocks.append({"kind": "table", "bbox": tuple(table.bbox), "rows": rows})
        for index, block in enumerate(page.get_text("dict")["blocks"]):
            bbox = tuple(block["bbox"])
            if any(fitz.Rect(bbox).intersect(rect).get_area() > fitz.Rect(bbox).get_area() * 0.5 for rect in table_rects):
                continue
            if block["type"] == 0:
                text = join_lines(["".join(span["text"] for span in line["spans"]) for line in block["lines"]])
                if text:
                    blocks.append({"kind": "text", "bbox": bbox, "text": text})
            elif block["type"] == 1 and block.get("width", 0) >= 40 and block.get("height", 0) >= 40:
                decoded = cv2.imdecode(np.frombuffer(block["image"], dtype=np.uint8), cv2.IMREAD_COLOR)
                if decoded is not None:
                    path = job / f"img-{page_no}-{index}.png"
                    cv2.imencode(".png", decoded)[1].tofile(str(path))
                    blocks.append({"kind": "image", "bbox": bbox, "path": path, "ratio": (bbox[2] - bbox[0]) / max(1, width)})
    header = [b for b in blocks if b["kind"] == "text" and b["bbox"][3] <= height * 0.07]
    footer = [b for b in blocks if b["kind"] == "text" and b["bbox"][1] >= height * 0.93]
    body = [b for b in blocks if b not in header and b not in footer]
    return {"header": row_sort(header), "body": reading_order(body, width), "footer": row_sort(footer)}


def document_layouts(source: Path, job: Path, language: str) -> list[dict[str, list[dict[str, Any]]]]:
    if source.suffix.lower() in IMAGE_TYPES:
        lines, image = ocr_image(source, language)
        height, width = image.shape[:2]
        blocks = [{"kind": "text", "bbox": line["rect"], "text": line["text"]} for line in lines]
        return [{"header": [], "body": reading_order(blocks, width), "footer": []}]
    document = open_pdf(source)
    try:
        return [page_layout(page, job, language, index + 1) for index, page in enumerate(document)]
    finally:
        document.close()


def write_layout_docx(layouts: list[dict[str, list[dict[str, Any]]]], output: Path) -> None:
    doc = Document()
    set_cjk_font(doc)
    section = doc.sections[0]
    # The first page's header/footer becomes the Word header/footer; repeated
    # running headers on later pages are dropped from the body.
    if layouts and layouts[0]["header"]:
        section.header.paragraphs[0].text = "  ".join(b["text"] for b in layouts[0]["header"])
    if layouts and layouts[0]["footer"]:
        section.footer.paragraphs[0].text = "  ".join(b["text"] for b in layouts[0]["footer"])
    for page_index, layout in enumerate(layouts):
        for block in layout["body"]:
            if block["kind"] == "text":
                doc.add_paragraph(block["text"])
            elif block["kind"] == "image":
                doc.add_picture(str(block["path"]), width=Inches(max(1.0, min(6.2, 6.2 * block["ratio"]))))
            elif block["kind"] == "table":
                rows = block["rows"]
                table = doc.add_table(rows=len(rows), cols=max(len(r) for r in rows))
                table.style = "Table Grid"
                for r, row in enumerate(rows):
                    for c, value in enumerate(row):
                        table.cell(r, c).text = value
        if page_index < len(layouts) - 1:
            doc.add_page_break()
    doc.save(output)


def layout_markdown(layouts: list[dict[str, list[dict[str, Any]]]]) -> str:
    parts: list[str] = []
    for index, layout in enumerate(layouts, 1):
        parts.append(f"<!-- 第 {index} 页 -->")
        for block in layout["body"]:
            if block["kind"] == "text":
                parts.append(block["text"])
            elif block["kind"] == "image":
                parts.append("![图片]()")
            elif block["kind"] == "table":
                rows = block["rows"]
                cols = max(len(r) for r in rows)
                fix = lambda row: [cell.replace("|", "\\|").replace("\n", " ") for cell in row] + [""] * (cols - len(row))
                parts.append("\n".join([
                    "| " + " | ".join(fix(rows[0])) + " |",
                    "| " + " | ".join(["---"] * cols) + " |",
                    *("| " + " | ".join(fix(row)) + " |" for row in rows[1:]),
                ]))
    return "\n\n".join(parts) + "\n"


def layout_page_texts(layouts: list[dict[str, list[dict[str, Any]]]]) -> list[list[str]]:
    pages = []
    for layout in layouts:
        paragraphs = []
        for block in layout["body"]:
            if block["kind"] == "text":
                paragraphs.append(block["text"])
            elif block["kind"] == "table":
                paragraphs.extend("\t".join(row) for row in block["rows"])
        pages.append(paragraphs)
    return pages


# ---------- tables ----------

def line_positions(profile: np.ndarray, threshold: float, offset: int) -> list[int]:
    hits = np.flatnonzero(profile >= threshold)
    groups: list[list[int]] = []
    for value in hits:
        if groups and value - groups[-1][-1] <= 6:
            groups[-1].append(int(value))
        else:
            groups.append([int(value)])
    return [offset + int(np.mean(group)) for group in groups]


def detect_grids(image: np.ndarray) -> list[tuple[list[int], list[int]]]:
    """Find ruled tables with morphology; returns row and column line positions."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    binary = cv2.adaptiveThreshold(~gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 15, -2)
    height, width = binary.shape
    horizontal = cv2.morphologyEx(binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, width // 30), 1)))
    vertical = cv2.morphologyEx(binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(20, height // 30))))
    mask = cv2.dilate(horizontal | vertical, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    grids = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if w < width * 0.15 or h < height * 0.03:
            continue
        rows = line_positions(horizontal[y:y + h, x:x + w].sum(axis=1) / 255, w * 0.3, y)
        cols = line_positions(vertical[y:y + h, x:x + w].sum(axis=0) / 255, h * 0.3, x)
        if len(rows) >= 2 and len(cols) >= 2:
            grids.append((rows, cols))
    return sorted(grids, key=lambda grid: grid[0][0])


def aligned_table(lines: list[dict[str, Any]]) -> list[list[str]] | None:
    """Borderless fallback: group OCR lines into rows, then cluster column starts."""
    if len(lines) < 4:
        return None
    heights = [line["rect"][3] - line["rect"][1] for line in lines]
    tolerance = max(6.0, float(np.median(heights)) * 0.6)
    rows: list[list[dict[str, Any]]] = []
    for line in sorted(lines, key=lambda item: item["rect"][1]):
        if rows and abs(line["rect"][1] - rows[-1][0]["rect"][1]) <= tolerance:
            rows[-1].append(line)
        else:
            rows.append([line])
    multi = [row for row in rows if len(row) >= 2]
    if len(multi) < 2:
        return None
    starts = sorted(line["rect"][0] for row in multi for line in row)
    anchors = [[starts[0]]]
    for value in starts[1:]:
        if value - anchors[-1][-1] > float(np.median(heights)) * 1.5:
            anchors.append([value])
        else:
            anchors[-1].append(value)
    centers = [float(np.mean(group)) for group in anchors]
    if len(centers) < 2:
        return None
    table = []
    for row in rows:
        cells = [""] * len(centers)
        for line in sorted(row, key=lambda item: item["rect"][0]):
            column = int(np.argmin([abs(line["rect"][0] - center) for center in centers]))
            cells[column] = (cells[column] + " " + line["text"]).strip()
        table.append(cells)
    return table


def tables_from_image(path: Path, language: str) -> list[list[list[str]]]:
    lines, image = ocr_image(path, language)
    tables = []
    used: set[int] = set()
    for rows, cols in detect_grids(image):
        grid = [["" for _ in range(len(cols) - 1)] for _ in range(len(rows) - 1)]
        for index, line in enumerate(lines):
            x0, y0, x1, y1 = line["rect"]
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            r = next((k for k in range(len(rows) - 1) if rows[k] <= cy < rows[k + 1]), None)
            c = next((k for k in range(len(cols) - 1) if cols[k] <= cx < cols[k + 1]), None)
            if r is not None and c is not None:
                grid[r][c] = (grid[r][c] + " " + line["text"]).strip()
                used.add(index)
        if any(any(cell for cell in row) for row in grid):
            tables.append(grid)
    if not tables:
        fallback = aligned_table([line for index, line in enumerate(lines) if index not in used])
        if fallback:
            tables.append(fallback)
    return tables


def extract_tables(source: Path, job: Path, language: str) -> list[tuple[str, list[list[str]]]]:
    found: list[tuple[str, list[list[str]]]] = []
    if source.suffix.lower() in IMAGE_TYPES:
        return [(f"表{i}", table) for i, table in enumerate(tables_from_image(source, language), 1)]
    document = open_pdf(source)
    try:
        for page_no, page in enumerate(document, 1):
            if page_needs_ocr(page):
                tables = tables_from_image(render_page(page, job / f"table-{page_no}.png", 3), language)
            else:
                try:
                    tables = [[[(cell or "").strip() for cell in row] for row in t.extract()] for t in page.find_tables().tables]
                except Exception:
                    tables = []
            found.extend((f"P{page_no}-表{i}", table) for i, table in enumerate(tables, 1))
    finally:
        document.close()
    return found


@router.post("/tables/extract")
async def tables_extract(files: list[UploadFile] = File(...), language: str = Form("ch"), output: str = Form("xlsx")):
    if not files or len(files) > 10:
        raise HTTPException(400, "请选择 1–10 个 PDF 或图片")
    job = new_job()
    collected: list[tuple[str, list[list[str]]]] = []
    for index, upload in enumerate(files, 1):
        source = save_upload(upload, job, f"source-{index}", {".pdf", *IMAGE_TYPES})
        prefix = f"{index}-" if len(files) > 1 else ""
        collected.extend((prefix + name, table) for name, table in extract_tables(source, job, language))
    if not collected:
        raise HTTPException(404, "没有检测到表格。带框线的表格效果最好；无框线表格需要列对齐清晰。")
    if output == "csv":
        archive = job / "tables-csv.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for name, table in collected:
                lines = [",".join('"' + cell.replace('"', '""') + '"' for cell in row) for row in table]
                bundle.writestr(f"{name}.csv", "\ufeff" + "\r\n".join(lines))
        response = FileResponse(archive, filename=archive.name)
    else:
        workbook = Workbook()
        workbook.remove(workbook.active)
        for name, table in collected:
            sheet = workbook.create_sheet(re.sub(r"[\\/*?:\[\]]", "_", name)[:31])
            for row in table:
                sheet.append(row)
            for column in sheet.columns:
                sheet.column_dimensions[column[0].column_letter].width = min(48, max(8, max(len(str(c.value or "")) for c in column) * 1.6))
        path = job / "tables.xlsx"
        workbook.save(path)
        response = FileResponse(path, filename=path.name)
    response.headers["X-PaperDock-Tables"] = str(len(collected))
    return response


# ---------- extra conversions ----------

@router.post("/convert/extra")
async def convert_extra(file: UploadFile = File(...), target: str = Form(...), language: str = Form("ch")):
    job = new_job()
    source = save_upload(file, job, "source", {".pdf", *IMAGE_TYPES})
    if target in {"layout-docx", "md", "odt", "epub"}:
        layouts = document_layouts(source, job, language)
        if target == "layout-docx":
            output = job / "layout.docx"
            write_layout_docx(layouts, output)
        elif target == "md":
            output = job / "document.md"
            output.write_text(layout_markdown(layouts), encoding="utf-8")
        elif target == "odt":
            output = job / "document.odt"
            write_odt(layout_page_texts(layouts), output)
        else:
            output = job / "document.epub"
            write_epub(layout_page_texts(layouts), Path(file.filename or "PaperDock").stem, output)
    elif target == "pptx":
        output = job / "slides.pptx"
        write_pptx(source, job, output)
    elif target == "embedded-images":
        output = extract_embedded_images(source, job)
    else:
        raise HTTPException(400, "不支持的输出格式")
    return FileResponse(output, filename=output.name)


def write_odt(pages: list[list[str]], output: Path) -> None:
    from odf.opendocument import OpenDocumentText
    from odf.style import ParagraphProperties, Style
    from odf.text import P

    document = OpenDocumentText()
    page_break = Style(name="PageBreak", family="paragraph")
    page_break.addElement(ParagraphProperties(breakbefore="page"))
    document.automaticstyles.addElement(page_break)
    for index, paragraphs in enumerate(pages):
        for number, paragraph in enumerate(paragraphs or [""]):
            document.text.addElement(P(text=paragraph, stylename=page_break if index and not number else None))
    document.save(str(output))


def write_epub(pages: list[list[str]], title: str, output: Path) -> None:
    from html import escape

    from ebooklib import epub

    book = epub.EpubBook()
    book.set_identifier(uuid.uuid4().hex)
    book.set_title(title)
    book.set_language("zh")
    chapters = []
    for index, paragraphs in enumerate(pages, 1):
        chapter = epub.EpubHtml(title=f"第 {index} 页", file_name=f"page-{index}.xhtml", lang="zh")
        chapter.content = f"<h2>第 {index} 页</h2>" + "".join(f"<p>{escape(p)}</p>" for p in paragraphs)
        book.add_item(chapter)
        chapters.append(chapter)
    book.toc = chapters
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = ["nav", *chapters]
    epub.write_epub(str(output), book)


def write_pptx(source: Path, job: Path, output: Path) -> None:
    """Each page becomes a full-slide picture; its text goes into speaker notes."""
    from pptx import Presentation
    from pptx.util import Emu

    presentation = Presentation()
    blank = presentation.slide_layouts[6]
    if source.suffix.lower() in IMAGE_TYPES:
        pages = [(source, "")]
    else:
        document = open_pdf(source)
        try:
            pages = [(render_page(page, job / f"slide-{i}.png"), page.get_text().strip()) for i, page in enumerate(document, 1)]
            first = document[0].rect
        finally:
            document.close()
        presentation.slide_width = Emu(int(first.width * 12700))
        presentation.slide_height = Emu(int(first.height * 12700))
    for image, notes in pages:
        slide = presentation.slides.add_slide(blank)
        slide.shapes.add_picture(str(image), 0, 0, presentation.slide_width, presentation.slide_height)
        if notes:
            slide.notes_slide.notes_text_frame.text = notes
    presentation.save(output)


def extract_embedded_images(source: Path, job: Path) -> Path:
    if source.suffix.lower() != ".pdf":
        raise HTTPException(415, "提取内嵌图片仅支持 PDF")
    archive = job / "embedded-images.zip"
    count = 0
    document = open_pdf(source)
    seen: set[int] = set()
    try:
        with zipfile.ZipFile(archive, "w") as bundle:
            for page_no, page in enumerate(document, 1):
                for info in page.get_images(full=True):
                    xref = info[0]
                    if xref in seen:
                        continue
                    seen.add(xref)
                    data = document.extract_image(xref)
                    if data and data.get("image"):
                        count += 1
                        bundle.writestr(f"p{page_no}-{count}.{data.get('ext', 'png')}", data["image"])
    finally:
        document.close()
    if not count:
        raise HTTPException(404, "该 PDF 中没有内嵌图片")
    return archive


# ---------- page rendering, organizer and split ----------

@router.post("/pdf/render")
async def pdf_render(file: UploadFile = File(...), pages: str = Form(""), scale: float = Form(0.3)):
    job = new_job()
    source = save_upload(file, job, "source", {".pdf"})
    document = open_pdf(source)
    try:
        targets = selected_pdf_pages(pages, len(document))
        if len(targets) > 400:
            raise HTTPException(400, "页面过多，一次最多预览 400 页")
        zoom = max(0.1, min(3.0, scale))
        rendered = []
        for index in targets:
            page = document[index]
            pixmap = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            rendered.append({
                "index": index, "width": page.rect.width, "height": page.rect.height,
                "image": "data:image/jpeg;base64," + base64.b64encode(pixmap.tobytes("jpeg", jpg_quality=82)).decode(),
            })
        return {"count": len(document), "pages": rendered}
    finally:
        document.close()


@router.post("/pdf/organize")
async def pdf_organize(file: UploadFile = File(...), plan: str = Form(...)):
    """plan: [{"src": page index or null for a blank page, "rotate": degrees}]"""
    items = parse_json(plan, "页面顺序")
    if not isinstance(items, list) or not items:
        raise HTTPException(400, "至少需要保留一页")
    job = new_job()
    source = save_upload(file, job, "source", {".pdf"})
    document = open_pdf(source)
    output = job / "organized.pdf"
    result = fitz.open()
    try:
        for item in items:
            src = item.get("src") if isinstance(item, dict) else None
            if src is None:
                size = document[0].rect
                result.new_page(width=size.width, height=size.height)
            else:
                if not isinstance(src, int) or not 0 <= src < len(document):
                    raise HTTPException(400, "页面序号超出范围")
                result.insert_pdf(document, from_page=src, to_page=src)
            rotate = int(item.get("rotate", 0)) % 360 if isinstance(item, dict) else 0
            if rotate not in {0, 90, 180, 270}:
                raise HTTPException(400, "旋转角度只能是 90 的倍数")
            page = result[-1]
            page.set_rotation((page.rotation + rotate) % 360)
        result.save(output, garbage=3, deflate=True)
    finally:
        result.close()
        document.close()
    return FileResponse(output, filename="organized.pdf")


@router.post("/pdf/split")
async def pdf_split(file: UploadFile = File(...), mode: str = Form("each"), ranges: str = Form("")):
    job = new_job()
    source = save_upload(file, job, "source", {".pdf"})
    document = open_pdf(source)
    archive = job / "split.zip"
    try:
        count = len(document)
        if mode == "each":
            groups = [(i, i) for i in range(count)]
        else:
            groups = []
            for part in re.split(r"[,，;；\s]+", normalize_form_text(ranges).strip()):
                if not part:
                    continue
                match = re.fullmatch(r"(\d+)(?:[-~–](\d+))?", part)
                if not match:
                    raise HTTPException(400, f"范围格式不正确：{part}（示例：1-3,4-6,7）")
                start, end = int(match[1]), int(match[2] or match[1])
                if not 1 <= start <= end <= count:
                    raise HTTPException(400, f"范围超出页数：{part}（共 {count} 页）")
                groups.append((start - 1, end - 1))
            if not groups:
                raise HTTPException(400, "请填写拆分范围，例如 1-3,4-6")
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for start, end in groups:
                part = fitz.open()
                part.insert_pdf(document, from_page=start, to_page=end)
                name = f"第{start + 1}页.pdf" if start == end else f"第{start + 1}-{end + 1}页.pdf"
                bundle.writestr(name, part.tobytes(garbage=3, deflate=True))
                part.close()
    finally:
        document.close()
    return FileResponse(archive, filename="split.zip")


# ---------- annotations ----------

def color_of(name: Any) -> tuple[float, float, float]:
    return COLORS.get(str(name), COLORS["yellow"])


def word_rects(page: fitz.Page, rect: fitz.Rect) -> list[fitz.Rect]:
    words = [fitz.Rect(w[:4]) for w in page.get_text("words", clip=rect)]
    return words or [rect]


@router.post("/annotate/apply")
async def annotate_apply(file: UploadFile = File(...), ops: str = Form(...)):
    """ops: [{type, page, rect?[x0,y0,x1,y1], points?[[x,y]..], text?, content?, color?, category?, status?}]
    Coordinates are PDF points on the unrotated page."""
    operations = parse_json(ops, "批注")
    if not isinstance(operations, list) or not operations:
        raise HTTPException(400, "没有需要添加的批注")
    job = new_job()
    source = save_upload(file, job, "source", {".pdf"})
    document = open_pdf(source)
    output = job / "annotated.pdf"
    added = 0
    try:
        for op in operations:
            kind = op.get("type")
            pages = range(len(document)) if op.get("page", 0) == -1 else [int(op.get("page", 0))]
            for index in pages:
                if not 0 <= index < len(document):
                    raise HTTPException(400, "批注页码超出范围")
                page = document[index]
                annots = []
                if kind in {"highlight", "underline", "strike", "squiggly"}:
                    if op.get("text"):
                        targets = page.search_for(normalize_form_text(op["text"]))
                    elif op.get("rect"):
                        targets = word_rects(page, fitz.Rect(op["rect"]))
                    else:
                        targets = []
                    if targets:
                        add = {"highlight": page.add_highlight_annot, "underline": page.add_underline_annot,
                               "strike": page.add_strikeout_annot, "squiggly": page.add_squiggly_annot}[kind]
                        annots.append(add(targets))
                elif kind == "note":
                    x0, y0 = (op.get("rect") or [36, 36])[:2]
                    annots.append(page.add_text_annot(fitz.Point(x0, y0), str(op.get("content") or "批注"), icon="Comment"))
                elif kind == "ink" and op.get("points"):
                    annots.append(page.add_ink_annot([[tuple(p) for p in op["points"]]]))
                elif kind in {"rect", "circle"} and op.get("rect"):
                    add = page.add_rect_annot if kind == "rect" else page.add_circle_annot
                    annots.append(add(fitz.Rect(op["rect"])))
                elif kind:
                    if kind not in {"highlight", "underline", "strike", "squiggly", "note", "ink", "rect", "circle"}:
                        raise HTTPException(400, f"未知批注类型：{kind}")
                for annot in annots:
                    color = color_of(op.get("color"))
                    if kind in {"ink", "rect", "circle"}:
                        annot.set_border(width=float(op.get("width", 2)))
                    annot.set_colors(stroke=color)
                    annot.set_info(
                        content=str(op.get("content") or annot.info.get("content") or ""),
                        title=STATUS_PREFIX + str(op.get("status") or "待处理"),
                        subject=str(op.get("category") or "未分类"),
                    )
                    annot.update(opacity=0.45 if kind == "highlight" else 1)
                    added += 1
        if not added:
            raise HTTPException(404, "没有生成任何批注：搜索的文字不存在，或框选区域为空")
        document.save(output, garbage=3, deflate=True)
    finally:
        document.close()
    response = FileResponse(output, filename="annotated.pdf")
    response.headers["X-PaperDock-Added"] = str(added)
    return response


def describe_annot(page_index: int, annot: fitz.Annot) -> dict[str, Any]:
    info = annot.info
    title = info.get("title") or ""
    return {
        "page": page_index, "xref": annot.xref, "type": annot.type[1],
        "content": info.get("content") or "",
        "category": info.get("subject") or "未分类",
        "status": title[len(STATUS_PREFIX):] if title.startswith(STATUS_PREFIX) else "待处理",
        "author": "" if title.startswith(STATUS_PREFIX) else title,
        "rect": list(annot.rect),
    }


@router.post("/annotate/list")
async def annotate_list(file: UploadFile = File(...)):
    job = new_job()
    document = open_pdf(save_upload(file, job, "source", {".pdf"}))
    try:
        items = [describe_annot(i, a) for i, page in enumerate(document) for a in page.annots() if a.type[0] != fitz.PDF_ANNOT_WIDGET]
    finally:
        document.close()
    shutil.rmtree(job, ignore_errors=True)
    return {"annotations": items}


@router.post("/annotate/update")
async def annotate_update(file: UploadFile = File(...), updates: str = Form(...)):
    changes = parse_json(updates, "批注修改")
    job = new_job()
    document = open_pdf(save_upload(file, job, "source", {".pdf"}))
    output = job / "annotated.pdf"
    try:
        for change in changes if isinstance(changes, list) else []:
            page = document[int(change["page"])]
            annot = page.load_annot(int(change["xref"]))
            if annot is None:
                raise HTTPException(404, "批注不存在，可能已被删除")
            if change.get("delete"):
                page.delete_annot(annot)
                continue
            info = annot.info
            status = change.get("status")
            annot.set_info(
                content=str(change.get("content", info.get("content") or "")),
                title=STATUS_PREFIX + status if status else info.get("title") or "",
                subject=str(change.get("category") or info.get("subject") or "未分类"),
            )
            annot.update()
        document.save(output, garbage=3, deflate=True)
    finally:
        document.close()
    return FileResponse(output, filename="annotated.pdf")


# ---------- signatures ----------

@router.post("/pdf/sign")
async def pdf_sign(file: UploadFile = File(...), signature: UploadFile = File(...), page: int = Form(0), rect: str = Form(...), date_text: str = Form("")):
    area = parse_json(rect, "签名位置")
    job = new_job()
    source = save_upload(file, job, "source", {".pdf"})
    image = save_upload(signature, job, "signature", {".png", ".jpg", ".jpeg"})
    document = open_pdf(source)
    output = job / "signed.pdf"
    try:
        if not 0 <= page < len(document):
            raise HTTPException(400, "签名页码超出范围")
        target = document[page]
        box = fitz.Rect(area)
        if box.width < 10 or box.height < 5:
            raise HTTPException(400, "签名区域太小，请拖出更大的框")
        target.insert_image(box, filename=str(image), keep_proportion=True, overlay=True)
        date_text = normalize_form_text(date_text).strip()
        if date_text:
            target.insert_text(fitz.Point(box.x0, box.y1 + 12), date_text, fontsize=10, fontname="china-s", color=(0.2, 0.2, 0.2))
        document.save(output, garbage=3, deflate=True)
    finally:
        document.close()
    return FileResponse(output, filename="signed.pdf")


# ---------- forms ----------

WIDGET_TYPES = {
    fitz.PDF_WIDGET_TYPE_TEXT: "text", fitz.PDF_WIDGET_TYPE_CHECKBOX: "checkbox",
    fitz.PDF_WIDGET_TYPE_RADIOBUTTON: "radio", fitz.PDF_WIDGET_TYPE_COMBOBOX: "combo",
    fitz.PDF_WIDGET_TYPE_LISTBOX: "list", fitz.PDF_WIDGET_TYPE_SIGNATURE: "signature",
    fitz.PDF_WIDGET_TYPE_BUTTON: "button",
}


@router.post("/forms/fields")
async def form_fields(file: UploadFile = File(...)):
    job = new_job()
    document = open_pdf(save_upload(file, job, "source", {".pdf"}))
    fields = []
    try:
        for index, page in enumerate(document):
            for widget in page.widgets():
                kind = WIDGET_TYPES.get(widget.field_type, "other")
                if kind in {"button", "signature"}:
                    continue
                fields.append({
                    "page": index, "xref": widget.xref, "name": widget.field_name or f"字段{len(fields) + 1}",
                    "label": widget.field_label or "", "type": kind, "value": widget.field_value,
                    "options": list(widget.choice_values or []) if kind in {"combo", "list"} else [],
                    "on": widget.on_state() if kind in {"checkbox", "radio"} else None,
                })
    finally:
        document.close()
    shutil.rmtree(job, ignore_errors=True)
    return {"fields": fields}


@router.post("/forms/fill")
async def form_fill(file: UploadFile = File(...), values: str = Form(...), flatten: bool = Form(False)):
    """values: {"<page>:<xref>": value}; checkbox/radio values are booleans."""
    entries = parse_json(values, "表单内容")
    job = new_job()
    document = open_pdf(save_upload(file, job, "source", {".pdf"}))
    output = job / "filled.pdf"
    filled = 0
    try:
        for index, page in enumerate(document):
            for widget in page.widgets():
                key = f"{index}:{widget.xref}"
                if key not in entries:
                    continue
                value = entries[key]
                if widget.field_type in {fitz.PDF_WIDGET_TYPE_CHECKBOX, fitz.PDF_WIDGET_TYPE_RADIOBUTTON}:
                    widget.field_value = widget.on_state() if value else "Off"
                else:
                    widget.field_value = str(value)
                    if CJK.search(str(value)):
                        widget.text_font = "china-s"
                widget.update()
                filled += 1
        if flatten:
            document.bake()
        document.save(output, garbage=3, deflate=True)
    finally:
        document.close()
    response = FileResponse(output, filename="filled.pdf")
    response.headers["X-PaperDock-Filled"] = str(filled)
    return response


# ---------- compare ----------

def tokens_of(source: Path, job: Path, language: str) -> tuple[list[dict[str, Any]], bool]:
    """Word tokens (CJK split per character). Returns (tokens, has_positions)."""
    suffix = source.suffix.lower()
    tokens: list[dict[str, Any]] = []

    def add_text(text: str, page: int) -> None:
        for piece in re.findall(r"[\u3400-\u9fff]|[^\s\u3400-\u9fff]+", text):
            tokens.append({"t": piece, "p": page, "r": None})

    if suffix == ".pdf":
        document = open_pdf(source)
        try:
            positioned = True
            for index, page in enumerate(document):
                if page_needs_ocr(page):
                    positioned = False
                    lines, _ = ocr_image(render_page(page, job / f"cmp-{uuid.uuid4().hex[:6]}.png"), language)
                    add_text("\n".join(line["text"] for line in lines), index)
                    continue
                for x0, y0, x1, y1, word, *_ in page.get_text("words", sort=True):
                    if CJK.search(word):
                        step = (x1 - x0) / max(1, len(word))
                        for k, char in enumerate(word):
                            tokens.append({"t": char, "p": index, "r": (x0 + k * step, y0, x0 + (k + 1) * step, y1)})
                    else:
                        tokens.append({"t": word, "p": index, "r": (x0, y0, x1, y1)})
            return tokens, positioned
        finally:
            document.close()
    if suffix == ".docx":
        add_text("\n".join(p.text for p in Document(str(source)).paragraphs), 0)
    elif suffix in {".txt", ".md"}:
        add_text(source.read_text(encoding="utf-8", errors="replace"), 0)
    elif suffix in IMAGE_TYPES:
        lines, _ = ocr_image(source, language)
        add_text("\n".join(line["text"] for line in lines), 0)
    else:
        raise HTTPException(415, "对比支持 PDF、Word(.docx)、TXT 和图片")
    return tokens, False


def joined(tokens: list[dict[str, Any]]) -> str:
    out = ""
    for token in tokens:
        if out and not (CJK.search(out[-1]) or CJK.search(token["t"][0])):
            out += " "
        out += token["t"]
    return out


def compare_report(path_a: Path, path_b: Path, marks_a: list, marks_b: list, output: Path) -> None:
    """Side-by-side PDF: old on the left with deletions in red, new on the right with insertions in green."""
    docs = []
    for path, marks, color in ((path_a, marks_a, (0.95, 0.3, 0.3)), (path_b, marks_b, (0.25, 0.8, 0.4))):
        document = fitz.open(path)
        for page_index, rect in marks:
            document[page_index].draw_rect(fitz.Rect(rect), color=None, fill=color, fill_opacity=0.35, overlay=True)
        docs.append(fitz.open("pdf", document.tobytes()))
        document.close()
    left, right = docs
    report = fitz.open()
    try:
        for index in range(max(len(left), len(right))):
            wa = left[index].rect if index < len(left) else fitz.Rect(0, 0, 0, 0)
            wb = right[index].rect if index < len(right) else fitz.Rect(0, 0, 0, 0)
            gap = 24
            page = report.new_page(width=wa.width + wb.width + gap, height=max(wa.height, wb.height))
            if index < len(left):
                page.show_pdf_page(fitz.Rect(0, 0, wa.width, wa.height), left, index)
            if index < len(right):
                page.show_pdf_page(fitz.Rect(wa.width + gap, 0, wa.width + gap + wb.width, wb.height), right, index)
            page.draw_line(fitz.Point(wa.width + gap / 2, 0), fitz.Point(wa.width + gap / 2, page.rect.height), color=(0.75, 0.75, 0.75))
        report.save(output, garbage=3, deflate=True)
    finally:
        report.close()
        left.close()
        right.close()


@router.post("/compare")
async def compare_documents(file_a: UploadFile = File(...), file_b: UploadFile = File(...), language: str = Form("ch")):
    job = new_job()
    allowed = {".pdf", ".docx", ".txt", ".md", *IMAGE_TYPES}
    path_a = save_upload(file_a, job, "old", allowed)
    path_b = save_upload(file_b, job, "new", allowed)
    tokens_a, pos_a = tokens_of(path_a, job, language)
    tokens_b, pos_b = tokens_of(path_b, job, language)
    if len(tokens_a) + len(tokens_b) > 400_000:
        raise HTTPException(400, "文档过大，单次对比请控制在约 20 万字以内")
    matcher = difflib.SequenceMatcher(None, [t["t"] for t in tokens_a], [t["t"] for t in tokens_b], autojunk=False)
    changes = []
    marks_a: list = []
    marks_b: list = []
    stats = {"insert": 0, "delete": 0, "replace": 0}
    for tag, a0, a1, b0, b1 in matcher.get_opcodes():
        if tag == "equal":
            continue
        stats[tag] += 1
        old, new = tokens_a[a0:a1], tokens_b[b0:b1]
        marks_a.extend((t["p"], t["r"]) for t in old if t["r"])
        marks_b.extend((t["p"], t["r"]) for t in new if t["r"])
        if len(changes) < 500:
            changes.append({
                "type": tag, "old": joined(old)[:300], "new": joined(new)[:300],
                "page_old": old[0]["p"] + 1 if old else None, "page_new": new[0]["p"] + 1 if new else None,
                "context": joined(tokens_a[max(0, a0 - 8):a0])[-40:],
            })
    report = None
    if path_a.suffix.lower() == ".pdf" and path_b.suffix.lower() == ".pdf" and (pos_a or pos_b):
        compare_report(path_a, path_b, marks_a, marks_b, job / "compare-report.pdf")
        report = "compare-report.pdf"
    return {
        "job_id": job.name, "similarity": round(matcher.ratio() * 100, 1), "stats": stats,
        "changes": changes, "truncated": sum(stats.values()) > len(changes), "report": report,
    }


@router.get("/jobfile/{job_id}/{name}")
def job_file(job_id: str, name: str):
    if not re.fullmatch(r"[0-9a-f]{32}", job_id) or "/" in name or "\\" in name or name.startswith("."):
        raise HTTPException(404, "文件不存在")
    path = JOBS / job_id / name
    if not path.is_file():
        raise HTTPException(404, "文件已过期，请重新生成")
    return FileResponse(path, filename=name)


# ---------- repair ----------

@router.post("/pdf/repair")
async def pdf_repair(file: UploadFile = File(...)):
    job = new_job()
    source = save_upload(file, job, "source", {".pdf"})
    output = job / "repaired.pdf"
    method = ""
    try:
        with fitz.open(source) as document:
            if document.needs_pass:
                raise HTTPException(400, "该 PDF 有打开密码，请先移除密码再修复")
            if not len(document):
                raise ValueError("no pages")
            document.save(output, garbage=4, deflate=True, clean=True)
            method = "pymupdf"
    except HTTPException:
        raise
    except Exception:
        try:
            import pikepdf

            with pikepdf.open(source, attempt_recovery=True) as pdf:
                pdf.save(output)
            method = "qpdf"
        except Exception as error:
            raise HTTPException(422, "文件损坏过于严重，两种修复引擎都无法恢复") from error
    with fitz.open(output) as check:
        pages = len(check)
    response = FileResponse(output, filename="repaired.pdf")
    response.headers["X-PaperDock-Repair"] = f"{method}|{pages}"
    return response


# ---------- screenshot ----------

@router.post("/capture/snip")
def capture_snip(timeout: int = Form(45)):
    """Open the Windows snipping overlay and return the next clipboard image."""
    if os.name != "nt":
        raise HTTPException(501, "截图仅支持 Windows")
    from PIL import ImageGrab

    def fingerprint() -> str | None:
        try:
            image = ImageGrab.grabclipboard()
        except Exception:
            return None
        return hashlib.md5(image.tobytes()).hexdigest() if hasattr(image, "tobytes") else None

    before = fingerprint()
    os.startfile("ms-screenclip:")
    deadline = time.time() + max(5, min(120, timeout))
    while time.time() < deadline:
        time.sleep(0.5)
        image = None
        try:
            image = ImageGrab.grabclipboard()
        except Exception:
            pass
        if hasattr(image, "tobytes") and hashlib.md5(image.tobytes()).hexdigest() != before:
            job = new_job()
            path = job / "screenshot.png"
            image.save(path)
            return FileResponse(path, filename="screenshot.png")
    raise HTTPException(408, "没有等到新的截图，已取消")
