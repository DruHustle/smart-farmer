import {cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactNode, type FormEvent} from 'react';
import {useFarm} from '../context';
import {label} from '../locales';
export function Icon({name, size = 20}: {name: string; size?: number}) {
  const paths: Record<string, ReactNode> = {
    leaf: <><path d="M20 4C10 3 4 7 4 13a7 7 0 0 0 7 7c6 0 9-6 9-16Z"/><path d="m5 19 10-10M10 14v-4m0 4h4"/></>,
    today: <><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/><circle cx="12" cy="12" r="5"/></>,
    farm: <><path d="m3 10 9-7 9 7v11H3Z"/><path d="M9 21v-8h6v8M3 11h18"/></>,
    market: <><path d="M3 9h18l-2-6H5Zm1 0v12h16V9M9 21v-7h6v7M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/></>,
    services: <><path d="m14 6 4 4m-13 9 4-4 6-6a6 6 0 0 0 6-7l-4 4-3-3 4-4a6 6 0 0 0-7 6L2 14a3 3 0 0 0 3 5Z"/></>,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, chevron: <path d="m9 5 7 7-7 7"/>, back: <path d="m15 5-7 7 7 7"/>, close: <path d="m6 6 12 12M6 18 18 6"/>,
    check: <path d="m4 12 5 5L20 6"/>, sync: <><path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/></>,
    stock: <><path d="m3 7 9-4 9 4-9 4Zm0 0v11l9 4 9-4V7M12 11v11M7 5l10 4"/></>,
    tasks: <><path d="M8 4H4v18h16V4h-4M8 2h8v5H8Z"/><path d="m7 13 2 2 3-4m2 3h3m-3 4h3"/></>,
    equipment: <><path d="M4 8h16v10H4ZM8 8V4h8v4M1 13h3m16 0h3M8 18v3m8-3v3"/><circle cx="12" cy="13" r="2"/></>,
    people: <><circle cx="9" cy="7" r="3"/><path d="M2 21v-4a7 7 0 0 1 14 0v4M16 4a3 3 0 0 1 0 6m3 3a7 7 0 0 1 3 6v2"/></>,
    reports: <><path d="M5 2h10l4 4v16H5ZM14 2v5h5M8 12h8m-8 4h8"/></>,
    incidents: <><path d="m12 3 10 18H2Zm0 6v5"/><circle cx="12" cy="17" r=".5"/></>,
    security: <><path d="m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6Z"/><path d="m8 12 3 3 5-6"/></>,
    lock: <><rect x="5" y="10" width="14" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v3"/></>,
    record: <><path d="m16 3 5 5-13 13H3v-5Zm-2 2 5 5"/></>,
    animal: <><path d="M5 8 3 3l6 3h6l6-3-2 5v7a7 7 0 0 1-14 0Z"/><path d="M8 12h1m6 0h1m-7 5h6"/></>,
    water: <path d="M12 2C9 7 4 12 4 16a8 8 0 0 0 16 0c0-4-5-9-8-14Z"/>,
    camera: <><path d="M3 7h4l2-3h6l2 3h4v14H3Z"/><circle cx="12" cy="14" r="4"/></>,
    mic: <><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.leaf}</svg>;
}
export function PageHead({title, subtitle, action}: {title: string; subtitle?: string; action?: ReactNode}) {return <div className="page-head"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{action}</div>;}
export function Empty({icon = 'leaf', title, text, action}: {icon?: string; title: string; text?: string; action?: ReactNode}) {return <div className="empty"><span className="empty-icon"><Icon name={icon} size={28}/></span><h3>{title}</h3>{text && <p>{text}</p>}{action}</div>;}
export function Badge({value, tone}: {value: string; tone?: string}) {return <span className={`badge ${tone ?? ''}`}>{value}</span>;}
export function Field({label: title, hint, children, className = ''}: {label: string; hint?: string; children: ReactNode; className?: string}) {
  const id = useId();
  const control = isValidElement<{'aria-labelledby'?: string; 'aria-describedby'?: string}>(children)
    ? cloneElement(children, {'aria-labelledby': `${id}-label`, 'aria-describedby': [children.props['aria-describedby'], hint ? `${id}-hint` : undefined].filter(Boolean).join(' ') || undefined})
    : children;
  return <label className={`field ${className}`}><span id={`${id}-label`}>{title}</span>{control}{hint && <small id={`${id}-hint`}>{hint}</small>}</label>;
}
export function Section({title, children, action, className = ''}: {title: string; children: ReactNode; action?: ReactNode; className?: string}) {return <section className={`panel ${className}`}><div className="section-head"><h2>{title}</h2>{action}</div>{children}</section>;}
export function ExpandForm({title, children, open = false}: {title: string; children: ReactNode; open?: boolean}) {return <details className="form-disclosure" open={open || undefined}><summary><Icon name="plus"/><span>{title}</span></summary><div className="form-body">{children}</div></details>;}
export function Modal({title, onClose, children}: {title: string; onClose: () => void; children: ReactNode}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const {t} = useFarm();
  useEffect(() => {const d = dialog.current; if (d && !d.open) d.showModal(); return () => {d?.close();};}, []);
  return <dialog ref={dialog} className="modal" onCancel={e => {e.preventDefault(); onClose();}} onClick={e => {if (e.target === dialog.current) onClose();}}><div className="modal-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label={t.close} onClick={onClose}><Icon name="close"/></button></div><div className="modal-content">{children}</div></dialog>;
}
export const formValue = (data: FormData, name: string): string => String(data.get(name) ?? '').trim();
export const formNumber = (data: FormData, name: string): number | null => formValue(data, name) === '' ? null : Number(formValue(data, name));
export function ProjectSelect({name = 'projectId', required = false, value, onChange}: {name?: string; required?: boolean; value?: string; onChange?: (value: string) => void}) {
  const {data, t} = useFarm();
  return <Field label={t.project}><select name={name} required={required} {...(value === undefined ? {} : {value, onChange: e => onChange?.(e.target.value)})}>{!required && <option value="">{t.none}</option>}{data.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>;
}
export function StockSelect({name = 'stockItemId', required = false, value, onChange}: {name?: string; required?: boolean; value?: string; onChange?: (id: string) => void}) {
  const {data, t} = useFarm();
  return <Field label={t.stockItem}><select name={name} required={required} {...(value === undefined ? {} : {value, onChange: e => onChange?.(e.target.value)})}><option value="">{t.none}</option>{data.stock.map(s => <option key={s.id} value={s.id}>{s.name} · {s.quantity} {s.unit}</option>)}</select></Field>;
}
export function MemberSelect({name = 'assigneeId'}: {name?: string}) {const {data, t} = useFarm(); return <Field label={t.assignee}><select name={name}><option value="">{t.unassigned}</option>{data.members.map(m => <option key={m.id} value={m.id}>{m.username} · {label(t, m.role)}</option>)}</select></Field>;}
export function Form({onSubmit, children, className = ''}: {onSubmit: (data: FormData, form: HTMLFormElement) => void | Promise<void>; children: ReactNode; className?: string}) {
  const {t, notify} = useFarm();
  const submit = (e: FormEvent<HTMLFormElement>) => {e.preventDefault(); const form = e.currentTarget; const invalid = [...form.elements].find(element => element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? !element.validity.valid : false) as HTMLElement | undefined; if (invalid) {notify(t.invalid_input); invalid.focus(); return;} void onSubmit(new FormData(form), form);};
  return <form noValidate className={`form-grid ${className}`} onSubmit={submit}>{children}</form>;
}
export function Submit({children}: {children?: ReactNode}) {const {busy, t} = useFarm(); return <button type="submit" className="primary" disabled={busy}>{children ?? t.save}</button>;}
export function CurrencyFields({required = false}: {required?: boolean}) {const {t} = useFarm(); return <div className="field-row"><Field label={t.amount}><input name="amount" type="number" min="0" step="0.01" required={required}/></Field><Field label={t.currency}><input name="currency" maxLength={3} minLength={3} pattern="[A-Za-z]{3}" placeholder="USD" required={required} autoCapitalize="characters"/></Field></div>;}
export function VoiceRecorder({onFile}: {onFile: (file: File) => void}) {
  const {t, notify} = useFarm(); const [active, setActive] = useState(false); const recorder = useRef<MediaRecorder | null>(null); const stream = useRef<MediaStream | null>(null);
  useEffect(() => () => {if (recorder.current?.state === 'recording') recorder.current.stop(); stream.current?.getTracks().forEach(track => track.stop());}, []);
  async function start() {
    try {const input = await navigator.mediaDevices.getUserMedia({audio: true}); stream.current = input; const type = ['audio/webm', 'audio/mp4'].find(m => MediaRecorder.isTypeSupported(m)); const rec = new MediaRecorder(input, type ? {mimeType: type} : undefined); const chunks: BlobPart[] = []; let size = 0; recorder.current = rec;
      rec.ondataavailable = event => {chunks.push(event.data); size += event.data.size; if (size > 4_500_000 && rec.state === 'recording') rec.stop();};
      rec.onstop = () => {setActive(false); input.getTracks().forEach(track => track.stop()); const mime = rec.mimeType.split(';')[0] || 'audio/webm'; onFile(new File(chunks, `voice-${Date.now()}.${mime === 'audio/mp4' ? 'm4a' : 'webm'}`, {type: mime}));};
      rec.start(1000); setActive(true);
    } catch {notify(t.microphone_error);}
  }
  return <div className="voice-control"><button className="secondary" type="button" disabled={typeof MediaRecorder === 'undefined'} onClick={() => active ? recorder.current?.stop() : void start()}><Icon name="mic"/>{active ? t.stopRecording : t.startRecording}</button>{active && <span role="status" className="recording">{t.recording}</span>}</div>;
}
