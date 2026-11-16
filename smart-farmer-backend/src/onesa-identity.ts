import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, type Context } from './context.js';
import { sha256, token } from './security.js';

import { managedAccount, managedIdentity, checkIdentityToken, type ManagedIdentity } from './managed-identity.js';

type Config = { issuer: string; clientId: string; secret: string; callback: string; accountIssuer:string; managed?:ManagedIdentity };

export function identityConfig(origin: string, env = process.env): Config | null {
  if (env.ONESA_IDENTITY_ENABLED !== 'true') return null;
  const issuer = env.ONESA_IDENTITY_ISSUER ?? '';
  const clientId = env.ONESA_IDENTITY_CLIENT_ID ?? '';
  const secret = env.ONESA_IDENTITY_CLIENT_SECRET ?? '';
  const account = new URL(issuer);
  const web = new URL(origin);
  const loopback = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const local = loopback(account) && loopback(web);
  const mode = env.ONESA_IDENTITY_MODE || 'portal';
  if (!['portal','managed'].includes(mode)) throw new Error('Invalid Onesa Identity mode');
  const managed = mode === 'managed' ? managedIdentity(env,account,local) : undefined;
  if (![account, web].every(u => (u.protocol === 'https:' || (local && u.protocol === 'http:')) && !u.username && !u.password && !u.search && !u.hash)
    || !managed && account.pathname !== '/api/v1/identity' || account.href !== issuer || web.origin !== origin
    || !clientId || clientId.length > 200 || secret.length < 32) {
    throw new Error('Invalid Onesa Identity configuration');
  }
  return { issuer, clientId, secret, managed, accountIssuer:managed?.accountIssuer ?? issuer, callback: origin + '/auth/onesa/callback' };
}

async function provider(config: Config, path: string, body: URLSearchParams | { token: string }, publicClient = false) {
  const form = body instanceof URLSearchParams;
  const encode = (s: string) => new URLSearchParams({v:s}).toString().slice(2);
  const basic = Buffer.from(encode(config.clientId) + ':' + encode(config.secret)).toString('base64');
  try {
    const response = await fetch(config.issuer + path, {
      method: 'POST', signal: AbortSignal.timeout(5000), redirect: 'error',
      headers: { ...(!publicClient && {Authorization: 'Basic ' + basic}), Accept: 'application/json', 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? body : JSON.stringify(body),
    });
    if ([400,401,403].includes(response.status)) throw new ApiError('unauthorized',401);
    if (response.status !== 200 || !response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65_536) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('onesa_unavailable',503);
  }
}

export async function currentFarmerAccount(config: Config, grant: string, expectedSubject?: string) {
  if (config.managed) return managedAccount({...config,managed:config.managed},grant,expectedSubject);
  const raw = await provider(config, '/session', {token:grant});
  const result = z.object({
    active:z.literal(true), iss:z.literal(config.issuer), aud:z.literal(config.clientId), sub:z.uuid(),
    email_verified:z.literal(true), exp:z.number().int(), auth_time:z.number().int().positive(),
    amr:z.array(z.string()), onesa_roles:z.array(z.string()),
    onesa_applications:z.array(z.string()), onesa_product_roles:z.object({farmer:z.enum(['user','admin'])}),
  }).safeParse(raw);
  const now = Math.floor(Date.now()/1000);
  if (!result.success) throw new ApiError('unauthorized',401);
  const claims = result.data;
  if ((expectedSubject && claims.sub !== expectedSubject) || claims.exp <= now || claims.exp > now+86400 ||
      claims.auth_time > now+30 || !claims.onesa_applications.includes('farmer')) throw new ApiError('unauthorized',401);
  const globalAdmin = claims.onesa_roles.includes('global_admin');
  if (globalAdmin !== (claims.onesa_product_roles.farmer === 'admin') ||
      (globalAdmin && !claims.amr.some(method => method === 'otp' || method === 'mfa'))) throw new ApiError('unauthorized',401);
  return claims;
}

// The database has only the local token's hash. Decryption requires the high-entropy
// local bearer presented by this client on this particular session.
function sealGrant(value: string, bearer: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(bearer,'base64url'), iv);
  const data = Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64url');
}

export function openGrant(value: string, bearer: string) {
  try {
    const data = Buffer.from(value,'base64url');
    const cipher = createDecipheriv('aes-256-gcm',Buffer.from(bearer,'base64url'),data.subarray(0,12));
    cipher.setAuthTag(data.subarray(12,28));
    return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');
  } catch { throw new ApiError('unauthorized',401); }
}

export function registerOnesa(app: FastifyInstance, ctx: Context, config: Config | null, localCredentials: boolean) {
  app.get('/v1/onesa/config', async () => ({
    ...(config ? {issuer:config.issuer, clientId:config.clientId, callback:config.callback, ...(config.managed && {audience:config.managed.audience,nativeClientId:config.managed.nativeClientId})} : {enabled:false}),
    ...(localCredentials ? {local_credentials:true} : {}),
  }));
  app.post('/v1/onesa/sessions', {config:{rateLimit:{max:12,timeWindow:'1 minute'}}}, async req => {
    if (!config) throw new ApiError('onesa_unavailable',503);
    const input = z.object({code:z.string().min(1).max(4096),verifier:z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),language:z.enum(['sn','nd']), native:z.literal(true).optional(), nonce:z.string().regex(/^[A-Za-z0-9_-]{43,128}$/).optional()}).strict().parse(req.body);
    if (config.managed && !input.nonce) throw new ApiError('unauthorized',401);
    const native = Boolean(config.managed && input.native);
    const clientId = native ? config.managed!.nativeClientId : config.clientId;
    const reply = await provider(config, config.managed ? 'oauth/token' : '/token', new URLSearchParams({
      ...(native && {client_id:clientId}), grant_type:'authorization_code', code:input.code, code_verifier:input.verifier, redirect_uri:config.callback,
    }), native);
    const exchange = z.object({token_type:z.string(), access_token:z.string().min(20).max(16384), id_token:z.string().max(16384).optional()}).safeParse(reply);
    if (!exchange.success || exchange.data.token_type.toLowerCase() !== 'bearer') throw new ApiError('onesa_unavailable',503);
    const grant = exchange.data.access_token;
    const claims = await currentFarmerAccount(config, grant);
    if (config.managed) {
      if (!exchange.data.id_token || !input.nonce || !('providerSubject' in claims) || claims.client !== undefined && claims.client !== clientId) throw new ApiError('unauthorized',401);
      await checkIdentityToken({...config,clientId,managed:config.managed}, exchange.data.id_token, input.nonce, claims.providerSubject);
    }
    const value = token();
    return ctx.transaction(async client => {
      const id = randomUUID();
      // The '+' is outside the local username grammar. No email-based linking.
      const account = await client.query(`
        INSERT INTO users(id,username,password_hash,language,onesa_issuer,onesa_subject,onesa_vault_key)
        VALUES($1,$2,'!',$3,$4,$5,$6) ON CONFLICT (onesa_issuer,onesa_subject) DO UPDATE
        SET onesa_subject=excluded.onesa_subject RETURNING id,username,language,onesa_vault_key`,
        [id,'onesa+'+id,input.language,config.accountIssuer,claims.sub,token()]);
      const user = account.rows[0];
      const session = await client.query(`INSERT INTO sessions(token_hash,user_id,expires_at,label,onesa_grant,onesa_token_issuer)
        VALUES($1,$2,to_timestamp($3),'Onesa',$4,$5) RETURNING expires_at`,[sha256(value),user.id,claims.exp,sealGrant(grant,value),config.issuer]);
      return {token:value,userId:user.id,username:user.username,language:user.language,expiresAt:session.rows[0].expires_at,vaultKey:user.onesa_vault_key};
    });
  });
}
