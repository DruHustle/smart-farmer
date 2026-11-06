import {useEffect, useRef, useState} from 'react';
import {useFarm} from '../context';
import {jsonBody} from '../lib/api';
import {displayTime} from '../lib/time';
import {errorLabel} from '../locales';
import {Empty, Field, Form, Icon, Modal, PageHead, Section, formValue} from '../components/ui';
import {forumText, forumTopics, reportReasons, type ForumComposer, type ForumEntry, type ForumPage, type ForumReport, type ForumThread, type ForumTopic} from '../forum';

type Mode='all'|'mine'|'reports'|'hidden';
type Action={kind:'delete'|'report'|'hide'|'restore'|'dismiss';entry:ForumEntry;id:string;reportId?:string};
export function Forum() {
  const {farm,lang,t,online,snapshot,busy,call,run}=useFarm(),f=forumText(lang);
  const base=`/v1/farms/${farm.id}/forum`,available=online&&!snapshot.requiresAuth;
  const [mode,setMode]=useState<Mode>('all'),[topic,setTopic]=useState<ForumTopic|''>('');
  const [searchDraft,setSearchDraft]=useState(''),[search,setSearch]=useState('');
  const [items,setItems]=useState<ForumEntry[]>([]),[reports,setReports]=useState<ForumReport[]>([]);
  const [next,setNext]=useState<string|null>(null),[loaded,setLoaded]=useState(false),[loading,setLoading]=useState(false);
  const [thread,setThread]=useState<ForumThread|null>(null),[composer,setComposer]=useState<ForumComposer|null>(null),[action,setAction]=useState<Action|null>(null);
  const [formError,setFormError]=useState('');
  const generation=useRef(0),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
  const disabled=!available||busy||loading;
  async function loadFeed(cursor?:string) {
    if(!available)return;
    const current=generation.current;setLoading(true);
    const q=new URLSearchParams({limit:'20'});if(cursor)q.set('cursor',cursor);
    if(mode==='all'||mode==='mine'){if(topic)q.set('topic',topic);if(search)q.set('search',search);q.set('mine',String(mode==='mine'));}
    try {
      if(mode==='reports') {
        const page=await call<ForumPage<ForumReport>>(`${base}/reports?${q}`);
        if(alive.current&&current===generation.current){setReports(previous=>cursor?[...previous,...page.items]:page.items);setNext(page.nextCursor);setLoaded(true);}
      } else {
        const page=await call<ForumPage<ForumEntry>>(`${base}/${mode==='hidden'?'hidden':'discussions'}?${q}`);
        if(alive.current&&current===generation.current){setItems(previous=>cursor?[...new Map([...previous,...page.items].map(item=>[item.id,item])).values()]:page.items);setNext(page.nextCursor);setLoaded(true);}
      }
    } finally {if(alive.current&&current===generation.current)setLoading(false);}
  }
  useEffect(()=>{
    generation.current++;setThread(null);setItems([]);setReports([]);setNext(null);setLoaded(false);setLoading(false);
    if(available)void run(()=>loadFeed());
  },[farm.id,farm.role,available,mode,topic,search]);
  async function openThread(id:string,cursor?:string) {
    if(!available)return;
    const current=generation.current;setLoading(true);
    try {
      const page=await call<ForumThread>(`${base}/discussions/${id}${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`);
      if(alive.current&&current===generation.current)setThread(previous=>cursor&&previous?.discussion.id===id?{...page,replies:{...page.replies,items:[...previous.replies.items,...page.replies.items]}}:page);
    } finally {if(alive.current&&current===generation.current)setLoading(false);}
  }
  function changeMode(value:Mode){setMode(value);setThread(null);}
  function start(kind:ForumComposer['kind'],entry?:ForumEntry){setFormError('');setComposer({kind,id:crypto.randomUUID(),entry,discussionId:thread?.discussion.id});}
  async function afterWrite(entry?:ForumEntry) {
    if(entry?.kind==='discussion'&&entry.status==='visible')await openThread(entry.id);
    else if(thread)await openThread(thread.discussion.id);
    else await loadFeed();
  }
  async function submitContent(data:FormData) {
    if(!composer||!available)return;
    const b={displayName:formValue(data,'displayName'),body:formValue(data,'body'),shareWithCommunity:true,
      ...((composer.kind==='discussion'||composer.entry?.kind==='discussion')?{title:formValue(data,'title'),topic:formValue(data,'topic')}:{}),
      ...(composer.kind==='edit'?{version:composer.entry!.version}:{id:composer.id})};
    await run(async()=>{
      setFormError('');try {
      const path=composer.kind==='edit'?`/entries/${composer.entry!.id}`:composer.kind==='reply'?`/discussions/${composer.discussionId}/replies`:'/discussions';
      const entry=await call<ForumEntry>(base+path,jsonBody(b,composer.kind==='edit'?'PATCH':'POST'));
      if(!alive.current)return;setComposer(null);await afterWrite(entry);
      } catch(error){if(alive.current)setFormError(errorLabel(t,error));throw error;}
    },f.shared);
  }
  async function submitAction(data:FormData) {
    if(!action||!available)return;
    const current=action,version=current.entry.version;
    await run(async()=>{
      setFormError('');try {
      if(current.kind==='delete')await call(`${base}/entries/${current.entry.id}`,jsonBody({version},'DELETE'));
      else if(current.kind==='report')await call(`${base}/entries/${current.entry.id}/reports`,jsonBody({id:current.id,version,reason:formValue(data,'category'),details:formValue(data,'details')}));
      else if(current.kind==='dismiss')await call(`${base}/reports/${current.reportId}/dismiss`,jsonBody({version,reason:formValue(data,'reason')}));
      else await call(`${base}/entries/${current.entry.id}/moderation`,jsonBody({version,status:current.kind==='hide'?'hidden':'visible',reason:formValue(data,'reason')}));
      if(!alive.current)return;setAction(null);
      if(current.kind==='delete'&&current.entry.kind==='discussion'){setThread(null);await loadFeed();}
      else if(mode==='reports'||mode==='hidden')await loadFeed();
      else await afterWrite();
      } catch(error){if(alive.current)setFormError(errorLabel(t,error));throw error;}
    },current.kind==='report'?f.reported:current.kind==='delete'?f.removed:f.moderationSaved);
  }
  function controls(entry:ForumEntry,reportId?:string) {
    if(entry.status==='deleted')return null;
    const act=(kind:Action['kind'])=>{setFormError('');setAction({kind,entry,id:crypto.randomUUID(),reportId});};
    return <div className="button-row forum-actions">
      {entry.canEdit&&<><button type="button" data-testid={`forum-edit-${entry.id}`} disabled={disabled} onClick={()=>start('edit',entry)}>{f.edit}</button><button type="button" className="danger-text" data-testid={`forum-delete-${entry.id}`} disabled={disabled} onClick={()=>act('delete')}>{f.remove}</button></>}
      {!entry.mine&&entry.status==='visible'&&<button type="button" data-testid={`forum-report-${entry.id}`} disabled={disabled} onClick={()=>act('report')}>{f.report}</button>}
      {entry.canModerate&&<button type="button" data-testid={`forum-moderate-${entry.id}`} disabled={disabled} onClick={()=>act(entry.status==='hidden'?'restore':'hide')}>{entry.status==='hidden'?f.restore:f.hide}</button>}
      {reportId&&<button type="button" disabled={disabled} onClick={()=>act('dismiss')}>{f.dismiss}</button>}
    </div>;
  }
  function entryCard(entry:ForumEntry,preview=false) {
    return <article className="forum-entry" data-testid={`forum-entry-${entry.id}`} key={entry.id}>
      {entry.status==='deleted'?<p className="muted">{f.removed}</p>:<>
        {entry.title&&(preview?<h2><button className="forum-title" data-testid={`forum-open-${entry.id}`} disabled={disabled} onClick={()=>void run(()=>openThread(entry.id))}>{entry.title}<Icon name="chevron" size={17}/></button></h2>:<h2>{entry.title}</h2>)}
        <div className="row-meta"><strong>{entry.displayName}</strong>{entry.topic&&<span className="badge">{f[entry.topic]}</span>}<time dateTime={entry.createdAt}>{displayTime(entry.createdAt,lang,farm.timezone)}</time>{entry.version>1&&<span>{f.edited}</span>}</div>
        {entry.status==='hidden'&&<p className="notice warning">{f.hidden}{entry.moderationReason?` ${entry.moderationReason}`:''}</p>}
        <p className="preserve-lines">{preview&&entry.body.length>280?`${entry.body.slice(0,280)}…`:entry.body}</p>
        {preview&&<small>{entry.replyCount} {f.replies}</small>}{controls(entry)}
      </>}
    </article>;
  }
  const actionTitle=action?{delete:f.remove,report:f.reportTitle,hide:f.hide,restore:f.restore,dismiss:f.dismiss}[action.kind]:'';
  return <>
    <PageHead title={f.title} subtitle={f.intro} action={<button className="primary" data-testid="forum-new" disabled={disabled} onClick={()=>start('discussion')}><Icon name="plus"/>{f.newDiscussion}</button>}/>
    <p className="notice subtle">{f.audience}</p>
    {!available&&<p className="notice warning" role="status">{snapshot.requiresAuth?t.sessionExpired:f.offline}</p>}
    {thread&&available?<>
      <button className="back-button" onClick={()=>{setThread(null);void run(()=>loadFeed());}} disabled={disabled}><Icon name="back"/>{f.back}</button>
      <Section title={f.discussions}>{entryCard(thread.discussion)}</Section>
      <Section title={f.replies} action={thread.discussion.status==='visible'?<button data-testid="forum-reply" disabled={disabled} onClick={()=>start('reply')}>{f.reply}</button>:undefined}>
        {thread.replies.items.map(entry=>entryCard(entry))}{!thread.replies.items.length&&<p className="muted">{f.noReplies}</p>}
        {thread.replies.nextCursor&&<button disabled={disabled} onClick={()=>void run(()=>openThread(thread.discussion.id,thread.replies.nextCursor!))}>{f.more}</button>}
      </Section>
    </>:<>
      <div className="button-row forum-modes" aria-label={f.title}>
        {([['all',f.discussions],['mine',f.mine],...(farm.role==='owner'?[['reports',f.reports],['hidden',f.hiddenEntries]]:[])] as [Mode,string][]).map(([value,title])=><button key={value} aria-pressed={mode===value} className={mode===value?'primary':''} disabled={busy||loading} onClick={()=>changeMode(value)}>{title}</button>)}
      </div>
      {(mode==='all'||mode==='mine')?<form className="forum-filters" onSubmit={e=>{e.preventDefault();setSearch(searchDraft.trim());}}>
        <Field label={f.topic}><select data-testid="forum-filter-topic" value={topic} onChange={e=>setTopic(e.target.value as ForumTopic|'')} disabled={disabled}><option value="">{f.all}</option>{forumTopics.map(value=><option key={value} value={value}>{f[value]}</option>)}</select></Field>
        <Field label={f.search}><input type="search" maxLength={100} value={searchDraft} onChange={e=>setSearchDraft(e.target.value)} disabled={!available}/></Field><button type="submit" disabled={disabled}>{f.searchButton}</button>
      </form>:<p className="muted">{f.moderationHint}</p>}
      {loading&&<p role="status">{t.loading}</p>}
      {available&&<Section title={mode==='reports'?f.reports:mode==='hidden'?f.hiddenEntries:f.discussions}>
        {mode==='reports'?reports.map(report=><article className="forum-entry" key={report.id}><h2>{f[report.reason]}</h2><p className="preserve-lines">{report.details}</p><small>{displayTime(report.createdAt,lang,farm.timezone)}</small>{report.reportedVersion!==report.entry.version&&<p className="notice warning">{f.changedSinceReport}</p>}<blockquote><strong>{report.entry.displayName}</strong><p className="preserve-lines">{report.entry.title}</p><p className="preserve-lines">{report.entry.body}</p></blockquote>{controls(report.entry,report.id)}</article>):items.map(entry=>entryCard(entry,mode!=='hidden'))}
        {loaded&&!loading&&!(mode==='reports'?reports:items).length&&<Empty icon="forum" title={mode==='reports'?f.noReports:mode==='hidden'?f.noHidden:f.empty}/>}
        {next&&<button className="load-more" disabled={disabled} onClick={()=>void run(()=>loadFeed(next))}>{f.more}</button>}
      </Section>}
    </>}
    {composer&&<Modal title={composer.kind==='discussion'?f.newDiscussion:composer.kind==='reply'?f.reply:f.edit} onClose={()=>{if(!busy)setComposer(null);}}>
      <Form onSubmit={submitContent}>
        {formError&&<p className="notice error" role="alert">{formError}</p>}
        <Field label={f.displayName} hint={f.nameHint}><input data-testid="forum-compose-name" name="displayName" minLength={2} maxLength={50} required defaultValue={composer.entry?.displayName??''} autoComplete="off"/></Field>
        {(composer.kind==='discussion'||composer.entry?.kind==='discussion')&&<><Field label={f.heading}><input data-testid="forum-compose-title" name="title" minLength={3} maxLength={160} required defaultValue={composer.entry?.title??''}/></Field><Field label={f.topic}><select name="topic" defaultValue={composer.entry?.topic??'general'}>{forumTopics.map(value=><option key={value} value={value}>{f[value]}</option>)}</select></Field></>}
        <Field label={f.body} hint={f.bodyHint}><textarea data-testid="forum-compose-body" name="body" maxLength={8000} required rows={8} defaultValue={composer.entry?.body??''}/></Field>
        <p>{f.audience}</p><label className="check-label"><input data-testid="forum-compose-consent" type="checkbox" required/>{f.consent}</label>
        {!available&&<p className="notice warning">{f.offline}</p>}
        <button data-testid="forum-compose-submit" className="primary" type="submit" disabled={disabled}>{composer.kind==='edit'?f.save:f.share}</button>
      </Form>
    </Modal>}
    {action&&<Modal title={actionTitle} onClose={()=>{if(!busy)setAction(null);}}><Form onSubmit={submitAction}>
      {formError&&<p className="notice error" role="alert">{formError}</p>}
      {action.kind==='delete'?<p>{f.removeHint}</p>:action.kind==='report'?<><p>{f.reportHint}</p><Field label={f.reason}><select name="category" defaultValue="other">{reportReasons.map(value=><option key={value} value={value}>{f[value]}</option>)}</select></Field><Field label={f.details}><textarea name="details" maxLength={1000}/></Field></>:<><p>{f.moderationHint}</p><Field label={f.moderationReason}><textarea name="reason" minLength={5} maxLength={1000} required/></Field></>}
      <label className="check-label"><input data-testid="forum-action-consent" type="checkbox" required/>{f.confirm}</label><button data-testid="forum-action-submit" type="submit" className="primary" disabled={disabled}>{actionTitle}</button>
    </Form></Modal>}
  </>;
}
