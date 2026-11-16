import React, { useState } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import * as Crypto from 'expo-crypto';
import { errorText, label, textFor } from '../i18n';
import { farmNow, farmTimeToIso, formatFarmTime } from '../time';
import type { Language, Task, TaskStatus } from '../types';
import { Button, Card, Choice, Field, Notice, Sheet, styles } from '../ui';
import type { Workspace } from '../use-workspace';
import { c, dateField, Form, memberOptions, projectOptions, selectField, textField } from '../completion-ui';

export function TodayScreen({ work, language, onRecord }: { work: Workspace; language: Language; onRecord: () => void }) {
  const t = textFor(language);
  const { width } = useWindowDimensions();
  const [task, setTask] = useState<Task | null>(null);
  const [status, setStatus] = useState<TaskStatus>('started');
  const [evidence, setEvidence] = useState('');
  const [reason, setReason] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const snapshot = work.snapshot;
  if (!snapshot) return <Notice text={t.neverSynced} />;
  const tasks = snapshot.tasks.filter(item => showAll || !['completed', 'cancelled'].includes(item.status));
  const column = width >= 800 ? { flexBasis: '48%' as const, flexGrow: 1 } : { width: '100%' as const };

  async function saveStatus() {
    if (!task) return;
    try {
      if (status === 'completed' && !evidence.trim() || ['blocked', 'cancelled'].includes(status) && !reason.trim()) throw new Error('required');
      const id = Crypto.randomUUID();
      await work.repository.enqueue({ id, farmId: work.farmId, kind: 'task-status', resourceId: task.id, body: { version: task.version, status, evidence: evidence.trim(), reason: reason.trim() }, state: 'pending', attempts: 0, lastError: null, createdAt: new Date().toISOString() });
      setTask(null); await work.reloadLocal(); work.setNotice('savedLocally'); if (work.online) void work.sync();
    } catch (value) { work.setError(value); }
  }


  return <>
    <View style={styles.between}><View><Text style={styles.title}>{t.today}</Text><Text style={styles.muted}>{farmNow(snapshot.farm.timezone).slice(0, 10)} · {snapshot.farm.timezone}</Text></View><Button title={t.record} onPress={onRecord} testID="today-record" /></View>
    <View style={styles.grid}>
      <Card title={t.tasks} style={column}><Button secondary title={c(language, showAll ? 'open' : 'history')} onPress={() => setShowAll(!showAll)} />
        {tasks.length ? tasks.map(item => {
          const queued = work.mutations.some(mutation => mutation.kind === 'task-status' && mutation.resourceId === item.id && mutation.state !== 'resolved');
          const editable = work.canManage || item.assignee_id === work.session.userId;
          return <View key={item.id} style={styles.item}><Text style={styles.text}>{item.title}</Text><Text style={styles.caption}>{label(language, item.status)}{item.due_at ? ` · ${formatFarmTime(item.due_at, snapshot.farm.timezone, language)}` : ''}</Text>{item.instructions ? <Text style={styles.muted}>{item.instructions}</Text> : null}
            {queued ? <Text style={styles.caption}>{t.taskPending}</Text> : editable ? <Button secondary title={t.edit} onPress={() => { setTask(item); setStatus(item.status === 'planned' ? 'started' : 'completed'); setEvidence(''); setReason(''); }} /> : null}
          </View>;
        }) : <Text style={styles.muted}>{t.empty}</Text>}
        {work.canManage ? <Button secondary title={t.newTask} onPress={() => setNewTask(true)} /> : null}
      </Card>
      <Card title={t.recent} style={column}>
        {snapshot.activities.slice(0, 8).map(activity => <View key={activity.id} style={styles.item}><Text style={styles.label}>{label(language, activity.kind)} · {snapshot.projects.find(project => project.id === activity.project_id)?.name || t.project}</Text><Text style={styles.caption}>{formatFarmTime(activity.observed_at, snapshot.farm.timezone, language)}</Text><Text style={styles.text}>{activity.note}{activity.quantity !== null ? ` · ${activity.quantity} ${activity.unit}` : ''}</Text></View>)}
        {!snapshot.activities.length ? <Text style={styles.muted}>{t.empty}</Text> : null}
      </Card>
    </View>
    {snapshot.assets.some(asset => ['offline', 'degraded'].includes(asset.integration_state)) ? <Card title={t.equipment}>{snapshot.assets.filter(asset => ['offline', 'degraded'].includes(asset.integration_state)).map(asset => <Text key={asset.id} style={styles.text}>{asset.name} · {label(language, asset.integration_state)}</Text>)}</Card> : null}
    <Sheet title={task?.title || t.task} visible={Boolean(task)} onClose={() => setTask(null)} closeLabel={t.close} keyboardDismissLabel={t.hideKeyboard}>
      {work.error ? <Notice error text={errorText(language, work.error)} /> : null}
      <Choice label={t.stage} value={status} onChange={setStatus} closeLabel={t.close} options={(['started', 'completed', 'blocked', ...(work.canManage ? ['cancelled'] : [])] as TaskStatus[]).map(value => ({ value, label: label(language, value) }))} />
      <Field label={t.evidence} value={evidence} onChangeText={setEvidence} multiline maxLength={2000} /><Field label={t.reason} value={reason} onChangeText={setReason} multiline maxLength={2000} />
      <Button title={t.save} onPress={() => { void saveStatus(); }} />
      {task && work.canManage ? <Form work={work} language={language} title={c(language, 'taskDetails')} includeId={false} fields={[textField('title', true, { maxLength: 200 }), textField('instructions', false, { multiline: true }), dateField('dueAt', false), selectField('assigneeId', memberOptions(work)), textField('reason', true, { maxLength: 1000 })]} initial={{ ...task, dueAt: task.due_at ? farmNow(snapshot.farm.timezone, new Date(task.due_at)) : '', assigneeId: task.assignee_id }} submit={body => work.api.request(`/v1/farms/${work.farmId}/tasks/${task.id}`, 'PATCH', { ...body, dueAt: body.dueAt ?? null, assigneeId: body.assigneeId ?? null, version: task.version })} onSaved={async () => { setTask(null); await work.refresh(); }} /> : null}
    </Sheet>
    <Sheet title={t.newTask} visible={newTask} onClose={() => setNewTask(false)} closeLabel={t.close} keyboardDismissLabel={t.hideKeyboard}>
      <Form work={work} language={language} fields={[textField('title', true, { maxLength: 200 }), textField('instructions', false, { multiline: true }), selectField('projectId', projectOptions(work)), selectField('assigneeId', memberOptions(work)), dateField('dueAt', false)]} submit={body => work.api.request(`/v1/farms/${work.farmId}/tasks`, 'POST', body)} onSaved={async () => { setNewTask(false); await work.refresh(); }} />
    </Sheet>
  </>;
}
