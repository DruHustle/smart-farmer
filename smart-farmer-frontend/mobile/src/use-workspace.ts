import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NetworkStateType, useNetworkState } from 'expo-network';
import { ApiError, createApi } from './api';
import { LocalRepository } from './repository';
import { Synchronizer } from './sync';
import { clearReminders, enableReminders, scheduleTaskReminders } from './reminders';
import type { Activity, Asset, Attachment, Farm, FarmSnapshot, Language, Member, Mutation, Project, Session, Stock, Task } from './types';

type Items<T> = { items: T[] };
export function useWorkspace(session: Session, repository: LocalRepository, language: Language, onExpired: () => void) {
  const api = useMemo(() => createApi(session.origin, session.token), [session.origin, session.token]);
  const synchronizer = useMemo(() => new Synchronizer(repository, api), [repository, api]);
  const network = useNetworkState();
  const online = network.isConnected === true && network.isInternetReachable !== false;
  const [farms, setFarms] = useState<Farm[]>([]);
  const [farmId, setFarmId] = useState('');
  const [snapshot, setSnapshot] = useState<FarmSnapshot | null>(null);
  const [mutations, setMutations] = useState<Mutation[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [dataSaver, setDataSaverState] = useState(true);
  const [reminders, setRemindersState] = useState(false);
  const [progress, setProgress] = useState<{ id: string; percent: number } | null>(null);
  const alive = useRef(true);
  const currentFarm = useRef('');
  const currentFarms = useRef<Farm[]>([]);
  const settings = useRef({ dataSaver, reminders, language, online, wifi: network.type === NetworkStateType.WIFI });
  settings.current = { dataSaver, reminders, language, online, wifi: network.type === NetworkStateType.WIFI };
  const refreshing = useRef(false);
  const ready = useRef(false);

  const reportError = useCallback((value: unknown) => {
    if (!alive.current) return;
    setError(value);
    if (value instanceof ApiError && value.status === 401) onExpired();
  }, [onExpired]);

  const reloadLocal = useCallback(async (id = currentFarm.current) => {
    if (!id || !alive.current) return;
    const [queued, files] = await Promise.all([repository.mutations(id), repository.attachments(id)]);
    if (alive.current && currentFarm.current === id) { setMutations(queued); setAttachments(files); }
  }, [repository]);

  async function download(farm: Farm) {
    const base = `/v1/farms/${farm.id}`;
    const [projects, tasks, activities, stock, members, assets] = await Promise.all([
      api.request<Items<Project>>(`${base}/projects`), api.request<Items<Task>>(`${base}/tasks`),
      api.request<Items<Activity>>(`${base}/activities`), api.request<Items<Stock>>(`${base}/stock`),
      api.request<Items<Member>>(`${base}/members`), api.request<Items<Asset>>(`${base}/assets`),
    ]);
    if (!alive.current) return;
    const next: FarmSnapshot = { farm, projects: projects.items, tasks: tasks.items, activities: activities.items, stock: stock.items, members: members.items, assets: assets.items, syncedAt: new Date().toISOString() };
    await repository.saveSnapshot(next);
    if (alive.current && currentFarm.current === farm.id) setSnapshot(next);
    if (settings.current.reminders) await scheduleTaskReminders(next.tasks.filter(task => task.assignee_id === session.userId), settings.current.language);
  }

  async function flush(id: string, forceMedia = false) {
    if (!id) return;
    const result = await synchronizer.flush(id, {
      media: forceMedia || !settings.current.dataSaver || settings.current.wifi,
      onProgress: (mediaId, percent) => { if (alive.current) setProgress({ id: mediaId, percent }); },
    });
    if (!alive.current) return;
    if (result.unauthorized) { onExpired(); return; }
    await reloadLocal(id);
    setProgress(null);
    if (result.failed) setNotice('conflictHint');
    return result;
  }

  async function refresh() {
    if (refreshing.current || !alive.current || !ready.current) return;
    refreshing.current = true; setBusy(true); setError(null);
    try {
      const result = await api.request<Items<Farm>>('/v1/farms');
      if (!alive.current) return;
      for (const previous of currentFarms.current) {
        const updated = result.items.find(farm => farm.id === previous.id);
        if (!updated || updated.role !== previous.role) {
          await repository.revokeFarm(previous.id);
          if (currentFarm.current === previous.id) { setSnapshot(null); setMutations([]); setAttachments([]); }
        }
      }
      const selected = result.items.find(farm => farm.id === currentFarm.current) || result.items[0];
      currentFarms.current = result.items; setFarms(result.items);
      await repository.setPreference('farms', result.items);
      if (!selected) { currentFarm.current = ''; setFarmId(''); setSnapshot(null); return; }
      currentFarm.current = selected.id; setFarmId(selected.id);
      await repository.setPreference('selectedFarm', selected.id);
      const pendingLanguage = await repository.preference<Language>('languageToSync');
      if (pendingLanguage) { await api.request('/v1/me', 'PATCH', { language: pendingLanguage }); await repository.setPreference('languageToSync', null); }
      const resultSync = await flush(selected.id);
      if (resultSync?.unauthorized || !alive.current) return;
      await download(selected);
    } catch (value) { reportError(value); }
    finally { refreshing.current = false; if (alive.current) setBusy(false); }
  }

  async function selectFarm(id: string) {
    if (id === currentFarm.current) return;
    const farm = currentFarms.current.find(value => value.id === id);
    if (!farm) return;
    currentFarm.current = id; setFarmId(id); setSnapshot(null); setMutations([]); setAttachments([]); setError(null);
    await repository.setPreference('selectedFarm', id);
    const cached = await repository.snapshot(id);
    if (alive.current && currentFarm.current === id) setSnapshot(cached);
    await reloadLocal(id);
    if (settings.current.online && !refreshing.current) await refresh();
  }

  async function sync(forceMedia = false) {
    if (busy || !alive.current) return;
    if (!settings.current.online) { setError(new Error('onlineRequired')); return; }
    setBusy(true); setError(null);
    try {
      const id = currentFarm.current;
      const result = await flush(id, forceMedia);
      const farm = currentFarms.current.find(item => item.id === id);
      if (farm && !result?.unauthorized) await download(farm);
    } catch (value) { reportError(value); }
    finally { if (alive.current) { setBusy(false); setProgress(null); } }
  }

  async function onlineAction(action: () => Promise<void>) {
    if (!settings.current.online) { setError(new Error('onlineRequired')); return false; }
    setBusy(true); setError(null); setNotice('');
    try { await action(); return true; } catch (value) { reportError(value); return false; }
    finally { if (alive.current) setBusy(false); }
  }

  async function setDataSaver(value: boolean) { await repository.setPreference('dataSaver', value); setDataSaverState(value); }
  async function setReminders(value: boolean) {
    try {
      if (value) { await enableReminders(); if (snapshot) await scheduleTaskReminders(snapshot.tasks.filter(task => task.assignee_id === session.userId), language); }
      else await clearReminders();
      await repository.setPreference('reminders', value); setRemindersState(value);
    } catch (value) { reportError(value); }
  }

  useEffect(() => {
    alive.current = true;
    void (async () => {
      const [cached, selected, saver, alerts] = await Promise.all([
        repository.preference<Farm[]>('farms'), repository.preference<string>('selectedFarm'),
        repository.preference<boolean>('dataSaver'), repository.preference<boolean>('reminders'),
      ]);
      if (!alive.current) return;
      currentFarms.current = cached || []; setFarms(currentFarms.current);
      setDataSaverState(saver !== false); setRemindersState(alerts === true);
      const chosen = currentFarms.current.find(farm => farm.id === selected) || currentFarms.current[0];
      if (chosen) {
        currentFarm.current = chosen.id; setFarmId(chosen.id);
        const saved = await repository.snapshot(chosen.id);
        if (alive.current) setSnapshot(saved);
        await reloadLocal(chosen.id);
      }
      ready.current = true;
      await refresh();
    })().catch(reportError);
    return () => { alive.current = false; };
  }, [repository]);

  useEffect(() => { if (online && ready.current) void refresh(); }, [online]);
  useEffect(() => {
    void repository.setPreference('languageToSync', language).then(async () => {
      if (settings.current.online && alive.current) {
        await api.request('/v1/me', 'PATCH', { language });
        await repository.setPreference('languageToSync', null);
      }
    }).catch(reportError);
  }, [language, repository]);

  const selectedFarm = farms.find(farm => farm.id === farmId);
  return { api, repository, session, farms, farmId, selectedFarm, snapshot, mutations, attachments, busy, online, network,
    error, setError: reportError, notice, setNotice, progress, dataSaver, setDataSaver, reminders, setReminders,
    selectFarm, reloadLocal, refresh, sync, onlineAction, canManage: selectedFarm?.role === 'owner' || selectedFarm?.role === 'manager' };
}
export type Workspace = ReturnType<typeof useWorkspace>;
