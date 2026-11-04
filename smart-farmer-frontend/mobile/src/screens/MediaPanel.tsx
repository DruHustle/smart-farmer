import React, { useEffect, useState } from 'react';
import { AppState, Image, Text, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { c, Facts, farmPath, Records, usePanel } from '../completion-ui';
import { allPages, string, type Row } from '../product';
import { MediaCapture } from '../media';
import { sharePrivateReport } from '../exports';
import { errorText, textFor } from '../i18n';
import type { Language } from '../types';
import type { Workspace } from '../use-workspace';
import { Button, Card, Notice, Sheet, Toggle, styles } from '../ui';
import { privateImage } from './SecurityPanel';

export function MediaPanel({ work, language, assetId, onNativePrompt }: { work: Workspace; language: Language; assetId?: string; onNativePrompt: (active: boolean) => void }) {
  const data = usePanel(work, `media:${assetId || 'all'}`, () => allPages<Row>(work.api, farmPath(work, `/media${assetId ? `?assetId=${assetId}` : ''}`)));
  const [financial, setFinancial] = useState(false);
  const [selected, setSelected] = useState<Row | null>(null); const [photo, setPhoto] = useState<string | null>(null);
  const t = textFor(language); const timezone = work.snapshot?.farm.timezone || 'Africa/Harare';
  async function preview(item: Row) {
    await work.onlineAction(async () => {
      if (string(item.mime_type).startsWith('image/')) { const result = await privateImage(work.session, farmPath(work, `/media/${item.id}/content`)); setPhoto(result.uri); }
      else if (item.mime_type === 'application/pdf') { onNativePrompt(true); try { await sharePrivateReport(work.session, farmPath(work, `/media/${item.id}/content`), 'pdf', string(item.filename)); } finally { onNativePrompt(false); } }
      else setSelected(item);
    });
  }
  return <><Notice text={t.dataSaverHint} /><Button secondary title={t.refresh} busy={data.loading} onPress={() => { void data.reload(); }} />
    <Records items={data.value || []} language={language} timezone={timezone} titleKey="filename" fields={['mime_type', 'size_bytes', 'created_at', 'financial']}>
      {item => <><Text style={styles.caption}>{item.asset_id ? work.snapshot?.assets.find(asset => asset.id === item.asset_id)?.name : work.snapshot?.activities.find(activity => activity.id === item.activity_id)?.note}</Text><Button secondary title={c(language, item.mime_type === 'application/pdf' ? 'openDocument' : 'preview')} disabled={!work.online} onPress={() => { void preview(item); }} /></>}
    </Records>
    {assetId && work.canManage ? <Card title={t.media}><Toggle label={c(language, 'financialDocument')} hint={c(language, 'financialDocumentHint')} value={financial} onChange={setFinancial} /><MediaCapture repository={work.repository} farmId={work.farmId} assetId={assetId} financial={financial} language={language} onChange={work.reloadLocal} onError={work.setError} onNativePrompt={onNativePrompt} /><Text style={styles.caption}>{t.mediaHint}</Text>{work.progress ? <Text accessibilityLiveRegion="polite" style={styles.text}>{work.progress.percent}%</Text> : null}<Button title={t.upload} busy={work.busy} disabled={!work.online} onPress={() => { void work.sync(true).then(data.reload); }} /></Card> : null}
    <Sheet title={t.photos} visible={Boolean(photo)} onClose={() => setPhoto(null)} closeLabel={t.close}>{photo ? <Image source={{ uri: photo }} resizeMode="contain" style={{ width: '100%', height: 360 }} accessibilityLabel={t.photos} /> : null}</Sheet>
    <Sheet title={t.voiceNote} visible={Boolean(selected)} onClose={() => setSelected(null)} closeLabel={t.close}>{selected ? <PrivateAudio key={string(selected.id)} work={work} language={language} media={selected} /> : null}</Sheet>
  </>;
}

function PrivateAudio({ work, language, media }: { work: Workspace; language: Language; media: Row }) {
  const source = { uri: work.session.origin + farmPath(work, `/media/${media.id}/content`), headers: { Authorization: `Bearer ${work.session.token}` } };
  const player = useAudioPlayer(source, { downloadFirst: false, keepAudioSessionActive: false }); const status = useAudioPlayerStatus(player);
  useEffect(() => { const listener = AppState.addEventListener('change', state => { if (state !== 'active') player.pause(); }); return () => { listener.remove(); }; }, [player]);
  return <><Facts value={media} fields={['filename', 'created_at']} language={language} timezone={work.snapshot?.farm.timezone || 'Africa/Harare'} />{status.error ? <Notice error text={errorText(language, new Error('media_unavailable'))} /> : null}<Text style={styles.text}>{Math.floor(status.currentTime || 0)} / {Math.floor(status.duration || 0)} s</Text><View style={styles.row}><Button title={c(language, status.playing ? 'pause' : 'play')} disabled={!status.isLoaded} onPress={() => { if (status.playing) player.pause(); else player.play(); }} /><Button secondary title={c(language, 'restartPlayback')} disabled={!status.isLoaded} onPress={() => { void player.seekTo(0); }} />{status.error ? <Button secondary title={textFor(language).retry} onPress={() => player.replace(source)} /> : null}</View></>;
}
