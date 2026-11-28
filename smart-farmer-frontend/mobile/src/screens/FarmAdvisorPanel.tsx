import React, { useRef, useState } from 'react';
import { Image, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File, Paths } from 'expo-file-system';
import { c, Facts, farmPath, Form, projectOptions, Records, textField, usePanel } from '../completion-ui';
import { allPages, object, rows, string, type Row } from '../product';
import { textFor } from '../i18n';
import type { Language } from '../types';
import type { Workspace } from '../use-workspace';
import { Button, Card, Choice, Notice, Toggle, styles } from '../ui';

type Props = { work: Workspace; language: Language; onNativePrompt: (active: boolean) => void };
type AdvisorImage = { mimeType: 'image/jpeg'; base64: string };

export function FarmAdvisorPanel({ work, language, onNativePrompt }: Props) {
  const [projectId, setProjectId] = useState('');
  return <>
    <Notice text={c(language, 'advisorHint')} />
    <Choice label={c(language, 'projectId')} value={projectId} onChange={setProjectId} closeLabel={textFor(language).close} options={projectOptions(work)} />
    {projectId ? <AdvisorChat key={projectId} work={work} language={language} projectId={projectId} onNativePrompt={onNativePrompt} /> : null}
  </>;
}

export function AdvisorChat({ work, language, projectId, onNativePrompt }: Props & { projectId: string }) {
  const [answerLanguage, setAnswerLanguage] = useState<string>(language);
  const [answer, setAnswer] = useState<Row | null>(null);
  const [photo, setPhoto] = useState<AdvisorImage | null>(null);
  const [consent, setConsent] = useState(false);
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  const data = usePanel(work, `advisor:${projectId}`, async () => {
    const [context, references, providers] = await Promise.all([
      work.api.request<Row>(farmPath(work, `/projects/${projectId}/companion`)),
      allPages<Row>(work.api, farmPath(work, '/references')),
      work.api.request<Row>(farmPath(work, '/provider-status')),
    ]);
    return { context, references, providers };
  });

  async function capture(camera: boolean) {
    if (pickingRef.current) return;
    pickingRef.current = true; setPicking(true); onNativePrompt(true);
    let original: File | undefined, compressed: File | undefined;
    let context: ReturnType<typeof ImageManipulator.manipulate> | undefined;
    let rendered: Awaited<ReturnType<ReturnType<typeof ImageManipulator.manipulate>['renderAsync']>> | undefined;
    try {
      if (camera && !(await ImagePicker.requestCameraPermissionsAsync()).granted) throw new Error('permissionDenied');
      const selection = camera
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8, exif: false })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false, quality: 0.8, exif: false });
      const selected = selection.assets?.[0];
      if (selection.canceled || !selected) return;
      original = new File(selected.uri);
      context = ImageManipulator.manipulate(selected.uri);
      if (Math.max(selected.width, selected.height) > 1280) context.resize(selected.width >= selected.height ? { width: 1280 } : { height: 1280 });
      rendered = await context.renderAsync();
      const result = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.65 });
      compressed = new File(result.uri);
      if (!compressed.exists || compressed.size < 1 || compressed.size > 1.5 * 1024 * 1024) throw new Error('media_too_large');
      setPhoto({ mimeType: 'image/jpeg', base64: await compressed.base64() });
      setConsent(false); setAnswer(null);
    } catch (error) { work.setError(error); }
    finally {
      // The app keeps only the in-memory preview until the person explicitly
      // submits it; the photo is never queued, publicly linked or persisted here.
      try {
        for (const file of [compressed, original]) if (file?.exists && file.uri.startsWith(Paths.cache.uri)) file.delete();
      } catch (error) { work.setError(error); }
      finally { rendered?.release(); context?.release(); pickingRef.current = false; setPicking(false); onNativePrompt(false); }
    }
  }

  return <>
    <Card title={c(language, 'farmAdvisor')}>
      <Facts value={object(data.value?.providers.ai)} fields={['configured', 'mode']} language={language} />
      {data.value?.context ? <>
        <Records items={rows(data.value.context.nextTasks)} language={language} timezone={work.snapshot?.farm.timezone || 'Africa/Harare'} fields={['due_at', 'status']} />
        {Array.isArray(data.value.context.missingFields) ? <Text style={styles.muted}>{c(language, 'missingData')}: {data.value.context.missingFields.map(item => c(language, string(item))).join(', ') || '—'}</Text> : null}
      </> : null}
      <Choice label={c(language, 'answerLanguage')} disabled={work.busy || picking} value={answerLanguage} onChange={value => { setAnswerLanguage(value); setAnswer(null); }} closeLabel={textFor(language).close} options={[{ value: 'en', label: 'English' }, { value: 'sn', label: 'Shona' }, { value: 'nd', label: 'isiNdebele' }]} />
      <View style={styles.row}><Button secondary title={textFor(language).takePhoto} disabled={work.busy || picking || !work.online} onPress={() => { void capture(true); }} /><Button secondary title={textFor(language).choosePhoto} disabled={work.busy || picking || !work.online} onPress={() => { void capture(false); }} /></View>
      {photo ? <>
        <Image accessibilityLabel={textFor(language).photos} source={{ uri: `data:${photo.mimeType};base64,${photo.base64}` }} resizeMode="contain" style={{ width: '100%', height: 220 }} />
        <Toggle label={c(language, 'imageConsent')} disabled={work.busy} value={consent} onChange={setConsent} />
        <Button secondary title={textFor(language).remove} disabled={work.busy} onPress={() => { setPhoto(null); setConsent(false); }} />
      </> : null}
      <Form work={work} language={language} includeId={false} hint={c(language, 'referenceLimit')} fields={[
        textField('question', true, { multiline: true, maxLength: 3000 }),
        { key: 'referenceIds', type: 'multi', options: (data.value?.references || []).map(item => ({ value: string(item.id), label: `${item.title} · ${item.version}` })) },
      ]} submit={async body => {
        if (photo && !consent) throw new Error('required');
        if (Array.isArray(body.referenceIds) && body.referenceIds.length > 8) throw new Error('referenceLimit');
        const submittedImage = photo;
        const response = await work.api.request<Row>(farmPath(work, `/projects/${projectId}/companion/chat`), 'POST', { ...body, language: answerLanguage, ...(submittedImage ? { image: submittedImage, imageConsent: true } : {}) });
        return { ...response, requestHadImage: Boolean(submittedImage) };
      }} onSaved={result => { setAnswer(object(result)); setPhoto(null); setConsent(false); }} />
    </Card>
    {answer ? <Card title={c(language, 'answer')}>
      <Facts value={answer} fields={['mode', 'provider']} language={language} />
      <Text selectable style={styles.text}>{string(answer.answer)}</Text>
      {answer.requestHadImage ? <Text style={styles.muted}>{c(language, answer.imageAnalysed ? 'imageAnalysed' : 'noImageAnalysis')}</Text> : null}
      {Array.isArray(answer.limitations) ? answer.limitations.map((item, index) => <Text key={index} style={styles.caption}>{string(item)}</Text>) : <Text style={styles.caption}>{string(answer.limitations)}</Text>}
      {answer.languageReview === 'pending' ? <Notice text={textFor(language).translations} /> : null}
    </Card> : null}
  </>;
}
