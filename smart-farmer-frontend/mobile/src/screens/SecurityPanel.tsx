import React, { useEffect, useState } from 'react';
import { AppState, Image, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Action, c, dateField, Facts, farmPath, Form, memberOptions, numericField, options, Records, selectField, textField, usePanel } from '../completion-ui';
import { allPages, object, rows, string, type FormField, type Row } from '../product';
import { ApiError } from '../api';
import { textFor } from '../i18n';
import { farmNow, formatFarmTime } from '../time';
import type { Language, Session } from '../types';
import { Button, Card, Choice, Notice, Sheet, styles } from '../ui';
import type { Workspace } from '../use-workspace';

type Props = { work: Workspace; language: Language };
type CameraSession = { id: string; token: string; playlistPath: string; expiresAt: string; connectionState: string; mode: string };
const zone = (work: Workspace) => work.snapshot?.farm.timezone || 'Africa/Harare';

export async function privateImage(session: Session, path: string): Promise<{ uri: string; observedAt: string | null; source: string | null }> {
  if (!path.startsWith('/v1/') || path.includes('://')) throw new Error('invalid_input');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(session.origin + path, { headers: { Authorization: `Bearer ${session.token}` }, redirect: 'error', signal: controller.signal });
    if (!response.ok) { let code = 'request_failed'; try { code = (await response.json()).error || code; } catch {} throw new ApiError(response.status, code); }
    const type = response.headers.get('content-type')?.split(';')[0] || '';
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new Error('invalid_response');
    const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.length > 5 * 1024 * 1024) throw new Error('media_too_large');
    let binary = ''; for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return { uri: `data:${type};base64,${btoa(binary)}`, observedAt: response.headers.get('x-observed-at'), source: response.headers.get('x-media-source') };
  } finally { clearTimeout(timer); }
}

export function SecurityPanel({ work, language }: Props) {
  const data = usePanel(work, 'security', async () => { const [cameras, events] = await Promise.all([allPages<Row>(work.api, farmPath(work, '/cameras')), allPages<Row>(work.api, farmPath(work, '/camera-events'))]); return { cameras, events }; });
  const [selected, setSelected] = useState(''); const [video, setVideo] = useState<CameraSession | null>(null); const [event, setEvent] = useState<Row | null>(null);
  const camera = data.value?.cameras.find(item => item.id === selected);
  const [snapshot, setSnapshot] = useState<{ uri: string; observedAt: string | null; source: string | null } | null>(null);
  async function stream(path: string) { const value = await work.api.request<CameraSession>(path, 'POST', { confirmed: true }); if (!value.playlistPath.startsWith(farmPath(work, '/cameras/')) || value.playlistPath.includes('://') || Date.parse(value.expiresAt) <= Date.now()) throw new Error('invalid_response'); setVideo(value); }
  return <>
    <Notice text={c(language, 'cameraSessionHint')} /><Button secondary title={textFor(language).refresh} busy={data.loading} onPress={() => { void data.reload(); }} />
    <Records items={data.value?.cameras || []} language={language} timezone={zone(work)} titleKey="name" fields={['connection_state', 'live_enabled', 'last_frame_at', 'retention_days']}>
      {item => <><Facts value={object(item.capabilities)} fields={['live', 'snapshot', 'motion', 'person', 'ptz']} language={language} />{item.live_enabled ? <Action testID={`camera-live-${item.id}`} work={work} language={language} title={c(language, 'live')} detail={c(language, 'cameraSessionHint')} action={() => stream(farmPath(work, `/cameras/${item.id}/sessions`))} /> : null}{object(item.capabilities).snapshot === true ? <Button secondary title={c(language, 'snapshot')} disabled={!work.online} onPress={() => { void work.onlineAction(async () => setSnapshot(await privateImage(work.session, farmPath(work, `/cameras/${item.id}/snapshot`)))); }} /> : null}{work.selectedFarm?.role === 'owner' ? <Button secondary title={c(language, 'settings')} onPress={() => setSelected(string(item.id))} /> : null}</>}
    </Records>
    <Card title={c(language, 'cameraEvents')}><Records items={data.value?.events || []} language={language} timezone={zone(work)} titleKey="name" fields={['kind', 'source', 'observed_at', 'received_at', 'delayed', 'acknowledged_at', 'expires_at']}>
      {item => <>{!item.acknowledged_at ? <Action testID={`camera-ack-${item.id}`} work={work} language={language} title={c(language, 'acknowledge')} action={() => work.api.request(farmPath(work, `/camera-events/${item.id}/acknowledge`), 'POST', {})} onSaved={data.reload} /> : null}{item.clip_available ? <Action testID={`camera-playback-${item.id}`} work={work} language={language} title={c(language, 'playback')} detail={c(language, 'cameraSessionHint')} action={() => stream(farmPath(work, `/camera-events/${item.id}/session`))} /> : null}{['owner', 'manager', 'worker'].includes(work.selectedFarm?.role || '') ? <Button secondary title={c(language, 'incidents')} onPress={() => setEvent(item)} /> : null}</>}
    </Records></Card>
    <Sheet title={c(language, 'settings')} visible={Boolean(camera)} onClose={() => setSelected('')} closeLabel={textFor(language).close} keyboardDismissLabel={textFor(language).hideKeyboard}>{camera ? <CameraSettings work={work} language={language} camera={camera} onSaved={data.reload} /> : null}</Sheet>
    <Sheet title={c(language, 'live')} visible={Boolean(video)} onClose={() => setVideo(null)} closeLabel={textFor(language).close} keyboardDismissLabel={textFor(language).hideKeyboard}>{video ? <PrivateVideo key={video.id} work={work} language={language} session={video} /> : null}</Sheet>
    <Sheet title={c(language, 'snapshot')} visible={Boolean(snapshot)} onClose={() => setSnapshot(null)} closeLabel={textFor(language).close} keyboardDismissLabel={textFor(language).hideKeyboard}>{snapshot ? <><Image source={{ uri: snapshot.uri }} style={{ width: '100%', height: 300 }} resizeMode="contain" accessibilityLabel={c(language, 'snapshot')} /><Text style={styles.caption}>{snapshot.observedAt ? formatFarmTime(snapshot.observedAt, zone(work), language) : textFor(language).unknown} · {c(language, snapshot.source || 'unknown')}</Text></> : null}</Sheet>
    <Sheet title={c(language, 'incidents')} visible={Boolean(event)} onClose={() => setEvent(null)} closeLabel={textFor(language).close} keyboardDismissLabel={textFor(language).hideKeyboard}>{event ? <Form work={work} language={language} fields={[textField('title', true), textField('description', false, { multiline: true }), selectField('severity', options(language, ['low', 'medium', 'high', 'urgent']), true), ...(work.canManage ? [selectField('assigneeId', memberOptions(work))] : [])]} initial={{ title: string(event.name), severity: 'medium' }} submit={body => work.api.request(farmPath(work, `/camera-events/${event.id}/incident`), 'POST', { ...body, confirmed: true })} onSaved={async () => { setEvent(null); await data.reload(); }} /> : null}</Sheet>
  </>;
}

function PrivateVideo({ work, language, session }: Props & { session: CameraSession }) {
  const [expired, setExpired] = useState(false); const [failed, setFailed] = useState(false);
  const player = useVideoPlayer({ uri: work.session.origin + session.playlistPath, headers: { Authorization: `Bearer ${session.token}` }, contentType: 'hls', useCaching: false }, player => { player.loop = false; player.play(); });
  const [playbackStatus, setPlaybackStatus] = useState(() => player.status);
  useEffect(() => {
    setPlaybackStatus(player.status);
    const timer = setTimeout(() => { player.pause(); setExpired(true); }, Math.max(0, Date.parse(session.expiresAt) - Date.now()));
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') player.pause(); });
    const errors = player.addListener('statusChange', event => { setPlaybackStatus(event.status); if (event.status === 'error') setFailed(true); });
    return () => { clearTimeout(timer); listener.remove(); errors.remove(); };
  }, [session.id, player]);
  return <><Notice text={c(language, 'cameraSessionHint')} /><Text style={styles.caption}>{c(language, session.mode)} · {formatFarmTime(session.expiresAt, zone(work), language)}</Text>{expired || failed ? <View testID="camera-player-error" collapsable={false}><Notice text={c(language, expired ? 'expired' : 'camera_unavailable')} /></View> : <><Text testID={playbackStatus === 'readyToPlay' ? 'camera-player-ready' : 'camera-player-loading'} accessibilityLiveRegion="polite" style={styles.caption}>{playbackStatus === 'readyToPlay' ? c(language, 'playbackReady') : textFor(language).loading}</Text><VideoView player={player} style={{ width: '100%', height: 300 }} nativeControls allowsPictureInPicture={false} contentFit="contain" accessibilityLabel={c(language, 'live')} /></>}</>;
}

function CameraSettings({ work, language, camera, onSaved }: Props & { camera: Row; onSaved: () => Promise<void> }) {
  const access = usePanel(work, `camera-access:${camera.id}`, () => allPages<Row>(work.api, farmPath(work, `/cameras/${camera.id}/access`)));
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const fields: FormField[] = [selectField('provider', options(language, ['simulator', 'gateway']), true), numericField('retentionDays', true, { type: 'integer', minimum: 1, maximum: 90 }), { key: 'eventsEnabled', type: 'boolean' }, { key: 'liveEnabled', type: 'boolean' }, ...['live', 'snapshot', 'motion', 'person'].map(key => ({ key, type: 'boolean' as const })), numericField('dedupeSeconds', true, { type: 'integer', minimum: 1, maximum: 600 }), { key: 'zones', type: 'rows', fields: [textField('id', true, { label: c(language, 'key') }), textField('name', true), { key: 'points', type: 'rows', required: true, fields: [numericField('x', true, { maximum: 1, label: 'X · 0–1' }), numericField('y', true, { maximum: 1, label: 'Y · 0–1' })] }] }, { key: 'schedules', type: 'rows', fields: [{ key: 'days', type: 'multi', required: true, options: weekdays.map((day, i) => ({ value: String(i), label: c(language, day) })) }, { key: 'start', type: 'time', required: true }, { key: 'end', type: 'time', required: true }] }];
  return <><Form work={work} language={language} key={string(camera.version)} includeId={false} hint={textFor(language).equipmentHint} fields={fields} initial={{ provider: camera.provider || (work.snapshot?.assets.find(item => item.id === camera.id)?.integration_state === 'simulated' ? 'simulator' : 'gateway'), retentionDays: camera.retention_days || 7, eventsEnabled: camera.events_enabled === true, liveEnabled: camera.live_enabled === true, ...object(camera.capabilities), dedupeSeconds: camera.dedupe_seconds || 30, zones: rows(camera.zones).map(row => ({ ...row, points: (Array.isArray(row.points) ? row.points : []).map(point => ({ x: (point as number[])[0], y: (point as number[])[1] })) })), schedules: rows(camera.schedules).map(row => ({ ...row, days: (Array.isArray(row.days) ? row.days : []).map(String) })) }} submit={body => { const { live, snapshot, motion, person, zones, schedules, ...rest } = body; return work.api.request(farmPath(work, `/cameras/${camera.id}/configure`), 'POST', { ...rest, capabilities: { live, snapshot, motion, person, ptz: false }, zones: rows(zones).map(row => ({ ...row, points: rows(row.points).map(point => [point.x, point.y]) })), schedules: rows(schedules).map(row => ({ ...row, days: (row.days as string[]).map(Number) })), version: camera.version }); }} onSaved={onSaved} />
    <Card title={c(language, 'access')}><Records items={access.value || []} language={language} timezone={zone(work)} titleKey="username" fields={[]} >{item => <Action work={work} language={language} title={textFor(language).revoke} danger action={() => work.api.request(farmPath(work, `/cameras/${camera.id}/access/${item.user_id}`), 'DELETE')} onSaved={access.reload} />}</Records><Form work={work} language={language} includeId={false} fields={[selectField('userId', memberOptions(work), true)]} submit={body => work.api.request(farmPath(work, `/cameras/${camera.id}/access`), 'POST', body)} onSaved={access.reload} /></Card>
    {camera.provider === 'simulator' && work.canManage ? <Form work={work} language={language} title={c(language, 'simulated')} fields={[selectField('kind', options(language, ['motion', 'person']), true), dateField('observedAt')]} initial={{ observedAt: farmNow(zone(work)) }} submit={body => work.api.request(farmPath(work, '/camera-events'), 'POST', { ...body, assetId: camera.id, retentionDays: camera.retention_days || 7 })} onSaved={onSaved} /> : null}
  </>;
}
