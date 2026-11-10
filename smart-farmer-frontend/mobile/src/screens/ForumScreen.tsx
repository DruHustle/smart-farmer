import React, {useEffect, useRef, useState} from 'react';
import {Text, View} from 'react-native';
import * as Crypto from 'expo-crypto';
import {errorText, textFor} from '../i18n';
import {formatFarmTime} from '../time';
import type {Language} from '../types';
import type {Workspace} from '../use-workspace';
import {Button, Card, Choice, Field, Notice, Sheet, Toggle, styles} from '../ui';
import {forumText, forumTopics, reportReasons, type ForumComposer, type ForumEntry, type ForumPage, type ForumReport, type ForumThread, type ForumTopic} from '../forum';

type Mode='all'|'mine'|'reports'|'hidden';
type ForumAction={kind:'delete'|'report'|'hide'|'restore'|'dismiss';entry:ForumEntry;id:string;reportId?:string};
export function ForumScreen({work,language,nativeBusy}:{work:Workspace;language:Language;nativeBusy:boolean}) {
  const t=textFor(language),f=forumText(language),base=`/v1/farms/${work.farmId}/forum`;
  const [mode,setMode]=useState<Mode>('all'),[topic,setTopic]=useState<ForumTopic|''>('');
  const [searchDraft,setSearchDraft]=useState(''),[search,setSearch]=useState('');
  const [items,setItems]=useState<ForumEntry[]>([]),[reports,setReports]=useState<ForumReport[]>([]),[next,setNext]=useState<string|null>(null);
  const [thread,setThread]=useState<ForumThread|null>(null),[composer,setComposer]=useState<ForumComposer|null>(null),[action,setAction]=useState<ForumAction|null>(null);
  const [loading,setLoading]=useState(false),[loaded,setLoaded]=useState(false);
  const alive=useRef(true),generation=useRef(0),saving=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
  const available=work.online&&Boolean(work.farmId),disabled=!available||work.busy||loading||nativeBusy;
  async function loadFeed(cursor?:string) {
    if(!available)return;
    const current=generation.current;setLoading(true);
    const q=new URLSearchParams({limit:'20'});if(cursor)q.set('cursor',cursor);
    if(mode==='all'||mode==='mine'){if(topic)q.set('topic',topic);if(search)q.set('search',search);q.set('mine',String(mode==='mine'));}
    try {
      if(mode==='reports') {
        const page=await work.api.request<ForumPage<ForumReport>>(`${base}/reports?${q}`);
        if(alive.current&&current===generation.current){setReports(previous=>cursor?[...previous,...page.items]:page.items);setNext(page.nextCursor);setLoaded(true);}
      } else {
        const page=await work.api.request<ForumPage<ForumEntry>>(`${base}/${mode==='hidden'?'hidden':'discussions'}?${q}`);
        if(alive.current&&current===generation.current){setItems(previous=>cursor?[...new Map([...previous,...page.items].map(item=>[item.id,item])).values()]:page.items);setNext(page.nextCursor);setLoaded(true);}
      }
    } finally {if(alive.current&&current===generation.current)setLoading(false);}
  }
  useEffect(()=>{
    generation.current++;setItems([]);setReports([]);setThread(null);setNext(null);setLoaded(false);setLoading(false);
    if(available)void work.onlineAction(()=>loadFeed());
  },[work.farmId,work.selectedFarm?.role,available,mode,topic,search]);
  async function openThread(id:string,cursor?:string) {
    if(!available)return;
    const current=generation.current;setLoading(true);
    try {
      const page=await work.api.request<ForumThread>(`${base}/discussions/${id}${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`);
      if(alive.current&&current===generation.current)setThread(previous=>cursor&&previous?.discussion.id===id?{...page,replies:{...page.replies,items:[...previous.replies.items,...page.replies.items]}}:page);
    } finally {if(alive.current&&current===generation.current)setLoading(false);}
  }
  function start(kind:ForumComposer['kind'],entry?:ForumEntry){work.setError(null);setComposer({kind,id:Crypto.randomUUID(),entry,discussionId:thread?.discussion.id});}
  function act(kind:ForumAction['kind'],entry:ForumEntry,reportId?:string){work.setError(null);setAction({kind,entry,id:Crypto.randomUUID(),reportId});}
  async function refreshAfterWrite(entry?:ForumEntry) {
    if(entry?.kind==='discussion'&&entry.status==='visible')await openThread(entry.id);
    else if(thread)await openThread(thread.discussion.id);
    else await loadFeed();
  }
  async function publish(values:Record<string,unknown>) {
    if(!composer||disabled||saving.current)return;saving.current=true;
    try {
      const current=composer;
      const success=await work.onlineAction(async()=>{
        const path=current.kind==='edit'?`/entries/${current.entry!.id}`:current.kind==='reply'?`/discussions/${current.discussionId}/replies`:'/discussions';
        const entry=await work.api.request<ForumEntry>(base+path,current.kind==='edit'?'PATCH':'POST',{...values,shareWithCommunity:true,...(current.kind==='edit'?{version:current.entry!.version}:{id:current.id})});
        if(!alive.current)return;setComposer(null);await refreshAfterWrite(entry);
      });
      if(success&&alive.current)work.setNotice('forum_shared');
    } finally {saving.current=false;}
  }
  async function decide(values:{reason:string;details:string}) {
    if(!action||disabled||saving.current)return;saving.current=true;
    try {
      const current=action,version=current.entry.version;
      const success=await work.onlineAction(async()=>{
        if(current.kind==='delete')await work.api.request(`${base}/entries/${current.entry.id}`,'DELETE',{version});
        else if(current.kind==='report')await work.api.request(`${base}/entries/${current.entry.id}/reports`,'POST',{id:current.id,version,reason:values.reason,details:values.details});
        else if(current.kind==='dismiss')await work.api.request(`${base}/reports/${current.reportId}/dismiss`,'POST',{version,reason:values.reason});
        else await work.api.request(`${base}/entries/${current.entry.id}/moderation`,'POST',{version,status:current.kind==='hide'?'hidden':'visible',reason:values.reason});
        if(!alive.current)return;setAction(null);
        if(current.kind==='delete'&&current.entry.kind==='discussion'){setThread(null);await loadFeed();}
        else if(mode==='reports'||mode==='hidden')await loadFeed();
        else await refreshAfterWrite();
      });
      if(success&&alive.current)work.setNotice(current.kind==='report'?'forum_reported':current.kind==='delete'?'forum_removed':'forum_moderation_saved');
    } finally {saving.current=false;}
  }
  function controls(entry:ForumEntry,reportId?:string) {
    if(entry.status==='deleted')return null;
    return <View style={styles.row}>
      {entry.canEdit?<><Button testID={`forum-edit-${entry.kind}-${entry.id}`} title={f.edit} secondary disabled={disabled} onPress={()=>start('edit',entry)}/><Button testID={`forum-delete-${entry.kind}-${entry.id}`} title={f.remove} danger disabled={disabled} onPress={()=>act('delete',entry)}/></>:null}
      {!entry.mine&&entry.status==='visible'?<Button testID={`forum-report-${entry.id}`} title={f.report} secondary disabled={disabled} onPress={()=>act('report',entry)}/>:null}
      {entry.canModerate?<Button testID={`forum-moderate-${entry.id}`} title={entry.status==='hidden'?f.restore:f.hide} secondary disabled={disabled} onPress={()=>act(entry.status==='hidden'?'restore':'hide',entry)}/>:null}
      {reportId?<Button title={f.dismiss} secondary disabled={disabled} onPress={()=>act('dismiss',entry,reportId)}/>:null}
    </View>;
  }
  function entryCard(entry:ForumEntry,preview=false) {
    return <View key={entry.id} testID={`forum-entry-${entry.id}`}><Card>
      {entry.status==='deleted'?<Text style={styles.muted}>{f.removed}</Text>:<>
        {entry.title?(preview?<Button testID={`forum-open-${entry.id}`} title={entry.title} secondary disabled={disabled} onPress={()=>{void work.onlineAction(()=>openThread(entry.id));}}/>:<Text style={styles.heading} accessibilityRole="header">{entry.title}</Text>):null}
        <Text style={styles.label}>{entry.displayName}</Text><Text style={styles.caption}>{entry.topic?`${f[entry.topic]} · `:''}{formatFarmTime(entry.createdAt,work.selectedFarm?.timezone||'Africa/Harare',language)}{entry.version>1?` · ${f.edited}`:''}</Text>
        {entry.status==='hidden'?<Notice text={`${f.hidden}${entry.moderationReason?` ${entry.moderationReason}`:''}`}/>:null}
        <Text selectable style={styles.text}>{preview&&entry.body.length>280?`${entry.body.slice(0,280)}…`:entry.body}</Text>
        {preview?<Text style={styles.caption}>{entry.replyCount} {f.replies}</Text>:null}{controls(entry)}
      </>}
    </Card></View>;
  }
  return <>
    <Text style={styles.title} accessibilityRole="header">{f.title}</Text><Text style={styles.muted}>{f.intro}</Text>
    <Notice text={f.audience}/><Button testID="forum-new" title={f.newDiscussion} disabled={disabled} onPress={()=>start('discussion')}/>
    {!available?<Notice text={f.offline}/>:null}
    {thread&&available?<>
      <Button testID="forum-back" title={f.back} secondary disabled={disabled} onPress={()=>{setThread(null);void work.onlineAction(()=>loadFeed());}}/>
      {entryCard(thread.discussion)}<Text style={styles.heading} accessibilityRole="header">{f.replies}</Text>
      {thread.discussion.status==='visible'?<Button testID="forum-reply" title={f.reply} disabled={disabled} onPress={()=>start('reply')}/>:null}
      {thread.replies.items.map(entry=>entryCard(entry))}{!thread.replies.items.length?<Text style={styles.muted}>{f.noReplies}</Text>:null}
      {thread.replies.nextCursor?<Button title={f.more} secondary disabled={disabled} onPress={()=>{void work.onlineAction(()=>openThread(thread.discussion.id,thread.replies.nextCursor!));}}/>:null}
    </>:<>
      <Choice testID="forum-mode" disabled={disabled} label={f.title} value={mode} closeLabel={t.close} onChange={setMode} options={[{value:'all',label:f.discussions},{value:'mine',label:f.mine},...(work.selectedFarm?.role==='owner'?[{value:'reports' as const,label:f.reports},{value:'hidden' as const,label:f.hiddenEntries}]:[])]}/>
      {mode==='all'||mode==='mine'?<Card>
        <Choice testID="forum-filter-topic" disabled={disabled} label={f.topic} value={topic} closeLabel={t.close} onChange={setTopic} options={[{value:'',label:f.all},...forumTopics.map(value=>({value,label:f[value]}))]}/>
        <Field testID="forum-search" label={f.search} value={searchDraft} onChangeText={setSearchDraft} maxLength={100} editable={!disabled} returnKeyType="search" onSubmitEditing={()=>setSearch(searchDraft.trim())}/>
        <Button testID="forum-search-submit" title={f.searchButton} secondary disabled={disabled} onPress={()=>setSearch(searchDraft.trim())}/>
      </Card>:<Text style={styles.muted}>{f.moderationHint}</Text>}
      {loading?<Text accessibilityLiveRegion="polite" style={styles.muted}>{t.loading}</Text>:null}
      {available?(mode==='reports'?reports.map(report=><Card key={report.id} title={f[report.reason]}>
        <Text selectable style={styles.text}>{report.details}</Text><Text style={styles.caption}>{formatFarmTime(report.createdAt,work.selectedFarm?.timezone||'Africa/Harare',language)}</Text>
        {report.reportedVersion!==report.entry.version?<Notice text={f.changedSinceReport}/>:null}
        <Text style={styles.label}>{report.entry.displayName}</Text>{report.entry.title?<Text style={styles.heading}>{report.entry.title}</Text>:null}<Text selectable style={styles.text}>{report.entry.body}</Text>{controls(report.entry,report.id)}
      </Card>):items.map(entry=>entryCard(entry,mode!=='hidden'))):null}
      {available&&loaded&&!loading&&!(mode==='reports'?reports:items).length?<Card><Text style={styles.muted}>{mode==='reports'?f.noReports:mode==='hidden'?f.noHidden:f.empty}</Text></Card>:null}
      {available&&next?<Button title={f.more} secondary disabled={disabled} onPress={()=>{void work.onlineAction(()=>loadFeed(next));}}/>:null}
    </>}
    <Sheet title={composer?.kind==='discussion'?f.newDiscussion:composer?.kind==='reply'?f.reply:f.edit} visible={Boolean(composer)} closeLabel={t.close} onClose={()=>{if(!work.busy)setComposer(null);}}>
      {composer?<Composer key={composer.id} composer={composer} language={language} disabled={disabled} offline={!available} error={work.error} onSubmit={publish}/>:null}
    </Sheet>
    <Sheet title={action?{delete:f.remove,report:f.reportTitle,hide:f.hide,restore:f.restore,dismiss:f.dismiss}[action.kind]:f.reportTitle} visible={Boolean(action)} closeLabel={t.close} onClose={()=>{if(!work.busy)setAction(null);}}>
      {action?<Decision key={action.id} action={action} language={language} disabled={disabled} error={work.error} onSubmit={decide}/>:null}
    </Sheet>
  </>;
}

function Composer({composer,language,disabled,offline,error,onSubmit}:{composer:ForumComposer;language:Language;disabled:boolean;offline:boolean;error:unknown;onSubmit:(values:Record<string,unknown>)=>Promise<void>}) {
  const f=forumText(language),t=textFor(language),discussion=composer.kind==='discussion'||composer.entry?.kind==='discussion';
  const [displayName,setDisplayName]=useState(composer.entry?.displayName||''),[title,setTitle]=useState(composer.entry?.title||''),[body,setBody]=useState(composer.entry?.body||'');
  const [topic,setTopic]=useState<ForumTopic>(composer.entry?.topic||'general'),[consent,setConsent]=useState(false);
  useEffect(()=>{if(offline)setConsent(false);},[offline]);
  const valid=displayName.trim().length>=2&&body.trim().length>0&&(!discussion||title.trim().length>=3)&&consent;
  return <>
    {error?<View testID="forum-compose-error"><Notice error text={errorText(language,error)}/></View>:null}
    <Field testID="forum-compose-name" label={f.displayName} hint={f.nameHint} value={displayName} onChangeText={setDisplayName} maxLength={50} autoComplete="off" editable={!disabled}/>
    {discussion?<><Field testID="forum-compose-title" label={f.heading} value={title} onChangeText={setTitle} maxLength={160} editable={!disabled}/><Choice testID="forum-compose-topic" disabled={disabled} label={f.topic} value={topic} onChange={setTopic} closeLabel={t.close} options={forumTopics.map(value=>({value,label:f[value]}))}/></>:null}
    <Field testID="forum-compose-body" label={f.body} hint={f.bodyHint} value={body} onChangeText={setBody} maxLength={8000} multiline editable={!disabled}/><Text style={styles.caption}>{body.length} / 8 000</Text>
    <Notice text={f.audience}/><Toggle testID="forum-compose-consent" disabled={disabled} label={f.consent} value={consent} onChange={setConsent}/>
    {offline?<Notice text={f.offline}/>:null}
    <Button testID="forum-compose-submit" title={composer.kind==='edit'?f.save:f.share} disabled={disabled||!valid} onPress={()=>{void onSubmit({displayName:displayName.trim(),body:body.trim(),...(discussion?{title:title.trim(),topic}:{})});}}/>
  </>;
}
function Decision({action,language,disabled,error,onSubmit}:{action:ForumAction;language:Language;disabled:boolean;error:unknown;onSubmit:(values:{reason:string;details:string})=>Promise<void>}) {
  const f=forumText(language),t=textFor(language),[reason,setReason]=useState(''),[category,setCategory]=useState<typeof reportReasons[number]>('other'),[details,setDetails]=useState(''),[confirmed,setConfirmed]=useState(false);
  const moderation=['hide','restore','dismiss'].includes(action.kind),title={delete:f.remove,report:f.reportTitle,hide:f.hide,restore:f.restore,dismiss:f.dismiss}[action.kind];
  return <>
    {error?<Notice error text={errorText(language,error)}/>:null}
    <Text style={styles.text}>{action.kind==='delete'?f.removeHint:action.kind==='report'?f.reportHint:f.moderationHint}</Text>
    {action.kind==='report'?<><Choice testID="forum-report-reason" disabled={disabled} label={f.reason} value={category} onChange={setCategory} closeLabel={t.close} options={reportReasons.map(value=>({value,label:f[value]}))}/><Field testID="forum-report-details" label={f.details} value={details} onChangeText={setDetails} maxLength={1000} multiline editable={!disabled}/></>:null}
    {moderation?<Field testID="forum-moderation-reason" label={f.moderationReason} value={reason} onChangeText={setReason} maxLength={1000} multiline editable={!disabled}/>:null}
    <Toggle testID="forum-action-consent" disabled={disabled} label={f.confirm} value={confirmed} onChange={setConfirmed}/><Button testID="forum-action-submit" title={title} disabled={disabled||!confirmed||(moderation&&reason.trim().length<5)} onPress={()=>{void onSubmit({reason:action.kind==='report'?category:reason.trim(),details:details.trim()});}}/>
  </>;
}
