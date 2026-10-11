import type { ProblemDetails } from '@hrms/shared';

/** Error carrying the server's problem+json details. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | null,
  ) {
    super(problem?.detail ?? `HTTP ${status}`);
  }
  get code(): string {
    return this.problem?.code ?? (this.status === 0 ? 'network' : 'INTERNAL');
  }
}

let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/** Same-origin JSON client. Cookies carry the session; unsafe methods send the CSRF token. */
export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
      signal: opts.signal ?? null,
    });
  } catch {
    throw new ApiError(0, null);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = new ApiError(res.status, (data as ProblemDetails) ?? null);
    if (res.status === 401 && !path.startsWith('/auth/login')) onUnauthorized?.();
    throw err;
  }
  return data as T;
}

/** POST that returns a file (exports): saves it with the name sent by the server. */
export async function download(path: string, body: unknown): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body) });
  } catch {
    throw new ApiError(0, null);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, text ? (JSON.parse(text) as ProblemDetails) : null);
  }
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1] ?? 'report');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Multipart upload (file + fields). The browser sets the multipart boundary itself. */
export async function upload<T>(path: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: 'POST',
      headers: csrfToken ? { 'X-CSRF-Token': csrfToken, Accept: 'application/json' } : { Accept: 'application/json' },
      credentials: 'same-origin',
      body: form,
    });
  } catch {
    throw new ApiError(0, null);
  }
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, (data as ProblemDetails) ?? null);
  return data as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body ?? {} });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });
