import type { Lang } from '../types';

export const onesaTransactionKey = 'smart-farmer:onesa:login';
export type BrowserOnesaTransaction = {
  state: string;
  verifier: string;
  nonce?: string;
  issuer: string;
  language: Lang;
  returnTo: string;
  expires: number;
};

export function consumeOnesaTransaction(
  storage: Storage,
  url: URL,
  origin: string,
  now = Date.now(),
): BrowserOnesaTransaction {
  const raw = storage.getItem(onesaTransactionKey);
  if (!raw) throw new Error('unauthorized');
  let saved: BrowserOnesaTransaction;
  try {
    saved = JSON.parse(raw);
  } catch {
    storage.removeItem(onesaTransactionKey);
    throw new Error('unauthorized');
  }
  if (!saved || typeof saved.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(saved.state) ||
      typeof saved.verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(saved.verifier) ||
      typeof saved.issuer !== 'string' || !['sn','nd'].includes(saved.language) ||
      !Number.isSafeInteger(saved.expires) || saved.expires <= now) {
    storage.removeItem(onesaTransactionKey);
    throw new Error('unauthorized');
  }
  const states = url.searchParams.getAll('state');
  const issuers = url.searchParams.getAll('iss');
  if (url.origin !== origin || url.pathname !== '/auth/onesa/callback' ||
      states.length !== 1 || states[0] !== saved.state ||
      (issuers.length && (issuers.length !== 1 || issuers[0] !== saved.issuer))) {
    throw new Error('unauthorized');
  }
  storage.removeItem(onesaTransactionKey);
  return saved;
}
