"""End-to-end checks for backend/tools.py. Run: .venv\\Scripts\\python scripts\\test-tools.py [--ocr]

Builds sample PDFs in a temp folder, calls every endpoint through FastAPI's
TestClient and verifies the produced files. --ocr also runs the scanned-document
paths with the local PaddleOCR models (slow).
"""
from __future__ import annotations

import io
import json
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fitz  # noqa: E402
from docx import Document  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from openpyxl import load_workbook  # noqa: E402

from backend.app import app  # noqa: E402

client = TestClient(app)
work = Path(tempfile.mkdtemp(prefix="paperdock-test-"))
results: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, bool(condition), detail))
    print(("PASS " if condition else "FAIL ") + name + (f" — {detail}" if detail else ""))


def post(url: str, files: dict | list, data: dict | None = None):
    return client.post(url, files=files, data=data or {})


def pdf_file(path: Path, name: str | None = None):
    return (name or path.name, path.read_bytes(), "application/pdf")


def converted_text(path: Path, target: str) -> tuple[int, str]:
    response = post("/convert", {"files": pdf_file(path)}, {"target": target})
    if response.status_code != 200 or target == "txt":
        return response.status_code, response.text
    workbook = load_workbook(io.BytesIO(response.content), read_only=True)
    try:
        return response.status_code, "\n".join(str(value) for row in workbook.active.values for value in row if value is not None)
    finally:
        workbook.close()


def build_samples() -> dict[str, Path]:
    font = dict(fontname="china-s")
    # Two-column article with header/footer and an image.
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 30), "页眉：能源与动力工程课程笔记", fontsize=9, **font)
    left = "\n".join(f"左栏第{i}行：热力学第一定律" for i in range(1, 16))
    right = "\n".join(f"右栏第{i}行：传热学基础知识" for i in range(1, 16))
    page.insert_textbox(fitz.Rect(50, 80, 290, 700), left, fontsize=11, **font)
    page.insert_textbox(fitz.Rect(320, 80, 560, 700), right, fontsize=11, **font)
    page.insert_text((280, 820), "第 1 页", fontsize=9, **font)
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 80, 80), False)
    pix.set_rect(pix.irect, (30, 120, 220))
    page.insert_image(fitz.Rect(400, 720, 480, 800), pixmap=pix)
    columns = work / "columns.pdf"
    doc.save(columns)

    # Ruled table.
    doc = fitz.open()
    page = doc.new_page()
    rows = [["工况", "温度/℃", "压力/MPa"], ["A", "120", "0.5"], ["B", "135", "0.8"], ["C", "150", "1.1"]]
    x0, y0, cw, rh = 80, 100, 140, 36
    for r in range(len(rows) + 1):
        page.draw_line((x0, y0 + r * rh), (x0 + cw * 3, y0 + r * rh), width=1.2)
    for c in range(4):
        page.draw_line((x0 + c * cw, y0), (x0 + c * cw, y0 + rh * len(rows)), width=1.2)
    for r, row in enumerate(rows):
        for c, value in enumerate(row):
            page.insert_text((x0 + c * cw + 12, y0 + r * rh + 24), value, fontsize=14, **font)
    table = work / "table.pdf"
    doc.save(table)
    # Scanned (image-only) copy of the table.
    scan = fitz.open()
    image = doc[0].get_pixmap(matrix=fitz.Matrix(2, 2))
    scan.new_page(width=595, height=842).insert_image(fitz.Rect(0, 0, 595, 842), pixmap=image)
    scanned_table = work / "table-scan.pdf"
    scan.save(scanned_table)

    # Form with text and checkbox.
    doc = fitz.open()
    page = doc.new_page()
    for kind, name, rect in ((fitz.PDF_WIDGET_TYPE_TEXT, "姓名", (100, 100, 300, 125)), (fitz.PDF_WIDGET_TYPE_CHECKBOX, "已完成", (100, 150, 115, 165))):
        widget = fitz.Widget()
        widget.field_type, widget.field_name, widget.rect = kind, name, fitz.Rect(rect)
        page.add_widget(widget)
    form = work / "form.pdf"
    doc.save(form)

    # Multi-page document and a revised copy.
    doc = fitz.open()
    for n in range(1, 5):
        doc.new_page().insert_text((72, 100), f"Page {n} original text 原始内容 {n}", fontsize=14, **font)
    multi = work / "multi.pdf"
    doc.save(multi)
    doc = fitz.open(multi)
    doc[1].add_redact_annot(doc[1].search_for("original")[0])
    doc[1].apply_redactions()
    doc[1].insert_text((72, 140), "Page 2 revised 新增内容", fontsize=14, **font)
    revised = work / "revised.pdf"
    doc.save(revised)

    broken = work / "broken.pdf"
    data = multi.read_bytes()
    broken.write_bytes(data[: data.rfind(b"xref")] + b"\n%%EOF")  # drop xref table
    return {"columns": columns, "table": table, "scan": scanned_table, "form": form, "multi": multi, "revised": revised, "broken": broken}


def main(run_ocr: bool) -> int:
    s = build_samples()

    for target in ("txt", "xlsx"):
        status, text = converted_text(s["multi"], target)
        check(f"native PDF → {target}", status == 200 and "Page 1 original text" in text)

    r = post("/pdf/render", {"file": pdf_file(s["multi"])}, {"scale": "0.2"})
    check("render thumbnails", r.status_code == 200 and r.json()["count"] == 4 and r.json()["pages"][0]["image"].startswith("data:image/jpeg"))

    plan = [{"src": 3, "rotate": 0}, {"src": 0, "rotate": 90}, {"src": None, "rotate": 0}]
    r = post("/pdf/organize", {"file": pdf_file(s["multi"])}, {"plan": json.dumps(plan)})
    out = fitz.open("pdf", r.content) if r.status_code == 200 else None
    check("organize reorder/rotate/blank", out is not None and len(out) == 3 and "Page 4" in out[0].get_text() and out[1].rotation == 90 and not out[2].get_text().strip())

    r = post("/pdf/split", {"file": pdf_file(s["multi"])}, {"mode": "ranges", "ranges": "1-2，3,4"})
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist() if r.status_code == 200 else []
    check("split ranges", len(names) == 3, ", ".join(names))

    r = post("/tables/extract", {"files": pdf_file(s["table"])})
    if r.status_code == 200:
        sheet = load_workbook(io.BytesIO(r.content)).worksheets[0]
        values = [[c.value for c in row] for row in sheet.iter_rows()]
    else:
        values = r.text
    check("native table → Excel cells", r.status_code == 200 and values[0] == ["工况", "温度/℃", "压力/MPa"] and values[3][2] == "1.1", str(values)[:120])

    r = post("/convert/extra", {"file": pdf_file(s["columns"])}, {"target": "layout-docx"})
    docx = Document(io.BytesIO(r.content)) if r.status_code == 200 else None
    paras = [p.text for p in docx.paragraphs if p.text] if docx else []
    left_last = next((i for i, p in enumerate(paras) if "左栏第15行" in p), -1)
    right_first = next((i for i, p in enumerate(paras) if "右栏第1行" in p), -1)
    check("layout: two columns read in order", 0 <= left_last < right_first, f"paras={len(paras)}")
    check("layout: header to Word header", docx is not None and "页眉" in docx.sections[0].header.paragraphs[0].text)
    check("layout: image kept", docx is not None and len(docx.inline_shapes) == 1)

    for target, test in (("md", lambda b: "左栏第1行" in b.decode()), ("odt", lambda b: b[:2] == b"PK"), ("epub", lambda b: b[:2] == b"PK"), ("pptx", lambda b: b[:2] == b"PK"), ("embedded-images", lambda b: len(zipfile.ZipFile(io.BytesIO(b)).namelist()) == 1)):
        r = post("/convert/extra", {"file": pdf_file(s["columns"])}, {"target": target})
        check(f"export {target}", r.status_code == 200 and test(r.content), r.text[:120] if r.status_code != 200 else "")
    from pptx import Presentation
    r = post("/convert/extra", {"file": pdf_file(s["multi"])}, {"target": "pptx"})
    check("pptx slides = pages", len(Presentation(io.BytesIO(r.content)).slides) == 4)

    ops = [
        {"type": "highlight", "page": -1, "text": "original", "color": "yellow", "category": "术语", "status": "待处理"},
        {"type": "underline", "page": 0, "rect": [60, 80, 400, 110], "color": "blue"},
        {"type": "note", "page": 1, "rect": [300, 300], "content": "这里需要核对", "category": "疑问"},
        {"type": "ink", "page": 2, "points": [[100, 100], [150, 140], [200, 110]], "color": "red"},
        {"type": "rect", "page": 3, "rect": [50, 50, 200, 120], "color": "green"},
    ]
    r = post("/annotate/apply", {"file": pdf_file(s["multi"])}, {"ops": json.dumps(ops)})
    annotated = work / "annotated.pdf"
    annotated.write_bytes(r.content)
    check("annotations added", r.status_code == 200 and int(r.headers.get("X-PaperDock-Added", 0)) >= 7, r.headers.get("X-PaperDock-Added", r.text[:100]))
    r = post("/annotate/list", {"file": pdf_file(annotated)})
    items = r.json().get("annotations", []) if r.status_code == 200 else []
    check("annotation list with category/status", any(a["category"] == "疑问" and a["content"] == "这里需要核对" for a in items) and all(a["status"] == "待处理" for a in items), f"{len(items)} items")
    target = next(a for a in items if a["category"] == "疑问")
    first = items[0]
    r = post("/annotate/update", {"file": pdf_file(annotated)}, {"updates": json.dumps([{"page": target["page"], "xref": target["xref"], "status": "已处理"}, {"page": first["page"], "xref": first["xref"], "delete": True}])})
    updated = work / "updated.pdf"
    updated.write_bytes(r.content)
    after = post("/annotate/list", {"file": pdf_file(updated)}).json()["annotations"]
    check("annotation status update + delete", len(after) == len(items) - 1 and any(a["status"] == "已处理" for a in after))

    signature = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 120, 40), False)
    signature.set_rect(signature.irect, (20, 20, 160))
    r = post("/pdf/sign", {"file": pdf_file(s["multi"]), "signature": ("sig.png", signature.tobytes("png"), "image/png")}, {"page": "1", "rect": "[300, 600, 460, 660]", "date_text": "2026-11-03"})
    signed = fitz.open("pdf", r.content) if r.status_code == 200 else None
    check("signature image + date", signed is not None and len(signed[1].get_images()) == 1 and "2026-11-03" in signed[1].get_text())

    r = post("/forms/fields", {"file": pdf_file(s["form"])})
    fields = r.json().get("fields", [])
    check("form fields listed", {f["type"] for f in fields} == {"text", "checkbox"}, str([f["name"] for f in fields]))
    values = {f"{f['page']}:{f['xref']}": ("张同学" if f["type"] == "text" else True) for f in fields}
    r = post("/forms/fill", {"file": pdf_file(s["form"])}, {"values": json.dumps(values, ensure_ascii=False)})
    filled = fitz.open("pdf", r.content)
    got = {w.field_name: w.field_value for w in filled[0].widgets()}
    check("form filled", got.get("姓名") == "张同学" and got.get("已完成") not in (None, "Off", False), str(got))
    r = post("/forms/fill", {"file": pdf_file(s["form"])}, {"values": json.dumps(values, ensure_ascii=False), "flatten": "true"})
    flat = fitz.open("pdf", r.content)
    check("form flatten", not list(flat[0].widgets()) and "张同学" in flat[0].get_text())

    r = post("/compare", {"file_a": pdf_file(s["multi"]), "file_b": pdf_file(s["revised"])})
    body = r.json()
    check("compare finds change on page 2", r.status_code == 200 and any(c["page_new"] == 2 for c in body["changes"]) and body["similarity"] < 100, json.dumps(body.get("stats")))
    report = client.get(f"/jobfile/{body['job_id']}/{body['report']}")
    check("compare side-by-side report", report.status_code == 200 and len(fitz.open("pdf", report.content)) == 4)

    r = post("/pdf/repair", {"file": pdf_file(s["broken"])})
    check("repair broken xref", r.status_code == 200 and len(fitz.open("pdf", r.content)) == 4, r.headers.get("X-PaperDock-Repair", r.text[:100]))

    if run_ocr:
        mixed = work / "mixed.pdf"
        blank = work / "blank.pdf"
        with fitz.open() as document, fitz.open(s["multi"]) as native, fitz.open(s["scan"]) as scanned:
            document.insert_pdf(native, from_page=0, to_page=0)
            document.insert_pdf(scanned)
            document.save(mixed)
        with fitz.open() as document:
            document.new_page()
            document.save(blank)
        for target in ("txt", "xlsx"):
            status, text = converted_text(mixed, target)
            check(f"mixed PDF → {target} preserves native and scanned text",
                  status == 200 and 0 <= text.find("Page 1 original text") < text.find("135"))
            status, _ = converted_text(blank, target)
            check(f"blank PDF → {target} rejects empty output", status == 422)

        r = post("/tables/extract", {"files": pdf_file(s["scan"])})
        values = [[c.value for c in row] for row in load_workbook(io.BytesIO(r.content)).worksheets[0].iter_rows()] if r.status_code == 200 else r.text
        check("scanned table → Excel cells (OCR)", r.status_code == 200 and len(values) == 4 and len(values[0]) == 3 and values[2][1] == "135", str(values)[:160])
        scan_cols = work / "columns-scan.pdf"
        src = fitz.open(s["columns"])
        out = fitz.open()
        out.new_page(width=595, height=842).insert_image(fitz.Rect(0, 0, 595, 842), pixmap=src[0].get_pixmap(matrix=fitz.Matrix(2, 2)))
        out.save(scan_cols)
        r = post("/convert/extra", {"file": pdf_file(scan_cols)}, {"target": "md"})
        text = r.text if r.status_code == 200 else ""
        check("scanned layout: columns in order (OCR)", 0 <= text.find("左栏第15行") < text.find("右栏第1行"), text[:80].replace("\n", " "))

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed" + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main("--ocr" in sys.argv))
