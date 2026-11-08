// SPDX-License-Identifier: AGPL-3.0-only
import './phone.css';
import { installNativeSaving } from './native';

export const setupWorkbench = installNativeSaving;

export async function requestLocalDocument(path: string, options?: RequestInit): Promise<Response> {
  return (await import('./api')).requestLocalDocument(path, options);
}
