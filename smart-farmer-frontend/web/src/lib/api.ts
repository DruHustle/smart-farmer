export const apiOrigin = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '');
export class ApiError extends Error {
  status: number;
  details: Record<string, unknown>;
  constructor(code: string, status: number, details: Record<string, unknown> = {}) {super(code); this.status = status; this.details = details;}
}
export async function request<T = Record<string, unknown>>(path: string, token: string = '', options: RequestInit = {}): Promise<T> {
  const response = await fetch(apiOrigin + path, {...options, signal: options.signal ?? AbortSignal.timeout(20_000), credentials: 'omit', cache: 'no-store', headers: {'Accept': 'application/json', ...(options.body ? {'Content-Type': 'application/json'} : {}), ...(token ? {Authorization: `Bearer ${token}`} : {}), ...options.headers}});
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(typeof body.error === 'string' ? body.error : 'request_failed', response.status, body);
  return body as T;
}
export function jsonBody(value: unknown, method = 'POST'): RequestInit {return {method, body: JSON.stringify(value)};}
