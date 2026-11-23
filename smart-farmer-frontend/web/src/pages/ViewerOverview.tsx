import {useEffect, useState, type ReactNode} from 'react';
import {displayTime} from '../lib/time';
import {errorLabel, label, type Words} from '../locales';
import type {Farm, Lang} from '../types';
import type {FarmContext} from '../context';
import {ExpandForm, PageHead, Section} from '../components/ui';

type Overview = {
  projects: {id: string; name: string; enterprise_type: string; status: string}[];
  tasks: {id: string; title: string; due_at: string | null; status: string}[];
  stock: {id: string; name: string; quantity: string; unit: string}[];
  incidents: {id: string; title: string; severity: string; status: string}[];
};

export function ViewerOverview({farm, lang, t, call, online, accountDeletion, logout, children}: {
  farm: Farm; lang: Lang; t: Words; call: FarmContext['call']; online: boolean;
  accountDeletion: () => void; logout: () => void; children: ReactNode;
}) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setData(null);
    setError(null);
    if (online) {
      void call<Overview>(`/v1/farms/${farm.id}/viewer-overview`)
        .then(overview => {if (current) setData(overview);})
        .catch(value => {if (current) setError(value);});
    }
    return () => {current = false;};
  }, [call, farm.id, online, attempt]);

  const sections = data ? [
    {title: t.projects, items: data.projects.map(item => ({id: item.id, title: item.name, summary: label(t, item.enterprise_type) + ' · ' + label(t, item.status)}))},
    {title: t.tasks, items: data.tasks.map(item => ({id: item.id, title: item.title, summary: [label(t, item.status), item.due_at && displayTime(item.due_at, lang, farm.timezone)].filter(Boolean).join(' · ')}))},
    {title: t.stock, items: data.stock.map(item => ({id: item.id, title: item.name, summary: item.quantity + ' ' + label(t, item.unit)}))},
    {title: t.incidents, items: data.incidents.map(item => ({id: item.id, title: item.title, summary: label(t, item.severity) + ' · ' + label(t, item.status)}))},
  ] : [];
  return <div data-testid="viewer-overview">
    <PageHead title={farm.name}/>
    <p>{t.viewerAccess}</p>
    {!online ? <p role="status">{t.online_required}</p> : error ? <p role="alert">{errorLabel(t, error)}</p> : !data ? <p role="status">{t.loading}</p> : null}
    <button type="button" className="text-button" disabled={!online} onClick={() => setAttempt(value => value + 1)}>{t.refresh}</button>
    {sections.map(({title, items}) => <Section key={title} title={title}>
      {items.length ? <ul>{items.map(item => <li key={item.id}><strong>{item.title}</strong> · {item.summary}</li>)}</ul> : <p>{t.noData}</p>}
    </Section>)}
    <ExpandForm title={t.join}>{children}</ExpandForm>
    <div className="header-actions">
      <button type="button" className="text-button" onClick={accountDeletion}>{t.deletionTitle}</button>
      <button type="button" className="text-button" onClick={logout}>{t.logout}</button>
    </div>
  </div>;
}
