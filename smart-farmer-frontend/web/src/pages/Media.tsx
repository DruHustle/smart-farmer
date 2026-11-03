import {useEffect, useState} from 'react';
import {useFarm} from '../context';
import {apiOrigin, ApiError} from '../lib/api';
import {useList} from '../lib/resources';
import {text, type Row, MoreButton} from '../components/completion';
import {ExpandForm} from '../components/ui';
export function PrivateMedia({item}: {item: Row}) {
  const {farm, snapshot, t, online, run} = useFarm(); const [url, setUrl] = useState('');
  useEffect(() => () => {if (url) URL.revokeObjectURL(url);}, [url]);
  const load = async () => {const response = await fetch(`${apiOrigin}/v1/farms/${farm.id}/media/${item.id}/content`, {headers: {Authorization: `Bearer ${snapshot.identity.token}`}, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(30000)}); if (!response.ok) throw new ApiError('media_unavailable', response.status); setUrl(URL.createObjectURL(await response.blob()));};
  return <div className="private-media">{!url ? <button className="text-button" disabled={!online} onClick={() => void run(load)}>{t.play} · {text(item.filename)}</button> : text(item.mime_type).startsWith('image/') ? <img src={url} alt={text(item.filename) || t.photograph}/> : <audio controls src={url} aria-label={text(item.filename) || t.voiceNote}/>}</div>;
}
export function ActivityMedia({activityId}: {activityId: string}) {
  const {farm, t} = useFarm(); const [open, setOpen] = useState(false); const list = useList<Row>(open ? `/v1/farms/${farm.id}/media?activityId=${activityId}` : null);
  return <details className="attachment-disclosure" onToggle={e => setOpen(e.currentTarget.open)}><summary>{t.photograph} / {t.voiceNote}</summary>{list.items.map(item => <PrivateMedia key={item.id} item={item}/>)}{!list.loading && !list.items.length && <p>{t.noData}</p>}<MoreButton {...list}/></details>;
}
