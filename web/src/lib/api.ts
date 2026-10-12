// Fetch wrapper: cookie auth + CSRF header on state-changing requests.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function csrf(): string {
  const m = /(?:^|;\s*)bb_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : '';
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-bb-csrf'] = csrf();
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth') && path !== '/api/me') window.dispatchEvent(new Event('bb-unauthorized'));
    throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? res.statusText);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T = { ok: boolean }>(path: string, body: unknown = {}) => call<T>('POST', path, body),
  put: <T = { ok: boolean }>(path: string, body: unknown = {}) => call<T>('PUT', path, body),
  del: <T = { ok: boolean }>(path: string) => call<T>('DELETE', path),
};
