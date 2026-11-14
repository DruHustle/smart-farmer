import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {openAuthSessionAsync} from 'expo-web-browser';
import {createApi} from './api';
import {PendingOnesaTransactions, type PendingOnesa} from './onesa-callback';
import type {Language,Session} from './types';

export type OnesaConfig = {audience?: string; nativeClientId?:string; issuer:string;clientId:string;callback:string};
const pendingKey = 'smart-farmer.onesa-pending.v1';
const options = {keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY};
const transactions = new PendingOnesaTransactions({
  read: () => SecureStore.getItemAsync(pendingKey, options),
  write: value => SecureStore.setItemAsync(pendingKey, value, options),
  remove: () => SecureStore.deleteItemAsync(pendingKey, options),
});
const random = () => Array.from(Crypto.getRandomBytes(32), byte => byte.toString(16).padStart(2,'0')).join('');

export async function openOnesa(origin:string, config:OnesaConfig, language:Language) {
  const target=new URL(config.audience ? new URL('authorize',config.issuer).href : config.issuer+'/auth');
  const callback=new URL(config.callback);
  const secure=(url:URL)=>!url.username&&!url.password&&!url.search&&!url.hash&&(url.protocol==='https:' ||
    (__DEV__ && url.protocol==='http:' && ['localhost','127.0.0.1','10.0.2.2'].includes(url.hostname)));
  if (!secure(target) || !secure(callback) || (config.audience ? target.pathname!=='/authorize' || target.origin!==new URL(config.issuer).origin : target.pathname!=='/api/v1/identity/auth') || callback.pathname!=='/auth/onesa/callback') throw new Error('invalid_response');
  if (config.audience && !config.nativeClientId) throw new Error('invalid_response');
  const state='native_'+random(), verifier=random(), nonce=random();
  const digest=await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,verifier,{encoding:Crypto.CryptoEncoding.BASE64});
  const challenge=digest.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const params = new URLSearchParams({response_type:'code',scope:config.audience ? 'openid profile email' : 'openid email profile onesa', ...(config.audience && {audience:config.audience}),client_id:config.nativeClientId ?? config.clientId,
    redirect_uri:config.callback,code_challenge_method:'S256',code_challenge:challenge,state,nonce});
  const pending:PendingOnesa={state,verifier,nonce:config.audience ? nonce : undefined,issuer:config.issuer,origin,language,expires:Date.now()+300_000};
  await transactions.save(pending);
  try {
    const response = await openAuthSessionAsync(target.href + '?' + params, 'smartfarmer://onesa/callback');
    if (response.type === 'cancel' || response.type === 'dismiss') throw new Error('onesa_cancelled');
    if (response.type !== 'success') throw new Error('onesa_unavailable');
    return await redeemOnesa(response.url, origin);
  } finally {
    // Cold starts redeem from secure storage. Clear only the attempt owned by this sheet.
    await transactions.clear(state);
  }
}

export async function redeemOnesa(incoming:string,origin:string):Promise<Session | null> {
  const claim = await transactions.claim(incoming, origin);
  if (!claim) return null;
  const {pending, code} = claim;
  const reply=await createApi(origin).request<Omit<Session,'origin'>>('/v1/onesa/sessions','POST',
    {code,verifier:pending.verifier,nonce:pending.nonce,native:pending.nonce ? true : undefined,language:pending.language});
  // Native storage supplies its own account-bound database key.
  return {origin,portalAccountUrl:new URL('/account',pending.issuer).href,token:reply.token,userId:reply.userId,username:reply.username,language:reply.language,expiresAt:reply.expiresAt};
}
