'use client';

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import SignaturePad from 'signature_pad';
import { ChevronLeft, ChevronRight, Circle, Download, Eraser, Highlighter, MessageSquare, PenLine, PenTool, Search, Signature, Square, Strikethrough, Trash2, Underline, Undo2 } from 'lucide-react';
import { formOf, readError, renderPages, useWorkbench, type RenderedPage } from '../api';
import { mobileWorkbench } from '../platform';
import { Button, Card, Chip, Dialog, DropZone, Empty, Field, IconButton, PageHeader, Select, Switch } from '../ui';

type Tool = 'highlight' | 'underline' | 'strike' | 'rect' | 'circle' | 'note' | 'ink' | 'sign';
type Op = { type: Exclude<Tool, 'sign'>; page: number; rect?: number[]; points?: number[][]; text?: string; content?: string; color: string; category: string; status: string };
type Annotation = { page: number; xref: number; type: string; content: string; category: string; status: string; author: string };
const tools: [Tool, string, typeof Highlighter][] = [
  ['highlight', '高亮', Highlighter], ['underline', '下划线', Underline], ['strike', '删除线', Strikethrough],
  ['rect', '矩形', Square], ['circle', '圆形', Circle], ['note', '便签', MessageSquare], ['ink', '画笔', PenTool], ['sign', '签名', Signature],
];
const colors: Record<string, string> = { yellow: '#f9cf1a', green: '#33bf59', blue: '#1a73e8', red: '#db3328', pink: '#f266b3' };
const statuses = ['待处理', '已处理', '驳回'];
const typeNames: Record<string, string> = { Highlight: '高亮', Underline: '下划线', StrikeOut: '删除线', Squiggly: '波浪线', Text: '便签', Ink: '画笔', Square: '矩形', Circle: '圆形', FreeText: '文字框' };

export default function AnnotateView() {
  const { post, saveBlob, notify, busy } = useWorkbench();
  const [doc, setDoc] = useState<Blob | null>(null);
  const [name, setName] = useState('');
  const [count, setCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<RenderedPage | null>(null);
  const [tool, setTool] = useState<Tool>('highlight');
  const [color, setColor] = useState('yellow');
  const [category, setCategory] = useState('未分类');
  const [status, setStatus] = useState('待处理');
  const [noteText, setNoteText] = useState('');
  const [pending, setPending] = useState<Op[]>([]);
  const [draft, setDraftState] = useState<{ start: number[]; end: number[]; points: number[][] } | null>(null);
  // Pointer events can outrun React renders on quick drags, so the live stroke lives in a ref.
  const draftRef = useRef<typeof draft>(null);
  const setDraft = (value: typeof draft) => { draftRef.current = value; setDraftState(value); };
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [filterCategory, setFilterCategory] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [search, setSearch] = useState('');
  const [searchType, setSearchType] = useState<'highlight' | 'underline' | 'strike'>('highlight');
  const [signOpen, setSignOpen] = useState(false);
  const [signature, setSignature] = useState('');
  const [withDate, setWithDate] = useState(true);
  const overlay = useRef<HTMLDivElement>(null);
  const padCanvas = useRef<HTMLCanvasElement>(null);
  const pad = useRef<SignaturePad | null>(null);

  const refresh = async (blob: Blob, index: number) => {
    try {
      const data = await renderPages(post, blob, String(index + 1), 1.6, '正在加载页面');
      if (data) { setCount(data.count); setPage(data.pages[0]); }
      const response = await post('/annotate/list', formOf({ file: blob }), '正在读取批注');
      if (response?.ok) setAnnotations(((await response.json()) as { annotations: Annotation[] }).annotations);
    } catch (error) { notify(error instanceof Error ? error.message : '页面加载失败'); }
  };
  const open = (files: File[]) => {
    if (!files.length) return;
    setDoc(files[0]); setName(files[0].name.replace(/\.pdf$/i, '')); setPageIndex(0); setPending([]);
    void refresh(files[0], 0);
  };
  const go = (index: number) => { if (!doc || index < 0 || index >= count) return; setPageIndex(index); void refresh(doc, index); };
  // Replace the working copy with a server result so edits accumulate.
  const adopt = async (response: Response | null, success: string) => {
    if (!response) return false;
    if (!response.ok) { notify(await readError(response, '处理失败')); return false; }
    const blob = await response.blob();
    setDoc(blob); setPending([]); notify(success);
    await refresh(blob, pageIndex);
    return true;
  };

  const toPdf = (event: ReactPointerEvent) => {
    const box = overlay.current!.getBoundingClientRect();
    return [((event.clientX - box.left) / box.width) * page!.width, ((event.clientY - box.top) / box.height) * page!.height];
  };
  const down = (event: ReactPointerEvent) => {
    if (!page) return;
    const point = toPdf(event);
    if (tool === 'note') {
      setPending((old) => [...old, { type: 'note', page: pageIndex, rect: point, content: noteText || '批注', color, category, status }]);
      return;
    }
    if (tool === 'sign' && !signature) { setSignOpen(true); return; }
    overlay.current!.setPointerCapture(event.pointerId);
    setDraft({ start: point, end: point, points: [point] });
  };
  const move = (event: ReactPointerEvent) => {
    const current = draftRef.current;
    if (!current) return;
    const point = toPdf(event);
    setDraft({ ...current, end: point, points: tool === 'ink' ? [...current.points, point] : current.points });
  };
  const up = async (event: ReactPointerEvent) => {
    if (!draftRef.current) return;
    move(event);
    const draft = draftRef.current;
    const [x0, y0] = draft.start; const [x1, y1] = draft.end;
    const rect = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
    setDraft(null);
    if (tool === 'ink') {
      if (draft.points.length > 1) setPending((old) => [...old, { type: 'ink', page: pageIndex, points: draft.points, color, category, status }]);
      return;
    }
    if (rect[2] - rect[0] < 4 || rect[3] - rect[1] < 4) return;
    if (tool === 'sign') {
      const image = await (await fetch(signature)).blob();
      await adopt(await post('/pdf/sign', formOf({ file: doc!, signature: new File([image], 'signature.png', { type: 'image/png' }), page: String(pageIndex), rect: JSON.stringify(rect), date_text: withDate ? new Date().toLocaleDateString('zh-CN') : '' }), '正在签名'), '签名已加入，可继续编辑或保存。');
      return;
    }
    setPending((old) => [...old, { type: tool as Op['type'], page: pageIndex, rect, color, category, status }]);
  };
  const apply = async (ops: Op[]) => {
    if (!doc || !ops.length) return;
    const response = await post('/annotate/apply', formOf({ file: doc, ops: JSON.stringify(ops) }), '正在写入批注');
    await adopt(response, `已添加 ${response?.headers.get('X-PaperDock-Added') || ''} 条批注。`);
  };
  const update = async (item: Annotation, change: Partial<{ status: string; delete: boolean }>) => {
    if (!doc) return;
    await adopt(await post('/annotate/update', formOf({ file: doc, updates: JSON.stringify([{ page: item.page, xref: item.xref, ...change }]) }), '正在更新批注'), change.delete ? '批注已删除。' : '状态已更新。');
  };

  useEffect(() => {
    if (!signOpen || !padCanvas.current) return;
    const canvas = padCanvas.current;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = canvas.offsetWidth * ratio; canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext('2d')!.scale(ratio, ratio);
    pad.current = new SignaturePad(canvas, { penColor: '#0b1f4a', minWidth: 1, maxWidth: 3 });
    return () => { pad.current?.off(); pad.current = null; };
  }, [signOpen]);

  const categories = useMemo(() => Array.from(new Set(annotations.map((a) => a.category))), [annotations]);
  const shown = annotations.filter((a) => (!filterCategory || a.category === filterCategory) && (!filterStatus || a.status === filterStatus));
  const pendingHere = pending.filter((op) => op.page === pageIndex);
  const draftRect = draft && [Math.min(draft.start[0], draft.end[0]), Math.min(draft.start[1], draft.end[1]), Math.abs(draft.end[0] - draft.start[0]), Math.abs(draft.end[1] - draft.start[1])];

  if (!doc) return (
    <div className="md-view mx-auto max-w-3xl">
      <PageHeader title="批注与签名" subtitle="高亮、下划线、删除线、便签、画笔、形状；按类别和状态管理批注；手写签名。" />
      <Card><DropZone files={[]} onFiles={open} accept=".pdf" label="打开一份 PDF" hint="所有修改在新副本上进行，原文件不会被改动。" /></Card>
    </div>
  );

  return (
    <div className="md-view">
      <PageHeader title="批注与签名" detail={`${name}.pdf · 第 ${pageIndex + 1} / ${count} 页`} actions={<>
        <Button variant="text" onClick={() => { setDoc(null); setPage(null); setAnnotations([]); }}>关闭</Button>
        <Button variant="filled" icon={Download} onClick={() => void saveBlob(doc, `${name}-批注.pdf`)}>保存 PDF</Button>
      </>} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Card className="!p-3">
            <div className="flex flex-wrap items-center gap-1">
              {tools.map(([id, label, Icon]) => <IconButton key={id} icon={Icon} label={label} active={tool === id} onClick={() => { setTool(id); if (id === 'sign' && !signature) setSignOpen(true); }} />)}
              <span className="mx-2 h-6 w-px bg-m-outline-variant" />
              {Object.entries(colors).map(([key, value]) => <button key={key} type="button" aria-label={`颜色 ${key}`} onClick={() => setColor(key)} className={`size-6 rounded-full border-2 ${color === key ? 'border-m-on-surface' : 'border-transparent'}`} style={{ background: value }} />)}
              <div className="ml-auto flex items-center gap-1">
                <IconButton icon={Undo2} label="撤销上一个未应用的批注" disabled={!pending.length} onClick={() => setPending((old) => old.slice(0, -1))} />
                <Button variant="filled" icon={PenLine} className="min-w-[120px]" disabled={!pending.length || busy} onClick={() => void apply(pending)}>应用{pending.length ? ` ${pending.length}` : ''}</Button>
              </div>
            </div>
            <div className="mt-3 grid gap-3 px-1 sm:grid-cols-3">
              <Field label="类别" list="pd-categories" value={category} onChange={(e) => setCategory(e.target.value)} />
              <datalist id="pd-categories">{['未分类', '疑问', '重点', '错误', '术语', ...categories].filter((v, i, a) => a.indexOf(v) === i).map((c) => <option key={c} value={c} />)}</datalist>
              <Select label="状态" value={status} onChange={(e) => setStatus(e.target.value)}>{statuses.map((s) => <option key={s}>{s}</option>)}</Select>
              {tool === 'note' ? <Field label="便签内容（点击页面放置）" value={noteText} onChange={(e) => setNoteText(e.target.value)} /> : tool === 'sign' ? <div className="flex items-end gap-3 pb-1"><Switch checked={withDate} onChange={setWithDate} label="附加日期" /><Button variant="text" onClick={() => setSignOpen(true)}>重写签名</Button></div> : <p className="self-end pb-2 text-xs text-m-on-surface-variant">{tool === 'ink' ? '按住拖动自由绘制' : '在页面上拖出一个区域'}</p>}
            </div>
          </Card>
          <Card className="!p-4">
            <div className="mb-3 flex items-center justify-center gap-2">
              <IconButton icon={ChevronLeft} label="上一页" disabled={pageIndex === 0 || busy} onClick={() => go(pageIndex - 1)} />
              <span className="text-sm text-m-on-surface-variant">{pageIndex + 1} / {count}</span>
              <IconButton icon={ChevronRight} label="下一页" disabled={pageIndex >= count - 1 || busy} onClick={() => go(pageIndex + 1)} />
            </div>
            {page ? (
              <div className="relative mx-auto w-full max-w-[900px] select-none shadow-md">
                <img src={page.image} alt={`第 ${pageIndex + 1} 页`} className="block w-full" draggable={false} />
                <div ref={overlay} className={`absolute inset-0 touch-none ${tool === 'note' ? 'cursor-copy' : 'cursor-crosshair'}`} onPointerDown={down} onPointerMove={move} onPointerUp={(event) => void up(event)}>
                  <svg viewBox={`0 0 ${page.width} ${page.height}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full">
                    {pendingHere.map((op, i) => {
                      const c = colors[op.color];
                      if (op.type === 'ink') return <polyline key={i} points={op.points!.map((p) => p.join(',')).join(' ')} fill="none" stroke={c} strokeWidth={2} />;
                      if (op.type === 'note') return <circle key={i} cx={op.rect![0]} cy={op.rect![1]} r={7} fill={c} stroke="#fff" strokeWidth={2} />;
                      const [x0, y0, x1, y1] = op.rect!;
                      if (op.type === 'circle') return <ellipse key={i} cx={(x0 + x1) / 2} cy={(y0 + y1) / 2} rx={(x1 - x0) / 2} ry={(y1 - y0) / 2} fill="none" stroke={c} strokeWidth={2} />;
                      return <rect key={i} x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill={op.type === 'highlight' ? c : 'none'} fillOpacity={0.35} stroke={c} strokeWidth={op.type === 'highlight' ? 0 : 1.5} strokeDasharray={op.type === 'rect' ? undefined : '4 3'} />;
                    })}
                    {draft && tool === 'ink' && <polyline points={draft.points.map((p) => p.join(',')).join(' ')} fill="none" stroke={colors[color]} strokeWidth={2} />}
                    {draftRect && tool !== 'ink' && <rect x={draftRect[0]} y={draftRect[1]} width={draftRect[2]} height={draftRect[3]} fill={tool === 'sign' ? '#1a73e822' : colors[color]} fillOpacity={0.25} stroke={tool === 'sign' ? '#1a73e8' : colors[color]} strokeDasharray="4 3" />}
                  </svg>
                </div>
              </div>
            ) : <Empty icon={PenLine} title="正在加载页面…" />}
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="按文字批量标记" subtitle={mobileWorkbench ? undefined : '在全部页面中查找并标记'}>
            <Field label="要查找的文字" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="mt-3 flex flex-wrap gap-2">
              {([['highlight', '高亮'], ['underline', '下划线'], ['strike', '删除线']] as const).map(([id, label]) => <Chip key={id} selected={searchType === id} onClick={() => setSearchType(id)}>{label}</Chip>)}
            </div>
            <Button className="mt-3" variant="tonal" icon={Search} disabled={!search.trim() || busy} onClick={() => void apply([{ type: searchType, page: -1, text: search.trim(), color, category, status }])}>标记全部</Button>
          </Card>
          <Card title={`批注列表（${shown.length}/${annotations.length}）`}>
            <div className="flex flex-wrap gap-2">
              <Chip selected={!filterCategory} onClick={() => setFilterCategory('')}>全部类别</Chip>
              {categories.map((c) => <Chip key={c} selected={filterCategory === c} onClick={() => setFilterCategory(filterCategory === c ? '' : c)}>{c}</Chip>)}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Chip selected={!filterStatus} onClick={() => setFilterStatus('')}>全部状态</Chip>
              {statuses.map((s) => <Chip key={s} selected={filterStatus === s} onClick={() => setFilterStatus(filterStatus === s ? '' : s)}>{s}</Chip>)}
            </div>
            {shown.length ? (
              <ul className="mt-4 max-h-[520px] space-y-2 overflow-auto">
                {shown.map((a) => (
                  <li key={`${a.page}-${a.xref}`} className="rounded-xl border border-m-outline-variant p-3 text-sm">
                    <button type="button" className="w-full text-left" onClick={() => go(a.page)}>
                      <span className="font-medium text-m-on-surface">{typeNames[a.type] || a.type}</span>
                      <span className="text-m-on-surface-variant"> · 第 {a.page + 1} 页 · {a.category}{a.author ? ` · ${a.author}` : ''}</span>
                      {a.content && <span className="mt-1 block text-m-on-surface-variant">{a.content}</span>}
                    </button>
                    <div className="mt-2 flex items-center gap-2">
                      <select className="md-input !h-8 !w-auto !text-xs" value={a.status} disabled={busy} onChange={(e) => void update(a, { status: e.target.value })}>{statuses.map((s) => <option key={s}>{s}</option>)}</select>
                      <IconButton icon={Trash2} label="删除批注" className="ml-auto size-8" disabled={busy} onClick={() => void update(a, { delete: true })} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : <Empty icon={Eraser} title="没有符合条件的批注" />}
          </Card>
        </div>
      </div>
      <Dialog open={signOpen} title="手写签名" onClose={() => setSignOpen(false)} actions={<>
        <Button variant="text" onClick={() => pad.current?.clear()}>清除</Button>
        <Button variant="text" onClick={() => setSignOpen(false)}>取消</Button>
        <Button variant="filled" onClick={() => { if (!pad.current || pad.current.isEmpty()) return notify('请先在框内写下签名。'); setSignature(pad.current.toDataURL('image/png')); setTool('sign'); setSignOpen(false); notify('签名已就绪：在页面上拖出放置区域。'); }}>使用此签名</Button>
      </>}>
        <canvas ref={padCanvas} className="h-48 w-full touch-none rounded-2xl border border-m-outline-variant bg-white" />
        <p className="mt-2 text-xs text-m-on-surface-variant">{mobileWorkbench ? '用手指或触控笔书写，签名以图片形式写入 PDF。' : '用鼠标或触控笔书写。这是电子手写签名图片，不是数字证书签名。'}</p>
      </Dialog>
    </div>
  );
}
