import { createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { ApiError } from './context.js';

const claim = 'https://onesa.eu/claims/';
const maxLifetime = 300;

export type ManagedIdentity = {
  audience: string;
  nativeClientId:string;
  accountIssuer: string;
  keys: ReturnType<typeof createLocalJWKSet>;
  keysExpire: number;
};

export function managedIdentity(env: NodeJS.ProcessEnv, issuer: URL, local: boolean): ManagedIdentity {
  if (issuer.href !== 'https://auth.onesa.eu/' && !(local && issuer.pathname === '/')) {
    throw new Error('Invalid managed Identity issuer');
  }
  const accountIssuer = env.ONESA_IDENTITY_ACCOUNT_ISSUER ?? 'https://portal.onesa.eu/api/v1/identity';
  const historic = new URL(accountIssuer);
  if (historic.pathname !== '/api/v1/identity' || historic.href !== historic.origin + historic.pathname ||
      historic.href !== 'https://portal.onesa.eu/api/v1/identity' && !(local && historic.origin === issuer.origin)) {
    throw new Error('Invalid historical Farmer account namespace');
  }
  const audience = env.ONESA_IDENTITY_AUDIENCE;
  const nativeClientId = env.ONESA_IDENTITY_NATIVE_CLIENT_ID;
  if (!nativeClientId || nativeClientId === env.ONESA_IDENTITY_CLIENT_ID) throw new Error('Missing distinct Farmer native public client');
  if (!audience || [env.ONESA_IDENTITY_CLIENT_ID,nativeClientId].includes(audience)) throw new Error('Missing dedicated Farmer API audience');
  const keysExpire = Number(env.ONESA_IDENTITY_JWKS_EXPIRES_AT);
  if (!Number.isSafeInteger(keysExpire) || keysExpire <= Math.floor(Date.now()/1000)) throw new Error('Invalid trusted signing-key expiry');
  const jwks = z.object({keys:z.array(z.object({
    kid:z.string().min(1), kty:z.literal('RSA'), n:z.string().min(1), e:z.string().min(1),
    use:z.literal('sig').optional(), alg:z.literal('RS256').optional(), d:z.never().optional(),
  })).min(1).max(8)}).parse(JSON.parse(env.ONESA_IDENTITY_JWKS ?? '{}'));
  if (new Set(jwks.keys.map(k => k.kid)).size !== jwks.keys.length) throw new Error('Ambiguous Identity signing keys');
  return {audience, nativeClientId, accountIssuer, keys:createLocalJWKSet(jwks), keysExpire};
}

type Config = {issuer:string; clientId:string; managed:ManagedIdentity};

async function verify(config:Config, raw:string, audience:string):Promise<JWTPayload> {
  if (config.managed.keysExpire <= Date.now()/1000) throw new ApiError('onesa_unavailable',503);
  try {
    const {payload,protectedHeader} = await jwtVerify(raw, config.managed.keys, {
      issuer:config.issuer, audience, algorithms:['RS256'], requiredClaims:['sub','iat','exp'],
    });
    if (!protectedHeader.kid || !payload.sub || !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) || payload.iat! > Date.now()/1000 + 5 || payload.exp! <= payload.iat!) throw Error();
    return payload;
  } catch { throw new ApiError('unauthorized',401); }
}

export async function managedAccount(config:Config, token:string, expectedId?:string) {
  const payload = await verify(config,token,config.managed.audience);
  const stable = z.uuid().safeParse(payload[claim+'user_id']);
  const products = z.array(z.string()).safeParse(payload[claim+'products']);
  const roles = z.array(z.string()).safeParse(payload[claim+'roles']);
  if (!stable.success || !products.success || !products.data.includes('farmer') || !roles.success ||
      !roles.data.some(r=>r==='user' || r==='admin') || expectedId && stable.data !== expectedId ||
      payload.exp! - payload.iat! > maxLifetime || payload.azp !== undefined && ![config.clientId,config.managed.nativeClientId].includes(String(payload.azp))) {
    throw new ApiError('unauthorized',401);
  }
  return {sub:stable.data, providerSubject:payload.sub!, client:payload.azp, mfaTime:payload[claim+'mfa_time'], exp:payload.exp!};
}

export async function checkIdentityToken(config:Config, token:string, nonce:string, providerSubject:string) {
  const payload = await verify(config,token,config.clientId);
  if (payload.nonce !== nonce || payload.sub !== providerSubject ||
      (Array.isArray(payload.aud) && payload.aud.length > 1 || payload.azp !== undefined) && payload.azp !== config.clientId) {
    throw new ApiError('unauthorized',401);
  }
}
