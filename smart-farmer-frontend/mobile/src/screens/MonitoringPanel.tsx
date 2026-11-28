import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Action, c, Facts, farmPath, Form, numericField, options, Records, selectField, textField, usePanel } from '../completion-ui';
import { allPages, numberText, rows, string, type FormField, type Row } from '../product';
import { textFor } from '../i18n';
import { sensorIsStale, sensorRuleTarget, weatherMetrics } from '../monitoring';
import { formatFarmTime } from '../time';
import type { Language } from '../types';
import type { Workspace } from '../use-workspace';
import { Button, Card, Choice, Notice, styles, colors } from '../ui';

type Props = { work: Workspace; language: Language };
const zone = (work: Workspace) => work.snapshot?.farm.timezone || 'Africa/Harare';

const ruleFields = (language: Language): FormField[] => [
  textField('name', true, { maxLength: 120 }),
  selectField('operator', options(language, ['below', 'above']), true),
  numericField('threshold', true, { minimum: -1e9, maximum: 1e9 }),
  numericField('cooldownMinutes', true, { type: 'integer', minimum: 1, maximum: 10080 }),
];

export function MonitoringPanel({ work, language }: Props) {
  const data = usePanel<Row>(work, 'monitoring-dashboard', async () => {
    const [dashboard, alerts] = await Promise.all([work.api.request<Row>(farmPath(work, '/monitoring')), allPages<Row>(work.api, farmPath(work, '/monitoring/alerts'))]);
    return { ...dashboard, alerts };
  });
  const [sensorKey, setSensorKey] = useState('');
  const sensors = rows(data.value?.sensors);
  const sensor = sensors.find(item => item.key === sensorKey);
  const rules = rows(data.value?.rules).filter(item => item.source !== 'weather');
  const alerts = rows(data.value?.alerts).filter(item => item.source !== 'weather');
  return <>
    <Notice text={c(language, 'monitoringHint')} />
    <Button secondary title={textFor(language).refresh} busy={data.loading} onPress={() => { void data.reload(); }} />
    <Text style={styles.heading} accessibilityRole="header">{c(language, 'sensors')}</Text>
    {!data.loading && !sensors.length ? <Notice text={c(language, 'noSensorReadings')} /> : null}
    {data.value?.truncated ? <Notice text={c(language, 'monitoringLimited')} /> : null}
    {sensors.map(item => <SensorCard key={string(item.key)} sensor={item} language={language} timezone={zone(work)} online={work.online} />)}
    <Text style={styles.heading} accessibilityRole="header">{c(language, 'gateways')}</Text>
    <Records items={rows(data.value?.gateways).map(item => ({ ...item, state: work.online ? item.state : 'offline', batteryPercent: item.batteryPercent ?? textFor(language).unknown, dataUsageMb: item.dataUsageMb ?? textFor(language).unknown }))} language={language} timezone={zone(work)} titleKey="id" fields={['state', 'lastReceivedAt', 'lastObservedAt', 'batteryPercent', 'dataUsageMb']} />
    {work.canManage && sensors.length ? <Card title={c(language, 'newRule')}>
      <Choice label={c(language, 'sensor')} value={sensorKey} onChange={setSensorKey} closeLabel={textFor(language).close} options={sensors.filter(item => !item.simulated).map(item => ({ value: string(item.key), label: `${item.name} · ${item.metric} (${item.unit})` }))} />
      {sensor ? <Form key={sensorKey} work={work} language={language} hint={c(language, 'ruleHint')} fields={[...ruleFields(language), numericField('staleAfterSeconds', true, { type: 'integer', minimum: 10, maximum: 86400 })]} initial={{ cooldownMinutes: 360, staleAfterSeconds: Number(sensor.staleAfterSeconds) || 900 }} submit={body => work.api.request(farmPath(work, '/monitoring/rules'), 'POST', { ...body, ...sensorRuleTarget(sensor), enabled: true })} onSaved={data.reload} /> : null}
    </Card> : null}
    <RuleList rules={rules} work={work} language={language} onSaved={data.reload} />
    <AlertList alerts={alerts} work={work} language={language} />
  </>;
}

export function WeatherRules({ work, language }: Props) {
  const data = usePanel(work, 'monitoring-weather-rules', async () => {
    const [rules, alerts] = await Promise.all([allPages<Row>(work.api, farmPath(work, '/monitoring/rules')), allPages<Row>(work.api, farmPath(work, '/monitoring/alerts'))]);
    return { rules, alerts };
  });
  const [metric, setMetric] = useState<string>('temperature_2m');
  const selected = weatherMetrics.find(item => item.value === metric)!;
  return <Card title={c(language, 'weatherRules')}>
    <Notice text={c(language, 'ruleHint')} />
    {work.canManage ? <>
      <Choice label={c(language, 'metric')} value={metric} onChange={setMetric} closeLabel={textFor(language).close} options={weatherMetrics.map(item => ({ value: item.value, label: c(language, item.value) }))} />
      <Form key={metric} work={work} language={language} title={c(language, 'newRule')} fields={[...ruleFields(language), numericField('lookaheadHours', true, { type: 'integer', minimum: 1, maximum: 72 })]} initial={{ cooldownMinutes: 360, lookaheadHours: 24 }} submit={body => work.api.request(farmPath(work, '/monitoring/rules'), 'POST', { ...body, source: 'weather', metric, unit: selected.unit, enabled: true })} onSaved={data.reload} />
    </> : null}
    <RuleList rules={rows(data.value?.rules).filter(item => item.source === 'weather')} work={work} language={language} onSaved={data.reload} />
    <AlertList alerts={rows(data.value?.alerts).filter(item => item.source === 'weather')} work={work} language={language} />
  </Card>;
}

function RuleList({ rules, work, language, onSaved }: Props & { rules: Row[]; onSaved: () => Promise<void> }) {
  return <Card title={c(language, 'rules')}><Records items={rules} language={language} timezone={zone(work)} titleKey="name" fields={['metric', 'operator', 'threshold', 'unit', 'enabled', 'lookahead_hours', 'cooldown_minutes', 'last_triggered_at']}>
    {rule => work.canManage ? <Action work={work} language={language} title={c(language, rule.enabled ? 'disableRule' : 'enableRule')} action={() => work.api.request(farmPath(work, `/monitoring/rules/${rule.id}`), 'PATCH', { version: rule.version, enabled: !rule.enabled })} onSaved={onSaved} /> : null}
  </Records></Card>;
}

function AlertList({ alerts, work, language }: Props & { alerts: Row[] }) {
  return <Card title={c(language, 'triggeredAlerts')}><Records items={alerts} language={language} timezone={zone(work)} titleKey="rule_name" fields={['source', 'metric', 'value', 'unit', 'observed_at', 'created_at']} /></Card>;
}

function SensorCard({ sensor, language, timezone, online }: { sensor: Row; language: Language; timezone: string; online: boolean }) {
  const stale = sensorIsStale(sensor, online);
  const history = rows(sensor.history).filter(item => typeof item.value === 'number' && Number.isFinite(item.value)).slice(-8);
  const values = history.map(item => Number(item.value));
  const minimum = Math.min(...values), maximum = Math.max(...values);
  return <Card title={`${sensor.name} · ${sensor.metric}`}>
    <Text style={[styles.title, { color: stale ? colors.muted : colors.green }]}>{numberText(sensor.value, language)} <Text style={styles.text}>{string(sensor.unit)}</Text></Text>
    {stale ? <Notice text={textFor(language).stale} /> : null}
    {sensor.simulated ? <Notice text={c(language, 'simulated')} /> : null}
    <Facts value={sensor} fields={['source', 'quality', 'commissioned', 'observedAt', 'receivedAt']} language={language} timezone={timezone} />
    {history.length > 1 ? <>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', alignItems: 'flex-end', height: 64, gap: 6 }}>
        {history.map((point, index) => <View key={index} style={{ flex: 1, minHeight: 6, height: maximum === minimum ? 32 : 8 + (Number(point.value) - minimum) / (maximum - minimum) * 56, backgroundColor: stale ? colors.muted : colors.blue, borderTopLeftRadius: 4, borderTopRightRadius: 4 }} />)}
      </View>
      <Text style={styles.caption}>{numberText(minimum, language)} – {numberText(maximum, language)} {string(sensor.unit)}</Text>
      {history.map((point, index) => <Text key={index} style={styles.caption}>{formatFarmTime(string(point.observedAt), timezone, language)} · {numberText(point.value, language)} {string(sensor.unit)}</Text>)}
    </> : null}
  </Card>;
}
