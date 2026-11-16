import {useState} from 'react';
import {useFarm} from '../context';
import {label} from '../locales';
import {useList} from '../lib/resources';
import {jsonBody} from '../lib/api';
import {Field, Form, Section, Submit, Empty, Badge} from '../components/ui';
import {formNumber,formValue} from '../components/ui';

type Fix = {
 id:string; label:string; provider:string; herd_name:string; animal_identifier:string|null;
 project_id:string; animal_id:string|null; coverage:string; status:string;
 observed_at:string|null; latitude:number|null; longitude:number|null;
 accuracy_m:number|null; quality:string|null; battery_percent:number|null; location_state:string;
};
type Fence={id:string;name:string;latitude:number;longitude:number;radius_m:number;project_id:string|null;active:boolean};
type Alert={id:string;tracker_label:string;geofence_name:string|null;kind:string;status:string;opened_at:string};
type Read={id:string; observed_at:string; latitude:number; longitude:number; accuracy_m:number|null;quality:string};
const format=(v:unknown)=>v===null||v===undefined?'—':String(v);
const mapLink=(lat:number,lon:number)=>'https://www.openstreetmap.org/?mlat='+encodeURIComponent(lat)+'&mlon='+encodeURIComponent(lon)+'#map=15/'+encodeURIComponent(lat)+'/'+encodeURIComponent(lon);
export function LivestockTrackersWeb() {
 const {farm,data,manager,run,call,online,t}=useFarm();
 const prefix='/v1/farms/'+farm.id;
 const trackers=useList<Fix>(prefix+'/trackers');
 const fences=useList<Fence>(prefix+'/geofences');
 const alerts=useList<Alert>(prefix+'/tracker-alerts');
 const [selected,setSelected]=useState<string|null>(null);
 const history=useList<Read>(selected?prefix+'/trackers/'+selected+'/history':null);
 const [issuedToken,setIssuedToken]=useState<string|null>(null);
 const [tokenVisible,setTokenVisible]=useState(false);
 const [saved,setSaved]=useState(false);
 const [kind,setKind]=useState('gnss_cellular');
 const animalProjects=data.projects.filter(p=>p.enterprise_type!=='crop'&&p.status==='active');
 const reload=async()=>{await Promise.all([trackers.reload(),fences.reload(),alerts.reload()]);};
 const change=async(path:string,body:unknown)=>{
   await run(async()=>{await call(path,jsonBody(body,'PATCH'));await reload();},t.saved);
 };
 return <Section title={t.trackingTitle}>
   <p className="notice subtle">{t.trackingPrivacy}</p>
   {manager&&animalProjects.length>0&&<details><summary>{t.trackingRegister}</summary>
      <Form onSubmit={async(f,form)=>{const ok=await run(async()=>{
         const response=await call<{ingestToken?:string}>(prefix+'/trackers',jsonBody({
           id:crypto.randomUUID(),projectId:formValue(f,'projectId'),animalId:formValue(f,'animalId')||null,
           label:formValue(f,'label'),provider:formValue(f,'provider'),externalId:formValue(f,'externalId')
         }));
         setIssuedToken(response.ingestToken??null);setSaved(true);await trackers.reload();
       },t.saved);if(ok)form.reset();}}>
        <Field label={t.trackingGroup}><select name="projectId" required>{animalProjects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label={t.trackingTagLabel}><input name="label" maxLength={120} required placeholder={t.trackingTagExample}/></Field>
        <Field label={t.trackingType}><select name="provider" value={kind} onChange={e=>setKind(e.target.value)}>
          <option value="gnss_cellular">{t.trackerProvider_gnss_cellular}</option><option value="gnss_lorawan">{t.trackerProvider_gnss_lorawan}</option>
          <option value="gnss_satellite">{t.trackerProvider_gnss_satellite}</option><option value="demo">{t.trackerProvider_demo}</option>
          <option value="manual_reference">{t.trackerProvider_manual_reference}</option>
        </select></Field>
        <Field label={t.trackingDeviceId}><input name="externalId" maxLength={120} required placeholder={t.trackingDeviceIdHint}/></Field>
        <Field label={t.trackingAnimalId}><input name="animalId" pattern="[0-9a-fA-F-]{36}" placeholder={t.trackingAnimalPlaceholder}/></Field>
        <Submit>{t.trackingRegisterAction}</Submit>
      </Form>
      {saved&&<div className="notice" role="status">{issuedToken?
        <><strong>{t.trackingTokenCreated}</strong><p>{t.trackingTokenHint}</p>
        <button className="secondary" disabled={!issuedToken} onClick={()=>{void run(async()=>{await navigator.clipboard.writeText(issuedToken);setTokenVisible(true);});}}>{t.trackingCopyToken}</button>
        {tokenVisible&&<span>{t.trackingTokenCopied}</span>}</>:
        <p>{t.trackingManualSaved}</p>}
        <button className="text-button" onClick={()=>{setIssuedToken(null);setSaved(false);setTokenVisible(false);}}>{t.close}</button>
      </div>}
   </details>}
   <div className="market-grid">{trackers.items.map(item=><article className="record-card" key={item.id}>
     <div className="split"><strong>{item.label}</strong><Badge value={label(t,'trackerState_'+item.location_state)}/></div>
     <p>{item.herd_name} · {item.animal_identifier??t.trackingRepresentative} · {label(t,'trackerProvider_'+item.provider)}</p>
     {item.latitude!==null&&item.longitude!==null?
       <><p><strong>{item.latitude.toFixed(5)}, {item.longitude.toFixed(5)}</strong> · ±{format(item.accuracy_m)} m</p>
         <p>{t.trackingObserved}: {format(item.observed_at)} · {item.quality?label(t,'trackerQuality_'+item.quality):t.trackingNoSource} · {t.trackingBattery} {format(item.battery_percent)}%</p>
         <a href={mapLink(item.latitude,item.longitude)} target="_blank" rel="noopener noreferrer">{t.trackingOpenMap}</a></>:
       <p className="muted">{t.trackingNoLocation}</p>}
     <button className="secondary" onClick={()=>setSelected(selected===item.id?null:item.id)}>{t.trackingHistory}</button>
     {manager&&item.status==='active'&&<button className="text-button" disabled={!online} onClick={()=>void change(prefix+'/trackers/'+item.id,{status:'paused'})}>{t.trackingPause}</button>}
     {manager&&item.status==='paused'&&<button className="text-button" disabled={!online} onClick={()=>void change(prefix+'/trackers/'+item.id,{status:'active'})}>{t.trackingResume}</button>}
     {manager&&item.status!=='revoked'&&<button className="text-button" disabled={!online} onClick={()=>{if(window.confirm(t.trackingRevokeConfirm))void change(prefix+'/trackers/'+item.id,{status:'revoked'});}}>{t.trackingRevoke}</button>}
     {selected===item.id&&<section aria-label={t.trackingHistory}>{history.items.map(p=><p key={p.id}>{p.observed_at}: {p.latitude.toFixed(5)}, {p.longitude.toFixed(5)} · {label(t,'trackerQuality_'+p.quality)}</p>)}{!history.items.length&&<p>{t.trackingNoObservations}</p>}</section>}
   </article>)}</div>
   {!trackers.items.length&&<Empty title={t.trackingEmpty} text={t.trackingEmptyHint}/>}
   {manager&&<details><summary>{t.trackingBoundarySummary}</summary>
     <Form onSubmit={async(f,form)=>{const ok=await run(async()=>{
         await call(prefix+'/geofences',jsonBody({id:crypto.randomUUID(),name:formValue(f,'name'),projectId:formValue(f,'projectId')||null,latitude:formNumber(f,'latitude'),longitude:formNumber(f,'longitude'),radiusMeters:formNumber(f,'radiusMeters')}));
         await fences.reload();
       },t.saved);if(ok)form.reset();}}>
       <Field label={t.trackingAreaName}><input name="name" required maxLength={100}/></Field>
       <Field label={t.trackingGroup}><select name="projectId"><option value="">{t.trackingAllAnimals}</option>{animalProjects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
       <div className="field-row"><Field label={t.trackingLatitude}><input name="latitude" type="number" min="-90" max="90" step="any" required/></Field><Field label={t.trackingLongitude}><input name="longitude" type="number" min="-180" max="180" step="any" required/></Field></div>
       <Field label={t.trackingRadius}><input name="radiusMeters" type="number" min="30" max="50000" step="1" required/></Field>
       <Submit>{t.trackingBoundaryAdd}</Submit>
     </Form>
   </details>}
   {fences.items.map(f=><div key={f.id} className="list-row"><strong>{f.name}</strong><span>{f.radius_m} m · {f.active?t.trackerStatus_active:t.trackerStatus_paused}</span>
     {manager&&<button className="text-button" disabled={!online} onClick={()=>void change(prefix+'/geofences/'+f.id,{active:!f.active})}>{f.active?t.trackingBoundaryPause:t.trackingBoundaryEnable}</button>}
   </div>)}
   {alerts.items.length>0&&<section aria-label={t.trackingAlerts}><h3>{t.trackingAlerts}</h3>{alerts.items.map(a=><article className="record-card" key={a.id}>
     <strong>{a.kind==='outside_geofence'?t.trackingOutside:t.trackingLowBattery} · {a.tracker_label}</strong><p>{a.geofence_name??''} · {a.opened_at} · {label(t,'trackerStatus_'+a.status)}</p>
     {manager&&a.status==='open'&&<button className="secondary" disabled={!online} onClick={()=>void run(async()=>{await call(prefix+'/tracker-alerts/'+a.id+'/acknowledge',jsonBody({}));await alerts.reload();},t.saved)}>{t.trackingAcknowledge}</button>}
   </article>)}</section>}
   <button className="secondary" disabled={!online} onClick={()=>void run(reload)}>{t.trackingRefresh}</button>
 </Section>;
}
