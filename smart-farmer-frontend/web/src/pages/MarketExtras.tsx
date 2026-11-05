import {useState} from 'react';
import {useFarm} from '../context';
import {useList} from '../lib/resources';
import {jsonBody} from '../lib/api';
import {ActionForm, type Row} from '../components/completion';
import {formNumber, formValue, Field, Section} from '../components/ui';

const words={
  sn:{saved:'Zvakachengetwa / Saved',alerts:'Zviziviso / Alerts',follow:'Vatevedzeri / Followed sellers',searches:'Tsvaga zvachengetwa / Saved searches'},
  nd:{saved:'Okugciniweyo / Saved',alerts:'Izaziso / Alerts',follow:'Abathengisi / Followed sellers',searches:'Okuseshiweyo / Saved searches'}
};
export function MarketExtras() {
  const {lang,t,run,call,online}=useFarm();
  const label=words[lang]??words.sn;
  const favourites=useList<Row>('/v1/market/favorites');
  const saved=useList<Row>('/v1/market/saved-searches');
  const follows=useList<Row>('/v1/market/follows');
  const alerts=useList<Row>('/v1/market/alerts');
  const [copied,setCopied]=useState(false);
  const act=async(path:string,method:string,body?:unknown,after?:()=>Promise<void>)=>{
    await run(async()=>{await call(path,body===undefined?{method}:jsonBody(body,method));if(after)await after();},t.saved);
  };
  return <section aria-label="Marketplace discovery" className="content-grid">
    <Section title={label.searches}>
      <p className="muted">Save an agricultural search to see matching newly posted items here. Notifications are in-app until push delivery is configured.</p>
      <ActionForm path="/v1/market/saved-searches" after={saved.reload} actionLabel={t.save} build={(f,id)=>({
        id,query:formValue(f,'query'),category:formValue(f,'category')||null,
        area:formValue(f,'area'),currency:formValue(f,'currency').toUpperCase()||null,
        minPrice:formNumber(f,'minPrice'),maxPrice:formNumber(f,'maxPrice'),
        condition:formValue(f,'condition'),notify:f.has('notify')
      })}>
        <Field label={t.search}><input name="query" maxLength={100} placeholder="Maize, cattle, irrigation pump…"/></Field>
        <div className="field-row">
          <Field label={t.category}><select name="category"><option value="">All</option>{['produce','input','animal','equipment','other'].map(x=><option key={x} value={x}>{x}</option>)}</select></Field>
          <Field label={t.collectionArea}><input name="area" maxLength={150} placeholder="Harare"/></Field>
        </div>
        <div className="field-row">
          <Field label="Min price"><input name="minPrice" type="number" min="0" max="999999999" step=".01"/></Field>
          <Field label="Max price"><input name="maxPrice" type="number" min="0" max="999999999" step=".01"/></Field>
          <Field label={t.currency}><input name="currency" maxLength={3} pattern="[A-Za-z]{3}" placeholder="USD"/></Field>
        </div>
        <Field label={t.condition}><input name="condition" maxLength={100}/></Field>
        <label className="check-label"><input name="notify" type="checkbox" defaultChecked/>In-app alert for matching new listings</label>
      </ActionForm>
      {saved.items.map(s=><article key={s.id} className="record-card"><strong>{String(s.query)||String(s.category||s.area)}</strong><p>{String(s.area||'All areas')} · {String(s.currency||'All currencies')}</p>
        <div className="button-row"><button className="secondary" disabled={!online} onClick={()=>void act('/v1/market/saved-searches/'+s.id,'PATCH',{notify:!s.notify},saved.reload)}>{s.notify?'Pause alerts':'Resume alerts'}</button><button className="text-button" disabled={!online} onClick={()=>void act('/v1/market/saved-searches/'+s.id,'DELETE',undefined,saved.reload)}>Delete</button></div>
      </article>)}
    </Section>
    <Section title={label.saved}>
      {favourites.items.map(item=><article key={item.id} className="record-card">
        <h3>{String(item.title)}</h3><p>{String(item.price)} {String(item.currency)} · {String(item.collection_area)}</p>
        <button className="secondary" disabled={!online} onClick={()=>void act('/v1/market/favorites/'+item.id,'DELETE',undefined,favourites.reload)}>Remove from saved</button>
      </article>)}
      {!favourites.items.length&&<p className="muted">Save a listing in the marketplace to find it here.</p>}
    </Section>
    <Section title={label.follow}>
      {follows.items.map(item=><article key={item.id} className="record-card"><strong>{String(item.seller_name)}</strong><p>{String(item.listings)} active listings</p>
        <button className="secondary" disabled={!online} onClick={()=>void act('/v1/market/follows/'+item.id,'DELETE',undefined,follows.reload)}>Unfollow</button>
      </article>)}
      {!follows.items.length&&<p className="muted">Follow a seller from a listing.</p>}
    </Section>
    <Section title={label.alerts}>
      {alerts.items.map(a=><article key={a.id} className="record-card"><strong>{String(a.title)}</strong><p>{a.kind==='saved_search'?'Saved search match':'New listing from followed seller'} · {String(a.seller_name)} · {String(a.price)} {String(a.currency)}</p>
        <div className="button-row">{!a.read_at&&<button className="secondary" disabled={!online} onClick={()=>void act('/v1/market/alerts/'+a.id+'/read','POST',{},alerts.reload)}>Mark read</button>}
          <button className="text-button" onClick={()=>{void run(async()=>{const url=new URL(window.location.href);url.searchParams.set('listing',String(a.listing_id));await navigator.clipboard.writeText(url.href);setCopied(true);});}}>Copy listing link</button>
        </div>
      </article>)}
      {copied&&<p role="status">Link copied</p>}
      {!alerts.items.length&&<p className="muted">New matching listings will appear here.</p>}
    </Section>
  </section>;
}
