// SPDX-License-Identifier: AGPL-3.0-only
import type { PDFPage } from 'mupdf';
import { Document, Footer, Header, ImageRun, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import { fileResponse, withPdf } from './pdf.ts';
import { recognizeOnPhone } from './native.ts';
import { MIME, renderPng } from './formats.ts';
import { pdfTextPositions, tableFromPositions } from './tables.ts';

type Position = { x: number; y: number; w: number; h: number };
type TextElement = Position & { type: 'text'; text: string; size: number };
type ImageElement = Position & { type: 'image'; png: Uint8Array<ArrayBuffer> };
type Element = TextElement | ImageElement;
type Layout = { width: number; height: number; elements: Element[]; tables: string[][][] };

async function inspect(page: PDFPage, language: string): Promise<Layout> {
  const [x0, y0, x1, y1] = page.getBounds();
  const width = x1 - x0;
  const height = y1 - y0;
  const structured = page.toStructuredText('preserve-images');
  const elements: Element[] = [];
  try {
    type Block = { type: string; lines?: { text: string; bbox: Position; font: { size: number } }[] };
    const { blocks } = JSON.parse(structured.asJSON()) as { blocks: Block[] };
    for (const block of blocks) {
      if (block.type !== 'text') continue;
      for (const line of block.lines ?? []) {
        if (line.text.trim()) elements.push({ type: 'text', ...line.bbox, text: line.text, size: line.font.size });
      }
    }
    const readable = elements.some((element) => element.type === 'text' && element.text.replace(/[□\ufffd\s]/g, '').length >= 2);
    if (!readable) {
      const { png } = renderPng(page);
      const { locations } = await recognizeOnPhone(new Blob([png], { type: 'image/png' }), 'page.png', language, true);
      for (const line of locations ?? []) {
        const [left, top, right, bottom] = line.box;
        elements.push({ type: 'text', text: line.text, size: (bottom - top) * height, x: left * width, y: top * height, w: (right - left) * width, h: (bottom - top) * height });
      }
      return { elements, width, height, tables: tableFromPositions(locations ?? []) };
    }
    structured.walk({ onImageBlock(bounds, _transform, image) {
      const [left, top, right, bottom] = bounds;
      if (right - left < 12 || bottom - top < 12 || image.getWidth() * image.getHeight() > 12_000_000) return;
      const pixmap = image.toPixmap();
      try { elements.push({ type: 'image', x: left, y: top, w: right - left, h: bottom - top, png: Uint8Array.from(pixmap.asPNG()) }); }
      finally { pixmap.destroy(); }
    } });
    const tables = tableFromPositions(pdfTextPositions(page)).filter((table) => table.length >= 2 && table.every((row) => row.every((cell) => cell.length <= 25))
      && table.slice(1).some((row) => row.slice(1).some((cell) => /^[-+]?\d+(?:[.,]\d+)?(?:\s|$)/.test(cell))));
    return { elements, width, height, tables };
  } finally { structured.destroy(); }
}

function readingOrder(elements: Element[], width: number) {
  const result: Element[] = [];
  const midpoint = width * 0.5;
  const byY = (a: Element, b: Element) => a.y - b.y || a.x - b.x;
  let band: Element[] = [];
  const flush = () => {
    const left = band.filter((item) => item.x < midpoint);
    const right = band.filter((item) => item.x >= midpoint);
    if (left.length >= 2 && right.length >= 2 && left.every((item) => item.x + item.w <= width * 0.61)) {
      result.push(...left.sort(byY), ...right.sort(byY));
    } else result.push(...band.sort(byY));
    band = [];
  };
  for (const element of [...elements].sort(byY)) {
    if (element.x < midpoint && element.x + element.w > width * 0.65) {
      flush();
      result.push(element);
    } else band.push(element);
  }
  flush();
  return result;
}

function repeating(pages: Layout[], bottom: boolean): Set<string> {
  const seen = new Map<string, number>();
  for (const page of pages) {
    const keys = new Set(page.elements.filter((item): item is TextElement => item.type === 'text' && (bottom ? item.y > page.height * 0.9 : item.y < page.height * 0.08)).map((item) => item.text.trim().replace(/\d+/g, '#')));
    for (const key of keys) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, count]) => count >= 2 && count >= pages.length * 0.6).map(([key]) => key));
}

const lineKey = (text: string) => text.trim().replace(/\d+/g, '#');

function markdownTable(rows: string[][]) {
  const pipe = (row: string[]) => `| ${row.map((value) => value.replaceAll('|', '\\|')).join(' | ')} |`;
  return [pipe(rows[0]), pipe(rows[0].map(() => '---')), ...rows.slice(1).map(pipe)].join('\n');
}

export async function restoreLayout(file: File, target: string, language: string, signal?: AbortSignal): Promise<Response> {
  const pages = file.name.toLowerCase().endsWith('.pdf') ? await withPdf(file, async (doc) => {
    const count = doc.countPages();
    if (!count || count > 30) throw new Error('手机端版面还原一次支持 1 到 30 页。');
    const layouts: Layout[] = [];
    for (let i = 0; i < count; i++) {
      signal?.throwIfAborted();
      const page = doc.loadPage(i);
      try { layouts.push(await inspect(page, language)); } finally { page.destroy(); }
    }
    return layouts;
  }) : await (async () => {
    const { locations } = await recognizeOnPhone(file, file.name, language, true);
    return [{ width: 1000, height: 1000, tables: tableFromPositions(locations ?? []), elements: (locations ?? []).map(({ text, box: [left, top, right, bottom] }): TextElement => ({
      type: 'text', text, size: (bottom - top) * 1000, x: left * 1000, y: top * 1000, w: (right - left) * 1000, h: (bottom - top) * 1000,
    })) }];
  })();
  if (!pages.some((page) => page.elements.length)) throw new Error('没有找到可还原的文字或图片。');
  const head = repeating(pages, false);
  const foot = repeating(pages, true);
  const content = pages.map((page) => {
    const headers: string[] = [];
    const footers: string[] = [];
    const cells = new Set(page.tables.flat(2).map((value) => value.trim()).filter(Boolean));
    const ordered = readingOrder(page.elements, page.width).filter((item) => {
      if (item.type === 'image') return true;
      if (item.y < page.height * 0.08 && head.has(lineKey(item.text))) { headers.push(item.text); return false; }
      if (item.y > page.height * 0.9 && foot.has(lineKey(item.text))) { footers.push(item.text); return false; }
      return !cells.has(item.text.trim());
    });
    return { headers, footers, ordered, tables: page.tables };
  });
  if (target === 'md') {
    const markdown = content.map((page, i) => [`## 第 ${i + 1} 页`, ...page.ordered.flatMap((item) => item.type === 'text' ? [item.text] : []), ...page.tables.map(markdownTable)].join('\n\n')).join('\n\n');
    return fileResponse(new Blob([markdown], { type: MIME.md }), 'document.md', MIME.md);
  }
  const sections = content.map((page) => ({
    headers: page.headers.length ? { default: new Header({ children: page.headers.map((value) => new Paragraph(value)) }) } : undefined,
    footers: page.footers.length ? { default: new Footer({ children: page.footers.map((value) => new Paragraph(value)) }) } : undefined,
    children: [
      ...page.ordered.map((item) => {
        if (item.type === 'text') return new Paragraph(item.text);
        const ratio = Math.min(590 / item.w, 650 / item.h, 1.3);
        return new Paragraph({ children: [new ImageRun({ data: item.png, type: 'png', transformation: { width: item.w * ratio, height: item.h * ratio } })] });
      }),
      ...page.tables.map((table) => new Table({ rows: table.map((row) => new TableRow({ children: row.map((value) => new TableCell({ children: [new Paragraph(value)] })) })) })),
    ],
  }));
  return fileResponse(await Packer.toBlob(new Document({ sections })), 'layout.docx', MIME.docx);
}
