export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}

export function apiOrigin(value: string | undefined, development: boolean): string {
  if (!value) throw new Error('api_unconfigured');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('api_unconfigured'); }
  const local = ['localhost', '127.0.0.1', '10.0.2.2', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('api_unconfigured');
  if (url.protocol !== 'https:' && !(development && local && url.protocol === 'http:')) throw new Error('https_required');
  return url.origin;
}

export interface ApiClient {
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  upload<T>(path: string, body: unknown, onProgress?: (percent: number) => void): Promise<T>;
}

export function createApi(origin: string, token?: string): ApiClient {
  const headers = () => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
  const checkPath = (path: string) => { if (!path.startsWith('/v1/') || path.includes('://')) throw new Error('invalid_request'); };
  return {
    async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
      checkPath(path);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const response = await fetch(origin + path, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'error' });
        if (response.status === 204) return undefined as T;
        let result: { error?: string };
        try { result = await response.json(); } catch { throw new ApiError(response.status, 'invalid_response'); }
        if (!response.ok) throw new ApiError(response.status, result.error || 'request_failed');
        return result as T;
      } finally { clearTimeout(timer); }
    },
    upload<T>(path: string, body: unknown, onProgress?: (percent: number) => void): Promise<T> {
      checkPath(path);
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', origin + path);
        for (const [name, value] of Object.entries(headers())) xhr.setRequestHeader(name, value);
        xhr.timeout = 60_000;
        xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(Math.min(99, Math.floor(event.loaded * 100 / event.total))); };
        xhr.onerror = () => reject(new ApiError(0, 'network_error'));
        xhr.ontimeout = () => reject(new ApiError(0, 'network_error'));
        xhr.onload = () => {
          let data: { error?: string };
          try { data = JSON.parse(xhr.responseText); } catch { reject(new ApiError(xhr.status, 'invalid_response')); return; }
          if (xhr.status < 200 || xhr.status >= 300) { reject(new ApiError(xhr.status, data.error || 'request_failed')); return; }
          onProgress?.(100);
          resolve(data as T);
        };
        xhr.send(JSON.stringify(body));
      });
    },
  };
}
