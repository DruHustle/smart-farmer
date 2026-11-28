import {useState} from 'react';
import {useFarm} from '../../context';
import {farmToolWords,type FarmToolKey} from '../../farm-tools-locales';
import {useList} from '../../lib/resources';
import {ActionForm,DataTable,MoreButton,ResourceState,TimeField,asObject,rows,text,timestamp,type Row} from '../../components/completion';
import {Badge,ExpandForm,Field,Section,formValue} from '../../components/ui';
import {ToolEmpty,ToolHeading,optionalNumber,optionalText,useDetailHistory} from './shared';

const waterKeys=['ph','ecMsCm','temperatureC','dissolvedOxygenMgL','ammoniaMgL','nitriteMgL','nitrateMgL'] as const;
export function GrowingSystems() {
  const {farm,lang,manager,t,data}=useFarm();const w=farmToolWords(lang),base=`/v1/farms/${farm.id}/growing-systems`;
  const list=useList<Row>(base),locations=useList<Row>(`/v1/farms/${farm.id}/locations`);const [selected,setSelected]=useState(''),[kind,setKind]=useState('hydroponics');
  if(selected)return <><button className="secondary back-button" onClick={()=>setSelected('')}>{t.back}</button><SystemDetail key={selected} id={selected}/></>;
  return <><ToolHeading name="growing-systems" intro="systemsIntro"/>
    {manager&&<Section title={w.newSystem}><ExpandForm title={w.newSystem}><ActionForm path={base} after={list.reload} build={(f,id)=>({id,name:formValue(f,'name'),type:kind,cropProjectId:formValue(f,'cropProjectId'),fishProjectId:kind==='aquaponics'?formValue(f,'fishProjectId'):undefined,locationId:optionalText(f,'locationId'),volumeLitres:optionalNumber(f,'volumeLitres'),notes:optionalText(f,'notes')})}>
      <Field label={t.title}><input name="name" required maxLength={160}/></Field><Field label={t.kind}><select name="type" value={kind} onChange={e=>setKind(e.target.value)}><option value="hydroponics">{w.hydroponics}</option><option value="aquaponics">{w.aquaponics}</option></select></Field><Field label={w.cropProject}><select name="cropProjectId" required><option value="">{t.none}</option>{data.projects.filter(p=>p.enterprise_type==='crop').map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>{kind==='aquaponics'&&<Field label={w.fishProject}><select name="fishProjectId" required><option value="">{t.none}</option>{data.projects.filter(p=>p.enterprise_type.startsWith('fish')).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
      <Field label={t.location}><select name="locationId"><option value="">{t.none}</option>{locations.items.map(l=><option key={l.id} value={l.id}>{text(l.name)}</option>)}</select></Field><Field label={w.volumeLitres}><input name="volumeLitres" type="number" min="0.000001" step="any"/></Field><Field label={t.note}><textarea name="notes" maxLength={2000}/></Field>
    </ActionForm></ExpandForm></Section>}
    <Section title={w['growing-systems']}><ResourceState {...list}/><div className="tool-card-grid">{list.items.map(system=><article className="tool-card" key={system.id}><div className="split"><h3>{text(system.name)}</h3><Badge value={w[text(system.type) as FarmToolKey]??t.unknown}/></div><p>{data.projects.find(p=>p.id===system.crop_project_id)?.name}{system.fish_project_id?` · ${data.projects.find(p=>p.id===system.fish_project_id)?.name??t.unknown}`:''}</p><p>{text(system.notes)}</p><button className="secondary" onClick={()=>setSelected(system.id)}>{w.waterQuality}</button></article>)}</div><ToolEmpty loading={list.loading} count={list.items.length}/><MoreButton {...list}/></Section>
  </>;
}
function SystemDetail({id}:{id:string}) {
  const {farm,lang,t}=useFarm();const w=farmToolWords(lang),base=`/v1/farms/${farm.id}/growing-systems/${id}`;
  const resource=useDetailHistory(base,'logs'),system=asObject(resource.value.system);
  const columns=[{key:'observed_at',title:t.when,format:'time' as const},...waterKeys.map(key=>({key:({ph:'ph',ecMsCm:'ec_ms_cm',temperatureC:'temperature_c',dissolvedOxygenMgL:'dissolved_oxygen_mg_l',ammoniaMgL:'ammonia_mg_l',nitriteMgL:'nitrite_mg_l',nitrateMgL:'nitrate_mg_l'})[key],title:w[key],format:'number' as const})),{key:'source',title:t.source},{key:'note',title:t.note}];
  return <><ToolHeading name="growing-systems" intro="systemsIntro"/><Section title={text(system.name)||w.waterQuality}><ResourceState {...resource}/><p>{text(system.notes)}</p><DataTable title={w.waterQuality} items={rows(resource.value.logs)} columns={columns}/><MoreButton {...resource}/></Section>
    {['owner','manager','worker','adviser'].includes(farm.role)&&<Section title={w.waterQuality}><p className="muted">{w.measurementHint}</p><ActionForm path={`${base}/logs`} after={resource.reload} build={(f,id)=>{const values=Object.fromEntries(waterKeys.map(key=>[key,optionalNumber(f,key)]));if(Object.values(values).every(v=>v===undefined))throw new Error('invalid_input');return{id,...values,observedAt:timestamp(f,'observedAt',farm.timezone),source:formValue(f,'source'),note:optionalText(f,'note')};}}>
      <TimeField/><Field label={t.source}><input name="source" required maxLength={300}/></Field><div className="tool-measurements">{waterKeys.map(key=><Field key={key} label={w[key]}><input name={key} type="number" min={key==='temperatureC'?'-10':'0'} max={key==='ph'?'14':key==='ecMsCm'?'200':key==='temperatureC'||key==='dissolvedOxygenMgL'?'100':'10000'} step="any"/></Field>)}</div><Field label={t.note}><textarea name="note" maxLength={2000}/></Field>
    </ActionForm></Section>}
  </>;
}
