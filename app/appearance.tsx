'use client';

import { useEffect, useRef, useState } from 'react';
import { applyMaterialTheme } from './m3';
import { API_URL, requestDocument } from './api';
import { mobileWorkbench } from './platform';

type Theme = { accent: string; radius: number; opacity: number; dim: number; blur: number; style: 'solid' | 'outline' | 'glass'; motion: boolean };
const defaults: Theme = { accent: '#0b57d0', radius: mobileWorkbench ? 24 : 20, opacity: 92, dim: 18, blur: 0, style: 'solid', motion: true };
type Stored = { theme: Theme; media?: Blob; name?: string; videoId?: string };
const mediaApi = '/wallpaper/video';
type VideoInfo = { id: string; created: string; original: { width: number; height: number; seconds: number; bytes: number }; output: { width: number; height: number; fps: number; bytes: number } };
type VideoStatus = { state: 'uploading' | 'analyzing' | 'optimizing' | 'done' | 'failed'; progress: number; metadata?: VideoInfo; original?: VideoInfo['original']; output?: VideoInfo['output'] & { estimated_bytes?: number } };
const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
const duration = (value: number) => `${Math.floor(value / 60)} 分 ${Math.round(value % 60)} 秒`;
export function validate(value: unknown): Theme {
  const t = value as Theme;
  if (!t || !/^#[\da-f]{6}$/i.test(t.accent) || !['solid', 'outline', 'glass'].includes(t.style) || typeof t.motion !== 'boolean') throw Error('主题格式不正确。');
  for (const [key, max] of [['radius', 28], ['opacity', 100], ['dim', 70], ['blur', 16]] as const) {
    if (!Number.isFinite(t[key]) || t[key] < (key === 'opacity' ? 70 : 0) || t[key] > max) throw Error('主题参数超出范围。');
  }
  return { accent: t.accent, radius: t.radius, opacity: t.opacity, dim: t.dim, blur: t.blur, style: t.style, motion: t.motion };
}
async function storage(value?: Stored): Promise<Stored | undefined> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('paperdock-appearance', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('settings', value ? 'readwrite' : 'readonly');
      const operation = value ? tx.objectStore('settings').put(value, 'current') : tx.objectStore('settings').get('current');
      tx.oncomplete = () => { db.close(); resolve(value || operation.result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
function sample(element: CanvasImageSource): string {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 24;
  const ctx = canvas.getContext('2d')!; ctx.drawImage(element, 0, 0, 24, 24);
  const pixels = ctx.getImageData(0, 0, 24, 24).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; n++;
  }
  if (!n) return defaults.accent;
  return '#' + [r, g, b].map(c => Math.round(c / n).toString(16).padStart(2, '0')).join('');
}
async function inspect(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'].includes(file.type)) throw Error('请选择 JPG、PNG、WebP 图片或 MP4、WebM 视频。场景包和网页主题暂不支持。');
  if (file.size > 80 * 1024 * 1024) throw Error('壁纸最大 80 MB，建议使用 1080p 短视频。');
  const url = URL.createObjectURL(file);
  const el = document.createElement(file.type.startsWith('video/') ? 'video' : 'img');
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('媒体读取超时，请换一个文件。')), 15000);
      const finish = () => { clearTimeout(timer); try { resolve(sample(el)); } catch { reject(Error('无法读取壁纸颜色。')); } };
      el.onerror = () => { clearTimeout(timer); reject(Error('无法解码该文件，请使用常见图片或 H.264 MP4 视频。')); };
      if (el instanceof HTMLVideoElement) { el.muted = true; el.preload = 'auto'; el.onloadeddata = finish; }
      else el.onload = finish;
      el.src = url;
    });
  } finally { el.removeAttribute('src'); if (el instanceof HTMLVideoElement) el.load(); URL.revokeObjectURL(url); }
}

export default function Appearance({ visible, busy, save }: { visible: boolean; busy: boolean; save: (blob: Blob, name: string) => Promise<unknown> }) {
  const [theme, setTheme] = useState<Theme>(defaults);
  const [media, setMedia] = useState<Blob>();
  const [videoId, setVideoId] = useState<string>();
  const abort = useRef<AbortController | undefined>(undefined);
  const sampleNextVideo = useRef(false);
  const [name, setName] = useState('未选择壁纸');
  const [url, setUrl] = useState('');
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<VideoStatus>();
  const [videos, setVideos] = useState<VideoInfo[]>([]);
  const [notice, setNotice] = useState(mobileWorkbench ? '' : '设置自动保存在本机。');
  const [focused, setFocused] = useState(true);
  const video = useRef<HTMLVideoElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const importPicker = useRef<HTMLInputElement>(null);
  const poll = useRef<number | undefined>(undefined);
  const stopPolling = () => { if (poll.current) { window.clearInterval(poll.current); poll.current = undefined; } };
  const refreshVideos = async () => {
    try { const response = await requestDocument(`${mediaApi}s`); if (response.ok) setVideos((await response.json() as { videos: VideoInfo[] }).videos); } catch { /* Offline manager is optional while backend is starting. */ }
  };
  useEffect(() => {
    let cancelled = false;
    storage().then(data => { if (!cancelled && data) { setTheme(validate(data.theme)); setMedia(data.media); setVideoId(/^[a-f0-9]{32}$/.test(data.videoId || '') ? data.videoId : undefined); setName(data.name || '本地壁纸'); } }).catch(() => { if (!cancelled) setNotice('外观设置读取失败，已使用默认外观。'); }).finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => { void storage({ theme, media, name, videoId }).catch(() => setNotice('外观保存失败：本机存储空间可能不足。')); }, 300);
    return () => clearTimeout(timer);
  }, [theme, media, name, videoId, ready]);
  useEffect(() => {
    if (videoId && !mobileWorkbench) { setUrl(`${API_URL}${mediaApi}/${videoId}`); return; }
    let current: string | undefined;
    let stopped = false;
    const setBlob = (blob: Blob) => {
      if (stopped) return;
      current = URL.createObjectURL(blob);
      setUrl(current);
    };
    if (videoId) {
      void requestDocument(`${mediaApi}/${videoId}`).then(async (response) => {
        if (response.ok) setBlob(await response.blob());
        else if (!stopped) setUrl('');
      }).catch(() => { if (!stopped) setUrl(''); });
    } else if (media) setBlob(media);
    else setUrl('');
    return () => { stopped = true; if (current) URL.revokeObjectURL(current); };
  }, [media, videoId]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { if (visible && ready) void refreshVideos(); }, [visible, ready]);
  useEffect(() => () => stopPolling(), []);
  useEffect(() => { if (busy) abort.current?.abort(); }, [busy]);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.paperTheme = theme.style;
    root.style.setProperty('--pd-accent', theme.accent);
    const rgb = [1, 3, 5].map(i => parseInt(theme.accent.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    root.style.setProperty('--pd-on-accent', rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > .179 ? '#101820' : '#ffffff');
    root.style.setProperty('--pd-radius', `${theme.radius}px`);
    root.style.setProperty('--pd-opacity', `${theme.opacity}%`);
    applyMaterialTheme(theme.accent, root, mobileWorkbench);
    return () => { delete root.dataset.paperTheme; };
  }, [theme]);
  useEffect(() => {
    const root = document.documentElement;
    if (url) root.dataset.hasWallpaper = ''; else delete root.dataset.hasWallpaper;
  }, [url]);
  useEffect(() => {
    const update = () => setFocused(document.visibilityState === 'visible' && document.hasFocus());
    window.addEventListener('focus', update); window.addEventListener('blur', update); document.addEventListener('visibilitychange', update); update();
    return () => { window.removeEventListener('focus', update); window.removeEventListener('blur', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (theme.motion && !busy && focused && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) void el.play().catch(() => setNotice('视频已暂停，可点击播放背景重试。'));
    else el.pause();
  }, [url, theme.motion, busy, focused]);
  async function upload(file?: File) {
    if (!file) return; setLoading(true);
    try {
      if (/\.(mp4|webm)$/i.test(file.name)) {
        if (file.size > (mobileWorkbench ? 50 * 1024 ** 2 : 1024 ** 3)) throw Error(mobileWorkbench ? '手机端视频不能超过 50 MB。' : '视频不能超过 1 GB（1024 MB）。');
        const controller = new AbortController(); abort.current = controller;
        const token = crypto.randomUUID().replaceAll('-', '');
        const low = (navigator.hardwareConcurrency || 4) <= 4 || ((navigator as Navigator & { deviceMemory?: number }).deviceMemory || 8) <= 4;
        setProgress({ state: 'uploading', progress: 0 });
        setNotice('正在本地优化视频。开始文档处理会取消本次优化。');
        poll.current = window.setInterval(() => { void requestDocument(`/wallpaper/status/${token}`).then(response => response.ok ? response.json() : undefined).then(value => { const status = value as VideoStatus | undefined; if (status) setProgress(status); }).catch(() => {}); }, 800);
        const response = await requestDocument(`${mediaApi}?low=${low}&token=${token}`, { method: 'POST', body: file, signal: controller.signal });
        const data = await response.json() as { id: string; message: string; detail?: string; metadata?: VideoInfo };
        if (!response.ok) throw Error(data.detail || '视频优化失败。');
        sampleNextVideo.current = true; setMedia(undefined); setVideoId(data.id); setName(file.name); setProgress({ state: 'done', progress: 100, metadata: data.metadata }); setNotice(data.message); await refreshVideos();
      } else {
        const accent = await inspect(file); setTheme(old => ({ ...old, accent })); setVideoId(undefined); setMedia(file); setName(file.name); setNotice('壁纸已导入，按钮已匹配壁纸配色。');
      }
    }
    catch (error) { setNotice((error as Error).name === 'AbortError' ? '已取消优化，原壁纸保持不变。' : (error as Error).message); }
    finally { stopPolling(); setLoading(false); abort.current = undefined; }
  }
  async function importTheme(file?: File) {
    if (!file) return;
    try {
      if (file.size > 100000) throw Error('主题配置文件过大。');
      const data = JSON.parse(await file.text());
      if (data.format !== 'paperdock-theme' || data.version !== 1) throw Error('请选择 PaperDock 主题配置；外部图片或视频请使用导入壁纸。');
      setTheme(validate(data.theme)); setNotice('主题样式已应用。壁纸请单独导入；主题配置不包含媒体文件。');
    } catch (error) { setNotice((error as Error).message); }
  }
  return <>
    {url && <div className="pd-wallpaper" aria-hidden="true" style={{ filter: `blur(${theme.blur}px)` }}>
      {videoId || media?.type.startsWith('video/') ? <video ref={video} src={url} crossOrigin="anonymous" loop muted playsInline preload="auto" onLoadedData={e => { if (!sampleNextVideo.current) return; sampleNextVideo.current = false; try { const accent = sample(e.currentTarget); setTheme(old => ({ ...old, accent })); } catch { /* Keep chosen color if sampling is unavailable. */ } }} onError={() => setNotice('视频播放失败，请重新导入兼容的视频。')} /> : <img src={url} alt="" />}
      <div style={{ background: `rgba(0,0,0,${theme.dim / 100})` }} />
    </div>}
    {visible && <section className="pd-settings md-card space-y-6 rounded-[24px] bg-m-surface-container-lowest p-6">
      <div><h2 className="text-[28px] text-m-on-surface">{mobileWorkbench ? '外观设置' : '你的工作台，你的风格'}</h2>{!mobileWorkbench && <p className="mt-2">导入壁纸，自动搭配按钮；也可以调整成你喜欢的样子。</p>}</div>
      {notice && <p role="status">{notice}</p>}
      {progress && <div className="rounded-xl border p-4 space-y-2" aria-live="polite"><div className="flex justify-between gap-3"><b>{progress.state === 'uploading' ? '正在上传' : progress.state === 'analyzing' ? '正在分析视频' : progress.state === 'optimizing' ? '正在优化播放' : progress.state === 'done' ? '优化完成' : '优化未完成'}</b><span>{progress.progress}%</span></div><div className="h-2 overflow-hidden rounded bg-slate-200"><div className="h-full bg-m-primary transition-all" style={{ width: `${progress.progress}%` }} /></div>{progress.original && progress.output && <p>原视频：{progress.original.width}×{progress.original.height} · {duration(progress.original.seconds)} · {bytes(progress.original.bytes)}<br />目标输出：{progress.output.width}×{progress.output.height} · {progress.output.fps.toFixed(0)} fps · 预计不超过 {bytes(progress.output.estimated_bytes || progress.output.bytes)}</p>}{progress.metadata && <p>实际副本占用：{bytes(progress.metadata.output.bytes)}</p>}</div>}
      <div className="flex flex-wrap gap-3">
        <input ref={picker} hidden type="file" accept=".jpg,.jpeg,.png,.webp,.mp4,.webm" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
        <button disabled={!ready || loading || busy} onClick={() => picker.current?.click()}>{loading ? '正在优化…' : '导入图片 / 视频'}</button>
        {loading && <button onClick={() => abort.current?.abort()}>取消优化</button>}
        <button disabled={!ready || loading} onClick={() => { setMedia(undefined); setVideoId(undefined); setName('未选择壁纸'); }}>清除背景</button>
        <button disabled={!ready || loading} onClick={() => { setTheme(defaults); setMedia(undefined); setVideoId(undefined); setName('未选择壁纸'); setNotice('已恢复默认外观。'); }}>恢复默认</button>
      </div>
      {(!mobileWorkbench || media || videoId) && <p className="break-all">当前：{name}</p>}
      <p>{mobileWorkbench ? '视频最多 50 MB、5 分钟' : '图片最大 80 MB；MP4、WebM 视频最大 1 GB（1024 MB），最长 5 分钟。自动生成本地 H.264 静音副本，常规设备最高 1080p / 30 fps，低配置最高 720p / 24 fps，不放大小分辨率。离开窗口或处理文档时暂停背景；不改变原视频。'}</p>
      <fieldset disabled={!ready || loading} className="grid gap-5 sm:grid-cols-2">
        <label>按钮配色 <input aria-label="按钮配色" type="color" value={theme.accent} onChange={e => setTheme({ ...theme, accent: e.target.value })} /></label>
        <label>按钮样式 <select value={theme.style} onChange={e => setTheme({ ...theme, style: e.target.value as Theme['style'] })}><option value="solid">实心</option><option value="outline">描边</option><option value="glass">玻璃</option></select></label>
        {([['radius', '按钮圆角', 0, 28], ['opacity', '卡片不透明度', 70, 100], ['dim', '壁纸暗化', 0, 70], ['blur', '壁纸模糊', 0, 16]] as const).map(([key, label, min, max]) => <label key={key}>{label}：{theme[key]}<input className="block w-full" type="range" min={min} max={max} value={theme[key]} onChange={e => setTheme({ ...theme, [key]: Number(e.target.value) })} /></label>)}
        <label><input type="checkbox" checked={theme.motion} onChange={e => setTheme({ ...theme, motion: e.target.checked })} /> 播放视频背景</label>
      </fieldset>
      <div className="flex gap-3 flex-wrap"><button className="md-button md-filled bg-m-primary text-m-on-primary">按钮效果预览</button><button className="md-button md-filled bg-m-primary text-m-on-primary" disabled>不可用状态</button></div>
      <div className="border-t pt-5 space-y-3"><div className="flex items-center justify-between gap-3"><h3 className="font-semibold">已优化的视频壁纸</h3><button disabled={loading} onClick={() => void refreshVideos()}>刷新</button></div><p>这里显示 PaperDock 生成的本地副本。删除后不可恢复，但原始视频不会被删除；“重新优化”请重新选择原视频，避免反复转码降低画质。</p>{!videos.length && <p>暂无已优化视频。</p>}{videos.map(item => <div key={item.id} className="rounded-xl border p-4"><b>{item.output.width}×{item.output.height} · {item.output.fps.toFixed(0)} fps</b><p>原始：{item.original.width}×{item.original.height} · {duration(item.original.seconds)} · {bytes(item.original.bytes)}；副本占用：{bytes(item.output.bytes)}</p><div className="mt-2 flex gap-3 flex-wrap"><button disabled={loading} onClick={() => picker.current?.click()}>重新导入原视频</button><button disabled={loading} onClick={() => void (async () => { if (!confirm('删除这个优化后的视频副本？原始视频不会被删除。')) return; const response = await requestDocument(`${mediaApi}/${item.id}`, { method: 'DELETE' }); if (!response.ok) { setNotice('删除失败，请稍后重试。'); return; } if (videoId === item.id) { setVideoId(undefined); setName('未选择壁纸'); } setProgress(undefined); setNotice('已删除优化副本。'); await refreshVideos(); })()}>删除副本</button></div></div>)}</div>
      <div className="border-t pt-5 space-y-3"><h3 className="font-semibold">{mobileWorkbench ? '主题配置' : '导入与分享主题样式'}</h3>{!mobileWorkbench && <p>主题配置保存配色、圆角、透明度和播放偏好，壁纸文件单独导入。</p>}<input hidden ref={importPicker} type="file" accept=".json" onChange={e => { void importTheme(e.target.files?.[0]); e.target.value = ''; }} /><div className="flex flex-wrap gap-3"><button disabled={!ready} onClick={() => importPicker.current?.click()}>导入主题配置</button><button disabled={!ready} onClick={() => void save(new Blob([JSON.stringify({ format: 'paperdock-theme', version: 1, theme }, null, 2)], { type: 'application/json' }), '我的主题.paperdock-theme.json')}>导出主题配置</button></div></div>
      <div className="border-t pt-5 space-y-2"><h3 className="font-semibold">寻找壁纸</h3><p>可从 Pexels、Pixabay 下载图片或视频，再通过上方按钮导入；无需 Steam。下载需要联网，导入后可离线使用。</p><p className="select-all">https://www.pexels.com/ · https://pixabay.com/</p><p>Wallpaper Engine 中已有的图片、视频源文件也可导入。场景包、网页脚本及粒子交互不在兼容范围内。</p></div>
    </section>}
  </>;
}
