import type {Words} from '../locales';
import type {Page} from '../lib/destination';
import type {GuestTab} from '../lib/preview';
import {previewFeatures} from '../lib/preview';
import {Icon} from './ui';

/**
 * Signed-out feature tour. It is static and synthetic (no API calls, no farm data);
 * each "sign in to use" action hands the chosen page to the caller, which starts sign-in
 * and returns the visitor to that page afterwards.
 */
export function PublicPreview({t, busy, target, onOpen, onBrowse}: {t: Words; busy: boolean; target: Page | null; onOpen: (page: Page) => void; onBrowse: (tab: GuestTab) => void}) {
  const words = t as Record<string, string>;
  return <section className="public-preview" aria-labelledby="public-preview-title">
    <div className="preview-head">
      <h2 id="public-preview-title">{t.previewTitle}</h2>
      <p>{t.previewIntro}</p>
    </div>
    <ul className="preview-grid">
      {previewFeatures.map(feature => {
        const title = words[feature.title];
        return <li key={feature.page}>
          <article className={`preview-card${feature.page === target ? ' targeted' : ''}`} aria-labelledby={`preview-${feature.page}`}>
            <div className="preview-card-head">
              <span className="preview-icon"><Icon name={feature.icon} size={22}/></span>
              <h3 id={`preview-${feature.page}`}>{title}</h3>
            </div>
            <p>{words[feature.text]}</p>
            <figure className="preview-sample">
              <figcaption>{t.previewSample}</figcaption>
              <ul>
                {feature.sample.map(row => <li key={row.text}>
                  {row.done !== undefined && <span className={`preview-check${row.done ? ' done' : ''}`} aria-hidden="true">{row.done && <Icon name="check" size={13}/>}</span>}
                  <span className="preview-row-text">{words[row.text]}</span>
                  {row.value && <strong>{row.value}</strong>}
                  {row.meter !== undefined && <span className="preview-meter" aria-hidden="true"><span style={{width: `${row.meter}%`}}/></span>}
                </li>)}
              </ul>
            </figure>
            <div className="preview-actions">
              {feature.guest && (feature.page === 'market' || feature.page === 'services') && <button type="button" className="primary preview-browse" aria-label={`${t.guestBrowse}: ${title}`} onClick={() => onBrowse(feature.page as GuestTab)}>{t.guestBrowse}</button>}
              <button type="button" className="secondary preview-open" disabled={busy} aria-label={`${t.previewOpen}: ${title}`} onClick={() => onOpen(feature.page)}>
                {t.previewOpen}<Icon name="chevron" size={16}/>
              </button>
            </div>
          </article>
        </li>;
      })}
    </ul>
    <p className="preview-note">{t.previewSampleNote}</p>
  </section>;
}
