import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Action, assetOptions, c, dateField, Facts, farmPath, Form, numericField, options, projectOptions, Records, selectField, textField, usePanel } from '../completion-ui';
import { allPages, rows, string, type FormField, type Row } from '../product';
import { textFor } from '../i18n';
import { farmNow } from '../time';
import type { Language } from '../types';
import type { Workspace } from '../use-workspace';
import { Button, Card, Choice, Field, Notice, Sheet, styles } from '../ui';
import { ReviewForm } from './MarketplacePanel';

type Props = { work: Workspace; language: Language };
const zone = (work: Workspace) => work.snapshot?.farm.timezone || 'Africa/Harare';
const serviceFacts = ['provider_name', 'description', 'service_area', 'capability', 'rate', 'currency', 'rate_basis', 'minimum_charge', 'mobilisation_charge', 'operator_included', 'fuel_included', 'availability_note', 'terms', 'cancellation_terms'];

export function ServicesPanel({ work, language }: Props) {
  const [tab, setTab] = useState('services'); const [query, setQuery] = useState(''); const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Row | null>(null); const [edit, setEdit] = useState<Row | null>(null); const [bookingId, setBookingId] = useState('');
  const data = usePanel(work, `services:${search}`, async () => {
    const [services, own, bookings] = await Promise.all([allPages<Row>(work.api, `/v1/services?q=${encodeURIComponent(search)}`), work.canManage ? allPages<Row>(work.api, farmPath(work, '/services')) : Promise.resolve([]), work.canManage ? allPages<Row>(work.api, farmPath(work, '/bookings')) : Promise.resolve([])]);
    return { services, own, bookings };
  });
  const t = textFor(language); const booking = data.value?.bookings.find(item => item.id === bookingId);
  async function reload() { await data.reload(); await work.refresh(); }
  return <><Notice text={c(language, 'onlineOnly')} /><Choice testID="service-tabs" label={t.services} value={tab} onChange={setTab} options={options(language, ['services', ...(work.canManage ? ['bookings', 'ownListings'] : [])])} closeLabel={t.close} />
    <Field label={c(language, 'search')} value={query} onChangeText={setQuery} maxLength={100} /><View style={styles.row}><Button secondary title={c(language, 'search')} onPress={() => setSearch(query.trim())} /><Button secondary title={t.refresh} busy={data.loading} onPress={() => { void data.reload(); }} /></View>
    {tab === 'services' || tab === 'ownListings' ? <><Records items={(tab === 'services' ? data.value?.services : data.value?.own) || []} language={language} timezone={zone(work)} titleKey="name" fields={serviceFacts}>{item => <View style={{ gap: 12 }}><Button testID={`service-open-${item.id}`} secondary title={c(language, 'details')} onPress={() => setSelected(item)} />{tab === 'ownListings' ? <Button secondary title={t.edit} onPress={() => setEdit(item)} /> : null}</View>}</Records>{tab === 'ownListings' ? <ServiceForm work={work} language={language} onSaved={reload} /> : null}</> : null}
    {tab === 'bookings' ? <Records items={data.value?.bookings || []} language={language} timezone={zone(work)} titleKey="name" fields={['status', 'starts_at', 'ends_at', 'requested_quantity', 'requested_unit', 'amount', 'currency', 'deposit_required', 'manually_recorded_paid']}>
      {item => <><Text style={styles.caption}>{c(language, item.is_provider ? 'provider' : 'customer')}</Text><Button secondary title={c(language, 'details')} onPress={() => setBookingId(string(item.id))} /></>}
    </Records> : null}
    <Sheet title={string(selected?.name) || t.services} visible={Boolean(selected)} onClose={() => setSelected(null)} closeLabel={t.close} keyboardDismissLabel={t.hideKeyboard}>{selected ? <ServiceDetails work={work} language={language} service={selected} own={Boolean(data.value?.own.some(item => item.id === selected.id))} onSaved={reload} /> : null}</Sheet>
    <Sheet title={t.edit} visible={Boolean(edit)} onClose={() => setEdit(null)} closeLabel={t.close} keyboardDismissLabel={t.hideKeyboard}>{edit ? <ServiceForm work={work} language={language} service={edit} onSaved={async () => { setEdit(null); await reload(); }} /> : null}</Sheet>
    <Sheet title={c(language, 'bookings')} visible={Boolean(bookingId)} onClose={() => setBookingId('')} closeLabel={t.close} keyboardDismissLabel={t.hideKeyboard}>{booking ? <BookingDetails work={work} language={language} booking={booking} onSaved={reload} /> : null}</Sheet>
  </>;
}

function ServiceForm({ work, language, service, onSaved }: Props & { service?: Row; onSaved: () => Promise<void> }) {
  const fields: FormField[] = [textField('name', true, { maxLength: 150 }), textField('description', true, { multiline: true }), textField('serviceArea', true, { maxLength: 150 }), textField('capability', false, { multiline: true, maxLength: 1500 }), selectField('resourceAssetId', assetOptions(work)), numericField('rate', true), textField('currency', true, { maxLength: 3 }), textField('rateBasis', true, { maxLength: 80 }), numericField('minimumCharge', true), numericField('mobilisationCharge', true), { key: 'operatorIncluded', type: 'boolean' }, { key: 'fuelIncluded', type: 'boolean' }, textField('availabilityNote', false, { maxLength: 1500 }), textField('terms', false, { multiline: true, maxLength: 1500 }), textField('cancellationTerms', false, { multiline: true, maxLength: 1500 }), ...(service ? [{ key: 'active', type: 'boolean' as const }, textField('reason', true)] : [])];
  const initial: Row = service ? { ...service, serviceArea: service.service_area, resourceAssetId: service.resource_asset_id, rateBasis: service.rate_basis, minimumCharge: service.minimum_charge, mobilisationCharge: service.mobilisation_charge, operatorIncluded: service.operator_included, fuelIncluded: service.fuel_included, availabilityNote: service.availability_note, cancellationTerms: service.cancellation_terms } : { minimumCharge: 0, mobilisationCharge: 0 };
  return <Form work={work} language={language} title={c(language, service ? 'edit' : 'add')} hint={c(language, 'publishServiceHint')} fields={fields} initial={initial} includeId={!service} submit={body => work.api.request(farmPath(work, service ? `/services/${service.id}` : '/services'), service ? 'PATCH' : 'POST', { ...body, resourceAssetId: body.resourceAssetId ?? null, ...(service ? { version: service.version } : {}) })} onSaved={onSaved} />;
}

function ServiceDetails({ work, language, service, own, onSaved }: Props & { service: Row; own: boolean; onSaved: () => Promise<void> }) {
  const reviews = usePanel(work, `service-reviews:${service.id}`, () => allPages<Row>(work.api, `/v1/services/${service.id}/reviews`));
  const [result, setResult] = useState<Row | null>(null);
  return <><Facts value={service} fields={serviceFacts} language={language} timezone={zone(work)} />
    {work.canManage && !own ? <Form work={work} language={language} title={c(language, 'requestBooking')} hint={c(language, 'quoteRequired')} fields={[selectField('projectId', projectOptions(work)), selectField('taskId', (work.snapshot?.tasks || []).filter(item => !['completed', 'cancelled'].includes(item.status)).map(item => ({ value: item.id, label: `${item.title} · ${work.snapshot?.projects.find(project => project.id === item.project_id)?.name || ''}` }))), dateField('startsAt'), dateField('endsAt'), numericField('requestedQuantity', false, { minimum: 0.000001 }), textField('requestedUnit', false, { maxLength: 40 }), textField('note', false, { multiline: true, maxLength: 1500 })]} initial={{ startsAt: farmNow(zone(work)), endsAt: farmNow(zone(work), new Date(Date.now() + 3600000)) }} submit={async body => {
      if (Date.parse(string(body.endsAt)) <= Date.parse(string(body.startsAt))) throw new Error('invalid_booking_dates');
      if (Boolean(body.requestedQuantity) !== Boolean(body.requestedUnit)) throw new Error('quantity_unit_pair_required');
      const task = work.snapshot?.tasks.find(item => item.id === body.taskId); if (task && task.project_id !== body.projectId) throw new Error('task_project_mismatch');
      const saved = await work.api.request<Row>(`/v1/services/${service.id}/bookings`, 'POST', { ...body, farmId: work.farmId }); setResult(saved); return saved;
    }} onSaved={onSaved} /> : null}
    {result ? <Card title={c(language, 'requested')}><Facts value={result} fields={['status', 'starts_at', 'ends_at', 'indicativeCharge', 'indicativeCurrency']} language={language} timezone={zone(work)} /><Notice text={c(language, 'quoteRequired')} /></Card> : null}
    <Card title={c(language, 'reviews')}><Records items={reviews.value || []} language={language} timezone={zone(work)} fields={['rating', 'note', 'created_at']} /></Card>
  </>;
}

function BookingDetails({ work, language, booking, onSaved }: Props & { booking: Row; onSaved: () => Promise<void> }) {
  const [tab, setTab] = useState('details'); const base = farmPath(work, `/bookings/${booking.id}`);
  const data = usePanel(work, `booking:${booking.id}:${booking.version}`, async () => { const [history, payments] = await Promise.all([work.api.request<Row>(`${base}/history`), work.api.request<Row>(`${base}/payments`)]); return { history, payments }; });
  const provider = booking.is_provider === true; const customer = booking.is_customer === true; const state = string(booking.status);
  async function reload() { await onSaved(); await data.reload(); }
  const currencyField = textField('currency', true, { maxLength: 3 });
  return <><Text style={styles.heading}>{string(booking.name)}</Text><Choice label={c(language, 'bookings')} value={tab} onChange={setTab} options={options(language, ['details', 'actualWork', 'payments', 'amendments', 'history', ...(state === 'completed' && customer ? ['reviews'] : [])])} closeLabel={textFor(language).close} /><Button secondary title={textFor(language).refresh} busy={data.loading} onPress={() => { void reload(); }} />
    {tab === 'details' ? <>
      <Facts value={booking} fields={['status', 'version', 'starts_at', 'ends_at', 'note', 'requested_quantity', 'requested_unit', 'quoted_quantity', 'quoted_unit', 'work_description', 'amount', 'currency', 'deposit_required', 'mobilisation_charge', 'manually_recorded_paid']} language={language} timezone={zone(work)} />
      {provider && ['requested', 'quoted'].includes(state) ? <Form key={string(booking.version)} work={work} language={language} title={c(language, 'quote')} includeId={false} hint={c(language, 'quoteTotalHint')} fields={[numericField('amount', true), currencyField, textField('workDescription', true, { multiline: true, maxLength: 2000 }), numericField('quotedQuantity', false, { minimum: 0.000001 }), textField('quotedUnit', false, { maxLength: 40 }), numericField('depositRequired', true), numericField('mobilisationCharge', true)]} initial={{ amount: booking.amount, currency: booking.currency, workDescription: booking.work_description, quotedQuantity: booking.quoted_quantity, quotedUnit: booking.quoted_unit, depositRequired: booking.deposit_required || 0, mobilisationCharge: booking.mobilisation_charge || 0 }} submit={body => work.api.request(`${base}/status`, 'POST', { ...body, status: 'quoted', version: booking.version })} onSaved={reload} /> : null}
      {customer && state === 'quoted' ? <Action work={work} language={language} title={c(language, 'acceptQuote')} detail={`${booking.amount} ${booking.currency} · ${booking.work_description || ''}`} action={() => work.api.request(`${base}/status`, 'POST', { status: 'confirmed', version: booking.version })} onSaved={reload} /> : null}
      {customer && state === 'confirmed' ? <Action work={work} language={language} title={c(language, 'confirmCompletion')} detail={c(language, 'completionExpenseHint')} action={() => work.api.request(`${base}/status`, 'POST', { status: 'completed', version: booking.version })} onSaved={reload} /> : null}
      {['requested', 'quoted', 'confirmed'].includes(state) ? <Action work={work} language={language} title={textFor(language).cancel} danger detail={c(language, 'cancellationHint')} action={() => work.api.request(`${base}/status`, 'POST', { status: 'cancelled', version: booking.version })} onSaved={reload} /> : null}
    </> : null}
    {tab === 'actualWork' ? <><Records items={rows(data.value?.history.work)} language={language} timezone={zone(work)} fields={['observed_at', 'quantity', 'unit', 'note']} />{provider && state === 'confirmed' ? <Form work={work} language={language} fields={[dateField('observedAt'), numericField('quantity', true, { minimum: 0.000001 }), textField('unit', true, { maxLength: 40 }), textField('note', true, { multiline: true })]} initial={{ observedAt: farmNow(zone(work)), unit: booking.quoted_unit || booking.requested_unit }} submit={body => work.api.request(`${base}/work`, 'POST', body)} onSaved={reload} /> : null}</> : null}
    {tab === 'payments' ? <>
      <Notice text={c(language, 'servicePaymentHint')} /><Facts value={data.value?.payments || {}} fields={['manuallyRecordedPaid', 'outstanding', 'depositOutstanding', 'cancelledHeldPayment']} language={language} />
      <Records items={rows(data.value?.payments.items)} language={language} timezone={zone(work)} fields={['kind', 'status', 'amount', 'currency', 'note', 'created_at', 'acknowledged_at']}>
        {item => provider && item.status === 'declared' ? <Action work={work} language={language} title={c(language, 'acknowledgePayment')} detail={`${item.amount} ${item.currency} · ${item.note}`} action={() => work.api.request(`${base}/payments/${item.id}/acknowledge`, 'POST', {})} onSaved={reload} /> : null}
      </Records>
      {['confirmed', 'completed'].includes(state) || state === 'cancelled' && provider ? <Form work={work} language={language} title={c(language, provider ? 'recordPayment' : 'declarePayment')} fields={[selectField('kind', options(language, [...(state !== 'cancelled' ? ['deposit', 'balance'] : []), ...(provider ? ['refund'] : [])]), true), numericField('amount', true, { minimum: 0.01 }), currencyField, textField('note', true, { multiline: true })]} initial={{ currency: booking.currency, kind: state === 'cancelled' ? 'refund' : 'deposit' }} submit={body => work.api.request(`${base}/payments`, 'POST', body)} onSaved={reload} /> : null}
    </> : null}
    {tab === 'amendments' ? <>
      <Records items={rows(data.value?.history.amendments)} language={language} timezone={zone(work)} fields={['status', 'amount', 'currency', 'work_description', 'reason', 'created_at', 'accepted_at']}>
        {item => customer && item.status === 'proposed' && state === 'confirmed' ? <View style={{ gap: 12 }}>{['accept', 'reject'].map(action => <Action key={action} work={work} language={language} title={c(language, action)} detail={`${item.amount} ${item.currency} · ${item.work_description}`} action={() => work.api.request(`${base}/amendments/${item.id}/${action}`, 'POST', { version: booking.version, confirmed: true })} onSaved={reload} />)}</View> : null}
      </Records>
      {provider && state === 'confirmed' ? <Form work={work} language={language} title={c(language, 'proposeAmendment')} fields={[numericField('amount', true), currencyField, textField('workDescription', true, { multiline: true }), textField('reason', true)]} initial={{ amount: booking.amount, currency: booking.currency, workDescription: booking.work_description }} submit={body => work.api.request(`${base}/amendments`, 'POST', { ...body, version: booking.version })} onSaved={reload} /> : null}
    </> : null}
    {tab === 'history' ? <Records items={rows(data.value?.history.items)} language={language} timezone={zone(work)} fields={['status', 'version', 'amount', 'currency', 'created_at']}>{item => <Facts value={item.detail && typeof item.detail === 'object' ? item.detail as Row : {}} fields={['workDescription', 'quotedQuantity', 'quotedUnit', 'depositRequired', 'mobilisationCharge', 'reason']} language={language} />}</Records> : null}
    {tab === 'reviews' && state === 'completed' && customer ? <ReviewForm work={work} language={language} target={{ bookingId: booking.id }} onSaved={reload} /> : null}
  </>;
}
