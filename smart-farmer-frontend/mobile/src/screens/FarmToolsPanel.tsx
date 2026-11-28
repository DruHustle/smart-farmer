import React, { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { c, dateField, Facts, farmPath, Form, numericField, options, Records, selectField, textField, usePanel } from '../completion-ui';
import { allPages, string, type FormField, type Row } from '../product';
import { textFor } from '../i18n';
import { farmNow } from '../time';
import { canRecordFarmObservation, marketPriceText } from '../farm-tools';
import type { Language } from '../types';
import type { Workspace } from '../use-workspace';
import { Button, Card, Choice, Field, Notice, Sheet, styles } from '../ui';
import { TrialsPanel, GrowingSystemsPanel } from './TrialsAndWater';
import { FarmAdvisorPanel } from './FarmAdvisorPanel';
import { BasicPhonePanel } from './BasicPhonePanel';

type Props = { work: Workspace; language: Language };
const zone = (work: Workspace) => work.snapshot?.farm.timezone || 'Africa/Harare';

export function FarmToolsPanel({ work, language, onNativePrompt, onNotifications }: Props & { onNativePrompt: (active: boolean) => void; onNotifications: () => void }) {
  const [tab, setTab] = useState('marketPrices');
  return <>
    <Notice text={c(language, 'farmToolsHint')} />
    <Text style={styles.caption}>{textFor(language).translations}</Text>
    <Choice testID="farm-tools-tabs" label={c(language, 'farmTools')} value={tab} onChange={setTab} closeLabel={textFor(language).close} options={options(language, ['marketPrices', 'support', 'fieldTrials', 'growingSystems', 'farmAdvisor', 'basicPhone'])} />
    {tab === 'marketPrices' ? <MarketPricesPanel work={work} language={language} /> : null}
    {tab === 'support' ? <SupportPanel work={work} language={language} onNativePrompt={onNativePrompt} /> : null}
    {tab === 'fieldTrials' ? <TrialsPanel work={work} language={language} onNativePrompt={onNativePrompt} /> : null}
    {tab === 'growingSystems' ? <GrowingSystemsPanel work={work} language={language} /> : null}
    {tab === 'farmAdvisor' ? <FarmAdvisorPanel work={work} language={language} onNativePrompt={onNativePrompt} /> : null}
    {tab === 'basicPhone' ? <BasicPhonePanel work={work} language={language} onNotifications={onNotifications} /> : null}
  </>;
}

function MarketPricesPanel({ work, language }: Props) {
  const data = usePanel(work, 'market-prices', () => allPages<Row>(work.api, farmPath(work, '/market-prices')));
  const [search, setSearch] = useState('');
  const [create, setCreate] = useState(false);
  const items = (data.value || []).filter(item => `${item.commodity} ${item.market}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <>
    <Notice text={c(language, 'priceHint')} />
    <Field label={`${c(language, 'commodity')} / ${c(language, 'market')}`} value={search} onChangeText={setSearch} />
    <Button secondary title={textFor(language).refresh} busy={data.loading} onPress={() => { void data.reload(); }} />
    {work.canManage ? <Button title={c(language, 'observedPrice')} onPress={() => setCreate(true)} /> : null}
    <Records items={items.map(item => ({ ...item, price: marketPriceText(item.price, language) }))} language={language} timezone={zone(work)} titleKey="commodity" fields={['market', 'price', 'currency', 'unit', 'observed_at', 'source', 'source_url', 'note']} />
    <Sheet title={c(language, 'observedPrice')} visible={create} onClose={() => setCreate(false)} closeLabel={textFor(language).close} keyboardDismissLabel={textFor(language).hideKeyboard}>
      {create && work.canManage ? <Form work={work} language={language} fields={[textField('commodity', true, { maxLength: 160 }), textField('market', true, { maxLength: 160 }), numericField('price', true, { minimum: 0.000001, maximum: 1e12 }), textField('currency', true, { maxLength: 3 }), textField('unit', true, { maxLength: 160 }), dateField('observedAt'), textField('source', true, { maxLength: 500 }), textField('sourceUrl', false, { maxLength: 2000 }), textField('note', false, { multiline: true, maxLength: 3000 })]} initial={{ observedAt: farmNow(zone(work)) }} submit={body => work.api.request(farmPath(work, '/market-prices'), 'POST', body)} onSaved={async () => { setCreate(false); await data.reload(); }} /> : null}
    </Sheet>
  </>;
}

function SupportPanel({ work, language, onNativePrompt }: Props & { onNativePrompt: (active: boolean) => void }) {
  const [tab, setTab] = useState('supportCentres');
  const [create, setCreate] = useState(false);
  const [guide, setGuide] = useState<Row | null>(null);
  const [visit, setVisit] = useState<Row | null>(null);
  const data = usePanel(work, 'support', async () => {
    const [centres, guides, visits] = await Promise.all([
      allPages<Row>(work.api, farmPath(work, '/support/centres')),
      allPages<Row>(work.api, farmPath(work, '/support/guides')),
      allPages<Row>(work.api, farmPath(work, '/support/visits')),
    ]);
    return { centres, guides, visits };
  });
  const centreOptions = (data.value?.centres || []).map(item => ({ value: string(item.id), label: `${item.name} · ${item.area}` }));
  const centreFields: FormField[] = [textField('name', true, { maxLength: 160 }), selectField('kind', options(language, ['extension_officer', 'support_centre']), true), textField('area', true, { maxLength: 160 }), numericField('latitude', false, { minimum: -90, maximum: 90 }), numericField('longitude', false, { minimum: -180, maximum: 180 }), textField('phone', false, { maxLength: 16 }), textField('email', false, { maxLength: 254 }), textField('sourceUrl', true, { maxLength: 2000 }), { key: 'verifiedOn', type: 'date', required: true }];
  const guideFields: FormField[] = [textField('title', true, { maxLength: 160 }), textField('summary', true, { multiline: true, maxLength: 1000 }), textField('content', true, { multiline: true, maxLength: 20000 }), selectField('language', [{ value: 'en', label: 'English' }, { value: 'sn', label: 'Shona' }, { value: 'nd', label: 'isiNdebele' }], true), textField('sourceUrl', true, { maxLength: 2000 }), textField('reviewedBy', true, { maxLength: 160 }), { key: 'reviewedOn', type: 'date', required: true }, textField('videoUrl', false, { maxLength: 2000 }), numericField('videoSizeKb', false, { type: 'integer', minimum: 1, maximum: 2000000 })];
  const visitFields: FormField[] = [selectField('centreId', centreOptions, true), dateField('requestedFor'), textField('reason', true, { multiline: true, maxLength: 500 })];
  return <>
    <Choice label={c(language, 'support')} value={tab} onChange={value => { setTab(value); setCreate(false); }} closeLabel={textFor(language).close} options={options(language, ['supportCentres', 'guides', 'visits'])} />
    <Button secondary title={textFor(language).refresh} busy={data.loading} onPress={() => { void data.reload(); }} />
    {work.canManage || tab === 'visits' && canRecordFarmObservation(work.selectedFarm?.role) ? <Button title={c(language, tab === 'visits' ? 'requestVisit' : 'add')} disabled={tab === 'visits' && !centreOptions.length} onPress={() => setCreate(true)} /> : null}
    {tab === 'supportCentres' ? <Records items={data.value?.centres || []} language={language} timezone={zone(work)} titleKey="name" fields={['kind', 'area', 'distanceKm', 'phone', 'email', 'source_url', 'verified_on']} /> : null}
    {tab === 'guides' ? <><Notice text={c(language, 'videoHint')} /><Records items={data.value?.guides || []} language={language} timezone={zone(work)} fields={['summary', 'language', 'reviewed_by', 'reviewed_on', 'source_url', 'video_size_kb']}>
      {item => <Button secondary title={c(language, 'openGuide')} onPress={() => setGuide(item)} />}
    </Records></> : null}
    {tab === 'visits' ? <><Notice text={c(language, 'visitHint')} /><Records items={(data.value?.visits || []).map(item => ({ ...item, centre_name: data.value?.centres.find(centre => centre.id === item.centre_id)?.name }))} language={language} timezone={zone(work)} titleKey="centre_name" fields={['requested_for', 'reason', 'status', 'note']}>
      {item => work.canManage && ['requested', 'confirmed'].includes(string(item.status)) ? <Button secondary title={textFor(language).edit} onPress={() => setVisit(item)} /> : null}
    </Records></> : null}
    <Sheet title={c(language, tab === 'visits' ? 'requestVisit' : 'add')} visible={create} onClose={() => setCreate(false)} closeLabel={textFor(language).close} keyboardDismissLabel={textFor(language).hideKeyboard}>
      {create && (work.canManage || tab === 'visits' && canRecordFarmObservation(work.selectedFarm?.role)) ? <Form key={tab} work={work} language={language} hint={tab === 'visits' ? c(language, 'visitHint') : undefined} fields={tab === 'supportCentres' ? centreFields : tab === 'guides' ? guideFields : visitFields} initial={tab === 'guides' ? { language } : {}} submit={body => work.api.request(farmPath(work, `/support/${tab === 'supportCentres' ? 'centres' : tab}`), 'POST', body)} onSaved={async () => { setCreate(false); await data.reload(); }} /> : null}
    </Sheet>
    <Sheet title={string(guide?.title) || c(language, 'guides')} visible={Boolean(guide)} onClose={() => setGuide(null)} closeLabel={textFor(language).close}>
      {guide ? <><Facts value={guide} fields={['source_url', 'reviewed_by', 'reviewed_on', 'language']} language={language} timezone={zone(work)} /><Text selectable style={styles.text}>{string(guide.content)}</Text>{guide.video_url ? <Card>
        <Text style={styles.caption}>{c(language, 'videoSizeKb')}: {guide.video_size_kb ? string(guide.video_size_kb) : textFor(language).unknown}</Text>
        <Button secondary title={c(language, 'openVideo')} onPress={() => {
          const url = string(guide.video_url);
          try { const target = new URL(url); if (target.protocol !== 'https:' || target.username || target.password) throw new Error('invalid_input'); }
          catch (error) { work.setError(error); return; }
          onNativePrompt(true);
          void Linking.openURL(url).catch(work.setError).finally(() => onNativePrompt(false));
        }} />
      </Card> : null}</> : null}
    </Sheet>
    <Sheet title={textFor(language).edit} visible={Boolean(visit)} onClose={() => setVisit(null)} closeLabel={textFor(language).close} keyboardDismissLabel={textFor(language).hideKeyboard}>
      {visit && work.canManage ? <Form key={string(visit.id)} work={work} language={language} includeId={false} hint={c(language, 'visitHint')} fields={[selectField('status', options(language, visit.status === 'confirmed' ? ['completed', 'cancelled'] : ['confirmed', 'cancelled']), true), textField('note', true, { multiline: true, maxLength: 500 })]} submit={body => work.api.request(farmPath(work, `/support/visits/${visit.id}`), 'PATCH', { ...body, version: visit.version })} onSaved={async () => { setVisit(null); await data.reload(); }} /> : null}
    </Sheet>
  </>;
}
