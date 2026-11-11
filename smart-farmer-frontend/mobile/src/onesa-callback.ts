export type PendingOnesa = {
  state: string; verifier: string; issuer: string; origin: string; language: 'sn' | 'nd'; expires: number;
};

export function nativeCode(incoming: string, pending: PendingOnesa, origin: string, now = Date.now()): string {
  const url = new URL(incoming);
  const p = url.searchParams;
  if (url.protocol !== 'smartfarmer:' || url.host !== 'onesa' || url.pathname !== '/callback' || url.username || url.password || url.hash
    || pending.origin !== origin || pending.expires <= now || p.getAll('state').length !== 1 || p.get('state') !== pending.state
    || p.has('error') || (p.has('iss') && (p.getAll('iss').length !== 1 || p.get('iss') !== pending.issuer))) {
    throw new Error('unauthorized');
  }
  const code = p.get('code');
  if (!code || code.length > 4096 || p.getAll('code').length !== 1) throw new Error('unauthorized');
  return code;
}
