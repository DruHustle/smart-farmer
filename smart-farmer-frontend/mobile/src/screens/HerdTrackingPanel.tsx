import React, {useState} from 'react';
import {Linking, Share, Text, View} from 'react-native';
import {allPages, object, string, type Row} from '../product';
import {c, Form, farmPath, numericField, selectField, textField, usePanel} from '../completion-ui';
import {Button, Card, Notice, styles} from '../ui';
import type {Workspace} from '../use-workspace';
import type {Language} from '../types';

const providerValues=['gnss_cellular','gnss_lorawan','gnss_satellite','demo','manual_reference'];
const decimal=(value:unknown)=>typeof value==='number'?value:Number(value);
export function HerdTrackingPanel({work,language}:{work:Workspace;language:Language}) {
 const [selected,setSelected]=useState('');
 const [token,setToken]=useState('');
 const providerOptions=providerValues.map(value=>({value,label:c(language,'trackerProvider_'+value)}));
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
   <Card title={c(language,'trackingTitle')}>
     <Notice text={c(language,'trackingPrivacy')}/>
     <Button secondary title={c(language,'trackingRefresh')} disabled={!work.online} busy={data.loading} onPress={()=>void data.reload()}/>
     {(data.value?.trackers??[]).map(row=><View key={string(row.id)} style={styles.item}>
       <Text style={styles.heading}>{string(row.label)}</Text>
       <Text style={styles.muted}>{string(row.herd_name)} · {row.animal_identifier?string(row.animal_identifier):c(language,'trackingRepresentative')} · {c(language,'trackerProvider_'+string(row.provider))}</Text>
       <Text style={styles.caption}>{c(language,'trackerState_'+string(row.location_state))} · {row.quality?c(language,'trackerQuality_'+string(row.quality)):c(language,'trackingNoSource')} · {row.observed_at?string(row.observed_at):c(language,'trackingNoObserved')}</Text>
       {row.latitude!==null&&row.longitude!==null&&row.latitude!==undefined&&row.longitude!==undefined?
         <><Text style={styles.text}>{decimal(row.latitude).toFixed(5)}, {decimal(row.longitude).toFixed(5)} · ±{string(row.accuracy_m)||'—'} m · {string(row.battery_percent)||'—'}% {c(language,'trackingBattery')}</Text>
         <Button secondary title={c(language,'trackingOpenMap')} onPress={()=>map(row)}/></>:
         <Text style={styles.muted}>{c(language,'trackingNoLocation')}</Text>}
       <Button secondary title={selected===row.id?c(language,'trackingHideHistory'):c(language,'trackingHistory')} onPress={()=>setSelected(selected===row.id?'':string(row.id))}/>
       {selected===row.id&&(history.value??[]).map(point=><Text key={string(point.id)} style={styles.caption}>{string(point.observed_at)}: {decimal(point.latitude).toFixed(5)}, {decimal(point.longitude).toFixed(5)} · {c(language,'trackerQuality_'+string(point.quality))}</Text>)}
       {manage&&row.status==='active'&&<Button secondary title={c(language,'trackingPause')} onPress={()=>void action(farmPath(work,'/trackers/'+row.id),'PATCH',{status:'paused'})}/>}
       {manage&&row.status==='paused'&&<Button secondary title={c(language,'trackingResume')} onPress={()=>void action(farmPath(work,'/trackers/'+row.id),'PATCH',{status:'active'})}/>}
     </View>)}
     {!data.value?.trackers?.length&&<Text style={styles.muted}>{c(language,'trackingEmpty')}</Text>}
     {work.canManage&&groups.length>0?<Form work={work} language={language} title={c(language,'trackingRegister')} hint={c(language,'trackingAnimalHint')} fields={[
       selectField('projectId',groups.map(g=>({value:g.id,label:g.name})),true),
       textField('label',true,{label:c(language,'trackingTagLabel')}),selectField('provider',providerOptions,true),textField('externalId',true),
       textField('animalId',false,{label:c(language,'trackingAnimalId')})
     ]} initial={{provider:'gnss_cellular'}} submit={body=>work.api.request(farmPath(work,'/trackers'),'POST',{...body,animalId:body.animalId||null})}
     onSaved={async result=>{setToken(string(object(result).ingestToken));await data.reload();}}/>:null}
     {token?<Card title={c(language,'trackingTokenTitle')}><Text style={styles.caption}>{c(language,'trackingTokenHint')}</Text>
       <Text selectable style={styles.caption}>{token}</Text>
       <Button secondary title={c(language,'trackingShareToken')} onPress={()=>{void Share.share({message:token}).catch(work.setError);}}/>
       <Button title={c(language,'trackingClearToken')} onPress={()=>setToken('')}/>
     </Card>:null}
   </Card>
   <Card title={c(language,'trackingBoundaryTitle')}>
     {(data.value?.geofences??[]).map(item=><View key={string(item.id)} style={styles.item}>
       <Text style={styles.text}>{string(item.name)} · {string(item.radius_m)} m</Text>
       <Text style={styles.caption}>{item.active?c(language,'trackerStatus_active'):c(language,'trackerStatus_paused')} · {string(item.latitude)}, {string(item.longitude)}</Text>
       {manage&&<Button secondary title={item.active?c(language,'trackingBoundaryPause'):c(language,'trackingBoundaryEnable')} onPress={()=>void action(farmPath(work,'/geofences/'+item.id),'PATCH',{active:!item.active})}/>}
     </View>)}
     {work.canManage&&<Form work={work} language={language} title={c(language,'trackingBoundaryAdd')} fields={[
       textField('name',true),
       selectField('projectId',[{value:'',label:c(language,'trackingAllAnimals')},...groups.map(g=>({value:g.id,label:g.name}))]),
       numericField('latitude',true,{minimum:-90,maximum:90,label:c(language,'trackingLatitude')}),
       numericField('longitude',true,{minimum:-180,maximum:180,label:c(language,'trackingLongitude')}),
       numericField('radiusMeters',true,{minimum:30,maximum:50000,label:c(language,'trackingRadius')})
     ]} submit={body=>work.api.request(farmPath(work,'/geofences'),'POST',{...body,projectId:body.projectId||null})} onSaved={data.reload}/>}
   </Card>
   <Card title={c(language,'trackingAlerts')}>
     {(data.value?.alerts??[]).map(item=><View key={string(item.id)} style={styles.item}>
       <Text style={styles.heading}>{item.kind==='outside_geofence'?c(language,'trackingOutside'):c(language,'trackingLowBattery')}</Text>
       <Text style={styles.text}>{string(item.tracker_label)} · {string(item.geofence_name)||c(language,'trackingGeneral')}</Text>
       <Text style={styles.caption}>{string(item.opened_at)} · {c(language,'trackerStatus_'+string(item.status))}</Text>
       {manage&&item.status==='open'&&<Button secondary title={c(language,'trackingAcknowledge')} onPress={()=>void action(farmPath(work,'/tracker-alerts/'+item.id+'/acknowledge'),'POST',{})}/>}
     </View>)}
     {!data.value?.alerts?.length&&<Text style={styles.muted}>{c(language,'trackingNoAlerts')}</Text>}
   </Card>
 </View>;
}
