import {useEffect,useState} from 'react';

type Observation = {
  gatewayId:string; sourceId:string; eventId:string; kind:'measurement'|'equipment_status';
  observedAt:string; receivedAt:string;
  payload:{data: {assetId:string; metric?:string; value?:number; unit?:string; state?:string}};
};
type Result = {items:Observation[];evidence:string;commandCapability:boolean};

export function EquipmentObservations({farmId,session,lang}:{
  farmId:string;session:string;lang:'sn'|'nd'
}){
  const [state,setState]=useState<{
    farmId:string;status:'loading'|'ready'|'error';items:Observation[]
  }>({farmId:'',status:'loading',items:[]});
  useEffect(()=>{
    if(!farmId || !session)return;
    const controller=new AbortController();
    setState({farmId,status:'loading',items:[]});
    void fetch((import.meta.env.VITE_API_URL || 'http://localhost:3000')+
      '/v1/farms/'+encodeURIComponent(farmId)+'/equipment/observations',{
      headers:{Authorization:'Bearer '+session},signal:controller.signal
    }).then(async response=>{
      if(!response.ok)throw new Error('observations unavailable');
      const body=await response.json() as Result;
      if(!controller.signal.aborted)setState({
        farmId,status:'ready',items:body.items||[]
      });
    }).catch(()=>{
      if(!controller.signal.aborted)setState({farmId,status:'error',items:[]});
    });
    return ()=>controller.abort();
  },[farmId,session]);
  const current=state.farmId===farmId?state:{farmId,status:'loading',items:[]};
  const text=lang==='sn'?{
    title:'Midziyo nemasensa',
    loading:'Kumirira zvakaonekwa…',
    error:'Hatina kukwanisa kutora zvakaonekwa.',
    empty:'Hapana zvakaonekwa zvabva kumidziyo.',
    caution:'Hapana chiyero chasimbiswa nemunhu ane mvumo.'
  }:{
    title:'Imitshina lezinzwa',
    loading:'Kulindelwe okubonakeleyo…',
    error:'Okubonakeleyo akutholakali.',
    empty:'Akula okubikiweyo yimishini.',
    caution:'Okubikiweyo akukaqinisekiswa ngokuhlolwa kwemishini.'
  };
  return <section className="card" aria-label={text.title}>
    <h2>{text.title}</h2>
    <p className="muted">{text.caution}</p>
    {current.status==='loading' && <p role="status">{text.loading}</p>}
    {current.status==='error' && <p role="alert">{text.error}</p>}
    {current.status==='ready' && !current.items.length && <p className="muted">{text.empty}</p>}
    {current.status==='ready' && <ul className="observations">
      {current.items.slice(0,8).map(item=><li key={item.eventId}>
        <strong>{item.payload.data.assetId}</strong>
        <span>{' · '+item.sourceId}</span>
        <p>{item.kind==='measurement'
          ? [item.payload.data.metric, item.payload.data.value, item.payload.data.unit].join(' ')
          : item.payload.data.state}</p>
        <small>{new Intl.DateTimeFormat(lang==='sn'?'sn-ZW':'nd-ZW',{
          dateStyle:'medium',timeStyle:'short',timeZone:'Africa/Harare'
        }).format(new Date(item.observedAt))}</small>
      </li>)}
    </ul>}
  </section>;
}
