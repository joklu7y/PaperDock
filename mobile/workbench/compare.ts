// SPDX-License-Identifier: AGPL-3.0-only
import { diffChars } from 'diff';
import { strFromU8, unzipSync } from 'fflate';
import { pageText } from './formats.ts';
import { pdfImages, withPdf } from './pdf.ts';
import { recognizeOnPhone } from './native.ts';

type Change = { type: 'insert' | 'delete' | 'replace'; old: string; new: string; page_old: number | null; page_new: number | null; context: string };

async function documentPages(file: File, signal?: AbortSignal): Promise<string[]> {
  if (file.size > 50 * 1024 * 1024) throw new Error('对比文件最大支持 50 MB。');
  const extension = file.name.toLowerCase().split('.').pop();
  if (extension === 'txt' || extension === 'md') return [(await file.text()).replace(/\r\n/g, '\n')];
  if (extension === 'docx') {
    const zipped = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (entry) => entry.name === 'word/document.xml' && entry.originalSize < 12 * 1024 * 1024 });
    if (!zipped['word/document.xml']) throw new Error('无法读取 Word 文件正文。');
    const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const xml = new DOMParser().parseFromString(strFromU8(zipped['word/document.xml']), 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('Word 文件格式不正确。');
    const text = Array.from(xml.getElementsByTagNameNS(word, 'p')).map((line) =>
      Array.from(line.getElementsByTagNameNS(word, 't')).map((span) => span.textContent ?? '').join('')).join('\n');
    return [text];
  }
  if (extension === 'pdf') {
    return withPdf(file, async (doc) => {
      if (doc.countPages() > 60) throw new Error('每份 PDF 最多对比 60 页。');
      const pages = [];
      for (let i = 0; i < doc.countPages(); i++) {
        signal?.throwIfAborted();
        const page = doc.loadPage(i);
        try { pages.push(await pageText(page, 'ch')); } finally { page.destroy(); }
      }
      return pages;
    });
  }
  return [(await recognizeOnPhone(file, file.name, 'ch')).text];
}

function characters(oldPages: string[], newPages: string[]) {
  const oldText = oldPages.join('\f');
  const newText = newPages.join('\f');
  if (oldText.length + newText.length > 160_000) throw new Error('文字过多，请分段对比。');
  const diff = diffChars(oldText, newText, { timeout: 1800 });
  if (!diff) throw new Error('两份文件的差异过大，请分段对比。');
  const stats = { insert: 0, delete: 0, replace: 0 };
  const changes: Change[] = [];
  let matched = 0;
  let oldPage = 1;
  let newPage = 1;
  let context = '';
  const pagesIn = (value: string) => value.split('\f').length - 1;
  for (let i = 0; i < diff.length; i++) {
    const part = diff[i];
    if (!part.added && !part.removed) {
      matched += part.count - pagesIn(part.value);
      oldPage += pagesIn(part.value);
      newPage += pagesIn(part.value);
      context = part.value.replace(/\s+/g, ' ').trim().slice(-30);
      continue;
    }
    let deleted = '';
    let inserted = '';
    let end = i;
    for (; end < diff.length && (diff[end].added || diff[end].removed); end++) {
      if (diff[end].added) inserted += diff[end].value;
      else deleted += diff[end].value;
    }
    const old = deleted.replaceAll('\f', '\n');
    const next = inserted.replaceAll('\f', '\n');
    const type = old && next ? 'replace' : old ? 'delete' : 'insert';
    stats[type]++;
    changes.push({ type, old, new: next, context, page_old: old ? oldPage : null, page_new: next ? newPage : null });
    oldPage += pagesIn(deleted);
    newPage += pagesIn(inserted);
    i = end - 1;
  }
  const length = Array.from(oldText.replaceAll('\f', '') + newText.replaceAll('\f', '')).length;
  return { stats, changes, similarity: length ? Math.round(2000 * matched / length) / 10 : 100 };
}

function wrap(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const char of text) {
    if (char === '\n' || context.measureText(line + char).width > width) {
      lines.push(line);
      line = char === '\n' ? '' : char;
    } else line += char;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

async function report(changes: Change[], signal?: AbortSignal): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 1100;
  canvas.height = 1450;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法绘制对比报告。');
  const pages: Blob[] = [];
  let top = 0;
  function begin() {
    context!.fillStyle = '#fff';
    context!.fillRect(0, 0, canvas.width, canvas.height);
    context!.fillStyle = '#172747';
    context!.font = 'bold 34px sans-serif';
    context!.fillText('PaperDock 文档对比', 48, 70);
    context!.font = '22px sans-serif';
    context!.fillText('旧版本', 48, 118);
    context!.fillText('新版本', 570, 118);
    top = 144;
  }
  async function flush() {
    const page = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('无法保存对比页。')), 'image/jpeg', 0.9));
    pages.push(page);
    if (pages.length > 100) throw new Error('对比报告过长，请分段导出。');
  }
  begin();
  if (!changes.length) { context.fillText('两份文档的文字内容一致。', 48, top + 28); }
  for (const change of changes) {
    signal?.throwIfAborted();
    context.font = '19px sans-serif';
    const old = wrap(context, change.old, 478);
    const next = wrap(context, change.new, 478);
    let offset = 0;
    while (offset < Math.max(old.length, next.length)) {
      if (top + 44 > 1400) { await flush(); begin(); context.font = '19px sans-serif'; }
      const count = Math.min(Math.max(old.length, next.length) - offset, Math.floor((1400 - top - 18) / 24));
      const height = count * 24 + 16;
      context.fillStyle = '#ffeceb';
      context.fillRect(42, top, 496, height);
      context.fillStyle = '#e5f5e9';
      context.fillRect(564, top, 496, height);
      context.fillStyle = '#202124';
      for (let n = 0; n < count; n++) {
        if (old[offset + n]) context.fillText(old[offset + n], 50, top + 25 + n * 24);
        if (next[offset + n]) context.fillText(next[offset + n], 572, top + 25 + n * 24);
      }
      offset += count;
      top += height + 8;
    }
  }
  await flush();
  return (await pdfImages(pages)).blob();
}

export async function compareDocuments(form: FormData, signal?: AbortSignal) {
  const oldFile = form.get('file_a');
  const newFile = form.get('file_b');
  if (!(oldFile instanceof File) || !(newFile instanceof File)) throw new Error('请选择两个版本的文档。');
  const oldPages = await documentPages(oldFile, signal);
  const newPages = await documentPages(newFile, signal);
  const { changes, stats, similarity } = characters(oldPages, newPages);
  return { stats, similarity, changes: changes.slice(0, 500), truncated: changes.length > 500, makeReport: () => report(changes) };
}
