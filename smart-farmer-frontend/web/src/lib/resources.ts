import {useCallback, useEffect, useRef, useState} from 'react';
import {useFarm} from '../context';
import {allPages, type PageResult} from './pages.ts';
export {allPages};
export type {PageResult};
/** Feature caches live in the same encrypted, farm- and role-scoped vault as field records. */
export function useResource<T>(path: string | null, initial: T) {
  const {call, farm, vault, online, run, data, snapshot} = useFarm();
  const queuedRevision = snapshot.outbox.filter(entry => entry.path === path?.split('?')[0]).map(entry => `${entry.id}:${entry.status}`).join('|');
  const cached = path ? data.resources?.[path] : undefined;
  const [value, setValue] = useState<T>(() => cached?.role === farm.role ? cached.value as T : initial);
  const [savedAt, setSavedAt] = useState(cached?.savedAt ?? '');
  const [loading, setLoading] = useState(false); const [failed, setFailed] = useState(false);
  const identity = `${farm.id}:${farm.role}:${path}`; const [valueIdentity, setValueIdentity] = useState(identity); const current = useRef(identity); current.current = identity;
  // An initial read can finish after a post-save reload for the same identity.
  const readSequence = useRef(0);
  const reload = useCallback(async () => {
    if (!path || !online) return;
    const identityAtRead = `${farm.id}:${farm.role}:${path}`;
    if (current.current !== identityAtRead) return;
    const sequence = ++readSequence.current;
    const isCurrent = () => current.current === identityAtRead && readSequence.current === sequence;
    setLoading(true);
    try {
      const response = await call<T>(path);
      const at = new Date().toISOString();
      if (!isCurrent()) return;
      setValue(response); setValueIdentity(identityAtRead); setSavedAt(at); setFailed(false);
      await vault.mutate(next => {
        // Writes are queued: another read can start before this callback runs.
        if (!isCurrent()) return;
        const membership = next.farms.find(f => f.id === farm.id);
        const target = next.data[farm.id];
        if (!target || membership?.role !== farm.role) return;
        target.resources ??= {}; target.resources[path] = {value: response, savedAt: at, role: farm.role};
      });
    } catch (error) {
      if (!isCurrent()) return;
      setFailed(true);
      const status = Number((error as {status?: number}).status);
      if (status === 403 || status === 404) {
        setValue(initial); setSavedAt('');
        await vault.mutate(next => {
          if (!isCurrent() || next.farms.find(f => f.id === farm.id)?.role !== farm.role) return;
          if (next.data[farm.id]?.resources) delete next.data[farm.id].resources![path];
        });
      }
      if (isCurrent()) throw error;
    }
    finally {if (isCurrent()) setLoading(false);}
  }, [path, online, farm.id, farm.role, call, vault]);
  useEffect(() => {
    const stored = path ? vault.snapshot().data[farm.id]?.resources?.[path] : undefined;
    setValue(stored?.role === farm.role ? stored.value as T : initial); setValueIdentity(identity); setSavedAt(stored?.savedAt ?? '');
    setFailed(false); setLoading(false); if (online && path) void run(reload);
    return () => {readSequence.current++;};
  }, [identity, online, queuedRevision]);
  return {value: valueIdentity === identity ? value : cached?.role === farm.role ? cached.value as T : initial, setValue, savedAt: valueIdentity === identity ? savedAt : '', loading, failed, reload};
}
export function useList<T extends {id: string}>(path: string | null) {
  const {call, run, online, vault, farm} = useFarm(); const resource = useResource<PageResult<T>>(path, {items: []});
  const [moreBusy, setMoreBusy] = useState(false); const identity = `${farm.id}:${farm.role}:${path}`; const current = useRef(identity); current.current = identity;
  const more = async () => {
    if (!online || !path || !resource.value.nextCursor || moreBusy) return;
    setMoreBusy(true);
    const identityAtRead = identity;
    try {await run(async () => {const page = await call<PageResult<T>>(`${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(resource.value.nextCursor!)}&limit=100`); if (current.current !== identityAtRead) return; const merged = {...resource.value, items: [...resource.value.items, ...page.items.filter(item => !resource.value.items.some(old => old.id === item.id))], nextCursor: page.nextCursor}; resource.setValue(merged); await vault.mutate(next => {const target = next.data[farm.id]?.resources?.[path]; if (target?.role === farm.role) target.value = merged;});});}
    finally {setMoreBusy(false);}
  };
  return {...resource, items: resource.value.items ?? [], nextCursor: resource.value.nextCursor, more, moreBusy};
}
