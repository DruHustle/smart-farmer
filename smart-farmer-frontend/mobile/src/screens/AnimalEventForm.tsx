import React, { useRef, useState } from 'react';
import { Text } from 'react-native';
import * as Crypto from 'expo-crypto';
import { label, textFor } from '../i18n';
import { farmNow, farmTimeToIso, optionalNumber } from '../time';
import type { AnimalEvent, AnimalEventType, Language, Project } from '../types';
import { Button, Choice, Field, styles } from '../ui';
import type { Workspace } from '../use-workspace';
import { c, Fields, numericField, textField } from '../completion-ui';
import { parseFields, type FormField, type Row } from '../product';

export type AnimalIdentity = { id: string; identifier: string; sex: 'female' | 'male' | 'unknown'; dam_id?: string | null; sire_id?: string | null; status?: string };

export function eventsFor(project: Project, canManage: boolean): AnimalEventType[] {
  const type = project.enterprise_type;
  let events: AnimalEventType[] = type === 'hatchery'
    ? ['incubation', 'hatch', 'egg_disposition', 'observation', 'care']
    : type === 'fish_hatchery' ? ['fish_hatch', 'egg_disposition', 'water_observation', 'observation', 'care']
    : ['acquisition', 'mortality', 'transfer', 'feed', 'growth_sample', 'observation', 'care'];
  if (['layer', 'breeder'].includes(type)) events.push('egg_collection', 'egg_consumption', 'egg_loss');
  if (type === 'rabbit_breeding') events.push('mating', 'kindling');
  if (type.startsWith('rabbit_')) events.push('fostering', 'weaning');
  if (['fish', 'fish_nursery', 'fish_breeder'].includes(type)) events.push('stocking', 'water_observation');
  if (type === 'fish_breeder') events.push('spawning');
  if (['broiler', 'rabbit_growout', 'fish'].includes(type)) events.push('harvest');
  if (canManage) {
    if (!['hatchery', 'fish_hatchery'].includes(type)) events.push('sale');
    if (['layer', 'breeder'].includes(type)) events.push('egg_sale');
    events.push('adjustment', 'close');
  }
  return events;
}

export function AnimalEventForm({ work, language, project, history, animals, onSaved }: { work: Workspace; language: Language; project: Project; history: AnimalEvent[]; animals: AnimalIdentity[]; onSaved: () => void }) {
  const t = textFor(language);
  const [type, setType] = useState<AnimalEventType>('observation');
  const [values, setValues] = useState<Record<string, string>>({ observedAt: farmNow(work.snapshot?.farm.timezone || 'Africa/Harare') });
  const [saving, setSaving] = useState(false);
  const [extra, setExtra] = useState<Row>({});
  const id = useRef(Crypto.randomUUID());
  const value = (name: string) => values[name] || '';
  const update = (name: string, entry: string) => setValues(previous => ({ ...previous, [name]: entry }));
  const number = (name: string, minimum = 0) => optionalNumber(value(name), minimum);
  const field = (name: string, title: string, numeric = false, hint?: string) => <Field key={name} label={title} value={value(name)} onChangeText={entry => update(name, entry)} keyboardType={numeric ? 'decimal-pad' : 'default'} hint={hint} />;
  const destinations = (work.snapshot?.projects || []).filter(candidate => candidate.id !== project.id && candidate.enterprise_type !== 'crop' && candidate.status !== 'closed');
  const needsCount = ['acquisition', 'mortality', 'transfer', 'sale', 'egg_collection', 'egg_consumption', 'egg_loss', 'egg_sale', 'incubation', 'hatch', 'kindling', 'fostering', 'weaning', 'stocking', 'harvest', 'adjustment', 'spawning', 'fish_hatch', 'egg_disposition'].includes(type);
  const needsDestination = ['transfer', 'hatch', 'kindling', 'fostering', 'weaning', 'spawning', 'fish_hatch'].includes(type);
  const needsStock = ['feed', 'egg_collection', 'egg_consumption', 'egg_loss', 'egg_sale', 'incubation', 'harvest'].includes(type);
  const needsQuantity = ['feed', 'growth_sample', 'harvest'].includes(type);
  const sale = ['sale', 'egg_sale'].includes(type);
  const zeroAllowed = ['adjustment', 'hatch', 'kindling', 'fish_hatch'].includes(type);
  const extraFields: FormField[] = [
    ...(['transfer', 'fostering', 'weaning', 'sale', 'mortality', 'harvest'].includes(type) && animals.length ? [{ key: 'identityIds', type: 'multi' as const, options: animals.filter(animal => !animal.status || animal.status === 'active').map(animal => ({ value: animal.id, label: animal.identifier })) }] : []),
    ...(work.canManage && needsDestination ? [{ key: 'costAllocations', label: c(language, 'allocations'), type: 'rows' as const, fields: [numericField('amount', true), textField('currency', true, { maxLength: 3 }), textField('basis', true)] }] : []),
  ];

  async function submit() {
    if (saving) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = { id: id.current, type, observedAt: farmTimeToIso(value('observedAt'), work.snapshot!.farm.timezone), note: value('note') };
      if (needsCount) { const count = number('count'); if (count === null || !Number.isInteger(count) || !zeroAllowed && count <= 0) throw new Error('required'); body.count = count; }
      if (needsDestination && body.count !== 0) { if (!value('destination')) throw new Error('required'); body.destinationProjectId = value('destination'); }
      if (needsStock) { if (!value('stock')) throw new Error('required'); body.stockItemId = value('stock'); }
      if (needsQuantity) { const quantity = number('quantity'); if (!quantity || !value('unit')) throw new Error('required'); Object.assign(body, { quantity, unit: value('unit') }); }
      if (sale) { const amount = number('amount'); if (amount === null || !/^[A-Z]{3}$/.test(value('currency'))) throw new Error('required'); Object.assign(body, { amount, currency: value('currency') }); }
      const metadata: Record<string, unknown> = parseFields(extraFields, extra, work.snapshot!.farm.timezone);
      if (type === 'egg_collection') metadata.rejects = number('rejects') ?? 0;
      if (type === 'hatch' || type === 'fish_hatch') { const processed = number('eggsProcessed'); if (processed === null || !Number.isInteger(processed) || processed <= 0) throw new Error('required'); metadata.eggsProcessed = processed; }
      if (['spawning', 'fish_hatch', 'egg_disposition'].includes(type)) { if (!value('source')) throw new Error('required'); metadata.source = value('source'); }
      if (type === 'spawning') { if (!value('eggCountBasis')) throw new Error('required'); metadata.eggCountBasis = value('eggCountBasis'); if (value('damId')) metadata.damId = value('damId'); if (value('sireId')) metadata.sireId = value('sireId'); }
      if (type === 'egg_disposition') { if (!value('disposition') || !value('note').trim()) throw new Error('required'); metadata.disposition = value('disposition'); }
      if (type === 'mating') {
        if (!value('damId') || !value('sireId')) throw new Error('required');
        Object.assign(metadata, { damId: value('damId'), sireId: value('sireId') });
        if (value('followUpAt')) metadata.followUpAt = farmTimeToIso(value('followUpAt'), work.snapshot!.farm.timezone);
      }
      if (type === 'kindling') { if (!value('matingEventId')) throw new Error('required'); Object.assign(metadata, { matingEventId: value('matingEventId'), stillborn: number('stillborn') ?? 0 }); }
      if (type === 'water_observation') {
        const measurement = number('waterValue', -Infinity);
        if (measurement === null || !value('measurement') || !value('waterUnit') || !value('source')) throw new Error('required');
        Object.assign(metadata, { measurement: value('measurement'), value: measurement, unit: value('waterUnit'), source: value('source'), ...(value('testType') ? { testType: value('testType') } : {}), ...(value('calibration') ? { calibration: value('calibration') } : {}) });
      }
      if (type === 'growth_sample') {
        const sampleSize = number('sampleSize'); if (!sampleSize || !Number.isInteger(sampleSize) || !value('measurementBasis')) throw new Error('required');
        Object.assign(metadata, { sampleSize, measurementBasis: value('measurementBasis') });
      }
      if (type === 'care') {
        if (!value('note') || !value('authorizedBy') || !value('administeredBy') || !value('instructionsSource')) throw new Error('required');
        Object.assign(metadata, { authorizedBy: value('authorizedBy'), administeredBy: value('administeredBy'), instructionsSource: value('instructionsSource') });
      }
      if (type === 'adjustment') { if (!value('reason') || !value('countBasis')) throw new Error('required'); Object.assign(metadata, { reason: value('reason'), countBasis: value('countBasis') }); }
      if (['mortality', 'close'].includes(type) && !value('note').trim()) throw new Error('required');
      if (Object.keys(metadata).length) body.metadata = metadata;
      await work.repository.enqueue({ id: id.current, farmId: work.farmId, kind: 'animal-event', resourceId: project.id, body, state: 'pending', attempts: 0, lastError: null, createdAt: new Date().toISOString() });
      await work.reloadLocal(); work.setNotice('savedLocally'); onSaved(); if (work.online) void work.sync();
    } catch (error) { work.setError(error); } finally { setSaving(false); }
  }

  return <>
    <Text style={styles.muted}>{t.eventHint}</Text>
    <Choice label={t.animalEvent} value={type} onChange={setType} closeLabel={t.close} options={eventsFor(project, work.canManage).map(event => ({ value: event, label: event === 'close' ? t.closeProject : label(language, event) }))} />
    {field('observedAt', `${t.when} · ${work.snapshot?.farm.timezone}`, false, t.farmTimeHint)}
    {needsCount ? field('count', ['fish_hatchery', 'hatchery'].includes(project.enterprise_type) && !['fish_hatch', 'hatch'].includes(type) || type === 'spawning' ? c(language, 'eggCount') : t.count, true, ['hatch', 'kindling', 'fish_hatch'].includes(type) ? c(language, 'zeroLiveHint') : undefined) : null}
    {needsDestination ? <Choice label={t.destination} value={value('destination')} onChange={entry => update('destination', entry)} closeLabel={t.close} options={[{ value: '', label: t.choose }, ...destinations.map(candidate => ({ value: candidate.id, label: `${candidate.name} · ${label(language, candidate.enterprise_type)}` }))]} /> : null}
    {needsStock ? <Choice label={t.stockItem} value={value('stock')} onChange={entry => { update('stock', entry); const stock = work.snapshot?.stock.find(stock => stock.id === entry); if (stock) update('unit', stock.unit); }} closeLabel={t.close} options={[{ value: '', label: t.choose }, ...(work.snapshot?.stock || []).map(stock => ({ value: stock.id, label: `${stock.name} · ${stock.quantity} ${stock.unit}` }))]} /> : null}
    {needsQuantity ? <>{field('quantity', t.quantity, true)}{field('unit', t.unit)}</> : null}
    {sale ? <>{field('amount', t.amount, true)}<Field label={t.currency} value={value('currency')} onChangeText={entry => update('currency', entry.toUpperCase())} autoCapitalize="characters" maxLength={3} /></> : null}
    {type === 'egg_collection' ? field('rejects', t.rejects, true) : null}
    {type === 'hatch' || type === 'fish_hatch' ? field('eggsProcessed', t.eggsProcessed, true) : null}
    {['spawning', 'fish_hatch', 'egg_disposition'].includes(type) ? field('source', t.sourceReference) : null}
    {type === 'spawning' ? <Choice label={t.countBasis} value={value('eggCountBasis')} onChange={entry => update('eggCountBasis', entry)} closeLabel={t.close} options={[{ value: '', label: t.choose }, { value: 'verified', label: t.verified }, { value: 'estimated', label: t.estimated }]} /> : null}
    {type === 'egg_disposition' ? <Choice label={c(language, 'disposition')} value={value('disposition')} onChange={entry => update('disposition', entry)} closeLabel={t.close} options={['loss', 'discard', 'test'].map(value => ({ value, label: c(language, value) }))} /> : null}
    {type === 'mating' || type === 'spawning' ? <>
      <Choice label={t.dam} value={value('damId')} onChange={entry => update('damId', entry)} closeLabel={t.close} options={[{ value: '', label: t.choose }, ...animals.filter(animal => animal.sex === 'female').map(animal => ({ value: animal.id, label: animal.identifier }))]} />
      <Choice label={t.sire} value={value('sireId')} onChange={entry => update('sireId', entry)} closeLabel={t.close} options={[{ value: '', label: t.choose }, ...animals.filter(animal => animal.sex === 'male').map(animal => ({ value: animal.id, label: animal.identifier }))]} />
      {type === 'mating' ? field('followUpAt', t.due, false, t.farmTimeHint) : null}
    </> : null}
    {type === 'kindling' ? <>
      <Choice label={t.mating} value={value('matingEventId')} onChange={entry => update('matingEventId', entry)} closeLabel={t.close} options={[{ value: '', label: t.choose }, ...history.filter(event => event.type === 'mating').map(event => ({ value: event.id, label: `${event.observed_at.slice(0, 10)} · ${event.note || event.id.slice(0, 8)}` }))]} />
      {field('stillborn', t.stillborn, true)}
    </> : null}
    {type === 'water_observation' ? <>{field('measurement', t.measurement)}{field('waterValue', t.quantity, true)}{field('waterUnit', t.unit)}{field('source', t.sourceReference)}{field('testType', t.testType)}{field('calibration', t.calibration)}</> : null}
    {type === 'growth_sample' ? <>{field('sampleSize', t.sampleSize, true)}<Choice label={t.measurementBasis} value={value('measurementBasis')} onChange={entry => update('measurementBasis', entry)} closeLabel={t.close} options={[{ value: '', label: t.choose }, { value: 'mean_weight', label: t.meanWeight }, { value: 'total_sample_weight', label: t.totalSampleWeight }]} /></> : null}
    {type === 'care' ? <>{field('authorizedBy', t.authorizedBy)}{field('administeredBy', t.administeredBy)}{field('instructionsSource', t.sourceReference)}</> : null}
    {type === 'adjustment' ? <>{field('reason', t.reason)}<Choice label={t.countBasis} value={value('countBasis')} onChange={entry => update('countBasis', entry)} closeLabel={t.close} options={[{ value: '', label: t.choose }, { value: 'verified', label: t.verified }, { value: 'estimated', label: t.estimated }]} /></> : null}
    <Fields fields={extraFields} value={extra} onChange={setExtra} language={language} prefix="animal" />
    <Field label={t.note} value={value('note')} onChangeText={entry => update('note', entry)} multiline maxLength={4000} />
    <Button title={t.save} busy={saving} onPress={() => { void submit(); }} />
  </>;
}
