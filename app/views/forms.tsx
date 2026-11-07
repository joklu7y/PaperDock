'use client';

import { useState } from 'react';
import { ClipboardList, Download } from 'lucide-react';
import { formOf, readError, useWorkbench } from '../api';
import { Button, Card, DropZone, Empty, Field, PageHeader, Select, Switch } from '../ui';

type FormField = { page: number; xref: number; name: string; label: string; type: string; value: string | boolean; options: string[]; on: string | null };

export default function FormsView() {
  const { post, saveResponse, notify, busy } = useWorkbench();
  const [file, setFile] = useState<File[]>([]);
  const [fields, setFields] = useState<FormField[] | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [flatten, setFlatten] = useState(false);

  const open = async (picked: File[]) => {
    setFile(picked); setFields(null); setValues({});
    if (!picked.length) return;
    const response = await post('/forms/fields', formOf({ file: picked[0] }), '正在读取表单');
    if (!response) return;
    if (!response.ok) return notify(await readError(response, '读取表单失败'));
    const list = ((await response.json()) as { fields: FormField[] }).fields;
    setFields(list);
    setValues(Object.fromEntries(list.map((f) => [`${f.page}:${f.xref}`, f.type === 'checkbox' || f.type === 'radio' ? Boolean(f.value && f.value !== 'Off') : String(f.value ?? '')])));
  };
  const save = async () => {
    const response = await post('/forms/fill', formOf({ file: file[0], values: JSON.stringify(values), flatten: String(flatten) }), '正在填写表单');
    const filled = response?.headers.get('X-PaperDock-Filled');
    if (await saveResponse(response, 'filled.pdf')) notify(`已填写 ${filled || ''} 个字段${flatten ? '，并固化为静态内容' : ''}。`);
  };

  return (
    <div className="md-view mx-auto max-w-4xl">
      <PageHeader title="填写 PDF 表单" subtitle="读取 PDF 里的可填写字段，在这里填好后导出。" />
      <Card><DropZone files={file} onFiles={(f) => void open(f)} accept=".pdf" label="选择带表单的 PDF" compact /></Card>
      {fields && (
        <Card className="mt-6" title={`表单字段（${fields.length}）`} actions={fields.length > 0 && <Button variant="filled" icon={Download} disabled={busy} onClick={() => void save()}>填写并保存</Button>}>
          {fields.length ? (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                {fields.map((f) => {
                  const key = `${f.page}:${f.xref}`;
                  const label = `${f.label || f.name}（第 ${f.page + 1} 页）`;
                  if (f.type === 'checkbox' || f.type === 'radio') return <div key={key} className="flex items-end pb-2"><Switch checked={Boolean(values[key])} onChange={(v) => setValues((old) => ({ ...old, [key]: v }))} label={label} /></div>;
                  if (f.options.length) return <Select key={key} label={label} value={String(values[key])} onChange={(e) => setValues((old) => ({ ...old, [key]: e.target.value }))}><option value="" />{f.options.map((o) => <option key={o}>{o}</option>)}</Select>;
                  return <Field key={key} label={label} value={String(values[key] ?? '')} onChange={(e) => setValues((old) => ({ ...old, [key]: e.target.value }))} />;
                })}
              </div>
              <div className="mt-6 border-t border-m-outline-variant pt-4"><Switch checked={flatten} onChange={setFlatten} label="扁平化：把填写内容固化成普通页面内容，别人无法再修改" /></div>
            </>
          ) : <Empty icon={ClipboardList} title="这份 PDF 没有可填写的字段">扫描件或普通 PDF 没有表单域，可以用“批注与签名”里的便签或签名代替。</Empty>}
        </Card>
      )}
    </div>
  );
}
