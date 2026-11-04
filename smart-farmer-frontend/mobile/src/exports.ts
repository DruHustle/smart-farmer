import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as Crypto from 'expo-crypto';
import { ApiError } from './api';
import type { Session } from './types';

/** Explicit user-initiated export. Bearer credentials stay in headers and temporary files are removed after the share sheet closes. */
export async function sharePrivateReport(session: Session, path: string, format: 'pdf' | 'csv', title: string): Promise<void> {
  if (!path.startsWith('/v1/') || path.includes('://')) throw new Error('invalid_input');
  if (!await Sharing.isAvailableAsync()) throw new Error('sharing_unavailable');
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30_000);
  let file: File | null = null;
  try {
    const response = await fetch(session.origin + path, { headers: { Authorization: `Bearer ${session.token}` }, signal: controller.signal, redirect: 'error' });
    if (!response.ok) { let code = 'request_failed'; try { code = (await response.json()).error || code; } catch {} throw new ApiError(response.status, code); }
    const mimeType = format === 'pdf' ? 'application/pdf' : 'text/csv';
    if (!response.headers.get('content-type')?.startsWith(mimeType)) throw new Error('invalid_response');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('media_too_large');
    file = new File(Paths.cache, `smart-farmer-${Crypto.randomUUID()}.${format}`); file.create(); file.write(bytes);
    await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: title, UTI: format === 'pdf' ? 'com.adobe.pdf' : 'public.comma-separated-values-text' });
  } finally { clearTimeout(timeout); if (file?.exists) file.delete(); }
}
