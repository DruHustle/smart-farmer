import {createContext, useContext} from 'react';
import type {Farm, FarmData, Lang, OutboxItem, Snapshot} from './types';
import type {Words} from './locales';
import type {Vault} from './lib/vault';
export type Page = 'today' | 'farm' | 'forum' | 'market' | 'services' | 'more' | 'stock' | 'tasks' | 'equipment' | 'people' | 'reports' | 'incidents' | 'sync' | 'security' | 'weather' | 'notifications' | 'maintenance' | 'locations' | 'settings';
export type FarmContext = {
  snapshot: Snapshot; vault: Vault; farm: Farm; data: FarmData; t: Words; lang: Lang; online: boolean; uploadProgress: Record<string, number>; busy: boolean; manager: boolean;
  call: <T = Record<string, unknown>>(path: string, options?: RequestInit) => Promise<T>;
  run: (action: () => Promise<void>, success?: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  enqueue: (entry: Omit<OutboxItem, 'status' | 'attempts' | 'createdAt'> | Array<Omit<OutboxItem, 'status' | 'attempts' | 'createdAt'>>) => Promise<void>;
  sync: (includeMedia?: boolean) => Promise<void>;
  navigate: (page: Page) => void;
  record: (projectId?: string) => void;
  notify: (message: string) => void;
};
export const Context = createContext<FarmContext | null>(null);
export function useFarm(): FarmContext {const value = useContext(Context); if (!value) throw new Error('Farm context missing'); return value;}
