import {useRef, useState, type ReactNode} from 'react';
import {useFarm} from '../../context';
import {jsonBody} from '../../lib/api';
import {AccountingIntent, clearAccountingRequest, definiteAccountingRejection, pendingAccountingRequests, persistAccountingRequest, type PendingAccountingRequest} from '../../lib/accounting-intent';
import {Form, Submit} from '../../components/ui';

/** Retry the same financial intent with the same identity after a lost response. */
export function AccountingForm<T>({path, method = 'POST', build, onResult, children, title, disabled = false}: {
  path: string;
  method?: 'POST' | 'PATCH' | 'PUT';
  build: (form: FormData, requestId: string) => unknown;
  onResult: (result: T) => void | Promise<void>;
  children?: ReactNode;
  title: string;
  disabled?: boolean;
}) {
  const {call, run, t, online, busy, vault, farm, notify} = useFarm();
  const restored = pendingAccountingRequests(vault.snapshot(), farm).find(item => item.path === path && item.method === method);
  const intent = useRef<AccountingIntent | null>(null);
  if (!intent.current) intent.current = new AccountingIntent(restored);
  const [uncertain, setUncertain] = useState(Boolean(restored));
  const [accepted, setAccepted] = useState<{result: T} | null>(null);
  async function showResult(result: T) {
    try {await onResult(result); setAccepted(null); notify(t.saved);}
    catch {setAccepted({result}); notify(`${t.saved} ${t.limitedSync}`);}
  }
  const send = async (payload: unknown) => {
    const request: PendingAccountingRequest = {id: intent.current!.id, path, method, payload, createdAt: new Date().toISOString()};
    // Persist before sending, including a tab closing while the response is in flight.
    await persistAccountingRequest(vault, farm, request);
    let result: T;
    try {result = await call<T>(path, jsonBody(payload, method));}
    catch (error) {
      if (definiteAccountingRejection(error)) {await clearAccountingRequest(vault, farm, request); intent.current!.accepted(); setUncertain(false);}
      else {intent.current!.responseLost(payload); setUncertain(true);}
      throw error;
    }
    // Server acceptance is distinct from refreshing the screen afterwards.
    try {await clearAccountingRequest(vault, farm, request);}
    catch {intent.current!.responseLost(payload); setUncertain(true); setAccepted({result}); notify(`${t.saved} ${t.storage_failed}`); return;}
    intent.current!.accepted(); setUncertain(false);
    await showResult(result);
  };
  return <>
    {uncertain && <div className="notice accounting-submit-state" role="alert"><p>{t.accounting_pending_intent}</p><button type="button" className="secondary" disabled={busy || !online} onClick={() => void run(async () => {if (!online) throw new Error('online_required'); await send(intent.current!.retry());})}>{t.accountingRetryOriginal}</button></div>}
    {accepted && <div className="notice" role="status"><p>{t.accountingAcceptedRefresh}</p><button type="button" className="secondary" disabled={busy || !online} onClick={() => void run(() => showResult(accepted.result))}>{t.invoiceReload}</button></div>}
    <Form onSubmit={async data => {
    await run(async () => {
      if (!online) throw new Error('online_required');
      await send(intent.current!.prepare(build(data, intent.current!.id)));
    });
  }}>
    {children}
    <Submit disabled={disabled || !online || Boolean(accepted)}>{title}</Submit>
  </Form></>;
}
