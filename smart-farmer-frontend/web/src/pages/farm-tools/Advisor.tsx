import {useState} from 'react';
import {useFarm} from '../../context';
import {farmToolWords} from '../../farm-tools-locales';
import {useList,useResource} from '../../lib/resources';
import {jsonBody} from '../../lib/api';
import {compactAdvisorPhoto} from '../../lib/advisor-photo';
import {label} from '../../locales';
import {ResourceState,asObject,rows,text,type Row} from '../../components/completion';
import {Badge,Field,Form,Section,Submit,formValue} from '../../components/ui';
import {SourceLink,ToolHeading} from './shared';

export function Advisor(){
  const {farm,lang,t,data,online,call,run}=useFarm();const w=farmToolWords(lang),base=`/v1/farms/${farm.id}`;
  const [projectId,setProjectId]=useState(''),[file,setFile]=useState<File|null>(null),[answer,setAnswer]=useState<Record<string,unknown>|null>(null);
  const references=useList<Row>(`${base}/references`),guidance=useResource<Record<string,unknown>>(projectId?`${base}/projects/${projectId}/companion`:null,{});
  const project=data.projects.find(p=>p.id===projectId),context=asObject(guidance.value.context);
  return <><ToolHeading name="advisor" intro="advisorIntro"/><Section title={t.project}><Field label={t.project}><select value={projectId} onChange={e=>{setProjectId(e.target.value);setFile(null);setAnswer(null);}}><option value="">{t.none}</option>{data.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field></Section>
    {project&&['owner','manager','worker','adviser'].includes(farm.role)&&<><Section title={t.question}><ResourceState {...guidance}/><Form key={projectId} onSubmit={async f=>{await run(async()=>{if(!online)throw new Error('online_required');if(file&&!f.has('imageConsent'))throw new Error('invalid_input');const image=file?await compactAdvisorPhoto(file):undefined;setAnswer(await call(`${base}/projects/${projectId}/companion/chat`,jsonBody({question:formValue(f,'question'),language:lang,referenceIds:f.getAll('referenceIds').map(String),...(image?{image,imageConsent:true}:{})})));});}}>
      <Field label={t.question}><textarea name="question" required maxLength={3000}/></Field>
      <Field label={w.photo} hint={w.photoLimit}><input name="image" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={e=>{setFile(e.target.files?.[0]??null);setAnswer(null);}}/></Field>
      {file&&<label className="check-label"><input name="imageConsent" type="checkbox" required/>{w.photoConsent}</label>}
      <fieldset className="repeat-card"><legend>{t.sources}</legend>{references.items.map(reference=><label className="check-label" key={reference.id}><input type="checkbox" name="referenceIds" value={reference.id}/>{text(reference.title)} · {text(reference.reviewed_by)}</label>)}{!references.items.length&&<p>{t.noData}</p>}</fieldset><Submit disabled={!online}>{t.askCompanion}</Submit>
    </Form>{answer&&<article className="companion-answer" aria-live="polite"><Badge value={label(t,text(answer.mode))}/>{answer.provider==='unconfigured'&&<p>{w.providerUnavailable}</p>}<p className="preserve-lines">{text(answer.answer)}</p>{Array.isArray(answer.limitations)&&<ul>{(answer.limitations as unknown[]).map((item,i)=><li key={i}>{typeof item==='string'&&label(t,item)!==t.unknown?label(t,item):text(item)}</li>)}</ul>}{file&&<p>{answer.imageAnalysed?w.imageAnalysed:w.imageNotAnalysed}</p>}{answer.languageReview==='pending'&&<p>{t.translationNote}</p>}</article>}</Section>
    <Section title={t.companionContext}><p>{project.name} · {project.crop??label(t,project.enterprise_type)}</p>{rows(context.recentActivities??guidance.value.recentActivities).map(item=><p key={item.id}>{text(item.note)}</p>)}{rows(guidance.value.nextActions).map((item,i)=><p key={item.id||i}>{text(item.title)} · {text(item.reason)}</p>)}{Array.isArray(guidance.value.missingFields)&&<ul>{(guidance.value.missingFields as string[]).map(key=><li key={key}>{label(t,key)}</li>)}</ul>}{references.items.map(reference=><p key={reference.id}><SourceLink value={reference.source_url}>{text(reference.title)}</SourceLink></p>)}</Section></>}
  </>;
}
