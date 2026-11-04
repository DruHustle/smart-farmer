import React, { useState } from 'react';
import { Image, Share, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { Action, c, dateField, Facts, farmPath, Form, numericField, options, Records, selectField, textField, usePanel } from '../completion-ui';
import { allPages, object, rows, string, type FormField, type Row } from '../product';
import { textFor } from '../i18n';
import { farmNow } from '../time';
import type { Language } from '../types';
import { Button, Card, Choice, Field, Notice, Sheet, styles } from '../ui';
import type { Workspace } from '../use-workspace';

type Props = { work: Workspace; language: Language };
const categories = ['produce', 'input', 'animal', 'equipment', 'other'];
const zone = (work: Workspace) => work.snapshot?.farm.timezone || 'Africa/Harare';

export function MarketplacePanel({ work, language }: Props) {
  const [tab, setTab] = useState('listings'); const [query, setQuery] = useState(''); const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Row | null>(null); const [edit, setEdit] = useState<Row | null>(null); const [request, setRequest] = useState<Row | null>(null);
  const data = usePanel(work, `market:${search}`, async () => {
    const [listings, own, orders, requests, myRequests, moderation, media] = await Promise.all([allPages<Row>(work.api, `/v1/market/listings?q=${encodeURIComponent(search)}`), work.canManage ? allPages<Row>(work.api, farmPath(work, '/listings')) : Promise.resolve([]), allPages<Row>(work.api, '/v1/market/orders'), allPages<Row>(work.api, `/v1/market/requests?q=${encodeURIComponent(search)}`), allPages<Row>(work.api, '/v1/market/my-requests'), work.canManage ? allPages<Row>(work.api, farmPath(work, '/moderation')) : Promise.resolve([]), work.canManage ? allPages<Row>(work.api, farmPath(work, '/media')) : Promise.resolve([])]);
    return { listings, own, orders, requests, myRequests, moderation, media };
  });
  const t = textFor(language);
  const requestFields: FormField[] = [textField('title', true), selectField('category', options(language, categories), true), numericField('quantity', true, { minimum: 0.000001 }), textField('unit', true), textField('area', true, { label: c(language, 'collectionArea') }), textField('details', true, { multiline: true }), dateField('expiresAt')];
  async function reload() { await data.reload(); await work.refresh(); }
  return <>
    <Notice text={c(language, 'onlineOnly')} /><Choice label={t.market} value={tab} onChange={setTab} options={options(language, ['listings', 'orders', 'requests', ...(work.canManage ? ['ownListings', 'moderation'] : [])])} closeLabel={t.close} />
    <Field label={c(language, 'search')} value={query} onChangeText={setQuery} maxLength={100} /><View style={styles.row}><Button secondary title={c(language, 'search')} onPress={() => setSearch(query.trim())} /><Button secondary title={t.refresh} busy={data.loading} onPress={() => { void data.reload(); }} /></View>
    {tab === 'listings' || tab === 'ownListings' ? <>
      <Records items={(tab === 'listings' ? data.value?.listings : data.value?.own) || []} language={language} timezone={zone(work)} fields={['category', 'available_quantity', 'remaining_quantity', 'unit', 'count_basis', 'expected_harvest', 'expected_quantity', 'price', 'currency', 'price_basis', 'price_quantity', 'collection_area', 'grade', 'status', 'expires_at']}>
        {item => <>{item.count_basis === 'estimated' ? <Notice text={t.estimated} /> : null}<Button testID={`listing-open-${item.id}`} secondary title={c(language, 'details')} onPress={() => setSelected(item)} />{tab === 'ownListings' ? <Button secondary title={t.edit} onPress={() => setEdit(item)} /> : null}</>}
      </Records>
      {tab === 'ownListings' && work.canManage ? <ListingForm work={work} language={language} media={data.value?.media || []} onSaved={reload} /> : null}
    </> : null}
    {tab === 'orders' ? <Records items={data.value?.orders || []} language={language} timezone={zone(work)} fields={['status', 'quantity', 'unit', 'amount', 'currency', 'manually_recorded_paid', 'expires_at', 'cancellation_reason']}>
      {order => <>
        {order.status === 'reserved' ? <View style={{ gap: 12 }}>{order.is_seller ? <Action work={work} language={language} title={c(language, 'fulfill')} detail={`${order.quantity} ${order.unit} · ${order.amount} ${order.currency}`} action={() => work.api.request(`/v1/market/orders/${order.id}/status`, 'POST', { status: 'fulfilled' })} onSaved={reload} /> : null}<Action work={work} language={language} title={t.cancel} danger action={() => work.api.request(`/v1/market/orders/${order.id}/status`, 'POST', { status: 'cancelled' })} onSaved={reload} /></View> : null}
        {order.status === 'fulfilled' && order.is_seller ? <Form work={work} language={language} title={c(language, 'payment')} hint={c(language, 'paymentHint')} fields={[numericField('amount', true, { minimum: 0.01 }), textField('currency', true, { maxLength: 3 }), textField('note')]} initial={{ currency: order.currency }} submit={body => work.api.request(`/v1/market/orders/${order.id}/payments`, 'POST', body)} onSaved={reload} /> : null}
        {order.status === 'fulfilled' && order.is_buyer ? <ReviewForm work={work} language={language} target={{ orderId: order.id }} onSaved={reload} /> : null}
      </>}
    </Records> : null}
    {tab === 'requests' ? <>
      <Form work={work} language={language} title={c(language, 'add')} fields={requestFields} submit={body => work.api.request('/v1/market/requests', 'POST', body)} onSaved={data.reload} />
      <Records items={[...(data.value?.myRequests || []), ...(data.value?.requests || []).filter(item => !data.value?.myRequests.some(own => own.id === item.id))]} language={language} timezone={zone(work)} fields={['category', 'quantity', 'unit', 'area', 'details', 'status', 'expires_at']}>{item => <Button secondary title={c(language, 'responses')} onPress={() => setRequest(item)} />}</Records>
    </> : null}
    {tab === 'moderation' && work.canManage ? <Records items={data.value?.moderation || []} language={language} timezone={zone(work)} fields={['reason', 'status', 'note', 'created_at']}>{item => item.status === 'open' ? <Form work={work} language={language} fields={[selectField('action', options(language, ['archive', 'dismiss']), true), textField('note', true)]} submit={body => work.api.request(farmPath(work, `/moderation/${item.id}/resolve`), 'POST', body)} onSaved={data.reload} /> : null}</Records> : null}
    <Sheet title={string(selected?.title) || t.market} visible={Boolean(selected)} onClose={() => setSelected(null)} closeLabel={t.close}>{selected ? <ListingDetail work={work} language={language} listing={selected} own={Boolean(data.value?.own.some(item => item.id === selected.id))} onSaved={reload} /> : null}</Sheet>
    <Sheet title={t.edit} visible={Boolean(edit)} onClose={() => setEdit(null)} closeLabel={t.close}>{edit ? <ListingForm work={work} language={language} listing={edit} media={data.value?.media || []} onSaved={async () => { setEdit(null); await reload(); }} /> : null}</Sheet>
    <Sheet title={c(language, 'requests')} visible={Boolean(request)} onClose={() => setRequest(null)} closeLabel={t.close}>{request ? <RequestDetail work={work} language={language} request={request} own={Boolean(data.value?.myRequests.some(item => item.id === request.id))} ownListings={data.value?.own || []} fields={requestFields} onSaved={async () => { setRequest(null); await data.reload(); }} /> : null}</Sheet>
  </>;
}

function ListingForm({ work, language, listing, media, onSaved }: Props & { listing?: Row; media: Row[]; onSaved: () => Promise<void> }) {
  const [source, setSource] = useState(listing?.animal_project_id ? 'animal' : 'stock');
  const fields: FormField[] = [
    ...(!listing ? source === 'animal' ? [selectField('animalProjectId', (work.snapshot?.projects || []).filter(project => !['crop', 'hatchery', 'fish_hatchery'].includes(project.enterprise_type) && project.status !== 'closed').map(project => ({ value: project.id, label: `${project.name} · ${project.current_count ?? '—'} · ${c(language, project.count_basis || 'unknown')}` })), true)] : [selectField('stockItemId', (work.snapshot?.stock || []).map(stock => ({ value: stock.id, label: `${stock.name} · ${stock.quantity} ${stock.unit}` })), true), selectField('category', options(language, ['produce', 'input', 'equipment', 'other']), true)] : []),
    textField('title', true), numericField('quantity', true, { minimum: 0.000001 }), numericField('price', true), textField('currency', true, { maxLength: 3 }), textField('collectionArea', true), textField('terms', false, { multiline: true }), textField('grade'), textField('condition'), textField('priceBasis', true), numericField('priceQuantity', true, { minimum: 0.000001 }), dateField('availabilityAt', false), dateField('expiresAt', false), ...(source === 'stock' ? [{ key: 'expectedHarvest', type: 'boolean' as const }] : []), { key: 'photoMediaIds', type: 'multi', options: media.filter(item => !item.financial && string(item.mime_type).startsWith('image/') && !work.snapshot?.activities.some(activity => activity.id === item.activity_id && activity.kind === 'cost')).map(item => ({ value: string(item.id), label: `${item.filename} · ${string(item.created_at).slice(0, 10)}` })) }, ...(listing ? [selectField('status', options(language, ['active', 'archived']), true), textField('reason', true)] : []),
  ];
  const initial: Row = listing ? { ...listing, collectionArea: listing.collection_area, priceBasis: listing.price_basis, priceQuantity: listing.price_quantity, expectedHarvest: listing.expected_harvest, photoMediaIds: listing.photo_media_ids || [], availabilityAt: listing.availability_at ? farmNow(zone(work), new Date(string(listing.availability_at))) : '', expiresAt: listing.expires_at ? farmNow(zone(work), new Date(string(listing.expires_at))) : '' } : { category: 'produce', priceBasis: 'unit', priceQuantity: 1 };
  return <>{!listing ? <Choice label={c(language, 'source')} value={source} onChange={setSource} options={options(language, ['stock', 'animal'])} closeLabel={textFor(language).close} /> : null}<Form key={`${source}:${listing?.id || 'new'}`} work={work} language={language} hint={c(language, 'publishHint')} fields={fields} initial={initial} includeId={!listing} submit={body => work.api.request(farmPath(work, listing ? `/listings/${listing.id}` : '/listings'), listing ? 'PATCH' : 'POST', { ...body, ...(listing ? { version: listing.version, availabilityAt: body.availabilityAt ?? null, expiresAt: body.expiresAt ?? null } : source === 'animal' ? { category: 'animal' } : {}) })} onSaved={onSaved} /></>;
}

function ListingDetail({ work, language, listing, own, onSaved }: Props & { listing: Row; own: boolean; onSaved: () => Promise<void> }) {
  const [tab, setTab] = useState('reserve'); const [showPhotos, setShowPhotos] = useState(!work.dataSaver);
  const data = usePanel(work, `listing:${listing.id}`, async () => { const [enquiries, offers, reviews] = await Promise.all([allPages<Row>(work.api, `/v1/market/listings/${listing.id}/enquiries`), allPages<Row>(work.api, `/v1/market/listings/${listing.id}/offers`), allPages<Row>(work.api, `/v1/market/listings/${listing.id}/reviews`)]); return { enquiries, offers, reviews }; });
  async function reload() { await data.reload(); await onSaved(); }
  return <>
    <Facts value={listing} fields={['seller_name', 'available_quantity', 'quantity', 'unit', 'count_basis', 'expected_harvest', 'expected_quantity', 'price', 'currency', 'price_basis', 'price_quantity', 'grade', 'condition', 'collection_area', 'terms', 'availability_at', 'expires_at']} language={language} timezone={zone(work)} />
    {listing.expected_harvest ? <Notice text={c(language, 'expectedHarvest')} /> : null}
    {Array.isArray(listing.photo_media_ids) && listing.photo_media_ids.length ? <><Button secondary title={textFor(language).photos} disabled={!work.online} onPress={() => setShowPhotos(!showPhotos)} />{showPhotos ? listing.photo_media_ids.map(id => <Image key={string(id)} source={{ uri: `${work.session.origin}/v1/market/listings/${listing.id}/photos/${id}` }} style={{ width: '100%', height: 210 }} resizeMode="contain" accessibilityLabel={textFor(language).photos} />) : null}</> : null}
    <Button secondary title={c(language, 'share')} onPress={() => { const origin = process.env.EXPO_PUBLIC_WEB_URL; if (!origin || !/^https:\/\/[^/]+$/.test(origin)) { work.setError(new Error('web_unconfigured')); return; } void Share.share({ message: `${listing.title}\n${origin}/?listing=${listing.id}` }).catch(work.setError); }} />
    <Choice label={c(language, 'details')} value={tab} onChange={setTab} options={options(language, [!own && !listing.expected_harvest ? 'reserve' : 'details', 'enquiries', 'offers', 'reviews', 'report'])} closeLabel={textFor(language).close} />
    {tab === 'reserve' && !own && !listing.expected_harvest ? <Form work={work} language={language} hint={c(language, 'reservationHint')} fields={[numericField('quantity', true, { minimum: 0.000001, maximum: Number(listing.available_quantity || 0) })]} submit={body => work.api.request(`/v1/market/listings/${listing.id}/orders`, 'POST', body)} onSaved={reload} /> : null}
    {tab === 'enquiries' ? <><Form work={work} language={language} fields={[textField('message', true, { multiline: true })]} submit={body => work.api.request(`/v1/market/listings/${listing.id}/enquiries`, 'POST', body)} onSaved={data.reload} /><Records items={data.value?.enquiries || []} language={language} timezone={zone(work)} fields={['created_at']}>{item => <><Records items={rows(item.messages)} language={language} timezone={zone(work)} fields={['message', 'created_at']} /><Form work={work} language={language} fields={[textField('message', true, { multiline: true })]} submit={body => work.api.request(`/v1/market/enquiries/${item.id}/messages`, 'POST', body)} onSaved={data.reload} /></>}</Records></> : null}
    {tab === 'offers' ? <>
      {!own ? <Form work={work} language={language} hint={c(language, 'offerTotalHint')} fields={[numericField('quantity', true, { minimum: 0.000001 }), numericField('amount', true), textField('currency', true, { maxLength: 3 }), textField('message', false, { multiline: true }), dateField('expiresAt')]} initial={{ currency: listing.currency }} submit={body => work.api.request(`/v1/market/listings/${listing.id}/offers`, 'POST', body)} onSaved={data.reload} /> : null}
      <Records items={data.value?.offers || []} language={language} timezone={zone(work)} fields={['status', 'quantity', 'amount', 'currency', 'message', 'expires_at']}>{item => item.status === 'pending' ? <Form work={work} language={language} fields={[selectField('status', options(language, own ? ['accepted', 'rejected'] : ['withdrawn']), true)]} submit={body => work.api.request(`/v1/market/offers/${item.id}/status`, 'POST', { ...body, version: item.version })} onSaved={reload} /> : null}</Records>
    </> : null}
    {tab === 'reviews' ? <Records items={data.value?.reviews || []} language={language} timezone={zone(work)} fields={['rating', 'note', 'created_at']} /> : null}
    {tab === 'report' ? <Form work={work} language={language} fields={[textField('reason', true, { multiline: true })]} submit={body => work.api.request('/v1/market/reports', 'POST', { ...body, listingId: listing.id })} onSaved={data.reload} /> : null}
  </>;
}

function RequestDetail({ work, language, request, own, ownListings, fields, onSaved }: Props & { request: Row; own: boolean; ownListings: Row[]; fields: FormField[]; onSaved: () => Promise<void> }) {
  const data = usePanel(work, `request:${request.id}`, () => allPages<Row>(work.api, `/v1/market/requests/${request.id}/responses`));
  return <><Facts value={request} fields={['title', 'details', 'quantity', 'unit', 'area', 'expires_at', 'status']} language={language} timezone={zone(work)} /><Records items={data.value || []} language={language} timezone={zone(work)} fields={['message', 'created_at']} />
    {request.status === 'open' ? <Form work={work} language={language} title={c(language, 'responses')} fields={[textField('message', true, { multiline: true }), selectField('listingId', ownListings.filter(item => item.status === 'active').map(item => ({ value: string(item.id), label: string(item.title) })))]} submit={body => work.api.request(`/v1/market/requests/${request.id}/responses`, 'POST', body)} onSaved={data.reload} /> : null}
    {own ? <Form work={work} language={language} title={textFor(language).edit} includeId={false} fields={[...fields, selectField('status', options(language, ['open', 'closed']), true), textField('reason', true)]} initial={{ ...request, expiresAt: farmNow(zone(work), new Date(string(request.expires_at))) }} submit={body => work.api.request(`/v1/market/requests/${request.id}`, 'PATCH', { ...body, version: request.version })} onSaved={onSaved} /> : <Form work={work} language={language} title={c(language, 'report')} fields={[textField('reason', true)]} submit={body => work.api.request('/v1/market/reports', 'POST', { ...body, requestId: request.id })} />}
  </>;
}

export function ReviewForm({ work, language, target, onSaved }: Props & { target: Row; onSaved: () => Promise<void> }) {
  return <Form work={work} language={language} title={c(language, 'reviews')} fields={[numericField('rating', true, { type: 'integer', minimum: 1, maximum: 5 }), textField('note', false, { multiline: true })]} submit={body => work.api.request('/v1/reviews', 'POST', { ...body, ...target })} onSaved={onSaved} />;
}
