import type {Lang, SessionIdentity, Snapshot} from '../types';
import {apiOrigin, jsonBody, request} from './api';
import {Vault} from './vault';

export type OnesaConfig = {issuer: string; clientId: string; callback: string};
const key = 'smart-farmer:onesa:login';
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');

export async function beginOnesa(config: OnesaConfig, language: Lang) {
  if (config.callback !== location.origin + '/auth/onesa/callback') throw new Error('onesa_unavailable');
  const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
  const state = random(), verifier = random();
  const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const target = new URL(config.issuer+'/auth');
  target.search = new URLSearchParams({
    response_type:'code', scope:'openid email profile onesa', client_id:config.clientId,
    redirect_uri:config.callback, state, nonce:random(), code_challenge:challenge, code_challenge_method:'S256',
  }).toString();
  sessionStorage.setItem(key, JSON.stringify({state,verifier,issuer:config.issuer,language,expires:Date.now()+300_000}));
  location.assign(target.href);
}

export async function finishOnesa(url: URL): Promise<Vault> {
  const transaction = sessionStorage.getItem(key);
  sessionStorage.removeItem(key);
  if (!transaction) throw new Error('unauthorized');
  const saved = JSON.parse(transaction);
  const singleton = (name: string) => url.searchParams.getAll(name).length === 1 ? url.searchParams.get(name) : null;
  const code = singleton('code');
  if (!code || url.searchParams.has('error') || singleton('state') !== saved.state || saved.expires <= Date.now()
    || (url.searchParams.has('iss') && singleton('iss') !== saved.issuer)) throw new Error('unauthorized');
  const {vaultKey, ...identity} = await request<SessionIdentity & {vaultKey:string}>('/v1/onesa/sessions','',
    jsonBody({code,verifier:saved.verifier,language:saved.language}));
  const initial: Snapshot = {version:1,identity,farms:[],currentFarmId:'',data:{},outbox:[],language:identity.language};
  return Vault.unlock(apiOrigin, identity.username, vaultKey, initial);
}
