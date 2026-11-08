// SPDX-License-Identifier: AGPL-3.0-only
import { ColorSpace, Matrix, type PDFPage } from 'mupdf';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { fileResponse, withPdf } from './pdf';
import { recognizeOnPhone } from './native';

const xml = (text: string) => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!);
const header = '<?xml version="1.0" encoding="UTF-8"?>';
const contentTypes = 'http://schemas.openxmlformats.org/package/2006/content-types';
const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const documentRelationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const MIME = {
  txt: 'text/plain;charset=utf-8', md: 'text/markdown;charset=utf-8', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', epub: 'application/epub+zip', zip: 'application/zip',
};

export function archive(files: Zippable): Uint8Array<ArrayBuffer> { return Uint8Array.from(zipSync(files, { level: 3 })); }

export function workbook(sheets: string[][][]): Uint8Array<ArrayBuffer> {
  const files: Zippable = {};
  const entries = sheets.map((rows, index) => {
    const n = index + 1;
    files[`xl/worksheets/sheet${n}.xml`] = strToU8(`${header}<worksheet xmlns="${spreadsheet}"><sheetData>${rows.map((row, rowIndex) =>
      `<row r="${rowIndex + 1}">${row.map((cell, column) => {
        let ref = '';
        for (let c = column + 1; c > 0; c = Math.floor((c - 1) / 26)) ref = String.fromCharCode(65 + (c - 1) % 26) + ref;
        return `<c r="${ref}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(cell)}</t></is></c>`;
      }).join('')}</row>`).join('')}</sheetData></worksheet>`);
    return n;
  });
  files['[Content_Types].xml'] = strToU8(`${header}<Types xmlns="${contentTypes}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${entries.map((n) => `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  files['_rels/.rels'] = strToU8(`${header}<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${documentRelationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  files['xl/workbook.xml'] = strToU8(`${header}<workbook xmlns="${spreadsheet}" xmlns:r="${documentRelationships}"><sheets>${entries.map((n) => `<sheet name="表${n}" sheetId="${n}" r:id="rId${n}"/>`).join('')}</sheets></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8(`${header}<Relationships xmlns="${packageRelationships}">${entries.map((n) => `<Relationship Id="rId${n}" Type="${documentRelationships}/worksheet" Target="worksheets/sheet${n}.xml"/>`).join('')}</Relationships>`);
  return archive(files);
}

export async function textFile(text: string, format: 'txt' | 'docx' | 'xlsx'): Promise<Blob> {
  if (format === 'txt') return new Blob([text], { type: MIME.txt });
  const lines = text.split(/\r?\n/);
  if (format === 'xlsx') return new Blob([workbook([lines.map((line) => [line])])], { type: MIME.xlsx });
  const { Document, Packer, Paragraph } = await import('docx');
  return Packer.toBlob(new Document({ sections: [{ children: lines.map((text) => new Paragraph(text)) }] }));
}

function packageOdt(pages: string[]) {
  const type = MIME.odt;
  const ns = 'urn:oasis:names:tc:opendocument:xmlns:';
  return archive({
    mimetype: [strToU8(type), { level: 0 }],
    'META-INF/manifest.xml': strToU8(`${header}<manifest:manifest xmlns:manifest="${ns}manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="${type}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`),
    'content.xml': strToU8(`${header}<office:document-content xmlns:office="${ns}office:1.0" xmlns:text="${ns}text:1.0" office:version="1.2"><office:body><office:text>${pages.flatMap((page) => page.split('\n')).map((line) => `<text:p>${xml(line)}</text:p>`).join('')}</office:text></office:body></office:document-content>`),
  });
}

function packageEpub(pages: string[]) {
  const files: Zippable = { mimetype: [strToU8('application/epub+zip'), { level: 0 }] };
  files['META-INF/container.xml'] = strToU8(`${header}<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  files['EPUB/book.opf'] = strToU8(`${header}<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:${crypto.randomUUID()}</dc:identifier><dc:title>PaperDock 文档</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${pages.map((_, i) => `<item id="p${i}" href="p${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${pages.map((_, i) => `<itemref idref="p${i}"/>`).join('')}</spine></package>`);
  files['EPUB/nav.xhtml'] = strToU8(`${header}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>${pages.map((_, i) => `<li><a href="p${i}.xhtml">第 ${i + 1} 页</a></li>`).join('')}</ol></nav></body></html>`);
  pages.forEach((text, i) => {
    files[`EPUB/p${i}.xhtml`] = strToU8(`${header}<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN"><head><title>第 ${i + 1} 页</title></head><body><h1>第 ${i + 1} 页</h1>${text.split('\n').map((line) => `<p>${xml(line)}</p>`).join('')}</body></html>`);
  });
  return archive(files);
}

export function renderPng(page: PDFPage, preferredScale = 1.6) {
  const [x0, y0, x1, y1] = page.getBounds();
  const width = x1 - x0;
  const height = y1 - y0;
  const scale = Math.min(preferredScale, 2000 / Math.max(1, width, height));
  const pixmap = page.toPixmap(Matrix.scale(scale, scale), ColorSpace.DeviceRGB);
  try { return { png: Uint8Array.from(pixmap.asPNG()), width, height }; }
  finally { pixmap.destroy(); }
}

export async function pageText(page: PDFPage, language: string): Promise<string> {
  const structured = page.toStructuredText('');
  const text = structured.asText().trim();
  structured.destroy();
  if (text && (text.match(/[□\ufffd]/g)?.length ?? 0) < Math.max(3, text.length * 0.01)) return text;
  const { png } = renderPng(page);
  return (await recognizeOnPhone(new Blob([png], { type: 'image/png' }), 'page.png', language)).text.trim();
}

export async function convertPdf(file: File, target: string, language: string, signal?: AbortSignal): Promise<Response> {
  return withPdf(file, async (doc) => {
    const count = doc.countPages();
    if (!count || count > 100) throw new Error('手机端每次可转换 1 到 100 页。');
    const images: Zippable = {};
    const pages: string[] = [];
    const visual: { png: Uint8Array<ArrayBuffer>; width: number; height: number }[] = [];
    const extractedImages = new Set<number>();
    for (let i = 0; i < count; i++) {
      signal?.throwIfAborted();
      const page = doc.loadPage(i);
      try {
        if (target === 'images') images[`第${i + 1}页.png`] = renderPng(page).png;
        else if (target === 'embedded-images') {
          const objects = page.getObject().getInheritable('Resources').get('XObject');
          if (!objects.isDictionary()) continue;
          objects.forEach((object) => {
            const xref = object.asIndirect();
            if (object.get('Subtype').asName() !== 'Image' || extractedImages.has(xref)) return;
            extractedImages.add(xref);
            if (object.get('Filter').asName() === 'DCTDecode') {
              const buffer = object.readRawStream();
              try { images[`图片${xref}.jpg`] = Uint8Array.from(buffer.asUint8Array()); } finally { buffer.destroy(); }
            } else {
              const image = doc.loadImage(object);
              const pixmap = image.toPixmap();
              try { images[`图片${xref}.png`] = Uint8Array.from(pixmap.asPNG()); }
              finally { pixmap.destroy(); image.destroy(); }
            }
          });
        } else {
          pages.push(await pageText(page, language));
          if (target === 'pptx' || target === 'layout-docx') visual.push(renderPng(page));
        }
      } finally { page.destroy(); }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (target === 'images' || target === 'embedded-images') {
      if (!Object.keys(images).length) throw new Error('这份 PDF 中没有可提取的图片。');
      return fileResponse(archive(images), target === 'images' ? 'pages.zip' : 'embedded-images.zip', MIME.zip);
    }
    const text = pages.join('\n\n').trim();
    if (target === 'pptx') {
      const { default: PptxGen } = await import('pptxgenjs');
      const pptx = new PptxGen();
      pptx.layout = 'LAYOUT_WIDE';
      for (const [index, image] of visual.entries()) {
        const slide = pptx.addSlide();
        const scale = Math.min(13.33 / image.width, 7.5 / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        let data = '';
        for (let i = 0; i < image.png.length; i += 8192) data += String.fromCharCode(...image.png.subarray(i, i + 8192));
        slide.addImage({ data: `image/png;base64,${btoa(data)}`, x: (13.33 - width) / 2, y: (7.5 - height) / 2, w: width, h: height });
        if (pages[index]) slide.addNotes(pages[index]);
      }
      const data = await pptx.write({ outputType: 'blob' });
      if (!(data instanceof Blob)) throw new Error('无法生成幻灯片。');
      return fileResponse(data, 'slides.pptx', MIME.pptx);
    }
    if (target === 'layout-docx') {
      const { Document, Packer, Paragraph, ImageRun } = await import('docx');
      const sections = visual.map(({ png, width, height }, index) => {
        const ratio = Math.min(600 / width, 780 / height);
        return { children: [new Paragraph({ children: [new ImageRun({ data: png, type: 'png', transformation: { width: width * ratio, height: height * ratio } })] }),
          ...pages[index].split('\n').filter(Boolean).map((line) => new Paragraph(line))] };
      });
      const response = fileResponse(await Packer.toBlob(new Document({ sections })), 'layout.docx', MIME.docx);
      response.headers.set('X-PaperDock-Conversion-Mode', 'page-images');
      return response;
    }
    if (!text) throw new Error('没有提取到可导出的文字。');
    if (target === 'epub') return fileResponse(packageEpub(pages), 'document.epub', MIME.epub);
    if (target === 'odt') return fileResponse(packageOdt(pages), 'document.odt', MIME.odt);
    if (target === 'md') return fileResponse(new Blob([pages.map((page, i) => `## 第 ${i + 1} 页\n\n${page}`).join('\n\n')], { type: MIME.md }), 'document.md', MIME.md);
    if (target === 'txt' || target === 'docx' || target === 'xlsx') return fileResponse(await textFile(text, target), `converted.${target}`, MIME[target]);
    throw new Error('不支持所选格式。');
  });
}
