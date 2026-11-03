import React, { useState } from 'react';
import { Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { Action, c, dateField, Facts, farmPath, Form, memberOptions, numericField, options, Records, selectField, textField, usePanel, assetOptions } from '../completion-ui';
import { allPages, numberText, object, rows, string, type FormField, type Row } from '../product';
import { farmNow, formatFarmTime } from '../time';
import type { Language, Project } from '../types';
import { textFor } from '../i18n';
import { Button, Card, Choice, Notice, Sheet, styles } from '../ui';
import type { Workspace } from '../use-workspace';
import type { AnimalIdentity } from './AnimalEventForm';
import { FinancePanel } from './FinancePanel';

type Props = { work: Workspace; language: Language; project: Project; animals?: AnimalIdentity[] };
const zone = (work: Workspace) => work.snapshot?.farm.timezone || 'Africa/Harare';
const projectPath = (work: Workspace, project: Project, suffix = '') => farmPath(work, `/projects/${project.id}${suffix}`);

export function ProjectWorkspace(props: Props) {
  const { work, language } = props;
  const [tab, setTab] = useState('companion');
  return <Card title={c(language, 'details')}><Choice testID="project-workspace" label={c(language, 'details')} value={tab} onChange={setTab} closeLabel={textFor(language).close} options={options(language, ['companion', 'planning', 'assessments', 'performance', 'history', ...(work.canManage ? ['finance'] : [])])} />
    {tab === 'planning' ? <PlanningPanel {...props} /> : tab === 'assessments' ? <ProjectRecords {...props} /> : tab === 'performance' ? <PerformancePanel {...props} /> : tab === 'history' ? <ProjectHistory {...props} /> : tab === 'finance' ? <FinancePanel work={work} language={language} project={props.project} /> : <CompanionPanel {...props} />}
  </Card>;
}

function PlanningPanel({ work, language, project }: Props) {
  const base = projectPath(work, project); const t = textFor(language);
  const data = usePanel(work, `planning:${project.id}`, async () => {
    const [templates, plans, comparisons] = await Promise.all([allPages<Row>(work.api, farmPath(work, '/templates')), allPages<Row>(work.api, `${base}/plans`), project.enterprise_type === 'crop' ? allPages<Row>(work.api, `${base}/comparisons`) : Promise.resolve([])]);
    return { templates, plans, comparisons };
  });
  const [mode, setMode] = useState('plans'); const [editTemplate, setEditTemplate] = useState<Row | null>(null); const [versions, setVersions] = useState<Row[]>([]);
  const templates = (data.value?.templates || []).filter(item => item.enterprise_type === project.enterprise_type);
  const stepFields: FormField[] = [textField('key', true), textField('title', true), textField('instructions', true, { multiline: true }), numericField('offsetDays', true, { type: 'integer', minimum: -365, maximum: 3650 }), textField('requiredEvidence')];
  const templateFields: FormField[] = [textField('name', true), textField('source', true), { key: 'sourceDate', type: 'date', required: true }, { key: 'steps', type: 'rows', required: true, fields: stepFields }];
  return <>
    <Choice label={c(language, 'planning')} value={mode} onChange={setMode} closeLabel={t.close} options={options(language, ['plans', 'templates', ...(project.enterprise_type === 'crop' ? ['comparisons'] : [])])} />
    <Button secondary title={t.refresh} busy={data.loading} onPress={() => { void data.reload(); }} />
    {mode === 'plans' ? <>
      <Notice text={c(language, 'previewHint')} />
      <Records items={data.value?.plans || []} language={language} timezone={zone(work)} fields={['status', 'template_version', 'anchor_at', 'note']}>
        {plan => <><Records items={rows(plan.preview)} language={language} timezone={zone(work)} fields={['dueAt', 'instructions', 'requiredEvidence']} />{work.canManage ? <>
          {plan.status === 'draft' ? <Action work={work} language={language} title={c(language, 'approve')} detail={c(language, 'previewHint')} action={() => work.api.request(`${base}/plans/${plan.id}/approve`, 'POST', { id: Crypto.randomUUID(), version: plan.version, confirmed: true })} onSaved={async () => { await data.reload(); await work.refresh(); }} /> : <Reschedule work={work} language={language} project={project} plan={plan} onSaved={data.reload} />}
        </> : null}</>}
      </Records>
      {work.canManage ? <Form work={work} language={language} title={c(language, 'add')} fields={[selectField('templateId', templates.map(item => ({ value: `${item.id}:${item.version}`, label: `${item.name} · ${item.version}` })), true), dateField('anchorAt'), selectField('assigneeId', memberOptions(work)), textField('note')]} submit={body => { const { templateId, ...rest } = body; const [id, version] = string(templateId).split(':'); return work.api.request(`${base}/plans`, 'POST', { ...rest, templateId: id, templateVersion: Number(version) }); }} onSaved={data.reload} /> : null}
    </> : null}
    {mode === 'templates' ? <>
      <Notice text={c(language, 'immutable')} /><Records items={templates} language={language} timezone={zone(work)} titleKey="name" fields={['version', 'source', 'source_date']}>
        {template => <><Records items={rows(template.steps)} language={language} timezone={zone(work)} fields={['instructions', 'offsetDays', 'requiredEvidence']} /><Button secondary title={c(language, 'history')} onPress={() => { void work.onlineAction(async () => setVersions(await allPages<Row>(work.api, farmPath(work, `/templates/${template.id}/versions`)))); }} />{work.canManage ? <Button secondary title={t.edit} onPress={() => setEditTemplate(template)} /> : null}</>}
      </Records>
      {work.canManage ? <Form work={work} language={language} title={c(language, 'add')} fields={templateFields} submit={body => work.api.request(farmPath(work, '/templates'), 'POST', { ...body, enterpriseType: project.enterprise_type, language })} onSaved={data.reload} /> : null}
      <Sheet title={t.edit} visible={Boolean(editTemplate)} closeLabel={t.close} onClose={() => setEditTemplate(null)}>{editTemplate ? <Form work={work} language={language} fields={[...templateFields, textField('reason', true)]} initial={{ ...editTemplate, sourceDate: string(editTemplate.source_date).slice(0, 10) }} includeId={false} submit={body => work.api.request(farmPath(work, `/templates/${editTemplate.id}`), 'PATCH', { ...body, version: editTemplate.version, language })} onSaved={async () => { setEditTemplate(null); await data.reload(); }} /> : null}</Sheet>
      {versions.length ? <Card title={c(language, 'history')}><Records items={versions.map(item => ({ ...object(item.snapshot), id: `${item.template_id}:${item.version}`, reason: item.reason }))} language={language} timezone={zone(work)} titleKey="name" fields={['version', 'reason', 'source', 'source_date']} /></Card> : null}
    </> : null}
    {mode === 'comparisons' ? <>
      <Notice text={c(language, 'estimatesOnly')} /><Records items={data.value?.comparisons || []} language={language} timezone={zone(work)} titleKey="objective" fields={['budget', 'currency', 'selected_crop']}>{comparison => <Records items={rows(comparison.candidates)} language={language} timezone={zone(work)} titleKey="crop" fields={['reason', 'source', 'estimatedCost', 'currency', 'waterFit', 'labourFit', 'assumptions', 'score']} />}</Records>
      {work.canManage ? <Form work={work} language={language} title={c(language, 'add')} fields={[textField('objective', true), numericField('budget'), textField('currency', false, { maxLength: 3 }), textField('selectedCrop'), { key: 'candidates', type: 'rows', required: true, fields: [textField('crop', true), textField('reason', true), textField('source', true), numericField('estimatedCost'), textField('currency', false, { maxLength: 3 }), selectField('waterFit', options(language, ['unknown', 'suitable', 'unsuitable']), true), selectField('labourFit', options(language, ['unknown', 'suitable', 'unsuitable']), true), textField('assumptions', false, { multiline: true })] }]} submit={body => work.api.request(`${base}/comparisons`, 'POST', body)} onSaved={data.reload} /> : null}
    </> : null}
  </>;
}

function Reschedule({ work, language, project, plan, onSaved }: Props & { plan: Row; onSaved: () => Promise<void> }) {
  const [visible, setVisible] = useState(false); const [preview, setPreview] = useState<Row | null>(null); const [request, setRequest] = useState<Row | null>(null);
  const path = projectPath(work, project, `/plans/${plan.id}/reschedule`);
  return <><Button secondary title={c(language, 'reschedule')} onPress={() => { setVisible(true); setPreview(null); }} /><Sheet title={c(language, 'reschedule')} visible={visible} closeLabel={textFor(language).close} onClose={() => setVisible(false)}>
    <Form work={work} language={language} fields={[dateField('anchorAt'), textField('reason', true)]} submit={async body => { const request = { ...body, version: plan.version, confirmed: false }; setRequest(request); return work.api.request(path, 'POST', request); }} onSaved={result => { setPreview(object(result)); }} />
    {preview ? <><Notice text={c(language, 'previewHint')} /><Records items={rows(preview.changes)} language={language} timezone={zone(work)} fields={['previousDueAt', 'newDueAt']} /><Action work={work} language={language} title={c(language, 'confirm')} action={() => work.api.request(path, 'POST', { ...request, confirmed: true, impactToken: preview.impactToken })} onSaved={async () => { setVisible(false); await onSaved(); await work.refresh(); }} /></> : null}
  </Sheet></>;
}

export function recordDetailFields(type: string, work: Workspace, language: Language): FormField[] {
  const source = textField('source', true);
  if (type === 'assessment') return [...['soilType', 'waterAvailability', 'labourAvailability', 'equipmentAvailable', 'pastCrops', 'objective', 'location'].map(key => textField(key)), numericField('usableAreaHa', false, { minimum: 0.000001 }), source];
  if (type === 'soil_test') return [selectField('measurement', [{ value: 'pH', label: 'pH' }, ...options(language, ['nitrogen', 'phosphorus', 'potassium', 'other'])], true), numericField('value', true, { minimum: -1e9 }), textField('unit', true), textField('sampleLocation', true), source, { key: 'reportDate', type: 'date', required: true }, textField('testMethod')];
  if (type === 'readiness') return [{ key: 'checks', type: 'rows', required: true, fields: [textField('label', true, { label: c(language, 'description') }), { key: 'done', type: 'boolean' }] }, source];
  if (['fuel', 'labour', 'irrigation_session'].includes(type)) return [numericField('quantity', true, { minimum: 0.000001 }), type === 'fuel' ? selectField('unit', [{ value: 'l', label: 'l' }, { value: 'ml', label: 'ml' }], true) : type === 'labour' ? selectField('unit', [{ value: 'hour', label: c(language, 'hours') }], true) : textField('unit', true), source, dateField('startedAt', false), dateField('endedAt', false), selectField('assetId', assetOptions(work))];
  return [textField('finding', true, { multiline: true }), source, textField('grade'), textField('location'), numericField('quantity'), textField('unit')];
}

function ProjectRecords({ work, language, project, animals = [] }: Props) {
  const types = ['assessment', 'soil_test', 'readiness', ...(project.enterprise_type === 'crop' ? ['crop_stage'] : ['husbandry', 'housing', 'pregnancy', 'hatch_observation']), 'grading', 'storage', 'fuel', 'labour', 'irrigation_session'];
  const [type, setType] = useState('assessment'); const t = textFor(language);
  const data = usePanel(work, `records:${project.id}`, () => allPages<Row>(work.api, projectPath(work, project, '/records')));
  const fields = recordDetailFields(type, work, language);
  return <><Choice label={t.kind} value={type} onChange={setType} options={options(language, types)} closeLabel={t.close} />
    {['owner', 'manager', 'worker'].includes(work.selectedFarm?.role || '') ? <Form key={`${project.id}:${type}`} work={work} language={language} title={t.record} offline confirmation={false} draftKey={`records:${project.id}:${type}`} fields={[dateField('observedAt'), textField('note', false, { multiline: true }), ...(animals.length ? [selectField('animalId', animals.map(animal => ({ value: animal.id, label: animal.identifier })))] : []), ...fields]} initial={{ observedAt: farmNow(zone(work)) }} submit={async body => {
      const { id, observedAt, note, animalId, ...details } = body;
      await work.repository.enqueue({ id: string(id), farmId: work.farmId, resourceId: project.id, kind: 'project-record', body: { id, type, observedAt, note: note || '', ...(animalId ? { animalId } : {}), details }, state: 'pending', attempts: 0, lastError: null, createdAt: new Date().toISOString() });
      await work.reloadLocal(); work.setNotice('savedLocally'); if (work.online) await work.sync();
    }} onSaved={data.reload} /> : null}
    <Button secondary title={t.refresh} busy={data.loading} onPress={() => { void data.reload(); }} /><Records items={(data.value || []).filter(item => item.type === type)} language={language} timezone={zone(work)} fields={['observed_at', 'note']}>{item => <><Facts value={object(item.details)} fields={fields.map(field => field.key)} language={language} timezone={zone(work)} />{type === 'readiness' ? rows(object(item.details).checks).map((check, i) => <Text key={i} style={styles.text}>{check.done ? '✓' : '○'} {string(check.label)}</Text>) : null}</>}</Records>
  </>;
}

export function PerformancePanel({ work, language, project }: Props) {
  const data = usePanel(work, `performance:${project.id}`, () => work.api.request<Row>(projectPath(work, project, '/performance')));
  const value = data.value;
  return <><Button secondary title={textFor(language).refresh} busy={data.loading} onPress={() => { void data.reload(); }} /><Notice text={textFor(language).unknownHint} />{value ? <>
    <Facts value={value} fields={['openingCount', 'currentCount', 'reservedCount', 'countBasis', 'recordedMortality', 'mortalityRate', 'mortalityDenominator', 'incomingRecordedCount', 'acquiredRecordedCount', 'liveHatched', 'eggsProcessed', 'hatchRate', 'eggLoss', 'feedKg', 'harvestKg', 'harvestCount', 'salesCount', 'estimatedBiomassKg', 'feedPerHarvestKg']} language={language} timezone={zone(work)} />
    <Card title={c(language, 'samples')}><Facts value={object(value.latestWeightSample)} fields={['observedAt', 'sampleSize', 'averageKg', 'basis']} language={language} timezone={zone(work)} /><Text style={styles.caption}>{c(language, 'estimatesOnly')}</Text></Card>
    <Card title={c(language, 'production')}><Records items={rows(value.output)} language={language} timezone={zone(work)} fields={['kind', 'quantity', 'unit']} /></Card>
    <Card title={c(language, 'tasks')}><Records items={rows(value.tasks)} language={language} timezone={zone(work)} fields={['status', 'count']} /></Card>
    <Card title={c(language, 'lineage')}><Records items={rows(value.breeding)} language={language} timezone={zone(work)} fields={['observed_at', 'live_count', 'stillborn']} /></Card>
    {Array.isArray(value.missing) ? <Card title={c(language, 'missingData')}>{value.missing.map(item => <Text key={string(item)} style={styles.text}>{c(language, string(item))}</Text>)}</Card> : null}
  </> : null}</>;
}

function ProjectHistory({ work, language, project, animals = [] }: Props) {
  const data = usePanel(work, `history:${project.id}`, async () => {
    const [activities, events, records] = await Promise.all([allPages<Row>(work.api, farmPath(work, '/activities')), project.enterprise_type === 'crop' ? Promise.resolve([]) : allPages<Row>(work.api, projectPath(work, project, '/events')), allPages<Row>(work.api, projectPath(work, project, '/records'))]);
    return [...activities.filter(item => item.project_id === project.id), ...events, ...records].sort((a, b) => Date.parse(string(b.observed_at)) - Date.parse(string(a.observed_at)));
  });
  const [identity, setIdentity] = useState('');
  return <>{animals.length ? <Choice label={c(language, 'timeline')} value={identity} onChange={setIdentity} options={[{ value: '', label: c(language, 'all') }, ...animals.map(animal => ({ value: animal.id, label: animal.identifier }))]} closeLabel={textFor(language).close} /> : null}
    {identity ? <IdentityTimeline key={identity} work={work} language={language} identity={identity} /> : <><Button secondary title={textFor(language).refresh} busy={data.loading} onPress={() => { void data.reload(); }} /><Records items={data.value || []} language={language} timezone={zone(work)} fields={['kind', 'type', 'observed_at', 'recorded_at', 'note', 'count', 'quantity', 'unit']} /></>}
  </>;
}

function IdentityTimeline({ work, language, identity }: { work: Workspace; language: Language; identity: string }) {
  const data = usePanel<Row>(work, `identity:${identity}`, async () => { const path = farmPath(work, `/animals/${identity}/timeline`); const first = await work.api.request<Row>(path); return { ...first, items: await allPages<Row>(work.api, path) }; });
  return <>{data.value ? <><Facts value={object(data.value.animal)} fields={['identifier', 'sex', 'birth_date', 'status']} language={language} timezone={zone(work)} /><Card title={c(language, 'parents')}><Records items={rows(data.value.parents)} language={language} timezone={zone(work)} titleKey="identifier" fields={['sex', 'birth_date', 'status']} /></Card><Card title={c(language, 'offspring')}><Records items={rows(data.value.children)} language={language} timezone={zone(work)} titleKey="identifier" fields={['sex', 'birth_date', 'status']} /></Card><Records items={rows(data.value.items)} language={language} timezone={zone(work)} fields={['type', 'observed_at', 'note', 'count']} >{item => <Text style={styles.caption}>{work.snapshot?.projects.find(project => project.id === item.project_id)?.name || '—'} → {work.snapshot?.projects.find(project => project.id === item.destination_project_id)?.name || '—'}</Text>}</Records></> : null}</>;
}

function CompanionPanel({ work, language, project }: Props) {
  const data = usePanel(work, `companion:${project.id}:${language}`, async () => { const [context, references] = await Promise.all([work.api.request<Row>(projectPath(work, project, '/companion')), allPages<Row>(work.api, farmPath(work, '/references'))]); return { context, references }; });
  const [answer, setAnswer] = useState<Row | null>(null);
  return <><Notice text={c(language, 'proposalHint')} />
    {data.value ? <><Text style={styles.caption}>{c(language, string(data.value.context.mode || 'record_based'))}</Text>{Array.isArray(data.value.context.missingFields) ? <Card title={c(language, 'missingData')}>{data.value.context.missingFields.map(value => <Text key={string(value)} style={styles.text}>{c(language, string(value))}: {textFor(language).unknown}</Text>)}</Card> : null}<Records items={rows(data.value.context.tasks)} language={language} timezone={zone(work)} fields={['due_at', 'status', 'instructions']} /></> : null}
    <Form work={work} language={language} title={textFor(language).companion} includeId={false} fields={[textField('question', true, { multiline: true }), { key: 'referenceIds', type: 'multi', options: (data.value?.references || []).map(item => ({ value: string(item.id), label: `${item.title} · ${string(item.published_on).slice(0, 10)} · ${item.version}` })) }]} submit={body => work.api.request(projectPath(work, project, '/companion/chat'), 'POST', { ...body, language })} onSaved={result => setAnswer(object(result))} />
    {answer ? <Card title={c(language, 'answer')}><Text style={styles.caption}>{c(language, string(answer.mode))} · {string(answer.provider)}</Text><Text selectable style={styles.text}>{string(answer.answer)}</Text>{Array.isArray(answer.limitations) ? answer.limitations.map(item => <Text key={string(item)} style={styles.muted}>{string(item)}</Text>) : <Text style={styles.muted}>{string(answer.limitations)}</Text>}<ProposalList work={work} language={language} project={project} proposals={rows(answer.proposals)} /></Card> : null}
    <Card title={c(language, 'references')}><Records items={data.value?.references || []} language={language} timezone={zone(work)} fields={['source_url', 'published_on', 'version', 'reviewed_by', 'content']} /></Card>
  </>;
}

function ProposalList({ work, language, project, proposals }: Props & { proposals: Row[] }) {
  return <>{proposals.map((proposal, index) => <Card key={string(proposal.id) || index} title={string(proposal.title) || c(language, 'proposals')}><Facts value={proposal} fields={['description', 'instructions', 'reason', 'dueAt', 'status']} language={language} timezone={zone(work)} />{work.canManage && (proposal.type === 'task' || proposal.kind === 'task') ? <Form work={work} language={language} title={c(language, 'review')} fields={[textField('title', true), textField('instructions', true, { multiline: true }), dateField('dueAt', false), selectField('assigneeId', memberOptions(work))]} initial={{ ...proposal, dueAt: proposal.dueAt ? farmNow(zone(work), new Date(string(proposal.dueAt))) : '' }} submit={body => work.api.request(farmPath(work, '/tasks'), 'POST', { ...body, projectId: project.id })} onSaved={() => work.refresh()} /> : null}</Card>)}</>;
}
