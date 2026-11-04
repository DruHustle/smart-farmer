import {pathToFileURL} from 'node:url';

const message = 'VITE_API_URL must be an HTTPS API origin (HTTP is allowed only on localhost, 127.0.0.1 or [::1]); omit credentials, path, query, fragment and trailing slash.';

export function validateApiOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error(message); }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (typeof value !== 'string' || value !== url.origin ||
      (url.protocol !== 'https:' && !localHttp)) throw new Error(message);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { validateApiOrigin(process.env.VITE_API_URL); }
  catch {
    // Do not echo a potentially credential-bearing argument into a build log.
    console.error(message);
    process.exitCode = 1;
  }
}
