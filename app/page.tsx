'use client';

import { useEffect, useRef, useState } from 'react';
import Appearance from './appearance';
import {
  BookOpen,
  Check,
  Eye,
  EyeOff,
  FileDown,
  FileText,
  Files,
  FolderOpen,
  ImageIcon,
  LockKeyhole,
  PenLine,
  RotateCw,
  ScanText,
  ShieldCheck,
  Upload,
  WandSparkles,
} from 'lucide-react';

type QueueFile = {
  name: string;
  size: string;
  type: string;
  status: string;
  source: File;
  recognized?: OcrItem;
};
type OcrResult = {
  lines?: OcrLine[];
  text: string;
  job_id: string;
  exports: Record<string, string>;
  pages: number;
  filename?: string;
  items?: OcrItem[];
};
type OcrItem = {
  lines?: OcrLine[];
  filename: string;
  text: string;
  pages: number;
  job_id: string;
};
type RecentRun = { name: string; pages: number; at: string };
type OcrLine = { text: string; score: number; page: number };
type SavedDownload = { id: string; name: string; status: string; path?: string; blob?: Blob };
declare global {
  interface Window {
    pywebview?: { api: { save_file: (name: string, data: string) => Promise<{ path?: string; cancelled?: boolean; error?: string; record_id?: string; warning?: string }>; list_downloads: () => Promise<SavedDownload[]>; open_download: (id: string, folder: boolean) => Promise<{ error?: string }> } };
  }
}

const errorMessage = (detail: unknown, fallback: string) => {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) =>
        item && typeof item === 'object' && 'msg' in item
          ? String(item.msg)
          : '',
      )
      .filter(Boolean);
    return messages.length ? messages.join('；') : fallback;
  }
  return fallback;
};
const nav = [
  [ScanText, '智能 OCR'],
  [Files, 'PDF 工具'],
  [LockKeyhole, '安全与签名'],
] as const;
const API_URL = 'http://127.0.0.1:8001';
const OCR_QUEUE_LIMIT = 10;

export default function Home() {
  const [downloads, setDownloads] = useState<SavedDownload[]>([]);
  useEffect(() => {
    const restore = () => { void window.pywebview?.api.list_downloads().then(records => setDownloads(old => [...old, ...records.filter(r => !old.some(x => x.id === r.id))])).catch(() => setNotice('下载记录暂时无法读取。')); };
    if (window.pywebview?.api) restore();
    window.addEventListener('pywebviewready', restore);
    return () => window.removeEventListener('pywebviewready', restore);
  }, []);
  const openDownload = async (id: string, folder: boolean) => {
    try {
      const response = await window.pywebview?.api.open_download(id, folder);
      if (response?.error) setNotice(response.error);
    } catch { setNotice('无法打开，请检查文件是否存在以及默认打开程序。'); }
  };
  const projectPicker = useRef<HTMLInputElement>(null);
  const [savingProject, setSavingProject] = useState(false);
  const taskAbort = useRef<AbortController | null>(null);
  const [taskLabel, setTaskLabel] = useState('');
  const [taskSeconds, setTaskSeconds] = useState(0);
  useEffect(() => {
    if (!taskLabel) return;
    setTaskSeconds(0);
    const timer = setInterval(() => setTaskSeconds(seconds => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [taskLabel]);
  const taskFetch = (url: string, body: FormData, label: string) => {
    const controller = new AbortController(); taskAbort.current = controller;
    setTaskLabel(label);
    return fetch(url, { method: 'POST', body, signal: controller.signal });
  };

  const saveBlob = async (blob: Blob, name: string) => {
    const id = crypto.randomUUID();
    const update = (status: string, path?: string) => setDownloads(old => old.map(item => item.id === id ? { ...item, status, path } : item));
    setDownloads(old => [{ id, name, blob, status: '等待选择保存位置' }, ...old]);
    try {
      if (window.pywebview?.api) {
        const encoded = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(new Error('读取导出文件失败'));
          reader.readAsDataURL(blob);
        });
        const saved = await window.pywebview.api.save_file(name, encoded);
        if (saved.cancelled) { update('已取消，可重新保存'); setNotice('已取消保存，可在下载记录中重新保存。'); return false; }
        if (saved.error || !saved.path) throw new Error(saved.error || '未返回保存位置');
        update('已保存', saved.path);
        if (saved.record_id) setDownloads(old => old.map(item => item.id === id ? { ...item, id: saved.record_id! } : item));
        setNotice(saved.warning || `文件已保存到：${saved.path}`);
      } else {
        if (location.pathname.startsWith('/desktop')) throw new Error('桌面保存接口尚未就绪，请关闭软件后重新启动。');
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        update('已交给浏览器，请查看浏览器下载记录');
        setNotice('已交给浏览器保存，请查看浏览器下载记录。');
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败';
      update(`保存失败：${message}`); setNotice(message); return false;
    }
  };
  const ocrPicker = useRef<HTMLInputElement>(null);
  const pdfPicker = useRef<HTMLInputElement>(null);
  const toolPicker = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState('智能 OCR');
  const [files, setFiles] = useState<QueueFile[]>([]);
  const [result, setResult] = useState<OcrResult | null>(null);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState(
    '本地工作台已就绪。文件仅在此电脑处理。',
  );
  const [running, setRunning] = useState(false);
  const stopOcr = useRef(false);
  const [stoppingOcr, setStoppingOcr] = useState(false);
  const [ocrProgress, setOcrProgress] = useState({ completed: 0, total: 0 });
  const [previewUrl, setPreviewUrl] = useState('');
  const [reviewIndex, setReviewIndex] = useState(0);
  const selectedJobId = result?.items?.[reviewIndex]?.job_id;
  const selectedSource = selectedJobId
    ? files.find(file => file.recognized?.job_id === selectedJobId)?.source
    : undefined;
  useEffect(() => {
    if (!selectedSource) { setPreviewUrl(''); return; }
    const url = URL.createObjectURL(selectedSource); setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedSource]);
  const [ocrMode, setOcrMode] = useState<'auto' | 'handwriting' | 'english'>('auto');
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>([]);
  const [savingCorrection, setSavingCorrection] = useState(false);
  const [converting, setConverting] = useState<string | null>(null);
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [pages, setPages] = useState('');
  const [rotationDegrees, setRotationDegrees] = useState('90');
  const [watermarkText, setWatermarkText] = useState('');
  const [watermarkPages, setWatermarkPages] = useState('1');
  const [cropMargin, setCropMargin] = useState('0');
  const [pdfRunning, setPdfRunning] = useState<string | null>(null);
  const [toolFiles, setToolFiles] = useState<File[]>([]);
  const [password, setPassword] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showOwnerPassword, setShowOwnerPassword] = useState(false);
  const [securityPermissions, setSecurityPermissions] = useState<string[]>([]);
  const [redactText, setRedactText] = useState('');

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('paperdock-recent-ocr') || '[]');
      if (Array.isArray(saved)) setRecentRuns(saved.slice(0, 5));
    } catch {
      // A damaged local preference must never block document processing.
    }
  }, []);

  const combinedText = (items: OcrItem[], edited?: string, editedIndex = -1) =>
    items
      .map((item, index) => `【文件：${item.filename}】\n${index === editedIndex ? edited || '' : item.text}`.trim())
      .join('\n\n');

  const add = (list: FileList | null) => {
    if (running) return;
    if (!list?.length) return;
    const remaining = OCR_QUEUE_LIMIT - files.length;
    if (remaining <= 0) {
      setNotice(`批量队列最多保留 ${OCR_QUEUE_LIMIT} 个文件。请先删除旧文件，再继续添加。`);
      return;
    }
    const selected = Array.from(list);
    const accepted = selected.slice(0, remaining);
    const next = accepted.map((source) => ({
      name: source.name,
      size:
        source.size > 1048576
          ? `${(source.size / 1048576).toFixed(1)} MB`
          : `${Math.ceil(source.size / 1024)} KB`,
      type: source.name.split('.').pop()?.toUpperCase() || '文件',
      status: '等待处理',
      source,
    }));
    setFiles((old) => [...old, ...next]);
    setNotice(
      selected.length > accepted.length
        ? `已加入 ${next.length} 个文件；队列上限为 ${OCR_QUEUE_LIMIT} 个，其余文件未加入。`
        : `已加入 ${next.length} 个文件，当前共 ${files.length + next.length}/${OCR_QUEUE_LIMIT} 个。`,
    );
  };
  const runOcr = async (retryOnly = false) => {
    if (!files.length) return setNotice('请先选择 PDF 或图片。');
    setRunning(true);
    stopOcr.current = false;
    setStoppingOcr(false);
    const targets = files.filter(item => !retryOnly || !item.recognized);
    setOcrProgress({ completed: 0, total: targets.length });
    setReviewIndex(0);
    setNotice(`准备逐份识别 ${files.length} 个文件；可在失败后只重试失败项。`);
    try {
      const completed = new Map<File, OcrItem>();
      if (retryOnly) files.forEach(item => { if (item.recognized) completed.set(item.source, result?.items?.find(r => r.job_id === item.recognized?.job_id) || item.recognized); });
      for (let index = 0; index < files.length; index += 1) {
        const item = files[index];
        if (stopOcr.current) break;
        if (retryOnly && item.recognized) continue;
        setFiles((old) => old.map((file, fileIndex) => fileIndex === index ? { ...file, recognized: undefined, status: '识别中' } : file));
        setNotice(`正在识别第 ${index + 1}/${files.length} 个文件：${item.name}`);
        const body = new FormData();
        body.append('file', item.source);
        body.append('language', ocrMode === 'english' ? 'en' : 'ch');
        try {
          const response = await fetch(`${API_URL}/ocr`, { method: 'POST', body });
          const data = (await response.json()) as OcrResult & { detail?: unknown };
          if (!response.ok) throw new Error(errorMessage(data.detail, 'OCR 服务错误'));
          const recognized = { filename: data.filename || item.name, text: data.text, pages: data.pages, job_id: data.job_id, lines: data.lines };
          completed.set(item.source, recognized);
          setFiles((old) => old.map((file, fileIndex) => fileIndex === index ? { ...file, recognized, status: '已完成' } : file));
        } catch (error) {
          setFiles((old) => old.map((file, fileIndex) => fileIndex === index ? { ...file, status: '失败，可重试' } : file));
          setNotice(`“${item.name}”识别失败：${error instanceof Error ? error.message : '未知错误'}；其余文件将继续处理。`);
        }
        setOcrProgress(old => ({ ...old, completed: old.completed + 1 }));
      }
      const done = files.flatMap(item => completed.has(item.source) ? [completed.get(item.source)!] : []);
      if (!done.length) return setNotice('没有文件识别成功。请检查失败项后点击“重试失败项”。');
      const combined = await fetch(`${API_URL}/ocr/combine`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: done }),
      });
      const data = (await combined.json()) as OcrResult & { detail?: unknown };
      if (!combined.ok) throw new Error(errorMessage(data.detail, '合并导出失败'));
      setResult(data);
      setDraft(done[0].text);
      const nextRecent = [{ name: data.filename || '批量识别', pages: data.pages, at: new Date().toLocaleString() }, ...recentRuns].slice(0, 5);
      setRecentRuns(nextRecent);
      localStorage.setItem('paperdock-recent-ocr', JSON.stringify(nextRecent));
      setNotice(stopOcr.current ? `队列已停止，保留 ${done.length} 份成功结果，可继续处理未完成文件。` : done.length === files.length ? `识别完成：${done.length} 个文件，可逐份校对后统一导出。` : `已完成 ${done.length}/${files.length} 个文件；失败项可重试。`);
    } catch (error) {
      setNotice(
        `识别未完成：${error instanceof Error ? error.message : '未知错误'}`,
      );
    } finally {
      setRunning(false);
      setStoppingOcr(false);
    }
  };
  const downloadJobExport = async (jobId: string, name: string) => {
    try {
    const response = await fetch(`${API_URL}/download/${jobId}/${name}`);
    if (!response.ok) {
      const data = (await response.json()) as { detail?: unknown };
      setNotice(errorMessage(data.detail, '导出文件下载失败。'));
      return false;
    }
    return saveBlob(await response.blob(), name);
    } catch {
      setNotice('获取导出文件失败，请检查本地服务后重试。');
      return false;
    }
  };
  const saveCorrection = async () => {
    if (!result) return;
    setSavingCorrection(true);
    try {
      const editedItems = result.items?.map((item, index) => index === reviewIndex ? { ...item, text: draft } : item);
      const finalText = editedItems ? combinedText(editedItems) : draft;
      const response = await fetch(
        `${API_URL}/exports/${result.job_id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: finalText }),
        },
      );
      const data = (await response.json()) as { exports?: Record<string, string>; detail?: unknown };
      if (!response.ok || !data.exports) {
        setNotice(errorMessage(data.detail, '校对结果保存失败。'));
        return;
      }
      setResult({ ...result, text: finalText, items: editedItems, exports: data.exports });
      await downloadJobExport(result.job_id, data.exports.docx);
    } catch {
      setNotice('无法连接本地导出服务，请重新启动工作台后再试。');
    } finally {
      setSavingCorrection(false);
    }
  };
  const saveProject = async () => {
    setSavingProject(true);
    try {
      const snapshot = { format: 'paperdock', version: 1, saved_at: new Date().toISOString(), result, draft, reviewIndex,
        settings: { pages, rotationDegrees, watermarkText, watermarkPages, cropMargin, ocrMode } };
      await saveBlob(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }), '我的工程.paperdock.json');
    } finally { setSavingProject(false); }
  };
  const openProject = async (file?: File) => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.format !== 'paperdock' || data.version !== 1 || typeof data.draft !== 'string') throw new Error('工程文件格式不正确');
      if (data.result) {
        const response = await fetch(`${API_URL}/ocr/combine`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: data.result.items || [{ filename: '恢复的工程', text: data.result.text, pages: data.result.pages, job_id: '' }] }) });
        if (!response.ok) throw new Error('恢复导出文件失败');
        setResult(await response.json());
      } else setResult(null);
      setDraft(data.draft); setReviewIndex(Number(data.reviewIndex) || 0);
      const s = data.settings || {};
      setOcrMode(['auto', 'handwriting', 'english'].includes(s.ocrMode) ? s.ocrMode : 'auto');
      setPages(String(s.pages || '')); setRotationDegrees(String(s.rotationDegrees || '90'));
      setWatermarkText(String(s.watermarkText || '')); setWatermarkPages(String(s.watermarkPages || ''));
      setCropMargin(String(s.cropMargin || '0')); setFiles([]); setPdfFiles([]); setToolFiles([]);
      setNotice('工程已恢复。已保留校对文字与页面设置；继续处理原文件时请重新选择原文件。');
    } catch (error) { setNotice(error instanceof Error ? error.message : '打开工程失败'); }
  };
  const pdfAction = async (
    action: 'merge' | 'rotate' | 'delete' | 'extract' | 'watermark' | 'crop',
  ) => {
    if (taskLabel) return setNotice('请等待当前任务结束。');
    if (!pdfFiles.length) return setNotice('请先选择 PDF 文件。');
    if (action === 'merge' && pdfFiles.length < 2) return setNotice('合并至少需要选择两份 PDF。');
    if (['delete', 'extract'].includes(action) && !pages.trim()) return setNotice('删除或提取前，请填写需要处理的页码。');
    if (action === 'watermark' && !watermarkText.trim()) return setNotice('请先输入水印文字。');
    const body = new FormData();
    let url = `${API_URL}/pdf/transform`;
    if (action === 'merge') {
      url = `${API_URL}/pdf/merge`;
      pdfFiles.forEach((x) => body.append('files', x));
    } else {
      body.append('file', pdfFiles[0]);
      body.append('action', action);
      body.append('pages', action === 'watermark' ? watermarkPages : pages);
      body.append('degrees', rotationDegrees);
      body.append('watermark_text', watermarkText);
      body.append('crop_margin', cropMargin);
    }
    setPdfRunning(action);
    setNotice('正在处理 PDF，请稍候…');
    try {
      const response = await taskFetch(url, body, '正在处理 PDF');
      if (!response.ok) {
        const data = (await response.json()) as { detail?: unknown };
        setNotice(errorMessage(data.detail, 'PDF 处理失败。'));
        return;
      }
      await downloadResponse(response, action === 'merge' ? 'merged.pdf' : 'processed.pdf');
    } catch {
      setNotice(taskAbort.current?.signal.aborted ? '已取消等待及下载。当前本地计算可能仍在完成，请稍后再开始新任务。' : '本地 PDF 服务暂时无法连接，请稍后重试。');
    } finally {
      setPdfRunning(null);
      setTaskLabel('');
    }
  };
  const downloadResponse = async (response: Response, fallback: string) => {
    if (!response.ok) {
      const data = (await response.json()) as { detail?: string };
      setNotice(errorMessage(data.detail, '处理失败。'));
      return;
    }
    const filename =
      response.headers
        .get('content-disposition')
        ?.match(/filename="?([^";]+)/)?.[1] || fallback;
    return saveBlob(await response.blob(), filename);
  };
  const convert = async (target: string) => {
    if (taskLabel) return setNotice('请等待当前任务结束。');
    if (!toolFiles.length) return setNotice('请先选择要转换的文件。');
    if (target === 'pdf' && toolFiles.length > 10) {
      return setNotice('图片转 PDF 一次最多上传 10 张图片。');
    }
    if (target !== 'pdf' && toolFiles.length !== 1) {
      return setNotice('除图片转 PDF 外，其他转换一次请选择一个文件。');
    }
    setConverting(target);
    setNotice(`正在处理 ${toolFiles.length} 个文件，请稍候…`);
    try {
      const body = new FormData();
      toolFiles.forEach((file) => body.append('files', file));
      body.append('target', target);
      const response = await taskFetch(`${API_URL}/convert`, body, '正在转换格式');
      if (response.status === 422) {
        setNotice('转换服务仍是旧版本，尚未支持批量图片。请重新运行 run-local.ps1 后刷新本页面。');
        return;
      }
      const fallbackNames: Record<string, string> = {
        pdf: 'converted.pdf',
        txt: 'converted.txt',
        docx: 'converted.docx',
        xlsx: 'converted.xlsx',
        images: 'pages.zip',
      };
      await downloadResponse(response, fallbackNames[target] || 'converted-file');
    } catch {
      setNotice(taskAbort.current?.signal.aborted ? '已取消等待及下载。当前本地计算可能仍在完成。' : '无法连接本地转换服务，请重新启动软件后再试。');
    } finally {
      setConverting(null);
      setTaskLabel('');
    }
  };
  const secure = async (operation: string) => {
    if (taskLabel) return setNotice('请等待当前任务结束。');
    if (!toolFiles.length) return setNotice('请先选择 PDF 文件。');
    if (operation === 'protect' && (!password || !ownerPassword)) {
      return setNotice('设置 AES-256 时请同时填写打开密码和所有者密码。');
    }
    if (operation === 'unlock' && !password) {
      return setNotice('移除密码前必须输入该 PDF 的打开密码。');
    }
    const body = new FormData();
    body.append('file', toolFiles[0]);
    body.append('password', password);
    body.append('owner_password', ownerPassword);
    body.append('redact_text', redactText);
    body.append('permissions', JSON.stringify(securityPermissions));
    try {
      await downloadResponse(
        await taskFetch(`${API_URL}/security/${operation}`, body, '正在处理安全操作'),
        operation === 'unlock' ? 'unlocked.pdf' : 'secured.pdf',
      );
    } catch {
      setNotice(taskAbort.current?.signal.aborted ? '已取消等待及下载。当前本地计算可能仍在完成。' : '无法连接本地安全服务，请重新启动软件后再试。');
    } finally {
      setTaskLabel('');
    }
  };
  const ocrView = (
    <div className="grid gap-6 xl:grid-cols-2">
      <div>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-widest text-[#75827d]">
              识别中心
            </p>
            <h2 className="mt-1 text-2xl font-semibold">从原件到可编辑文档</h2>
          </div>
          <span className="rounded-full bg-[#eaf5ef] px-3 py-1 text-xs font-medium text-[#167c69]">
            本地处理
          </span>
        </div>
        <button
          onClick={() => ocrPicker.current?.click()}
          onDrop={(e) => {
            e.preventDefault();
            add(e.dataTransfer.files);
          }}
          onDragOver={(e) => e.preventDefault()}
          className="flex min-h-56 w-full flex-col items-center justify-center rounded-3xl border-2 border-dashed border-[#a8c9bc] bg-[#eaf5ef] p-8 text-center"
        >
          <div className="mb-4 rounded-2xl bg-white p-4 text-[#167c69]">
            <Upload size={25} />
          </div>
          <b className="text-lg">拖入 PDF 或图片</b>
          <p className="mt-2 text-sm text-[#64746e]">
            支持 PDF、JPG、PNG、BMP、TIF；可分次添加，队列最多 10 个文件。
          </p>
          <span className="mt-5 rounded-lg bg-[#167c69] px-4 py-2 text-sm text-white">
            选择/追加文件
          </span>
          <input
            ref={ocrPicker}
            type="file"
            multiple
            className="hidden"
            accept=".pdf,.jpg,.jpeg,.png,.bmp,.tif,.tiff"
            onChange={(e) => {
              add(e.target.files);
              e.target.value = '';
            }}
          />
        </button>
        {result && <div className="mt-6 rounded-2xl border bg-white p-4"><h3 className="font-semibold">原文件对照 · {result.items?.[reviewIndex]?.filename}</h3>{previewUrl ? selectedSource?.name.toLowerCase().endsWith('.pdf') ? <iframe title="PDF 原文件对照" src={previewUrl} className="mt-3 h-[600px] w-full" /> : <img alt="当前校对文件原图" src={previewUrl} className="mt-3 max-h-[800px] w-full object-contain" /> : <p className="mt-3 text-sm">原图未加载。打开工程后需重新识别原文件才能显示本次结果对应的原图。</p>}</div>}
        <div className="mt-6 overflow-hidden rounded-2xl border border-[#dce2de] bg-white">
          <div className="flex justify-between border-b border-[#edf0ee] px-5 py-4">
            <b>批量队列</b>
            <span className="text-xs text-[#167c69]">
              {files.length}/{OCR_QUEUE_LIMIT} 个文件
            </span>
          </div>
          {files.length ? (
            files.map((f, i) => (
              <div
                key={`${f.name}-${i}`}
                className="flex items-center gap-3 border-b border-[#edf0ee] px-5 py-3 last:border-0"
              >
                <ImageIcon size={18} className="text-[#167c69]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{f.name}</p>
                  <p className="text-xs text-[#83908b]">
                    {f.type} · {f.size}
                  </p>
                </div>
                <span className="text-xs text-[#a96a09]">{f.status}</span>
                <button
                  type="button"
                  disabled={running}
                  onClick={() => {
                    setFiles((old) => old.filter((_, index) => index !== i));
                    setNotice(`已从批量队列删除“${f.name}”。`);
                  }}
                  className="shrink-0 rounded-lg border border-[#e6c6c2] px-2 py-1 text-xs text-[#a54848] hover:bg-[#fff3f2] disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label={`从队列删除 ${f.name}`}
                >
                  删除
                </button>
              </div>
            ))
          ) : (
            <p className="p-8 text-center text-sm text-[#83908b]">
              上传后可开始识别。
            </p>
          )}
        </div>
      </div>
      <aside className="space-y-5">
        <div className="rounded-2xl bg-[#183c35] p-5 text-white">
          <WandSparkles size={20} className="text-[#8be2c1]" />
          <h3 className="mt-4 text-lg font-semibold">识别与模型策略</h3>
          <p className="mt-2 text-sm leading-6 text-[#bad0c8]">
            自动扶正、去噪与阅读顺序整理已接入。手写模式会优先保留笔画和纸面颜色，适合拍照笔记校对。
          </p>
        </div>
        <div className="rounded-2xl border border-[#dce2de] bg-white p-5">
          <b>本次识别</b>
          <label className="mt-3 block text-sm text-[#65756f]">识别模式
            <select value={ocrMode} onChange={(event) => setOcrMode(event.target.value as typeof ocrMode)} className="mt-2 w-full rounded-xl border border-[#dce2de] bg-white px-3 py-2">
              <option value="auto">自动（中英混合）</option>
              <option value="handwriting">手写优先（中文/中英混合）</option>
              <option value="english">英文优先</option>
            </select>
          </label>
          <p className="mt-3 text-xs leading-5 text-[#65756f]">手写内容请优先人工校对；系统会保留原图，不会覆盖源文件。</p>
          <button
            disabled={running}
            onClick={() => void runOcr()}
            className="mt-5 flex w-full justify-center gap-2 rounded-xl bg-[#167c69] py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            <ScanText size={17} />
            {running ? '正在识别…' : '开始批量识别'}
          </button>
          {!running && files.some(file => !file.recognized) && files.some(file => file.recognized) && <button className="mt-3 w-full rounded-xl border p-2" onClick={() => void runOcr(true)}>仅重试失败 / 未完成文件</button>}
          {running && <div className="mt-3" role="status"><progress className="w-full" max={ocrProgress.total || 1} value={ocrProgress.completed} /><p className="text-sm">已处理 {ocrProgress.completed} / {ocrProgress.total} 个文件</p><button disabled={stoppingOcr} className="mt-2 rounded-xl border p-2" onClick={() => { stopOcr.current = true; setStoppingOcr(true); }}>{stoppingOcr ? '等待当前文件完成后停止…' : '停止后续队列'}</button><p className="mt-2 text-xs">当前文件完成后停止，已成功识别的结果会保留。</p></div>}
        </div>
        {result && (
          <div className="rounded-2xl border border-[#bde1d0] bg-white p-5">
            <div className="flex justify-between">
              <b>人工校对（逐份文件）</b>
              <span className="text-xs text-[#167c69]">{result.pages} 页</span>
            </div>
            {result.items && result.items.length > 1 && (
              <select
                value={reviewIndex}
                onChange={(event) => {
                  const index = Number(event.target.value);
                  setReviewIndex(index);
                  setDraft(result.items?.[index]?.text || '');
                }}
                className="mt-3 w-full rounded-xl border border-[#dce2de] bg-white px-3 py-2 text-sm"
              >
                {result.items.map((item, index) => <option key={`${item.job_id}-${index}`} value={index}>{index + 1}. {item.filename}（{item.pages} 页）</option>)}
              </select>
            )}
            <textarea
              value={draft}
              onChange={(e) => { const text = e.target.value; setDraft(text); setResult(old => old ? { ...old, items: old.items?.map((item, index) => index === reviewIndex ? { ...item, text } : item) } : old); }}
              className="mt-3 h-96 w-full rounded-xl border border-[#dce2de] p-3 text-sm leading-6 outline-none focus:border-[#167c69]"
            />
            <details className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3"><summary>低置信度原始识别内容（{(result.items?.[reviewIndex]?.lines || []).filter(line => line.score < 0.85).length} 处）</summary><p className="mt-2 text-xs">模型评分低于 85% 的行供校对参考，不代表错误概率；修改文字后此原始记录不变。无标记也不保证识别正确。</p>{(result.items?.[reviewIndex]?.lines || []).filter(line => line.score < 0.85).map((line, index) => <p key={index} className="mt-2 text-sm">第 {line.page} 页 · {Math.round(line.score * 100)}%：{line.text}</p>)}</details>
            <button
              onClick={saveCorrection}
              disabled={savingCorrection}
              className="mt-3 w-full rounded-xl border border-[#167c69] py-2 text-sm font-medium text-[#167c69]"
            >
              {savingCorrection ? '正在保存并下载…' : '保存校对并重新导出 Word'}
            </button>
            <div className="mt-3 flex gap-2">
              {Object.entries(result.exports).map(([label, name]) => (
                <button
                  key={name}
                  className="rounded-lg bg-[#eaf5ef] px-2 py-1 text-xs font-medium text-[#167c69]"
                  onClick={() => void downloadJobExport(result.job_id, name)}
                >
                  {label.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        )}
        {recentRuns.length > 0 && (
          <div className="rounded-2xl border border-[#dce2de] bg-white p-5">
            <b>最近识别</b>
            <ul className="mt-3 space-y-2 text-xs text-[#65756f]">
              {recentRuns.map((item, index) => <li key={`${item.name}-${item.at}-${index}`} className="flex justify-between gap-3"><span className="truncate">{item.name}</span><span className="shrink-0">{item.pages} 页 · {item.at}</span></li>)}
            </ul>
          </div>
        )}
        <div className="rounded-xl border border-[#bde1d0] bg-[#edf9f2] px-4 py-3 text-sm text-[#17664f]">
          {notice}
        </div>
      </aside>
    </div>
  );
  const pdfView = (
    <div className="mx-auto max-w-4xl">
      <p className="text-xs font-semibold tracking-widest text-[#75827d]">
        PDF 工作台
      </p>
      <h2 className="mt-1 text-2xl font-semibold">页面整理与基础编辑</h2>
      <div className="mt-6 rounded-3xl border border-[#dce2de] bg-white p-6">
        <input
          ref={pdfPicker}
          type="file"
          multiple
          accept=".pdf"
          className="hidden"
          onChange={(e) => {
            const selected = Array.from(e.target.files || []);
            if (selected.length > 10) {
              setPdfFiles([]);
              setNotice('PDF 工作台一次最多选择 10 份 PDF，请减少后重新选择。');
              return;
            }
            setPdfFiles(selected);
            setNotice(
              selected.length
                ? `已选择 ${selected.length} 份 PDF；合并时会按当前顺序排列。`
                : '尚未选择 PDF。',
            );
          }}
        />
        <button
          onClick={() => pdfPicker.current?.click()}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#a8c9bc] bg-[#eaf5ef] py-12 text-[#167c69]"
        >
          <Upload size={20} />
          {pdfFiles.length
            ? `已选择 ${pdfFiles.length}/10 份 PDF`
            : '选择 PDF 文件（最多 10 份）'}
        </button>
        {pdfFiles.length > 0 && (
          <div className="mt-4 rounded-2xl border border-[#dce2de] bg-[#fafcfb] p-4">
            <div className="flex items-center justify-between text-sm">
              <b>已选文件（合并顺序）</b>
              <button onClick={() => setPdfFiles([])} className="text-[#a54848]">清空</button>
            </div>
            <ol className="mt-2 space-y-1 text-sm text-[#65756f]">
              {pdfFiles.map((file, index) => (
                <li key={`${file.name}-${index}`} className="flex items-center justify-between gap-3">
                  <span className="truncate">{index + 1}. {file.name}</span>
                  <button
                    onClick={() => setPdfFiles((old) => old.filter((_, itemIndex) => itemIndex !== index))}
                    className="shrink-0 text-xs text-[#a54848]"
                  >
                    移除
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}
        <label className="mt-5 block text-sm text-[#65756f]">
          指定页码（例如 1,3,5 或 1，3，5；旋转/裁切留空表示全部，删除/提取必须填写）
          <input
            value={pages}
            onChange={(e) => setPages(e.target.value)}
            className="mt-2 w-full rounded-xl border border-[#dce2de] px-3 py-2"
            placeholder="1,3,5 或 1，3，5"
          />
        </label>
        <div className="mt-4 grid gap-4 rounded-2xl bg-[#f7faf8] p-4 md:grid-cols-2">
          <label className="text-sm text-[#65756f]">
            旋转角度
            <select
              value={rotationDegrees}
              onChange={(e) => setRotationDegrees(e.target.value)}
              className="mt-2 w-full rounded-xl border border-[#dce2de] bg-white px-3 py-2"
            >
              {[0, 90, 180, 270, 360].map((angle) => <option key={angle} value={angle}>{angle}°</option>)}
            </select>
          </label>
          <label className="text-sm text-[#65756f]">
            裁切边距（点，0 表示不裁切）
            <input
              value={cropMargin}
              onChange={(e) => setCropMargin(e.target.value)}
              type="number"
              min="0"
              className="mt-2 w-full rounded-xl border border-[#dce2de] bg-white px-3 py-2"
            />
          </label>
        </div>
        <div className="mt-4 rounded-2xl border border-[#bde1d0] bg-[#edf9f2] p-4">
          <p className="text-sm font-semibold text-[#17664f]">整页倾斜文字水印</p>
          <div className="mt-3 grid gap-3">
            <label className="text-sm text-[#65756f]">
              水印内容（可输入中英文、符号和表情）
              <input value={watermarkText} onChange={(e) => setWatermarkText(e.target.value)} className="mt-1 w-full rounded-xl border border-[#dce2de] bg-white px-3 py-2" placeholder="例如：草稿 / 机密" />
            </label>
            <label className="text-sm text-[#65756f]">
              应用页面（例如 1,3,5 或 1，3，5；留空表示全部页面）
              <input value={watermarkPages} onChange={(e) => setWatermarkPages(e.target.value)} className="mt-1 w-full rounded-xl border border-[#dce2de] bg-white px-3 py-2" placeholder="1,3,5 或 1，3，5" />
            </label>
          </div>
          <p className="mt-2 text-xs text-[#65756f]">将以 30° 从左上至右下重复铺满指定页面，使用半透明灰色。生成后整个 PDF 会扁平化为高质量图片页，水印会融合进像素，不能作为独立文字对象删除。</p>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ['merge', '合并 PDF'],
            ['rotate', '旋转页面'],
            ['delete', '删除页面'],
            ['extract', '提取页面'],
            ['watermark', '添加整页水印'],
            ['crop', '按边距裁切'],
          ].map(([action, label]) => (
            <button
              key={action}
              onClick={() =>
                pdfAction(
                  action as
                    | 'merge'
                    | 'rotate'
                    | 'delete'
                    | 'extract'
                    | 'watermark'
                    | 'crop',
                )
              }
              disabled={pdfRunning !== null}
              className="rounded-xl bg-[#eaf5ef] px-4 py-3 text-sm font-medium text-[#167c69] disabled:cursor-wait disabled:opacity-60"
            >
              {pdfRunning === action ? '正在处理…' : label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 rounded-xl border border-[#bde1d0] bg-[#edf9f2] px-4 py-3 text-sm text-[#17664f]">
        {notice}
      </div>
    </div>
  );
  const filePicker = (
    <div className="rounded-3xl border border-[#dce2de] bg-white p-6">
      <input
        ref={toolPicker}
        type="file"
        multiple={active === 'PDF 工具'}
        accept={active === 'PDF 工具' ? '.pdf,.png,.jpg,.jpeg,.bmp,.tif,.tiff' : '.pdf'}
        className="hidden"
        onChange={(e) => {
          const selected = Array.from(e.target.files || []);
          if (active === 'PDF 工具' && selected.length > 10) {
            setToolFiles([]);
            setNotice('一次最多可选择 10 张图片，请减少后重新选择。');
            return;
          }
          setToolFiles(selected);
        }}
      />
      <button
        onClick={() => toolPicker.current?.click()}
        className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#a8c9bc] bg-[#eaf5ef] py-10 text-[#167c69]"
      >
        <Upload size={20} />
        {toolFiles.length
          ? toolFiles.length === 1
            ? toolFiles[0].name
            : `已选择 ${toolFiles.length} 个文件（按此顺序生成）`
          : active === 'PDF 工具'
            ? '选择文件或最多 10 张图片'
            : '选择 PDF 文件'}
      </button>
    </div>
  );
  const conversionView = (
    <div className="mx-auto max-w-4xl">
      <p className="text-xs font-semibold tracking-widest text-[#75827d]">
        转换中心
      </p>
      <h2 className="mt-1 text-2xl font-semibold">本地格式转换</h2>
      <div className="mt-6">{filePicker}</div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[
          ['pdf', '图片转 PDF'],
          ['txt', 'PDF 转 TXT'],
          ['docx', 'PDF 转 Word'],
          ['xlsx', 'PDF 转 Excel'],
          ['images', 'PDF 转图片压缩包'],
        ].map(([target, label]) => (
          <button
            key={target}
            onClick={() => convert(target)}
            disabled={converting !== null}
            className="rounded-xl bg-[#eaf5ef] px-4 py-3 text-sm font-medium text-[#167c69] disabled:cursor-wait disabled:opacity-60"
          >
            {converting === target ? '正在生成…' : label}
          </button>
        ))}
      </div>
      <div className="mt-4 rounded-xl border border-[#bde1d0] bg-[#edf9f2] px-4 py-3 text-sm text-[#17664f]">
        {notice}
      </div>
    </div>
  );
  const securityView = (
    <div className="mx-auto max-w-4xl">
      <p className="text-xs font-semibold tracking-widest text-[#75827d]">
        安全中心
      </p>
      <h2 className="mt-1 text-2xl font-semibold">PDF 密码、权限与永久脱敏</h2>
      <div className="mt-6">{filePicker}</div>
      <div className="mt-5 grid gap-4 rounded-3xl border border-[#dce2de] bg-white p-6 md:grid-cols-2">
        <label className="text-sm text-[#65756f]">
          打开密码
          <div className="relative mt-2">
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              className="w-full rounded-xl border border-[#dce2de] px-3 py-2 pr-11"
            />
            <button
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-label={showPassword ? '隐藏打开密码' : '显示打开密码'}
              title={showPassword ? '隐藏密码' : '显示密码'}
              className="absolute inset-y-0 right-0 grid w-10 place-items-center text-[#65756f] hover:text-[#167c69]"
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <span className="mt-1 block text-xs">至少 12 位，需含大小写字母、数字和符号；可使用中文、表情及常见符号。</span>
        </label>
        <label className="text-sm text-[#65756f]">
          所有者密码
          <div className="relative mt-2">
            <input
              value={ownerPassword}
              onChange={(e) => setOwnerPassword(e.target.value)}
              type={showOwnerPassword ? 'text' : 'password'}
              autoComplete="new-password"
              className="w-full rounded-xl border border-[#dce2de] px-3 py-2 pr-11"
            />
            <button
              type="button"
              onClick={() => setShowOwnerPassword((visible) => !visible)}
              aria-label={showOwnerPassword ? '隐藏所有者密码' : '显示所有者密码'}
              title={showOwnerPassword ? '隐藏密码' : '显示密码'}
              className="absolute inset-y-0 right-0 grid w-10 place-items-center text-[#65756f] hover:text-[#167c69]"
            >
              {showOwnerPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <span className="mt-1 block text-xs">必须与打开密码不同，用于锁定复制、打印和修改权限。</span>
        </label>
        <fieldset className="md:col-span-2">
          <legend className="text-sm text-[#65756f]">使用所有者密码控制的权限（不勾选即禁止）</legend>
          <div className="mt-2 flex flex-wrap gap-4 text-sm text-[#44554f]">
            {[
              ['copy', '允许复制文字和图片'],
              ['print', '允许打印（含高质量打印）'],
              ['modify', '允许修改、批注和填写表单'],
            ].map(([value, label]) => (
              <label key={value} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={securityPermissions.includes(value)}
                  onChange={(event) => setSecurityPermissions((current) => event.target.checked ? [...current, value] : current.filter((item) => item !== value))}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="text-sm text-[#65756f] md:col-span-2">
          永久涂黑文字（每行一项）
          <textarea
            value={redactText}
            onChange={(e) => setRedactText(e.target.value)}
            className="mt-2 h-24 w-full rounded-xl border border-[#dce2de] p-3"
            placeholder="身份证号\n姓名"
          />
        </label>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <button
          onClick={() => secure('protect')}
          className="rounded-xl bg-[#167c69] px-4 py-3 text-sm font-medium text-white"
        >
          设置 AES-256 密码
        </button>
        <button
          onClick={() => secure('unlock')}
          className="rounded-xl bg-[#eaf5ef] px-4 py-3 text-sm font-medium text-[#167c69]"
        >
          移除已有密码
        </button>
        <button
          onClick={() => secure('clean-metadata')}
          className="rounded-xl bg-[#eaf5ef] px-4 py-3 text-sm font-medium text-[#167c69]"
        >
          清理元数据
        </button>
        <button
          onClick={() => secure('redact')}
          className="rounded-xl bg-[#1d2a29] px-4 py-3 text-sm font-medium text-white"
        >
          永久涂黑
        </button>
      </div>
      <p className="mt-3 text-sm text-[#65756f]">
        仅能移除由 PaperDock 加密生成的 PDF，且必须先验证正确的打开密码。成功后会生成一份全新、无打开密码和所有者密码的 PDF。
      </p>
      <div className="mt-6 rounded-2xl border border-[#dce2de] bg-white p-5 text-sm text-[#65756f]">
        <b className="text-[#1d2a29]">安全提示</b>
        <p className="mt-2">
          永久涂黑会移除匹配的可搜索文字，操作前请保留原件。密码保护使用 PDF 标准中最高级别的 AES-256
          加密；请妥善保存两种密码。
        </p>
      </div>
      <div className="mt-4 rounded-xl border border-[#bde1d0] bg-[#edf9f2] px-4 py-3 text-sm text-[#17664f]">
        {notice}
      </div>
    </div>
  );
  return (
    <main className="pd-app min-h-screen bg-[#f5f6f4] text-[#1d2a29]">
      <div className="mx-auto flex min-h-screen max-w-[1600px]">
        <aside className="hidden w-60 shrink-0 border-r border-[#dce2de] bg-[#eef2ee] p-5 lg:block">
          <div className="mb-10 flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-[#167c69] text-white">
              <BookOpen size={20} />
            </div>
            <div>
              <b>PaperDock</b>
              <p className="text-xs text-[#71807b]">个人文档工作台</p>
            </div>
          </div>
          {nav.map(([Icon, name]) => (
            <button
              key={name}
              onClick={() => setActive(name)}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm ${active === name ? 'bg-white font-semibold text-[#126d5c] shadow-sm' : 'text-[#5d6d68]'}`}
            >
              <Icon size={18} />
              {name}
            </button>
          ))}
          <button onClick={() => setActive('下载记录')} className="mt-12 flex items-center gap-2 text-sm text-[#64746e]">
            <FileDown size={17} />下载记录（{downloads.length}）
          </button>
          <div className="mt-3 space-y-3 text-xs" aria-live="polite">
            {downloads.slice(0, 4).map(item => <div key={item.id} className="break-all"><b>{item.name}</b><p>{item.status}</p>{item.path && <p>{item.path}</p>}</div>)}
          </div>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-[76px] items-center justify-between border-b border-[#dce2de] bg-white/80 px-6">
            <div>
              <h1 className="text-lg font-semibold">{active}</h1>
              {active === '智能 OCR' && <p className="text-xs text-[#75827d]">本地工程 · 手动保存校对文字与设置</p>}
            </div>
            <div className="flex gap-2"><input ref={projectPicker} type="file" accept=".json" className="hidden" onChange={event => { void openProject(event.target.files?.[0]); event.target.value = ''; }} />
            {active === '智能 OCR' && <button onClick={() => projectPicker.current?.click()} className="rounded-xl border px-4 py-2 text-sm">打开工程</button>}<button onClick={() => setActive('下载记录')} className="rounded-xl border px-4 py-2 text-sm">下载记录</button>{active === '智能 OCR' && <button
              onClick={saveProject}
              disabled={savingProject}
              className="rounded-xl bg-[#167c69] px-4 py-2 text-sm font-medium text-white"
            >
              {savingProject ? '保存中…' : '保存工程'}
            </button>}</div>
          </header>
          <div className="p-6 xl:p-9">
            <button onClick={() => setActive('外观设置')} className="mb-4 rounded-xl border bg-white px-4 py-2">外观设置</button>
            <Appearance visible={active === '外观设置'} busy={running || !!taskLabel} save={saveBlob} />
            <p role="status" className="mb-4 break-all rounded-xl border bg-white p-3 text-sm">{notice}</p>
            {taskLabel && <div role="status" className="mb-4 rounded-xl border p-3"><p>{taskLabel} · 已用时 {taskSeconds} 秒</p><progress className="my-2 w-full" /><button className="rounded-lg border px-3 py-2" onClick={() => taskAbort.current?.abort()}>取消等待及下载</button><p className="mt-2 text-xs">取消会停止接收结果，不会立即终止已开始的本地计算。</p></div>}
            {active === '下载记录' ? <div className="space-y-4"><h2 className="text-xl font-semibold">下载与保存记录</h2><p>每次保存可独立选择文件夹。桌面版保留最近 200 条成功保存记录，重启后仍可查看。</p>{!downloads.length && <p>暂无导出文件。处理完成后会弹出保存位置选择窗口。</p>}{downloads.map(item => <div key={item.id} className="rounded-xl border bg-white p-4"><b>{item.name}</b><p>{item.status}</p>{item.path && <p className="break-all">保存位置：{item.path}</p>}{item.path && <><button className="m-2 rounded-lg border p-2" onClick={() => void openDownload(item.id, false)}>打开文件</button><button className="m-2 rounded-lg border p-2" onClick={() => void openDownload(item.id, true)}>打开所在文件夹</button></>}{item.blob && <button className="mt-2 rounded-lg border px-3 py-2" onClick={() => item.blob && void saveBlob(item.blob, item.name)}>另存为 / 重新保存</button>}</div>)}</div> : active === '智能 OCR' ? (
              ocrView
            ) : active === 'PDF 工具' ? (
              <div className="space-y-10">{pdfView}{conversionView}</div>
            ) : active === '安全与签名' ? (
              securityView
            ) : active === '外观设置' ? null : (
              <div className="rounded-3xl border border-[#dce2de] bg-white p-10">
                <ShieldCheck className="text-[#167c69]" />
                <h2 className="mt-4 text-2xl font-semibold">
                  {active} 正在准备中
                </h2>
                <p className="mt-2 text-[#65756f]">
                  该模块已纳入第二阶段架构；当前可优先使用 OCR、工程保存和 PDF
                  页面整理。
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
