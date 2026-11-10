import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { label, textFor } from '../i18n';
import { MediaCapture } from '../media';
import { farmNow, farmTimeToIso, optionalNumber } from '../time';
import { activityKinds, type ActivityPayload, type Language, type RecordDraft } from '../types';
import { Button, Card, Choice, Field, Notice, styles } from '../ui';
import type { Workspace } from '../use-workspace';

export function RecordScreen({ work, language, nativeBusy, onNativePrompt }: { work: Workspace; language: Language; nativeBusy: boolean; onNativePrompt: (value: boolean) => void }) {
  const t = textFor(language);
  const [draft, setDraft] = useState<RecordDraft | null>(null);
  const current = useRef<RecordDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const snapshot = work.snapshot;
  const adviser = work.selectedFarm?.role === 'adviser';
  const projects = snapshot?.projects.filter(project => project.status !== 'closed') || [];
  const newDraft = (): RecordDraft => ({ id: Crypto.randomUUID(), projectId: projects[0]?.id || '', kind: adviser ? 'observation' : 'work', observedLocal: farmNow(snapshot?.farm.timezone || 'Africa/Harare'), note: '', quantity: '', unit: '', stockItemId: '', amount: '', currency: '', taskId: '' });

  useEffect(() => {
    let active = true;
    setDraft(null); current.current = null;
    if (snapshot) void (async () => {
      const previous = await work.repository.draft(work.farmId);
      const value = previous ? { ...previous, taskId: previous.taskId || '' } : newDraft();
      if (!previous) await work.repository.saveDraft(work.farmId, value);
      if (active) { current.current = value; setDraft(value); }
    })().catch(work.setError);
    return () => { active = false; };
  }, [work.farmId, Boolean(snapshot)]);

  function update(patch: Partial<RecordDraft>) {
    if (!current.current) return;
    const next = { ...current.current, ...patch };
    current.current = next; setDraft(next);
    void work.repository.saveDraft(work.farmId, next).catch(work.setError);
  }

  async function submit() {
    const value = current.current;
    if (!value || !snapshot || saving || nativeBusy) return;
    setSaving(true); work.setNotice('');
    try {
      if (adviser && (!['observation', 'rain'].includes(value.kind) || value.taskId || value.stockItemId || value.amount || value.currency)) throw new Error('adviser_observation_only');
      if (!projects.some(project => project.id === value.projectId)) throw new Error('required');
      const quantity = optionalNumber(value.quantity);
      const unit = value.unit.trim() || null;
      if ((quantity === null) !== (unit === null)) throw new Error('invalid_input');
      const body: ActivityPayload = { id: value.id, projectId: value.projectId, kind: value.kind, observedAt: farmTimeToIso(value.observedLocal, snapshot.farm.timezone), note: value.note, quantity, unit };
      if (value.kind === 'input_use' || value.kind === 'harvest') {
        if (!value.stockItemId || !quantity || !unit) throw new Error('required');
        body.stockItemId = value.stockItemId;
      }
      if (value.kind === 'cost') {
        const amount = optionalNumber(value.amount);
        if (amount === null || !/^[A-Z]{3}$/.test(value.currency)) throw new Error('required');
        body.amount = amount; body.currency = value.currency;
      }
      if (value.taskId) {
        const task = snapshot.tasks.find(task => task.id === value.taskId && task.project_id === value.projectId);
        if (!task) throw new Error('invalid_input');
        body.taskId = task.id; body.taskVersion = task.version;
      }
      await work.repository.enqueue({ id: value.id, farmId: work.farmId, kind: 'activity', body: { ...body }, state: 'pending', attempts: 0, lastError: null, createdAt: new Date().toISOString() }, true);
      const next = { ...newDraft(), projectId: value.projectId };
      await work.repository.saveDraft(work.farmId, next);
      current.current = next; setDraft(next); await work.reloadLocal(); work.setNotice('savedLocally');
      if (work.online) void work.sync();
    } catch (error) { work.setError(error); } finally { setSaving(false); }
  }

  if (!snapshot) return <Notice text={t.neverSynced} />;
  if (!projects.length) return <Card title={t.record}><Text style={styles.text}>{t.empty}</Text><Text style={styles.caption}>{t.newProject}</Text></Card>;
  if (!draft) return <Text style={styles.text}>{t.loading}</Text>;
  if (draft.kind === 'cost' && !work.canManage) return <Notice text={t.access_revoked} />;
  const projectTasks = snapshot.tasks.filter(task => task.project_id === draft.projectId && !['completed', 'cancelled'].includes(task.status) && (work.canManage || task.assignee_id === work.session.userId));
  const stock = snapshot.stock.filter(item => draft.kind !== 'harvest' || item.project_id === draft.projectId);
  return <Card title={t.record}>
    <Choice testID="record-project" label={t.project} value={draft.projectId} onChange={projectId => update({ projectId, taskId: '', stockItemId: '' })} closeLabel={t.close} options={projects.map(project => ({ value: project.id, label: project.name }))} />
    <Choice label={t.kind} value={draft.kind} onChange={kind => update({ kind, stockItemId: '', quantity: '', unit: '', amount: '', currency: '' })} closeLabel={t.close} options={activityKinds.filter(kind => adviser ? ['observation', 'rain'].includes(kind) : work.canManage || kind !== 'cost').map(value => ({ value, label: t[value] }))} />
    <Field testID="record-when" label={`${t.when} · ${snapshot.farm.timezone}`} hint={t.farmTimeHint} value={draft.observedLocal} onChangeText={observedLocal => update({ observedLocal })} autoCapitalize="none" />
    <Field testID="record-note" label={t.note} value={draft.note} onChangeText={note => update({ note })} autoCorrect={false} autoCapitalize="none" multiline maxLength={4000} />
    {draft.kind === 'input_use' || draft.kind === 'harvest' ? <Choice label={t.stockItem} value={draft.stockItemId} onChange={stockItemId => { const item = snapshot.stock.find(value => value.id === stockItemId); update({ stockItemId, unit: item?.unit || '' }); }} closeLabel={t.close} options={[{ value: '', label: t.choose }, ...stock.map(item => ({ value: item.id, label: `${item.name} · ${item.quantity} ${item.unit}` }))]} /> : null}
    {draft.kind === 'cost' ? <View style={{ gap: 12 }}><Field label={t.amount} keyboardType="decimal-pad" value={draft.amount} onChangeText={amount => update({ amount })} /><Field label={t.currency} value={draft.currency} onChangeText={currency => update({ currency: currency.toUpperCase() })} maxLength={3} autoCapitalize="characters" /><Text style={styles.caption}>{t.moneyHint}</Text></View> : <View style={styles.row}><View style={{ flex: 1, minWidth: 130 }}><Field label={t.quantity} value={draft.quantity} onChangeText={quantity => update({ quantity })} keyboardType="decimal-pad" /></View><View style={{ flex: 1, minWidth: 130 }}><Field label={t.unit} value={draft.unit} onChangeText={unit => update({ unit })} maxLength={40} /></View></View>}
    {!adviser && projectTasks.length ? <Choice label={t.task} value={draft.taskId} onChange={taskId => update({ taskId })} closeLabel={t.close} options={[{ value: '', label: '—' }, ...projectTasks.map(task => ({ value: task.id, label: `${task.title} · ${label(language, task.status)}` }))]} /> : null}
    <MediaCapture key={draft.id} repository={work.repository} farmId={work.farmId} activityId={draft.id} language={language} onChange={work.reloadLocal} onError={work.setError} onNativePrompt={onNativePrompt} />
    <Button testID="record-save" title={t.save} busy={saving} disabled={nativeBusy} onPress={() => { void submit(); }} />
  </Card>;
}
