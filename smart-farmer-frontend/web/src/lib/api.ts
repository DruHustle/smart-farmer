export const apiOrigin = (import.meta.env?.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '');
export class ApiError extends Error {
  status: number;
  details: Record<string, unknown>;
  constructor(code: string, status: number, details: Record<string, unknown> = {}) {super(code); this.status = status; this.details = details;}
}
export async function request<T = Record<string, unknown>>(path: string, token: string = '', options: RequestInit = {}): Promise<T> {
  const response = await fetch(apiOrigin + path, {...options, signal: options.signal ?? AbortSignal.timeout(20_000), credentials: 'omit', cache: 'no-store', headers: {'Accept': 'application/json', ...(options.body ? {'Content-Type': 'application/json'} : {}), ...(token ? {Authorization: `Bearer ${token}`} : {}), ...options.headers}});
  if (response.status === 204) return undefined as T;
  let body: any;
  try {body = await response.json();}
  catch {if (response.ok) throw new ApiError('invalid_response', response.status); body = {};}
  if (!response.ok) throw new ApiError(typeof body?.error === 'string' ? body.error : 'request_failed', response.status, body ?? {});
  return body as T;
}
export function jsonBody(value: unknown, method = 'POST'): RequestInit {return {method, body: JSON.stringify(value)};}
/** XMLHttpRequest exposes actual upload bytes; metadata and evidence remain separate queue entries. */
export function uploadRecord(path: string, token: string, body: unknown, progress: (percent: number) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('POST', apiOrigin + path); xhr.timeout = 30000;
    xhr.setRequestHeader('Content-Type', 'application/json'); xhr.setRequestHeader('Accept', 'application/json'); xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = event => {if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100));};
    xhr.onerror = () => reject(new ApiError('network_error', 0)); xhr.ontimeout = () => reject(new ApiError('network_error', 0));
    xhr.onload = () => {let response: Record<string, unknown> = {}; try {response = JSON.parse(xhr.responseText);} catch {} if (xhr.status >= 200 && xhr.status < 300) {progress(100); resolve(response);} else reject(new ApiError(typeof response.error === 'string' ? response.error : 'error', xhr.status, response));};
    xhr.send(JSON.stringify(body));
  });
}
