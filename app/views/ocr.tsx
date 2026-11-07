'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, FileDown, FolderOpen, Play, RotateCcw, Save, ScanText, Square, Trash2 } from 'lucide-react';
import { API_URL, errorMessage, fileSize, readError, useWorkbench } from '../api';
import { Button, Card, Chip, DropZone, Empty, LinearProgress, PageHeader } from '../ui';

type OcrLine = { text: string; score: number; page: number };
type OcrItem = { lines?: OcrLine[]; filename: string; text: string; pages: number; job_id: string };
type OcrResult = { text: string; job_id: string; exports: Record<string, string>; pages: number; filename?: string; items?: OcrItem[] };
type QueueFile = { source: File; status: string; recognized?: OcrItem };
type RecentRun = { name: string; pages: number; at: string };
const LIMIT = 10;
const OCR_TYPES = '.pdf,.jpg,.jpeg,.png,.bmp,.tif,.tiff';

export default function OcrView() {
  const { notify, saveBlob, post } = useWorkbench();
  const [queue, setQueue] = useState<QueueFile[]>([]);
  const [result, setResult] = useState<OcrResult | null>(null);
  const [draft, setDraft] = useState('');
  const [reviewIndex, setReviewIndex] = useState(0);
  const [mode, setMode] = useState<'auto' | 'handwriting' | 'english'>('auto');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [recent, setRecent] = useState<RecentRun[]>([]);
  const [previewUrl, setPreviewUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const stop = useRef(false);
  const projectPicker = useRef<HTMLInputElement>(null);

  const selectedJob = result?.items?.[reviewIndex]?.job_id;
  const selectedSource = selectedJob ? queue.find((item) => item.recognized?.job_id === selectedJob)?.source : undefined;
  useEffect(() => {
    if (!selectedSource) { setPreviewUrl(''); return; }
    const url = URL.createObjectURL(selectedSource);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedSource]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('paperdock-recent-ocr') || '[]');
      if (Array.isArray(saved)) setRecent(saved.slice(0, 5));
    } catch { /* A damaged preference must never block recognition. */ }
  }, []);

  const addFiles = (files: File[]) => {
    if (running) return;
    const room = LIMIT - queue.length;
    if (room <= 0) return notify(`队列最多 ${LIMIT} 个文件，请先移除一些。`);
    setQueue((old) => [...old, ...files.slice(0, room).map((source) => ({ source, status: '等待识别' }))]);
    notify(files.length > room ? `已加入 ${room} 个文件，其余超出队列上限。` : `已加入 ${files.length} 个文件。`);
  };
  // Ctrl+V a screenshot straight into the queue.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const images = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'));
      if (images.length) addFiles(images.map((file, i) => new File([file], `粘贴的截图-${Date.now()}-${i + 1}.png`, { type: file.type })));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  const snip = async () => {
    notify('请框选屏幕区域，截图会自动加入队列（Esc 取消）。');
    const response = await post('/capture/snip', new FormData(), '等待截图');
    if (!response) return;
    if (!response.ok) return notify(await readError(response, '截图失败'));
    addFiles([new File([await response.blob()], `截图-${new Date().toLocaleTimeString().replaceAll(':', '')}.png`, { type: 'image/png' })]);
  };

  const run = async (retryOnly = false) => {
    if (!queue.length) return notify('请先添加 PDF 或图片。');
    setRunning(true);
    stop.current = false;
    const targets = queue.filter((item) => !retryOnly || !item.recognized);
    setProgress({ completed: 0, total: targets.length });
    setReviewIndex(0);
    const done = new Map<File, OcrItem>();
    if (retryOnly) queue.forEach((item) => { if (item.recognized) done.set(item.source, result?.items?.find((r) => r.job_id === item.recognized?.job_id) || item.recognized); });
    try {
      for (let index = 0; index < queue.length; index += 1) {
        const item = queue[index];
        if (stop.current) break;
        if (retryOnly && item.recognized) continue;
        setQueue((old) => old.map((file, i) => (i === index ? { ...file, recognized: undefined, status: '识别中…' } : file)));
        const body = new FormData();
        body.append('file', item.source);
        body.append('language', mode === 'english' ? 'en' : 'ch');
        try {
          const response = await fetch(`${API_URL}/ocr`, { method: 'POST', body });
          const data = (await response.json()) as OcrResult & { detail?: unknown };
          if (!response.ok) throw new Error(errorMessage(data.detail, 'OCR 服务错误'));
          const recognized = { filename: data.filename || item.source.name, text: data.text, pages: data.pages, job_id: data.job_id, lines: (data as unknown as OcrItem).lines };
          done.set(item.source, recognized);
          setQueue((old) => old.map((file, i) => (i === index ? { ...file, recognized, status: '已完成' } : file)));
        } catch (error) {
          setQueue((old) => old.map((file, i) => (i === index ? { ...file, status: '失败，可重试' } : file)));
          notify(`“${item.source.name}”识别失败：${error instanceof Error ? error.message : '未知错误'}`);
        }
        setProgress((old) => ({ ...old, completed: old.completed + 1 }));
      }
      const items = queue.flatMap((item) => (done.has(item.source) ? [done.get(item.source)!] : []));
      if (!items.length) return notify('没有文件识别成功，请检查失败项后重试。');
      const response = await fetch(`${API_URL}/ocr/combine`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
      const data = (await response.json()) as OcrResult & { detail?: unknown };
      if (!response.ok) throw new Error(errorMessage(data.detail, '合并导出失败'));
      setResult(data);
      setDraft(items[0].text);
      const nextRecent = [{ name: data.filename || '批量识别', pages: data.pages, at: new Date().toLocaleString() }, ...recent].slice(0, 5);
      setRecent(nextRecent);
      try { localStorage.setItem('paperdock-recent-ocr', JSON.stringify(nextRecent)); } catch { /* optional */ }
      notify(stop.current ? `已停止，保留 ${items.length} 份结果。` : `识别完成：${items.length}/${queue.length} 个文件，可逐份校对后导出。`);
    } catch (error) {
      notify(`识别未完成：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setRunning(false);
    }
  };

  const downloadExport = async (jobId: string, name: string) => {
    try {
      const response = await fetch(`${API_URL}/download/${jobId}/${name}`);
      if (!response.ok) return notify(await readError(response, '导出文件下载失败'));
      await saveBlob(await response.blob(), name);
    } catch { notify('获取导出文件失败，请检查本地服务。'); }
  };

  const combined = (items: OcrItem[]) => items.map((item) => `【文件：${item.filename}】\n${item.text}`.trim()).join('\n\n');
  const saveCorrection = async (format: string) => {
    if (!result) return;
    setSaving(true);
    try {
      const items = result.items?.map((item, i) => (i === reviewIndex ? { ...item, text: draft } : item));
      const text = items ? combined(items) : draft;
      const response = await fetch(`${API_URL}/exports/${result.job_id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const data = (await response.json()) as { exports?: Record<string, string>; detail?: unknown };
      if (!response.ok || !data.exports) return notify(errorMessage(data.detail, '校对结果保存失败'));
      setResult({ ...result, text, items, exports: data.exports });
      await downloadExport(result.job_id, data.exports[format]);
    } catch { notify('无法连接本地导出服务。'); } finally { setSaving(false); }
  };

  const saveProject = () => saveBlob(new Blob([JSON.stringify({ format: 'paperdock', version: 1, saved_at: new Date().toISOString(), result, draft, reviewIndex, settings: { ocrMode: mode } }, null, 2)], { type: 'application/json' }), '我的工程.paperdock.json');
  const openProject = async (file?: File) => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.format !== 'paperdock' || data.version !== 1 || typeof data.draft !== 'string') throw new Error('工程文件格式不正确');
      if (data.result) {
        const response = await fetch(`${API_URL}/ocr/combine`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: data.result.items || [{ filename: '恢复的工程', text: data.result.text, pages: data.result.pages, job_id: '' }] }) });
        if (!response.ok) throw new Error('恢复导出文件失败');
        setResult(await response.json());
      } else setResult(null);
      setDraft(data.draft);
      setReviewIndex(Number(data.reviewIndex) || 0);
      if (['auto', 'handwriting', 'english'].includes(data.settings?.ocrMode)) setMode(data.settings.ocrMode);
      setQueue([]);
      notify('工程已恢复。如需对照原图，请重新添加原文件。');
    } catch (error) { notify(error instanceof Error ? error.message : '打开工程失败'); }
  };

  const items = result?.items || [];
  const lowConfidence = (items[reviewIndex]?.lines || []).filter((line) => line.score < 0.85);
  return (
    <div className="md-view">
      <PageHeader
        title="文字识别 OCR"
        subtitle="图片、扫描件转可编辑文字；文件只在这台电脑上处理。"
        actions={<>
          <input ref={projectPicker} type="file" accept=".json" hidden onChange={(event) => { void openProject(event.target.files?.[0]); event.target.value = ''; }} />
          <Button variant="outlined" icon={FolderOpen} onClick={() => projectPicker.current?.click()}>打开工程</Button>
          <Button variant="tonal" icon={Save} onClick={() => void saveProject()}>保存工程</Button>
        </>}
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-6">
          <Card>
            <DropZone files={[]} onFiles={addFiles} accept={OCR_TYPES} multiple label="拖入或点击选择 PDF / 图片" hint={`支持 PDF、JPG、PNG、BMP、TIF；也可以直接 Ctrl+V 粘贴截图。队列最多 ${LIMIT} 个。`} />
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button variant="outlined" icon={Camera} onClick={() => void snip()} disabled={running}>截图识别</Button>
              <span className="ml-auto text-sm text-m-on-surface-variant">{queue.length}/{LIMIT} 个文件</span>
              {queue.length > 0 && <Button variant="text" icon={Trash2} disabled={running} onClick={() => setQueue([])}>清空</Button>}
            </div>
            {queue.length > 0 && (
              <ul className="mt-3 divide-y divide-m-outline-variant overflow-hidden rounded-2xl border border-m-outline-variant">
                {queue.map((item, index) => (
                  <li key={`${item.source.name}-${index}`} className="flex items-center gap-3 px-4 py-3">
                    <ScanText size={18} className="shrink-0 text-m-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-m-on-surface">{item.source.name}</p>
                      <p className="text-xs text-m-on-surface-variant">{fileSize(item.source.size)}</p>
                    </div>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs ${item.recognized ? 'bg-m-tertiary-container text-m-on-tertiary-container' : item.status.startsWith('失败') ? 'bg-m-error-container text-m-on-error-container' : 'bg-m-surface-container-high text-m-on-surface-variant'}`}>{item.status}</span>
                    <button type="button" disabled={running} aria-label={`移除 ${item.source.name}`} onClick={() => setQueue((old) => old.filter((_, i) => i !== index))} className="grid size-8 place-items-center rounded-full text-m-on-surface-variant hover:bg-m-on-surface/8 disabled:opacity-40"><Trash2 size={16} /></button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {result && (
            <Card title={`原文件对照 · ${items[reviewIndex]?.filename || ''}`}>
              {previewUrl ? (selectedSource?.name.toLowerCase().endsWith('.pdf') ? <iframe title="PDF 原文件对照" src={previewUrl} className="h-[600px] w-full rounded-xl" /> : <img alt="当前校对文件原图" src={previewUrl} className="max-h-[800px] w-full rounded-xl object-contain" />) : <p className="text-sm text-m-on-surface-variant">打开工程后需要重新添加原文件才能对照原图。</p>}
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card title="识别设置">
            <div className="flex flex-wrap gap-2">
              {([['auto', '自动（中英）'], ['handwriting', '手写优先'], ['english', '英文优先']] as const).map(([value, label]) => <Chip key={value} selected={mode === value} onClick={() => setMode(value)}>{label}</Chip>)}
            </div>
            <p className="mt-3 text-xs leading-5 text-m-on-surface-variant">已自动扶正、去噪并整理阅读顺序。手写内容建议识别后人工校对。</p>
            {running ? (
              <div className="mt-5 space-y-3" role="status">
                <LinearProgress value={(progress.completed / (progress.total || 1)) * 100} />
                <p className="text-sm text-m-on-surface-variant">已处理 {progress.completed} / {progress.total} 个文件</p>
                <Button variant="outlined" icon={Square} onClick={() => { stop.current = true; notify('当前文件完成后停止。'); }}>停止后续</Button>
              </div>
            ) : (
              <div className="mt-5 flex flex-wrap gap-2">
                <Button variant="filled" icon={Play} onClick={() => void run()} disabled={!queue.length}>开始识别</Button>
                {queue.some((f) => !f.recognized) && queue.some((f) => f.recognized) && <Button variant="outlined" icon={RotateCcw} onClick={() => void run(true)}>只重试未完成</Button>}
              </div>
            )}
          </Card>
          {result ? (
            <Card title="人工校对" subtitle={`${result.pages} 页 · 修改后可重新导出`}>
              {items.length > 1 && (
                <select className="md-input mb-3" value={reviewIndex} onChange={(event) => { const index = Number(event.target.value); setReviewIndex(index); setDraft(items[index]?.text || ''); }}>
                  {items.map((item, index) => <option key={`${item.job_id}-${index}`} value={index}>{index + 1}. {item.filename}（{item.pages} 页）</option>)}
                </select>
              )}
              <textarea className="md-input h-96" value={draft} onChange={(event) => { const text = event.target.value; setDraft(text); setResult((old) => (old ? { ...old, items: old.items?.map((item, i) => (i === reviewIndex ? { ...item, text } : item)) } : old)); }} />
              {lowConfidence.length > 0 && (
                <details className="mt-3 rounded-xl bg-m-tertiary-container/50 p-3 text-sm">
                  <summary className="cursor-pointer text-m-on-surface">低置信度的行（{lowConfidence.length} 处），建议重点核对</summary>
                  {lowConfidence.map((line, index) => <p key={index} className="mt-2 text-m-on-surface-variant">第 {line.page} 页 · {Math.round(line.score * 100)}%：{line.text}</p>)}
                </details>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                {(['docx', 'xlsx', 'txt'] as const).map((format) => <Button key={format} variant={format === 'docx' ? 'filled' : 'tonal'} icon={FileDown} loading={saving && format === 'docx'} onClick={() => void saveCorrection(format)}>{format.toUpperCase()}</Button>)}
              </div>
            </Card>
          ) : (
            <Card><Empty icon={ScanText} title="识别结果会显示在这里">添加文件后点击“开始识别”。</Empty></Card>
          )}
          {recent.length > 0 && (
            <Card title="最近识别">
              <ul className="space-y-2 text-sm">{recent.map((item, index) => <li key={index} className="flex justify-between gap-3 text-m-on-surface-variant"><span className="truncate text-m-on-surface">{item.name}</span><span className="shrink-0">{item.pages} 页 · {item.at}</span></li>)}</ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
