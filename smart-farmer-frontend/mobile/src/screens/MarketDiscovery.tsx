import React from 'react';
import {Text, View} from 'react-native';
import {allPages, string, type Row} from '../product';
import {Form, numericField, selectField, textField, usePanel} from '../completion-ui';
import {Button, Card, styles} from '../ui';
import type {Workspace} from '../use-workspace';
import type {Language} from '../types';

const categories=['produce','input','animal','equipment','other'];
export function MarketDiscoveryPanel({work,language,onListing}:{work:Workspace;language:Language;onListing:(item:Row)=>void}) {
 const data=usePanel(work,'market-discovery',async()=>{
   const [saved,favorites,follows,alerts]=await Promise.all([
     allPages<Row>(work.api,'/v1/market/saved-searches'),
     allPages<Row>(work.api,'/v1/market/favorites'),
     allPages<Row>(work.api,'/v1/market/follows'),
     allPages<Row>(work.api,'/v1/market/alerts')
   ]);
   return {saved,favorites,follows,alerts};
 });
 async function modify(path:string,method:string,body?:unknown){
   try {await work.api.request(path,method,body);await data.reload();}
   catch(e){work.setError(e);}
 }
 return <View style={{gap:14}}>
   <Card title="Saved searches">
     <Text style={styles.muted}>Save a local agricultural search and get in-app alerts when new items match. Push notifications will require a configured delivery provider.</Text>
     <Form work={work} language={language} title="Save a search" fields={[
       textField('query',false,{label:'Search words'}),
       selectField('category',[{value:'',label:'All categories'},...categories.map(v=>({value:v,label:v}))]),
       textField('area',false,{label:'Area or town'}),
       textField('currency',false,{label:'Currency (e.g. USD)',maxLength:3}),
       numericField('minPrice',false,{minimum:0}),
       numericField('maxPrice',false,{minimum:0}),
       textField('condition',false,{label:'Condition'})
     ]} submit={body=>work.api.request('/v1/market/saved-searches','POST',{
       ...body,category:body.category||null,currency:body.currency?String(body.currency).toUpperCase():null,
       minPrice:body.minPrice??null,maxPrice:body.maxPrice??null,condition:body.condition||'',notify:true
     })} onSaved={data.reload}/>
     {(data.value?.saved??[]).map(x=><View key={string(x.id)} style={styles.item}>
       <Text style={styles.text}>{string(x.query)||string(x.category)||string(x.area)}</Text>
       <Text style={styles.caption}>{string(x.area)} · {string(x.currency)} · {x.notify?'Alerts on':'Alerts paused'}</Text>
       <Button secondary title={x.notify?'Pause alerts':'Resume alerts'} disabled={!work.online} onPress={()=>void modify('/v1/market/saved-searches/'+x.id,'PATCH',{notify:!x.notify})}/>
       <Button secondary title="Remove saved search" disabled={!work.online} onPress={()=>void modify('/v1/market/saved-searches/'+x.id,'DELETE')}/>
     </View>)}
     {!data.value?.saved?.length&&<Text style={styles.muted}>No searches saved.</Text>}
   </Card>
   <Card title={language==='nd'?'Okugciniweyo · Saved listings':'Zvakachengetwa · Saved listings'}>
     {(data.value?.favorites??[]).map(x=><View key={string(x.id)} style={styles.item}>
       <Text style={styles.heading}>{string(x.title)}</Text>
       <Text style={styles.caption}>{string(x.price)} {string(x.currency)} · {string(x.collection_area)}</Text>
       <Button title="Open listing" onPress={()=>onListing(x)}/>
       <Button secondary title="Remove saved listing" disabled={!work.online} onPress={()=>void modify('/v1/market/favorites/'+x.id,'DELETE')}/>
     </View>)}
     {!data.value?.favorites?.length&&<Text style={styles.muted}>Save a listing to see it here.</Text>}
   </Card>
   <Card title="Followed sellers">
     {(data.value?.follows??[]).map(x=><View key={string(x.id)} style={styles.item}>
       <Text style={styles.text}>{string(x.seller_name)}</Text>
       <Text style={styles.caption}>{string(x.listings)} active listings</Text>
       <Button secondary title="Unfollow" disabled={!work.online} onPress={()=>void modify('/v1/market/follows/'+x.id,'DELETE')}/>
     </View>)}
     {!data.value?.follows?.length&&<Text style={styles.muted}>Follow a seller from a listing.</Text>}
   </Card>
   <Card title="New listing alerts">
     {(data.value?.alerts??[]).map(x=><View key={string(x.id)} style={styles.item}>
       <Text style={styles.heading}>{string(x.title)}</Text>
       <Text style={styles.caption}>{x.kind==='saved_search'?'Saved search match':'Followed seller'} · {string(x.seller_name)} · {string(x.price)} {string(x.currency)}</Text>
       {x.read_at?<Text style={styles.caption}>Read</Text>:<Button secondary title="Mark read" onPress={()=>void modify('/v1/market/alerts/'+x.id+'/read','POST',{})}/>}
       <Button secondary title="Open listing" onPress={()=>{void work.api.request<Row>('/v1/market/listings/'+x.listing_id).then(onListing).catch(work.setError);}}/>
     </View>)}
     {!data.value?.alerts?.length&&<Text style={styles.muted}>Matching new listings will appear here.</Text>}
     <Button secondary title="Refresh" busy={data.loading} disabled={!work.online} onPress={()=>void data.reload()}/>
   </Card>
 </View>;
}
