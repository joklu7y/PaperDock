// SPDX-License-Identifier: AGPL-3.0-only
export function jsonResponse(body: unknown, options?: { status: number }): Response {
  return new Response(JSON.stringify(body), {
    status: options?.status ?? 200,
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
  });
}
