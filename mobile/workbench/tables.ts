// SPDX-License-Identifier: AGPL-3.0-only
import type { PDFPage } from 'mupdf';
import { strToU8, type Zippable } from 'fflate';
import { archive, MIME, renderPng, workbook } from './formats.ts';
import { recognizeOnPhone, type LocatedText } from './native.ts';
import { fileResponse, formText, withPdf } from './pdf.ts';

type Row = { center: number; height: number; cells: LocatedText[] };

export function pdfTextPositions(page: PDFPage): LocatedText[] {
  const [x0, y0, x1, y1] = page.getBounds();
  const w = x1 - x0;
  const h = y1 - y0;
  const text = page.toStructuredText('preserve-whitespace');
  const chars: LocatedText[] = [];
  try {
    text.walk({ onChar(char, _, _font, _size, quad) {
      if (!char.trim()) return;
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      chars.push({ text: char, box: [(Math.min(...xs) - x0) / w, (Math.min(...ys) - y0) / h, (Math.max(...xs) - x0) / w, (Math.max(...ys) - y0) / h] });
    } });
    return chars;
  } finally { text.destroy(); }
}

const middle = ([, top, , bottom]: LocatedText['box']) => (top + bottom) / 2;
const size = ([, top, , bottom]: LocatedText['box']) => Math.max(0.001, bottom - top);

export function tableFromPositions(positions: LocatedText[]): string[][][] {
  const rows: Row[] = [];
  const ordered = positions.filter((item) => item.text.trim() && item.box.every(Number.isFinite))
    .sort((a, b) => middle(a.box) - middle(b.box) || a.box[0] - b.box[0]);
  for (const item of ordered) {
    const center = middle(item.box);
    const height = size(item.box);
    const last = rows.at(-1);
    if (last && Math.abs(center - last.center) < Math.max(last.height, height) * 0.43) last.cells.push(item);
    else rows.push({ center, height, cells: [item] });
  }
  for (const row of rows) {
    const merged: LocatedText[] = [];
    for (const item of row.cells.sort((a, b) => a.box[0] - b.box[0])) {
      const last = merged.at(-1);
      const gap = last ? item.box[0] - last.box[2] : Number.POSITIVE_INFINITY;
      if (last && gap < Math.max(0.008, row.height * 0.6)) {
        if (gap > 0.002 && /[a-z\d]$/i.test(last.text) && /^[a-z\d]/i.test(item.text)) last.text += ' ';
        last.text += item.text;
        last.box[2] = Math.max(last.box[2], item.box[2]);
      } else merged.push({ text: item.text, box: [...item.box] });
    }
    row.cells = merged;
  }

  const groups: Row[][] = [];
  for (const row of rows) {
    if (row.cells.length < 2) continue;
    const group = groups.at(-1);
    const previous = group?.at(-1);
    const sameColumns = previous && previous.cells.some((old, index) => index > 0 && row.cells.some((cell) => Math.abs(cell.box[0] - old.box[0]) < 0.065));
    if (group && previous && sameColumns && row.center - previous.center < Math.max(0.085, 3 * row.height)) group.push(row);
    else groups.push([row]);
  }
  return groups.filter((group) => group.length >= 2).map((group) => {
    const reference = group.reduce((best, row) => row.cells.length > best.cells.length ? row : best);
    const anchors = reference.cells.map((cell) => cell.box[0]);
    return group.map((row) => {
      const output = anchors.map(() => '');
      for (const cell of row.cells) {
        const best = anchors.reduce((nearest, x, i) => Math.abs(x - cell.box[0]) < Math.abs(anchors[nearest] - cell.box[0]) ? i : nearest, 0);
        output[best] = [output[best], cell.text].filter(Boolean).join(' ');
      }
      return output;
    });
  });
}

async function scannedPositions(file: Blob, name: string, language: string) {
  return (await recognizeOnPhone(file, name, language, true)).locations ?? [];
}

export async function extractTables(form: FormData, signal?: AbortSignal): Promise<Response> {
  const files = form.getAll('files').filter((item): item is File => item instanceof File);
  if (!files.length || files.length > 10) throw new Error('请选择 1 到 10 份 PDF 或图片。');
  const language = formText(form, 'language', 'ch');
  const tables: string[][][] = [];
  for (const file of files) {
    signal?.throwIfAborted();
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      tables.push(...tableFromPositions(await scannedPositions(file, file.name, language)));
      continue;
    }
    await withPdf(file, async (doc) => {
      if (doc.countPages() > 30) throw new Error('单份 PDF 一次最多提取 30 页表格。');
      for (let index = 0; index < doc.countPages(); index++) {
        signal?.throwIfAborted();
        const page = doc.loadPage(index);
        try {
          const positions = pdfTextPositions(page);
          const found = positions.length ? positions : await scannedPositions(new Blob([renderPng(page).png], { type: 'image/png' }), 'page.png', language);
          tables.push(...tableFromPositions(found));
        } finally { page.destroy(); }
      }
    });
  }
  if (!tables.length) throw new Error('未发现可以按行列还原的表格。');
  let response: Response;
  if (formText(form, 'output') === 'csv') {
    const files: Zippable = {};
    tables.forEach((rows, index) => {
      const escaped = rows.map((row) => row.map((value) => {
        const safe = /^[\t\r\n ]*[=+@-]/.test(value) ? `'${value}` : value;
        return `"${safe.replaceAll('"', '""')}"`;
      }).join(',')).join('\r\n');
      files[`表${index + 1}.csv`] = strToU8(`\uFEFF${escaped}`);
    });
    response = fileResponse(archive(files), 'tables-csv.zip', MIME.zip);
  } else response = fileResponse(workbook(tables), 'tables.xlsx', MIME.xlsx);
  response.headers.set('X-PaperDock-Tables', String(tables.length));
  return response;
}
