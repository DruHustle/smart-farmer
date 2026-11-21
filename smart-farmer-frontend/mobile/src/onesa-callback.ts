export type PendingOnesa = {
  state: string; nonce?:string; verifier: string; issuer: string; origin: string; language: 'sn' | 'nd'; expires: number;
};

export function nativeCode(incoming: string, pending: PendingOnesa, origin: string, now = Date.now()): string {
  const url = new URL(incoming);
  const p = url.searchParams;
  if (url.protocol !== 'smartfarmer:' || url.host !== 'onesa' || url.pathname !== '/callback' || url.username || url.password || url.hash
    || pending.origin !== origin || pending.expires <= now || p.getAll('state').length !== 1 || p.get('state') !== pending.state
    || (p.has('iss') && (p.getAll('iss').length !== 1 || p.get('iss') !== pending.issuer))) {
    throw new Error('unauthorized');
  }
  if (p.has('error')) throw new Error(p.get('error') === 'access_denied' ? 'onesa_denied' : 'unauthorized');
  const code = p.get('code');
  if (!code || code.length > 4096 || p.getAll('code').length !== 1) throw new Error('unauthorized');
  return code;
}

// A successful browser return with no active, matching transaction is not
// a successful login. Keep cold-start duplicate link deliveries ignorable in
// PendingOnesaTransactions.claim(), but never silently dismiss the interactive
// sign-in attempt when its transaction was lost or already consumed.
export function requireOwnedOnesaSession<T>(session: T | null): T {
  if (session === null) throw new Error('unauthorized');
  return session;
}

type PendingStore = {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
};

// An OS deep-link event may arrive while the system authentication promise is
// still active (notably after the iOS native MFA browser handoff). This match
// only selects an event for the active attempt: nativeCode() + the server
// exchange still enforce issuer, PKCE, one-time code and account permissions.
export function isOwnedNativeCallback(incoming:string, state:string):boolean {
  try {
    const url=new URL(incoming);
    return url.protocol==='smartfarmer:' && url.host==='onesa' && url.pathname==='/callback' &&
      !url.username && !url.password && !url.hash && url.searchParams.getAll('state').length===1 &&
      url.searchParams.get('state')===state;
  } catch { return false; }
}

// Two platform callbacks for the same attempt must share one redemption. A
// duplicate event never replays the authorization code against the backend.
export class SingleNativeRedemption<T> {
  private pending:Promise<T>|null=null;
  once(fn:()=>Promise<T>):Promise<T> {
    if(this.pending===null) this.pending=fn();
    return this.pending;
  }
}

/** SecureStore has no atomic read-and-delete operation for a one-time callback. */
export class PendingOnesaTransactions {
  private idle: Promise<void> = Promise.resolve();

  constructor(private readonly store: PendingStore) {}

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.idle.then(action);
    this.idle = result.then(() => {}, () => {});
    return result;
  }

  save(attempt: PendingOnesa): Promise<void> {
    return this.serialize(() => this.store.write(JSON.stringify(attempt)));
  }

  clear(state: string): Promise<void> {
    return this.serialize(async () => {
      const raw = await this.store.read();
      if (raw && JSON.parse(raw).state === state) await this.store.remove();
    });
  }

  claim(incoming: string, origin: string): Promise<{pending: PendingOnesa; code: string} | null> {
    return this.serialize(async () => {
      const raw = await this.store.read();
      if (!raw) return null;
      const pending: PendingOnesa = JSON.parse(raw);
      let code: string;
      try {
        code = nativeCode(incoming, pending, origin);
      } catch (error) {
        // Only a denial already matched to this attempt ends it on a cold start.
        if (error instanceof Error && error.message === 'onesa_denied') await this.store.remove();
        throw error;
      }
      await this.store.remove();
      return {pending, code};
    });
  }
}
