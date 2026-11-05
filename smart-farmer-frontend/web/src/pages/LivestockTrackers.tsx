import {useState} from 'react';
import {useFarm} from '../context';
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
 return <Section title="Herd tracking · GPS collars & ear tags">
   <p className="notice subtle">Private animal locations. A herd representative reports only its own position, not every animal. A recent fix is less than 30 minutes old; stale or simulated data is never proof of the herd's current position. Apple Find My references are manual only.</p>
   {manager&&animalProjects.length>0&&<details><summary>Register GPS collar / tag</summary>
      <Form onSubmit={async(f,form)=>{const ok=await run(async()=>{
         const response=await call<{ingestToken?:string}>(prefix+'/trackers',jsonBody({
           id:crypto.randomUUID(),projectId:formValue(f,'projectId'),animalId:formValue(f,'animalId')||null,
           label:formValue(f,'label'),provider:formValue(f,'provider'),externalId:formValue(f,'externalId')
         }));
         setIssuedToken(response.ingestToken??null);setSaved(true);await trackers.reload();
       },t.saved);if(ok)form.reset();}}>
        <Field label="Animal group"><select name="projectId" required>{animalProjects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Tag label"><input name="label" maxLength={120} required placeholder="Lead cow collar A1"/></Field>
        <Field label="Tracker type"><select name="provider" value={kind} onChange={e=>setKind(e.target.value)}>
          <option value="gnss_cellular">GPS · cellular</option><option value="gnss_lorawan">GPS · LoRaWAN</option>
          <option value="gnss_satellite">GPS · satellite</option><option value="demo">Demo only</option>
          <option value="manual_reference">AirTag / Find My reference only</option>
        </select></Field>
        <Field label="Hardware device ID"><input name="externalId" maxLength={120} required placeholder="Vendor device identifier"/></Field>
        <Field label="Animal identity UUID (optional)"><input name="animalId" pattern="[0-9a-fA-F-]{36}" placeholder="Leave blank for representative of herd"/></Field>
        <Submit>Register tracker</Submit>
      </Form>
      {saved&&<div className="notice" role="status">{issuedToken?
        <><strong>One-time ingestion credential generated.</strong><p>Store it only in the trusted edge gateway. It will not be shown again.</p>
        <button className="secondary" disabled={!issuedToken} onClick={()=>{void run(async()=>{await navigator.clipboard.writeText(issuedToken);setTokenVisible(true);});}}>Copy one-time token</button>
        {tokenVisible&&<span> Copied. Treat as a secret.</span>}</>:
        <p>Reference saved. No location connection is available for an AirTag.</p>}
        <button className="text-button" onClick={()=>{setIssuedToken(null);setSaved(false);setTokenVisible(false);}}>Dismiss</button>
      </div>}
   </details>}
   <div className="market-grid">{trackers.items.map(item=><article className="record-card" key={item.id}>
     <div className="split"><strong>{item.label}</strong><Badge value={item.location_state}/></div>
     <p>{item.herd_name} · {item.animal_identifier??'One herd representative'} · {item.provider}</p>
     {item.latitude!==null&&item.longitude!==null?
       <><p><strong>{item.latitude.toFixed(5)}, {item.longitude.toFixed(5)}</strong> · ±{format(item.accuracy_m)} m</p>
         <p>Observed: {format(item.observed_at)} · {format(item.quality)} · battery {format(item.battery_percent)}%</p>
         <a href={mapLink(item.latitude,item.longitude)} target="_blank" rel="noopener noreferrer">Open map (shares location with OpenStreetMap)</a></>:
       <p className="muted">No verified location reported.</p>}
     <button className="secondary" onClick={()=>setSelected(selected===item.id?null:item.id)}>Movement history</button>
     {manager&&item.status==='active'&&<button className="text-button" disabled={!online} onClick={()=>void change(prefix+'/trackers/'+item.id,{status:'paused'})}>Pause tracker</button>}
     {manager&&item.status==='paused'&&<button className="text-button" disabled={!online} onClick={()=>void change(prefix+'/trackers/'+item.id,{status:'active'})}>Resume tracker</button>}
     {manager&&item.status!=='revoked'&&<button className="text-button" disabled={!online} onClick={()=>{if(window.confirm('Revoke this device credential? This cannot be undone.'))void change(prefix+'/trackers/'+item.id,{status:'revoked'});}}>Revoke credential</button>}
     {selected===item.id&&<section aria-label="Movement history">{history.items.map(p=><p key={p.id}>{p.observed_at}: {p.latitude.toFixed(5)}, {p.longitude.toFixed(5)} · {p.quality}</p>)}{!history.items.length&&<p>No observations yet.</p>}</section>}
   </article>)}</div>
   {!trackers.items.length&&<Empty title="No livestock GPS trackers registered" text="Register a real GPS collar or a demo transmitter when the hardware is available."/>}
   {manager&&<details><summary>Grazing boundary / geofence</summary>
     <Form onSubmit={async(f,form)=>{const ok=await run(async()=>{
         await call(prefix+'/geofences',jsonBody({id:crypto.randomUUID(),name:formValue(f,'name'),projectId:formValue(f,'projectId')||null,latitude:formNumber(f,'latitude'),longitude:formNumber(f,'longitude'),radiusMeters:formNumber(f,'radiusMeters')}));
         await fences.reload();
       },t.saved);if(ok)form.reset();}}>
       <Field label="Area name"><input name="name" required maxLength={100}/></Field>
       <Field label="Animal group"><select name="projectId"><option value="">All animals</option>{animalProjects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
       <div className="field-row"><Field label="Centre latitude"><input name="latitude" type="number" min="-90" max="90" step="any" required/></Field><Field label="Centre longitude"><input name="longitude" type="number" min="-180" max="180" step="any" required/></Field></div>
       <Field label="Radius (metres)"><input name="radiusMeters" type="number" min="30" max="50000" step="1" required/></Field>
       <Submit>Add grazing boundary</Submit>
     </Form>
   </details>}
   {fences.items.map(f=><div key={f.id} className="list-row"><strong>{f.name}</strong><span>{f.radius_m} m · {f.active?'active':'paused'}</span>
     {manager&&<button className="text-button" disabled={!online} onClick={()=>void change(prefix+'/geofences/'+f.id,{active:!f.active})}>{f.active?'Pause':'Enable'}</button>}
   </div>)}
   {alerts.items.length>0&&<section aria-label="Tracker alerts"><h3>Tracker alerts</h3>{alerts.items.map(a=><article className="record-card" key={a.id}>
     <strong>{a.kind==='outside_geofence'?'Outside grazing boundary':'Low battery'} · {a.tracker_label}</strong><p>{a.geofence_name??''} · {a.opened_at} · {a.status}</p>
     {manager&&a.status==='open'&&<button className="secondary" disabled={!online} onClick={()=>void run(async()=>{await call(prefix+'/tracker-alerts/'+a.id+'/acknowledge',jsonBody({}));await alerts.reload();},t.saved)}>Acknowledge</button>}
   </article>)}</section>}
   <button className="secondary" disabled={!online} onClick={()=>void run(reload)}>Refresh tracker data</button>
 </Section>;
}
