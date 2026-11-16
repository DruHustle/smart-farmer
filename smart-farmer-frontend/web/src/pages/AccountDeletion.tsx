import {useCallback, useEffect, useState} from 'react';
import {errorLabel, type Words} from '../locales';
import {jsonBody} from '../lib/api';
import {type FarmContext} from '../context';

type Request = {id: string; status: 'pending' | 'in_review'; requestedAt: string};
const path = '/v1/me/deletion-request';
export function AccountDeletion({call, t, online, onBack}: {
  call: FarmContext['call']; t: Words; online: boolean; onBack: () => void;
}) {
  const [request, setRequest] = useState<Request | null>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    setError(null);
    try {setRequest((await call<{request: Request | null}>(path)).request);}
    catch (cause) {setError(cause);}
  }, [call]);
  useEffect(() => {if (online) void load();}, [load, online]);

  async function change() {
    if (!online || busy || request === undefined || (!request && !confirmed)) return;
    setBusy(true); setError(null);
    try {
      if (request) {await call(path, {method: 'DELETE'}); setRequest(null);}
      else setRequest((await call<{request: Request}>(path, jsonBody({confirm: true}))).request);
      setConfirmed(false);
    } catch (cause) {setError(cause);}
    finally {setBusy(false);}
  }
  return <section className="panel deletion-panel"><h1>{t.deletionTitle}</h1><p>{t.deletionInfo}</p>
    {error ? <p role="alert">{errorLabel(t, error)} <button disabled={busy || !online} onClick={() => void load()}>{t.retry}</button></p> : null}
    {!online && <p role="status">{t.online_required}</p>}
    {request === undefined && online && !error && <p role="status">{t.loading}</p>}
    {request && <p role="status">{request.status === 'in_review' ? t.deletionReview : t.deletionPending}</p>}
    {request === null && <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/> {t.deletionConfirm}</label>}
    {request !== undefined && request?.status !== 'in_review' && <button className="secondary" disabled={busy || !online || (!request && !confirmed)} onClick={() => void change()}>
      {busy ? t.working : request ? t.deletionWithdraw : t.deletionSubmit}
    </button>}
    <button className="text-button" onClick={onBack}>{t.more}</button>
  </section>;
}
