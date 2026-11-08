// SPDX-License-Identifier: AGPL-3.0-only
import { jsonResponse } from './response.ts';
type Reply = { id: string; value?: unknown; error?: string };
type NativeHost = { postMessage: (message: string) => void };

declare global {
  interface Window {
    PaperDockAndroid?: NativeHost;
    webkit?: { messageHandlers?: { paperdock?: NativeHost } };
    paperDockReply?: (reply: Reply) => void;
  }
}

const pending = new Map<string, (reply: Reply) => void>();

function host() { return window.PaperDockAndroid ?? window.webkit?.messageHandlers?.paperdock; }

export async function encodeFile(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('无法读取所选文件。'));
    reader.readAsDataURL(file);
  });
}

export function nativeRequest<T>(action: string, payload: object = {}): Promise<T> {
  const target = host();
  if (!target) return Promise.reject(new Error('请在 PaperDock 手机版中使用此功能。'));
  window.paperDockReply = (reply) => pending.get(reply.id)?.(reply);
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('等待手机操作超时，请重试。'));
    }, 300_000);
    pending.set(id, (reply) => {
      clearTimeout(timer);
      pending.delete(id);
      if (reply.error) reject(new Error(reply.error));
      else resolve(reply.value as T);
    });
    try { target.postMessage(JSON.stringify({ id, action, ...payload })); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}

export function installNativeSaving() {
  if (!host()) return;
  window.pywebview = { api: {
    save_file: (name, data) => nativeRequest('save', { name, data }),
    list_downloads: () => nativeRequest('list'),
    open_download: (id, folder) => nativeRequest('open', { record: id, share: folder }),
  } };
  window.dispatchEvent(new Event('pywebviewready'));
}

export type LocatedText = { text: string; box: [number, number, number, number] };

export async function recognizeOnPhone(file: Blob, name: string, language: string, locations = false) {
  if (file.size > 50 * 1024 * 1024) throw new Error('手机端单个文件最大支持 50 MB。');
  return nativeRequest<{ text: string; pages: number; locations?: LocatedText[] }>('ocr', { name, language, locations, data: await encodeFile(file) });
}

export async function pickScreenshot(): Promise<Response> {
  const result = await nativeRequest<{ data: string; type: string } | null>('screenshot');
  if (!result) return jsonResponse({ detail: '已取消选择截图。' }, { status: 400 });
  const bytes = Uint8Array.from(atob(result.data), (char) => char.charCodeAt(0));
  return new Response(bytes, { headers: { 'Content-Type': result.type } });
}
