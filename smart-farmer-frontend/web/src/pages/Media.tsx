import {useEffect, useState} from 'react';
import {useFarm} from '../context';
import {apiOrigin, ApiError} from '../lib/api';
import {useList} from '../lib/resources';
import {downloadPrivate, Facts, MoreButton, ResourceState, text, type Row} from '../components/completion';
import {Field, Form, Submit} from '../components/ui';
import {prepareFile} from './Record';

export function PrivateMedia({item}: {item: Row}) {
  const {farm, snapshot, t, online, run} = useFarm();
  const [url, setUrl] = useState('');
  const path = `/v1/farms/${farm.id}/media/${item.id}/content`;
  useEffect(() => () => {if (url) URL.revokeObjectURL(url);}, [url]);
  const load = async () => {
    const response = await fetch(apiOrigin + path, {headers: {Authorization: `Bearer ${snapshot.identity.token}`}, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw new ApiError('media_unavailable', response.status);
    setUrl(URL.createObjectURL(await response.blob()));
  };
  if (item.mime_type === 'application/pdf') return <div className="private-media"><button type="button" className="text-button" disabled={!online} onClick={() => void run(() => downloadPrivate(path, snapshot.identity.token, text(item.filename) || 'smart-farmer.pdf'))}>{t.download} · {text(item.filename) || t.document}</button></div>;
  return <div className="private-media">{!url ? <button type="button" className="text-button" disabled={!online} onClick={() => void run(load)}>{t.play} · {text(item.filename)}</button> : text(item.mime_type).startsWith('image/') ? <img src={url} alt={text(item.filename) || t.photograph}/> : <audio controls src={url} aria-label={text(item.filename) || t.voiceNote}/>}</div>;
}
export function ActivityMedia({activityId}: {activityId: string}) {
  const {farm, t} = useFarm(); const [open, setOpen] = useState(false); const list = useList<Row>(open ? `/v1/farms/${farm.id}/media?activityId=${activityId}` : null);
  return <details className="attachment-disclosure" onToggle={e => setOpen(e.currentTarget.open)}><summary>{t.photograph} / {t.voiceNote}</summary>{list.items.map(item => <PrivateMedia key={item.id} item={item}/>)}{!list.loading && !list.items.length && <p>{t.noData}</p>}<MoreButton {...list}/></details>;
}
export function AssetMedia({assetId}: {assetId: string}) {
  const {farm, t, snapshot, vault, run, enqueue, manager, navigate} = useFarm();
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<Array<{id: string; file: File}>>([]);
  const list = useList<Row>(open ? `/v1/farms/${farm.id}/media?assetId=${assetId}` : null);
  const pending = snapshot.outbox.filter(item => item.farmId === farm.id && item.payload.assetId === assetId && item.mediaId);
  return <details className="attachment-disclosure" onToggle={e => setOpen(e.currentTarget.open)}><summary>{t.attachments}</summary><p className="muted">{t.assetMediaHint}</p>
    <Form onSubmit={async (data, form) => {
      const saved = await run(async () => {
        if (!files.length) throw new Error('attachment_required');
        const prepared = await Promise.all(files.map(async item => ({id: item.id, file: await prepareFile(item.file, snapshot.preferences?.compactPhotos ?? true, true)})));
        for (const item of prepared) await vault.storeAttachment(item.id, item.file);
        await enqueue(prepared.map(item => ({id: item.id, farmId: farm.id, path: `/v1/farms/${farm.id}/media`, method: 'POST' as const, payload: {id: item.id, assetId, financial: manager && data.has('financial')}, label: item.file.mimeType === 'application/pdf' ? 'document' : item.file.mimeType.startsWith('image/') ? 'photograph' : 'voiceNote', mediaId: item.id})));
      }, t.queued);
      if (saved) {setFiles([]); form.reset();}
    }}><Field label={t.attachments}><input type="file" name="attachments" required multiple accept="image/jpeg,image/png,image/webp,audio/mp4,audio/mpeg,audio/webm,audio/wav,application/pdf" onChange={e => setFiles(Array.from(e.target.files ?? []).map(file => ({id: crypto.randomUUID(), file})))}/></Field>
      {manager && <label className="check-label"><input type="checkbox" name="financial"/>{t.financialAttachment}</label>}
      {files.length > 0 && <ul>{files.map(item => <li key={item.id}>{item.file.name}</li>)}</ul>}<Submit/>
    </Form>
    {pending.length > 0 && <button type="button" className="secondary" onClick={() => navigate('sync')}>{t.pending} · {pending.length} · {t.syncPanel}</button>}
    <ResourceState {...list}/>{list.items.map(item => <article className="record-card" key={item.id}>{item.financial === true && <p className="muted">{t.financialAttachment}</p>}<PrivateMedia item={item}/><Facts entries={[["recordedAt", item.created_at, 'time']]}/></article>)}{!list.loading && !list.items.length && <p>{t.noData}</p>}<MoreButton {...list}/>
  </details>;
}
