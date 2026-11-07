'use client';

import { useState } from 'react';
import { Download, GitCompareArrows } from 'lucide-react';
import { API_URL, formOf, readError, useWorkbench } from '../api';
import { Button, Card, DropZone, Empty, PageHeader } from '../ui';

type Change = { type: 'insert' | 'delete' | 'replace'; old: string; new: string; page_old: number | null; page_new: number | null; context: string };
type Result = { job_id: string; similarity: number; stats: Record<string, number>; changes: Change[]; truncated: boolean; report: string | null };
const TYPES = '.pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.bmp,.tif,.tiff';

export default function CompareView() {
  const { post, saveBlob, notify, busy } = useWorkbench();
  const [oldFile, setOldFile] = useState<File[]>([]);
  const [newFile, setNewFile] = useState<File[]>([]);
  const [result, setResult] = useState<Result | null>(null);

  const run = async () => {
    const response = await post('/compare', formOf({ file_a: oldFile[0], file_b: newFile[0] }), '正在对比文档');
    if (!response) return;
    if (!response.ok) return notify(await readError(response, '对比失败'));
    setResult(await response.json());
  };
  const report = async () => {
    if (!result?.report) return;
    const response = await fetch(`${API_URL}/jobfile/${result.job_id}/${result.report}`);
    if (!response.ok) return notify(await readError(response, '报告已过期'));
    await saveBlob(await response.blob(), '对比报告.pdf');
  };

  return (
    <div className="md-view mx-auto max-w-5xl">
      <PageHeader title="文档对比" subtitle="找出两个版本之间改了什么：PDF、Word、TXT 或图片（自动 OCR）。" />
      <div className="grid gap-6 md:grid-cols-2">
        <Card title="旧版本"><DropZone files={oldFile} onFiles={setOldFile} accept={TYPES} label="选择旧版本" compact /></Card>
        <Card title="新版本"><DropZone files={newFile} onFiles={setNewFile} accept={TYPES} label="选择新版本" compact /></Card>
      </div>
      <div className="mt-4 flex justify-end"><Button variant="filled" icon={GitCompareArrows} disabled={!oldFile.length || !newFile.length || busy} onClick={() => void run()}>开始对比</Button></div>
      {result && (
        <Card className="mt-6" title="对比结果" actions={result.report && <Button variant="tonal" icon={Download} onClick={() => void report()}>下载并排对比 PDF</Button>}>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[['相似度', `${result.similarity}%`], ['新增', result.stats.insert], ['删除', result.stats.delete], ['修改', result.stats.replace]].map(([label, value]) => (
              <div key={label} className="rounded-2xl bg-m-surface-container-low p-4"><p className="text-xs text-m-on-surface-variant">{label}</p><p className="mt-1 text-2xl text-m-on-surface">{value}</p></div>
            ))}
          </div>
          {result.changes.length ? (
            <ul className="max-h-[560px] divide-y divide-m-outline-variant overflow-auto rounded-2xl border border-m-outline-variant">
              {result.changes.map((c, i) => (
                <li key={i} className="px-4 py-3 text-sm leading-6">
                  <p className="text-xs text-m-on-surface-variant">{c.type === 'insert' ? '新增' : c.type === 'delete' ? '删除' : '修改'} · {c.page_old ? `旧第 ${c.page_old} 页` : ''}{c.page_old && c.page_new ? ' → ' : ''}{c.page_new ? `新第 ${c.page_new} 页` : ''}{c.context && ` · …${c.context}`}</p>
                  {c.old && <p><del className="rounded bg-m-error-container px-1 text-m-on-error-container">{c.old}</del></p>}
                  {c.new && <p><ins className="rounded bg-m-tertiary-container px-1 text-m-on-tertiary-container no-underline">{c.new}</ins></p>}
                </li>
              ))}
            </ul>
          ) : <Empty icon={GitCompareArrows} title="两份文档文字内容完全一致" />}
          {result.truncated && <p className="mt-3 text-xs text-m-on-surface-variant">差异较多，列表只显示前 500 处；并排 PDF 中标出了全部差异。</p>}
        </Card>
      )}
    </div>
  );
}
