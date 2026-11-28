import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Exercise the deployed web component with two synthetic boundaries: Account and its issuer.
export async function registrationJourney(browser, ui, api, label, audience, newTab = false) {
  const context = await browser.newContext({serviceWorkers:'block'});
  try {
    const page = await context.newPage();
    const issuer = 'https://farmer-provider.example.test/';
    const callback = ui + '/auth/onesa/callback';
    const listing = '12a34567-89ab-4cde-8fab-0123456789ab';
    const destination = ui + '/?listing=' + listing;
    const headers = {'Access-Control-Allow-Origin':ui,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
    let challenge, nonce;
    await context.route(api + '/v1/onesa/config', route => route.fulfill({headers,json:{
      issuer,clientId:'synthetic-farmer',audience:'https://farmer-api.example.test',callback,
    }}));
    const registration = 'https://account.onesa.eu/register?audience='+audience+'&product=farmer&platform=web';
    await context.route(registration, route => route.fulfill({contentType:'text/html',body:
      '<a href="'+ui+'/auth/registration/complete"'+(newTab ? ' target="_blank" rel="noopener"' : '')+'>Return to Farmer</a>'}));
    await context.route(issuer + 'authorize?**', route => {
      const params = new URL(route.request().url()).searchParams;
      assert.equal(params.get('redirect_uri'),callback);
      assert.equal(params.get('code_challenge_method'),'S256');
      assert.equal(params.has('prompt'),false);
      challenge=params.get('code_challenge'); nonce=params.get('nonce');
      const url = new URL(callback);
      url.search = new URLSearchParams({code:'synthetic-signup',state:params.get('state'),iss:issuer});
      return route.fulfill({contentType:'text/html',body:'<script>location.replace('+JSON.stringify(url.href)+')</script>'});
    });
    await context.route(api + '/v1/onesa/sessions', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({status:204, headers});
      const body = route.request().postDataJSON();
      assert.equal(body.code,'synthetic-signup');
      assert.equal(body.nonce,nonce);
      assert.equal(createHash('sha256').update(body.verifier).digest('base64url'),challenge);
      return route.fulfill({headers,json:{token:'synthetic-local-token',userId:listing,username:'synthetic-farmer',
        language:'sn',vaultKey:'synthetic-vault-key',expiresAt:new Date(Date.now()+300000).toISOString()}});
    });
    await page.goto(destination);
    await page.getByRole('link',{name:label,exact:true}).click();
    assert.equal(page.url(),registration);
    const exchange = context.waitForEvent('response', response =>
      response.url() === api + '/v1/onesa/sessions' && response.request().method() === 'POST');
    const [returned] = await Promise.all([
      newTab ? context.waitForEvent('page') : page,
      page.getByRole('link',{name:'Return to Farmer'}).click(),
    ]);
    assert.equal((await exchange).status(),200);
    await returned.waitForURL(newTab ? ui + '/' : destination);
  } finally { await context.close(); }
}
