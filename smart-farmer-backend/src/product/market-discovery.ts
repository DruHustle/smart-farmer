import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, type Context } from '../context.js';
import { uuid } from '../core.js';
import { publicSelect, publicWhere } from './market.js';

const list=z.object({limit:z.coerce.number().int().min(1).max(100).default(50)});
const category=z.enum(['produce','input','animal','equipment','other']);
const searchInput=z.object({
  id:uuid,query:z.string().trim().max(100).default(''),
  category:category.nullable().default(null),area:z.string().trim().max(150).default(''),
  currency:z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
  minPrice:z.number().finite().min(0).max(999999999).nullable().default(null),
  maxPrice:z.number().finite().min(0).max(999999999).nullable().default(null),
  condition:z.string().trim().max(100).default(''),notify:z.boolean().default(true)
}).strict().refine(v=>v.minPrice===null||v.maxPrice===null||v.minPrice<=v.maxPrice,'invalid_price_range')
  .refine(v=>!!(v.query||v.category||v.area||v.currency||v.condition||v.minPrice!==null||v.maxPrice!==null),'empty_search');
async function actor(ctx:Context,req:any,reply:any) {return ctx.user(req,reply);}
export function registerMarketDiscovery(app:FastifyInstance,ctx:Context) {
  app.get('/v1/market/favorites',async(req,reply)=>{
    const user=await actor(ctx,req,reply);if(!user)return;
    const q=list.parse(req.query);
    const r=await ctx.db.query(`${publicSelect} JOIN market_favorites f ON f.listing_id=l.id WHERE ${publicWhere} AND f.user_id=$1 ORDER BY f.created_at DESC LIMIT $2`,[user,q.limit]);
    return {items:r.rows};
  });
  app.put('/v1/market/favorites/:listingId',async(req,reply)=>{
    const user=await actor(ctx,req,reply);if(!user)return;
    const {listingId}=z.object({listingId:uuid}).parse(req.params);
    const exist=await ctx.db.query(`${publicSelect} WHERE ${publicWhere} AND l.id=$1`,[listingId]);
    if(!exist.rowCount)throw new ApiError('listing_unavailable',404);
    await ctx.db.query('INSERT INTO market_favorites(user_id,listing_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[user,listingId]);
    return {saved:true};
  });
  app.delete('/v1/market/favorites/:listingId',async(req,reply)=>{
    const user=await actor(ctx,req,reply);if(!user)return;
    const {listingId}=z.object({listingId:uuid}).parse(req.params);
    await ctx.db.query('DELETE FROM market_favorites WHERE user_id=$1 AND listing_id=$2',[user,listingId]);
    return reply.code(204).send();
  });
  app.get('/v1/market/saved-searches',async(req,reply)=>{
    const user=await actor(ctx,req,reply);if(!user)return;
    const r=await ctx.db.query('SELECT id,query,category,area,currency,min_price,max_price,condition_query,notify,created_at FROM market_saved_searches WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30',[user]);
    return {items:r.rows};
  });
  app.post('/v1/market/saved-searches',async(req,reply)=>{
    const user=await actor(ctx,req,reply);if(!user)return;
    const b=searchInput.parse(req.body);
    return ctx.transaction(async c=>{
      const count=await c.query('SELECT count(*)::int AS count FROM market_saved_searches WHERE user_id=$1',[user]);
      if(Number(count.rows[0].count)>=30)throw new ApiError('saved_search_limit',409);
      const created=await c.query('INSERT INTO market_saved_searches(id,user_id,query,category,area,currency,min_price,max_price,condition_query,notify) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,query,category,area,currency,min_price,max_price,condition_query,notify',[b.id,user,b.query,b.category,b.area,b.currency,b.minPrice,b.maxPrice,b.condition,b.notify]);
      return reply.code(201).send(created.rows[0]);
    });
  });
  app.patch('/v1/market/saved-searches/:searchId',async(req,reply)=>{
    const user=await actor(ctx,req,reply);if(!user)return;
    const {searchId}=z.object({searchId:uuid}).parse(req.params);
    const body=z.object({notify:z.boolean()}).strict().parse(req.body);
    const r=await ctx.db.query('UPDATE market_saved_searches SET notify=$3 WHERE user_id=$1 AND id=$2 RETURNING id,notify',[user,searchId,body.notify]);
    if(!r.rowCount)throw new ApiError('not_found',404);return r.rows[0];
  });
  app.delete('/v1/market/saved-searches/:searchId',async(req,reply)=>{
    const user=await actor(ctx,req,reply);if(!user)return;
    const {searchId}=z.object({searchId:uuid}).parse(req.params);
    await ctx.db.query('DELETE FROM market_saved_searches WHERE user_id=$1 AND id=$2',[user,searchId]);
    return reply.code(204).send();
  });
  app.get('/v1/market/follows',async(req,reply)=>{
    const user=await actor(ctx,req,reply);if(!user)return;
    const r=await ctx.db.query("SELECT f.farm_id AS id,s.name AS seller_name,f.created_at, (SELECT count(*)::int FROM market_listings l WHERE l.farm_id=f.farm_id AND l.status='active') AS listings FROM market_followed_sellers f JOIN farms s ON s.id=f.farm_id WHERE f.user_id=$1 ORDER BY f.created_at DESC LIMIT 100",[user]);
    return {items:r.rows};
  });
  app.put('/v1/market/follows/:sellerFarmId',async(req,reply)=>{
    const user=await actor(ctx,req,reply);if(!user)return;
    const {sellerFarmId}=z.object({sellerFarmId:uuid}).parse(req.params);
    const farm=await ctx.db.query('SELECT id FROM farms WHERE id=$1',[sellerFarmId]);
    if(!farm.rowCount)throw new ApiError('seller_not_found',404);
    if((await ctx.db.query('SELECT 1 FROM memberships WHERE farm_id=$1 AND user_id=$2',[sellerFarmId,user])).rowCount)
      throw new ApiError('cannot_follow_own_farm');
    await ctx.db.query('INSERT INTO market_followed_sellers(user_id,farm_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[user,sellerFarmId]);
    return {following:true};
  });
  app.delete('/v1/market/follows/:sellerFarmId',async(req,reply)=>{
    const user=await actor(ctx,req,reply);if(!user)return;
    const {sellerFarmId}=z.object({sellerFarmId:uuid}).parse(req.params);
    await ctx.db.query('DELETE FROM market_followed_sellers WHERE user_id=$1 AND farm_id=$2',[user,sellerFarmId]);
    return reply.code(204).send();
  });
  app.get('/v1/market/sellers/:sellerFarmId',async(req)=>{
    const {sellerFarmId}=z.object({sellerFarmId:uuid}).parse(req.params);
    const r=await ctx.db.query("SELECT f.id,f.name AS seller_name,(SELECT count(*)::int FROM market_listings l WHERE l.farm_id=f.id AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at>now())) AS active_listings FROM farms f WHERE f.id=$1",[sellerFarmId]);
    if(!r.rowCount)throw new ApiError('seller_not_found',404);
    return r.rows[0];
  });
  app.get('/v1/market/alerts',async(req,reply)=>{
    const user=await actor(ctx,req,reply);if(!user)return;
    const q=list.parse(req.query);
    const r=await ctx.db.query(`SELECT a.id,a.kind,a.created_at,a.read_at,l.id AS listing_id,l.title,l.price,l.currency,l.collection_area,f.name AS seller_name
      FROM market_discovery_alerts a JOIN market_listings l ON l.id=a.listing_id
      JOIN farms f ON f.id=l.farm_id LEFT JOIN stock_items s ON s.id=l.stock_item_id
      WHERE a.user_id=$1 AND ${publicWhere} ORDER BY a.created_at DESC LIMIT $2`,[user,q.limit]);
    return {items:r.rows};
  });
  app.post('/v1/market/alerts/:alertId/read',async(req,reply)=>{
    const user=await actor(ctx,req,reply);if(!user)return;
    const {alertId}=z.object({alertId:uuid}).parse(req.params);
    const r=await ctx.db.query('UPDATE market_discovery_alerts SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at',[alertId,user]);
    if(!r.rowCount)throw new ApiError('not_found',404);return r.rows[0];
  });
}
