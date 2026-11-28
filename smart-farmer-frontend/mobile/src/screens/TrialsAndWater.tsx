import React, { useState } from 'react';
import { Share, Text, View } from 'react-native';
import { c, dateField, Facts, farmPath, Form, numericField, options, projectOptions, Records, selectField, textField, usePanel } from '../completion-ui';
import { allPages, numberText, object, rows, string, type FormField, type Row } from '../product';
import { textFor } from '../i18n';
import { canRecordFarmObservation, eligibleTrialEvidence, readDetailHistory } from '../farm-tools';
import { farmNow } from '../time';
import type { Language } from '../types';
import type { Workspace } from '../use-workspace';
import { Button, Card, Notice, Sheet, styles } from '../ui';

type Props = { work: Workspace; language: Language };
const zone = (work: Workspace) => work.snapshot?.farm.timezone || 'Africa/Harare';

export function TrialsPanel({ work, language, onNativePrompt }: Props & { onNativePrompt: (active: boolean) => void }) {
  const data = usePanel(work, 'field-trials', () => allPages<Row>(work.api, farmPath(work, '/trials')));
  const [create, setCreate] = useState(false);
  const [selected, setSelected] = useState('');
  return <>
    <Notice text={c(language, 'trialHint')} />
    <Button secondary title={textFor(language).refresh} busy={data.loading} onPress={() => { void data.reload(); }} />
    {work.canManage ? <Button title={c(language, 'add')} onPress={() => setCreate(true)} /> : null}
    <Records items={data.value || []} language={language} timezone={zone(work)} titleKey="name" fields={['practice', 'control_label', 'treatment_label', 'metric', 'unit', 'started_on']}>
      {trial => <Button secondary title={c(language, 'details')} onPress={() => setSelected(string(trial.id))} />}
    </Records>
    <Sheet title={c(language, 'fieldTrials')} visible={create} onClose={() => setCreate(false)} closeLabel={textFor(language).close} keyboardDismissLabel={textFor(language).hideKeyboard}>
      {create && work.canManage ? <Form work={work} language={language} fields={[textField('name', true, { maxLength: 160 }), selectField('projectId', projectOptions(work), true), textField('controlLabel', true, { maxLength: 160 }), textField('treatmentLabel', true, { maxLength: 160 }), textField('practice', true, { multiline: true, maxLength: 500 }), textField('metric', true, { maxLength: 160 }), textField('unit', true, { maxLength: 160 }), { key: 'startedOn', type: 'date', required: true }, textField('note', false, { multiline: true, maxLength: 3000 })]} submit={body => work.api.request(farmPath(work, '/trials'), 'POST', body)} onSaved={async result => { setCreate(false); await data.reload(); setSelected(string(object(result).id)); }} /> : null}
    </Sheet>
    <Sheet title={c(language, 'fieldTrials')} visible={Boolean(selected)} onClose={() => setSelected('')} closeLabel={textFor(language).close} keyboardDismissLabel={textFor(language).hideKeyboard}>
      {selected ? <TrialDetail key={selected} work={work} language={language} id={selected} onNativePrompt={onNativePrompt} /> : null}
    </Sheet>
  </>;
}

function TrialDetail({ work, language, id, onNativePrompt }: Props & { id: string; onNativePrompt: (active: boolean) => void }) {
  const data = usePanel(work, `trial:${id}`, () => readDetailHistory(work.api, farmPath(work, `/trials/${id}`), 'observations'));
  const media = usePanel(work, 'trial-evidence-options', () => allPages<Row>(work.api, farmPath(work, '/media')));
  const trial = object(data.value?.trial), summary = object(data.value?.summary);
  const evidence = eligibleTrialEvidence(media.value || [], work.snapshot?.activities || [], trial.project_id);
  return <>
    <Text style={styles.heading}>{string(trial.name)}</Text>
    <Facts value={trial} fields={['practice', 'control_label', 'treatment_label', 'metric', 'unit', 'started_on', 'note']} language={language} timezone={zone(work)} />
    <Card title={c(language, 'summary')}>
      <View style={styles.row}>{(['control', 'treatment'] as const).map(arm => <View key={arm} style={{ flex: 1, minWidth: 130 }}>
        <Text style={styles.label}>{string(trial[`${arm}_label`]) || c(language, arm)}</Text>
        <Text style={styles.title}>{numberText(object(summary[arm]).mean, language)} <Text style={styles.text}>{string(trial.unit)}</Text></Text>
        <Text style={styles.caption}>{c(language, 'samples')}: {numberText(object(summary[arm]).count, language)}</Text>
      </View>)}</View>
      <Facts value={summary} fields={['difference', 'percentChange']} language={language} />
      <Notice text={c(language, 'trialHint')} />
      {summary.caution ? <Text style={styles.muted}>{string(summary.caution)}</Text> : null}
      {summary.shareText ? <Button secondary title={c(language, 'shareTrial')} onPress={() => {
        onNativePrompt(true);
        void Share.share({ title: string(trial.name), message: string(summary.shareText) }).catch(work.setError).finally(() => onNativePrompt(false));
      }} /> : null}
      <Text style={styles.caption}>{c(language, 'shareTrialHint')}</Text>
    </Card>
    {canRecordFarmObservation(work.selectedFarm?.role) ? <Form work={work} language={language} title={c(language, 'observation')} hint={c(language, 'evidenceLimit')} fields={[
      selectField('arm', options(language, ['control', 'treatment']), true),
      numericField('value', true, { minimum: -1e12, maximum: 1e12 }), dateField('observedAt'), textField('source', true, { maxLength: 500 }), textField('note', false, { multiline: true, maxLength: 3000 }),
      { key: 'mediaIds', label: textFor(language).media, type: 'multi', options: evidence.map(item => ({ value: string(item.id), label: string(item.filename) || string(item.id) })) },
    ]} initial={{ observedAt: farmNow(zone(work)) }} submit={body => {
      if (Array.isArray(body.mediaIds) && body.mediaIds.length > 8) throw new Error('evidenceLimit');
      return work.api.request(farmPath(work, `/trials/${id}/observations`), 'POST', body);
    }} onSaved={data.reload} /> : null}
    <Records items={rows(data.value?.observations)} language={language} timezone={zone(work)} fields={['arm', 'value', 'observed_at', 'source', 'note']} />
  </>;
}

export function GrowingSystemsPanel({ work, language }: Props) {
  const data = usePanel(work, 'growing-systems', async () => {
    const [systems, locations] = await Promise.all([
      allPages<Row>(work.api, farmPath(work, '/growing-systems')),
      allPages<Row>(work.api, farmPath(work, '/locations')),
    ]);
    return { systems, locations };
  });
  const [create, setCreate] = useState(false);
  const [selected, setSelected] = useState('');
  const projects = work.snapshot?.projects || [];
  const fields: FormField[] = [textField('name', true, { maxLength: 160 }), selectField('type', options(language, ['hydroponics', 'aquaponics']), true),
    selectField('cropProjectId', projects.filter(item => item.enterprise_type === 'crop').map(item => ({ value: item.id, label: item.name })), true),
    { ...selectField('fishProjectId', projects.filter(item => item.enterprise_type.startsWith('fish')).map(item => ({ value: item.id, label: item.name })), true), when: { key: 'type', equals: 'aquaponics' } },
    selectField('locationId', (data.value?.locations || []).map(item => ({ value: string(item.id), label: string(item.name) }))),
    numericField('volumeLitres', false, { minimum: 0.001, maximum: 1e12 }), textField('notes', false, { multiline: true, maxLength: 3000 }),
  ];
  return <>
    <Notice text={c(language, 'growingHint')} />
    <Button secondary title={textFor(language).refresh} busy={data.loading} onPress={() => { void data.reload(); }} />
    {work.canManage ? <Button title={c(language, 'add')} onPress={() => setCreate(true)} /> : null}
    <Records items={data.value?.systems || []} language={language} timezone={zone(work)} titleKey="name" fields={['type', 'volume_litres', 'notes']}>
      {system => <Button secondary title={c(language, 'waterLogs')} onPress={() => setSelected(string(system.id))} />}
    </Records>
    <Sheet title={c(language, 'growingSystems')} visible={create} onClose={() => setCreate(false)} closeLabel={textFor(language).close} keyboardDismissLabel={textFor(language).hideKeyboard}>
      {create && work.canManage ? <Form work={work} language={language} fields={fields} submit={body => work.api.request(farmPath(work, '/growing-systems'), 'POST', body)} onSaved={async result => { setCreate(false); await data.reload(); setSelected(string(object(result).id)); }} /> : null}
    </Sheet>
    <Sheet title={c(language, 'waterLogs')} visible={Boolean(selected)} onClose={() => setSelected('')} closeLabel={textFor(language).close} keyboardDismissLabel={textFor(language).hideKeyboard}>
      {selected ? <WaterLogs key={selected} work={work} language={language} id={selected} /> : null}
    </Sheet>
  </>;
}

function WaterLogs({ work, language, id }: Props & { id: string }) {
  const data = usePanel(work, `growing-system:${id}`, () => readDetailHistory(work.api, farmPath(work, `/growing-systems/${id}`), 'logs'));
  const system = object(data.value?.system);
  const measurements = ['ph', 'ecMsCm', 'temperatureC', 'dissolvedOxygenMgL', 'ammoniaMgL', 'nitriteMgL', 'nitrateMgL'];
  return <>
    <Text style={styles.heading}>{string(system.name)}</Text>
    <Facts value={system} fields={['type', 'volume_litres', 'notes']} language={language} />
    {canRecordFarmObservation(work.selectedFarm?.role) ? <Form work={work} language={language} title={c(language, 'waterLogs')} fields={[
      dateField('observedAt'), textField('source', true, { maxLength: 500 }),
      ...measurements.map(key => numericField(key, false, { minimum: key === 'temperatureC' ? -10 : 0, maximum: key === 'ph' ? 14 : key === 'ecMsCm' ? 200 : key === 'temperatureC' || key === 'dissolvedOxygenMgL' ? 100 : 10000 })), textField('note', false, { multiline: true, maxLength: 3000 }),
    ]} initial={{ observedAt: farmNow(zone(work)) }} submit={body => {
      if (!measurements.some(key => typeof body[key] === 'number')) throw new Error('measurement_required');
      return work.api.request(farmPath(work, `/growing-systems/${id}/logs`), 'POST', body);
    }} onSaved={data.reload} /> : null}
    <Records items={rows(data.value?.logs)} language={language} timezone={zone(work)} fields={['observed_at', 'source', 'ph', 'ec_ms_cm', 'temperature_c', 'dissolved_oxygen_mg_l', 'ammonia_mg_l', 'nitrite_mg_l', 'nitrate_mg_l', 'note']} />
  </>;
}
