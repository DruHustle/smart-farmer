import {useState} from 'react';
import {useFarm} from '../context';
import {label} from '../locales';
import {farmTimeToUtc, localDateTime} from '../lib/time';
import {Field, Form, Modal, StockSelect, Submit, VoiceRecorder, formNumber, formValue, Icon} from '../components/ui';

const mimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'audio/mp4', 'audio/mpeg', 'audio/webm', 'audio/wav']);
export async function prepareFile(file: File, compact = true, allowDocuments = false): Promise<{mimeType: string; dataBase64: string; filename: string}> {
  let blob: Blob = file;
  if (compact && file.type.startsWith('image/') && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    const image = await createImageBitmap(file); const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
    const context = canvas.getContext('2d'); if (!context) throw new Error('attachment_type'); context.drawImage(image, 0, 0, canvas.width, canvas.height); image.close();
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('attachment_type')), 'image/jpeg', 0.8));
  }
  const type = blob.type.split(';')[0];
  if (!mimeTypes.has(type) && !(allowDocuments && type === 'application/pdf')) throw new Error('attachment_type');
  if (blob.size > 5 * 1024 * 1024) throw new Error('attachment_too_large');
  const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
  for (let i = 0; i < bytes.length; i += 16_384) binary += String.fromCharCode(...bytes.subarray(i, i + 16_384));
  return {mimeType: type, dataBase64: btoa(binary), filename: file.name};
}
export function RecordActivity({initialProject, onClose}: {initialProject: string; onClose: () => void}) {
  const {data, t, farm, run, enqueue, vault, manager, snapshot} = useFarm(); const [projectId, setProjectId] = useState(initialProject || data.projects[0]?.id || ''); const selectedProject = data.projects.find(p => p.id === projectId); const [kind, setKind] = useState(farm.role === 'adviser' ? 'observation' : 'work'); const [stockId, setStockId] = useState(''); const [files, setFiles] = useState<File[]>([]);
  const stockKind = kind === 'input_use' || kind === 'harvest'; const stock = data.stock.find(s => s.id === stockId);
  return <Modal title={t.record} onClose={onClose}><p className="muted">{t.recordHint}</p><Form onSubmit={async f => {
    const success = await run(async () => {
      const id = crypto.randomUUID(), projectId = formValue(f, 'projectId'); const quantity = formNumber(f, 'quantity'); const unit = stockKind ? stock?.unit ?? null : formValue(f, 'unit') || null;
      if ((quantity === null) !== (unit === null)) throw new Error('invalid_input');
      if (stockKind && (!stock || quantity === null || quantity <= 0)) throw new Error('stock_required');
      const payload: Record<string, unknown> = {id, projectId, kind, observedAt: farmTimeToUtc(formValue(f, 'observedAt'), farm.timezone), note: formValue(f, 'note'), quantity, unit};
      const taskId = formValue(f, 'taskId'); if (taskId) {const task = data.tasks.find(row => row.id === taskId); if (!task || task.project_id !== projectId) throw new Error('invalid_input'); payload.taskId = taskId; payload.taskVersion = task.version;}
      if (stockKind) payload.stockItemId = stockId;
      if (kind === 'cost') {payload.amount = formNumber(f, 'amount'); payload.currency = formValue(f, 'currency').toUpperCase();}
      const media = await Promise.all(files.map(async file => ({id: crypto.randomUUID(), file: await prepareFile(file, snapshot.preferences?.compactPhotos ?? true)})));
      for (const item of media) await vault.storeAttachment(item.id, item.file);
      // All queue entries commit together; uploads still run independently after metadata syncs.
      await enqueue([
        {id, farmId: farm.id, path: `/v1/farms/${farm.id}/activities`, method: 'POST', payload, label: kind},
        ...media.map(item => ({id: item.id, farmId: farm.id, path: `/v1/farms/${farm.id}/media`, method: 'POST' as const, payload: {id: item.id, activityId: id}, label: item.file.mimeType.startsWith('image/') ? 'photograph' : 'voiceNote', mediaId: item.id}))
      ]);
    });
    if (success) onClose();
  }}>
    <Field label={t.project}><select name="projectId" required value={projectId} onChange={e => {setProjectId(e.target.value); setKind(farm.role === 'adviser' ? 'observation' : 'work'); setStockId('');}}>{data.projects.filter(p => p.status !== 'closed').map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></Field>
    <Field label={t.kind}><select name="kind" value={kind} onChange={e => {setKind(e.target.value); setStockId('');}}>{(farm.role==='adviser'?['observation',...(selectedProject?.enterprise_type==='crop'?['rain']:[])]:['work', 'observation', ...(selectedProject?.enterprise_type === 'crop' ? ['rain', 'irrigation', 'harvest', 'input_use'] : []), ...(manager ? ['cost'] : [])]).map(k => <option key={k} value={k}>{label(t, k)}</option>)}</select></Field>
    {farm.role!=='adviser'&&<Field label={t.linkedTask}><select name="taskId"><option value="">{t.none}</option>{data.tasks.filter(task => task.project_id === projectId && !['completed', 'cancelled'].includes(task.status) && (manager || task.assignee_id === snapshot.identity.userId)).map(task => <option value={task.id} key={task.id}>{task.title}</option>)}</select></Field>}
    <Field label={t.when} hint={`${t.farmTime}: ${farm.timezone}`}><input name="observedAt" type="datetime-local" required defaultValue={localDateTime(new Date(), farm.timezone)}/></Field>
    <Field label={t.note}><textarea name="note" rows={3} maxLength={4000}/></Field>
    {stockKind && <StockSelect required value={stockId} onChange={setStockId}/>}
    {kind !== 'cost' && <div className="field-row"><Field label={t.quantity}><input name="quantity" type="number" min={stockKind ? '0.000001' : '0'} step="any" required={stockKind}/></Field><Field label={t.unit}>{stockKind ? <input name="unit" value={stock?.unit ?? ''} readOnly/> : <select name="unit"><option value="">{t.none}</option>{['mm', 'l', 'h', 'kg', 'count', '°C', 'pH'].map(unit => <option value={unit} key={unit}>{unit}</option>)}</select>}</Field></div>}
    {kind === 'cost' && <div className="field-row"><Field label={t.amount}><input name="amount" type="number" min="0" step="0.01" required/></Field><Field label={t.currency}><input name="currency" required minLength={3} maxLength={3} pattern="[A-Za-z]{3}" placeholder="USD" autoCapitalize="characters"/></Field></div>}
    <details className="attachment-disclosure"><summary><Icon name="camera"/>{t.photograph} / {t.voiceNote}</summary><p className="muted small">{t.attachmentHint}</p><Field label={t.photograph}><input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={e => {const file = e.target.files?.[0]; if (file) setFiles(prev => [...prev, file]);}}/></Field><VoiceRecorder onFile={file => setFiles(prev => [...prev, file])}/><Field label={t.voiceNote}><input type="file" accept="audio/mp4,audio/mpeg,audio/webm,audio/wav" onChange={e => {const file = e.target.files?.[0]; if (file) setFiles(prev => [...prev, file]);}}/></Field>{files.map((file, i) => <div className="attachment-row" key={`${file.name}-${i}`}><span>{file.name} · {(file.size / 1024).toFixed(0)} KB</span><button type="button" className="icon-button" aria-label={t.removeDraft} onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}><Icon name="close" size={16}/></button></div>)}</details>
    <Submit/>
  </Form></Modal>;
}
