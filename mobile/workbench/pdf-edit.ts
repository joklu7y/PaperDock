// SPDX-License-Identifier: AGPL-3.0-only
import { Font, Image, Matrix, type PDFAnnotationType, type PDFDocument, type PDFPage, type Point, type Quad, type Rect } from 'mupdf';
import { bytesOf, fileResponse, formFile, formText, withPdf } from './pdf';
import { jsonResponse } from './response';

const MARKS: Record<string, PDFAnnotationType> = {
  highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut', squiggly: 'Squiggly',
};
const COLORS: Record<string, [number, number, number]> = {
  yellow: [1, 0.83, 0.1], red: [0.83, 0.16, 0.2], green: [0.16, 0.66, 0.35], blue: [0.13, 0.39, 0.83],
  purple: [0.55, 0.26, 0.75], black: [0.08, 0.08, 0.08],
};
const STATUS_PREFIX = '状态：';

type Operation = { type: string; page: number; rect?: Rect; points?: Point[]; text?: string; content?: string; color?: string; width?: number; category?: string; status?: string };
type Change = { page: number; xref: number; delete?: boolean; content?: string; category?: string; status?: string };
type ListedAnnotation = { page: number; xref: number; type: string; content: string; category: string; status: string; author: string; rect: Rect };
type ListedField = { page: number; xref: number; type: string; name: string; label: string; value: string; options: string[]; on: null };

function checkRect(rect: Rect): Rect {
  if (!Array.isArray(rect) || rect.length !== 4 || rect.some((value) => !Number.isFinite(value)) || rect[2] <= rect[0] || rect[3] <= rect[1]) {
    throw new Error('请在页面上框选有效区域。');
  }
  return rect;
}

function withPage<T>(doc: PDFDocument, index: number, action: (page: PDFPage) => T): T {
  if (!Number.isInteger(index) || index < 0 || index >= doc.countPages()) throw new Error('页码超出范围。');
  const page = doc.loadPage(index);
  try { return action(page); }
  finally { page.destroy(); }
}

function rectQuad([x0, y0, x1, y1]: Rect): Quad { return [x0, y0, x1, y0, x0, y1, x1, y1]; }

function addAnnotation(doc: PDFDocument, page: PDFPage, operation: Operation): boolean {
  const { type, rect, points, text } = operation;
  let annotation;
  if (Object.hasOwn(MARKS, type)) {
    const quads = text ? page.search(text, '').flat() : rect ? [rectQuad(checkRect(rect))] : [];
    if (!quads.length) return false;
    annotation = page.createAnnotation(MARKS[type]);
    annotation.setQuadPoints(quads);
    if (type === 'highlight') annotation.setOpacity(0.45);
  } else if (type === 'note') {
    const [x, y] = rect ?? [36, 36];
    annotation = page.createAnnotation('Text');
    annotation.setRect([x, y, x + 24, y + 24]);
    annotation.setIcon('Comment');
  } else if (type === 'ink' && points && points.length > 1) {
    annotation = page.createAnnotation('Ink');
    annotation.setInkList([points]);
    annotation.setBorderWidth(operation.width ?? 2);
  } else if ((type === 'rect' || type === 'circle') && rect) {
    annotation = page.createAnnotation(type === 'rect' ? 'Square' : 'Circle');
    annotation.setRect(checkRect(rect));
    annotation.setBorderWidth(operation.width ?? 2);
  } else throw new Error('批注内容不完整。');
  annotation.setColor(COLORS[operation.color ?? ''] ?? COLORS.yellow);
  annotation.setContents(operation.content ?? '');
  annotation.setAuthor(`${STATUS_PREFIX}${operation.status || '待处理'}`);
  annotation.getObject().put('Subj', doc.newString(operation.category || '未分类'));
  annotation.update();
  return true;
}

export async function editAnnotations(action: string, form: FormData): Promise<Response> {
  return withPdf(formFile(form), (doc) => {
    if (action === 'list') {
      const annotations: ListedAnnotation[] = [];
      for (let index = 0; index < doc.countPages(); index++) {
        withPage(doc, index, (page) => {
          for (const annotation of page.getAnnotations()) {
            const object = annotation.getObject();
            const author = annotation.getAuthor();
            const tagged = author.startsWith(STATUS_PREFIX);
            annotations.push({
              page: index, xref: object.asIndirect(), type: annotation.getType(), content: annotation.getContents(),
              category: object.get('Subj').asString() || '未分类', status: tagged ? author.slice(STATUS_PREFIX.length) : '待处理',
              author: tagged ? '' : author, rect: annotation.getRect(),
            });
          }
        });
      }
      return jsonResponse({ annotations });
    }
    let added = 0;
    if (action === 'apply') {
      const operations: Operation[] = JSON.parse(formText(form, 'ops'));
      if (!operations.length) throw new Error('请添加批注。');
      for (const operation of operations) {
        const pages = operation.page === -1 ? Array.from({ length: doc.countPages() }, (_, index) => index) : [operation.page];
        for (const index of pages) if (withPage(doc, index, (page) => addAnnotation(doc, page, operation))) added++;
      }
      if (!added) throw new Error('未找到需要批注的文字或区域。');
    } else if (action === 'update') {
      const changes: Change[] = JSON.parse(formText(form, 'updates'));
      for (const change of changes) {
        withPage(doc, change.page, (page) => {
          const annotation = page.getAnnotations().find((item) => item.getObject().asIndirect() === change.xref);
          if (!annotation) throw new Error('找不到该批注。');
          if (change.delete) { page.deleteAnnotation(annotation); return; }
          if (change.content !== undefined) annotation.setContents(change.content);
          if (change.category !== undefined) annotation.getObject().put('Subj', doc.newString(change.category));
          if (change.status) annotation.setAuthor(`${STATUS_PREFIX}${change.status}`);
          annotation.update();
        });
      }
    } else throw new Error('不支持的批注操作。');
    const response = fileResponse(bytesOf(doc), 'annotated.pdf');
    response.headers.set('X-PaperDock-Added', String(added));
    return response;
  });
}

export async function editForm(action: string, form: FormData): Promise<Response> {
  return withPdf(formFile(form), (doc) => {
    const fields: ListedField[] = [];
    const values: Record<string, string | boolean> = action === 'fill' ? JSON.parse(formText(form, 'values', '{}')) : {};
    let filled = 0;
    for (let index = 0; index < doc.countPages(); index++) {
      withPage(doc, index, (page) => {
        for (const widget of page.getWidgets()) {
          if (widget.isReadOnly() || !(widget.isText() || widget.isChoice() || widget.isCheckbox() || widget.isRadioButton())) continue;
          const xref = widget.getObject().asIndirect();
          const type = widget.isCheckbox() ? 'checkbox' : widget.isRadioButton() ? 'radio' : widget.isChoice() ? 'combo' : 'text';
          if (action === 'fields') {
            fields.push({ page: index, xref, type, name: widget.getName(), label: widget.getLabel(), value: widget.getValue(), options: widget.isChoice() ? widget.getOptions() : [], on: null });
            continue;
          }
          const value = values[`${index}:${xref}`];
          if (value === undefined) continue;
          if (widget.isText()) widget.setTextValue(String(value));
          else if (widget.isChoice()) widget.setChoiceValue(String(value));
          else {
            const state = widget.getObject().get('AS').asName();
            if (Boolean(state && state !== 'Off') !== Boolean(value)) widget.toggle();
          }
          widget.update();
          filled++;
        }
      });
    }
    if (action === 'fields') return jsonResponse({ fields });
    if (action !== 'fill') throw new Error('不支持的表单操作。');
    if (formText(form, 'flatten') === 'true') doc.bake(false, true);
    const response = fileResponse(bytesOf(doc), 'filled.pdf');
    response.headers.set('X-PaperDock-Filled', String(filled));
    return response;
  });
}

export async function signPdf(form: FormData): Promise<Response> {
  const signature = new Image(new Uint8Array(await formFile(form, 'signature').arrayBuffer()));
  try {
    return await withPdf(formFile(form), (doc) => {
      withPage(doc, Number(formText(form, 'page', '0')), (page) => {
        let [x0, y0, x1, y1] = checkRect(JSON.parse(formText(form, 'rect')));
        if (x1 - x0 < 10 || y1 - y0 < 5) throw new Error('签名区域太小。');
        const factor = Math.min((x1 - x0) / signature.getWidth(), (y1 - y0) / signature.getHeight());
        const width = signature.getWidth() * factor;
        const height = signature.getHeight() * factor;
        x0 += (x1 - x0 - width) / 2;
        y0 += (y1 - y0 - height) / 2;
        x1 = x0 + width;
        y1 = y0 + height;
        const stamp = page.createAnnotation('Stamp');
        stamp.setRect([x0, y0, x1, y1]);
        stamp.update();
        stamp.setAppearance('N', null, Matrix.identity, [0, 0, width, height], { XObject: { Signature: doc.addImage(signature) } },
          `q ${width} 0 0 ${height} 0 0 cm /Signature Do Q`);
        const date = formText(form, 'date_text').trim();
        if (date) {
          const safeDate = date.replace(/[^\x20-\x7e]/g, ' ').replace(/[()\\]/g, '\\$&');
          const caption = page.createAnnotation('FreeText');
          const captionWidth = Math.max(width, 90);
          caption.setRect([x0, y1, x0 + captionWidth, y1 + 14]);
          caption.setContents(date);
          caption.update();
          caption.setAppearance('N', null, Matrix.identity, [0, 0, captionWidth, 14], { Font: { Date: doc.addSimpleFont(new Font('Helvetica')) } },
            `BT /Date 9 Tf 0.2 g 0 3 Td (${safeDate}) Tj ET`);
        }
      });
      return fileResponse(bytesOf(doc), 'signed.pdf');
    });
  } finally { signature.destroy(); }
}
