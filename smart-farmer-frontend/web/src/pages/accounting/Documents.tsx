import {useEffect, useRef, useState} from 'react';
import {useFarm} from '../../context';
import {jsonBody} from '../../lib/api';
import {invoiceFilePayload, validateInvoiceFile} from '../../lib/accounting';
import {useList, useResource} from '../../lib/resources';
import {displayTime} from '../../lib/time';
import {errorLabel, label} from '../../locales';
import {ActionForm, downloadPrivate, MoreButton, ResourceState} from '../../components/completion';
import {Badge, Empty, Field, Form, Icon, Section, Submit} from '../../components/ui';
import type {InvoiceDocument} from './types';

export function DocumentStatus({document}: {document: InvoiceDocument}) {
  const {t} = useFarm();
  const titles = {queued: t.extractionQueued, processing: t.extractionProcessing, ready: t.extractionReady, failed: t.extractionFailed};
  return <Badge value={titles[document.state]} tone={document.state === 'failed' ? 'danger' : document.state === 'ready' ? 'success' : undefined}/>;
}

export function SupplierDocuments({onDraft}: {onDraft: (document: InvoiceDocument | null) => void}) {
  const {farm, t, lang, online, run, call, notify} = useFarm();
  const base = `/v1/farms/${farm.id}/accounting/documents`;
  const list = useList<InvoiceDocument>(base);
  const [file, setFile] = useState<File | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  function choose(value: File | null) {
    if (!value) return;
    try {validateInvoiceFile(value); setFile(value); requestId.current = crypto.randomUUID();}
    catch (error) {setFile(null); notify(errorLabel(t, error));}
  }
  if (selected) return <DocumentReview documentId={selected} onBack={async () => {setSelected(null); if (online) await run(list.reload);}} onDraft={onDraft}/>;
  return <>
    <Section title={t.newSupplierInvoice} action={<button type="button" className="secondary" disabled={!online} onClick={() => onDraft(null)}>{t.manualInvoice}</button>}>
      <p>{t.scanInvoiceHint}</p>
      <Form onSubmit={async (_data, form) => {
        const saved = await run(async () => {
          if (!online) throw new Error('online_required');
          if (!file) throw new Error('attachment_required');
          const result = await call<{document: InvoiceDocument}>(base, jsonBody({id: requestId.current, ...await invoiceFilePayload(file)}));
          // The server may return an existing identical file. Always use its identity.
          setSelected(result.document.id);
          requestId.current = crypto.randomUUID();
        });
        if (saved) {setFile(null); form.reset();}
      }}>
        <div className="field-row">
          <Field label={t.invoiceCamera}><input type="file" name="camera" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={!online} onChange={event => choose(event.target.files?.[0] ?? null)}/></Field>
          <Field label={t.invoiceFile}><input type="file" name="invoiceFile" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={!online} onChange={event => choose(event.target.files?.[0] ?? null)}/></Field>
        </div>
        <p className="muted small">{t.invoiceFileHint}</p>
        {file && <p className="invoice-file-selection" role="status"><Icon name="reports"/>{file.name} · {Math.ceil(file.size / 1024)} KB</p>}
        <Submit disabled={!online || !file}>{t.uploadInvoice}</Submit>
      </Form>
    </Section>
    <Section title={t.sourceDocument} action={<button type="button" className="text-button" disabled={!online || list.loading} onClick={() => void run(list.reload)}><Icon name="sync"/>{t.invoiceReload}</button>}>
      <ResourceState {...list}/>
      {list.items.map(document => <article className="record-card invoice-document-row" key={document.id}>
        <div><h3>{document.filename}</h3><p className="small">{displayTime(document.createdAt, lang, farm.timezone)}</p><DocumentStatus document={document}/></div>
        <button type="button" className="secondary" onClick={() => setSelected(document.id)}>{t.review}</button>
      </article>)}
      {!list.loading && !list.items.length && <Empty icon="reports" title={t.invoiceEmpty}/>}
      <MoreButton {...list}/>
    </Section>
  </>;
}

export function DocumentReview({documentId, onBack, onDraft}: {documentId: string; onBack: () => void; onDraft: (document: InvoiceDocument) => void}) {
  const {farm, t, online, run, snapshot} = useFarm();
  const base = `/v1/farms/${farm.id}/accounting/documents/${documentId}`;
  const resource = useResource<{document: InvoiceDocument | null}>(base, {document: null});
  const document = resource.value.document;
  const state = document?.state;
  useEffect(() => {
    if (!online || (state !== 'queued' && state !== 'processing')) return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (cancelled) return;
      await run(resource.reload);
      attempts += 1;
      // Bounded foreground reads; an explicit refresh remains available afterwards.
      if (!cancelled && attempts < 30) timer = setTimeout(check, 4000);
    };
    timer = setTimeout(check, 4000);
    return () => {cancelled = true; clearTimeout(timer);};
  }, [documentId, online, state, resource.reload]);
  return <Section title={t.extractionReview} action={<button type="button" className="text-button" onClick={onBack}><Icon name="back"/>{t.back}</button>}>
    <ResourceState {...resource}/>
    {document ? <>
      <h3>{document.filename}</h3>
      <div className="invoice-status-row" role="status"><DocumentStatus document={document}/></div>
      <div className="button-row">
        <button type="button" className="secondary" disabled={!online} onClick={() => void run(() => downloadPrivate(`${base}/content`, snapshot.identity.token, document.filename))}>{t.sourceDocument} · {t.download}</button>
        <button type="button" className="text-button" disabled={!online || resource.loading} onClick={() => void run(resource.reload)}><Icon name="sync"/>{t.invoiceReload}</button>
      </div>
      {(state === 'queued' || state === 'processing') && <p className="notice subtle">{t.invoiceScanStillWorking}</p>}
      {state === 'failed' && <div className="notice"><p>{document.errorCode ? errorLabel(t, new Error(document.errorCode)) : t.extractionFailed}</p><p>{t.extractionUnavailable}</p></div>}
      {document.extraction && <>
        <p className="notice subtle">{t.extractionHint}</p>
        {document.extraction.confidence !== null && <p>{t.extractionConfidence}: {Math.round(document.extraction.confidence)}%</p>}
        {document.extraction.warnings.length > 0 && <div><h3>{t.extractionWarnings}</h3><ul className="notice-list">{document.extraction.warnings.map(warning => <li key={warning}>{label(t, `scan_${warning}`)}</li>)}</ul></div>}
        <details className="attachment-disclosure"><summary>{t.extractedText}</summary><pre className="invoice-extracted-text">{document.extraction.text}</pre></details>
        {document.extraction.suggestions.reportedTotal !== null && <p>{t.invoiceReportedTotal}: {document.extraction.suggestions.currency ?? t.unknown} {document.extraction.suggestions.reportedTotal}</p>}
      </>}
      {state === 'failed' && document.attempts < 3 && <ActionForm path={`${base}/retry`} build={(_form, id) => ({id})} after={resource.reload} actionLabel={t.extractionRetry}>{null}</ActionForm>}
      <div className="button-row"><button type="button" className="primary" disabled={!online || (state !== 'ready' && state !== 'failed')} onClick={() => onDraft(document)}>{state === 'ready' ? t.useExtractedDraft : t.manualInvoice}</button></div>
    </> : !resource.loading && <Empty title={t.noData}/>}
  </Section>;
}
