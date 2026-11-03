import React, { useEffect, useRef, useState } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import * as Crypto from 'expo-crypto';
import { errorText, label, textFor } from '../i18n';
import { farmTimeToIso, formatFarmTime, optionalNumber } from '../time';
import { stockUnits, type AnimalEvent, type Language, type Project, type Stock } from '../types';
import { Button, Card, Choice, Field, Notice, Sheet, styles } from '../ui';
import type { Workspace } from '../use-workspace';
import { AnimalEventForm, type AnimalIdentity } from './AnimalEventForm';
import { ProjectForm } from './ProjectForm';

type Restriction = { id: string; starts_at: string; ends_at: string; scope: string; reason: string; authorized_by: string };
type Details = { events: AnimalEvent[]; animals: AnimalIdentity[]; restrictions: Restriction[]; missingFields: string[] };
const emptyDetails: Details = { events: [], animals: [], restrictions: [], missingFields: [] };

function StockForm({ work, language, onSaved }: { work: Workspace; language: Language; onSaved: () => void }) {
  const t = textFor(language);
  const id = useRef(Crypto.randomUUID());
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<Stock['unit']>('kg');
  const [quantity, setQuantity] = useState('');
  const [projectId, setProjectId] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [currency, setCurrency] = useState('');
  async function submit() {
    const success = await work.onlineAction(async () => {
      const count = optionalNumber(quantity), cost = optionalNumber(unitCost);
      if (!name.trim() || count === null || cost !== null && !/^[A-Z]{3}$/.test(currency)) throw new Error('required');
      await work.api.request(`/v1/farms/${work.farmId}/stock`, 'POST', { id: id.current, name: name.trim(), unit, quantity: count, ...(projectId ? { projectId } : {}), ...(cost !== null ? { unitCost: cost, currency } : {}) });
    });
    if (success) { onSaved(); await work.refresh(); }
  }
  return <><Text style={styles.muted}>{t.stockHint}</Text><Field label={t.stockName} value={name} onChangeText={setName} maxLength={120} />
    <Field label={t.quantity} value={quantity} onChangeText={setQuantity} keyboardType="decimal-pad" />
    <Choice label={t.unit} value={unit} onChange={setUnit} closeLabel={t.close} options={stockUnits.map(value => ({ value, label: value }))} />
    <Choice label={t.project} value={projectId} onChange={setProjectId} closeLabel={t.close} options={[{ value: '', label: '—' }, ...(work.snapshot?.projects || []).map(project => ({ value: project.id, label: project.name }))]} />
    <Field label={t.unitCost} value={unitCost} onChangeText={setUnitCost} keyboardType="decimal-pad" /><Field label={t.currency} value={currency} onChangeText={value => setCurrency(value.toUpperCase())} maxLength={3} autoCapitalize="characters" />
    <Button title={t.save} busy={work.busy} onPress={() => { void submit(); }} /></>;
}

function IdentityForm({ work, language, project, animals, onSaved }: { work: Workspace; language: Language; project: Project; animals: AnimalIdentity[]; onSaved: () => void }) {
  const t = textFor(language);
  const id = useRef(Crypto.randomUUID());
  const [identifier, setIdentifier] = useState('');
  const [sex, setSex] = useState<'unknown' | 'female' | 'male'>('unknown');
  const [birthDate, setBirthDate] = useState('');
  const [damId, setDamId] = useState('');
  const [sireId, setSireId] = useState('');
  async function submit() {
    const success = await work.onlineAction(async () => {
      if (!identifier.trim()) throw new Error('required');
      await work.api.request(`/v1/farms/${work.farmId}/projects/${project.id}/animals`, 'POST', { id: id.current, identifier: identifier.trim(), sex, ...(birthDate ? { birthDate } : {}), ...(damId ? { damId } : {}), ...(sireId ? { sireId } : {}) });
    });
    if (success) onSaved();
  }
  return <><Text style={styles.muted}>{t.identityHint}</Text><Field label={t.identifier} value={identifier} onChangeText={setIdentifier} maxLength={100} />
    <Choice label={t.sex} value={sex} onChange={setSex} closeLabel={t.close} options={(['unknown', 'female', 'male'] as const).map(value => ({ value, label: t[value] }))} />
    <Field label={t.birthDate} hint="YYYY-MM-DD" value={birthDate} onChangeText={setBirthDate} maxLength={10} />
    <Choice label={t.dam} value={damId} onChange={setDamId} closeLabel={t.close} options={[{ value: '', label: t.unknown }, ...animals.filter(animal => animal.sex === 'female').map(animal => ({ value: animal.id, label: animal.identifier }))]} />
    <Choice label={t.sire} value={sireId} onChange={setSireId} closeLabel={t.close} options={[{ value: '', label: t.unknown }, ...animals.filter(animal => animal.sex === 'male').map(animal => ({ value: animal.id, label: animal.identifier }))]} />
    <Button title={t.save} busy={work.busy} onPress={() => { void submit(); }} /></>;
}

function RestrictionForm({ work, language, project, onSaved }: { work: Workspace; language: Language; project: Project; onSaved: () => void }) {
  const t = textFor(language);
  const id = useRef(Crypto.randomUUID());
  const [startsAt, setStartsAt] = useState(''); const [endsAt, setEndsAt] = useState('');
  const [scope, setScope] = useState('all'); const [reason, setReason] = useState(''); const [authorizedBy, setAuthorizedBy] = useState('');
  async function submit() {
    const success = await work.onlineAction(async () => {
      if (!reason.trim() || !authorizedBy.trim()) throw new Error('required');
      await work.api.request(`/v1/farms/${work.farmId}/projects/${project.id}/restrictions`, 'POST', { id: id.current, startsAt: farmTimeToIso(startsAt, work.snapshot!.farm.timezone), endsAt: farmTimeToIso(endsAt, work.snapshot!.farm.timezone), scope, reason: reason.trim(), authorizedBy: authorizedBy.trim() });
    });
    if (success) onSaved();
  }
  return <><Text style={styles.muted}>{t.treatment_restriction}</Text>
    <Field label={t.startsAt} hint={t.farmTimeHint} value={startsAt} onChangeText={setStartsAt} /><Field label={t.endsAt} hint={t.farmTimeHint} value={endsAt} onChangeText={setEndsAt} />
    <Choice label={t.scope} value={scope} onChange={setScope} closeLabel={t.close} options={['all', 'harvest', 'sale', 'transfer'].map(value => ({ value, label: label(language, value) }))} />
    <Field label={t.reason} value={reason} onChangeText={setReason} multiline /><Field label={t.authorizedBy} value={authorizedBy} onChangeText={setAuthorizedBy} />
    <Button title={t.save} busy={work.busy} onPress={() => { void submit(); }} /></>;
}

export function FarmScreen({ work, language }: { work: Workspace; language: Language }) {
  const t = textFor(language);
  const { width } = useWindowDimensions();
  const [filter, setFilter] = useState<'crops' | 'animals' | 'stock'>('crops');
  const [create, setCreate] = useState(false);
  const [stockCreate, setStockCreate] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [mode, setMode] = useState<'detail' | 'edit' | 'event' | 'identity' | 'restriction'>('detail');
  const [details, setDetails] = useState<Details>(emptyDetails);
  const detailEpoch = useRef(0);
  const snapshot = work.snapshot;
  const selected = snapshot?.projects.find(project => project.id === selectedId);

  async function loadDetails(project: Project) {
    const epoch = ++detailEpoch.current;
    const key = `farm:${work.farmId}:project:${project.id}`;
    const previous = await work.repository.preference<Details>(key);
    if (epoch !== detailEpoch.current) return;
    setDetails(previous || emptyDetails);
    if (!work.online) return;
    const base = `/v1/farms/${work.farmId}/projects/${project.id}`;
    try {
      const companion = await work.api.request<{ missingFields: string[] }>(`${base}/companion`);
      let value: Details = { ...emptyDetails, missingFields: companion.missingFields || [] };
      if (project.enterprise_type !== 'crop') {
        const [events, animals, restrictions] = await Promise.all([
          work.api.request<{ items: AnimalEvent[] }>(`${base}/events`),
          work.api.request<{ items: AnimalIdentity[] }>(`${base}/animals`),
          work.api.request<{ items: Restriction[] }>(`${base}/restrictions`),
        ]);
        value = { ...value, events: events.items, animals: animals.items, restrictions: restrictions.items };
      }
      if (epoch !== detailEpoch.current) return;
      await work.repository.setPreference(key, value);
      if (epoch === detailEpoch.current) setDetails(value);
    } catch (error) { if (epoch === detailEpoch.current) work.setError(error); }
  }
  useEffect(() => { if (selected) void loadDetails(selected).catch(work.setError); return () => { detailEpoch.current++; }; }, [selectedId, snapshot?.syncedAt]);
  useEffect(() => { detailEpoch.current++; setSelectedId(''); setCreate(false); setStockCreate(false); setDetails(emptyDetails); }, [work.farmId]);
  if (!snapshot) return <Notice text={t.neverSynced} />;
  const projects = snapshot.projects.filter(project => filter === 'crops' ? project.enterprise_type === 'crop' : project.enterprise_type !== 'crop');

  return <>
    <View style={styles.between}><Text style={styles.title}>{t.farm}</Text>{work.canManage ? <Button title={filter === 'stock' ? t.newStock : t.newProject} onPress={() => { work.setError(null); filter === 'stock' ? setStockCreate(true) : setCreate(true); }} /> : null}</View>
    <View style={styles.row}>{(['crops', 'animals', 'stock'] as const).map(value => <Button key={value} title={t[value]} secondary={filter !== value} onPress={() => setFilter(value)} />)}</View>
    <Text style={styles.caption}>{t.recentWindow}</Text>
    <View style={styles.grid}>
      {filter === 'stock' ? snapshot.stock.map(item => <Card key={item.id} title={item.name} style={{ flexGrow: 1, flexBasis: width >= 800 ? '46%' : '100%' }}><Text style={styles.heading}>{item.quantity} {item.unit}</Text><Text style={styles.caption}>{snapshot.projects.find(project => project.id === item.project_id)?.name || '—'}</Text>{item.unit_cost !== undefined && item.unit_cost !== null ? <Text style={styles.caption}>{t.unitCost}: {item.unit_cost} {item.currency}</Text> : null}</Card>) : projects.map(project => <Card key={project.id} title={project.name} style={{ flexGrow: 1, flexBasis: width >= 800 ? '46%' : '100%' }}>
        <Text style={styles.muted}>{label(language, project.enterprise_type)} · {label(language, project.status || 'active')}</Text>
        {project.enterprise_type === 'crop' ? <Text style={styles.text}>{t.plantingDate}: {project.planting_date?.slice(0, 10) || t.unknown}{'\n'}{t.area}: {project.area_ha || t.unknown}</Text> : <Text style={styles.text}>{t.currentCount}: {project.current_count ?? t.unknown} · {label(language, project.count_basis || 'unknown')}</Text>}
        <Button secondary title={t.project} onPress={() => { setSelectedId(project.id); setMode('detail'); work.setError(null); }} />
      </Card>)}
    </View>
    {!(filter === 'stock' ? snapshot.stock.length : projects.length) ? <Card><Text style={styles.muted}>{t.empty}</Text><Text style={styles.caption}>{t.unknownHint}</Text></Card> : null}
    <Sheet title={t.newProject} visible={create} onClose={() => setCreate(false)} closeLabel={t.close}>
      {work.error ? <Notice error text={errorText(language, work.error)} /> : null}{create ? <ProjectForm work={work} language={language} onSaved={() => setCreate(false)} /> : null}
    </Sheet>
    <Sheet title={t.newStock} visible={stockCreate} onClose={() => setStockCreate(false)} closeLabel={t.close}>
      {work.error ? <Notice error text={errorText(language, work.error)} /> : null}{stockCreate ? <StockForm work={work} language={language} onSaved={() => setStockCreate(false)} /> : null}
    </Sheet>
    <Sheet title={selected?.name || t.project} visible={Boolean(selected)} onClose={() => setSelectedId('')} closeLabel={t.close}>
      {work.error ? <Notice error text={errorText(language, work.error)} /> : null}
      {selected && mode !== 'detail' ? <Button secondary title={t.back} onPress={() => { work.setError(null); setMode('detail'); }} /> : null}
      {selected && mode === 'edit' ? <ProjectForm work={work} language={language} project={selected} onSaved={() => setMode('detail')} /> : null}
      {selected && mode === 'event' ? <AnimalEventForm work={work} language={language} project={selected} history={details.events} animals={details.animals} onSaved={() => setMode('detail')} /> : null}
      {selected && mode === 'identity' ? <IdentityForm work={work} language={language} project={selected} animals={details.animals} onSaved={() => { setMode('detail'); void loadDetails(selected); }} /> : null}
      {selected && mode === 'restriction' ? <RestrictionForm work={work} language={language} project={selected} onSaved={() => { setMode('detail'); void loadDetails(selected); }} /> : null}
      {selected && mode === 'detail' ? <>
        <Text style={styles.muted}>{label(language, selected.enterprise_type)} · {label(language, selected.status || 'active')}</Text>
        {selected.enterprise_type === 'crop' ? <Text style={styles.text}>{t.plantingDate}: {selected.planting_date?.slice(0, 10) || t.unknown}{'\n'}{t.variety}: {selected.variety || t.unknown}{'\n'}{t.area}: {selected.area_ha || t.unknown}{'\n'}{t.objective}: {selected.objective || t.unknown}</Text> : <Text style={styles.heading}>{t.currentCount}: {selected.current_count ?? t.unknown} · {label(language, selected.count_basis || 'unknown')}</Text>}
        <View style={styles.row}>{work.canManage ? <Button secondary title={t.edit} onPress={() => setMode('edit')} /> : null}{selected.enterprise_type !== 'crop' && selected.status !== 'closed' && snapshot.farm.role !== 'adviser' ? <Button title={t.animalEvent} onPress={() => setMode('event')} /> : null}</View>
        <Card title={t.companion}><Text style={styles.muted}>{t.guidanceHint}</Text>{details.missingFields.length ? details.missingFields.map(field => <Text style={styles.text} key={field}>{label(language, field)}: {t.unknown}</Text>) : <Text style={styles.caption}>{t.tasks}: {snapshot.tasks.filter(task => task.project_id === selected.id && !['completed', 'cancelled'].includes(task.status)).length}</Text>}</Card>
        {selected.enterprise_type !== 'crop' ? <>
          <Card title={t.identities}>{details.animals.map(animal => <Text key={animal.id} style={styles.text}>{animal.identifier} · {label(language, animal.sex)}{animal.dam_id ? ` · ${t.dam}: ${details.animals.find(item => item.id === animal.dam_id)?.identifier || animal.dam_id.slice(0, 8)}` : ''}</Text>)}{!details.animals.length ? <Text style={styles.muted}>{t.empty}</Text> : null}{work.canManage ? <Button secondary title={t.record} onPress={() => setMode('identity')} /> : null}</Card>
          <Card title={t.restrictions}>{details.restrictions.map(restriction => <View key={restriction.id} style={styles.item}><Text style={styles.text}>{restriction.reason}</Text><Text style={styles.caption}>{label(language, restriction.scope)} · {formatFarmTime(restriction.starts_at, snapshot.farm.timezone, language)} → {formatFarmTime(restriction.ends_at, snapshot.farm.timezone, language)}</Text></View>)}{!details.restrictions.length ? <Text style={styles.muted}>{t.empty}</Text> : null}{work.canManage ? <Button secondary title={t.record} onPress={() => setMode('restriction')} /> : null}</Card>
          <Card title={t.eventHistory}>{details.events.slice(0, 30).map(event => <View key={event.id} style={styles.item}><Text style={styles.label}>{event.type === 'close' ? t.closeProject : label(language, event.type)}</Text><Text style={styles.caption}>{formatFarmTime(event.observed_at, snapshot.farm.timezone, language)}</Text><Text style={styles.text}>{event.note}{event.count !== null ? ` · ${event.count}` : ''}{event.quantity !== null ? ` · ${event.quantity} ${event.unit}` : ''}</Text></View>)}{!details.events.length ? <Text style={styles.muted}>{t.empty}</Text> : null}</Card>
        </> : null}
      </> : null}
    </Sheet>
  </>;
}
