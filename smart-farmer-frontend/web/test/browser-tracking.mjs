import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';

/** Real API/browser observations with synthetic coordinates; never contacts a real device. */
export async function trackingJourneys({page,context,api,apiCall,farm,token,sn,nd,unique,navigate,checkpoint,pass,artifacts}) {
  const visible=locator=>locator.waitFor({state:'visible',timeout:10000});
  const base='/v1/farms/'+farm.id;
  checkpoint('Private tracker registration, uncertain geofence and manual reference');
  const project=await apiCall(base+'/projects',{name:'Synthetic tracking herd',enterpriseType:'rabbit_growout',asOfDate:'2026-11-01',openingCount:4,countBasis:'verified'},token);
  await page.locator('.sync-caption').getByRole('button',{name:sn.refresh,exact:true}).click();
  await navigate('farm');await page.locator('.filter-chips').getByRole('button',{name:sn.animals,exact:true}).click();
  const section=page.locator('section').filter({has:page.getByRole('heading',{name:sn.trackingTitle,exact:true})}).first();
  await visible(section);
  const registration=section.locator('details').filter({has:page.locator('summary').filter({hasText:sn.trackingRegister})});
  await registration.locator('summary').click();
  await registration.getByLabel(sn.trackingGroup,{exact:true}).selectOption(project.id);
  await registration.getByLabel(sn.trackingTagLabel,{exact:true}).fill('Synthetic lead-animal tag');
  await registration.getByLabel(sn.trackingType,{exact:true}).selectOption('demo');
  await registration.getByLabel(sn.trackingDeviceId,{exact:true}).fill('synthetic-browser-'+unique);
  const created=page.waitForResponse(response=>response.url()===api+base+'/trackers'&&response.request().method()==='POST');
  await registration.getByRole('button',{name:sn.trackingRegisterAction,exact:true}).click();
  const response=await created;assert.equal(response.status(),201);const tracker=await response.json();
  assert.equal(typeof tracker.ingestToken,'string');assert.equal((await section.innerText()).includes(tracker.ingestToken),false,'A credential is never rendered into screenshot text');
  await registration.getByRole('button',{name:sn.close,exact:true}).click();
  const fenceForm=section.locator('details').filter({has:page.locator('summary').filter({hasText:sn.trackingBoundarySummary})});
  await fenceForm.locator('summary').click();await fenceForm.getByLabel(sn.trackingAreaName,{exact:true}).fill('Synthetic grazing circle');
  await fenceForm.getByLabel(sn.trackingGroup,{exact:true}).selectOption(project.id);
  await fenceForm.getByLabel(sn.trackingLatitude,{exact:true}).fill('0');await fenceForm.getByLabel(sn.trackingLongitude,{exact:true}).fill('0');await fenceForm.getByLabel(sn.trackingRadius,{exact:true}).fill('200');
  await fenceForm.getByRole('button',{name:sn.trackingBoundaryAdd,exact:true}).click();await visible(section.getByText('Synthetic grazing circle',{exact:true}));
  const start=Date.now()-31*60_000;
  async function observation(latitude,offset,expected=201){
    const result=await fetch(api+'/v1/trackers/'+tracker.id+'/observations',{method:'POST',headers:{'Content-Type':'application/json','X-Tracker-Token':tracker.ingestToken},body:JSON.stringify({id:randomUUID(),observedAt:new Date(start+offset).toISOString(),latitude,longitude:0,accuracyMeters:20,batteryPercent:80,quality:'simulated'})});
    assert.equal(result.status,expected,'Expected isolated tracker ingestion result');
  }
  await observation(0.003,0);await section.getByRole('button',{name:sn.trackingRefresh,exact:true}).click();
  const card=section.locator('article').filter({has:page.getByText('Synthetic lead-animal tag',{exact:true})});
  await visible(card.getByText(sn.trackerState_stale,{exact:true}));
  const alert=section.getByRole('region',{name:sn.trackingAlerts});
  await visible(alert);await alert.getByRole('button',{name:sn.trackingAcknowledge,exact:true}).click();await visible(alert.getByText(new RegExp(sn.trackerStatus_acknowledged)));
  await observation(0.0018,1000);await section.getByRole('button',{name:sn.trackingRefresh,exact:true}).click();
  await visible(alert.getByText(new RegExp(sn.trackerStatus_acknowledged)));
  await card.getByRole('button',{name:sn.trackingHistory,exact:true}).click();await visible(card.getByRole('region',{name:sn.trackingHistory}).getByText(/0\.00180/));
  assert.match(await card.getByRole('link',{name:sn.trackingOpenMap,exact:true}).getAttribute('href'),/^https:\/\/www\.openstreetmap\.org\//);
  assert.equal(context.pages().length,1,'Coordinates are not automatically opened in an external map');
  for(const width of [320,768,1280]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Tracking page fits '+width);await page.screenshot({path:resolve(artifacts,'tracking-'+width+'.png'),fullPage:true});}
  await page.getByLabel(sn.language,{exact:true}).selectOption('nd');
  const ndTracking=page.locator('section').filter({has:page.getByRole('heading',{name:nd.trackingTitle,exact:true})}).first();
  await visible(ndTracking.getByText(nd.trackingPrivacy,{exact:true}));
  await visible(ndTracking.getByText(nd.trackerState_stale,{exact:true}));
  await visible(ndTracking.getByText(new RegExp(nd.trackerStatus_acknowledged)));
  await visible(ndTracking.getByRole('link',{name:nd.trackingOpenMap,exact:true}));
  assert.equal(await ndTracking.getByLabel(nd.trackingType,{exact:true}).locator('option[value="manual_reference"]').textContent(),nd.trackerProvider_manual_reference);
  for(const width of [320,1280]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Ndebele tracking fits '+width);await page.screenshot({path:resolve(artifacts,'tracking-nd-'+width+'.png'),fullPage:true});}
  const ndTrackingAccess=await new AxeBuilder({page}).include('.workspace').analyze();await writeFile(resolve(artifacts,'axe-tracking-nd.json'),JSON.stringify(ndTrackingAccess,null,2));assert.deepEqual(ndTrackingAccess.violations.filter(v=>['critical','serious'].includes(v.impact)).map(v=>v.id),[]);
  await page.getByLabel(nd.language,{exact:true}).selectOption('sn');await visible(section);
  await page.setViewportSize({width:390,height:844});
  await observation(0,2000);await section.getByRole('button',{name:sn.trackingRefresh,exact:true}).click();await alert.waitFor({state:'hidden'});
  await card.getByRole('button',{name:sn.trackingPause,exact:true}).click();await visible(card.getByRole('button',{name:sn.trackingResume,exact:true}));await observation(0,3000,401);
  await registration.getByLabel(sn.trackingTagLabel,{exact:true}).fill('Synthetic manual reference');await registration.getByLabel(sn.trackingType,{exact:true}).selectOption('manual_reference');await registration.getByLabel(sn.trackingDeviceId,{exact:true}).fill('synthetic-manual-'+unique);await registration.getByLabel(sn.trackingGroup,{exact:true}).selectOption(project.id);
  await registration.getByRole('button',{name:sn.trackingRegisterAction,exact:true}).click();await visible(registration.getByText(sn.trackingManualSaved,{exact:true}));
  const access=await new AxeBuilder({page}).include('.workspace').analyze();await writeFile(resolve(artifacts,'axe-tracking.json'),JSON.stringify(access,null,2));assert.deepEqual(access.violations.filter(v=>['critical','serious'].includes(v.impact)).map(v=>v.id),[]);
  pass('Private demo tracker registration, stale/uncertain boundaries, confirmed return, pause denial and manual-only AirTag reference work with Shona/Ndebele labels');

  checkpoint('Saved marketplace search, favourites, follows and private account alerts');
  const discovery=page.getByRole('region',{name:sn.marketDiscovery});
  const query='Synthetic maize '+unique;
  // Hold the real initial list response until the save and its newer reload
  // have completed. A late read must not erase the new item or its vault cache.
  const savedSearchesUrl=api+'/v1/market/saved-searches';
  async function saveBeforeOlderRead(savedQuery,staleStatus){
    const initial=Promise.withResolvers(),release=Promise.withResolvers(),handled=Promise.withResolvers();
    // A route callback runs outside the journey's promise chain. Observe its
    // failure here and await it below, so cleanup cannot mask the first failure.
    initial.promise.catch(()=>{});handled.promise.catch(()=>{});
    let heldRequest,holding=false,journeyError;
    const delayInitial=async route=>{
      if(route.request().method()!=='GET'||holding){await route.continue();return;}
      holding=true;heldRequest=route.request();
      try{
        const response=await route.fetch({timeout:10000});initial.resolve();await release.promise;
        // Also exercise an older authorization failure after the newer read
        // has already confirmed the account's current access.
        await route.fulfill(staleStatus?{response,status:staleStatus,json:{error:'forbidden'}}:{response});
        handled.resolve();
      }catch(error){
        initial.reject(error);
        await route.abort().catch(()=>{});
        handled.reject(error);
      }
    };
    await page.route(savedSearchesUrl,delayInitial);
    try{
      await navigate('market');
      const requested=page.waitForRequest(request=>request.url()===savedSearchesUrl&&request.method()==='GET',{timeout:10000});
      await page.getByRole('button',{name:sn.marketSavedAlerts,exact:true}).click();await requested;await initial.promise;
      await discovery.getByLabel(sn.search,{exact:true}).fill(savedQuery);await discovery.getByRole('button',{name:sn.save,exact:true}).click();await visible(discovery.getByText(savedQuery,{exact:true}));
      // The form resets only after the post-save reload has persisted its cache.
      await page.waitForFunction(label=>Array.from(document.querySelectorAll('section')).find(section=>section.getAttribute('aria-label')===label)?.querySelector('input[name="query"]')?.value==='',sn.marketDiscovery);
      const lateResponse=page.waitForResponse(response=>response.request()===heldRequest,{timeout:10000});release.resolve();await Promise.all([lateResponse.then(response=>response.finished()),handled.promise]);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await discovery.getByText(savedQuery,{exact:true}).isVisible(),true,'A late initial marketplace read cannot erase a newly saved search');
      await context.setOffline(true);await navigate('today');await navigate('market');
      await page.getByRole('button',{name:sn.marketSavedAlerts,exact:true}).click();
      await visible(discovery.getByText(savedQuery,{exact:true}));
    }catch(error){journeyError=error;throw error;}
    finally{
      release.resolve();
      let routeError;
      // Removing a Playwright route continues its in-flight requests. Finish
      // the held response first, including when an earlier UI assertion fails.
      if(holding)await handled.promise.catch(error=>{routeError=error;});
      await page.unroute(savedSearchesUrl,delayInitial);await context.setOffline(false);
      if(routeError&&!journeyError)throw routeError;
    }
  }
  await saveBeforeOlderRead(query);
  await navigate('today');await saveBeforeOlderRead('Unrelated search '+unique,403);
  pass('Saved marketplace searches and their offline cache retain the newer authorized result after an older response or rejection');
  const sellerName='tracking_seller_'+unique,password='Synthetic-browser-seller-only-2026';
  const seller=await apiCall('/v1/register',{username:sellerName,password,language:'sn',farmName:'Synthetic discovery seller'});
  const sellerSession=await apiCall('/v1/sessions',{username:sellerName,password});const sellerBase='/v1/farms/'+seller.farmId;
  const stock=await apiCall(sellerBase+'/stock',{id:randomUUID(),name:'Synthetic stock',unit:'kg',quantity:100},sellerSession.token);
  const listing=await apiCall(sellerBase+'/listings',{id:randomUUID(),stockItemId:stock.id,title:query,quantity:10,price:3,currency:'USD',collectionArea:'Synthetic town',category:'produce',condition:'dry',grade:'A',terms:'Synthetic acceptance only'},sellerSession.token);
  await page.locator('.workspace-tabs').getByRole('button',{name:sn.listings,exact:true}).click();
  const search=page.locator('form.search-form');await search.getByLabel(sn.search,{exact:true}).fill(query);await search.getByRole('button',{name:sn.search,exact:true}).click();
  const listingCard=page.locator('.listing-card').filter({has:page.getByRole('heading',{name:query,exact:true})});await visible(listingCard);
  await listingCard.getByRole('button',{name:sn.marketSaveListing,exact:true}).click();await visible(listingCard.getByRole('button',{name:sn.marketListingSaved,exact:true}));
  await listingCard.getByRole('button',{name:sn.marketFollowSeller,exact:true}).click();await visible(listingCard.getByRole('button',{name:sn.marketFollowingSeller,exact:true}));
  await page.getByRole('button',{name:sn.marketSavedAlerts,exact:true}).click();await visible(discovery.getByRole('button',{name:sn.marketRemoveSaved,exact:true}));await visible(discovery.getByRole('button',{name:sn.marketUnfollow,exact:true}));
  await discovery.getByRole('button',{name:sn.marketMarkRead,exact:true}).click();await discovery.getByRole('button',{name:sn.marketMarkRead,exact:true}).waitFor({state:'hidden'});
  assert.ok((await apiCall('/v1/market/alerts',undefined,token)).items.find(item=>item.listing_id===listing.id)?.read_at);
  assert.equal((await apiCall('/v1/market/favorites',undefined,sellerSession.token)).items.length,0,'Favourites stay account-scoped');
  for(const width of [320,768,1280]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Discovery fits '+width);await page.screenshot({path:resolve(artifacts,'market-discovery-'+width+'.png'),fullPage:true});}
  await page.getByLabel(sn.language,{exact:true}).selectOption('nd');
  const ndDiscovery=page.getByRole('region',{name:nd.marketDiscovery});
  await visible(ndDiscovery.getByRole('heading',{name:nd.marketSavedSearches,exact:true}));
  await visible(ndDiscovery.getByText(nd.marketSearchHint,{exact:true}));
  await visible(ndDiscovery.getByRole('button',{name:nd.marketRemoveSaved,exact:true}));
  await visible(ndDiscovery.getByRole('button',{name:nd.marketUnfollow,exact:true}));
  assert.equal(await ndDiscovery.getByLabel(nd.category,{exact:true}).locator('option[value="produce"]').textContent(),nd.produce);
  for(const width of [320,1280]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Ndebele discovery fits '+width);await page.screenshot({path:resolve(artifacts,'market-discovery-nd-'+width+'.png'),fullPage:true});}
  const ndDiscoveryAccess=await new AxeBuilder({page}).include('.workspace').analyze();await writeFile(resolve(artifacts,'axe-market-discovery-nd.json'),JSON.stringify(ndDiscoveryAccess,null,2));assert.deepEqual(ndDiscoveryAccess.violations.filter(v=>['critical','serious'].includes(v.impact)).map(v=>v.id),[]);
  await page.getByLabel(nd.language,{exact:true}).selectOption('sn');await visible(discovery);
  await page.setViewportSize({width:390,height:844});
  const discoveryAccess=await new AxeBuilder({page}).include('.workspace').analyze();await writeFile(resolve(artifacts,'axe-market-discovery.json'),JSON.stringify(discoveryAccess,null,2));assert.deepEqual(discoveryAccess.violations.filter(v=>['critical','serious'].includes(v.impact)).map(v=>v.id),[]);
  await discovery.getByRole('button',{name:sn.marketRemoveSaved,exact:true}).click();await discovery.getByRole('button',{name:sn.marketRemoveSaved,exact:true}).waitFor({state:'hidden'});
  await discovery.getByRole('button',{name:sn.marketUnfollow,exact:true}).click();await discovery.getByRole('button',{name:sn.marketUnfollow,exact:true}).waitFor({state:'hidden'});
  for(const savedQuery of [query,'Unrelated search '+unique]){
    const savedCard=discovery.locator('section.panel').filter({has:page.getByRole('heading',{name:sn.marketSavedSearches,exact:true})}).locator('.record-card').filter({has:page.getByText(savedQuery,{exact:true})});
    await savedCard.getByRole('button',{name:sn.marketRemoveSearch,exact:true}).click();await savedCard.waitFor({state:'hidden'});
  }
  assert.equal((await apiCall('/v1/market/favorites',undefined,token)).items.length,0);assert.equal((await apiCall('/v1/market/follows',undefined,token)).items.length,0);assert.equal((await apiCall('/v1/market/saved-searches',undefined,token)).items.length,0);
  pass('Saved searches, matching account alerts, favourites, follows, read acknowledgement and removal work with Shona/Ndebele discovery labels');
}
