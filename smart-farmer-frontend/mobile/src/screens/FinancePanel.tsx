import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { c, dateField, Facts, farmPath, Form, numericField, options, projectOptions, Records, selectField, textField, usePanel } from '../completion-ui';
import { allPages, object, rows, string, type FormField, type Row } from '../product';
import { sharePrivateReport } from '../exports';
import { textFor } from '../i18n';
import { farmNow } from '../time';
import type { Language, Project, Stock } from '../types';
import { Button, Card, Choice, Notice, Sheet, styles } from '../ui';
import type { Workspace } from '../use-workspace';

export const costCategories = ['seed', 'fertiliser', 'feed', 'fuel', 'labour', 'equipment', 'transport', 'care', 'other'] as const;
const currencyField = (): FormField => textField('currency', true, { maxLength: 3 });

export function FinancePanel({ work, language, project }: { work: Workspace; language: Language; project?: Project }) {
  const [tab, setTab] = useState('reports'); const t = textFor(language); const timezone = work.snapshot?.farm.timezone || 'Africa/Harare';
  const [filters, setFilters] = useState<Row>({ period: 'season' });
  const query = new URLSearchParams({ language, ...Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, string(value)])), ...(project ? { projectId: project.id } : {}) }).toString();
  const report = usePanel(work, `summary:${query}`, () => work.api.request<Row>(farmPath(work, `/reports/summary?${query}`)));
  const data = usePanel(work, `finance:${project?.id || 'all'}`, async () => {
    const [expenses, budgets, opening, ledger] = await Promise.all([allPages<Row>(work.api, farmPath(work, '/expenses')), project ? allPages<Row>(work.api, farmPath(work, `/projects/${project.id}/budgets`)) : Promise.resolve([]), project ? allPages<Row>(work.api, farmPath(work, `/projects/${project.id}/opening-balances`)) : Promise.resolve([]), project ? allPages<Row>(work.api, farmPath(work, `/projects/${project.id}/ledger`)) : Promise.resolve([])]);
    return { expenses, budgets, opening, ledger };
  });
  const [allocation, setAllocation] = useState<Row | null>(null);
  async function reload() { await Promise.all([data.reload(), report.reload()]); await work.refresh(); }
  if (!work.canManage) return <Notice text={t.forbidden} />;
  return <>
    <Choice label={c(language, 'finance')} value={tab} onChange={setTab} closeLabel={t.close} options={options(language, ['reports', 'expenses', ...(project ? ['budgets', 'openingBalances', 'payments'] : []), 'reviewDuplicates'])} />
    <Button secondary title={t.refresh} busy={report.loading || data.loading} onPress={() => { void reload(); }} />
    {tab === 'reports' ? <>
      <Form work={work} language={language} fields={[...(project ? [] : [selectField('projectId', projectOptions(work))]), dateField('from', false), dateField('to', false), selectField('period', options(language, ['day', 'week', 'season']), true)]} initial={{ period: 'season' }} includeId={false} confirmation={false} submit={async body => { setFilters(body); }} />
      <Notice text={c(language, 'missingCosts')} />
      {report.value ? <>
        <Records items={rows(report.value.byCurrency)} language={language} timezone={timezone} titleKey="currency" fields={['recordedCosts', 'recordedSales', 'cashReceived', 'cashPaid', 'outstandingRecordedSales', 'recordedMargin', 'inventoryPurchases', 'inputConsumption', 'allocatedTransferNet']} />
        <Card title={c(language, 'budget')}><Records items={rows(report.value.budgetByCurrency)} language={language} timezone={timezone} titleKey="currency" fields={['budget', 'recordedCosts', 'variance']} /></Card>
        <Card title={c(language, 'missingData')}><Facts value={object(report.value.missing)} fields={['unpricedInputs', 'unvaluedStock']} language={language} /></Card>
        <Card title={c(language, 'history')}><Records items={rows(report.value.series)} language={language} timezone={timezone} titleKey="date" fields={['currency', 'kind', 'amount']} /></Card>
      </> : null}
      <Notice text={c(language, 'exportHint')} /><View style={styles.row}>{(['pdf', 'csv'] as const).map(format => <Button key={format} title={c(language, format === 'pdf' ? 'downloadPdf' : 'downloadCsv')} disabled={!work.online} busy={work.busy} onPress={() => { void work.onlineAction(() => sharePrivateReport(work.session, farmPath(work, `/reports/summary.${format}?${query}`), format, c(language, 'reports'))); }} />)}</View>
    </> : null}
    {tab === 'expenses' ? <>
      <Form work={work} language={language} title={c(language, 'add')} fields={[selectField('projectId', projectOptions(work)), selectField('category', options(language, costCategories), true), numericField('amount', true, { minimum: 0.01 }), currencyField(), dateField('observedAt'), textField('note', true, { multiline: true }), selectField('receiptActivityId', (work.snapshot?.activities || []).map(item => ({ value: item.id, label: `${item.note || c(language, item.kind)} · ${item.observed_at.slice(0, 10)}` })))]} initial={{ projectId: project?.id || '', observedAt: farmNow(timezone) }} submit={body => work.api.request(farmPath(work, '/expenses'), 'POST', body)} onSaved={reload} />
      <Records items={data.value?.expenses || []} language={language} timezone={timezone} fields={['observed_at', 'category', 'note', 'amount', 'currency', 'allocated']}>{entry => <Button secondary title={c(language, 'allocations')} onPress={() => setAllocation(entry)} />}</Records>
      <Sheet title={c(language, 'allocations')} visible={Boolean(allocation)} onClose={() => setAllocation(null)} closeLabel={t.close}>{allocation ? <AllocationForm work={work} language={language} expense={allocation} onSaved={reload} /> : null}</Sheet>
    </> : null}
    {project && tab === 'budgets' ? <>
      <Notice text={c(language, 'immutable')} /><Form work={work} language={language} fields={[textField('versionName', true), textField('reason', true), { key: 'lines', type: 'rows', required: true, fields: [selectField('category', options(language, costCategories), true), textField('description', true), numericField('amount', true), currencyField()] }]} submit={body => work.api.request(farmPath(work, `/projects/${project.id}/budgets`), 'POST', body)} onSaved={reload} />
      <Records items={data.value?.budgets || []} language={language} timezone={timezone} titleKey="version_name" fields={['reason', 'created_at']}>{budget => <Records items={rows(budget.lines)} language={language} timezone={timezone} titleKey="description" fields={['category', 'amount', 'currency']} />}</Records>
    </> : null}
    {project && tab === 'openingBalances' ? <><Form work={work} language={language} hint={c(language, 'openingFinanceHint')} fields={[{ key: 'asOfDate', type: 'date', required: true }, selectField('kind', options(language, ['cost', 'sales', 'cash_received']), true), numericField('amount', true), currencyField(), textField('source', true)]} submit={body => work.api.request(farmPath(work, `/projects/${project.id}/opening-balances`), 'POST', body)} onSaved={reload} /><Records items={data.value?.opening || []} language={language} timezone={timezone} fields={['as_of_date', 'kind', 'amount', 'currency', 'source']} /></> : null}
    {project && tab === 'payments' ? <>
      <Form work={work} language={language} hint={c(language, 'paymentHint')} fields={[selectField('revenueId', (data.value?.ledger || []).filter(item => item.kind === 'revenue' && item.source_type === 'animal_event').map(item => ({ value: string(item.id), label: `${item.note} · ${item.amount} ${item.currency}` })), true), numericField('amount', true, { minimum: 0.01 }), currencyField(), dateField('observedAt'), textField('note')]} initial={{ observedAt: farmNow(timezone) }} submit={body => work.api.request(farmPath(work, `/projects/${project.id}/payments`), 'POST', body)} onSaved={reload} /><Records items={data.value?.ledger || []} language={language} timezone={timezone} fields={['kind', 'observed_at', 'note', 'amount', 'currency', 'source_type']} />
    </> : null}
    {tab === 'reviewDuplicates' ? <DuplicateReview work={work} language={language} /> : null}
  </>;
}

function AllocationForm({ work, language, expense, onSaved }: { work: Workspace; language: Language; expense: Row; onSaved: () => Promise<void> }) {
  const path = farmPath(work, `/expenses/${expense.id}/allocations`); const data = usePanel(work, `allocations:${expense.id}`, () => allPages<Row>(work.api, path));
  return <><Facts value={expense} fields={['note', 'amount', 'currency', 'allocated']} language={language} /><Form work={work} language={language} fields={[{ key: 'allocations', type: 'rows', required: true, fields: [selectField('projectId', projectOptions(work), true), numericField('amount', true, { minimum: 0.01 }), textField('basis', true)] }]} submit={body => work.api.request(path, 'POST', body)} onSaved={async () => { await data.reload(); await onSaved(); }} /><Records items={data.value || []} language={language} timezone={work.snapshot?.farm.timezone || 'Africa/Harare'} fields={['amount', 'basis', 'created_at']}>{entry => <Text style={styles.text}>{work.snapshot?.projects.find(project => project.id === entry.project_id)?.name}</Text>}</Records></>;
}

export function StockMovements({ work, language, item }: { work: Workspace; language: Language; item: Stock }) {
  const timezone = work.snapshot?.farm.timezone || 'Africa/Harare'; const [mode, setMode] = useState('movements');
  const data = usePanel(work, `stock:${item.id}`, () => allPages<Row>(work.api, farmPath(work, `/stock/${item.id}/movements`)));
  const pack = object(item).pack_size;
  return <><Text style={styles.heading}>{item.quantity} {item.unit}</Text><Facts value={object(item)} fields={['grade', 'unit_cost', 'currency', 'pack_size', 'pack_unit']} language={language} />
    {pack ? <Choice label={c(language, 'kind')} value={mode} onChange={setMode} options={options(language, ['movements', 'packs'])} closeLabel={textFor(language).close} /> : null}
    {work.canManage ? <Form key={mode} work={work} language={language} title={c(language, 'add')} fields={[selectField('kind', options(language, mode === 'packs' ? ['purchase', 'consumption', 'loss'] : ['purchase', 'consumption', 'loss', 'adjustment']), true), numericField(mode === 'packs' ? 'packCount' : 'quantity', true, { type: mode === 'packs' ? 'integer' : 'number', minimum: mode === 'packs' ? 1 : -1e9 }), dateField('observedAt'), textField('reason', true), numericField('amount'), textField('currency', false, { maxLength: 3 })]} initial={{ observedAt: farmNow(timezone) }} submit={body => work.api.request(farmPath(work, `/stock/${item.id}/${mode === 'packs' ? 'packs' : 'movements'}`), 'POST', { ...body, ...(mode === 'packs' ? {} : { unit: item.unit }) })} onSaved={async () => { await work.refresh(); await data.reload(); }} /> : null}
    <Button secondary title={textFor(language).refresh} busy={data.loading} onPress={() => { void data.reload(); }} /><Records items={data.value || []} language={language} timezone={timezone} fields={['kind', 'quantity', 'unit', 'observed_at', 'note']} />
  </>;
}

function DuplicateReview({ work, language }: { work: Workspace; language: Language }) {
  const data = usePanel(work, 'duplicate-review', () => allPages<Row>(work.api, farmPath(work, '/record-review')));
  return <><Notice text={c(language, 'correctionHint')} /><Records items={data.value || []} language={language} timezone={work.snapshot?.farm.timezone || 'Africa/Harare'} fields={['kind', 'observed_at', 'note', 'quantity', 'unit', 'other_observed_at']}>
    {item => <Form work={work} language={language} fields={[selectField('action', options(language, ['annotate', 'reverse']), true), textField('reason', true)]} submit={body => work.api.request(farmPath(work, `/activities/${item.id}/corrections`), 'POST', { ...body, duplicateOfActivityId: item.possible_duplicate_id })} onSaved={async () => { await data.reload(); await work.refresh(); }} />}
  </Records></>;
}
