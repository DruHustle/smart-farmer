export type Sensor = {key:string;source:'asset'|'edge';assetId:string|null;gatewayId:string|null;sourceId:string|null;edgeAssetId:string|null;name:string;metric:string;value:number|null;unit:string;quality:'good'|'uncertain'|'bad';simulated:boolean;commissioned:boolean;observedAt:string|null;receivedAt:string|null;stale:boolean;staleAfterSeconds:number;history:Array<{value:number|null;observedAt:string}>};
export type Gateway = {id:string;lastReceivedAt:string|null;lastObservedAt:string|null;state:'online'|'offline'|'unknown';batteryPercent:number|null;dataUsageMb:number|null};
export type Monitoring = {sensors:Sensor[];gateways:Gateway[];commandCapability:false;truncated?:boolean};
export const weatherMetrics = {temperature_2m:'C',precipitation:'mm',wind_speed_10m:'km/h',relative_humidity_2m:'%'} as const;
export type WeatherMetric = keyof typeof weatherMetrics;
export function sensorRuleSource(sensor:Sensor) {
  return {source:sensor.source,metric:sensor.metric,unit:sensor.unit,
    ...(sensor.assetId?{assetId:sensor.assetId}:{}),...(sensor.gatewayId?{gatewayId:sensor.gatewayId}:{}),
    ...(sensor.sourceId?{sourceId:sensor.sourceId}:{}),...(sensor.edgeAssetId?{edgeAssetId:sensor.edgeAssetId}:{})};
}
/** Gaps remain unknown; null never becomes zero or a fabricated temperature. */
export function forecastDays(hourly:Record<string,unknown>,timezone:string) {
  const times=Array.isArray(hourly.time)?hourly.time:[];
  const temperature=Array.isArray(hourly.temperature_2m)?hourly.temperature_2m:[];
  const rain=Array.isArray(hourly.precipitation)?hourly.precipitation:[];
  const days=new Map<string,{temperatures:number[];rain:number[];missingRain:boolean;hours:number}>();
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  for(let index=0;index<times.length;index++) {
    const time=new Date(String(times[index]));if(!Number.isFinite(time.getTime()))continue;
    const key=formatter.format(time),day=days.get(key)??{temperatures:[],rain:[],missingRain:false,hours:0};
    if(typeof temperature[index]==='number'&&Number.isFinite(temperature[index]))day.temperatures.push(temperature[index]);
    if(typeof rain[index]==='number'&&Number.isFinite(rain[index]))day.rain.push(rain[index]);else day.missingRain=true;
    day.hours++;days.set(key,day);
  }
  return [...days.entries()].slice(0,3).map(([date,day])=>({date,hours:day.hours,min:day.temperatures.length?Math.min(...day.temperatures):null,max:day.temperatures.length?Math.max(...day.temperatures):null,rain:day.missingRain?null:day.rain.reduce((sum,value)=>sum+value,0)}));
}
