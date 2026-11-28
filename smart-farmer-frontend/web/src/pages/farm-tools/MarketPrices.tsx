import {useState} from 'react';
import {useFarm} from '../../context';
import {farmToolWords} from '../../farm-tools-locales';
import {useList} from '../../lib/resources';
import {displayTime, displayNumber} from '../../lib/time';
import {ActionForm, MoreButton, ResourceState, TimeField, text, timestamp, type Row} from '../../components/completion';
import {Badge, ExpandForm, Field, Form, Section, Submit, formValue} from '../../components/ui';
import {SourceLink, ToolEmpty, ToolHeading, optionalText} from './shared';

export function MarketPrices() {
  const {farm, lang, manager, t} = useFarm(); const w = farmToolWords(lang);
  const [query, setQuery] = useState(''); const base = `/v1/farms/${farm.id}/market-prices`;
  const list = useList<Row>(base + query);
  return <><ToolHeading name="market-prices" intro="pricesIntro"/>
    <Section title={t.search}><Form onSubmit={f => {const params = new URLSearchParams(); for (const field of ['commodity','market']) {const value=formValue(f,field); if(value) params.set(field,value);} setQuery(params.size ? '?' + params.toString() : '');}}>
      <div className="field-row"><Field label={w.commodity}><input name="commodity" maxLength={120}/></Field><Field label={w.marketName}><input name="market" maxLength={120}/></Field></div><Submit>{t.search}</Submit>
    </Form></Section>
    {manager && <Section title={w.newPrice}><ExpandForm title={w.newPrice}><ActionForm path={base} after={list.reload} build={(f,id)=>({id,commodity:formValue(f,'commodity'),market:formValue(f,'market'),price:Number(f.get('price')),currency:formValue(f,'currency').toUpperCase(),unit:formValue(f,'unit'),observedAt:timestamp(f,'observedAt',farm.timezone),source:formValue(f,'source'),sourceUrl:optionalText(f,'sourceUrl'),note:optionalText(f,'note')})}>
      <Field label={w.commodity}><input name="commodity" required maxLength={120}/></Field><Field label={w.marketName}><input name="market" required maxLength={120}/></Field>
      <div className="field-row"><Field label={t.price}><input name="price" type="number" required min="0.000001" step="any"/></Field><Field label={t.currency}><input name="currency" required minLength={3} maxLength={3} pattern="[A-Za-z]{3}" autoCapitalize="characters"/></Field></div>
      <Field label={t.unit}><input name="unit" required maxLength={40}/></Field><TimeField/><Field label={t.source}><input name="source" required maxLength={300}/></Field><Field label={w.sourceUrl}><input name="sourceUrl" type="url" pattern="https://.*" maxLength={2000}/></Field><Field label={t.note}><textarea name="note" maxLength={2000}/></Field>
    </ActionForm></ExpandForm></Section>}
    <Section title={w['market-prices']}><ResourceState {...list}/><div className="tool-card-grid">{list.items.map(item=><article className="tool-card" key={item.id}>
      <div className="split"><h3>{text(item.commodity)}</h3><Badge value={text(item.market)}/></div>
      <p className="tool-price">{text(item.currency)} {displayNumber(item.price,lang,6)} <span>/ {text(item.unit)}</span></p>
      <p className="muted">{displayTime(text(item.observed_at),lang,farm.timezone)}</p><p>{t.source}: {text(item.source)}</p><SourceLink value={item.source_url}/>{Boolean(item.note)&&<p>{text(item.note)}</p>}
    </article>)}</div><ToolEmpty loading={list.loading} count={list.items.length}/><MoreButton {...list}/></Section>
  </>;
}
