/** Only native-initiated transactions use this state format. Their verifier stays on the initiating device. */
export function nativeReturnLink(callback: URL): string | null {
  const params = callback.searchParams;
  const state = params.get('state') ?? '';
  if (callback.pathname !== '/auth/onesa/callback' || !/^native_[0-9a-f]{64}$/.test(state)
    || params.getAll('state').length !== 1 || params.getAll('iss').length > 1) return null;
  const target = new URL('smartfarmer://onesa/callback');
  target.searchParams.set('state',state);
  const issuer = params.get('iss');
  if (issuer) target.searchParams.set('iss',issuer);
  if (params.has('error')) target.searchParams.set('error','access_denied');
  else {
    const code=params.get('code');
    if (params.getAll('code').length !== 1 || !code || code.length > 4096) return null;
    target.searchParams.set('code',code);
  }
  return target.href;
}
