import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { errorText, label, textFor } from '../i18n';
import { formatFarmTime } from '../time';
import type { Language, Mutation, Task } from '../types';
import { Button, Card, Choice, Field, Notice, Sheet, Toggle, styles } from '../ui';
import type { Workspace } from '../use-workspace';

type DeviceSession = { id: string; label: string; created_at: string; expires_at: string; current: boolean };
type Listing = { id: string; title?: string; name?: string; available_quantity?: string; unit?: string; currency?: string; price?: string; rate?: string; rate_basis?: string; collection_area?: string; service_area?: string; description?: string };

function AssetForm({ work, language, onSaved }: { work: Workspace; language: Language; onSaved: () => void }) {
  const t = textFor(language); const id = useRef(Crypto.randomUUID());
  const [name, setName] = useState(''); const [model, setModel] = useState(''); const [category, setCategory] = useState('pump'); const [protocol, setProtocol] = useState('unconfigured');
  async function submit() {
    const success = await work.onlineAction(async () => {
      if (!name.trim()) throw new Error('required');
      await work.api.request(`/v1/farms/${work.farmId}/assets`, 'POST', { id: id.current, name: name.trim(), category, protocol, ...(model.trim() ? { model: model.trim() } : {}) });
    });
    if (success) { onSaved(); await work.refresh(); }
  }
  return <><Text style={styles.muted}>{t.equipmentHint}</Text><Field label={t.assetName} value={name} onChangeText={setName} maxLength={100} />
    <Choice label={t.category} value={category} onChange={setCategory} closeLabel={t.close} options={['borehole', 'pump', 'pivot', 'valve', 'tank', 'sensor', 'power', 'camera', 'other'].map(value => ({ value, label: label(language, value) }))} />
    <Field label={t.model} value={model} onChangeText={setModel} maxLength={100} />
    <Choice label={t.protocol} value={protocol} onChange={setProtocol} closeLabel={t.close} options={[{ value: 'unconfigured', label: t.unconfigured }, { value: 'simulator', label: t.simulated }]} />
    <Button title={t.save} busy={work.busy} onPress={() => { void submit(); }} /></>;
}

export function MoreScreen({ work, language, onLogout, onLock }: { work: Workspace; language: Language; onLogout: () => void; onLock: () => void }) {
  const t = textFor(language);
  const [screen, setScreen] = useState<'sync' | 'equipment' | 'team' | 'recovery' | 'sessions' | 'market' | 'services' | null>(null);
  const [assetCreate, setAssetCreate] = useState(false);
  const [role, setRole] = useState('worker'); const [code, setCode] = useState(''); const [inviteToken, setInviteToken] = useState('');
  const [password, setPassword] = useState(''); const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [conflict, setConflict] = useState<Mutation | null>(null);
  const [serverTask, setServerTask] = useState<Task | null>(null);
  const pending = work.mutations.filter(item => item.state !== 'resolved');
  const pendingMedia = work.attachments.filter(item => item.state !== 'synced' && item.state !== 'draft');
  const timezone = work.snapshot?.farm.timezone || 'Africa/Harare';

  function open(value: NonNullable<typeof screen>) { setScreen(value); setCode(''); setInviteToken(''); setPassword(''); setAssetCreate(false); setConflict(null); setServerTask(null); work.setError(null); }
  useEffect(() => {
    if (screen === 'sessions') void work.onlineAction(async () => { const result = await work.api.request<{ items: DeviceSession[] }>('/v1/sessions'); setDevices(result.items); });
    if (screen === 'market' || screen === 'services') void work.onlineAction(async () => {
      setListings([]); const result = await work.api.request<{ items: Listing[] }>(screen === 'market' ? '/v1/market/listings' : '/v1/services'); setListings(result.items);
    });
  }, [screen]);

  async function invite() {
    await work.onlineAction(async () => { const response = await work.api.request<{ token: string }>(`/v1/farms/${work.farmId}/invitations`, 'POST', { role }); setCode(response.token); });
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
      const tasks = await work.api.request<{ items: Task[] }>(`/v1/farms/${work.farmId}/tasks`);
      setServerTask(tasks.items.find(task => task.id === item.resourceId) || null);
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
      {[['sync', `${t.outbox} (${pending.length})`], ['equipment', t.equipment], ['team', t.team], ['market', t.market], ['services', t.services], ['sessions', t.sessions], ['recovery', t.recovery]].map(([value, title]) => <View key={value} style={{ minWidth: 140, flexGrow: 1, flexBasis: '45%' }}><Button secondary title={title!} onPress={() => open(value as NonNullable<typeof screen>)} /></View>)}
    </View>
    <Card title={t.configuration}><Toggle label={t.dataSaver} hint={t.dataSaverHint} value={work.dataSaver} onChange={value => { void work.setDataSaver(value).catch(work.setError); }} /><Toggle label={t.taskReminders} hint={t.remindersHint} value={work.reminders} onChange={value => { void work.setReminders(value); }} /><Text style={styles.caption}>{t.translations}</Text></Card>
    <Sheet title={screen === 'sync' ? t.outbox : screen ? label(language, screen) : t.more} visible={Boolean(screen)} onClose={() => { setScreen(null); setCode(''); setPassword(''); }} closeLabel={t.close}>
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
          {pendingMedia.map(item => <View key={item.id} style={styles.item}><Text style={styles.text}>{item.mimeType.startsWith('image/') ? t.photos : t.voiceNote} · {Math.ceil(item.sizeBytes / 1024)} KiB · {label(language, item.state)}</Text>{item.lastError ? <Text style={styles.caption}>{errorText(language, new Error(item.lastError))}</Text> : null}
            {['blocked', 'conflict'].includes(item.state) ? <Button secondary title={t.retry} onPress={() => { void work.repository.updateAttachment({ ...item, state: 'pending', attempts: 0, lastError: null }).then(() => work.reloadLocal()).catch(work.setError); }} /> : null}
          </View>)}
          {work.progress ? <Text style={styles.text}>{work.progress.percent}%</Text> : null}<Button title={t.upload} busy={work.busy} onPress={() => { void work.sync(true); }} /></Card> : null}
        <Text style={styles.caption}>{t.conflictHint}</Text>
        {work.mutations.filter(item => item.state === 'resolved').map(item => <Text key={item.id} style={styles.caption}>{t.resolved} · {item.id.slice(0, 8)}</Text>)}
      </> : null}
      {screen === 'equipment' ? <>
        <Text style={styles.muted}>{t.equipmentHint}</Text>
        {(work.snapshot?.assets || []).map(asset => <Card key={asset.id} title={asset.name}><Text style={styles.text}>{label(language, asset.category)} · {label(language, asset.integration_state)}</Text><Text style={styles.caption}>{t.model}: {asset.model || t.unknown}</Text>{asset.last_observed_at ? <Text style={styles.caption}>{formatFarmTime(asset.last_observed_at, timezone, language)} · {asset.fresh ? t.online : t.stale}</Text> : null}</Card>)}
        {!work.snapshot?.assets.length ? <Text style={styles.muted}>{t.empty}</Text> : null}
        {work.canManage ? assetCreate ? <AssetForm work={work} language={language} onSaved={() => setAssetCreate(false)} /> : <Button title={t.newAsset} onPress={() => setAssetCreate(true)} /> : null}
      </> : null}
      {screen === 'team' ? <>
        {(work.snapshot?.members || []).map(member => <View key={member.id} style={styles.item}><Text style={styles.text}>{member.username} · {label(language, member.role)}</Text></View>)}
        {work.canManage ? <Card title={t.invite}><Choice label={t.role} value={role} onChange={setRole} closeLabel={t.close} options={['worker', 'adviser', ...(work.selectedFarm?.role === 'owner' ? ['manager'] : [])].map(value => ({ value, label: label(language, value) }))} /><Button title={t.invite} busy={work.busy} onPress={() => { void invite(); }} />{code ? <><Text style={styles.text}>{t.invitationCreated}</Text><Text selectable style={styles.text}>{code}</Text></> : null}</Card> : null}
        <Card title={t.join}><Field label={t.invitationCode} value={inviteToken} onChangeText={setInviteToken} secureTextEntry autoCapitalize="none" autoCorrect={false} /><Button title={t.join} busy={work.busy} disabled={!inviteToken.trim()} onPress={() => { void acceptInvite(); }} /></Card>
      </> : null}
      {screen === 'recovery' ? <><Text style={styles.muted}>{t.recoveryHint}</Text><Field label={t.password} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" maxLength={128} /><Button title={t.createRecovery} busy={work.busy} onPress={() => { void recover(); }} />{code ? <Card><Text style={styles.text}>{t.recoveryCreated}</Text><Text selectable style={styles.text}>{code}</Text></Card> : null}</> : null}
      {screen === 'sessions' ? devices.map(device => <Card key={device.id} title={device.current ? t.currentSession : device.label || t.sessions}><Text style={styles.caption}>{formatFarmTime(device.created_at, timezone, language)} → {formatFarmTime(device.expires_at, timezone, language)}</Text><Button secondary title={t.revoke} busy={work.busy} onPress={() => { void work.onlineAction(async () => { await work.api.request(`/v1/sessions/${encodeURIComponent(device.id)}`, 'DELETE'); if (device.current) onLogout(); else setDevices(previous => previous.filter(item => item.id !== device.id)); }); }} /></Card>) : null}
      {screen === 'market' || screen === 'services' ? <><Text style={styles.muted}>{t.marketHint}</Text>{listings.map(item => <Card key={item.id} title={item.title || item.name || t.unknown}>{item.description ? <Text style={styles.text}>{item.description}</Text> : null}{item.available_quantity !== undefined ? <Text style={styles.text}>{item.available_quantity} {item.unit}</Text> : null}{item.price || item.rate ? <Text style={styles.text}>{item.price || item.rate} {item.currency}{item.rate_basis ? ` · ${item.rate_basis}` : ''}</Text> : null}{item.collection_area || item.service_area ? <Text style={styles.caption}>{item.collection_area || item.service_area}</Text> : null}</Card>)}{!listings.length ? <Text style={styles.muted}>{t.empty}</Text> : null}</> : null}
    </Sheet>
    <Sheet title={t.resolve} visible={Boolean(conflict)} onClose={() => setConflict(null)} closeLabel={t.close}>
      {work.error ? <Notice error text={errorText(language, work.error)} /> : null}<Text style={styles.muted}>{t.conflictHint}</Text>
      <Card title={t.proposedChange}><Text style={styles.text}>{conflict ? label(language, String(conflict.body.status || conflict.body.kind || conflict.body.type || 'observation')) : ''}</Text><Text style={styles.text}>{String(conflict?.body.note || conflict?.body.evidence || '')}</Text></Card>
      {serverTask ? <Card title={t.currentServer}><Text style={styles.text}>{serverTask.title} · {label(language, serverTask.status)}</Text><Text style={styles.muted}>{serverTask.evidence}</Text><Button title={t.applyReviewed} busy={work.busy} onPress={() => { void applyReviewed(); }} /></Card> : null}
      <Button secondary title={t.keepServer} onPress={() => { void keepServer().catch(work.setError); }} />
    </Sheet>
  </>;
}
