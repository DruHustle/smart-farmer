import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Action, c, Facts, farmPath, Form, projectOptions, selectField, usePanel } from '../completion-ui';
import { object, rows, string, type Row } from '../product';
import { textFor } from '../i18n';
import { canLinkBasicPhone, phoneLinkState } from '../farm-tools';
import type { Language } from '../types';
import type { Workspace } from '../use-workspace';
import { Button, Card, Notice, styles } from '../ui';

export function BasicPhonePanel({ work, language, onNotifications }: { work: Workspace; language: Language; onNotifications: () => void }) {
  const data = usePanel(work, 'basic-phone', () => work.api.request<Row>(farmPath(work, '/basic-phone')));
  const [link, setLink] = useState<Row | null>(null);
  const [, refreshClock] = useState(0);
  const savedLink = object(data.value?.link);
  const state = phoneLinkState(savedLink);
  useEffect(() => {
    if (state !== 'pending' && state !== 'linked') return;
    const expiry = Date.parse(string(state === 'linked' ? savedLink.accessExpiresAt : savedLink.expiresAt));
    const timer = setTimeout(() => refreshClock(value => value + 1), Math.min(2_147_483_647, Math.max(0, expiry - Date.now()) + 1));
    return () => clearTimeout(timer);
  }, [savedLink.id, savedLink.expiresAt, savedLink.accessExpiresAt, state]);
  useEffect(() => {
    if (link?.id === savedLink.id && state !== 'pending') setLink(null);
  }, [link?.id, savedLink.id, state]);
  const channels = rows(data.value?.channels).filter(item => item.channel === 'sms' && !item.disabled_at && (item.state === 'verified' || item.verified_at));
  return <>
    <Notice text={c(language, 'basicPhoneHint')} />
    <Button secondary title={textFor(language).refresh} busy={data.loading} onPress={() => { void data.reload(); }} />
    <Facts value={data.value || {}} fields={['configured', 'provider']} language={language} />
    {data.value?.configured !== true ? <Notice text={c(language, 'provider_unconfigured')} /> : null}
    {Array.isArray(data.value?.requirements) ? <Card title={c(language, 'requirements')}>{data.value.requirements.map((item, index) => <Text key={index} style={styles.text}>{c(language, string(item))}</Text>)}</Card> : null}
    <Button secondary title={c(language, 'notifications')} onPress={onNotifications} />
    {canLinkBasicPhone(work.selectedFarm?.role) && data.value?.configured === true && channels.length ? <Form work={work} language={language} title={c(language, 'linkPhone')} fields={[
      selectField('channelId', channels.map(item => ({ value: string(item.id), label: string(item.masked_address || item.maskedAddress) })), true),
      selectField('projectId', projectOptions(work), true),
      { key: 'consent', label: c(language, 'phoneConsent'), type: 'boolean', required: true },
    ]} submit={body => work.api.request(farmPath(work, '/basic-phone/link'), 'POST', body)} onSaved={async result => { setLink(object(result)); await data.reload(); }} /> : null}
    {state === 'pending' && link?.id === savedLink.id && link?.code ? <Card title={c(language, 'verificationCode')}>
      <Notice text={c(language, 'phoneCodeHint')} />
      <Text selectable style={styles.title}>{string(link.code)}</Text>
      <Facts value={link} fields={['expiresAt']} language={language} timezone={work.snapshot?.farm.timezone || 'Africa/Harare'} />
    </Card> : null}
    {state !== 'none' ? <Card title={c(language, 'basicPhone')}>
      <Notice text={c(language, `phone_${state}`)} />
      <Facts value={savedLink} fields={state === 'pending' ? ['expiresAt'] : ['linkedAt', 'accessExpiresAt', 'revokedAt']} language={language} timezone={work.snapshot?.farm.timezone || 'Africa/Harare'} />
      {state === 'pending' || state === 'linked' ? <Action work={work} language={language} title={c(language, 'revokePhone')} danger action={() => work.api.request(farmPath(work, '/basic-phone/link'), 'DELETE')} onSaved={async () => { setLink(null); await data.reload(); }} /> : null}
    </Card> : null}
    {Array.isArray(data.value?.commands) && data.value.commands.length ? <Card title={c(language, 'commands')}>{data.value.commands.map((item, index) => <Text key={index} selectable style={styles.text}>{typeof item === 'string' ? item : `${string(object(item).command)} ${string(object(item).description)}`}</Text>)}</Card> : null}
  </>;
}
