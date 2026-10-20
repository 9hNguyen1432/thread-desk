export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'td.token';

/** Moves the access key from the URL fragment into this origin's storage and out of the address bar. */
export function captureToken(): void {
  const match = /(?:^#|&)t=([0-9a-f]+)/.exec(location.hash);
  if (!match) return;
  try {
    localStorage.setItem(TOKEN_KEY, match[1]!);
  } catch {
    sessionStorage.setItem(TOKEN_KEY, match[1]!);
  }
  history.replaceState(null, '', location.pathname + location.search);
}

export function token(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'x-thread-desk-token': token(),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
};
