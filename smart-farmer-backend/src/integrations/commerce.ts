import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {ApiError} from '../context.js';
import {uuid,managers,requireRow,operationLock,type Context} from './common.js';
import {registerMarket} from '../product/market.js';
import {registerServices} from '../product/services.js';
export function registerCommerce(app:FastifyInstance,ctx:Context){
 registerMarket(app,ctx);registerServices(app,ctx);
  app.post('/v1/reviews',async(req,reply)=>{
    const userId=await ctx.user(req,reply);if(!userId)return;
    const data=z.object({id:uuid,bookingId:uuid.optional(),orderId:uuid.optional(),rating:z.number().int().min(1).max(5),note:z.string().max(1000).default('')}).strict().refine(v=>!!v.bookingId!==!!v.orderId).parse(req.body);
    const replayed=await ctx.transaction(async(client)=>{
      await operationLock(client,`review:${userId}:${data.bookingId??data.orderId}`);
      if(data.orderId){const order=requireRow((await client.query("SELECT buyer_id FROM market_orders WHERE id=$1 AND status='fulfilled'",[data.orderId])).rows[0]);if(order.buyer_id!==userId)throw new ApiError('not_found',404);}
      if(data.bookingId){const booking=requireRow((await client.query("SELECT farm_id FROM service_bookings WHERE id=$1 AND status='completed'",[data.bookingId])).rows[0]);if(!await ctx.member(booking.farm_id,userId,managers))throw new ApiError('not_found',404);}
      const old=(await client.query('SELECT * FROM interaction_reviews WHERE id=$1 OR (actor_id=$2 AND (order_id=$3 OR booking_id=$4))',[data.id,userId,data.orderId??null,data.bookingId??null])).rows[0];
      if(old){if(old.id!==data.id||old.actor_id!==userId||old.rating!==data.rating||old.note!==data.note||old.booking_id!==(data.bookingId??null)||old.order_id!==(data.orderId??null))throw new ApiError('review_already_recorded',409);return true;}
      await client.query('INSERT INTO interaction_reviews(id,actor_id,booking_id,order_id,rating,note) VALUES($1,$2,$3,$4,$5,$6)',[data.id,userId,data.bookingId??null,data.orderId??null,data.rating,data.note]);return false;
    });return reply.code(replayed?200:201).send({id:data.id});
  });
}
