// SPDX-License-Identifier: AGPL-3.0-only
import { encodeFile, nativeRequest } from './native';
import { jsonResponse } from './response';

type Properties = { width: number; height: number; fps: number; bytes: number; seconds: number };
type Video = { id: string; original: Properties; output: Properties; blob: Blob };

function storage<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('paperdock-phone-videos', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('videos', { keyPath: 'id' });
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('videos', mode);
      const request = action(transaction.objectStore('videos'));
      transaction.oncomplete = () => { database.close(); resolve(request.result); };
      transaction.onabort = () => { database.close(); reject(transaction.error ?? request.error); };
    };
  });
}

export async function requestVideo(path: string, options?: RequestInit): Promise<Response> {
  const url = new URL(path, 'https://paperdock.invalid');
  if (url.pathname === '/wallpaper/videos') {
    const records: Video[] = await storage('readonly', (store) => store.getAll());
    return jsonResponse({ videos: records.map(({ id, original, output }) => ({ id, original, output })) });
  }
  if (url.pathname.startsWith('/wallpaper/status/')) return jsonResponse(await nativeRequest('video-status'));
  if (url.pathname === '/wallpaper/video' && options?.method === 'POST') {
    const file = options.body;
    const signal = options.signal;
    if (!(file instanceof File) || file.size > 50 * 1024 * 1024) throw new Error('手机端视频最大支持 50 MB。');
    const data = await encodeFile(file);
    signal?.throwIfAborted();
    const abort = () => { void nativeRequest('video-cancel').catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await nativeRequest<{ data: string; metadata: { original: Properties; output: Properties } }>('video', {
        name: file.name, data, low: url.searchParams.get('low') === 'true',
      });
      signal?.throwIfAborted();
      const id = crypto.randomUUID().replaceAll('-', '');
      const bytes = Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'video/mp4' });
      await storage('readwrite', (store) => store.put({ id, ...result.metadata, blob }));
      return jsonResponse({ id, metadata: { id, ...result.metadata }, message: '视频已在手机上优化并保存。' });
    } finally { signal?.removeEventListener('abort', abort); }
  }
  const item = /^\/wallpaper\/video\/([a-f0-9]{32})$/.exec(url.pathname);
  if (item) {
    if (options?.method === 'DELETE') {
      await storage('readwrite', (store) => store.delete(item[1]));
      return jsonResponse({ deleted: true });
    }
    const record: Video | undefined = await storage('readonly', (store) => store.get(item[1]));
    if (record) return new Response(record.blob, { headers: { 'Content-Type': 'video/mp4' } });
  }
  return jsonResponse({ detail: '找不到该视频副本。' }, { status: 404 });
}
