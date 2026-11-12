import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {openAuthSessionAsync} from 'expo-web-browser';
import {createApi} from './api';
import {nativeCode, type PendingOnesa} from './onesa-callback';
import type {Language,Session} from './types';

export type OnesaConfig = {issuer:string;clientId:string;callback:string};
const pendingKey = 'smart-farmer.onesa-pending.v1';
const options = {keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY};
const random = () => Array.from(Crypto.getRandomBytes(32), byte => byte.toString(16).padStart(2,'0')).join('');

export async function openOnesa(origin:string, config:OnesaConfig, language:Language) {
  const target=new URL(config.issuer+'/auth');
  const callback=new URL(config.callback);
  const secure=(url:URL)=>!url.username&&!url.password&&!url.search&&!url.hash&&(url.protocol==='https:' ||
    (__DEV__ && url.protocol==='http:' && ['localhost','127.0.0.1','10.0.2.2'].includes(url.hostname)));
  if (!secure(target) || !secure(callback) || target.pathname!=='/api/v1/identity/auth' || callback.pathname!=='/auth/onesa/callback') throw new Error('invalid_response');
  const state='native_'+random(), verifier=random();
  const digest=await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,verifier,{encoding:Crypto.CryptoEncoding.BASE64});
  const challenge=digest.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const params = new URLSearchParams({response_type:'code',scope:'openid email profile onesa',client_id:config.clientId,
    redirect_uri:config.callback,code_challenge_method:'S256',code_challenge:challenge,state,nonce:random()});
  const pending:PendingOnesa={state,verifier,issuer:config.issuer,origin,language,expires:Date.now()+300_000};
  await SecureStore.setItemAsync(pendingKey,JSON.stringify(pending),options);
  try {
    const response = await openAuthSessionAsync(target.href + '?' + params, 'smartfarmer://onesa/callback');
    if (response.type === 'cancel' || response.type === 'dismiss') throw new Error('onesa_cancelled');
    if (response.type !== 'success') throw new Error('onesa_unavailable');
    return await redeemOnesa(response.url, origin);
  } finally {
    // Cold starts redeem from secure storage. Clear only the attempt owned by this sheet.
    const raw = await SecureStore.getItemAsync(pendingKey, options);
    if (raw && JSON.parse(raw).state === state) await SecureStore.deleteItemAsync(pendingKey, options);
  }
}

export async function redeemOnesa(incoming:string,origin:string):Promise<Session | null> {
  const raw=await SecureStore.getItemAsync(pendingKey,options);
  if(!raw)return null;
  const pending:PendingOnesa=JSON.parse(raw);
  const code=nativeCode(incoming,pending,origin);
  await SecureStore.deleteItemAsync(pendingKey,options);
  const reply=await createApi(origin).request<Omit<Session,'origin'>>('/v1/onesa/sessions','POST',
    {code,verifier:pending.verifier,language:pending.language});
  // Native storage supplies its own account-bound database key.
  return {origin,token:reply.token,userId:reply.userId,username:reply.username,language:reply.language,expiresAt:reply.expiresAt};
}
