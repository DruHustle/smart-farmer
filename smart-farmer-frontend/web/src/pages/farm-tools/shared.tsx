import {useRef,useState,type ReactNode} from 'react';
import {useResource} from '../../lib/resources';
import {useFarm} from '../../context';
import {farmToolWords, type FarmToolKey} from '../../farm-tools-locales';
import {Empty, PageHead} from '../../components/ui';

export const optionalNumber = (data: FormData, key: string): number | undefined => {
  const value = String(data.get(key) ?? '').trim();
  return value === '' ? undefined : Number(value);
};
export const optionalText = (data: FormData, key: string) => String(data.get(key) ?? '').trim() || undefined;
export function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;} catch {return null;}
}
export function SourceLink({value, children}: {value: unknown; children?: ReactNode}) {
  const {t} = useFarm(); const url = safeSourceUrl(value);
  return url ? <a href={url} target="_blank" rel="noreferrer">{children ?? t.sourceReference}</a> : null;
}
export function ToolHeading({name, intro}: {name: FarmToolKey; intro: FarmToolKey}) {
  const {lang, t} = useFarm(); const w = farmToolWords(lang);
  return <><PageHead title={w[name]} subtitle={w[intro]}/>{lang !== 'en' && <p className="tool-language-note">{t.translationNote}</p>}</>;
}
export function ToolEmpty({loading, count}: {loading: boolean; count: number}) {const {t} = useFarm(); return !loading && !count ? <Empty title={t.noData}/> : null;}

/** Nested detail histories retain cursors rather than silently displaying only page one. */
export function useDetailHistory(path:string,itemsKey:'observations'|'logs') {
  const {farm,call,run,online,vault}=useFarm();
  const resource=useResource<Record<string,unknown>>(path,{});
  const [moreBusy,setMoreBusy]=useState(false);
  const current=useRef({path,savedAt:resource.savedAt});current.current={path,savedAt:resource.savedAt};
  const nextCursor=typeof resource.value.nextCursor==='string'?resource.value.nextCursor:null;
  const more=async()=>{
    if(!online||!nextCursor||moreBusy||resource.loading)return;
    const expected=current.current;setMoreBusy(true);
    try{await run(async()=>{
      const page=await call<Record<string,unknown>>(`${path}?limit=100&cursor=${encodeURIComponent(nextCursor)}`);
      if(current.current.path!==expected.path||current.current.savedAt!==expected.savedAt)return;
      const old=Array.isArray(resource.value[itemsKey])?resource.value[itemsKey] as Array<{id:string}>:[];
      const added=Array.isArray(page[itemsKey])?page[itemsKey] as Array<{id:string}>:[];
      const merged={...resource.value,...page,[itemsKey]:[...old,...added.filter(row=>!old.some(item=>item.id===row.id))]};
      resource.setValue(merged);
      await vault.mutate(next=>{const cached=next.data[farm.id]?.resources?.[path];if(cached?.role===farm.role&&current.current.path===expected.path&&current.current.savedAt===expected.savedAt)cached.value=merged;});
    });}finally{setMoreBusy(false);}
  };
  return {...resource,nextCursor,more,moreBusy};
}
