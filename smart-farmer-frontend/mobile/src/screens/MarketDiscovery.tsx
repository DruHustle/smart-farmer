import React from 'react';
import {Text, View} from 'react-native';
import {allPages, string, type Row} from '../product';
import {c, Form, numericField, options, selectField, textField, usePanel} from '../completion-ui';
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
   <Card title={c(language,'marketSavedSearches')}>
     <Text style={styles.muted}>{c(language,'marketSearchHint')}</Text>
     <Form work={work} language={language} title={c(language,'marketSaveSearch')} fields={[
       textField('query',false,{label:c(language,'marketSearchWords')}),
       selectField('category',[{value:'',label:c(language,'marketAllCategories')},...options(language,categories)]),
       textField('area',false,{label:c(language,'collectionArea')}),
       textField('currency',false,{label:c(language,'marketCurrencyHint'),maxLength:3}),
       numericField('minPrice',false,{minimum:0}),
       numericField('maxPrice',false,{minimum:0}),
       textField('condition',false,{label:c(language,'condition')})
     ]} submit={body=>work.api.request('/v1/market/saved-searches','POST',{
       ...body,category:body.category||null,currency:body.currency?String(body.currency).toUpperCase():null,
       minPrice:body.minPrice??null,maxPrice:body.maxPrice??null,condition:body.condition||'',notify:true
     })} onSaved={data.reload}/>
     {(data.value?.saved??[]).map(x=><View key={string(x.id)} style={styles.item}>
       <Text style={styles.text}>{string(x.query)||(x.category?c(language,string(x.category)):string(x.area))}</Text>
       <Text style={styles.caption}>{string(x.area)} · {string(x.currency)} · {x.notify?c(language,'marketAlertsOn'):c(language,'marketAlertsPaused')}</Text>
       <Button secondary title={x.notify?c(language,'marketPauseAlerts'):c(language,'marketResumeAlerts')} disabled={!work.online} onPress={()=>void modify('/v1/market/saved-searches/'+x.id,'PATCH',{notify:!x.notify})}/>
       <Button secondary title={c(language,'marketRemoveSearch')} disabled={!work.online} onPress={()=>void modify('/v1/market/saved-searches/'+x.id,'DELETE')}/>
     </View>)}
     {!data.value?.saved?.length&&<Text style={styles.muted}>{c(language,'marketNoSearches')}</Text>}
   </Card>
   <Card title={c(language,'marketSavedListings')}>
     {(data.value?.favorites??[]).map(x=><View key={string(x.id)} style={styles.item}>
       <Text style={styles.heading}>{string(x.title)}</Text>
       <Text style={styles.caption}>{string(x.price)} {string(x.currency)} · {string(x.collection_area)}</Text>
       <Button title={c(language,'marketOpenListing')} onPress={()=>onListing(x)}/>
       <Button secondary title={c(language,'marketRemoveSaved')} disabled={!work.online} onPress={()=>void modify('/v1/market/favorites/'+x.id,'DELETE')}/>
     </View>)}
     {!data.value?.favorites?.length&&<Text style={styles.muted}>{c(language,'marketNoSaved')}</Text>}
   </Card>
   <Card title={c(language,'marketFollowedSellers')}>
     {(data.value?.follows??[]).map(x=><View key={string(x.id)} style={styles.item}>
       <Text style={styles.text}>{string(x.seller_name)}</Text>
       <Text style={styles.caption}>{string(x.listings)} · {c(language,'marketActiveListings')}</Text>
       <Button secondary title={c(language,'marketUnfollow')} disabled={!work.online} onPress={()=>void modify('/v1/market/follows/'+x.id,'DELETE')}/>
     </View>)}
     {!data.value?.follows?.length&&<Text style={styles.muted}>{c(language,'marketNoFollowed')}</Text>}
   </Card>
   <Card title={c(language,'marketNewAlerts')}>
     {(data.value?.alerts??[]).map(x=><View key={string(x.id)} style={styles.item}>
       <Text style={styles.heading}>{string(x.title)}</Text>
       <Text style={styles.caption}>{x.kind==='saved_search'?c(language,'marketSearchMatch'):c(language,'marketFollowedMatch')} · {string(x.seller_name)} · {string(x.price)} {string(x.currency)}</Text>
       {x.read_at?<Text style={styles.caption}>{c(language,'marketRead')}</Text>:<Button secondary title={c(language,'marketMarkRead')} onPress={()=>void modify('/v1/market/alerts/'+x.id+'/read','POST',{})}/>}
       <Button secondary title={c(language,'marketOpenListing')} onPress={()=>{void work.api.request<Row>('/v1/market/listings/'+x.listing_id).then(onListing).catch(work.setError);}}/>
     </View>)}
     {!data.value?.alerts?.length&&<Text style={styles.muted}>{c(language,'marketNoAlerts')}</Text>}
     <Button secondary title={c(language,'refresh')} busy={data.loading} disabled={!work.online} onPress={()=>void data.reload()}/>
   </Card>
 </View>;
}
