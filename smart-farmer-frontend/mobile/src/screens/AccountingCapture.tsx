import React, { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File, Paths } from 'expo-file-system';
import { c } from '../completion-ui';
import { textFor } from '../i18n';
import type { Language } from '../types';
import type { Workspace } from '../use-workspace';
import { Button, Notice, styles } from '../ui';

/** Sources stay in the encrypted attachment store until the user requests upload. */
export function AccountingCapture({ work, language, onNativePrompt, onSelected }: { work: Workspace; language: Language; onNativePrompt: (active: boolean) => void; onSelected?: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const captureBusy = useRef(false);
  const t = textFor(language);

  async function capture(source: 'camera' | 'library' | 'pdf') {
    if (captureBusy.current || !work.canManage) return;
    captureBusy.current = true; setBusy(true); work.setError(null); onNativePrompt(true);
    const temporary = new Set<string>();
    try {
      let uri: string; let filename: string; let mimeType: 'image/jpeg' | 'application/pdf';
      const id = Crypto.randomUUID();
      if (source === 'pdf') {
        const picked = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true, multiple: false });
        const item = picked.assets?.[0]; if (picked.canceled || !item) return;
        uri = item.uri; filename = item.name.replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 150) || `invoice-${id}.pdf`; mimeType = 'application/pdf'; temporary.add(uri);
      } else {
        if (source === 'camera' && !(await ImagePicker.requestCameraPermissionsAsync()).granted) throw new Error('permissionDenied');
        const picked = source === 'camera'
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9, exif: false })
          : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false, quality: 0.9, exif: false });
        const item = picked.assets?.[0]; if (picked.canceled || !item) return;
        temporary.add(item.uri);
        const context = ImageManipulator.manipulate(item.uri);
        try {
          if (Math.max(item.width, item.height) > 2400) context.resize(item.width >= item.height ? { width: 2400 } : { height: 2400 });
          const rendered = await context.renderAsync();
          try {
            const image = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
            uri = image.uri; temporary.add(uri);
          } finally { rendered.release(); }
        } finally { context.release(); }
        filename = `invoice-${id}.jpg`; mimeType = 'image/jpeg';
      }
      const file = new File(uri);
      if (!file.exists || file.size <= 0 || file.size > 5 * 1024 * 1024) throw new Error('media_too_large');
      const dataBase64 = await file.base64();
      if (mimeType === 'application/pdf' && !dataBase64.startsWith('JVBERi0')) throw new Error('invalid_media');
      await work.repository.attach({ id, farmId: work.farmId, accountingDocument: true, financial: true, mimeType, filename, dataBase64, sizeBytes: file.size, state: 'draft', attempts: 0, lastError: null, createdAt: new Date().toISOString() });
      await work.reloadLocal();
      onSelected?.(id);
    } catch (error) { work.setError(error); }
    finally {
      for (const uri of temporary) if (uri.startsWith(Paths.cache.uri)) { try { const file = new File(uri); if (file.exists) file.delete(); } catch {} }
      onNativePrompt(false); captureBusy.current = false; setBusy(false);
    }
  }

  return <View style={{ gap: 12 }}>
    <Notice text={c(language, 'scanHint')} />
    <Text style={styles.caption}>{c(language, 'documentPrivacy')}</Text>
    <View style={styles.row}>
      <Button testID="invoice-camera" secondary title={t.takePhoto} busy={busy} disabled={!work.canManage} onPress={() => { void capture('camera'); }} />
      <Button testID="invoice-library" secondary title={t.choosePhoto} disabled={busy || !work.canManage} onPress={() => { void capture('library'); }} />
    </View>
    <Button testID="invoice-document" secondary title={c(language, 'chooseInvoiceDocument')} disabled={busy || !work.canManage} onPress={() => { void capture('pdf'); }} />
    <Text style={styles.caption}>{c(language, 'documentLocalHint')}</Text>
  </View>;
}
