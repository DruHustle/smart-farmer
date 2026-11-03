import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, resolve, sep} from 'node:path';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {ApiError,audit} from '../context.js';
import {authorize, managers, recorders, requireRow, uuid, type Context} from './common.js';

export interface ObjectStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

/** Private development/persistent-volume adapter. Never mounted as a public static directory. */
export class FileObjectStore implements ObjectStore {
  readonly root: string;
  constructor(root=process.env.MEDIA_ROOT || '.data/media') {this.root=resolve(root);}
  private path(key: string) {
    if(!/^[0-9a-f-]{36}\/[0-9a-f-]{36}-[0-9a-f]{64}$/.test(key))throw new Error('Invalid object key');
    const path=resolve(this.root,key);if(!path.startsWith(this.root+sep))throw new Error('Invalid object key');return path;
  }
  async put(key: string,data: Buffer) {
    const path=this.path(key);await mkdir(dirname(path),{recursive:true,mode:0o700});
    const temporary=`${path}.${randomUUID()}.tmp`;
    try{await writeFile(temporary,data,{flag:'wx',mode:0o600});await rename(temporary,path);}finally{await rm(temporary,{force:true});}
  }
  get(key: string) {return readFile(this.path(key));}
}

const mime=z.enum(['image/jpeg','image/png','image/webp','audio/mp4','audio/mpeg','audio/webm','audio/wav']);
function validSignature(type: z.infer<typeof mime>,data: Buffer) {
  if(data.length<12)return false;
  switch(type){
    case 'image/jpeg': return data[0]===255&&data[1]===216&&data[2]===255;
    case 'image/png': return data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    case 'image/webp': return data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP';
    case 'audio/mp4': return data.toString('ascii',4,8)==='ftyp';
    case 'audio/mpeg': return data.toString('ascii',0,3)==='ID3'||(data[0]===255&&(data[1]&224)===224);
    case 'audio/webm': return data.subarray(0,4).equals(Buffer.from([26,69,223,163]));
    case 'audio/wav': return data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WAVE';
  }
}
export function registerMedia(app: FastifyInstance,ctx: Context) {
  const store=new FileObjectStore();
  app.post('/v1/farms/:farmId/media',{bodyLimit:7_100_000,config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async(req,reply)=>{
    const auth=await authorize(ctx,req,reply,recorders);if(!auth)return;
    const data=z.object({id:uuid,activityId:uuid,mimeType:mime,dataBase64:z.string().min(1).max(6_990_508),filename:z.string().trim().min(1).max(150).regex(/^[^\x00-\x1f/\\]+$/).default('attachment')}).strict().parse(req.body);
    const bytes=Buffer.from(data.dataBase64,'base64');
    if(bytes.length>5*1024*1024||bytes.toString('base64')!==data.dataBase64||!validSignature(data.mimeType,bytes))throw new ApiError('invalid_media');
    const fingerprint=createHash('sha256').update(bytes).digest('hex');
    const result=await ctx.transaction(async(client)=>{
      await client.query('SELECT id FROM farms WHERE id=$1 FOR UPDATE',[auth.farmId]);
      const previous=(await client.query('SELECT * FROM private_media WHERE id=$1',[data.id])).rows[0];
      if(previous){if(previous.farm_id!==auth.farmId||previous.actor_id!==auth.userId||previous.activity_id!==data.activityId||previous.mime_type!==data.mimeType||previous.content_hash!==fingerprint||previous.filename!==data.filename)throw new ApiError('idempotency_conflict',409);return true;}
      const activity=requireRow((await client.query('SELECT actor_id FROM activities WHERE farm_id=$1 AND id=$2',[auth.farmId,data.activityId])).rows[0]);
      if(activity.actor_id!==auth.userId&&!await ctx.member(auth.farmId,auth.userId,managers))throw new ApiError('not_found',404);
      const used=Number((await client.query('SELECT COALESCE(sum(size_bytes),0) AS bytes FROM private_media WHERE farm_id=$1',[auth.farmId])).rows[0].bytes);
      const quota=Number(process.env.MEDIA_FARM_QUOTA_BYTES||262144000);
      if(!Number.isSafeInteger(quota)||quota<1)throw new Error('Invalid MEDIA_FARM_QUOTA_BYTES');
      if(used+bytes.length>quota)throw new ApiError('media_quota_exceeded',409);
      const key=`${auth.farmId}/${data.id}-${fingerprint}`;
      await store.put(key,bytes);
      await client.query('INSERT INTO private_media(id,farm_id,activity_id,actor_id,mime_type,size_bytes,content_hash,object_key,filename) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[data.id,auth.farmId,data.activityId,auth.userId,data.mimeType,bytes.length,fingerprint,key,data.filename]);
      return false;
    });
    return reply.code(result?200:201).send({id:data.id,activityId:data.activityId,mimeType:data.mimeType,sizeBytes:bytes.length,status:'stored'});
  });
  app.get('/v1/farms/:farmId/media',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply);if(!auth)return;
    const query=z.object({activityId:uuid.optional()}).parse(req.query);
    const canFinance=await ctx.member(auth.farmId,auth.userId,managers);
    return {items:(await ctx.db.query("SELECT m.id,m.activity_id,m.mime_type,m.size_bytes,m.filename,m.created_at FROM private_media m JOIN activities a ON a.farm_id=m.farm_id AND a.id=m.activity_id WHERE m.farm_id=$1 AND ($2::uuid IS NULL OR m.activity_id=$2) AND ($3::boolean OR a.kind<>'cost') ORDER BY m.created_at DESC LIMIT 100",[auth.farmId,query.activityId??null,canFinance])).rows};
  });
  app.get('/v1/farms/:farmId/media/:mediaId/content',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply);if(!auth)return;const {mediaId}=z.object({mediaId:uuid}).parse(req.params);
    const media=requireRow((await ctx.db.query('SELECT m.*,a.kind FROM private_media m JOIN activities a ON a.farm_id=m.farm_id AND a.id=m.activity_id WHERE m.farm_id=$1 AND m.id=$2',[auth.farmId,mediaId])).rows[0]);
    if(media.kind==='cost'&&!await ctx.member(auth.farmId,auth.userId,managers))throw new ApiError('not_found',404);
    let bytes:Buffer;
    try{bytes=await store.get(media.object_key);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new ApiError('media_unavailable',503);throw error;}
    if(createHash('sha256').update(bytes).digest('hex')!==media.content_hash)throw new ApiError('media_integrity_error',503);
    await ctx.transaction(async client=>{await audit(client,auth.farmId,auth.userId,'media',mediaId,'content_accessed','authorised_private_download');});
    return reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"default-src 'none'; sandbox").header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(media.filename)}`).type(media.mime_type).send(bytes);
  });
}
