import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { errorText, label, textFor } from '../i18n';
import { formatFarmTime } from '../time';
import type { Language, Mutation, Task } from '../types';
import { Button, Card, Choice, Field, Notice, Sheet, Toggle, styles } from '../ui';
import type { Workspace } from '../use-workspace';
import { Action, c, Form, options, selectField, usePanel, farmPath, Records } from '../completion-ui';
import { allPages, type Row } from '../product';
import { EquipmentPanel } from './EquipmentPanel';
import { MarketplacePanel } from './MarketplacePanel';
import { ServicesPanel } from './ServicesPanel';
import { FinancePanel } from './FinancePanel';
import { IncidentsPanel, WeatherPanel, NotificationsPanel, FarmSettingsPanel } from './OperationsPanel';
import { SecurityPanel } from './SecurityPanel';
import { MediaPanel } from './MediaPanel';

type DeviceSession = { id: string; label: string; created_at: string; expires_at: string; current: boolean };
export function MoreScreen({ work, language, onLogout, onLock, onNativePrompt }: { work: Workspace; language: Language; onLogout: () => void; onLock: () => void; onNativePrompt: (active: boolean) => void }) {
  const t = textFor(language);
  const [screen, setScreen] = useState<string | null>(null);
  const [role, setRole] = useState('worker'); const [code, setCode] = useState(''); const [inviteToken, setInviteToken] = useState('');
  const [password, setPassword] = useState(''); const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [conflict, setConflict] = useState<Mutation | null>(null);
  const [serverTask, setServerTask] = useState<Task | null>(null);
  const invitations = usePanel(work, 'invitations', () => work.canManage ? allPages<Row>(work.api, farmPath(work, '/invitations')) : Promise.resolve([]));
  const pending = work.mutations.filter(item => item.state !== 'resolved');
  const pendingMedia = work.attachments.filter(item => item.state !== 'synced' && item.state !== 'draft');
  const timezone = work.snapshot?.farm.timezone || 'Africa/Harare';

  function open(value: NonNullable<typeof screen>) { setScreen(value); setCode(''); setInviteToken(''); setPassword(''); setConflict(null); setServerTask(null); work.setError(null); }
  useEffect(() => {
    if (screen === 'sessions') void work.onlineAction(async () => { const result = await work.api.request<{ items: DeviceSession[] }>('/v1/sessions'); setDevices(result.items); });
  }, [screen]);

  async function invite() {
    await work.onlineAction(async () => { const response = await work.api.request<{ token: string }>(`/v1/farms/${work.farmId}/invitations`, 'POST', { role }); setCode(response.token); await invitations.reload(); });
  }
  async function acceptInvite() {
    const success = await work.onlineAction(async () => { await work.api.request('/v1/invitations/accept', 'POST', { token: inviteToken.trim() }); });
    if (success) { setInviteToken(''); setScreen(null); await work.refresh(); }
  }
  async function recover() {
    await work.onlineAction(async () => { const response = await work.api.request<{ recoveryCode: string }>('/v1/recovery-codes', 'POST', { password }); setPassword(''); setCode(response.recoveryCode); });
  }
  async function retry(item: Mutation) {
    await work.repository.updateMutation({ ...item, state: 'pending', attempts: 0, lastError: null });
    await work.reloadLocal(); if (work.online) await work.sync();
  }
  async function review(item: Mutation) {
    setConflict(item); setServerTask(null);
    if (item.kind === 'task-status') await work.onlineAction(async () => {
      const tasks = await allPages<Task>(work.api, `/v1/farms/${work.farmId}/tasks`);
      setServerTask(tasks.find(task => task.id === item.resourceId) || null);
    });
  }
  async function keepServer() {
    if (!conflict) return;
    await work.repository.updateMutation({ ...conflict, state: 'resolved' });
    for (const attachment of work.attachments.filter(item => item.activityId === conflict.id && item.state !== 'synced')) await work.repository.updateAttachment({ ...attachment, state: 'blocked', lastError: 'idempotency_conflict' });
    setConflict(null); await work.reloadLocal();
  }
  async function applyReviewed() {
    if (!conflict || !serverTask) return;
    const success = await work.onlineAction(async () => {
      await work.api.request(`/v1/farms/${work.farmId}/tasks/${serverTask.id}`, 'PATCH', { ...conflict.body, version: serverTask.version, reason: String(conflict.body.reason || t.resolve) });
      await work.repository.updateMutation({ ...conflict, state: 'resolved' });
    });
    if (success) { setConflict(null); await work.reloadLocal(); await work.refresh(); }
  }

  return <>
    <Text style={styles.title}>{t.more}</Text>
    <Card><Text style={styles.heading}>{work.session.username}</Text><Text style={styles.muted}>{label(language, work.selectedFarm?.role || '')} · {work.selectedFarm?.name}</Text><Text style={styles.caption}>{t.localPrivacy}</Text><View style={styles.row}><Button secondary title={t.lock} onPress={onLock} /><Button secondary title={t.logout} onPress={onLogout} /></View></Card>
    <View style={styles.grid}>
      {[['sync', `${t.outbox} (${pending.length})`], ['equipment', t.equipment], ['security', c(language, 'security')], ['incidents', c(language, 'incidents')], ['weather', c(language, 'weather')], ['market', t.market], ['services', t.services], ...(work.canManage ? [['finance', c(language, 'finance')], ['settings', c(language, 'settings')]] : []), ['media', c(language, 'media')], ['notifications', c(language, 'notifications')], ['team', t.team], ['sessions', t.sessions], ['recovery', t.recovery]].map(([value, title]) => <View key={value} style={{ minWidth: 140, flexGrow: 1, flexBasis: '45%' }}><Button testID={`more-${value}`} secondary title={title!} onPress={() => open(value!)} /></View>)}
    </View>
    <Card title={t.configuration}><Toggle label={t.dataSaver} hint={t.dataSaverHint} value={work.dataSaver} onChange={value => { void work.setDataSaver(value).catch(work.setError); }} /><Toggle label={t.taskReminders} hint={t.remindersHint} value={work.reminders} onChange={value => { void work.setReminders(value); }} /><Text style={styles.caption}>{t.translations}</Text></Card>
    <Sheet title={screen === 'sync' ? t.outbox : screen ? c(language, screen) : t.more} visible={Boolean(screen)} onClose={() => { setScreen(null); setCode(''); setPassword(''); }} closeLabel={t.close}>
      {work.error ? <Notice error text={errorText(language, work.error)} /> : null}
      {screen === 'sync' ? <>
        <Text style={styles.muted}>{t.lastSync}: {work.snapshot?.syncedAt ? formatFarmTime(work.snapshot.syncedAt, timezone, language) : t.neverSynced}</Text>
        <Button title={t.sync} busy={work.busy} onPress={() => { void work.sync(); }} />
        {!pending.length && !pendingMedia.length ? <Text style={styles.text}>{t.noPending}</Text> : null}
        {pending.map(item => <Card key={item.id} title={label(language, String(item.body.kind || item.body.type || 'task'))}>
          <Text style={styles.caption}>{item.id.slice(0, 8)} · {label(language, item.state)} · {t.attempts}: {item.attempts}</Text>
          {item.lastError === 'access_revoked' ? <Notice text={t.access_revoked} /> : <Text style={styles.text}>{String(item.body.note || item.body.evidence || '')}</Text>}
          {item.lastError ? <Text style={styles.muted}>{errorText(language, new Error(item.lastError))}</Text> : null}
          {item.state === 'conflict' ? <Button secondary title={t.resolve} onPress={() => { void review(item); }} /> : null}
          {item.lastError !== 'access_revoked' ? <Button secondary title={t.retry} disabled={work.busy} onPress={() => { void retry(item).catch(work.setError); }} /> : null}
        </Card>)}
        {pendingMedia.length ? <Card title={`${t.media} (${pendingMedia.length})`}><Text style={styles.caption}>{t.mediaHint}</Text>
          {pendingMedia.map(item => <View key={item.id} style={styles.item}><Text style={styles.text}>{item.mimeType.startsWith('image/') ? t.photos : item.mimeType === 'application/pdf' ? c(language, 'document') : t.voiceNote} · {Math.ceil(item.sizeBytes / 1024)} KiB · {label(language, item.state)}</Text>{item.lastError ? <Text style={styles.caption}>{errorText(language, new Error(item.lastError))}</Text> : null}
            {item.lastError !== 'access_revoked' && ['blocked', 'conflict'].includes(item.state) ? <Button secondary title={t.retry} onPress={() => { void work.repository.updateAttachment({ ...item, state: 'pending', attempts: 0, lastError: null }).then(() => work.reloadLocal()).catch(work.setError); }} /> : null}
          </View>)}
          {work.progress ? <Text style={styles.text}>{work.progress.percent}%</Text> : null}<Button title={t.upload} busy={work.busy} onPress={() => { void work.sync(true); }} /></Card> : null}
        <Text style={styles.caption}>{t.conflictHint}</Text>
        {work.mutations.filter(item => item.state === 'resolved').map(item => <Text key={item.id} style={styles.caption}>{t.resolved} · {item.id.slice(0, 8)}</Text>)}
      </> : null}
      {screen === 'equipment' ? <EquipmentPanel work={work} language={language} onNativePrompt={onNativePrompt} /> : null}
      {screen === 'market' ? <MarketplacePanel work={work} language={language} /> : null}
      {screen === 'services' ? <ServicesPanel work={work} language={language} /> : null}
      {screen === 'finance' && work.canManage ? <FinancePanel work={work} language={language} /> : null}
      {screen === 'incidents' ? <IncidentsPanel work={work} language={language} /> : null}
      {screen === 'weather' ? <WeatherPanel work={work} language={language} /> : null}
      {screen === 'notifications' ? <NotificationsPanel work={work} language={language} /> : null}
      {screen === 'settings' && work.canManage ? <FarmSettingsPanel work={work} language={language} /> : null}
      {screen === 'media' ? <MediaPanel work={work} language={language} onNativePrompt={onNativePrompt} /> : null}
      {screen === 'security' ? <SecurityPanel work={work} language={language} /> : null}
      {screen === 'team' ? <>
        {(work.snapshot?.members || []).map(member => <View key={member.id} style={styles.item}><Text style={styles.text}>{member.username} · {label(language, member.role)}</Text>{work.selectedFarm?.role === 'owner' ? <><Form work={work} language={language} includeId={false} fields={[selectField('role', options(language, ['owner', 'manager', 'worker', 'adviser']), true)]} initial={{ role: member.role }} submit={body => work.api.request(`/v1/farms/${work.farmId}/members/${member.id}`, 'PATCH', body)} onSaved={work.refresh} /><Action work={work} language={language} danger title={t.revoke} detail={`${member.username} · ${c(language, 'revokeMemberHint')}`} action={() => work.api.request(`/v1/farms/${work.farmId}/members/${member.id}`, 'DELETE')} onSaved={work.refresh} /></> : null}</View>)}
        {work.canManage ? <Card title={t.invite}><Choice label={t.role} value={role} onChange={setRole} closeLabel={t.close} options={['worker', 'adviser', ...(work.selectedFarm?.role === 'owner' ? ['manager'] : [])].map(value => ({ value, label: label(language, value) }))} /><Button title={t.invite} busy={work.busy} onPress={() => { void invite(); }} />{code ? <><Text style={styles.text}>{t.invitationCreated}</Text><Text selectable style={styles.text}>{code}</Text></> : null}</Card> : null}
        {work.canManage ? <Records items={invitations.value || []} language={language} timezone={timezone} fields={['role', 'created_at', 'expires_at', 'accepted_at']}>{item => !item.accepted_at ? <Action work={work} language={language} title={t.revoke} danger action={() => work.api.request(farmPath(work, `/invitations/${item.id}`), 'DELETE')} onSaved={invitations.reload} /> : null}</Records> : null}
        <Card title={t.join}><Field label={t.invitationCode} value={inviteToken} onChangeText={setInviteToken} secureTextEntry autoCapitalize="none" autoCorrect={false} /><Button title={t.join} busy={work.busy} disabled={!inviteToken.trim()} onPress={() => { void acceptInvite(); }} /></Card>
      </> : null}
      {screen === 'recovery' ? <><Text style={styles.muted}>{t.recoveryHint}</Text><Field label={t.password} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" maxLength={128} /><Button title={t.createRecovery} busy={work.busy} onPress={() => { void recover(); }} />{code ? <Card><Text style={styles.text}>{t.recoveryCreated}</Text><Text selectable style={styles.text}>{code}</Text></Card> : null}</> : null}
      {screen === 'sessions' ? devices.map(device => <Card key={device.id} title={device.current ? t.currentSession : device.label || t.sessions}><Text style={styles.caption}>{formatFarmTime(device.created_at, timezone, language)} → {formatFarmTime(device.expires_at, timezone, language)}</Text><Button secondary title={t.revoke} busy={work.busy} onPress={() => { void work.onlineAction(async () => { await work.api.request(`/v1/sessions/${encodeURIComponent(device.id)}`, 'DELETE'); if (device.current) onLogout(); else setDevices(previous => previous.filter(item => item.id !== device.id)); }); }} /></Card>) : null}

    </Sheet>
    <Sheet title={t.resolve} visible={Boolean(conflict)} onClose={() => setConflict(null)} closeLabel={t.close}>
      {work.error ? <Notice error text={errorText(language, work.error)} /> : null}<Text style={styles.muted}>{t.conflictHint}</Text>
      <Card title={t.proposedChange}><Text style={styles.text}>{conflict ? label(language, String(conflict.body.status || conflict.body.kind || conflict.body.type || 'observation')) : ''}</Text><Text style={styles.text}>{String(conflict?.body.note || conflict?.body.evidence || '')}</Text></Card>
      {serverTask ? <Card title={t.currentServer}><Text style={styles.text}>{serverTask.title} · {label(language, serverTask.status)}</Text><Text style={styles.muted}>{serverTask.evidence}</Text><Button title={t.applyReviewed} busy={work.busy} onPress={() => { void applyReviewed(); }} /></Card> : null}
      <Button secondary title={t.keepServer} onPress={() => { void keepServer().catch(work.setError); }} />
    </Sheet>
  </>;
}
