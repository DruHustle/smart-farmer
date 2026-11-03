import {useCallback, useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {Auth} from './Auth';
import {catalog, errorLabel, label} from './locales';
import {ApiError, request, jsonBody, uploadRecord} from './lib/api';
import {displayTime} from './lib/time';
import {drainOutbox, queueRecords} from './lib/sync';
import {Context, type Page} from './context';
import {emptyFarmData, type Farm, type FarmData, type Lang, type OutboxItem} from './types';
import type {Vault} from './lib/vault';
import {Icon} from './components/ui';
import {Today, Tasks, Incidents, SyncPage, More} from './pages/Work';
import {Projects} from './pages/Projects';
import {RecordActivity} from './pages/Record';
import {StockPage, Reports} from './pages/Stock';
import {Equipment} from './pages/Equipment';
import {Market, Services} from './pages/Commerce';
import {Locations, Weather, Notifications, FarmSettings} from './pages/Operations';
import {Maintenance} from './pages/AssetOperations';
import {FinancialReports} from './pages/Finance';
import {allPages} from './lib/resources';
import {Security} from './pages/Security';
import {People} from './pages/People';

const emptySubscribe = () => () => {};
const noSnapshot = () => null;
export function App() {
  const [vault, setVault] = useState<Vault | null>(null);
  const snapshot = useSyncExternalStore(vault?.subscribe ?? emptySubscribe, vault?.snapshot ?? noSnapshot);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [language, setLanguage] = useState<Lang>(() => localStorage.getItem('smart-farmer-language') === 'nd' ? 'nd' : 'sn');
  const [online, setOnline] = useState(navigator.onLine); const [page, setPage] = useState<Page>(new URLSearchParams(location.search).has('listing') ? 'market' : 'today'); const [recordProject, setRecordProject] = useState<string | null>(null); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false); const synchronising = useRef(false);
  const lang = snapshot?.language ?? language, t = catalog[lang];
  const farm = snapshot?.farms.find(f => f.id === snapshot.currentFarmId) ?? snapshot?.farms[0];
  const farmId = farm?.id ?? '';
  const farmData = snapshot?.data[farmId] ?? emptyFarmData();
  const manager = farm?.role === 'owner' || farm?.role === 'manager';
  useEffect(() => {document.documentElement.lang = lang; localStorage.setItem('smart-farmer-language', lang);}, [lang]);
  useEffect(() => {const update = () => setOnline(navigator.onLine); window.addEventListener('online', update); window.addEventListener('offline', update); return () => {window.removeEventListener('online', update); window.removeEventListener('offline', update);};}, []);
  const call = useCallback(async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    if (!vault) throw new ApiError('unauthorized', 401);
    try {return await request<T>(path, vault.snapshot().identity.token, options);} catch (error) {if (error instanceof ApiError && error.status === 401) await vault.mutate(next => {next.requiresAuth = true;}); throw error;}
  }, [vault]);
  const refresh = useCallback(async () => {
    if (!vault || !navigator.onLine) return;
    const farms = await call<{items: Farm[]}>('/v1/farms');
    const previous = vault.snapshot().currentFarmId;
    const current = farms.items.find(f => f.id === previous) ?? farms.items[0];
    await vault.mutate(next => {
      const lostFinancialRole = next.farms.some(old => ['owner', 'manager'].includes(old.role) && !farms.items.some(f => f.id === old.id && ['owner', 'manager'].includes(f.role)));
      const oldRoles = new Map(next.farms.map(f => [f.id, f.role]));
      next.farms = farms.items; next.currentFarmId = current?.id ?? '';
      for (const id of Object.keys(next.data)) {
        const membership = farms.items.find(f => f.id === id);
        if (!membership) {delete next.data[id]; continue;}
        if (oldRoles.get(id) !== membership.role) delete next.data[id].resources;
        if (!['owner', 'manager'].includes(membership.role)) {
          delete next.data[id].report; delete next.data[id].resources;
          next.data[id].bookings = [];
          next.data[id].activities = next.data[id].activities.filter(a => a.kind !== 'cost');
          for (const events of Object.values(next.data[id].events)) for (const event of events) {delete event.metadata.costAllocations; delete event.metadata.amount; delete event.metadata.currency;}
          next.data[id].stock = next.data[id].stock.map(({unit_cost: _cost, currency: _currency, ...stock}) => stock);
        }
      }
      // Seller financial state is refreshed separately; discard it immediately on a role change.
      if (lostFinancialRole) next.orders = undefined;
      for (const item of next.outbox) if (!farms.items.some(f => f.id === item.farmId)) {item.status = 'failed'; item.error = 'forbidden';}
    });
    if (!current) return;
    const base = `/v1/farms/${current.id}`;
    const keys: Array<'projects' | 'activities' | 'tasks' | 'stock' | 'incidents' | 'members' | 'assets' | 'bookings'> = ['projects', 'activities', 'tasks', 'stock', 'incidents', 'members', 'assets', ...(['owner', 'manager'].includes(current.role) ? ['bookings' as const] : [])];
    const responses = await Promise.allSettled(keys.map(key => allPages<unknown>(call, `${base}/${key}`).then(items => ({items}))));
    if (responses.some(r => r.status === 'rejected' && r.reason instanceof ApiError && r.reason.status === 401)) throw new ApiError('unauthorized', 401);
    await vault.mutate(next => {
      const data = next.data[current.id] ?? emptyFarmData();
      data.partial = [];
      responses.forEach((result, index) => {const key = keys[index]; if (result.status === 'fulfilled') Object.assign(data, {[key]: result.value.items}); else data.partial!.push(key);});
      if (!data.partial.length) data.syncedAt = new Date().toISOString();
      next.data[current.id] = data;
    });
  }, [vault, call]);
  const sync = useCallback(async (includeMedia = false) => {
    if (!vault || !navigator.onLine || synchronising.current) return;
    if (vault.snapshot().requiresAuth || new Date(vault.snapshot().identity.expiresAt).getTime() <= Date.now()) {setNotice(t.sessionExpired); return;}
    synchronising.current = true;
    try {
      await drainOutbox(vault, (entry, payload) => entry.mediaId ? uploadRecord(entry.path, vault.snapshot().identity.token, payload, percent => setUploadProgress(old => ({...old, [entry.id]: percent}))) : call(entry.path, jsonBody(payload, entry.method)), includeMedia);
      if (!vault.snapshot().requiresAuth) await refresh();
    } catch (error) {setNotice(errorLabel(t, error));} finally {synchronising.current = false;}
  }, [vault, call, refresh, t]);
  useEffect(() => {if (vault && online) void sync(vault.snapshot().preferences?.automaticMedia ?? false);}, [vault, online, sync]);
  useEffect(() => {if (!vault || !online) return; const timer = setInterval(() => void sync(vault.snapshot().preferences?.automaticMedia ?? false), 60_000); return () => clearInterval(timer);}, [vault, online, sync]);
  async function run(action: () => Promise<void>, success = ''): Promise<boolean> {setBusy(true); setNotice(''); try {await action(); if (success) setNotice(success); return true;} catch (error) {setNotice(errorLabel(t, error)); return false;} finally {setBusy(false);}}
  async function enqueue(entry: Omit<OutboxItem, 'status' | 'attempts' | 'createdAt'> | Array<Omit<OutboxItem, 'status' | 'attempts' | 'createdAt'>>) {
    if (!vault) throw new Error('unauthorized');
    await queueRecords(vault, Array.isArray(entry) ? entry : [entry]);
    setNotice(t.queued);
    if (navigator.onLine) void sync(vault.snapshot().preferences?.automaticMedia ?? false);
  }
  async function changeLanguage(value: Lang) {
    setLanguage(value);
    if (!vault) return;
    await vault.mutate(next => {next.language = value;});
    if (navigator.onLine) {try {await call('/v1/me', jsonBody({language: value}, 'PATCH'));} catch (error) {setNotice(errorLabel(catalog[value], error));}}
  }
  async function logout() {
    if (!vault) return;
    if (navigator.onLine) await request('/v1/sessions/current', vault.snapshot().identity.token, {method: 'DELETE'}).catch(() => {});
    await vault.mutate(next => {next.requiresAuth = true;});
    setVault(null); setNotice(''); setPage('today'); setRecordProject(null);
  }
  function lock() {setVault(null); setNotice(''); setPage('today'); setRecordProject(null);}
  if (!vault || !snapshot) return <Auth language={language} onLanguage={setLanguage} onLogin={v => {setVault(v); setLanguage(v.snapshot().language); setPage(new URLSearchParams(location.search).has('listing') ? 'market' : 'today'); setNotice('');}}/>;
  const navigation = ['today', 'farm', 'market', 'services', 'more'] as const;
  const navPage = ['stock', 'tasks', 'equipment', 'people', 'reports', 'incidents', 'sync', 'security', 'notifications', 'weather', 'maintenance', 'locations', 'settings'].includes(page) ? 'more' : page;
  return <div className="app-shell"><header className="app-header"><div className="brand"><span className="brand-mark"><Icon name="leaf" size={23}/></span><strong>Smart Farmer</strong></div><div className="header-actions"><span className="current-user"><Icon name="people" size={16}/>{snapshot.identity.username}</span><select className="language-select" aria-label={t.language} value={lang} onChange={e => void changeLanguage(e.target.value as Lang)}><option value="sn">Shona</option><option value="nd">isiNdebele</option></select><button className="icon-button" title={t.lock} aria-label={t.lock} onClick={lock}><Icon name="lock" size={18}/></button></div></header>
    <aside className="desktop-nav"><div className="farm-identity"><span className="eyebrow">{t.farm}</span><strong>{farm?.name ?? t.loading}</strong><small>{farm ? label(t, farm.role) : ''}</small></div><nav aria-label={t.more}>{navigation.map(item => <button key={item} className={navPage === item ? 'selected' : ''} onClick={() => setPage(item)}><Icon name={item}/>{t[item]}<Icon name="chevron" size={15}/></button>)}</nav><div className="sidebar-bottom"><Icon name="lock" size={16}/><small>{t.privacy}</small></div></aside>
    <main className="workspace"><div className="workspace-toolbar"><div className="farm-switch"><Icon name="farm" size={18}/><select aria-label={t.farm} value={farmId} disabled={busy || !snapshot.farms.length} onChange={e => {const id = e.target.value; void run(async () => {await vault.mutate(next => {next.currentFarmId = id;}); await refresh();});}}>{snapshot.farms.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></div><button className={`sync-pill ${online ? '' : 'offline'}`} onClick={() => setPage('sync')}><span className={`status-dot ${online ? 'on' : ''}`}/>{online ? t.connected : t.offline}{snapshot.outbox.length > 0 && <strong>{snapshot.outbox.length}</strong>}</button></div>
      <div className="sync-caption"><span>{farmData.syncedAt ? `${t.synced}: ${displayTime(farmData.syncedAt, lang, farm?.timezone ?? 'Africa/Harare')}` : t.neverSynced}</span><button className="text-button" disabled={!online || busy} onClick={() => void run(refresh)}><Icon name="sync" size={14}/>{t.refresh}</button></div>
      {(!online || !!farmData.partial?.length) && <p className="notice subtle" role="status">{!online ? t.offlineOnlyRecords : t.limitedSync}</p>}
      {snapshot.requiresAuth && <div className="notice warning"><span>{t.sessionExpired}</span><button className="text-button" onClick={lock}>{t.signIn}</button></div>}
      {notice && <div className="notice" role="status"><span>{notice}</span><button className="icon-button" aria-label={t.close} onClick={() => setNotice('')}><Icon name="close" size={16}/></button></div>}
      {busy && <div className="working-line" role="status">{t.working}</div>}
      {farm ? <Context.Provider value={{snapshot, vault, farm, data: farmData, t, lang, online, uploadProgress, busy, manager, call, run, refresh, enqueue, sync, navigate: setPage, record: id => setRecordProject(id ?? ''), notify: setNotice}}>
        {page === 'today' && <Today/>}{page === 'farm' && <Projects/>}{page === 'tasks' && <Tasks/>}{page === 'incidents' && <Incidents/>}{page === 'stock' && <StockPage/>}{page === 'reports' && <FinancialReports/>}{page === 'equipment' && <Equipment/>}{page === 'security' && <Security/>}{page === 'market' && <Market/>}{page === 'services' && <Services/>}{page === 'people' && <People/>}{page === 'locations' && <Locations/>}{page === 'weather' && <Weather/>}{page === 'notifications' && <Notifications/>}{page === 'maintenance' && <Maintenance/>}{page === 'settings' && <FarmSettings/>}{page === 'more' && <More onLogout={() => void logout()} onLock={lock}/>} {page === 'sync' && <SyncPage/>}
        {recordProject !== null && <RecordActivity initialProject={recordProject} onClose={() => setRecordProject(null)}/>}
        {recordProject === null && page !== 'market' && page !== 'services' && farm.role !== 'adviser' && <button className="record-fab" disabled={!farmData.projects.length} onClick={() => setRecordProject('')}><Icon name="plus" size={21}/><span>{t.record}</span></button>}
      </Context.Provider> : <div className="loading-card"><Icon name="leaf" size={30}/><p>{online ? t.loading : t.no_saved_data}</p><button onClick={lock}>{t.signIn}</button></div>}
    </main><nav className="mobile-nav" aria-label={t.more}>{navigation.map(item => <button key={item} className={navPage === item ? 'selected' : ''} onClick={() => setPage(item)}><Icon name={item}/><span>{t[item]}</span></button>)}</nav></div>;
}
