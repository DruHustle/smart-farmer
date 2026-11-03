import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { Action, assetOptions, c, dateField, Facts, farmPath, Form, memberOptions, numericField, options, projectOptions, Records, selectField, textField, usePanel } from '../completion-ui';
import { allPages, object, rows, string, type FormField, type Row } from '../product';
import { textFor } from '../i18n';
import { farmNow } from '../time';
import type { Language } from '../types';
import { Button, Card, Choice, Notice, Sheet, styles } from '../ui';
import type { Workspace } from '../use-workspace';

type Props = { work: Workspace; language: Language };
const zone = (work: Workspace) => work.snapshot?.farm.timezone || 'Africa/Harare';

export function EquipmentPanel({ work, language }: Props) {
  const [selected, setSelected] = useState(''); const [create, setCreate] = useState(false);
  const asset = work.snapshot?.assets.find(item => item.id === selected);
  return <><Notice text={textFor(language).equipmentHint} /><Button secondary title={textFor(language).refresh} busy={work.busy} onPress={() => { void work.refresh(); }} />
    {work.canManage ? <Button title={textFor(language).newAsset} onPress={() => setCreate(true)} /> : null}
    <Records items={(work.snapshot?.assets || []).map(item => ({ ...item }))} language={language} timezone={zone(work)} titleKey="name" fields={['category', 'make', 'model', 'integration_state', 'fresh', 'last_observed_at']}>{item => <Button secondary title={c(language, 'details')} onPress={() => setSelected(string(item.id))} />}</Records>
    <Sheet title={textFor(language).newAsset} visible={create} onClose={() => setCreate(false)} closeLabel={textFor(language).close}>
      <Form work={work} language={language} fields={[textField('name', true), selectField('category', options(language, ['borehole', 'pump', 'pivot', 'valve', 'tank', 'sensor', 'power', 'camera', 'other']), true), textField('model'), selectField('protocol', options(language, ['unconfigured', 'simulator']), true), selectField('parentAssetId', assetOptions(work)), numericField('staleAfterSeconds', true, { type: 'integer', minimum: 10, maximum: 3600 })]} initial={{ protocol: 'unconfigured', staleAfterSeconds: 120 }} submit={body => work.api.request(farmPath(work, '/assets'), 'POST', body)} onSaved={async () => { setCreate(false); await work.refresh(); }} />
    </Sheet>
    <Sheet title={asset?.name || textFor(language).equipment} visible={Boolean(asset)} onClose={() => setSelected('')} closeLabel={textFor(language).close}>{asset ? <AssetDetail key={asset.id} work={work} language={language} asset={{ ...asset }} /> : null}</Sheet>
  </>;
}

function AssetDetail({ work, language, asset }: Props & { asset: Row }) {
  const [tab, setTab] = useState('telemetry'); const [maintenance, setMaintenance] = useState<Row | null>(null);
  const base = farmPath(work, `/assets/${asset.id}`); const owner = work.selectedFarm?.role === 'owner';
  const data = usePanel(work, `asset:${asset.id}`, async () => { const [commands, telemetry, usage, maintenance, locations] = await Promise.all([allPages<Row>(work.api, `${base}/commands`), allPages<Row>(work.api, `${base}/telemetry`), allPages<Row>(work.api, `${base}/usage`), allPages<Row>(work.api, `${base}/maintenance`), allPages<Row>(work.api, farmPath(work, '/locations'))]); return { commands, telemetry, usage, maintenance, locations }; });
  const capabilities = object(asset.capabilities); const state = string(asset.integration_state).replaceAll('-', '_');
  async function reload() { await work.refresh(); await data.reload(); }
  // Poll outcomes only while a command is awaiting feedback. A timeout remains an unknown outcome.
  useEffect(() => { if (!work.online || !data.value?.commands.some(command => ['authorized', 'dispatched', 'acknowledged'].includes(string(command.status)))) return; const timer = setInterval(() => { void data.reload(); }, 5000); return () => clearInterval(timer); }, [work.online, data.value?.commands]);
  return <>
    <Facts value={asset} fields={['category', 'make', 'model', 'controller', 'firmware', 'integration_state', 'fresh', 'last_observed_at', 'notes']} language={language} timezone={zone(work)} />
    <Choice label={c(language, 'equipment')} value={tab} onChange={setTab} closeLabel={textFor(language).close} options={options(language, ['telemetry', 'commands', 'usage', 'maintenance', ...(work.canManage ? ['edit'] : []), ...(owner ? ['integration', 'commissioning'] : [])])} />
    <Button secondary title={textFor(language).refresh} busy={data.loading || work.busy} onPress={() => { void reload(); }} />
    {tab === 'telemetry' ? <>
      <Card title={c(language, 'telemetry')}><Facts value={object(asset.latest_telemetry)} fields={['running', 'interlock_ok', 'flow_l_min', 'pressure_kpa']} language={language} />{asset.fresh !== true ? <Notice text={textFor(language).stale} /> : null}<Records items={data.value?.telemetry || []} language={language} timezone={zone(work)} fields={['measurement', 'value', 'unit', 'observed_at', 'received_at', 'source', 'quality']} /></Card>
      {work.canManage && state === 'simulated' ? <Form work={work} language={language} title={c(language, 'simulated')} hint={textFor(language).equipmentHint} includeId={false} fields={[{ key: 'running', type: 'boolean' }, { key: 'interlockOk', type: 'boolean' }]} submit={body => work.api.request(`${base}/simulate`, 'POST', body)} onSaved={reload} /> : null}
    </> : null}
    {tab === 'commands' ? <><Notice text={c(language, 'commandHint')} />
      {work.canManage && asset.fresh === true && ['simulated', 'verified_control_enabled'].includes(state) ? <View style={styles.row}>{(['start', 'stop'] as const).filter(command => Array.isArray(capabilities.commands) && capabilities.commands.includes(command)).map(command => <CommandButton key={command} work={work} language={language} asset={asset} command={command} onSaved={reload} />)}</View> : <Notice text={textFor(language).equipmentHint} />}
      <Records items={data.value?.commands || []} language={language} timezone={zone(work)} fields={['command', 'status', 'created_at', 'expires_at', 'acknowledged_at', 'completed_at', 'reason']}>{command => <><Facts value={object(command.feedback)} fields={['running', 'interlock_ok']} language={language} />{work.canManage && state === 'simulated' && ['authorized', 'dispatched', 'acknowledged'].includes(string(command.status)) ? <Form work={work} language={language} title={c(language, 'simulated')} includeId={false} fields={[selectField('status', options(language, ['acknowledged', 'confirmed', 'rejected', 'failed', 'outcome_unknown']), true), { key: 'running', type: 'boolean' }, { key: 'interlock_ok', type: 'boolean' }, textField('reason')]} submit={body => { const { running, interlock_ok, ...rest } = body; return work.api.request(`${base}/commands/${command.id}/simulate`, 'POST', { ...rest, feedback: { running, interlock_ok } }); }} onSaved={reload} /> : null}</>}</Records>
    </> : null}
    {tab === 'usage' ? <>
      {['owner', 'manager', 'worker'].includes(work.selectedFarm?.role || '') ? <Form work={work} language={language} offline confirmation={false} draftKey={`usage:${asset.id}`} fields={[selectField('kind', options(language, ['runtime', 'fuel', 'energy', 'water', 'pressure', 'position', 'fault']), true), numericField('quantity', true), textField('unit', true), dateField('observedAt'), selectField('projectId', projectOptions(work)), textField('note')]} initial={{ observedAt: farmNow(zone(work)) }} submit={async body => { await work.repository.enqueue({ id: string(body.id), farmId: work.farmId, kind: 'asset-usage', resourceId: string(asset.id), body, state: 'pending', attempts: 0, lastError: null, createdAt: new Date().toISOString() }); await work.reloadLocal(); work.setNotice('savedLocally'); if (work.online) await work.sync(); }} onSaved={data.reload} /> : null}
      <Records items={data.value?.usage || []} language={language} timezone={zone(work)} fields={['kind', 'quantity', 'unit', 'observed_at', 'note']} />
    </> : null}
    {tab === 'maintenance' ? <>
      {work.canManage ? <Form work={work} language={language} title={c(language, 'add')} fields={[textField('title', true), dateField('dueAt'), numericField('intervalDays', false, { type: 'integer', minimum: 1 }), textField('instructions', false, { multiline: true }), selectField('assigneeId', memberOptions(work)), selectField('projectId', projectOptions(work))]} submit={body => work.api.request(`${base}/maintenance`, 'POST', body)} onSaved={data.reload} /> : null}
      <Records items={data.value?.maintenance || []} language={language} timezone={zone(work)} fields={['status', 'due_at', 'interval_days', 'instructions', 'performed_at', 'hours', 'note']}>{item => work.canManage && item.status === 'planned' ? <Button secondary title={textFor(language).complete} onPress={() => setMaintenance(item)} /> : null}</Records>
      <Sheet title={c(language, 'maintenance')} visible={Boolean(maintenance)} onClose={() => setMaintenance(null)} closeLabel={textFor(language).close}>{maintenance ? <Form work={work} language={language} includeId={false} fields={[selectField('status', options(language, ['completed', 'cancelled']), true), textField('note', true), dateField('performedAt', false), numericField('hours'), numericField('amount'), textField('currency', false, { maxLength: 3 })]} initial={{ status: 'completed', performedAt: farmNow(zone(work)) }} submit={body => work.api.request(farmPath(work, `/maintenance/${maintenance.id}`), 'PATCH', { ...body, version: maintenance.version })} onSaved={async () => { setMaintenance(null); await data.reload(); }} /> : null}</Sheet>
    </> : null}
    {tab === 'edit' && work.canManage ? <Form work={work} language={language} key={string(asset.version)} includeId={false} fields={[textField('name', true), ...['make', 'model', 'controller', 'firmware'].map(key => textField(key)), selectField('locationId', (data.value?.locations || []).map(item => ({ value: string(item.id), label: string(item.name) }))), selectField('responsibleId', memberOptions(work)), numericField('staleAfterSeconds', true, { type: 'integer', minimum: 10, maximum: 3600 }), textField('notes', false, { multiline: true }), textField('reason', true)]} initial={{ ...asset, locationId: asset.location_id, responsibleId: asset.responsible_id, staleAfterSeconds: asset.stale_after_seconds }} submit={body => work.api.request(base, 'PATCH', { ...body, version: asset.version })} onSaved={reload} /> : null}
    {tab === 'integration' && owner ? <IntegrationForm work={work} language={language} asset={asset} onSaved={reload} /> : null}
    {tab === 'commissioning' && owner ? <Form work={work} language={language} hint={textFor(language).equipmentHint} fields={[selectField('mode', options(language, ['read_only', 'control']), true), ...['identityVerified', 'mappingVerified', 'localInterlocksVerified', 'manualOverrideVerified', 'networkLossVerified', 'feedbackVerified'].map(key => ({ key, type: 'boolean' as const })), textField('evidence', true, { multiline: true, maxLength: 5000 }), { key: 'password', type: 'password', required: true }]} submit={body => { const { id, mode, evidence, password, ...checks } = body; return work.api.request(`${base}/commissioning`, 'POST', { id, mode, checks, evidence, password, version: asset.version, confirmed: true }); }} onSaved={reload} /> : null}
  </>;
}

function IntegrationForm({ work, language, asset, onSaved }: Props & { asset: Row; onSaved: () => Promise<void> }) {
  return <Form work={work} language={language} includeId={false} hint={textFor(language).equipmentHint} fields={[selectField('protocol', [{ value: 'simulator', label: c(language, 'simulator') }, { value: 'mqtt', label: 'MQTT' }, { value: 'http', label: 'HTTPS' }, { value: 'modbus', label: 'Modbus' }], true), textField('connectionRef', true), { key: 'telemetry', type: 'rows', required: true, fields: [textField('name', true), textField('unit', true), textField('address', true), numericField('scale', false, { minimum: -1e9 }), numericField('offset', false, { minimum: -1e9 })] }, { key: 'commands', type: 'rows', fields: [selectField('name', options(language, ['start', 'stop']), true), textField('address', true), numericField('value', true, { type: 'integer', maximum: 65535 })] }, textField('reason', true)]} initial={{ ...object(asset.configuration), protocol: asset.protocol }} submit={body => work.api.request(farmPath(work, `/assets/${asset.id}/integration`), 'POST', { ...body, version: asset.version })} onSaved={onSaved} />;
}

function CommandButton({ work, language, asset, command, onSaved }: Props & { asset: Row; command: 'start' | 'stop'; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const request = useRef<Row | null>(null);
  return <><Button title={c(language, command)} disabled={!work.online || command === 'start' && object(asset.latest_telemetry).interlock_ok !== true} onPress={() => { request.current = { id: Crypto.randomUUID(), command, confirmed: true, expiresAt: new Date(Date.now() + 90_000).toISOString() }; setOpen(true); }} /><Sheet title={`${asset.name} · ${c(language, command)}`} visible={open} onClose={() => setOpen(false)} closeLabel={textFor(language).cancel}><Notice text={c(language, 'commandHint')} /><Facts value={asset} fields={['name', 'model', 'integration_state', 'last_observed_at']} language={language} timezone={zone(work)} /><Button title={c(language, 'confirm')} busy={busy} disabled={!work.online} onPress={() => { if (busy || !request.current) return; setBusy(true); void work.onlineAction(async () => { await work.api.request(farmPath(work, `/assets/${asset.id}/commands`), 'POST', request.current); setOpen(false); await onSaved(); }).finally(() => setBusy(false)); }} /></Sheet></>;
}
