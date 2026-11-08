const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../app/views/ocr.tsx'), 'utf8');
const stateNames = [...source.matchAll(/const \[(\w+),[^\]]+\] = useState/g)].map(match => match[1]);
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  jsx: ts.JsxEmit.ReactJSX,
} }).outputText;

function render(overrides) {
  let index = 0;
  const effects = [];
  const exports = {};
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === '../api') return { useWorkbench: () => ({}), fileSize: () => '1 MB' };
    if (name === '../platform') return { mobileWorkbench: false };
    if (name === '../ui') return Object.fromEntries(
      ['Button', 'Card', 'Chip', 'DropZone', 'Empty', 'LinearProgress', 'PageHeader'].map(name => [name, () => null]),
    );
    if (name === 'react') return {
      useState(initial) {
        const key = stateNames[index++];
        return [Object.hasOwn(overrides, key) ? overrides[key] : initial, () => {}];
      },
      useRef: current => ({ current }),
      useEffect: (fn, deps) => effects.push({ fn, deps }),
    };
    return require(name);
  } });
  assert.ok(exports.default(), 'OCR view must render');
  return effects;
}
const first = { name: 'english.jpeg' };
const second = { name: 'chinese.jpg' };
const items = [
  { filename: first.name, job_id: 'en', text: 'English text', pages: 1, lines: [] },
  { filename: second.name, job_id: 'ch', text: '中文文字', pages: 1, lines: [] },
];
const queue = [first, second].map((source, index) => ({
  source, name: source.name, type: 'JPG', size: '1 MB', status: '已完成', recognized: items[index],
}));
const result = { items, text: 'English text\n中文文字', pages: 2, job_id: 'combined', exports: {} };
render({});
const pendingEffects = render({ queue, result: null });
assert.ok(!pendingEffects.some(effect => effect.deps?.includes(first)), 'No preview before a selected result exists');
for (const reviewIndex of [0, 1]) {
  const effects = render({ queue, result, reviewIndex });
  assert.ok(effects.some(effect => effect.deps?.[0] === queue[reviewIndex].source), 'Preview must match selected result');
}
render({ queue: [], result, reviewIndex: 1 });
render({ queue, result: { ...result, items: undefined } });
console.log('PASS: empty queue, pending results, two completed files, selected preview, restored project, legacy result');
