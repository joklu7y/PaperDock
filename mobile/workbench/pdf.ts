// SPDX-License-Identifier: AGPL-3.0-only
import { ColorSpace, Document, Image, Matrix, PDFDocument, PDFPage, type Rect } from 'mupdf';
import { zipSync } from 'fflate';
import { jsonResponse } from './response.ts';

const PDF_LIMIT = 50 * 1024 * 1024;
const WRITE_OPTIONS = 'garbage=4,compress=yes';
const SECURITY_MARKER = 'PaperDock Secure PDF AES-256';

export function formText(form: FormData, name: string, fallback = ''): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : fallback;
}

export function formFile(form: FormData, name = 'file'): Blob {
  const value = form.get(name);
  if (!(value instanceof Blob)) throw new Error('请先选择文件。');
  return value;
}

export function fileResponse(data: Uint8Array<ArrayBuffer> | Blob, name: string, type = 'application/pdf'): Response {
  return new Response(data, { headers: {
    'Content-Type': type,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  } });
}

export async function withPdf<T>(file: Blob, action: (doc: PDFDocument) => T | Promise<T>, password?: string): Promise<T> {
  if (file.size > PDF_LIMIT) throw new Error('手机端单个 PDF 最大支持 50 MB。');
  const doc = new PDFDocument(await file.arrayBuffer());
  try {
    if (doc.needsPassword() && password === undefined) throw new Error('此 PDF 有打开密码，请先到安全与修复中处理。');
    return await action(doc);
  } finally {
    doc.destroy();
  }
}

export function bytesOf(doc: PDFDocument, options = WRITE_OPTIONS): Uint8Array<ArrayBuffer> {
  const buffer = doc.saveToBuffer(options);
  try { return Uint8Array.from(buffer.asUint8Array()); }
  finally { buffer.destroy(); }
}

function newPdf(action: (output: PDFDocument) => void): Uint8Array<ArrayBuffer> {
  const output = new PDFDocument();
  try { action(output); return bytesOf(output); }
  finally { output.destroy(); }
}

function indices(count: number, raw: string): number[] {
  if (!count) throw new Error('PDF 没有可读取的页面。');
  if (!raw.trim()) return Array.from({ length: count }, (_, index) => index);
  const values = raw.trim().split(/[,，;；\s]+/).map(Number);
  if (values.some((page) => !Number.isInteger(page) || page < 1 || page > count)) {
    throw new Error(`请输入 1 到 ${count} 之间的页码，用逗号分隔。`);
  }
  return [...new Set(values)].map((page) => page - 1);
}

function turn(degrees: number): 0 | 90 | 180 | 270 {
  const angle = (degrees % 360 + 360) % 360;
  if (angle !== 0 && angle !== 90 && angle !== 180 && angle !== 270) throw new Error('旋转角度只能是 90 的倍数。');
  return angle;
}

function rotatePage(doc: PDFDocument, index: number, delta: number) {
  const page = doc.findPage(index);
  page.put('Rotate', turn(page.getInheritable('Rotate').asNumber() + delta));
}

function jpeg(page: PDFPage, scale: number) {
  const pixmap = page.toPixmap(Matrix.scale(scale, scale), ColorSpace.DeviceRGB);
  try { return Uint8Array.from(pixmap.asJPEG(82)); }
  finally { pixmap.destroy(); }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

export async function renderPdf(form: FormData, signal?: AbortSignal): Promise<Response> {
  return withPdf(formFile(form), async (doc) => {
    const count = doc.countPages();
    const selected = indices(count, formText(form, 'pages'));
    if (selected.length > 400) throw new Error('一次最多预览 400 页。');
    const scale = Math.max(0.1, Math.min(3, Number(formText(form, 'scale')) || 0.3));
    const pages = [];
    for (const index of selected) {
      signal?.throwIfAborted();
      const page = doc.loadPage(index);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        const safeScale = Math.min(scale, 2400 / Math.max(1, x1 - x0, y1 - y0));
        pages.push({ index, width: x1 - x0, height: y1 - y0, image: `data:image/jpeg;base64,${base64(jpeg(page, safeScale))}` });
      } finally { page.destroy(); }
      if (pages.length % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return jsonResponse({ count, pages });
  });
}

export async function organizePdf(form: FormData): Promise<Response> {
  const plan: { src: number | null; rotate: number }[] = JSON.parse(formText(form, 'plan'));
  if (!Array.isArray(plan) || !plan.length || plan.length > 400) throw new Error('请保留 1 到 400 页。');
  return withPdf(formFile(form), (source) => {
    const count = source.countPages();
    if (!count) throw new Error('PDF 没有可读取的页面。');
    const first = source.loadPage(0);
    const [x0, y0, x1, y1] = first.getBounds();
    first.destroy();
    return fileResponse(newPdf((output) => {
      const graft = output.newGraftMap();
      try {
        plan.forEach((item, index) => {
          if (!item || item.src !== null && (!Number.isInteger(item.src) || item.src < 0 || item.src >= count)) {
            throw new Error('页面序号超出范围。');
          }
          const angle = turn(item.rotate ?? 0);
          if (item.src === null) output.insertPage(-1, output.addPage([0, 0, x1 - x0, y1 - y0], angle, {}, ''));
          else {
            graft.graftPage(-1, source, item.src);
            if (angle) rotatePage(output, index, angle);
          }
        });
      } finally { graft.destroy(); }
    }), 'organized.pdf');
  });
}

export async function mergePdf(form: FormData, signal?: AbortSignal): Promise<Response> {
  const files = form.getAll('files');
  if (files.length < 2 || files.length > 10) throw new Error('请选择 2 到 10 份 PDF。');
  const output = new PDFDocument();
  try {
    for (const file of files) {
      if (!(file instanceof Blob)) throw new Error('请选择 PDF 文件。');
      await withPdf(file, (source) => {
        const graft = output.newGraftMap();
        try {
          for (const index of indices(source.countPages(), '')) {
            signal?.throwIfAborted();
            graft.graftPage(-1, source, index);
          }
        } finally { graft.destroy(); }
      });
    }
    return fileResponse(bytesOf(output), 'merged.pdf');
  } finally { output.destroy(); }
}

export async function splitPdf(form: FormData, signal?: AbortSignal): Promise<Response> {
  return withPdf(formFile(form), async (source) => {
    const count = source.countPages();
    const ranges = formText(form, 'mode', 'each') === 'each'
      ? indices(count, '').map((index) => `${index + 1}`)
      : formText(form, 'ranges').trim().split(/[,，;；\s]+/).filter(Boolean);
    if (!ranges.length || ranges.length > 400) throw new Error('请输入 1 到 400 个拆分范围，例如 1-3,4-6。');
    const outputs: Record<string, Uint8Array> = {};
    for (const range of ranges) {
      signal?.throwIfAborted();
      const match = /^(\d+)(?:[-~–](\d+))?$/.exec(range);
      if (!match) throw new Error(`页码范围格式不正确：${range}`);
      const first = Number(match[1]);
      const last = Number(match[2] ?? match[1]);
      if (first < 1 || first > last || last > count) throw new Error(`页码范围超出文档页数：${range}`);
      const filename = first === last ? `第${first}页.pdf` : `第${first}-${last}页.pdf`;
      outputs[filename] = newPdf((part) => {
        const graft = part.newGraftMap();
        try { for (let index = first - 1; index < last; index++) graft.graftPage(-1, source, index); }
        finally { graft.destroy(); }
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return fileResponse(Uint8Array.from(zipSync(outputs, { level: 0 })), 'split.zip', 'application/zip');
  });
}

function appendImage(output: PDFDocument, image: Image, width: number, height: number) {
  const resource = output.addImage(image);
  const commands = `q ${width} 0 0 ${height} 0 0 cm /Photo Do Q`;
  output.insertPage(-1, output.addPage([0, 0, width, height], 0, { XObject: { Photo: resource } }, commands));
}

async function watermarkedPage(output: PDFDocument, page: PDFPage, text: string) {
  const [x0, y0, x1, y1] = page.getBounds();
  const width = x1 - x0;
  const height = y1 - y0;
  const bitmap = await createImageBitmap(new Blob([jpeg(page, Math.min(2, 2400 / Math.max(width, height)))], { type: 'image/jpeg' }));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法绘制水印。');
    context.drawImage(bitmap, 0, 0);
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(-Math.PI / 6);
    const size = Math.max(14, Math.round(canvas.width / 20));
    context.font = `${size}px sans-serif`;
    context.fillStyle = 'rgba(70,70,70,0.23)';
    const step = Math.max(size * 5, context.measureText(text).width + size * 2);
    const diagonal = Math.hypot(canvas.width, canvas.height);
    for (let y = -diagonal / 2; y < diagonal / 2; y += size * 4) {
      for (let x = -diagonal / 2; x < diagonal / 2; x += step) context.fillText(text, x, y);
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('无法导出水印页面。')), 'image/jpeg', 0.92));
    const image = new Image(new Uint8Array(await blob.arrayBuffer()));
    try { appendImage(output, image, width, height); }
    finally { image.destroy(); }
  } finally { bitmap.close(); }
}

export async function transformPdf(form: FormData): Promise<Response> {
  const action = formText(form, 'action');
  return withPdf(formFile(form), async (doc) => {
    const selected = new Set(indices(doc.countPages(), formText(form, 'pages')));
    if (action === 'watermark') {
      const text = formText(form, 'watermark_text').trim();
      if (!text || text.length > 120) throw new Error('请输入 1 到 120 字的水印。');
      const output = new PDFDocument();
      const graft = output.newGraftMap();
      try {
        for (let index = 0; index < doc.countPages(); index++) {
          if (!selected.has(index)) { graft.graftPage(-1, doc, index); continue; }
          const page = doc.loadPage(index);
          try { await watermarkedPage(output, page, text); } finally { page.destroy(); }
        }
        return fileResponse(bytesOf(output), 'watermarked.pdf');
      } finally { graft.destroy(); output.destroy(); }
    }
    if (action === 'rotate') {
      const angle = turn(Number(formText(form, 'degrees', '90')));
      for (const index of selected) rotatePage(doc, index, angle);
    } else if (action === 'crop') {
      const margin = Number(formText(form, 'crop_margin', '18'));
      if (!Number.isFinite(margin) || margin < 0) throw new Error('请输入有效的裁切边距。');
      for (const index of selected) {
        const page = doc.loadPage(index);
        try {
          const [x0, y0, x1, y1] = page.getBounds();
          if (Math.min(x1 - x0, y1 - y0) - 2 * margin <= 20) throw new Error('裁切边距过大。');
          page.setPageBox('CropBox', [x0 + margin, y0 + margin, x1 - margin, y1 - margin]);
        } finally { page.destroy(); }
      }
    } else throw new Error('不支持的 PDF 操作。');
    return fileResponse(bytesOf(doc), 'processed.pdf');
  });
}

export async function pdfImages(files: Blob[]): Promise<Response> {
  const output = new PDFDocument();
  try {
    for (const file of files) {
      const image = new Image(new Uint8Array(await file.arrayBuffer()));
      try {
        const width = 595;
        appendImage(output, image, width, width * image.getHeight() / image.getWidth());
      } finally { image.destroy(); }
    }
    return fileResponse(bytesOf(output), 'images.pdf');
  } finally { output.destroy(); }
}

export async function repairPdf(form: FormData): Promise<Response> {
  return withPdf(formFile(form), (doc) => {
    if (!doc.countPages()) throw new Error('PDF 损坏过于严重，未能恢复页面。');
    const response = fileResponse(bytesOf(doc, `${WRITE_OPTIONS},clean=yes`), 'repaired.pdf');
    response.headers.set('X-PaperDock-Repair', `mupdf|${doc.countPages()}`);
    return response;
  });
}

export async function securePdf(operation: string, form: FormData): Promise<Response> {
  const password = formText(form, 'password');
  return withPdf(formFile(form), (doc) => {
    if (operation === 'protect') {
      if (doc.needsPassword()) throw new Error('请先移除 PDF 的已有密码。');
      const owner = formText(form, 'owner_password');
      for (const value of [password, owner]) {
        if (!/^[\x21-\x7e]{8,64}$/.test(value) || !/[A-Za-z]/.test(value) || !/\d/.test(value) || /[,=]/.test(value)) {
          throw new Error('密码需为 8 到 64 位可见英文字符，包含字母和数字，逗号及等号除外。');
        }
      }
      if (password === owner) throw new Error('打开密码和所有者密码必须不同。');
      const flags: string[] = JSON.parse(formText(form, 'permissions', '[]'));
      const permissions = 512 | (flags.includes('print') ? 4 | 2048 : 0) | (flags.includes('copy') ? 16 : 0)
        | (flags.includes('modify') ? 8 | 32 | 256 | 1024 : 0);
      doc.setMetaData(Document.META_INFO_PRODUCER, SECURITY_MARKER);
      return fileResponse(bytesOf(doc, `${WRITE_OPTIONS},encrypt=aes-256,user-password=${password},owner-password=${owner},permissions=${permissions}`), 'secured.pdf');
    }
    const locked = doc.needsPassword();
    const auth = locked ? doc.authenticatePassword(password) : 0;
    if (locked && !auth) throw new Error('PDF 密码不正确。');
    if (operation === 'unlock') {
      if (!locked) throw new Error('此 PDF 无需移除密码。');
      if (!(auth & 2) || doc.getMetaData(Document.META_INFO_PRODUCER) !== SECURITY_MARKER) {
        throw new Error('请输入 PaperDock 加密文档的打开密码。');
      }
      return fileResponse(bytesOf(doc, `${WRITE_OPTIONS},encrypt=no`), 'unlocked.pdf');
    }
    if (operation === 'clean-metadata') {
      const trailer = doc.getTrailer();
      trailer.delete('Info');
      trailer.delete('ID');
      trailer.get('Root').delete('Metadata');
    } else if (operation === 'redact') {
      const terms = [...new Set(formText(form, 'redact_text').split(/\r?\n/).map((term) => term.trim()).filter(Boolean))];
      if (!terms.length) throw new Error('请输入需要永久涂黑的文字。');
      const missing = new Set(terms);
      for (let index = 0; index < doc.countPages(); index++) {
        const page = doc.loadPage(index);
        try {
          let hits = 0;
          for (const term of terms) {
            for (const match of page.search(term, '')) {
              for (const quad of match) {
                const xs = [quad[0], quad[2], quad[4], quad[6]];
                const ys = [quad[1], quad[3], quad[5], quad[7]];
                const rect: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
                const mark = page.createAnnotation('Redact');
                mark.setRect(rect);
                mark.update();
                hits++;
              }
              if (match.length) missing.delete(term);
            }
          }
          if (hits) page.applyRedactions(true, PDFPage.REDACT_IMAGE_PIXELS, PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED, PDFPage.REDACT_TEXT_REMOVE);
        } finally { page.destroy(); }
      }
      if (missing.size) throw new Error(`PDF 中找不到以下文字：${[...missing].join('、')}。`);
    } else throw new Error('不支持的安全操作。');
    return fileResponse(bytesOf(doc, `${WRITE_OPTIONS},clean=yes,encrypt=no`), 'secured.pdf');
  }, password);
}
