import { appStoreListings } from "./app-store-listings";
import "./app-availability.css";

function PlatformIcon({ platform }: { platform: "ios" | "android" }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {platform === "ios" ? (
        <>
          <rect x="6" y="2" width="12" height="20" rx="3" />
          <path d="M10 4.5h4M10.5 19.5h3" />
        </>
      ) : (
        <>
          <path d="m7 5-2-3m12 3 2-3M3 15a9 9 0 0 1 18 0v2H3z" />
          <circle cx="8" cy="11.5" r=".9" fill="currentColor" stroke="none" />
          <circle cx="16" cy="11.5" r=".9" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  );
}

export function AppAvailability({ heading, unpublished }: { heading: string; unpublished: string }) {
  return (
    <section className="app-availability" aria-label={heading}>
      <h2>{heading}</h2>
      <ul>
        {appStoreListings.map(({ platform, device, store, url }) => {
          const details = (
            <>
              <PlatformIcon platform={platform} />
              <span><strong>{device}</strong><small>{store}{url ? "" : ` · ${unpublished}`}</small></span>
            </>
          );
          return (
            <li key={platform}>
              {url ? <a className="store-listing" href={url}>{details}</a> : <span className="store-listing">{details}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
