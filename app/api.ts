'use client';

import { createContext, useContext } from 'react';
import { mobileWorkbench } from './platform';

export const API_URL = 'http://127.0.0.1:8001';

export async function requestDocument(path: string, options?: RequestInit): Promise<Response> {
  if (mobileWorkbench) {
    const { requestLocalDocument } = await import('../mobile/workbench/api');
    return requestLocalDocument(path, options);
  }
  return fetch(`${API_URL}${path}`, options);
}

export const errorMessage = (detail: unknown, fallback: string) => {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => (item && typeof item === 'object' && 'msg' in item ? String(item.msg) : ''))
      .filter(Boolean);
    return messages.length ? messages.join('；') : fallback;
  }
  return fallback;
};

/** Read a FastAPI error body without throwing on non-JSON responses. */
export async function readError(response: Response, fallback: string) {
  try {
    const data = (await response.json()) as { detail?: unknown };
    return errorMessage(data.detail, fallback);
  } catch {
    return fallback;
  }
}

export const filenameOf = (response: Response, fallback: string) => {
  const header = response.headers.get('content-disposition') || '';
  const encoded = header.match(/filename\*=utf-8''([^;]+)/i)?.[1];
  if (encoded) return decodeURIComponent(encoded);
  return header.match(/filename="?([^";]+)/)?.[1] || fallback;
};

export const formOf = (fields: Record<string, string | Blob | Blob[] | undefined>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    // A bare Blob (e.g. an edited working copy) has no name; the server checks the extension.
    const append = (item: string | Blob) => (item instanceof Blob && !(item instanceof File) ? body.append(key, item, 'document.pdf') : body.append(key, item));
    if (Array.isArray(value)) value.forEach(append);
    else append(value);
  }
  return body;
};

export const fileSize = (bytes: number) =>
  bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

export type Workbench = {
  /** Show a snackbar message. */
  notify: (message: string) => void;
  /** Ask where to save a file (desktop) or hand it to the browser. */
  saveBlob: (blob: Blob, name: string) => Promise<boolean>;
  /** POST a form as a cancellable task with a progress bar; returns null when cancelled or offline. */
  post: (path: string, body: FormData | object, label: string) => Promise<Response | null>;
  /** Save a successful file response, or show its error. Returns the blob when saved. */
  saveResponse: (response: Response | null, fallback: string) => Promise<Blob | null>;
  busy: boolean;
};

export const WorkbenchContext = createContext<Workbench | null>(null);
export const useWorkbench = () => {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error('Workbench context missing');
  return value;
};

export type RenderedPage = { index: number; width: number; height: number; image: string };

export async function renderPages(post: Workbench['post'], file: Blob, pages: string, scale: number, label = '正在生成预览') {
  const response = await post('/pdf/render', formOf({ file, pages, scale: String(scale) }), label);
  if (!response) return null;
  if (!response.ok) throw new Error(await readError(response, '预览生成失败'));
  return (await response.json()) as { count: number; pages: RenderedPage[] };
}
