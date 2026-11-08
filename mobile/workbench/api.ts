// SPDX-License-Identifier: AGPL-3.0-only
import { mergePdf, organizePdf, pdfImages, renderPdf, repairPdf, securePdf, splitPdf, transformPdf } from './pdf';
import { editAnnotations, editForm, signPdf } from './pdf-edit';
import { convertPdf, MIME, textFile } from './formats';
import { pickScreenshot, recognizeOnPhone } from './native';
import { jsonResponse } from './response';
import { compareDocuments } from './compare';
import { extractTables } from './tables';
import { restoreLayout } from './layout';

const pdfRoutes: Record<string, (body: FormData, signal?: AbortSignal) => Promise<Response>> = {
  '/pdf/render': renderPdf,
  '/pdf/organize': organizePdf,
  '/pdf/merge': mergePdf,
  '/pdf/split': splitPdf,
  '/pdf/transform': transformPdf,
  '/pdf/repair': repairPdf,
  '/pdf/sign': signPdf,
};

type OcrItem = { text: string; filename: string; pages: number; job_id: string };
const jobs = new Map<string, string>();
const reports = new Map<string, () => Promise<Blob>>();
const ocrExports = { txt: 'result.txt', docx: 'result.docx', xlsx: 'result.xlsx' } as const;

function storeText(text: string) {
  if (jobs.size >= 20) jobs.delete(jobs.keys().next().value!);
  const id = crypto.randomUUID();
  jobs.set(id, text);
  return id;
}

export async function requestLocalDocument(path: string, options?: RequestInit): Promise<Response> {
  const body = options?.body;
  const signal = options?.signal ?? undefined;
  try {
    signal?.throwIfAborted();
    if (path.startsWith('/wallpaper/')) return await (await import('./media')).requestVideo(path, options);
    if (body instanceof FormData) {
      if (Object.hasOwn(pdfRoutes, path)) return await pdfRoutes[path](body, signal);
      if (path.startsWith('/security/')) return await securePdf(path.slice('/security/'.length), body);
      if (path.startsWith('/annotate/')) return await editAnnotations(path.slice('/annotate/'.length), body);
      if (path.startsWith('/forms/')) return await editForm(path.slice('/forms/'.length), body);
      if (path === '/capture/snip') return await pickScreenshot();
      if (path === '/tables/extract') return await extractTables(body, signal);
      if (path === '/compare') {
        const { makeReport, ...result } = await compareDocuments(body, signal);
        const job_id = crypto.randomUUID();
        if (reports.size >= 3) reports.delete(reports.keys().next().value!);
        reports.set(job_id, makeReport);
        return jsonResponse({ ...result, job_id, report: 'compare.pdf' });
      }
      if (path === '/ocr') {
        const file = body.get('file');
        if (!(file instanceof File)) throw new Error('请先选择图片或 PDF。');
        const result = await recognizeOnPhone(file, file.name, String(body.get('language') || 'ch'));
        return jsonResponse({ ...result, job_id: storeText(result.text), filename: file.name, exports: ocrExports });
      }
      if (path === '/convert' || path === '/convert/extra') {
        const target = String(body.get('target'));
        const files = (path === '/convert' ? body.getAll('files') : [body.get('file')]).filter((item): item is File => item instanceof File);
        if (!files.length || files.length > 10) throw new Error('请选择需要转换的文件。');
        if (target === 'pdf') return await pdfImages(files);
        if (files.length !== 1) throw new Error('请单独选择一个文件。');
        const file = files[0];
        if (target === 'layout-docx' || target === 'md') return await restoreLayout(file, target, String(body.get('language') || 'ch'), signal);
        if (!file.name.toLowerCase().endsWith('.pdf')) throw new Error('这项转换需要 PDF 文件。');
        return await convertPdf(file, target, String(body.get('language') || 'ch'), signal);
      }
    }
    if (path === '/ocr/combine' && typeof body === 'string') {
      const { items }: { items: OcrItem[] } = JSON.parse(body);
      if (!Array.isArray(items) || !items.length || items.length > 10) throw new Error('没有可合并的识别结果。');
      const text = items.map((item) => `【文件：${item.filename}】\n${item.text}`.trim()).join('\n\n');
      return jsonResponse({ items, text, job_id: storeText(text), pages: items.reduce((sum, item) => sum + item.pages, 0), exports: ocrExports });
    }
    const edit = /^\/exports\/([\w-]+)$/.exec(path);
    if (edit && typeof body === 'string') {
      const { text } = JSON.parse(body);
      if (typeof text !== 'string') throw new Error('识别结果格式无效。');
      jobs.set(edit[1], text);
      return jsonResponse({ exports: ocrExports });
    }
    const download = /^\/download\/([\w-]+)\/result\.(txt|docx|xlsx)$/.exec(path);
    if (download) {
      const text = jobs.get(download[1]);
      if (text === undefined) return jsonResponse({ detail: '识别结果已过期，请重新导出。' }, { status: 404 });
      const format = download[2] as keyof typeof ocrExports;
      return new Response(await textFile(text, format), { headers: { 'Content-Type': MIME[format] } });
    }
    const report = /^\/jobfile\/([\w-]+)\/compare\.pdf$/.exec(path);
    if (report) {
      const makeReport = reports.get(report[1]);
      if (makeReport) return new Response(await makeReport(), { headers: { 'Content-Type': 'application/pdf' } });
      return jsonResponse({ detail: '报告已过期，请重新对比。' }, { status: 404 });
    }
    return jsonResponse({ detail: '这项功能还在进行手机端移植。' }, { status: 501 });
  } catch (error) {
    signal?.throwIfAborted();
    return jsonResponse({ detail: error instanceof Error ? error.message : '处理文件失败。' }, { status: 400 });
  }
}
