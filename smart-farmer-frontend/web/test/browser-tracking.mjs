import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';

/** Real API/browser observations with synthetic coordinates; never contacts a real device. */
export async function trackingJourneys({page,context,api,apiCall,farm,token,sn,unique,navigate,checkpoint,pass,artifacts}) {
  const visible=locator=>locator.waitFor({state:'visible',timeout:10000});
  const base='/v1/farms/'+farm.id;
  checkpoint('Private tracker registration, uncertain geofence and manual reference');
  const project=await apiCall(base+'/projects',{name:'Synthetic tracking herd',enterpriseType:'rabbit_growout',asOfDate:'2026-11-01',openingCount:4,countBasis:'verified'},token);
  await page.locator('.sync-caption').getByRole('button',{name:sn.refresh,exact:true}).click();
  await navigate('farm');await page.locator('.filter-chips').getByRole('button',{name:sn.animals,exact:true}).click();
  const section=page.locator('section').filter({has:page.getByRole('heading',{name:'Herd tracking · GPS collars & ear tags',exact:true})}).first();
  await visible(section);
  const registration=section.locator('details').filter({has:page.locator('summary').filter({hasText:'Register GPS collar / tag'})});
  await registration.locator('summary').click();
  await registration.getByLabel('Animal group',{exact:true}).selectOption(project.id);
  await registration.getByLabel('Tag label',{exact:true}).fill('Synthetic lead-animal tag');
  await registration.getByLabel('Tracker type',{exact:true}).selectOption('demo');
  await registration.getByLabel('Hardware device ID',{exact:true}).fill('synthetic-browser-'+unique);
  const created=page.waitForResponse(response=>response.url()===api+base+'/trackers'&&response.request().method()==='POST');
  await registration.getByRole('button',{name:'Register tracker',exact:true}).click();
  const response=await created;assert.equal(response.status(),201);const tracker=await response.json();
  assert.equal(typeof tracker.ingestToken,'string');assert.equal((await section.innerText()).includes(tracker.ingestToken),false,'A credential is never rendered into screenshot text');
  await registration.getByRole('button',{name:'Dismiss',exact:true}).click();
  const fenceForm=section.locator('details').filter({has:page.locator('summary').filter({hasText:'Grazing boundary / geofence'})});
  await fenceForm.locator('summary').click();await fenceForm.getByLabel('Area name',{exact:true}).fill('Synthetic grazing circle');
  await fenceForm.getByLabel('Animal group',{exact:true}).selectOption(project.id);
  await fenceForm.getByLabel('Centre latitude',{exact:true}).fill('0');await fenceForm.getByLabel('Centre longitude',{exact:true}).fill('0');await fenceForm.getByLabel('Radius (metres)',{exact:true}).fill('200');
  await fenceForm.getByRole('button',{name:'Add grazing boundary',exact:true}).click();await visible(section.getByText('Synthetic grazing circle',{exact:true}));
  const start=Date.now()-31*60_000;
  async function observation(latitude,offset,expected=201){
    const result=await fetch(api+'/v1/trackers/'+tracker.id+'/observations',{method:'POST',headers:{'Content-Type':'application/json','X-Tracker-Token':tracker.ingestToken},body:JSON.stringify({id:randomUUID(),observedAt:new Date(start+offset).toISOString(),latitude,longitude:0,accuracyMeters:20,batteryPercent:80,quality:'simulated'})});
    assert.equal(result.status,expected,'Expected isolated tracker ingestion result');
  }
  await observation(0.003,0);await section.getByRole('button',{name:'Refresh tracker data',exact:true}).click();
  const card=section.locator('article').filter({has:page.getByText('Synthetic lead-animal tag',{exact:true})});
  await visible(card.getByText('stale',{exact:true}));
  const alert=section.getByRole('region',{name:'Tracker alerts'});
  await visible(alert);await alert.getByRole('button',{name:'Acknowledge',exact:true}).click();await visible(alert.getByText(/acknowledged/));
  await observation(0.0018,1000);await section.getByRole('button',{name:'Refresh tracker data',exact:true}).click();
  await visible(alert.getByText(/acknowledged/));
  await card.getByRole('button',{name:'Movement history',exact:true}).click();await visible(card.getByRole('region',{name:'Movement history'}).getByText(/0\.00180/));
  assert.match(await card.getByRole('link',{name:'Open map (shares location with OpenStreetMap)',exact:true}).getAttribute('href'),/^https:\/\/www\.openstreetmap\.org\//);
  assert.equal(context.pages().length,1,'Coordinates are not automatically opened in an external map');
  for(const width of [320,768,1280]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Tracking page fits '+width);await page.screenshot({path:resolve(artifacts,'tracking-'+width+'.png'),fullPage:true});}
  await page.setViewportSize({width:390,height:844});
  await observation(0,2000);await section.getByRole('button',{name:'Refresh tracker data',exact:true}).click();await alert.waitFor({state:'hidden'});
  await card.getByRole('button',{name:'Pause tracker',exact:true}).click();await visible(card.getByRole('button',{name:'Resume tracker',exact:true}));await observation(0,3000,401);
  await registration.getByLabel('Tag label',{exact:true}).fill('Synthetic manual reference');await registration.getByLabel('Tracker type',{exact:true}).selectOption('manual_reference');await registration.getByLabel('Hardware device ID',{exact:true}).fill('synthetic-manual-'+unique);await registration.getByLabel('Animal group',{exact:true}).selectOption(project.id);
  await registration.getByRole('button',{name:'Register tracker',exact:true}).click();await visible(registration.getByText('Reference saved. No location connection is available for an AirTag.',{exact:true}));
  const access=await new AxeBuilder({page}).include('.workspace').analyze();await writeFile(resolve(artifacts,'axe-tracking.json'),JSON.stringify(access,null,2));assert.deepEqual(access.violations.filter(v=>['critical','serious'].includes(v.impact)).map(v=>v.id),[]);
  pass('Private demo tracker registration, stale history, acknowledged uncertain boundary, confirmed return, pause denial and manual-only AirTag reference work through the browser');

  checkpoint('Saved marketplace search, favourites, follows and private account alerts');
  await navigate('market');await page.getByRole('button',{name:'Saved & alerts',exact:true}).click();
  const discovery=page.getByRole('region',{name:'Marketplace discovery'});
  const query='Synthetic maize '+unique;
  await discovery.getByLabel(sn.search,{exact:true}).fill(query);await discovery.getByRole('button',{name:sn.save,exact:true}).click();await visible(discovery.getByText(query,{exact:true}));
  const sellerName='tracking_seller_'+unique,password='Synthetic-browser-seller-only-2026';
  const seller=await apiCall('/v1/register',{username:sellerName,password,language:'sn',farmName:'Synthetic discovery seller'});
  const sellerSession=await apiCall('/v1/sessions',{username:sellerName,password});const sellerBase='/v1/farms/'+seller.farmId;
  const stock=await apiCall(sellerBase+'/stock',{id:randomUUID(),name:'Synthetic stock',unit:'kg',quantity:100},sellerSession.token);
  const listing=await apiCall(sellerBase+'/listings',{id:randomUUID(),stockItemId:stock.id,title:query,quantity:10,price:3,currency:'USD',collectionArea:'Synthetic town',category:'produce',condition:'dry',grade:'A',terms:'Synthetic acceptance only'},sellerSession.token);
  await page.locator('.workspace-tabs').getByRole('button',{name:sn.listings,exact:true}).click();
  const search=page.locator('form.search-form');await search.getByLabel(sn.search,{exact:true}).fill(query);await search.getByRole('button',{name:sn.search,exact:true}).click();
  const listingCard=page.locator('.listing-card').filter({has:page.getByRole('heading',{name:query,exact:true})});await visible(listingCard);
  await listingCard.getByRole('button',{name:'Save listing',exact:true}).click();await visible(listingCard.getByRole('button',{name:'Saved',exact:true}));
  await listingCard.getByRole('button',{name:'Follow seller',exact:true}).click();await visible(listingCard.getByRole('button',{name:'Following seller',exact:true}));
  await page.getByRole('button',{name:'Saved & alerts',exact:true}).click();await visible(discovery.getByRole('button',{name:'Remove from saved',exact:true}));await visible(discovery.getByRole('button',{name:'Unfollow',exact:true}));
  await discovery.getByRole('button',{name:'Mark read',exact:true}).click();await discovery.getByRole('button',{name:'Mark read',exact:true}).waitFor({state:'hidden'});
  assert.ok((await apiCall('/v1/market/alerts',undefined,token)).items.find(item=>item.listing_id===listing.id)?.read_at);
  assert.equal((await apiCall('/v1/market/favorites',undefined,sellerSession.token)).items.length,0,'Favourites stay account-scoped');
  for(const width of [320,768,1280]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Discovery fits '+width);await page.screenshot({path:resolve(artifacts,'market-discovery-'+width+'.png'),fullPage:true});}
  await page.setViewportSize({width:390,height:844});
  const discoveryAccess=await new AxeBuilder({page}).include('.workspace').analyze();await writeFile(resolve(artifacts,'axe-market-discovery.json'),JSON.stringify(discoveryAccess,null,2));assert.deepEqual(discoveryAccess.violations.filter(v=>['critical','serious'].includes(v.impact)).map(v=>v.id),[]);
  await discovery.getByRole('button',{name:'Remove from saved',exact:true}).click();await discovery.getByRole('button',{name:'Remove from saved',exact:true}).waitFor({state:'hidden'});
  await discovery.getByRole('button',{name:'Unfollow',exact:true}).click();await discovery.getByRole('button',{name:'Unfollow',exact:true}).waitFor({state:'hidden'});
  await discovery.getByRole('button',{name:'Delete',exact:true}).click();await discovery.getByRole('button',{name:'Delete',exact:true}).waitFor({state:'hidden'});
  assert.equal((await apiCall('/v1/market/favorites',undefined,token)).items.length,0);assert.equal((await apiCall('/v1/market/follows',undefined,token)).items.length,0);assert.equal((await apiCall('/v1/market/saved-searches',undefined,token)).items.length,0);
  pass('Saved searches generate only matching account alerts; listing favourites, follows, read acknowledgement and removal persist through the real UI');
}
