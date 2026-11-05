import React, {useState} from 'react';
import {Linking, Share, Text, View} from 'react-native';
import {allPages, object, string, type Row} from '../product';
import {Form, farmPath, numericField, selectField, textField, usePanel, options} from '../completion-ui';
import {Button, Card, Notice, styles} from '../ui';
import type {Workspace} from '../use-workspace';
import type {Language} from '../types';
import {textFor} from '../i18n';

const providerOptions=[
 {value:'gnss_cellular',label:'GPS cellular'},
 {value:'gnss_lorawan',label:'GPS LoRaWAN'},
 {value:'gnss_satellite',label:'GPS satellite'},
 {value:'demo',label:'Demonstration only'},
 {value:'manual_reference',label:'AirTag · manual Find My reference'}
];
const decimal=(value:unknown)=>typeof value==='number'?value:Number(value);
export function HerdTrackingPanel({work,language}:{work:Workspace;language:Language}) {
 const [selected,setSelected]=useState('');
 const [token,setToken]=useState('');
 const t=textFor(language);
 const data=usePanel(work,'livestock-tracking',async()=>{
   const [trackers,geofences,alerts]=await Promise.all([
     allPages<Row>(work.api,farmPath(work,'/trackers')),
     allPages<Row>(work.api,farmPath(work,'/geofences')),
     allPages<Row>(work.api,farmPath(work,'/tracker-alerts'))
   ]);
   return {trackers,geofences,alerts};
 });
 const history=usePanel(work,'tracker-history:'+selected,()=>selected?allPages<Row>(work.api,farmPath(work,'/trackers/'+selected+'/history')):Promise.resolve([]));
 const groups=(work.snapshot?.projects??[]).filter(p=>p.enterprise_type!=='crop'&&p.status==='active');
 const manage=work.canManage&&work.online;
 async function action(path:string,method:string,body?:unknown) {
   try {
     await work.api.request(path,method,body);
     await data.reload(); await work.refresh();
   }catch(error){work.setError(error);}
 }
 const map=(row:Row)=>{
   const lat=decimal(row.latitude),lon=decimal(row.longitude);
   if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
   const url='https://www.openstreetmap.org/?mlat='+encodeURIComponent(lat)+'&mlon='+encodeURIComponent(lon)+'#map=15/'+encodeURIComponent(lat)+'/'+encodeURIComponent(lon);
   void Linking.openURL(url).catch(work.setError);
 };
 return <View style={{gap:14}}>
   <Card title={language==='nd'?'Ukulandelela umhlambi · Herd tracking':'Kutevera mombe · Herd tracking'}>
     <Notice text="A tracker attached to one animal shows that animal, not the entire herd. GPS observations are private to this farm. Recent means under 30 minutes old; a stale or simulated fix is not current proof. AirTag references do not supply live positions."/>
     <Button secondary title="Refresh positions" disabled={!work.online} busy={data.loading} onPress={()=>void data.reload()}/>
     {(data.value?.trackers??[]).map(row=><View key={string(row.id)} style={styles.item}>
       <Text style={styles.heading}>{string(row.label)}</Text>
       <Text style={styles.muted}>{string(row.herd_name)} · {row.animal_identifier?string(row.animal_identifier):'One herd representative'} · {string(row.provider)}</Text>
       <Text style={styles.caption}>{string(row.location_state)} · {row.quality?string(row.quality):'No source verified'} · {row.observed_at?string(row.observed_at):'No observed position'}</Text>
       {row.latitude!==null&&row.longitude!==null&&row.latitude!==undefined&&row.longitude!==undefined?
         <><Text style={styles.text}>{decimal(row.latitude).toFixed(5)}, {decimal(row.longitude).toFixed(5)} · ±{string(row.accuracy_m)||'—'} m · {string(row.battery_percent)||'—'}% battery</Text>
         <Button secondary title="Open map (shares location with OpenStreetMap)" onPress={()=>map(row)}/></>:
         <Text style={styles.muted}>No location yet. Check the device and gateway.</Text>}
       <Button secondary title={selected===row.id?'Hide movement history':'Movement history'} onPress={()=>setSelected(selected===row.id?'':string(row.id))}/>
       {selected===row.id&&(history.value??[]).map(point=><Text key={string(point.id)} style={styles.caption}>{string(point.observed_at)}: {decimal(point.latitude).toFixed(5)}, {decimal(point.longitude).toFixed(5)} · {string(point.quality)}</Text>)}
       {manage&&row.status==='active'&&<Button secondary title="Pause tracker" onPress={()=>void action(farmPath(work,'/trackers/'+row.id),'PATCH',{status:'paused'})}/>}
       {manage&&row.status==='paused'&&<Button secondary title="Resume tracker" onPress={()=>void action(farmPath(work,'/trackers/'+row.id),'PATCH',{status:'active'})}/>}
     </View>)}
     {!data.value?.trackers?.length&&<Text style={styles.muted}>No GPS tags registered.</Text>}
     {work.canManage&&groups.length>0?<Form work={work} language={language} title="Register GPS collar / tag" hint="The optional animal ID must be from this group. Leave blank for one herd representative." fields={[
       selectField('projectId',groups.map(g=>({value:g.id,label:g.name})),true),
       textField('label',true),selectField('provider',providerOptions,true),textField('externalId',true),
       textField('animalId',false,{label:'Animal UUID (optional)'})
     ]} initial={{provider:'gnss_cellular'}} submit={body=>work.api.request(farmPath(work,'/trackers'),'POST',{...body,animalId:body.animalId||null})}
     onSaved={async result=>{setToken(string(object(result).ingestToken));await data.reload();}}/>:null}
     {token?<Card title="One-time device token"><Text style={styles.caption}>Only share this with your trusted edge gateway. The app does not save the credential.</Text>
       <Text selectable style={styles.caption}>{token}</Text>
       <Button secondary title="Share token securely" onPress={()=>{void Share.share({message:token}).catch(work.setError);}}/>
       <Button title="Dismiss and clear token" onPress={()=>setToken('')}/>
     </Card>:null}
   </Card>
   <Card title="Grazing boundaries">
     {(data.value?.geofences??[]).map(item=><View key={string(item.id)} style={styles.item}>
       <Text style={styles.text}>{string(item.name)} · {string(item.radius_m)} m</Text>
       <Text style={styles.caption}>{item.active?'Active':'Paused'} · {string(item.latitude)}, {string(item.longitude)}</Text>
       {manage&&<Button secondary title={item.active?'Pause boundary':'Enable boundary'} onPress={()=>void action(farmPath(work,'/geofences/'+item.id),'PATCH',{active:!item.active})}/>}
     </View>)}
     {work.canManage&&<Form work={work} language={language} title="Add grazing boundary" fields={[
       textField('name',true),
       selectField('projectId',[{value:'',label:'All herds'},...groups.map(g=>({value:g.id,label:g.name}))]),
       numericField('latitude',true,{minimum:-90,maximum:90}),
       numericField('longitude',true,{minimum:-180,maximum:180}),
       numericField('radiusMeters',true,{minimum:30,maximum:50000})
     ]} submit={body=>work.api.request(farmPath(work,'/geofences'),'POST',{...body,projectId:body.projectId||null})} onSaved={data.reload}/>}
   </Card>
   <Card title="Tracker alerts">
     {(data.value?.alerts??[]).map(item=><View key={string(item.id)} style={styles.item}>
       <Text style={styles.heading}>{item.kind==='outside_geofence'?'Outside grazing boundary':'Low battery'}</Text>
       <Text style={styles.text}>{string(item.tracker_label)} · {string(item.geofence_name)||'General'}</Text>
       <Text style={styles.caption}>{string(item.opened_at)} · {string(item.status)}</Text>
       {manage&&item.status==='open'&&<Button secondary title="Acknowledge" onPress={()=>void action(farmPath(work,'/tracker-alerts/'+item.id+'/acknowledge'),'POST',{})}/>}
     </View>)}
     {!data.value?.alerts?.length&&<Text style={styles.muted}>No active alerts. This is not proof that every tracker is online.</Text>}
   </Card>
 </View>;
}
