import type {FastifyInstance} from 'fastify';
import type {PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ApiError, audit, type Context, manageRoles} from './context.js';
import {hashPassword, verifyPassword, sha256, token} from './security.js';
import {idempotent} from './product/common.js';
import {NODE_RED_CAPABILITY} from './node-red/types.js';

const uuid=z.string().uuid();
const username=z.string().trim().min(3).max(80).regex(/^[a-zA-Z0-9._-]+$/).transform(s=>s.toLowerCase());
const password=z.string().min(12).max(128);
const language=z.enum(['sn','nd']);
const credentials=z.object({username,password});
const dummyPassword=hashPassword(token());
const farmParams=z.object({farmId:uuid});

async function lockMembershipChange(client:PoolClient,farmId:string,actorId:string,userId:string,nextRole:string|null) {
  // Serialize owner changes before checking the acting owner's current role.
  await client.query('SELECT id FROM farms WHERE id=$1 FOR NO KEY UPDATE',[farmId]);
  const target=await client.query(
    `SELECT role FROM memberships WHERE farm_id=$1 AND user_id=$2
     AND EXISTS (SELECT 1 FROM memberships WHERE farm_id=$1 AND user_id=$3 AND role='owner')
     FOR UPDATE`,[farmId,userId,actorId]
  );
  if(!target.rowCount)throw new ApiError('not_found',404);
  if(target.rows[0].role==='owner'&&nextRole!=='owner'){
    const otherOwner=await client.query("SELECT 1 FROM memberships WHERE farm_id=$1 AND user_id<>$2 AND role='owner' LIMIT 1",[farmId,userId]);
    if(!otherOwner.rowCount)throw new ApiError('last_owner',409);
  }
  return target.rows[0];
}

export function registerIdentity(app:FastifyInstance, ctx:Context) {
  const {db,user,member,transaction}=ctx;
  app.post('/v1/register',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(req,reply)=>{
    const b=credentials.extend({language,farmName:z.string().trim().min(1).max(100)}).strict().parse(req.body);
    const passwordHash=await hashPassword(b.password), recoveryCode=token();
    const result=await transaction(async client=>{
      const userId=randomUUID(),farmId=randomUUID();
      await client.query('INSERT INTO users(id,username,password_hash,language) VALUES($1,$2,$3,$4)',[userId,b.username,passwordHash,b.language]);
      await client.query('INSERT INTO farms(id,name,timezone) VALUES($1,$2,$3)',[farmId,b.farmName,'Africa/Harare']);
      await client.query("INSERT INTO memberships(user_id,farm_id,role) VALUES($1,$2,'owner')",[userId,farmId]);
      await client.query('INSERT INTO recovery_codes(user_id,token_hash) VALUES($1,$2)',[userId,sha256(recoveryCode)]);
      return {userId,farmId,recoveryCode};
    }).catch(error=>{if(error.code==='23505')throw new ApiError('username_unavailable',409);throw error;});
    return reply.code(201).send(result);
  });
  app.post('/v1/sessions',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
    const b=credentials.extend({deviceName:z.string().trim().max(80).default('Device')}).strict().parse(req.body);
    const result=await db.query('SELECT id,username,password_hash,language FROM users WHERE username=$1',[b.username]);
    const account=result.rows[0];
    const verified=await verifyPassword(b.password,account?.password_hash??await dummyPassword);
    if(!account||!verified)throw new ApiError('invalid_credentials',401);
    const value=token();
    const session=await transaction(async c=>{
      // A recovery must revoke logins that started while the old password was valid.
      const current=await c.query('SELECT password_hash FROM users WHERE id=$1 FOR SHARE',[account.id]);
      if(current.rows[0].password_hash!==account.password_hash)throw new ApiError('invalid_credentials',401);
      return c.query("INSERT INTO sessions(token_hash,user_id,expires_at,label) VALUES($1,$2,now()+interval '7 days',$3) RETURNING expires_at",[sha256(value),account.id,b.deviceName]);
    });
    reply.header('Cache-Control','no-store');
    return {token:value,userId:account.id,username:account.username,language:account.language,expiresAt:session.rows[0].expires_at};
  });
  app.get('/v1/me',async(req,reply)=>{const id=await user(req,reply);if(!id)return;const r=await db.query('SELECT id,username,language FROM users WHERE id=$1',[id]);return r.rows[0];});
  app.patch('/v1/me',async(req,reply)=>{const id=await user(req,reply);if(!id)return;const b=z.object({language}).strict().parse(req.body);const r=await db.query('UPDATE users SET language=$2 WHERE id=$1 RETURNING id,username,language',[id,b.language]);return r.rows[0];});
  app.get('/v1/sessions',async(req,reply)=>{
    const id=await user(req,reply);if(!id)return;
    const hash=sha256(req.headers.authorization!.slice(7));
    const r=await db.query('SELECT id,label,created_at,expires_at,(token_hash=$2) AS current FROM sessions WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC',[id,hash]);return {items:r.rows};
  });
  app.delete('/v1/sessions/current',async(req,reply)=>{const id=await user(req,reply);if(!id)return;await db.query('DELETE FROM sessions WHERE token_hash=$1',[sha256(req.headers.authorization!.slice(7))]);return reply.code(204).send();});
  app.delete('/v1/sessions/:sessionId',async(req,reply)=>{const id=await user(req,reply);if(!id)return;const {sessionId}=z.object({sessionId:uuid}).parse(req.params);await db.query('DELETE FROM sessions WHERE user_id=$1 AND id=$2',[id,sessionId]);return reply.code(204).send();});
  app.post('/v1/recovery-codes',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(req,reply)=>{
    const id=await user(req,reply);if(!id)return;const b=z.object({password}).strict().parse(req.body);
    const a=await db.query('SELECT password_hash FROM users WHERE id=$1',[id]);
    if(!await verifyPassword(b.password,a.rows[0].password_hash))throw new ApiError('invalid_credentials',401);
    const recoveryCode=token();
    await transaction(async c=>{
      const current=await c.query('SELECT password_hash FROM users WHERE id=$1 FOR SHARE',[id]);if(current.rows[0].password_hash!==a.rows[0].password_hash)throw new ApiError('invalid_credentials',401);
      await c.query('INSERT INTO recovery_codes(user_id,token_hash) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,created_at=now(),used_at=NULL',[id,sha256(recoveryCode)]);
    });
    reply.header('Cache-Control','no-store');return {recoveryCode};
  });
  app.post('/v1/recover',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(req,reply)=>{
    const b=z.object({username,password,recoveryCode:z.string().min(32).max(100)}).strict().parse(req.body);
    const newHash=await hashPassword(b.password);
    await transaction(async client=>{
      const u=await client.query('SELECT id FROM users WHERE username=$1 FOR UPDATE',[b.username]);if(!u.rowCount)throw new ApiError('invalid_recovery_code',400);const id=u.rows[0].id;
      const r=await client.query('SELECT user_id FROM recovery_codes WHERE user_id=$1 AND token_hash=$2 AND used_at IS NULL FOR UPDATE',[id,sha256(b.recoveryCode)]);
      if(!r.rowCount)throw new ApiError('invalid_recovery_code',400);
      await client.query('UPDATE users SET password_hash=$2 WHERE id=$1',[id,newHash]);
      await client.query('UPDATE recovery_codes SET used_at=now() WHERE user_id=$1',[id]);
      await client.query('DELETE FROM sessions WHERE user_id=$1',[id]);
      await audit(client,null,id,'user',id,'password_recovered','single_use_recovery_code');
    });
    return reply.code(204).send();
  });
  app.get('/v1/farms',async(req,reply)=>{const id=await user(req,reply);if(!id)return;const r=await db.query('SELECT f.id,f.name,f.timezone,m.role FROM farms f JOIN memberships m ON m.farm_id=f.id WHERE m.user_id=$1 ORDER BY f.name',[id]);return {items:r.rows,capabilities:[NODE_RED_CAPABILITY]};});
  app.post('/v1/farms',async(req,reply)=>{
    const actor = await user(req,reply);
    if (!actor) return;
    const body = z.object({id:uuid.optional(), name:z.string().trim().min(1).max(100), timezone:z.string().max(80).default('Africa/Harare')}).strict().parse(req.body);
    try { new Intl.DateTimeFormat('en',{timeZone:body.timezone}); } catch { throw new ApiError('invalid_timezone'); }
    const result = await idempotent(ctx, null, actor, body.id ?? randomUUID(),
      {operation:'create-farm', name:body.name, timezone:body.timezone}, async client => {
        const farmId = randomUUID();
        await client.query('INSERT INTO farms(id,name,timezone) VALUES($1,$2,$3)',[farmId,body.name,body.timezone]);
        await client.query("INSERT INTO memberships(user_id,farm_id,role) VALUES($1,$2,'owner')",[actor,farmId]);
        return {id:farmId};
      });
    if (result.replayed && !await member(result.body.id,actor)) throw new ApiError('not_found',404);
    return reply.code(result.replayed ? 200 : 201).send(result.body);
  });
  app.get('/v1/farms/:farmId/members',async(req,reply)=>{const id=await user(req,reply);if(!id)return;const {farmId}=farmParams.parse(req.params);if(!await member(farmId,id))throw new ApiError('not_found',404);const r=await db.query('SELECT u.id,u.username,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.farm_id=$1 ORDER BY u.username',[farmId]);return {items:r.rows};});
  app.post('/v1/farms/:farmId/invitations',async(req,reply)=>{
    const id=await user(req,reply);if(!id)return;const {farmId}=farmParams.parse(req.params);if(!await member(farmId,id,manageRoles))throw new ApiError('not_found',404);
    const b=z.object({role:z.enum(['manager','worker','adviser']),expiresInHours:z.number().int().min(1).max(168).default(72)}).strict().parse(req.body);
    if(b.role==='manager'&&!await member(farmId,id,['owner']))throw new ApiError('owner_required',403);
    const invitationId=randomUUID(),value=token(),expiresAt=new Date(Date.now()+b.expiresInHours*3_600_000).toISOString();
    await db.query('INSERT INTO invitations(id,farm_id,token_hash,role,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[invitationId,farmId,sha256(value),b.role,id,expiresAt]);
    reply.header('Cache-Control','no-store');return reply.code(201).send({id:invitationId,token:value,expiresAt});
  });
  app.get('/v1/farms/:farmId/invitations',async(req,reply)=>{const id=await user(req,reply);if(!id)return;const {farmId}=farmParams.parse(req.params);if(!await member(farmId,id,manageRoles))throw new ApiError('not_found',404);const q=z.object({limit:z.coerce.number().int().min(1).max(100).default(100),cursor:uuid.optional()}).parse(req.query);const r=await db.query('SELECT id,role,expires_at,accepted_at,created_at FROM invitations WHERE farm_id=$1 AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT $3',[farmId,q.cursor??null,q.limit+1]);return {items:r.rows.slice(0,q.limit),nextCursor:r.rows.length>q.limit?r.rows[q.limit-1].id:null};});
  app.delete('/v1/farms/:farmId/invitations/:invitationId',async(req,reply)=>{const id=await user(req,reply);if(!id)return;const {farmId,invitationId}=z.object({farmId:uuid,invitationId:uuid}).parse(req.params);if(!await member(farmId,id,manageRoles))throw new ApiError('not_found',404);await db.query('DELETE FROM invitations WHERE farm_id=$1 AND id=$2 AND accepted_at IS NULL',[farmId,invitationId]);return reply.code(204).send();});
  app.post('/v1/invitations/accept',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
    const b=z.object({token:z.string().length(43),username:username.optional(),password:password.optional(),language:language.optional()}).strict().parse(req.body);
    const existingUser=req.headers.authorization?await user(req,reply):null;if(req.headers.authorization&&!existingUser)return;
    if(!existingUser&&(!b.username||!b.password||!b.language))throw new ApiError('credentials_required');
    const newHash=existingUser?null:await hashPassword(b.password!),recoveryCode=existingUser?undefined:token();
    const result=await transaction(async client=>{
      const r=await client.query('SELECT * FROM invitations WHERE token_hash=$1 AND expires_at>now() AND accepted_at IS NULL FOR UPDATE',[sha256(b.token)]);
      if(!r.rowCount)throw new ApiError('invalid_invitation',400);const invitation=r.rows[0];
      const creator=await client.query('SELECT role FROM memberships WHERE user_id=$1 AND farm_id=$2',[invitation.created_by,invitation.farm_id]);
      if(!creator.rowCount||!manageRoles.includes(creator.rows[0].role)||(invitation.role==='manager'&&creator.rows[0].role!=='owner'))throw new ApiError('invalid_invitation',400);
      const userId=existingUser??randomUUID();
      if(!existingUser){await client.query('INSERT INTO users(id,username,password_hash,language) VALUES($1,$2,$3,$4)',[userId,b.username,newHash,b.language]);await client.query('INSERT INTO recovery_codes(user_id,token_hash) VALUES($1,$2)',[userId,sha256(recoveryCode!)]);}
      await client.query('INSERT INTO memberships(user_id,farm_id,role) VALUES($1,$2,$3) ON CONFLICT(user_id,farm_id) DO NOTHING',[userId,invitation.farm_id,invitation.role]);
      await client.query('UPDATE invitations SET accepted_by=$2,accepted_at=now() WHERE id=$1',[invitation.id,userId]);
      await audit(client,invitation.farm_id,userId,'membership',userId,'invitation_accepted','single_use_invitation');
      return {userId,farmId:invitation.farm_id,...(recoveryCode?{recoveryCode}:{})};
    }).catch(error=>{if(error.code==='23505')throw new ApiError('username_unavailable',409);throw error;});
    return reply.code(201).send(result);
  });
  app.patch('/v1/farms/:farmId/members/:userId',async(req,reply)=>{
    const id=await user(req,reply);if(!id)return;const {farmId,userId}=z.object({farmId:uuid,userId:uuid}).parse(req.params);if(!await member(farmId,id,['owner']))throw new ApiError('not_found',404);
    const b=z.object({role:z.enum(['owner','manager','worker','adviser'])}).strict().parse(req.body);
    await transaction(async c=>{
      const previous=await lockMembershipChange(c,farmId,id,userId,b.role);
      await c.query('UPDATE memberships SET role=$3 WHERE farm_id=$1 AND user_id=$2',[farmId,userId,b.role]);
      await audit(c,farmId,id,'membership',userId,'role_changed','owner_review',previous,b);
    });return {userId,role:b.role};
  });
  app.delete('/v1/farms/:farmId/members/:userId',async(req,reply)=>{
    const id=await user(req,reply);if(!id)return;const {farmId,userId}=z.object({farmId:uuid,userId:uuid}).parse(req.params);if(!await member(farmId,id,['owner']))throw new ApiError('not_found',404);
    await transaction(async c=>{
      await lockMembershipChange(c,farmId,id,userId,null);
      const assignment=[farmId,userId];
      await c.query('UPDATE project_plans SET assignee_id=NULL,version=version+1 WHERE farm_id=$1 AND assignee_id=$2',assignment);
      await c.query('UPDATE tasks SET assignee_id=NULL,version=version+1 WHERE farm_id=$1 AND assignee_id=$2',assignment);
      await c.query('UPDATE incidents SET assignee_id=NULL,version=version+1 WHERE farm_id=$1 AND assignee_id=$2',assignment);
      await c.query("UPDATE asset_maintenance SET assignee_id=NULL,version=version+1 WHERE farm_id=$1 AND assignee_id=$2 AND status='planned'",assignment);
      await c.query('UPDATE assets SET responsible_id=NULL,version=version+1 WHERE farm_id=$1 AND responsible_id=$2',assignment);
      await c.query('DELETE FROM memberships WHERE farm_id=$1 AND user_id=$2',assignment);
      await c.query('DELETE FROM invitations WHERE farm_id=$1 AND created_by=$2 AND accepted_at IS NULL',assignment);
      await audit(c,farmId,id,'membership',userId,'access_revoked','owner_review');
    });return reply.code(204).send();
  });
}
