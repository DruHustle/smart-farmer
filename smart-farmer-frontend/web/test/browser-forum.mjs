import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import {forumText} from '../src/forum.ts';

/** Real signed-in browser journeys; all community activity here is synthetic fixture data. */
export async function forumJourneys({page,context,apiCall,farm,token,sn,nd,unique,checkpoint,pass,artifacts}) {
  const f=forumText('sn'),n=forumText('nd'),base=`/v1/farms/${farm.id}/forum`;
  const guestName=`forum_guest_${unique}`,guestPassword='Forum-fixture-only-2026';
  const guest=await apiCall('/v1/register',{username:guestName,password:guestPassword,language:'sn',farmName:'Private forum guest farm'});
  const guestSession=await apiCall('/v1/sessions',{username:guestName,password:guestPassword});
  const guestBase=`/v1/farms/${guest.farmId}/forum`;
  const seededId=randomUUID(),title=`Forum field notes ${unique}`,guestTitle=`Forum community ${unique}`;
  await apiCall(`${guestBase}/discussions`,{id:seededId,displayName:'CommunityGrower',title:guestTitle,topic:'crops',body:'Synthetic community discussion for acceptance; no agronomic advice.',shareWithCommunity:true},guestSession.token);
  const visible=locator=>locator.waitFor({state:'visible',timeout:10000});
  const navigate=async()=>{await page.locator('.mobile-nav').getByRole('button',{name:sn.forum,exact:true}).click();await visible(page.getByRole('heading',{name:f.title,exact:true}));};
  let forumWrites=0;
  const count=request=>{if(request.url().includes('/forum/')&&['POST','PATCH','DELETE'].includes(request.method()))forumWrites++;};
  page.on('request',count);
  try {
    checkpoint('Forum explicit sharing, plain-text rendering and author control');
    await navigate();await visible(page.getByTestId(`forum-open-${seededId}`));
    assert.equal(await page.getByTestId(`forum-entry-${seededId}`).getByText(guestName,{exact:true}).count(),0);
    assert.equal(await page.getByTestId(`forum-entry-${seededId}`).getByText('Private forum guest farm',{exact:true}).count(),0);
    await page.getByTestId('forum-new').click();let modal=page.getByRole('dialog');
    await modal.getByTestId('forum-compose-name').fill('FieldGrower');await modal.getByTestId('forum-compose-title').fill(title);
    await modal.getByLabel(f.topic,{exact:true}).selectOption('soil');
    const literal='<img src=x onerror="window.__forum_xss=1"> Synthetic field observation.';
    await modal.getByTestId('forum-compose-body').fill(literal);
    const beforeConsent=forumWrites;await modal.getByTestId('forum-compose-submit').click();assert.equal(forumWrites,beforeConsent,'No publication before explicit sharing acknowledgement');
    await modal.getByTestId('forum-compose-consent').check();await modal.getByTestId('forum-compose-submit').click();await modal.waitFor({state:'hidden'});
    await visible(page.getByRole('heading',{name:title,exact:true}));await visible(page.getByText(literal,{exact:true}));
    assert.equal(await page.locator('img[src=x]').count(),0);assert.equal(await page.evaluate(()=>window.__forum_xss),undefined);
    const created=(await apiCall(`${base}/discussions?mine=true&search=${encodeURIComponent(title)}`,undefined,token)).items;
    assert.equal(created.length,1);const postId=created[0].id;
    for(const key of ['farm_id','farmId','author_id','authorId','username','payload_hash'])assert.equal(Object.hasOwn(created[0],key),false,key);
    await page.getByTestId(`forum-edit-${postId}`).click();modal=page.getByRole('dialog');
    await modal.getByTestId('forum-compose-body').fill('Reviewed synthetic forum note.');await modal.getByTestId('forum-compose-consent').check();await modal.getByTestId('forum-compose-submit').click();await modal.waitFor({state:'hidden'});
    await visible(page.getByText('Reviewed synthetic forum note.',{exact:true}));
    await page.getByTestId('forum-reply').click();modal=page.getByRole('dialog');await modal.getByTestId('forum-compose-name').fill('FieldGrower');await modal.getByTestId('forum-compose-body').fill('Synthetic reply shared deliberately.');await modal.getByTestId('forum-compose-consent').check();await modal.getByTestId('forum-compose-submit').click();await modal.waitFor({state:'hidden'});
    await visible(page.getByText('Synthetic reply shared deliberately.',{exact:true}));
    let thread=await apiCall(`${base}/discussions/${postId}`,undefined,token);assert.equal(thread.discussion.version,2);assert.equal(thread.replies.items.length,1);
    const replyId=thread.replies.items[0].id;await page.getByTestId(`forum-delete-${replyId}`).click();modal=page.getByRole('dialog');await modal.getByTestId('forum-action-consent').check();await modal.getByTestId('forum-action-submit').click();await modal.waitFor({state:'hidden'});
    await visible(page.getByTestId(`forum-entry-${replyId}`).getByText(f.removed,{exact:true}));
    thread=await apiCall(`${base}/discussions/${postId}`,undefined,token);assert.equal(thread.replies.items[0].body,'');assert.equal(thread.replies.items[0].displayName,'');
    pass('Forum requires explicit sharing, escapes HTML as text, and supports versioned author edits and reply removal');

    checkpoint('Forum topic discovery, cross-farm report and owner-scoped moderation');
    await page.getByRole('button',{name:f.back,exact:true}).click();await page.getByTestId('forum-filter-topic').selectOption('crops');
    await visible(page.getByTestId(`forum-open-${seededId}`));assert.equal(await page.getByTestId(`forum-open-${postId}`).count(),0);
    await page.getByLabel(f.search,{exact:true}).fill(guestTitle);await page.getByRole('button',{name:f.searchButton,exact:true}).click();
    await page.getByTestId(`forum-open-${seededId}`).click();await visible(page.getByRole('heading',{name:guestTitle,exact:true}));
    assert.equal(await page.getByTestId(`forum-edit-${seededId}`).count(),0);assert.equal(await page.getByTestId(`forum-moderate-${seededId}`).count(),0);
    await page.getByTestId(`forum-report-${seededId}`).click();modal=page.getByRole('dialog');await modal.getByLabel(f.reason,{exact:true}).selectOption('privacy');await modal.getByLabel(f.details,{exact:true}).fill('Synthetic privacy report for acceptance.');await modal.getByTestId('forum-action-consent').check();await modal.getByTestId('forum-action-submit').click();await modal.waitFor({state:'hidden'});
    const guestReports=(await apiCall(`${guestBase}/reports`,undefined,guestSession.token)).items;assert.equal(guestReports.length,1);
    for(const key of ['reporter_id','reporterId','username','farm_id','farmId'])assert.equal(Object.hasOwn(guestReports[0],key),false,key);
    await apiCall(`${guestBase}/entries/${postId}/reports`,{id:randomUUID(),version:2,reason:'other',details:'Synthetic moderation review.'},guestSession.token);
    await page.getByRole('button',{name:f.back,exact:true}).click();await page.getByRole('button',{name:f.reports,exact:true}).click();
    await visible(page.getByTestId(`forum-moderate-${postId}`));await page.getByTestId(`forum-moderate-${postId}`).click();modal=page.getByRole('dialog');await modal.getByLabel(f.moderationReason,{exact:true}).fill('Synthetic owner review hides this fixture.');await modal.getByTestId('forum-action-consent').check();await modal.getByTestId('forum-action-submit').click();await modal.waitFor({state:'hidden'});await visible(page.getByRole('heading',{name:f.noReports,exact:true}));
    assert.equal((await apiCall(`${guestBase}/discussions?search=${encodeURIComponent(title)}`,undefined,guestSession.token)).items.length,0);
    await page.getByRole('button',{name:f.hiddenEntries,exact:true}).click();await visible(page.getByTestId(`forum-moderate-${postId}`));await page.getByTestId(`forum-moderate-${postId}`).click();modal=page.getByRole('dialog');await modal.getByLabel(f.moderationReason,{exact:true}).fill('Synthetic review restores the unchanged content.');await modal.getByTestId('forum-action-consent').check();await modal.getByTestId('forum-action-submit').click();await modal.waitFor({state:'hidden'});await visible(page.getByRole('heading',{name:f.noHidden,exact:true}));
    assert.equal((await apiCall(`${guestBase}/discussions/${postId}`,undefined,guestSession.token)).discussion.status,'visible');
    pass('Forum discovery crosses farm boundaries deliberately; reports hide reporter identity and only source-farm owners moderate');

    checkpoint('Forum offline behavior, language, responsive layout and accessibility');
    await page.getByRole('button',{name:f.discussions,exact:true}).click();await page.getByTestId('forum-new').click();modal=page.getByRole('dialog');
    await modal.getByTestId('forum-compose-name').fill('OfflineGrower');await modal.getByTestId('forum-compose-title').fill('Must remain unshared offline');await modal.getByTestId('forum-compose-body').fill('Unshared synthetic local text.');
    const beforeOffline=forumWrites;await context.setOffline(true);await visible(modal.getByText(f.offline,{exact:true}));assert.equal(await modal.getByTestId('forum-compose-submit').isDisabled(),true);
    await context.setOffline(false);await modal.getByText(f.offline,{exact:true}).waitFor({state:'hidden'});assert.equal(forumWrites,beforeOffline,'Reconnection must not publish a forum draft');
    await modal.getByRole('button',{name:sn.close,exact:true}).click();assert.equal((await apiCall(`${base}/discussions?search=Must%20remain%20unshared%20offline`,undefined,token)).items.length,0);
    await page.getByLabel(sn.language,{exact:true}).selectOption('nd');await visible(page.getByRole('heading',{name:n.title,exact:true}));await page.screenshot({path:resolve(artifacts,'forum-nd.png'),fullPage:true});await page.getByLabel(nd.language,{exact:true}).selectOption('sn');
    for(const [width,height,name] of [[320,740,'phone'],[768,1024,'tablet'],[1280,900,'desktop']]){
      await page.setViewportSize({width,height});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Forum overflow at ${width}`);await page.screenshot({path:resolve(artifacts,`forum-${name}.png`),fullPage:true});
    }
    await page.setViewportSize({width:390,height:844});await page.evaluate(()=>document.documentElement.style.fontSize='200%');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Forum large-text overflow');await page.screenshot({path:resolve(artifacts,'forum-large-text-viewport.png'),fullPage:false});await page.screenshot({path:resolve(artifacts,'forum-large-text.png'),fullPage:true});await page.evaluate(()=>document.documentElement.style.fontSize='');
    const accessibility=await new AxeBuilder({page}).include('.workspace').analyze();await writeFile(resolve(artifacts,'axe-forum.json'),JSON.stringify(accessibility,null,2));assert.deepEqual(accessibility.violations.filter(item=>['critical','serious'].includes(item.impact)).map(item=>({id:item.id,nodes:item.nodes.length})),[]);
    const storage=await page.evaluate(async()=>({local:{...localStorage},session:{...sessionStorage},cached:(await Promise.all((await caches.keys()).map(async key=>(await (await caches.open(key)).keys()).map(request=>request.url)))).flat()}));
    assert.equal(JSON.stringify(storage.local).includes('Unshared synthetic local text.'),false);assert.equal(JSON.stringify(storage.session).includes('Unshared synthetic local text.'),false);assert.equal(storage.cached.some(url=>new URL(url).pathname.includes('/v1/')),false);
    pass('Forum never queues offline publication, supports Shona/Ndebele and responsive large text, and passes serious/critical accessibility checks');
  } finally {page.off('request',count);await context.setOffline(false);}
}
