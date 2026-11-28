import {createHmac, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {z} from 'zod';
import {ApiError, audit, type Context} from '../context.js';
import {authorize, uuid, instant, hash, operationLock, requireRow, lockFarmMembership} from '../integrations/common.js';
import {sealSecret, openSecret, digest, secretConfigured} from '../operations/common.js';

const roles=['owner','manager','worker'];
const ready=()=>secretConfigured()&&/^[a-f0-9]{64}$/i.test(process.env.BASIC_PHONE_WEBHOOK_SECRET??'');
const envelope=z.object({id:z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/),channel:z.enum(['sms','ussd']),from:z.string().regex(/^\+[1-9]\d{7,14}$/),sessionId:z.string().max(120).default(''),text:z.string().trim().max(700),timestamp:instant}).strict();
export type PhoneEnvelope=z.infer<typeof envelope>;
/** The provider signs this exact JSON array. Keep field order stable. */
export function phoneSignature(body:PhoneEnvelope,secret:string){return createHmac('sha256',Buffer.from(secret,'hex')).update(JSON.stringify([body.id,body.channel,body.from,body.sessionId,body.text,body.timestamp])).digest('hex');}
export function phoneCommand(text:string,channel:string){
  if(channel==='sms')return text.trim();
  const values=text.split('*');
  if(!text)return 'MENU';
  if(values[0]==='1')return values.length>1?'RAIN '+values[1]:'PROMPT_RAIN';
  if(values[0]==='2')return values.length>1?'NOTE '+values.slice(1).join(' '):'PROMPT_NOTE';
  if(values[0]==='3')return 'ALERTS';
  if(values[0]==='4')return 'STATUS';
  if(values[0]==='0')return 'STOP';
  return text;
}
const answer=(message:string,continueSession=false)=>({message,continueSession});

export function registerBasicPhone(app:FastifyInstance,ctx:Context){
  app.get('/v1/farms/:farmId/basic-phone',async(req,reply)=>{
    const a=await authorize(ctx,req,reply);if(!a)return;
    const channels=(await ctx.db.query("SELECT id,channel,masked_address,verified_at,disabled_at FROM notification_channels WHERE user_id=$1 AND channel='sms' AND verified_at IS NOT NULL AND disabled_at IS NULL ORDER BY created_at DESC",[a.userId])).rows;
    const link=(await ctx.db.query('SELECT id,expires_at AS "expiresAt",access_expires_at AS "accessExpiresAt",linked_at AS "linkedAt",revoked_at AS "revokedAt",project_id AS "projectId" FROM farm_phone_links WHERE farm_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1',[a.farmId,a.userId])).rows[0]??null;
    return {configured:ready(),provider:ready()?'signed_gateway':'unconfigured',channels,link,commands:['LINK <code>','RAIN <millimetres>','NOTE <observation>','ALERTS','STATUS','STOP'],requirements:['operator_sms_or_ussd_number','signed_provider_webhook','verified_sms_channel','current_onesa_session','explicit_link_consent'],delivery:'Provider replies are returned to the configured gateway; no SMS is sent by this endpoint.'};
  });
  app.post('/v1/farms/:farmId/basic-phone/link',async(req,reply)=>{
    const a=await authorize(ctx,req,reply,roles);if(!a)return;
    const b=z.object({id:uuid,channelId:uuid,projectId:uuid,consent:z.literal(true)}).strict().parse(req.body);
    if(!ready())throw new ApiError('basic_phone_unconfigured',409);
    const bearer=req.headers.authorization!.slice(7),sessionHash=digest(bearer);
    return ctx.transaction(async c=>{
      await lockFarmMembership(c,a.farmId,a.userId,roles);await operationLock(c,'phone-link:'+b.id);
      const old=(await c.query('SELECT * FROM farm_phone_links WHERE id=$1',[b.id])).rows[0];
      if(old){
        if(old.farm_id!==a.farmId||old.user_id!==a.userId||old.payload_hash!==hash(b)||old.session_hash!==sessionHash)throw new ApiError('idempotency_conflict',409);
        if(old.revoked_at||new Date(old.expires_at).getTime()<=Date.now())throw new ApiError('phone_link_expired',409);
        return {id:old.id,code:openSecret(old.code_cipher,'phone-code:'+old.id),expiresAt:old.expires_at};
      }
      const channel=requireRow((await c.query("SELECT id FROM notification_channels WHERE id=$1 AND user_id=$2 AND channel='sms' AND verified_at IS NOT NULL AND disabled_at IS NULL FOR SHARE",[b.channelId,a.userId])).rows[0]);
      requireRow((await c.query('SELECT id FROM projects WHERE farm_id=$1 AND id=$2',[a.farmId,b.projectId])).rows[0]);
      const session=requireRow((await c.query('SELECT expires_at FROM sessions WHERE user_id=$1 AND token_hash=$2 AND expires_at>now()',[a.userId,sessionHash])).rows[0]);
      await operationLock(c,'phone-channel:'+channel.id);
      await c.query('UPDATE farm_phone_links SET revoked_at=now() WHERE channel_id=$1 AND revoked_at IS NULL',[channel.id]);
      const code=randomBytes(6).toString('hex').toUpperCase();
      const row=(await c.query(`INSERT INTO farm_phone_links(id,farm_id,user_id,channel_id,project_id,code_hash,code_cipher,session_cipher,session_hash,expires_at,access_expires_at,payload_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,least(now()+interval '10 minutes',$10),$10,$11) RETURNING id,expires_at`,[b.id,a.farmId,a.userId,b.channelId,b.projectId,digest(code),sealSecret(code,'phone-code:'+b.id),sealSecret(bearer,'phone-session:'+b.id),sessionHash,session.expires_at,hash(b)])).rows[0];
      await audit(c,a.farmId,a.userId,'basic_phone',b.id,'link_requested','explicit_member_consent');
      reply.code(201);return {id:row.id,code,expiresAt:row.expires_at};
    });
  });
  app.delete('/v1/farms/:farmId/basic-phone/link',async(req,reply)=>{
    const a=await authorize(ctx,req,reply);if(!a)return;
    await ctx.transaction(async c=>{await lockFarmMembership(c,a.farmId,a.userId);await c.query('UPDATE farm_phone_links SET revoked_at=now() WHERE farm_id=$1 AND user_id=$2 AND revoked_at IS NULL',[a.farmId,a.userId]);await audit(c,a.farmId,a.userId,'basic_phone',a.farmId,'revoked','member_request');});
    return reply.code(204).send();
  });
  app.post('/v1/integrations/basic-phone',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async(req,reply)=>{
    if(!ready())throw new ApiError('basic_phone_unconfigured',503);
    const b=envelope.parse(req.body),signature=req.headers['x-farmer-signature'];
    if(typeof signature!=='string'||!/^[a-f0-9]{64}$/i.test(signature)||!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(phoneSignature(b,process.env.BASIC_PHONE_WEBHOOK_SECRET!),'hex')))throw new ApiError('unauthorized',401);
    if(Math.abs(Date.now()-Date.parse(b.timestamp))>300_000)throw new ApiError('expired_provider_request',401);
    const command=phoneCommand(b.text,b.channel),linkMatch=/^LINK ([A-F0-9]{12})$/i.exec(command);
    const link=(await ctx.db.query(`SELECT l.* FROM farm_phone_links l JOIN notification_channels c ON c.id=l.channel_id
      WHERE c.channel='sms' AND c.address_hash=$1 AND c.verified_at IS NOT NULL AND c.disabled_at IS NULL
      AND l.revoked_at IS NULL AND l.access_expires_at>now()
      AND ($2::text IS NULL AND l.linked_at IS NOT NULL OR $2::text IS NOT NULL AND l.code_hash=$2 AND l.expires_at>now())
      ORDER BY l.created_at DESC LIMIT 1`,[digest(b.from),linkMatch?digest(linkMatch[1].toUpperCase()):null])).rows[0];
    if(!link)return answer('Open Smart Farmer, verify your phone number and request a new phone-access code. Send LINK followed by that code.');
    // A linked phone does not bypass Onesa: recheck the original live session and
    // current central product grant on every request, including provider replays.
    const bearer=openSecret(link.session_cipher,'phone-session:'+link.id);
    const authRequest={headers:{authorization:'Bearer '+bearer}} as FastifyRequest;
    const authReply={code(){return this;},send(){return this;}} as unknown as FastifyReply;
    const userId=await ctx.user(authRequest,authReply);
    if(!userId||userId!==link.user_id)return answer('Phone access expired. Sign in to Smart Farmer and link your phone again.');
    return ctx.transaction(async c=>{
      await operationLock(c,'phone-address:'+digest(b.from));
      await lockFarmMembership(c,link.farm_id,userId,roles);
      const live=await c.query('SELECT id FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()',[link.session_hash,userId]);
      if(!live.rowCount)throw new ApiError('unauthorized',401);
      requireRow((await c.query("SELECT id FROM notification_channels WHERE id=$1 AND user_id=$2 AND address_hash=$3 AND channel='sms' AND verified_at IS NOT NULL AND disabled_at IS NULL FOR SHARE",[link.channel_id,userId,digest(b.from)])).rows[0]);
      await operationLock(c,'phone-channel:'+link.channel_id);
      const current=requireRow((await c.query('SELECT id,linked_at FROM farm_phone_links WHERE id=$1 AND revoked_at IS NULL AND access_expires_at>now() AND ($2::text IS NULL OR (code_hash=$2 AND expires_at>now())) FOR UPDATE',[link.id,linkMatch?digest(linkMatch[1].toUpperCase()):null])).rows[0]);
      await operationLock(c,'phone-request:'+b.id);
      const payloadHash=hash(b),previous=(await c.query('SELECT * FROM farm_phone_requests WHERE request_id=$1',[b.id])).rows[0];
      if(previous){if(previous.payload_hash!==payloadHash||previous.link_id!==current.id)throw new ApiError('idempotency_conflict',409);return previous.response;}
      let response:ReturnType<typeof answer>;
      if(linkMatch&&current.linked_at)response=answer('This code has already linked your phone. Send RAIN, NOTE, ALERTS, STATUS or STOP.');
      else if(linkMatch){
        // One explicit current binding per physical number prevents a shared
        // phone's records from being silently routed to another user's farm.
        await c.query('UPDATE farm_phone_links SET revoked_at=now() WHERE id<>$1 AND revoked_at IS NULL AND channel_id IN (SELECT id FROM notification_channels WHERE channel=\'sms\' AND address_hash=$2)',[link.id,digest(b.from)]);
        await c.query('UPDATE farm_phone_links SET linked_at=coalesce(linked_at,now()) WHERE id=$1',[link.id]);response=answer('Phone linked. Send RAIN 12.5, NOTE your observation, ALERTS, STATUS or STOP.');
      }
      else if(command==='MENU')response=answer('Smart Farmer\n1 Record rain\n2 Record note\n3 Alerts\n4 Status\n0 Stop phone access',true);
      else if(command==='PROMPT_RAIN')response=answer('Enter measured rainfall in millimetres (for example 12.5).',true);
      else if(command==='PROMPT_NOTE')response=answer('Enter your field observation.',true);
      else if(command.toUpperCase()==='STOP'){
        await c.query('UPDATE farm_phone_links SET revoked_at=now() WHERE id=$1',[link.id]);
        await c.query('UPDATE notification_channels SET disabled_at=now() WHERE id=$1',[link.channel_id]);
        await c.query('UPDATE notification_preferences SET sms=false WHERE user_id=$1',[userId]);
        await c.query("UPDATE notification_deliveries SET state='cancelled',updated_at=now() WHERE channel_id=$1 AND state IN ('pending','unconfigured','failed')",[link.channel_id]);
        response=answer('Phone record access and SMS alerts stopped. Re-enable your verified channel in Smart Farmer to use them again.');
      }else if(/^RAIN /i.test(command)){
        const raw=command.slice(5).trim(),value=Number(raw);
        if(!/^\d+(\.\d{1,3})?$/.test(raw)||!Number.isFinite(value)||value<0||value>2000)response=answer('Enter measured rain from 0 to 2000 mm, for example RAIN 12.5.');
        else{
          await c.query("INSERT INTO weather_observations(id,farm_id,actor_id,kind,value,unit,source,note,observed_at,payload_hash) VALUES($1,$2,$3,'rainfall',$4,'mm','manual',$5,$6,$7)",[randomUUID(),link.farm_id,userId,value,'Recorded through verified '+b.channel,b.timestamp,payloadHash]);
          response=answer(`Recorded measured rain: ${value} mm. This is a field measurement, not a forecast.`);
        }
      }else if(/^NOTE /i.test(command)){
        const value=command.slice(5).trim();
        if(!value)response=answer('Write an observation after NOTE.');
        else{
          await c.query("INSERT INTO project_records(id,farm_id,project_id,actor_id,type,observed_at,note,details) VALUES($1,$2,$3,$4,'husbandry',$5,$6,$7)",[randomUUID(),link.farm_id,link.project_id,userId,b.timestamp,value,{source:'verified_'+b.channel,observationOnly:true}]);
          response=answer('Field observation recorded. No stock, money or equipment was changed.');
        }
      }else if(command.toUpperCase()==='ALERTS'){
        const alerts=(await c.query(`SELECT n.message_key,n.arguments,n.created_at FROM notifications n
          WHERE n.farm_id=$1 AND n.user_id=$2 AND n.acknowledged_at IS NULL AND n.available_at<=now()
          AND (n.kind<>'camera' OR EXISTS(SELECT 1 FROM camera_events e JOIN memberships m ON m.farm_id=e.farm_id AND m.user_id=n.user_id
            WHERE e.id=n.entity_id AND (m.role IN ('owner','manager') OR EXISTS(SELECT 1 FROM camera_access ca WHERE ca.asset_id=e.asset_id AND ca.user_id=n.user_id))))
          ORDER BY n.created_at DESC LIMIT 3`,[link.farm_id,userId])).rows;
        response=answer(alerts.length?alerts.map(row=>String(row.arguments?.title??row.message_key).slice(0,100)).join('\n'):'No unacknowledged alerts.');
      }else if(command.toUpperCase()==='STATUS'){
        const tasks=(await c.query("SELECT count(*)::int AS count FROM tasks WHERE farm_id=$1 AND project_id=$2 AND status NOT IN ('completed','cancelled')",[link.farm_id,link.project_id])).rows[0];
        response=answer(`Phone connected. Open project tasks: ${tasks.count}. Access ends ${new Date(link.access_expires_at).toISOString().slice(0,16)} UTC.`);
      }else response=answer('Commands: RAIN <mm>, NOTE <observation>, ALERTS, STATUS, STOP.');
      await c.query('INSERT INTO farm_phone_requests(request_id,link_id,payload_hash,response) VALUES($1,$2,$3,$4)',[b.id,link.id,payloadHash,response]);
      await audit(c,link.farm_id,userId,'basic_phone',link.id,'command_processed',command.split(' ')[0].slice(0,20));
      return response;
    });
  });
}
