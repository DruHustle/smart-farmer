import {test} from 'node:test';
import assert from 'node:assert/strict';
import {forecastDays,sensorRuleSource} from '../src/lib/monitoring.ts';
import {farmToolWords,farmToolPhrases} from '../src/farm-tools-locales.ts';
import {destination} from '../src/lib/destination.ts';
import {isQueueable} from '../src/lib/sync.ts';

test('forecast summaries use the farm day across UTC midnight and retain missing precipitation',()=>{
  const days=forecastDays({time:['2026-11-28T20:00:00Z','2026-11-28T21:00:00Z','2026-11-28T22:00:00Z','2026-11-28T23:00:00Z'],temperature_2m:[0,null,-2,3],precipitation:[0,null,1,2]},'Africa/Harare');
  assert.deepEqual(days,[{date:'2026-11-28',hours:2,min:0,max:0,rain:null},{date:'2026-11-29',hours:2,min:-2,max:3,rain:3}]);
});
test('empty forecasts and nonnumeric provider data cannot become invented zero readings',()=>{
  assert.deepEqual(forecastDays({},'Africa/Harare'),[]);
  assert.deepEqual(forecastDays({time:['invalid','2026-11-28T12:00:00Z'],temperature_2m:[null,'0'],precipitation:[null,'0']},'Africa/Harare'),[{date:'2026-11-28',hours:1,min:null,max:null,rain:null}]);
});
test('sensor rule targets retain exact source and unit without mixing asset and gateway identities',()=>{
  assert.deepEqual(sensorRuleSource({source:'asset',metric:'soil_moisture',unit:'%',assetId:'one',gatewayId:null,sourceId:null,edgeAssetId:null}),{source:'asset',metric:'soil_moisture',unit:'%',assetId:'one'});
  assert.deepEqual(sensorRuleSource({source:'edge',metric:'water_level',unit:'m',assetId:null,gatewayId:'gateway',sourceId:'tank',edgeAssetId:'tank-1'}),{source:'edge',metric:'water_level',unit:'m',gatewayId:'gateway',sourceId:'tank',edgeAssetId:'tank-1'});
});
test('farm-tool entry routes round-trip after sign-in and all three draft catalogs contain every label',()=>{
  for(const key of Object.keys(farmToolPhrases))for(const lang of ['en','sn','nd'])assert.ok(farmToolWords(lang)[key]?.trim(),`${lang}.${key}`);
  for(const page of ['sensors','market-prices','support','trials','growing-systems','advisor','basic-phone'])assert.deepEqual(destination(new URL('/?page='+page,'https://farmer.example.test')),{page,path:'/?page='+page});
});
test('advisor transfers, phone linking and alert rules never enter the offline field-record queue',()=>{
  for(const path of ['/v1/farms/f/projects/p/companion/chat','/v1/farms/f/basic-phone/link','/v1/farms/f/monitoring/rules','/v1/farms/f/support/visits','/v1/farms/f/market-prices'])assert.equal(isQueueable(path,'POST'),false,path);
});
