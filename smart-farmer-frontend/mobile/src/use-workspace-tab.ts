import {useEffect, useRef, useState} from 'react';
import type {LocalRepository} from './repository';

type Tab = 'today' | 'farm' | 'record' | 'forum' | 'more';
const tabs: readonly Tab[] = ['today', 'farm', 'record', 'forum', 'more'];

// Preferences live in the encrypted database for the current Farmer user ID and API origin.
export function useWorkspaceTab(repository: LocalRepository, onError: (error: unknown) => void) {
  const [tab, setTab] = useState<Tab>('today');
  const selected = useRef(false);
  useEffect(() => {
    let active = true;
    selected.current = false;
    setTab('today');
    repository.preference<Tab>('workspaceTab').then(saved => {
      if (active && !selected.current && saved && tabs.includes(saved)) setTab(saved);
    }).catch(reason => { if (active) onError(reason); });
    return () => { active = false; };
  }, [repository, onError]);

  function selectTab(next: Tab) {
    selected.current = true;
    setTab(next);
    void repository.setPreference('workspaceTab', next).catch(onError);
  }
  return [tab, selectTab] as const;
}
