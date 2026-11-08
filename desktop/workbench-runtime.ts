export const setupWorkbench = () => {};

export function requestLocalDocument(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:8001${path}`, options);
}
