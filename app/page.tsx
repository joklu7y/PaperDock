'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRightLeft, ClipboardList, Download, ExternalLink, FileDown, FolderOpen, GitCompareArrows, House, LayoutGrid,
  Info, Menu, Palette, PenLine, ScanText, Search, ShieldCheck, Table2, X, type LucideIcon,
} from 'lucide-react';
import Appearance from './appearance';
import { WorkbenchContext, filenameOf, readError, requestDocument, type Workbench } from './api';
import { mobileWorkbench } from './platform';
import { Button, Card, Empty, IconButton, LinearProgress, PageHeader } from './ui';
import OcrView from './views/ocr';
import TablesView from './views/tables';
import PagesView from './views/pages';
import AnnotateView from './views/annotate';
import FormsView from './views/forms';
import CompareView from './views/compare';
import ConvertView from './views/convert';
import SecurityView from './views/security';

type SavedDownload = { id: string; name: string; status: string; path?: string; blob?: Blob };
declare global {
  interface Window {
    pywebview?: { api: { save_file: (name: string, data: string) => Promise<{ path?: string; cancelled?: boolean; error?: string; record_id?: string; warning?: string }>; list_downloads: () => Promise<SavedDownload[]>; open_download: (id: string, folder: boolean) => Promise<{ error?: string }> } };
  }
}

type ViewId = 'home' | 'ocr' | 'tables' | 'pages' | 'annotate' | 'forms' | 'compare' | 'convert' | 'security' | 'downloads' | 'appearance';
type Destination = { id: ViewId; label: string; icon: LucideIcon; description: string; keywords: string };
const tools: Destination[] = [
  { id: 'ocr', label: '文字识别', icon: ScanText, description: '图片、扫描件、截图转可编辑文字', keywords: 'ocr 识别 扫描 手写 截图 文字' },
  { id: 'tables', label: '表格与版面', icon: Table2, description: '表格转 Excel，双栏/图文混排还原 Word', keywords: '表格 excel csv 版面 双栏 多栏 页眉 页脚 markdown' },
  { id: 'pages', label: '页面整理', icon: LayoutGrid, description: '拖拽排序、旋转、删除、合并、拆分、水印', keywords: '页面 排序 拖拽 旋转 删除 合并 拆分 提取 水印 裁切 空白页' },
  { id: 'annotate', label: '批注与签名', icon: PenLine, description: '高亮、便签、画笔，按类别/状态管理；手写签名', keywords: '批注 高亮 下划线 删除线 便签 画笔 签名 注释' },
  { id: 'forms', label: '填写表单', icon: ClipboardList, description: '填写 PDF 中的表单字段并可扁平化', keywords: '表单 填写 扁平化 问卷' },
  { id: 'compare', label: '文档对比', icon: GitCompareArrows, description: '两个版本逐字比对，生成并排对比 PDF', keywords: '对比 比较 差异 版本 校对' },
  { id: 'convert', label: '格式转换', icon: ArrowRightLeft, description: '图片/截图转 PDF；PDF 转 Word、PPT、EPUB 等', keywords: '转换 word ppt pptx odt epub markdown txt 图片 截图 pdf' },
  { id: 'security', label: '安全与修复', icon: ShieldCheck, description: '加密、权限、永久涂黑、清理元数据、修复', keywords: '密码 加密 权限 涂黑 脱敏 元数据 修复 损坏' },
];
const extras: Destination[] = [
  { id: 'downloads', label: '下载记录', icon: Download, description: '', keywords: '下载 保存 记录' },
  { id: 'appearance', label: '外观设置', icon: Palette, description: '', keywords: '外观 主题 壁纸 颜色' },
];

export default function Home() {
  const [view, setView] = useState<ViewId>('home');
  const [drawer, setDrawer] = useState(() => !mobileWorkbench || matchMedia('(min-width: 768px)').matches);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [ocrStarted, setOcrStarted] = useState(false);
  const [task, setTask] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [downloads, setDownloads] = useState<SavedDownload[]>([]);
  const abort = useRef<AbortController | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  const notify = useCallback((text: string) => setToast({ id: Date.now(), text }), []);
  useEffect(() => {
    if (!mobileWorkbench) return;
    const wide = matchMedia('(min-width: 768px)');
    const fit = () => setDrawer(wide.matches);
    wide.addEventListener('change', fit);
    return () => wide.removeEventListener('change', fit);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), Math.min(10000, 4000 + toast.text.length * 60));
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!task) return;
    setSeconds(0);
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [task]);
  useEffect(() => {
    const restore = () => { void window.pywebview?.api.list_downloads().then((records) => setDownloads((old) => [...old, ...records.filter((r) => !old.some((x) => x.id === r.id))])).catch(() => notify('下载记录暂时无法读取。')); };
    if (window.pywebview?.api) restore();
    window.addEventListener('pywebviewready', restore);
    return () => window.removeEventListener('pywebviewready', restore);
  }, [notify]);
  // "/" focuses the tool search, like Google apps.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName);
      if (event.key === '/' && !typing) { event.preventDefault(); searchBox.current?.focus(); }
      if (event.key === 'Escape') {
        setQuery('');
        if (mobileWorkbench && matchMedia('(max-width: 767px)').matches) setDrawer(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const saveBlob = useCallback(async (blob: Blob, name: string) => {
    const id = crypto.randomUUID();
    const update = (status: string, path?: string) => setDownloads((old) => old.map((item) => (item.id === id ? { ...item, status, path } : item)));
    setDownloads((old) => [{ id, name, blob, status: '等待选择保存位置' }, ...old]);
    try {
      if (window.pywebview?.api) {
        const encoded = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(new Error('读取导出文件失败'));
          reader.readAsDataURL(blob);
        });
        const saved = await window.pywebview.api.save_file(name, encoded);
        if (saved.cancelled) { update('已取消，可重新保存'); notify('已取消保存，可在下载记录中重新保存。'); return false; }
        if (saved.error || !saved.path) throw new Error(saved.error || '未返回保存位置');
        update('已保存', saved.path);
        if (saved.record_id) setDownloads((old) => old.map((item) => (item.id === id ? { ...item, id: saved.record_id! } : item)));
        notify(saved.warning || `已保存：${saved.path}`);
      } else {
        if (location.pathname.startsWith('/desktop')) throw new Error('桌面保存接口尚未就绪，请重新启动软件。');
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        update('已交给浏览器下载');
        notify(`已开始下载：${name}`);
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败';
      update(`保存失败：${message}`); notify(message); return false;
    }
  }, [notify]);

  const post = useCallback<Workbench['post']>(async (path, body, label) => {
    const controller = new AbortController();
    abort.current = controller;
    setTask(label);
    try {
      return await requestDocument(path, body instanceof FormData
        ? { method: 'POST', body, signal: controller.signal }
        : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal: controller.signal });
    } catch {
      notify(controller.signal.aborted ? '已取消等待。本地计算可能仍在后台完成。' : '无法连接本地服务，请重新启动 PaperDock 后再试。');
      return null;
    } finally {
      setTask((current) => (current === label ? '' : current));
    }
  }, [notify]);

  const saveResponse = useCallback<Workbench['saveResponse']>(async (response, fallback) => {
    if (!response) return null;
    if (!response.ok) { notify(await readError(response, '处理失败')); return null; }
    const blob = await response.blob();
    return (await saveBlob(blob, filenameOf(response, fallback))) ? blob : null;
  }, [notify, saveBlob]);

  const workbench = useMemo<Workbench>(() => ({ notify, saveBlob, post, saveResponse, busy: !!task }), [notify, saveBlob, post, saveResponse, task]);
  const matches = query.trim() ? [...tools, ...extras].filter((d) => `${d.label} ${d.description} ${d.keywords}`.toLowerCase().includes(query.trim().toLowerCase())) : [];
  const go = (id: ViewId) => {
    setView(id);
    if (id !== 'ocr') setOcrStarted(false);
    setQuery('');
    if (mobileWorkbench && matchMedia('(max-width: 767px)').matches) setDrawer(false);
    window.scrollTo({ top: 0 });
  };
  const openDownload = async (id: string, folder: boolean) => {
    try { const response = await window.pywebview?.api.open_download(id, folder); if (response?.error) notify(response.error); }
    catch { notify('无法打开，请检查文件是否存在。'); }
  };

  const navItem = (d: Destination, badge?: ReactNode) => (
    <button key={d.id} type="button" onClick={() => go(d.id)} aria-current={view === d.id ? 'page' : undefined}
      className={`flex h-12 w-full items-center gap-3 rounded-full px-4 text-sm transition-colors ${view === d.id ? 'bg-m-secondary-container font-medium text-m-on-secondary-container' : 'text-m-on-surface-variant hover:bg-m-on-surface/8'}`}>
      <d.icon size={20} />
      <span className="flex-1 text-left">{d.label}</span>
      {badge}
    </button>
  );

  const homeView = (
    <div className="md-view">
      <div className="md-header mb-8 mt-2">
        <h2 className="text-[32px] font-normal leading-10 text-m-on-surface">今天想处理什么文档？</h2>
        <p className="mt-2 text-m-on-surface-variant">{mobileWorkbench ? '文档在手机上离线处理。' : <>所有处理都在本机完成。按 <kbd className="rounded border border-m-outline-variant px-1.5 text-xs">/</kbd> 可以快速搜索工具。</>}</p>
      </div>
      <div className="pd-tool-list grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {tools.map((t) => (
          <button key={t.id} type="button" onClick={() => go(t.id)} className="md-card group flex flex-col items-start rounded-[24px] bg-m-surface-container-lowest p-5 text-left transition-all hover:-translate-y-0.5 hover:shadow-lg">
            <span className="grid size-12 place-items-center rounded-2xl bg-m-primary-container text-m-on-primary-container transition-transform group-hover:scale-105"><t.icon size={24} /></span>
            <span className="mt-4 font-medium text-m-on-surface">{t.label}</span>
            <span className="mt-1 text-sm leading-5 text-m-on-surface-variant">{t.description}</span>
          </button>
        ))}
      </div>
      {downloads.length > 0 && (
        <Card className="mt-8" title="最近保存" actions={<Button variant="text" onClick={() => go('downloads')}>全部</Button>}>
          <ul className="divide-y divide-m-outline-variant">{downloads.slice(0, 5).map((d) => <li key={d.id} className="flex items-center gap-3 py-2 text-sm"><FileDown size={18} className="text-m-primary" /><span className="flex-1 truncate">{d.name}</span><span className="text-xs text-m-on-surface-variant">{d.status}</span></li>)}</ul>
        </Card>
      )}
    </div>
  );

  const downloadsView = (
    <div className="md-view mx-auto max-w-4xl">
      <PageHeader title="下载记录" subtitle={mobileWorkbench ? '最近 200 条成功保存记录可在重启后查看。' : '桌面版保留最近 200 条成功保存记录，重启后仍可查看。'} />
      <Card>
        {downloads.length ? (
          <ul className="divide-y divide-m-outline-variant">
            {downloads.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-3 py-3">
                <FileDown size={20} className="text-m-primary" />
                <div className="min-w-0 flex-1"><p className="truncate text-sm text-m-on-surface">{item.name}</p><p className="truncate text-xs text-m-on-surface-variant">{item.path || item.status}</p></div>
                {item.path && <><IconButton icon={ExternalLink} label="打开文件" onClick={() => void openDownload(item.id, false)} /><IconButton icon={FolderOpen} label={mobileWorkbench ? '分享文件' : '打开所在文件夹'} onClick={() => void openDownload(item.id, true)} /></>}
                {item.blob && <Button variant="text" onClick={() => item.blob && void saveBlob(item.blob, item.name)}>重新保存</Button>}
              </li>
            ))}
          </ul>
        ) : <Empty icon={Download} title="暂无保存记录">处理完成后会弹出保存位置选择窗口。</Empty>}
      </Card>
    </div>
  );

  const views: Partial<Record<ViewId, ReactNode>> = {
    home: homeView, ocr: <OcrView onRecognitionStart={mobileWorkbench ? () => setOcrStarted(true) : undefined} />, tables: <TablesView />, pages: <PagesView />, annotate: <AnnotateView />,
    forms: <FormsView />, compare: <CompareView />, convert: <ConvertView />, security: <SecurityView />, downloads: downloadsView,
  };
  const showOcrReminder = mobileWorkbench && view === 'ocr' && ocrStarted;

  return (
    <WorkbenchContext.Provider value={workbench}>
      <main className={`pd-app min-h-screen bg-m-surface text-m-on-surface${mobileWorkbench ? ' pd-mobile' : ''}`}>
        <header className="pd-topbar md-surface sticky top-0 z-30 flex h-16 items-center gap-2 bg-m-surface px-2 sm:px-4">
          <IconButton icon={Menu} label="展开或收起导航" aria-controls="workbench-navigation" aria-expanded={drawer} onClick={() => setDrawer((open) => !open)} />
          <button type="button" onClick={() => go('home')} className="pd-brand flex items-center gap-2 rounded-full px-2 py-1">
            <span className="grid size-9 place-items-center rounded-xl bg-m-primary text-m-on-primary"><ScanText size={20} /></span>
            <span className="hidden text-[22px] text-m-on-surface sm:inline">PaperDock</span>
          </button>
          <div className="pd-search relative mx-auto w-full max-w-[720px]">
            <Search size={20} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-m-on-surface-variant" />
            <input ref={searchBox} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) go(matches[0].id); }}
              placeholder={mobileWorkbench ? '搜索拆分、签名、表格等工具' : '搜索工具，例如“拆分”“签名”“表格”'} aria-label="搜索工具"
              className="h-12 w-full rounded-full bg-m-surface-container-high pl-12 pr-12 text-[15px] text-m-on-surface outline-none transition-shadow placeholder:text-m-on-surface-variant focus:bg-m-surface-container-lowest focus:shadow-md" />
            {query && <IconButton icon={X} label="清除搜索" className="absolute right-1 top-1/2 -translate-y-1/2" onClick={() => setQuery('')} />}
            {query.trim() && (
              <div className="absolute inset-x-0 top-14 overflow-hidden rounded-3xl bg-m-surface-container-lowest py-2 shadow-xl">
                {matches.length ? matches.map((d) => (
                  <button key={d.id} type="button" onClick={() => go(d.id)} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-m-on-surface/8">
                    <d.icon size={20} className="text-m-on-surface-variant" /><span className="text-sm text-m-on-surface">{d.label}</span><span className="truncate text-xs text-m-on-surface-variant">{d.description}</span>
                  </button>
                )) : <p className="px-5 py-3 text-sm text-m-on-surface-variant">没有找到相关工具</p>}
              </div>
            )}
          </div>
          <IconButton icon={Download} label={`下载记录（${downloads.length}）`} onClick={() => go('downloads')} active={view === 'downloads'} />
          <IconButton icon={Palette} label="外观设置" onClick={() => go('appearance')} active={view === 'appearance'} />
          {task && <div className="absolute inset-x-0 bottom-0"><LinearProgress /></div>}
        </header>
        <div className="flex">
          {mobileWorkbench && drawer && <button type="button" className="pd-drawer-backdrop" aria-label="关闭导航" onClick={() => setDrawer(false)} />}
          <nav id="workbench-navigation" data-open={drawer} className={`pd-navigation md-surface sticky top-16 h-[calc(100vh-4rem)] shrink-0 overflow-y-auto bg-m-surface px-3 pb-6 transition-all ${drawer ? 'w-64' : 'w-0 overflow-hidden px-0'}`} aria-label="主导航">
            {mobileWorkbench && <div className="pd-drawer-title"><span>PaperDock</span><IconButton icon={X} label="收起导航" onClick={() => setDrawer(false)} /></div>}
            {navItem({ id: 'home', label: '首页', icon: House, description: '', keywords: '' })}
            <p className="px-4 pb-1 pt-4 text-xs font-medium text-m-on-surface-variant">工具</p>
            {tools.map((t) => navItem(t))}
            <div className="my-3 h-px bg-m-outline-variant" />
            {navItem(extras[0], downloads.length ? <span className="text-xs">{downloads.length}</span> : null)}
            {navItem(extras[1])}
          </nav>
          <section className="pd-workspace min-w-0 flex-1 px-4 pb-24 pt-2 sm:px-8">
            <Appearance visible={view === 'appearance'} busy={!!task} save={saveBlob} />
            {views[view]}
          </section>
        </div>
        {(toast || task || showOcrReminder) && (
          <div className="pd-notice-stack pointer-events-none fixed bottom-6 left-1/2 z-50 flex w-[min(560px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-2">
            {task && (
              <div className="md-snackbar pointer-events-auto flex items-center gap-3 rounded-xl bg-m-inverse-surface px-4 py-3 text-sm text-m-inverse-on-surface shadow-lg" role="status">
                <span className="md-spinner shrink-0" /><span className="flex-1">{task} · {seconds} 秒</span>
                <button type="button" className="font-medium text-m-primary-container" onClick={() => abort.current?.abort()}>取消</button>
              </div>
            )}
            {toast && (
              <div key={toast.id} className="md-snackbar pointer-events-auto flex items-start gap-3 rounded-xl bg-m-inverse-surface px-4 py-3 text-sm text-m-inverse-on-surface shadow-lg" role="status" aria-live="polite">
                <span className="flex-1 break-all leading-6">{toast.text}</span>
                <button type="button" aria-label="关闭提示" onClick={() => setToast(null)} className="opacity-80 hover:opacity-100"><X size={18} /></button>
              </div>
            )}
            {showOcrReminder && (
              <p className="md-snackbar flex w-fit max-w-full items-center gap-2 rounded-full bg-m-secondary-container px-4 py-2.5 text-sm font-medium text-m-on-secondary-container shadow-sm" role="status">
                <Info size={18} className="shrink-0" aria-hidden="true" />
                <span>识别可能有误，请仔细甄别</span>
              </p>
            )}
          </div>
        )}
      </main>
    </WorkbenchContext.Provider>
  );
}
