import {useFarm} from '../../context';
import {jsonBody} from '../../lib/api';
import {clearAccountingRequest, definiteAccountingRejection, pendingAccountingRequests, type PendingAccountingRequest} from '../../lib/accounting-intent';
import {Section} from '../../components/ui';

export function PendingAccountingActions({onResolved}: {onResolved: (value: unknown, request: PendingAccountingRequest) => void | Promise<void>}) {
  const {snapshot, vault, farm, t, online, busy, run, call, notify} = useFarm();
  const pending = pendingAccountingRequests(snapshot, farm);
  if (!pending.length || busy) return null;
  return <Section title={t.accountingPendingActions} className="accounting-pending-actions"><p>{t.accounting_pending_intent}</p>{pending.map(request => {
    const payload = request.payload as Record<string, unknown>;
    const party = payload.party as {name?: string} | undefined;
    const title = request.path.endsWith('/journals') ? t.accountingManualJournal : request.path.endsWith('/settings') ? t.accountingSetup : request.path.endsWith('/accounts') ? t.accountingNewAccount : request.path.includes('/payments') ? t.invoicePayments : request.path.endsWith('/credits') ? t.invoiceCredit : t.accounting;
    return <article className="record-card" key={request.id}><h3>{title}</h3>{Boolean(party?.name || payload.reference || payload.description) && <p>{String(party?.name || payload.reference || payload.description)}</p>}<button type="button" className="secondary" disabled={!online} onClick={() => void run(async () => {
      if (!online) throw new Error('online_required');
      let value: unknown;
      try {value = await call(request.path, jsonBody(request.payload, request.method));}
      catch (error) {if (definiteAccountingRejection(error)) await clearAccountingRequest(vault, farm, request); throw error;}
      await clearAccountingRequest(vault, farm, request);
      try {await onResolved(value, request); notify(t.saved);} catch {notify(`${t.saved} ${t.limitedSync}`);}
    })}>{t.accountingResumeSaved}</button></article>;
  })}</Section>;
}
