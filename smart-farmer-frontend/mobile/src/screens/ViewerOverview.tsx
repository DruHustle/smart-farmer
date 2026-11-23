import React from 'react';
import { Text } from 'react-native';
import { ApiError } from '../api';
import { c, Records, usePanel } from '../completion-ui';
import { textFor } from '../i18n';
import type { Row } from '../product';
import type { Language } from '../types';
import { Button, Card, Notice, styles } from '../ui';
import type { Workspace } from '../use-workspace';
import { AccountDeletion } from './AccountDeletion';

type Overview = Record<'projects' | 'tasks' | 'stock' | 'incidents', Row[]>;

export function ViewerOverview({ work, language, logout, lock, children }: {
  work: Workspace; language: Language; logout: () => void; lock: () => void; children: React.ReactNode;
}) {
  const t = textFor(language);
  const {value, loading, reload} = usePanel(work, 'viewer-overview', () =>
    work.api.request<Overview>(`/v1/farms/${work.farmId}/viewer-overview`));
  const unavailable = work.online && work.error instanceof ApiError && work.error.status === 404;
  const timezone = work.selectedFarm?.timezone || 'Africa/Harare';
  const sections = [
    {key: 'projects', title: t.projects, titleKey: 'name', fields: ['enterprise_type', 'status']},
    {key: 'tasks', title: t.tasks, titleKey: 'title', fields: ['status', 'due_at']},
    {key: 'stock', title: t.stock, titleKey: 'name', fields: ['quantity', 'unit']},
    {key: 'incidents', title: c(language, 'incidents'), titleKey: 'title', fields: ['severity', 'status']},
  ] as const;
  return <>
    <Notice text={t.viewerAccess}/>
    {work.online ? <Button secondary title={t.refresh} busy={loading} onPress={() => {void reload();}}/> : <Text style={styles.caption}>{t.offline}</Text>}
    {value && !unavailable && sections.map(section => <Card key={section.key} title={section.title}>
      <Records items={value[section.key]} titleKey={section.titleKey} fields={[...section.fields]} language={language} timezone={timezone}/>
    </Card>)}
    {children}
    <AccountDeletion work={work} language={language}/>
    <Button secondary title={t.lock} onPress={lock}/>
    <Button secondary title={t.logout} onPress={logout}/>
  </>;
}
