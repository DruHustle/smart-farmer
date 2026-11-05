import React, { useEffect, useRef, useState } from 'react';
import { Image, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { extractionDraft, type EditableInvoice, type FinancialDocument } from '../accounting';
import { c, usePanel } from '../completion-ui';
import { sharePrivateReport } from '../exports';
import { errorText, textFor } from '../i18n';
import { allPages } from '../product';
import type { Language } from '../types';
import type { Workspace } from '../use-workspace';
import { Button, Card, Notice, Sheet, styles } from '../ui';
import { AccountingCapture } from './AccountingCapture';
import { accountingMutation, accountingPath } from './accounting-ui';
import { privateImage } from './SecurityPanel';

type Props = { work: Workspace; language: Language; onNativePrompt: (active: boolean) => void; onDraft: (draft: EditableInvoice) => void; projectId?: string };
export function AccountingDocuments(props: Props) {
  const { work, language, onNativePrompt } = props; const t = textFor(language);
  const data = usePanel(work, 'accounting-documents', () => allPages<FinancialDocument>(work.api, accountingPath(work, '/documents')));
  const [selected, setSelected] = useState<FinancialDocument | null>(null); const [visible, setVisible] = useState(25);
  const attachments = work.attachments.filter(item => item.accountingDocument && item.state !== 'synced');
  async function upload(id: string, draft: boolean) {
    try { if (draft) await work.repository.queueAccountingDocument(work.farmId, id); await work.reloadLocal(); await work.sync(true); await data.reload(); }
    catch (error) { work.setError(error); }
  }
  return <>
    <AccountingCapture {...props} onSelected={() => { void work.reloadLocal(); }} />
    {attachments.map(item => <Card key={item.id} title={item.filename}>
      <Text style={styles.text}>{c(language, item.state)} · {Math.ceil(item.sizeBytes / 1024)} KB · {c(language, 'attempts')}: {item.attempts}/5</Text>
      {item.dataBase64 && item.mimeType.startsWith('image/') ? <Image source={{ uri: `data:${item.mimeType};base64,${item.dataBase64}` }} resizeMode="contain" style={{ width: '100%', height: 180 }} accessibilityLabel={c(language, 'sourceDocument')} /> : null}
      {item.lastError ? <Notice error text={errorText(language, new Error(item.lastError))} /> : null}
      {item.state === 'draft' || item.state === 'pending' && item.attempts < 5 ? <Button testID={`invoice-upload-${item.id}`} title={c(language, 'uploadAndExtract')} disabled={!work.online} busy={work.busy} onPress={() => { void upload(item.id, item.state === 'draft'); }} /> : null}
      {item.state === 'draft' ? <Button secondary title={t.remove} onPress={() => { void work.repository.removeDraftAttachment(work.farmId, item.id).then(() => work.reloadLocal()).catch(work.setError); }} /> : null}
    </Card>)}
    {work.progress ? <Text style={styles.text}>{work.progress.percent}%</Text> : null}
    <Notice text={c(language, 'scanQueueHint')} /><Button secondary title={t.refresh} busy={data.loading || work.busy} onPress={() => { void data.reload(); }} />
    {!(data.value?.length || attachments.length) ? <Text style={styles.muted}>{t.empty}</Text> : null}
    {(data.value || []).slice(0, visible).map(document => <Card key={document.id} title={document.filename}><Text testID={`invoice-scan-${document.state}`} style={styles.text}>{c(language, document.state)}</Text><Text style={styles.caption}>{document.createdAt}</Text><Button secondary title={c(language, 'reviewExtraction')} onPress={() => setSelected(document)} /></Card>)}
    {(data.value?.length || 0) > visible ? <Button secondary title={c(language, 'loadMore')} onPress={() => setVisible(value => value + 25)} /> : null}
    <Sheet title={c(language, 'reviewExtraction')} visible={Boolean(selected)} onClose={() => setSelected(null)} closeLabel={t.close} keyboardDismissLabel={t.hideKeyboard}>{selected ? <AccountingDocumentDetail key={selected.id} {...props} id={selected.id} initial={selected} onDraft={draft => { setSelected(null); props.onDraft(draft); }} onChanged={() => { void data.reload(); }} /> : null}</Sheet>
  </>;
}

export function AccountingDocumentDetail({ work, language, onNativePrompt, onDraft, id, initial, projectId, onChanged }: Props & { id: string; initial?: FinancialDocument; onChanged?: () => void }) {
  const t = textFor(language); const data = usePanel(work, `accounting-document:${id}`, () => work.api.request<{ document: FinancialDocument }>(accountingPath(work, `/documents/${id}`)));
  const document = data.value?.document || initial; const [photo, setPhoto] = useState<string | null>(null); const [textOpen, setTextOpen] = useState(false);
  const active = useRef(true); useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function source() {
    if (!document) return;
    await work.onlineAction(async () => {
      if (document.mimeType.startsWith('image/')) { const result = await privateImage(work.session, accountingPath(work, `/documents/${id}/content`)); if (active.current) setPhoto(result.uri); }
      else { onNativePrompt(true); try { await sharePrivateReport(work.session, accountingPath(work, `/documents/${id}/content`), 'pdf', document.filename); } finally { onNativePrompt(false); } }
    });
  }
  async function retry() {
    await work.onlineAction(async () => { await accountingMutation(work, `/documents/${id}/retry`, {}); void data.reload(); onChanged?.(); });
  }
  if (!document) return <Notice text={work.error ? errorText(language, work.error) : data.loading ? t.loading : t.empty} error={Boolean(work.error)} />;
  const extraction = document.extraction;
  return <>
    <Card title={document.filename}><Text testID="invoice-document-state" style={styles.heading}>{c(language, document.state)}</Text><Text style={styles.caption}>{c(language, 'attempts')}: {document.attempts}/3 · {Math.ceil(document.sizeBytes / 1024)} KB</Text><Button secondary title={t.refresh} busy={data.loading} onPress={() => { void data.reload(); }} /><Button testID="invoice-source-preview" secondary title={c(language, 'sourceDocument')} disabled={!work.online} busy={work.busy} onPress={() => { void source(); }} /></Card>
    <Notice text={c(language, document.state === 'failed' ? 'scanFailedHint' : document.state === 'ready' ? 'scanReadyHint' : 'scanQueueHint')} />
    {document.errorCode ? <Notice error text={errorText(language, new Error(document.errorCode))} /> : null}
    {document.state === 'failed' && document.attempts < 3 ? <Button title={t.retry} disabled={!work.online} busy={work.busy} onPress={() => { void retry(); }} /> : null}
    {extraction ? <>
      {extraction.confidence !== null ? <Text style={styles.text}>{c(language, 'extractionConfidence')}: {Math.round(extraction.confidence)}%</Text> : null}
      <Card title={c(language, 'extractionWarnings')}>{extraction.warnings.map(warning => <Text key={warning} style={styles.text}>{errorText(language, new Error(warning))}</Text>)}</Card>
      <Card title={c(language, 'reviewExtraction')}><Text selectable style={styles.text}>{extraction.suggestions.party?.name || t.unknown}</Text><Text style={styles.text}>{c(language, 'reference')}: {extraction.suggestions.reference || t.unknown}</Text><Text style={styles.text}>{c(language, 'issueDate')}: {extraction.suggestions.issueDate || t.unknown}</Text><Text style={styles.text}>{c(language, 'currency')}: {extraction.suggestions.currency || t.unknown}</Text><Text style={styles.text}>{c(language, 'reportedTotal')}: {extraction.suggestions.reportedTotal || t.unknown}</Text><Notice text={c(language, 'reportedTotalHint')} /></Card>
      <Button secondary title={c(language, 'extractedText')} onPress={() => setTextOpen(true)} />
    </> : null}
    {document.state === 'ready' || document.state === 'failed' ? <Button testID="invoice-use-extraction" title={c(language, extraction ? 'useReviewedValues' : 'manualEntry')} onPress={() => onDraft(extractionDraft(document, Crypto.randomUUID(), Crypto.randomUUID, projectId || null))} /> : null}
    <Sheet title={c(language, 'sourceDocument')} visible={Boolean(photo)} onClose={() => setPhoto(null)} closeLabel={t.close}>{photo ? <Image source={{ uri: photo }} resizeMode="contain" style={{ width: '100%', height: 480 }} accessibilityLabel={c(language, 'sourceDocument')} /> : null}</Sheet>
    <Sheet title={c(language, 'extractedText')} visible={textOpen} onClose={() => setTextOpen(false)} closeLabel={t.close}><Text selectable style={styles.text}>{extraction?.text || t.empty}</Text></Sheet>
  </>;
}
