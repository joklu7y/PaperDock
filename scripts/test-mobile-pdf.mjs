// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Font, PDFDocument } from 'mupdf';
import { unzipSync } from 'fflate';
import { mergePdf, organizePdf, renderPdf, repairPdf, securePdf, splitPdf, transformPdf } from '../mobile/workbench/pdf.ts';

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
