import React, { useEffect, useRef, useState } from 'react';
import { Image, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File, Paths } from 'expo-file-system';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import * as Crypto from 'expo-crypto';
import { LocalRepository } from './repository';
import type { Attachment, Language } from './types';
import { textFor } from './i18n';
import { Button, styles } from './ui';

async function storeAttachment(repository: LocalRepository, farmId: string, activityId: string, uri: string, mimeType: Attachment['mimeType']): Promise<void> {
  const file = new File(uri);
  if (!file.exists || file.size <= 0 || file.size > 5 * 1024 * 1024) throw new Error('media_too_large');
  const id = Crypto.randomUUID();
  await repository.attach({ id, farmId, activityId, mimeType, filename: `${id}.${mimeType.startsWith('image/') ? 'jpg' : 'm4a'}`, dataBase64: await file.base64(), sizeBytes: file.size, state: 'draft', attempts: 0, lastError: null, createdAt: new Date().toISOString() });
  // Only remove app-owned temporary files after the encrypted database has durably saved them.
  if (file.uri.startsWith(Paths.cache.uri)) file.delete();
}

export function MediaCapture({ repository, farmId, activityId, language, onChange, onError, onNativePrompt }: { repository: LocalRepository; farmId: string; activityId: string; language: Language; onChange: () => Promise<void>; onError: (error: unknown) => void; onNativePrompt: (active: boolean) => void }) {
  const t = textFor(language);
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const activeRecording = useRef(false);
  const recordingOwner = useRef({ farmId, activityId });
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, sampleRate: 22050, numberOfChannels: 1, bitRate: 64000 }, status => {
    if (status.isFinished && activeRecording.current) void persistRecording();
  });
  const recorderState = useAudioRecorderState(recorder);
  const reload = async () => { setAttachments(await repository.attachments(farmId, activityId)); await onChange(); };
  useEffect(() => { void repository.attachments(farmId, activityId).then(setAttachments).catch(onError); }, [farmId, activityId]);
  useEffect(() => () => { onNativePrompt(false); }, []);

  async function photo(camera: boolean) {
    setBusy(true); onNativePrompt(true);
    try {
      if (camera && !(await ImagePicker.requestCameraPermissionsAsync()).granted) throw new Error('permissionDenied');
      const result = camera
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8, exif: false })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false, quality: 0.8, exif: false });
      const selected = result.assets?.[0];
      if (!result.canceled && selected) {
        const context = ImageManipulator.manipulate(selected.uri);
        if (Math.max(selected.width, selected.height) > 1600) context.resize(selected.width >= selected.height ? { width: 1600 } : { height: 1600 });
        const rendered = await context.renderAsync();
        const compressed = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.65 });
        await storeAttachment(repository, farmId, activityId, compressed.uri, 'image/jpeg');
        rendered.release(); context.release();
        await reload();
      }
    } catch (error) { onError(error); } finally { onNativePrompt(false); setBusy(false); }
  }

  async function persistRecording() {
    if (!activeRecording.current) return;
    activeRecording.current = false;
    setBusy(true);
    try {
      if (recorder.isRecording) await recorder.stop();
      const uri = recorder.uri;
      if (uri) await storeAttachment(repository, recordingOwner.current.farmId, recordingOwner.current.activityId, uri, 'audio/mp4');
      await setAudioModeAsync({ allowsRecording: false });
      await reload();
    } catch (error) { onError(error); } finally { setBusy(false); onNativePrompt(false); }
  }

  async function startRecording() {
    setBusy(true); onNativePrompt(true);
    try {
      if (!(await AudioModule.requestRecordingPermissionsAsync()).granted) throw new Error('permissionDenied');
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: false });
      await recorder.prepareToRecordAsync();
      recordingOwner.current = { farmId, activityId };
      activeRecording.current = true;
      recorder.record({ forDuration: 120 });
    } catch (error) { onError(error); onNativePrompt(false); } finally { setBusy(false); }
  }

  return <View style={{ gap: 10 }}><Text style={styles.label}>{t.media}</Text><Text style={styles.caption}>{t.mediaHint}</Text>
    <View style={styles.row}><Button testID="media-camera" secondary title={t.takePhoto} disabled={busy || recorderState.isRecording} onPress={() => { void photo(true); }} /><Button testID="media-library" secondary title={t.choosePhoto} disabled={busy || recorderState.isRecording} onPress={() => { void photo(false); }} /></View>
    <Button secondary title={recorderState.isRecording ? `${t.stopAudio} · ${Math.round(recorderState.durationMillis / 1000)} s` : t.recordAudio} busy={busy} onPress={() => { void (recorderState.isRecording ? persistRecording() : startRecording()); }} />
    {attachments.map(attachment => <View key={attachment.id} style={styles.item}>
      {attachment.mimeType.startsWith('image/') && attachment.dataBase64 ? <Image source={{ uri: `data:${attachment.mimeType};base64,${attachment.dataBase64}` }} style={{ width: '100%', height: 180, borderRadius: 12 }} resizeMode="contain" accessibilityLabel={t.photos} /> : <Text style={styles.text}>{t.voiceNote}</Text>}
      <Text style={styles.caption}>{Math.ceil(attachment.sizeBytes / 1024)} KiB · {t.draft}</Text>
      <Button secondary title={t.remove} disabled={busy} onPress={() => { void repository.removeDraftAttachment(farmId, attachment.id).then(reload).catch(onError); }} />
    </View>)}
  </View>;
}
