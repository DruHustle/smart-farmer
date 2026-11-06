import {useEffect, useRef, useState, type FormEvent} from 'react';
import {Field, Section} from './components/ui';
import {useFarm} from './context';
import {ApiError, jsonBody} from './lib/api';
import {displayTime} from './lib/time';
import type {Farm} from './types';
import type {NodeRedGateways, NodeRedOperation, NodeRedReview, NodeRedStatus, NodeRedTarget} from './node-red-types';

const capability = 'node-red-package-management-v1';
const pending = (operation: NodeRedOperation | null) => operation?.state === 'installing' || operation?.state === 'unconfirmed';

/** Capability and membership are live reads, never retained in the offline vault. */
export function NodeRedPackages() {
  const {farm, call, t, online} = useFarm();
  const [generation, setGeneration] = useState(0);
  const [gateways, setGateways] = useState<NodeRedGateways | null>(null);
  const [access, setAccess] = useState<'checking' | 'supported' | 'hidden' | 'error'>('checking');
  const [gatewayId, setGatewayId] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setAccess('checking'); setGateways(null); setGatewayId(''); setBusy(false);
    if (!online || farm.role !== 'owner') {setAccess('hidden'); return () => controller.abort();}
    void (async () => {
      try {
        const farms = await call<{items: Farm[]; capabilities?: string[]}>('/v1/farms', {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])});
        if (controller.signal.aborted) return;
        if (!farms.capabilities?.includes(capability) || !farms.items.some(item => item.id === farm.id && item.role === 'owner')) {setAccess('hidden'); return;}
        const result = await call<NodeRedGateways>(`/v1/farms/${encodeURIComponent(farm.id)}/node-red/gateways`, {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])});
        if (controller.signal.aborted) return;
        setGateways(result); setGatewayId(result.items[0]?.gatewayId ?? ''); setAccess('supported');
      } catch {if (!controller.signal.aborted) setAccess('error');}
    })();
    return () => controller.abort();
  }, [farm.id, farm.role, online, call, generation]);
  if (!online || farm.role !== 'owner' || access === 'hidden' || access === 'checking') return null;
  const selected = gateways?.items.find(item => item.gatewayId === gatewayId);
  return <Section title={t.nodeRedTitle} className="node-red-packages" action={<button type="button" className="text-button" disabled={busy} onClick={() => {
    // Unmount the gateway before a refreshed capability check can complete.
    setAccess('checking'); setGeneration(value => value + 1);
  }}>{t.refresh}</button>}>
    <p className="muted">{t.nodeRedIntro}</p>
    {access === 'error' || gateways?.state === 'unavailable' ? <p role="alert">{t.nodeRedUnavailable}</p> : gateways?.state !== 'configured' || !selected ? <p role="status">{t.nodeRedDisabled}</p> : <>
      <Field label={t.nodeRedGateway}><select value={gatewayId} disabled={busy} onChange={event => setGatewayId(event.target.value)}>{gateways.items.map(item => <option key={item.gatewayId} value={item.gatewayId}>{item.target.label} · {item.gatewayId}</option>)}</select></Field>
      <GatewayPackages key={`${farm.id}:${gatewayId}:${selected.target.id}:${selected.target.revision}:${generation}`} gatewayId={gatewayId} enrolled={selected.target} onBusy={setBusy}/>
    </>}
  </Section>;
}

function GatewayPackages({gatewayId, enrolled, onBusy}: {gatewayId: string; enrolled: NodeRedTarget; onBusy: (value: boolean) => void}) {
  const {farm, call, t, lang, online} = useFarm();
  const prefix = `/v1/farms/${encodeURIComponent(farm.id)}/node-red/gateways/${encodeURIComponent(gatewayId)}/packages`;
  const [status, setStatus] = useState<NodeRedStatus | null>(null);
  const [module, setModule] = useState('');
  const [version, setVersion] = useState('');
  const [review, setReview] = useState<NodeRedReview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<'read' | 'review' | 'install' | 'reconcile' | null>('read');
  const [error, setError] = useState<'unavailable' | 'unconfirmed' | 'expired' | 'selection' | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const operation = status?.operation ?? null;
  const blocked = uncertain || pending(operation);
  const matchingTarget = status?.target?.id === enrolled.id && status.target.revision === enrolled.revision;
  const usable = online && status?.state === 'ready' && matchingTarget;
  const reviewedSelection = review && review.module === module.trim() && review.version === version.trim() && review.target.id === enrolled.id && review.target.revision === enrolled.revision;
  const reviewValid = reviewedSelection && new Date(review.expiresAt).getTime() > Date.now();
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    onBusy(true);
    void call<NodeRedStatus>(prefix, {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])}).then(result => {
      if (!controller.signal.aborted) {setStatus(result); setError(null);}
    }).catch(() => {if (!controller.signal.aborted) setError('unavailable');}).finally(() => {
      if (!controller.signal.aborted) {setBusy(null); onBusy(false);}
    });
    return () => {alive.current = false; controller.abort();};
  }, [prefix, call, onBusy]);
  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(() => {setReview(null); setAcknowledged(false); setError('expired');}, Math.max(0, new Date(review.expiresAt).getTime() - Date.now()));
    return () => clearTimeout(timer);
  }, [review]);
  useEffect(() => {
    if (operation?.state !== 'installing' || !online) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await call<NodeRedStatus>(prefix, {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])});
        if (!controller.signal.aborted) setStatus(result);
      } catch {if (!controller.signal.aborted) setError('unavailable');}
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3_000);
    };
    timer = setTimeout(() => void poll(), 3_000);
    return () => {controller.abort(); clearTimeout(timer);};
  }, [operation?.state, operation?.id, prefix, call, online]);
  function invalidate() {setReview(null); setAcknowledged(false); if (error === 'expired') setError(null);}
  async function action(kind: 'review' | 'install' | 'reconcile', work: () => Promise<void>) {
    if (inFlight.current || !online || !navigator.onLine) return;
    inFlight.current = true; setBusy(kind); onBusy(true); setError(null);
    try {await work();} catch (failure) {if (alive.current) {setError(kind === 'install' ? 'unconfirmed' : failure instanceof ApiError && failure.status === 400 ? 'selection' : 'unavailable'); if (kind === 'install') setUncertain(true);}}
    finally {inFlight.current = false; if (alive.current) {setBusy(null); onBusy(false);}}
  }
  async function readStatus() {
    const result = await call<NodeRedStatus>(prefix);
    if (alive.current) setStatus(result);
    return result;
  }
  function reviewPackage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!usable || blocked || busy) return;
    invalidate();
    void action('review', async () => {
      const result = await call<NodeRedReview>(prefix + '/review', jsonBody({module: module.trim(), version: version.trim()}));
      if (alive.current) {setReview(result); setAcknowledged(false);}
    });
  }
  function install() {
    if (!usable || blocked || busy || !acknowledged || !reviewValid || !review) return;
    const token = review.reviewToken;
    invalidate();
    void action('install', async () => {
      // A single explicit request. This operation never enters the offline outbox.
      const result = await call<NodeRedOperation>(prefix + '/install', {...jsonBody({reviewToken: token, requestId: crypto.randomUUID(), acknowledgeCodeExecution: true}), signal: AbortSignal.timeout(125_000)});
      if (!alive.current) return;
      setStatus(previous => previous ? {...previous, operation: result} : previous);
      // The server returned a durable operation; its state now owns the lock.
      setUncertain(false);
      try {await readStatus();} catch {setError('unavailable');}
    });
  }
  function reconcile() {
    if (busy || !blocked) return;
    void action('reconcile', async () => {
      const result = await call<{operation: NodeRedOperation | null}>(prefix + '/reconcile', jsonBody({}));
      if (!alive.current) return;
      setStatus(previous => previous ? {...previous, operation: result.operation} : previous);
      // An absent operation cannot resolve an uncertain install response.
      if (result.operation && !pending(result.operation)) setUncertain(false);
      await readStatus();
    });
  }
  const stateText = operation?.state === 'installed' ? t.nodeRedSuccess : operation?.state === 'failed' ? t.nodeRedFailed : operation?.state === 'installing' ? t.nodeRedInstalling : t.nodeRedUnconfirmed;
  return <div className="node-red-gateway" aria-busy={busy !== null}>
    <p className="small muted">{enrolled.label} · Node-RED {enrolled.version}</p>
    {busy === 'read' && <p role="status">{t.loading}</p>}
    {error && <p className="notice" role="alert">{error === 'expired' ? t.nodeRedExpired : error === 'unconfirmed' ? t.nodeRedUnconfirmed : error === 'selection' ? t.nodeRedInvalidSelection : t.nodeRedUnavailable}</p>}
    {status && !usable && <p role="alert">{status.state === 'disabled' ? t.nodeRedDisabled : t.nodeRedUnavailable}</p>}
    {(operation || uncertain) && <div className="node-red-operation" role="status">
      <strong>{uncertain ? t.nodeRedUnconfirmed : stateText}</strong>
      {operation && <><p><code>{operation.module}@{operation.version}</code></p><small>{displayTime(operation.updatedAt, lang, farm.timezone)}</small></>}
      {blocked && <button type="button" className="secondary" disabled={busy !== null || !online} onClick={reconcile}>{t.nodeRedReconcile}</button>}
    </div>}
    {status && <><h3>{t.nodeRedInstalled}</h3>{status.packages.length ? <ul className="node-red-inventory">{status.packages.map(item => <li key={item.name}>
      <strong><code>{item.name}</code></strong><span>{item.version}</span>
      <small>{t.nodeRedNodes}: {item.nodeSets} · {t.nodeRedPlugins}: {item.pluginSets}</small>
      {item.loadError && <span className="notice">{t.nodeRedLoadError}</span>}
      {item.pendingVersion && <span>{t.nodeRedPending}: {item.pendingVersion}</span>}
    </li>)}</ul> : <p className="muted">{t.nodeRedEmpty}</p>}</>}
    <form className="form-grid node-red-form" onSubmit={reviewPackage}>
      <fieldset disabled={!usable || blocked || busy !== null}>
        <legend>{t.nodeRedReview}</legend>
        <Field label={t.nodeRedModule}><input value={module} onChange={event => {setModule(event.target.value); invalidate();}} required maxLength={214} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="node-red-contrib-example"/></Field>
        <Field label={t.nodeRedVersion} hint={t.nodeRedVersionHint}><input value={version} onChange={event => {setVersion(event.target.value); invalidate();}} required maxLength={96} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="1.2.3"/></Field>
        <button type="submit" className="secondary">{t.nodeRedReview}</button>
      </fieldset>
    </form>
    <p className="small muted">{t.nodeRedScope}</p>
    {review && reviewedSelection && <section className="node-red-review" aria-label={t.nodeRedReviewTitle}>
      <h3>{t.nodeRedReviewTitle}</h3><p>{t.nodeRedReviewHint}</p>
      <dl><div><dt>{t.nodeRedModule}</dt><dd><code>{review.module}</code></dd></div><div><dt>{t.nodeRedVersion}</dt><dd>{review.version}</dd></div><div><dt>{t.nodeRedGateway}</dt><dd>{review.target.label} · {gatewayId}</dd></div></dl>
      {review.description && <p>{review.description}</p>}
      <p>{t.nodeRedNodes}: {review.nodeSets.join(', ') || '0'} · {t.nodeRedPlugins}: {review.pluginSets.join(', ') || '0'}</p>
      <small>{t.expires}: {displayTime(review.expiresAt, lang, farm.timezone)}</small>
      <p className="notice">{t.nodeRedRisk}</p>
      <label className="check-label"><input type="checkbox" checked={acknowledged} disabled={busy !== null || blocked || !usable} onChange={event => setAcknowledged(event.target.checked)}/>{t.nodeRedAcknowledge}</label>
      <button type="button" className="primary" disabled={!usable || !reviewValid || !acknowledged || blocked || busy !== null} onClick={install}>{t.nodeRedInstall}</button>
    </section>}
  </div>;
}
