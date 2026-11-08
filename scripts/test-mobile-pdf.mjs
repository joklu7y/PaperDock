// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Font, PDFDocument } from 'mupdf';
import { strFromU8, unzipSync } from 'fflate';
import { mergePdf, organizePdf, renderPdf, repairPdf, securePdf, splitPdf, transformPdf } from '../mobile/workbench/pdf.ts';
import { editAnnotations, editForm, signPdf } from '../mobile/workbench/pdf-edit.ts';
import { convertPdf, renderPng } from '../mobile/workbench/formats.ts';
import { compareDocuments } from '../mobile/workbench/compare.ts';
import { extractTables } from '../mobile/workbench/tables.ts';
import { restoreLayout } from '../mobile/workbench/layout.ts';

const source = new PDFDocument();
const font = source.addSimpleFont(new Font('Helvetica'));
for (const text of ['first secret', 'second']) {
  const page = source.addPage([0, 0, 200, 300], 0, { Font: { F: font } }, `BT /F 20 Tf 20 220 Td (${text}) Tj ET`);
  source.insertPage(-1, page);
}
const buffer = source.saveToBuffer('compress=yes');
const fixture = new Blob([Uint8Array.from(buffer.asUint8Array())], { type: 'application/pdf' });
buffer.destroy();
source.destroy();

function form(fields = {}, document = fixture) {
  const data = new FormData();
  data.append('file', document, 'source.pdf');
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

async function open(response) {
  return new PDFDocument(await response.arrayBuffer());
}

test('renders and rearranges actual pages, including rotation and blank insertion', async () => {
  const rendered = await (await renderPdf(form())).json();
  assert.equal(rendered.count, 2);
  assert.ok(rendered.pages.every(({ image }) => image.startsWith('data:image/jpeg;base64,')));
  const plan = JSON.stringify([{ src: 1, rotate: 90 }, { src: null, rotate: 0 }, { src: 0, rotate: 0 }]);
  const output = await open(await organizePdf(form({ plan })));
  assert.equal(output.countPages(), 3);
  assert.match(output.loadPage(0).toStructuredText('').asText(), /second/);
  assert.deepEqual(output.loadPage(0).getBounds(), [0, 0, 300, 200]);
  assert.equal(output.loadPage(1).toStructuredText('').asText().trim(), '');
  output.destroy();
});

test('merges, splits, crops and rewrites PDFs', async () => {
  const files = new FormData();
  files.append('files', fixture, 'a.pdf');
  files.append('files', fixture, 'b.pdf');
  const merged = await open(await mergePdf(files));
  assert.equal(merged.countPages(), 4);
  merged.destroy();
  const bundle = unzipSync(new Uint8Array(await (await splitPdf(form())).arrayBuffer()));
  assert.deepEqual(Object.keys(bundle), ['第1页.pdf', '第2页.pdf']);
  const cropped = await open(await transformPdf(form({ action: 'crop', crop_margin: '10', pages: '1' })));
  assert.deepEqual(cropped.loadPage(0).getBounds(), [0, 0, 180, 280]);
  assert.deepEqual(cropped.loadPage(1).getBounds(), [0, 0, 200, 300]);
  cropped.destroy();
  const repaired = await open(await repairPdf(form()));
  assert.equal(repaired.countPages(), 2);
  repaired.destroy();
});

test('protects with AES, removes an authorized password and permanently redacts', async () => {
  const secured = await securePdf('protect', form({ password: 'tester123', owner_password: 'owner5678' }));
  const encrypted = await secured.blob();
  const checked = new PDFDocument(await encrypted.arrayBuffer());
  assert.ok(checked.needsPassword());
  assert.equal(checked.authenticatePassword('tester123'), 2);
  assert.equal(checked.getMetaData('info:Producer'), 'PaperDock Secure PDF AES-256');
  checked.destroy();
  await assert.rejects(securePdf('unlock', form({ password: 'owner5678' }, encrypted)));
  const unlocked = await open(await securePdf('unlock', form({ password: 'tester123' }, encrypted)));
  assert.equal(unlocked.needsPassword(), false);
  unlocked.destroy();
  const redacted = await open(await securePdf('redact', form({ redact_text: 'secret' })));
  const text = redacted.loadPage(0).toStructuredText('').asText();
  assert.match(text, /first/);
  assert.doesNotMatch(text, /secret/);
  redacted.destroy();
});

test('writes visible annotations, updates their categories and stamps an image', async () => {
  const ops = [{ type: 'highlight', page: 0, text: 'secret', status: '待处理', category: '审阅' }, { type: 'note', page: 1, content: '检查' }];
  const added = await editAnnotations('apply', form({ ops: JSON.stringify(ops) }));
  assert.equal(added.headers.get('X-PaperDock-Added'), '2');
  const data = await added.blob();
  const list = (await (await editAnnotations('list', form({}, data))).json()).annotations;
  assert.equal(list[0].category, '审阅');
  const updates = JSON.stringify([{ page: 0, xref: list[0].xref, status: '已完成' }, { page: 1, xref: list[1].xref, delete: true }]);
  const updated = await editAnnotations('update', form({ updates }, data));
  const changes = (await (await editAnnotations('list', form({}, await updated.blob()))).json()).annotations;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, '已完成');

  const original = new PDFDocument(await fixture.arrayBuffer());
  const sign = form({ page: '1', rect: '[20,90,150,130]', date_text: '2026/11/08' });
  sign.append('signature', new Blob([renderPng(original.loadPage(0)).png]), 'signature.png');
  original.destroy();
  const signed = await open(await signPdf(sign));
  assert.deepEqual(signed.loadPage(1).getAnnotations().map((annotation) => annotation.getType()), ['Stamp', 'FreeText']);
  signed.destroy();
});

test('reads, fills and flattens a PDF AcroForm', async () => {
  const doc = new PDFDocument();
  const helvetica = doc.addSimpleFont(new Font('Helvetica'));
  const page = doc.addPage([0, 0, 200, 300], 0, {}, '');
  doc.insertPage(-1, page);
  const widget = doc.addObject({ Type: doc.newName('Annot'), Subtype: doc.newName('Widget'), FT: doc.newName('Tx'),
    Rect: [20, 20, 150, 40], T: doc.newString('Name'), V: doc.newString(''), DA: doc.newString('/Helv 10 Tf 0 g'), F: 4, P: page });
  page.put('Annots', [widget]);
  doc.getTrailer().get('Root').put('AcroForm', { Fields: [widget], DR: { Font: { Helv: helvetica } }, DA: doc.newString('/Helv 10 Tf 0 g') });
  const buffer = doc.saveToBuffer('');
  const input = new Blob([Uint8Array.from(buffer.asUint8Array())]);
  buffer.destroy();
  doc.destroy();
  const { fields } = await (await editForm('fields', form({}, input))).json();
  assert.equal(fields[0].name, 'Name');
  const values = JSON.stringify({ [`0:${fields[0].xref}`]: 'PaperDock' });
  const filled = await editForm('fill', form({ values, flatten: 'true' }, input));
  assert.equal(filled.headers.get('X-PaperDock-Filled'), '1');
  const output = await open(filled);
  assert.equal(output.loadPage(0).getWidgets().length, 0);
  assert.match(output.loadPage(0).toStructuredText('').asText(), /PaperDock/);
  output.destroy();
});

test('exports valid document formats and compares text at character granularity', async () => {
  const document = new File([fixture], 'source.pdf', { type: 'application/pdf' });
  for (const [format, entry] of [['docx', 'word/document.xml'], ['xlsx', 'xl/worksheets/sheet1.xml'], ['odt', 'content.xml'], ['epub', 'EPUB/p0.xhtml'], ['pptx', 'ppt/notesSlides/notesSlide1.xml']]) {
    const result = await convertPdf(document, format, 'ch');
    const files = unzipSync(new Uint8Array(await result.arrayBuffer()));
    assert.match(strFromU8(files[entry]), /first secret/);
  }
  const pair = new FormData();
  pair.append('file_a', new File(['待处理 2025'], 'old.txt'));
  pair.append('file_b', new File(['待处理 2026'], 'new.txt'));
  const diff = await compareDocuments(pair);
  assert.equal(diff.stats.replace, 1);
  assert.equal(diff.changes[0].old, '5');
  assert.equal(diff.changes[0].new, '6');
});

test('preserves table cells in XLSX and in a restored Word layout', async () => {
  const doc = new PDFDocument();
  const font = doc.addSimpleFont(new Font('Helvetica'));
  const rows = [['ID', 'TEMP', 'VALUE'], ['A', '120', '0.5'], ['B', '135', '0.8'], ['C', '150', '1.1']];
  const body = rows.flatMap((row, y) => row.map((cell, x) => `BT /F 12 Tf ${30 + x * 120} ${400 - y * 25} Td (${cell}) Tj ET`)).join('\n');
  doc.insertPage(-1, doc.addPage([0, 0, 500, 500], 0, { Font: { F: font } }, body));
  const data = doc.saveToBuffer('');
  const file = new File([Uint8Array.from(data.asUint8Array())], 'table.pdf');
  data.destroy();
  doc.destroy();
  const input = new FormData();
  input.append('files', file);
  const response = await extractTables(input);
  assert.equal(response.headers.get('X-PaperDock-Tables'), '1');
  const sheet = unzipSync(new Uint8Array(await response.arrayBuffer()));
  assert.match(strFromU8(sheet['xl/worksheets/sheet1.xml']), /r="B3"[^>]*><is><t[^>]*>135<\/t>/);
  const layout = await restoreLayout(file, 'layout-docx', 'ch');
  const zip = unzipSync(new Uint8Array(await layout.arrayBuffer()));
  assert.match(strFromU8(zip['word/document.xml']), /<w:tbl>[\s\S]*135/);
});
