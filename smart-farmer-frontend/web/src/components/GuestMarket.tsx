import {useEffect, useState, type FormEvent} from 'react';
import type {Lang} from '../types';
import {label, type Words} from '../locales';
import {apiOrigin, request} from '../lib/api';
import {displayMoney, displayNumber} from '../lib/time';
import {guestPageSize, guestPaths, guestTabs, type GuestTab} from '../lib/preview';
import {Icon} from './ui';

type Row = Record<string, unknown>;
type Page = {items: Row[]; nextCursor: string | null};
const text = (value: unknown) => value === null || value === undefined ? '' : String(value);
const listingId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/**
 * Guest browsing of offers the API already publishes to anyone: active market listings
 * and service offers. It never sends credentials or writes anything. Buying, asking, offering
 * and booking sign in first and return to the same listing or to services.
 */
export function GuestMarket({t, lang, tab, shared, busy, onTab, onSignIn}: {
  t: Words; lang: Lang; tab: GuestTab; shared: string | null; busy: boolean;
  onTab: (tab: GuestTab) => void; onSignIn: (path: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [list, setList] = useState<Page & {loading: boolean; failed: boolean}>({items: [], nextCursor: null, loading: true, failed: false});
  const [highlight, setHighlight] = useState<Row | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const query = (cursor?: string) => `${guestPaths[tab]}?${new URLSearchParams({limit: String(guestPageSize), ...(search && {q: search}), ...(cursor && {cursor})})}`;

  useEffect(() => {
    let active = true;
    setList(old => ({...old, items: [], nextCursor: null, loading: true, failed: false}));
    request<Page>(query()).then(page => {if (active) setList({items: page.items, nextCursor: page.nextCursor, loading: false, failed: false});})
      .catch(() => {if (active) setList({items: [], nextCursor: null, loading: false, failed: true});});
    return () => {active = false;};
  }, [tab, search, attempt]);

  useEffect(() => {
    let active = true;
    if (tab !== 'market' || !shared || !listingId.test(shared)) {setHighlight(null); return;}
    request<Row>(`${guestPaths.market}/${shared}`).then(row => {if (active) setHighlight(row);}).catch(() => {if (active) setHighlight(null);});
    return () => {active = false;};
  }, [tab, shared]);

  async function more() {
    if (!list.nextCursor || moreBusy) return;
    setMoreBusy(true);
    try {
      const page = await request<Page>(query(list.nextCursor));
      setList(old => ({...old, items: [...old.items, ...page.items.filter(item => !old.items.some(seen => seen.id === item.id))], nextCursor: page.nextCursor}));
    } catch { setList(old => ({...old, failed: true})); } finally { setMoreBusy(false); }
  }

  function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(String(new FormData(event.currentTarget).get('q') ?? '').trim().slice(0, 100));
  }

  const listing = (row: Row, shown: boolean) => {
    const photos = Array.isArray(row.photo_media_ids) ? row.photo_media_ids as string[] : [];
    const unit = label(t, text(row.unit));
    return <article className={`listing-card guest-card${shown ? ' targeted' : ''}`} key={text(row.id)} aria-labelledby={`guest-${text(row.id)}`}>
      {photos[0] && <img className="guest-photo" loading="lazy" src={`${apiOrigin}${guestPaths.market}/${text(row.id)}/photos/${photos[0]}`} alt={text(row.title)}/>}
      <div className="split"><h3 id={`guest-${text(row.id)}`}>{text(row.title)}</h3><strong>{displayMoney(row.price, text(row.currency), lang)} / {displayNumber(row.price_quantity, lang)} {unit}</strong></div>
      <p>{row.expected_harvest === true ? '' : `${displayNumber(row.available_quantity, lang)} ${unit} · `}{text(row.collection_area)}</p>
      <p className="guest-seller">{t.guestSeller}: {text(row.seller_name)}</p>
      {row.expected_harvest === true && <p className="notice warning">{t.expectedHarvestHint}</p>}
      {text(row.terms) && <p className="guest-terms">{text(row.terms)}</p>}
      <button type="button" className="primary guest-action" disabled={busy} onClick={() => onSignIn(`/?listing=${text(row.id)}`)}>{t.guestBuy}<Icon name="chevron" size={16}/></button>
    </article>;
  };

  const service = (row: Row) => <article className="listing-card guest-card" key={text(row.id)} aria-labelledby={`guest-${text(row.id)}`}>
    <div className="split"><h3 id={`guest-${text(row.id)}`}>{text(row.name)}</h3><strong>{displayMoney(row.rate, text(row.currency), lang)}</strong></div>
    <p>{text(row.description)}</p>
    <p className="guest-seller">{t.serviceArea}: {text(row.service_area)} · {t.rateBasis}: {text(row.rate_basis)}</p>
    {(row.operator_included === true || row.fuel_included === true) && <p className="row-meta">{row.operator_included === true && <span className="badge">{t.operatorIncluded}</span>} {row.fuel_included === true && <span className="badge">{t.fuelIncluded}</span>}</p>}
    <button type="button" className="primary guest-action" disabled={busy} onClick={() => onSignIn('/?page=services')}>{t.guestBook}<Icon name="chevron" size={16}/></button>
  </article>;

  return <section className="guest-market" id="guest-market" aria-labelledby="guest-market-title">
    <div className="preview-head"><h2 id="guest-market-title">{t.guestTitle}</h2><p>{t.guestNote}</p></div>
    <div className="guest-tabs">{guestTabs.map(item => <button key={item} type="button" aria-pressed={tab === item} className={tab === item ? 'selected' : ''} onClick={() => onTab(item)}>{t[item]}</button>)}</div>
    <form className="guest-search" role="search" onSubmit={find}>
      <input name="q" type="search" maxLength={100} aria-label={t.search} placeholder={t.search} defaultValue={search}/>
      <button type="submit" className="secondary">{t.search}</button>
    </form>
    {highlight && <div className="guest-shared"><span className="eyebrow">{t.guestShared}</span>{listing(highlight, true)}</div>}
    {list.loading && <p role="status">{t.loading}</p>}
    {list.failed && <p role="status" className="notice">{t.guestUnavailable} <button type="button" className="text-button" onClick={() => setAttempt(n => n + 1)}>{t.retry}</button></p>}
    {!list.loading && !list.failed && !list.items.length && <p className="muted">{t.noData}</p>}
    <div className="guest-grid">{list.items.filter(row => row.id !== highlight?.id).map(row => tab === 'market' ? listing(row, false) : service(row))}</div>
    {list.nextCursor && <button type="button" className="secondary guest-more" disabled={moreBusy} onClick={() => void more()}>{t.loadMore}</button>}
  </section>;
}
