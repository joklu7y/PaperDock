'use client';

import { useState } from 'react';
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, CheckSquare, Combine, Crop, Download, FilePlus2, Files, Repeat, RotateCcw, RotateCw, Scissors, Stamp, Trash2 } from 'lucide-react';
import { formOf, renderPages, useWorkbench } from '../api';
import { Button, Card, Chip, DropZone, Empty, Field, IconButton, PageHeader, Select } from '../ui';

type Thumb = { id: string; src: number | null; rotate: number; image?: string; ratio: number };
const tabs = [['organize', '整理页面'], ['merge', '合并'], ['split', '拆分'], ['stamp', '水印与裁切']] as const;

function PageTile({ page, number, selected, onToggle, onRotate, onRemove }: { page: Thumb; number: number; selected: boolean; onToggle: () => void; onRotate: (delta: number) => void; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined }} className={`pd-page-tile group relative rounded-2xl border-2 bg-m-surface-container-lowest p-2 transition-shadow ${selected ? 'border-m-primary' : 'border-transparent'} ${isDragging ? 'shadow-xl' : 'hover:shadow-md'}`}>
      <div {...attributes} {...listeners} onClick={onToggle} className="grid aspect-[3/4] cursor-grab place-items-center overflow-hidden rounded-xl bg-m-surface-container active:cursor-grabbing">
        {page.image ? <img src={page.image} alt={`第 ${number} 页`} draggable={false} className="max-h-full max-w-full shadow-sm transition-transform" style={{ transform: `rotate(${page.rotate}deg)` }} /> : <span className="text-xs text-m-on-surface-variant">空白页</span>}
      </div>
      <div className="mt-1 flex items-center justify-between">
        <span className="pl-1 text-xs text-m-on-surface-variant">{number}{page.src !== null && page.src + 1 !== number ? `（原 ${page.src + 1}）` : ''}</span>
        <div className="flex opacity-70 group-hover:opacity-100">
          <IconButton icon={RotateCcw} label="向左旋转" className="size-8" onClick={() => onRotate(-90)} />
          <IconButton icon={RotateCw} label="向右旋转" className="size-8" onClick={() => onRotate(90)} />
          <IconButton icon={Trash2} label="删除此页" className="size-8" onClick={onRemove} />
        </div>
      </div>
    </div>
  );
}

export default function PagesView() {
  const { post, saveResponse, notify, busy } = useWorkbench();
  const [tab, setTab] = useState<(typeof tabs)[number][0]>('organize');
  const [file, setFile] = useState<File[]>([]);
  const [pages, setPages] = useState<Thumb[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mergeFiles, setMergeFiles] = useState<File[]>([]);
  const [splitMode, setSplitMode] = useState<'each' | 'ranges'>('ranges');
  const [ranges, setRanges] = useState('');
  const [stampFile, setStampFile] = useState<File[]>([]);
  const [watermark, setWatermark] = useState('');
  const [stampPages, setStampPages] = useState('');
  const [margin, setMargin] = useState('18');
  const [rotation, setRotation] = useState('90');
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 240, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const load = async (picked: File[]) => {
    setFile(picked);
    setPages([]);
    setSelected(new Set());
    if (!picked.length) return;
    try {
      const data = await renderPages(post, picked[0], '', 0.3, '正在生成页面缩略图');
      if (data) setPages(data.pages.map((p) => ({ id: `p${p.index}`, src: p.index, rotate: 0, image: p.image, ratio: p.width / p.height })));
    } catch (error) { notify(error instanceof Error ? error.message : '预览失败'); }
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) setPages((old) => arrayMove(old, old.findIndex((p) => p.id === active.id), old.findIndex((p) => p.id === over.id)));
  };
  const toggle = (id: string) => setSelected((old) => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const targets = (page: Thumb) => !selected.size || selected.has(page.id);
  const rotateSelected = (delta: number) => setPages((old) => old.map((p) => (targets(p) ? { ...p, rotate: (p.rotate + delta + 360) % 360 } : p)));
  const removeSelected = () => { if (selected.size === pages.length) return notify('至少需要保留一页。'); setPages((old) => old.filter((p) => !selected.has(p.id))); setSelected(new Set()); };
  const insertBlank = () => {
    const last = Math.max(-1, ...pages.map((p, i) => (selected.has(p.id) ? i : -1)));
    const blank = { id: `b${crypto.randomUUID()}`, src: null, rotate: 0, ratio: pages[0]?.ratio || 0.707 };
    setPages((old) => { const at = last >= 0 ? last + 1 : old.length; return [...old.slice(0, at), blank, ...old.slice(at)]; });
  };
  const save = async (onlySelected = false) => {
    const list = onlySelected ? pages.filter((p) => selected.has(p.id)) : pages;
    if (!file.length || !list.length) return notify(onlySelected ? '请先点击缩略图选择要导出的页面。' : '请先选择 PDF。');
    const plan = list.map((p) => ({ src: p.src, rotate: p.rotate }));
    await saveResponse(await post('/pdf/organize', formOf({ file: file[0], plan: JSON.stringify(plan) }), '正在生成新 PDF'), onlySelected ? 'extracted.pdf' : 'organized.pdf');
  };
  const moveMerge = (index: number, delta: number) => setMergeFiles((old) => { const next = [...old]; const target = index + delta; if (target < 0 || target >= next.length) return old; [next[index], next[target]] = [next[target], next[index]]; return next; });
  const transform = async (action: 'watermark' | 'crop' | 'rotate') => {
    if (!stampFile.length) return notify('请先选择 PDF。');
    if (action === 'watermark' && !watermark.trim()) return notify('请输入水印文字。');
    await saveResponse(await post('/pdf/transform', formOf({ file: stampFile[0], action, pages: stampPages, watermark_text: watermark, crop_margin: margin, degrees: rotation }), '正在处理 PDF'), 'processed.pdf');
  };

  return (
    <div className="md-view">
      <PageHeader title="页面整理" subtitle="拖拽排序、旋转、删除、插入空白页；合并、拆分、加水印。" />
      <div className="mb-6 flex flex-wrap gap-2">{tabs.map(([id, label]) => <Chip key={id} selected={tab === id} onClick={() => setTab(id)}>{label}</Chip>)}</div>

      {tab === 'organize' && (
        <Card>
          {!pages.length ? (
            <DropZone files={file} onFiles={(f) => void load(f)} accept=".pdf" label="选择要整理的 PDF" hint="生成缩略图后可拖拽排序；点击缩略图可多选。" />
          ) : (
            <>
              <div className="pd-page-toolbar sticky top-0 z-20 -mx-2 mb-4 flex flex-wrap items-center gap-2 rounded-2xl bg-m-surface-container-lowest/95 px-2 py-2 backdrop-blur">
                <span className="mr-2 text-sm text-m-on-surface-variant">{file[0]?.name} · {pages.length} 页{selected.size ? ` · 已选 ${selected.size}` : ''}</span>
                <IconButton icon={CheckSquare} label={selected.size === pages.length ? '取消全选' : '全选'} onClick={() => setSelected(selected.size === pages.length ? new Set() : new Set(pages.map((p) => p.id)))} />
                <IconButton icon={RotateCcw} label="向左旋转（所选或全部）" onClick={() => rotateSelected(-90)} />
                <IconButton icon={RotateCw} label="向右旋转（所选或全部）" onClick={() => rotateSelected(90)} />
                <IconButton icon={Trash2} label="删除所选" disabled={!selected.size} onClick={removeSelected} />
                <IconButton icon={FilePlus2} label="在所选后插入空白页" onClick={insertBlank} />
                <IconButton icon={Repeat} label="倒序排列" onClick={() => setPages((old) => [...old].reverse())} />
                <div className="ml-auto flex flex-wrap gap-2">
                  <Button variant="text" onClick={() => void load([])}>换一个文件</Button>
                  <Button variant="outlined" icon={Files} disabled={!selected.size || busy} onClick={() => void save(true)}>仅导出所选</Button>
                  <Button variant="filled" icon={Download} disabled={busy} onClick={() => void save()}>保存为新 PDF</Button>
                </div>
              </div>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={pages.map((p) => p.id)} strategy={rectSortingStrategy}>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                    {pages.map((page, index) => (
                      <PageTile key={page.id} page={page} number={index + 1} selected={selected.has(page.id)} onToggle={() => toggle(page.id)}
                        onRotate={(delta) => setPages((old) => old.map((p) => (p.id === page.id ? { ...p, rotate: (p.rotate + delta + 360) % 360 } : p)))}
                        onRemove={() => (pages.length > 1 ? setPages((old) => old.filter((p) => p.id !== page.id)) : notify('至少需要保留一页。'))} />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </>
          )}
        </Card>
      )}

      {tab === 'merge' && (
        <Card title="合并 PDF" subtitle="按列表顺序拼成一份，可用箭头调整顺序（2–10 份）">
          <DropZone files={[]} onFiles={(f) => setMergeFiles((old) => [...old, ...f].slice(0, 10))} accept=".pdf" multiple label="添加 PDF" />
          {mergeFiles.length ? (
            <ol className="mt-4 divide-y divide-m-outline-variant rounded-2xl border border-m-outline-variant">
              {mergeFiles.map((item, index) => (
                <li key={`${item.name}-${index}`} className="flex items-center gap-2 px-4 py-2 text-sm">
                  <span className="w-6 text-m-on-surface-variant">{index + 1}</span><span className="flex-1 truncate">{item.name}</span>
                  <IconButton icon={ArrowUp} label="上移" disabled={!index} onClick={() => moveMerge(index, -1)} />
                  <IconButton icon={ArrowDown} label="下移" disabled={index === mergeFiles.length - 1} onClick={() => moveMerge(index, 1)} />
                  <IconButton icon={Trash2} label="移除" onClick={() => setMergeFiles((old) => old.filter((_, i) => i !== index))} />
                </li>
              ))}
            </ol>
          ) : <Empty icon={Combine} title="还没有添加文件" />}
          <div className="mt-4 flex justify-end"><Button variant="filled" icon={Combine} disabled={mergeFiles.length < 2 || busy} onClick={async () => { await saveResponse(await post('/pdf/merge', formOf({ files: mergeFiles }), '正在合并 PDF'), 'merged.pdf'); }}>合并并保存</Button></div>
        </Card>
      )}

      {tab === 'split' && (
        <Card title="拆分 PDF" subtitle="结果打包为 ZIP">
          <DropZone files={file} onFiles={setFile} accept=".pdf" label="选择 PDF" compact />
          <div className="mt-4 flex flex-wrap gap-2">
            <Chip selected={splitMode === 'ranges'} onClick={() => setSplitMode('ranges')}>按范围</Chip>
            <Chip selected={splitMode === 'each'} onClick={() => setSplitMode('each')}>每页一个文件</Chip>
          </div>
          {splitMode === 'ranges' && <Field className="mt-4" label="页码范围" hint="用逗号分隔，每段生成一个 PDF，例如 1-3,4-6,7" value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="1-3,4-6,7" />}
          <div className="mt-4 flex justify-end"><Button variant="filled" icon={Scissors} disabled={!file.length || busy} onClick={async () => { await saveResponse(await post('/pdf/split', formOf({ file: file[0], mode: splitMode, ranges }), '正在拆分 PDF'), 'split.zip'); }}>拆分并保存</Button></div>
        </Card>
      )}

      {tab === 'stamp' && (
        <Card title="水印、裁切与批量旋转">
          <DropZone files={stampFile} onFiles={setStampFile} accept=".pdf" label="选择 PDF" compact />
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label="应用页码（留空 = 全部）" value={stampPages} onChange={(e) => setStampPages(e.target.value)} placeholder="1,3,5" />
            <Field label="水印文字" value={watermark} onChange={(e) => setWatermark(e.target.value)} placeholder="草稿 / 机密" hint="30° 斜向铺满；生成后页面扁平化，水印无法被单独删除。" />
            <Field label="裁切边距（pt）" type="number" min={0} value={margin} onChange={(e) => setMargin(e.target.value)} />
            <Select label="旋转角度" value={rotation} onChange={(e) => setRotation(e.target.value)}>{[90, 180, 270].map((a) => <option key={a} value={a}>{a}°</option>)}</Select>
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="outlined" icon={RotateCw} disabled={busy} onClick={() => void transform('rotate')}>旋转</Button>
            <Button variant="outlined" icon={Crop} disabled={busy} onClick={() => void transform('crop')}>裁切</Button>
            <Button variant="filled" icon={Stamp} disabled={busy} onClick={() => void transform('watermark')}>添加水印</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
