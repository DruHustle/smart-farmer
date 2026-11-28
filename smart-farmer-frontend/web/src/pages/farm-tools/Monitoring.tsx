import {useState} from 'react';
import {useFarm} from '../../context';
import {farmToolWords} from '../../farm-tools-locales';
import {useList,useResource} from '../../lib/resources';
import {jsonBody} from '../../lib/api';
import {displayDate,displayNumber,displayTime} from '../../lib/time';
import {forecastDays,sensorRuleSource,weatherMetrics,type Monitoring,type Sensor,type WeatherMetric} from '../../lib/monitoring';
import {ActionForm,DataTable,MoreButton,ResourceState,text,type Row} from '../../components/completion';
import {Badge,Empty,ExpandForm,Field,Section,formValue} from '../../components/ui';
import {ToolHeading} from './shared';

export function ForecastSummary({hourly}:{hourly:Record<string,unknown>}) {
  const {farm,lang,t}=useFarm();const days=forecastDays(hourly,farm.timezone);
  return <div className="tool-forecast-grid">{days.map(day=><article className="tool-metric" key={day.date}><h3>{displayDate(day.date,lang)}</h3><strong>{displayNumber(day.min,lang,1)}–{displayNumber(day.max,lang,1)} °C</strong><p>{t.rain}: {displayNumber(day.rain,lang,1)} mm</p><small>{day.hours} h · {t.forecast}</small></article>)}</div>;
}
export function WeatherAlerts(){
  return <AlertRules weather/>;
}
export function Sensors(){
  const {farm,lang,t,navigate}=useFarm();const w=farmToolWords(lang);
  const resource=useResource<Monitoring>(`/v1/farms/${farm.id}/monitoring`,{sensors:[],gateways:[],commandCapability:false});
  return <><ToolHeading name="sensors" intro="monitoringIntro"/>
    <Section title={w.sensors} action={<button className="secondary" onClick={()=>navigate('equipment')}>{t.equipment}</button>}><ResourceState {...resource}/>{resource.value.truncated&&<p className="notice warning">{t.limitedSync}</p>}<div className="tool-card-grid">{resource.value.sensors.map(sensor=><SensorCard key={sensor.key} sensor={sensor}/>)}</div>{!resource.loading&&!resource.value.sensors.length&&<Empty title={w.noSensors} text={w.noSensorsHint}/>}</Section>
    <Section title={w.gateways}><div className="tool-card-grid">{resource.value.gateways.map(gateway=><article key={gateway.id} className="tool-card"><div className="split"><h3>{gateway.id}</h3><Badge value={gateway.state==='online'?t.connected:gateway.state==='offline'?t.offline:t.unknown} tone={gateway.state==='offline'?'warning':''}/></div><dl className="facts-grid"><div><dt>{w.battery}</dt><dd>{gateway.batteryPercent===null?t.unknown:`${displayNumber(gateway.batteryPercent,lang,0)}%`}</dd></div><div><dt>{w.dataUsage}</dt><dd>{gateway.dataUsageMb===null?t.unknown:`${displayNumber(gateway.dataUsageMb,lang,2)} MB`}</dd></div><div><dt>{t.lastUpdated}</dt><dd>{displayTime(gateway.lastReceivedAt??'',lang,farm.timezone)}</dd></div></dl></article>)}</div>{!resource.loading&&!resource.value.gateways.length&&<Empty title={t.noData}/>}</Section>
    <AlertRules sensors={resource.value.sensors}/><RecentAlerts/>
  </>;
}
function SensorCard({sensor}:{sensor:Sensor}){
  const {farm,lang,t}=useFarm();const w=farmToolWords(lang);const trusted=sensor.quality==='good'&&!sensor.simulated&&sensor.commissioned;
  return <article className="tool-card"><div className="split"><h3>{sensor.name}</h3><Badge value={sensor.simulated?t.simulated:sensor.stale?t.stale:trusted?t.fresh:w.untrusted} tone={sensor.stale||!trusted?'warning':''}/></div><p className="tool-reading">{displayNumber(sensor.value,lang)} <span>{sensor.unit}</span></p><p>{sensor.metric}</p><p className="muted">{t.source}: {sensor.source==='edge'?sensor.gatewayId:sensor.name}</p><p className="muted">{displayTime(sensor.observedAt??'',lang,farm.timezone)}</p>
    {sensor.history.length>0&&<details><summary>{w.history}</summary><DataTable title={w.history} items={sensor.history} columns={[{key:'observedAt',title:t.when,format:'time'},{key:'value',title:`${sensor.metric} (${sensor.unit})`,format:'number'}]}/></details>}
  </article>;
}
function AlertRules({weather=false,sensors=[]}:{weather?:boolean;sensors?:Sensor[]}){
  const {farm,lang,t,manager,online,run,call,navigate}=useFarm();const w=farmToolWords(lang),base=`/v1/farms/${farm.id}/monitoring/rules`;
  const list=useList<Row>(base),[sensorKey,setSensorKey]=useState(''),[metric,setMetric]=useState<WeatherMetric>('temperature_2m');
  const sensor=sensors.find(item=>item.key===sensorKey),visible=list.items.filter(rule=>weather?rule.source==='weather':rule.source!=='weather');
  const metricNames={temperature_2m:w.temperatureC,precipitation:w.rainHourly,wind_speed_10m:w.wind,relative_humidity_2m:w.humidity};
  return <Section title={weather?w.forecastRules:w.sensorRules}><p className="muted">{w.ruleHint}</p><p>{w.channelHint}</p><button className="text-button" onClick={()=>navigate('notifications')}>{w.configureChannels}</button><ResourceState {...list}/>
    {manager&&<ExpandForm title={w.newRule}><ActionForm path={base} after={list.reload} build={(f,id)=>{if(!weather&&!sensor)throw new Error('invalid_input');return{id,name:formValue(f,'name'),...(weather?{source:'weather',metric,unit:weatherMetrics[metric]}:sensorRuleSource(sensor!)),operator:formValue(f,'operator'),threshold:Number(f.get('threshold')),cooldownMinutes:Number(f.get('cooldownMinutes')),enabled:true,...(weather?{lookaheadHours:Number(f.get('lookaheadHours'))}:{staleAfterSeconds:Number(f.get('staleAfterSeconds'))})};}}>
      <Field label={t.title}><input name="name" required maxLength={120}/></Field>{weather?<Field label={w.metric}><select name="metric" value={metric} onChange={e=>setMetric(e.target.value as WeatherMetric)}>{Object.keys(weatherMetrics).map(key=><option key={key} value={key}>{metricNames[key as WeatherMetric]}</option>)}</select></Field>:<Field label={w.selectSensor}><select name="sensor" value={sensorKey} required onChange={e=>setSensorKey(e.target.value)}><option value="">{t.none}</option>{sensors.map(item=><option key={item.key} value={item.key}>{item.name} · {item.metric} ({item.unit})</option>)}</select></Field>}
      <div className="field-row"><Field label={w.operator}><select name="operator"><option value="below">{w.below}</option><option value="above">{w.above}</option></select></Field><Field label={`${w.threshold} (${weather?weatherMetrics[metric]:sensor?.unit??'—'})`}><input name="threshold" type="number" step="any" required/></Field></div>
      {weather?<Field label={w.lookahead}><input name="lookaheadHours" type="number" min="1" max="72" step="1" required defaultValue="24"/></Field>:<Field label={w.freshness}><input key={sensorKey} name="staleAfterSeconds" type="number" min="10" max="86400" step="1" required defaultValue={sensor?.staleAfterSeconds??900}/></Field>}<Field label={w.cooldown}><input name="cooldownMinutes" type="number" min="1" max="10080" step="1" required defaultValue="360"/></Field>
    </ActionForm></ExpandForm>}
    {visible.map(rule=><article className="record-card" key={rule.id}><div className="split"><h3>{text(rule.name)}</h3><Badge value={rule.enabled?w.enabled:w.paused}/></div><p>{text(rule.metric)} {rule.operator==='below'?w.below:w.above} {displayNumber(rule.threshold,lang)} {text(rule.unit)}</p>{Boolean(rule.last_triggered_at)&&<p className="muted">{displayTime(text(rule.last_triggered_at),lang,farm.timezone)}</p>}{manager&&<button className="secondary" disabled={!online} onClick={()=>void run(async()=>{await call(`${base}/${rule.id}`,jsonBody({version:rule.version,enabled:!rule.enabled},'PATCH'));await list.reload();})}>{rule.enabled?w.pause:w.enable}</button>}</article>)}<MoreButton {...list}/>
  </Section>;
}
export function RecentAlerts(){
  const {farm,lang,t}=useFarm();const w=farmToolWords(lang),list=useList<Row>(`/v1/farms/${farm.id}/monitoring/alerts`);
  return <Section title={w.recentAlerts}><ResourceState {...list}/>{list.items.map(alert=><article className="record-card" key={alert.id}><h3>{text(alert.rule_name)}</h3><p>{text(alert.metric)}: {displayNumber(alert.value,lang)} {text(alert.unit)}</p><p>{displayTime(text(alert.observed_at),lang,farm.timezone)}</p></article>)}{!list.loading&&!list.items.length&&<Empty title={t.noData}/>}<MoreButton {...list}/></Section>;
}
