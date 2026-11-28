import {useState} from 'react';
import {useFarm} from '../../context';
import {farmToolWords} from '../../farm-tools-locales';
import {useResource} from '../../lib/resources';
import {displayTime} from '../../lib/time';
import {ActionForm,ResourceState,asObject,rows,text} from '../../components/completion';
import {Badge,Field,Section,formValue} from '../../components/ui';
import {ToolHeading} from './shared';

export function BasicPhone(){
  const {farm,lang,t,data,run,call,online,navigate}=useFarm();const w=farmToolWords(lang),path=`/v1/farms/${farm.id}/basic-phone`;
  const resource=useResource<Record<string,unknown>>(path,{});const [code,setCode]=useState(''),[expires,setExpires]=useState('');
  const channels=rows(resource.value.channels).filter(channel=>channel.channel==='sms'&&Boolean(channel.verified_at)&&!channel.disabled_at),link=asObject(resource.value.link);
  return <><ToolHeading name="basic-phone" intro="phoneIntro"/><Section title={w['basic-phone']}><ResourceState {...resource}/><Badge value={resource.value.configured?t.enabled:w.noProvider}/><p>{link.linkedAt&&!link.revokedAt&&Date.parse(text(link.accessExpiresAt))>Date.now()?w.linked:link.id&&!link.revokedAt&&Date.parse(text(link.expiresAt))>Date.now()?w.pending:w.notLinked}</p>{Boolean(link.expiresAt)&&<p>{t.expires}: {displayTime(text(link.expiresAt),lang,farm.timezone)}</p>}<button className="secondary" onClick={()=>navigate('notifications')}>{w.configureChannels}</button></Section>
    {Boolean(resource.value.configured)&&['owner','manager','worker'].includes(farm.role)&&<Section title={w.linkPhone}><ActionForm path={`${path}/link`} after={resource.reload} onResult={result=>{const value=asObject(result);setCode(text(value.code));setExpires(text(value.expiresAt));}} build={(f,id)=>({id,channelId:formValue(f,'channelId'),projectId:formValue(f,'projectId'),consent:f.has('consent')})} actionLabel={w.linkPhone}>
      <Field label={t.address}><select name="channelId" required><option value="">{t.none}</option>{channels.map(channel=><option key={channel.id} value={channel.id}>{text(channel.masked_address??channel.address_masked??channel.maskedAddress)}</option>)}</select></Field><Field label={t.project}><select name="projectId" required><option value="">{t.none}</option>{data.projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></Field><label className="check-label"><input name="consent" type="checkbox" required/>{w.linkConsent}</label>
    </ActionForm>{code&&<div className="secret-result" role="status"><strong>{w.linkCode}</strong><code>{code}</code><p>{w.linkCodeHint}</p><p>{t.expires}: {displayTime(expires,lang,farm.timezone)}</p></div>}{Boolean(link.id)&&!link.revokedAt&&<button type="button" className="text-button danger-text" disabled={!online} onClick={()=>void run(async()=>{await call(`${path}/link`,{method:'DELETE'});setCode('');setExpires('');await resource.reload();})}>{w.removeLink}</button>}</Section>}
    <Section title={w.commands}><ul className="tool-notes">{Array.isArray(resource.value.commands)&&(resource.value.commands as unknown[]).map((command,i)=><li key={i}>{typeof command==='object'?Object.values(asObject(command)).map(text).join(' · '):text(command)}</li>)}</ul></Section>
  </>;
}
