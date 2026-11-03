import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {ApiError} from '../context.js';
import {assertReleaseAllowed} from '../core.js';
import {authorize, currency, hash, instant, managers, money, operationLock, quantity, requireRow, uuid, type Context} from './common.js';

async function stockForRelease(client: PoolClient,farmId: string,stockId: string,release=true) {
  const snapshot=requireRow((await client.query('SELECT project_id FROM stock_items WHERE farm_id=$1 AND id=$2',[farmId,stockId])).rows[0]);
  if(snapshot.project_id){
    if(release)await assertReleaseAllowed(client,farmId,snapshot.project_id,'sale');
    else await client.query('SELECT id FROM projects WHERE farm_id=$1 AND id=$2 FOR NO KEY UPDATE',[farmId,snapshot.project_id]);
  }
  return requireRow((await client.query('SELECT * FROM stock_items WHERE farm_id=$1 AND id=$2 FOR UPDATE',[farmId,stockId])).rows[0]);
}
const listingInput=z.object({id:uuid,stockItemId:uuid,title:z.string().trim().min(1).max(150),quantity,price:money,currency,collectionArea:z.string().trim().min(1).max(150),terms:z.string().max(1500).default('')}).strict();
const serviceInput=z.object({id:uuid,name:z.string().trim().min(1).max(150),description:z.string().trim().min(1).max(2000),serviceArea:z.string().trim().min(1).max(150),rate:money,currency,rateBasis:z.string().trim().min(1).max(80),operatorIncluded:z.boolean(),fuelIncluded:z.boolean(),terms:z.string().max(1500).default(''),resourceAssetId:uuid.nullable().default(null)}).strict();

export function registerCommerce(app: FastifyInstance,ctx: Context) {
  app.get('/v1/farms/:farmId/listings',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply,managers);if(!auth)return;
    return {items:(await ctx.db.query('SELECT l.id,l.stock_item_id,l.title,l.quantity,l.remaining_quantity,l.price,l.currency,l.collection_area,l.terms,l.status,s.unit FROM market_listings l JOIN stock_items s ON s.id=l.stock_item_id WHERE l.farm_id=$1 ORDER BY l.created_at DESC LIMIT 100',[auth.farmId])).rows};
  });
  app.get('/v1/market/listings',async(req)=>{
    const query=z.object({q:z.string().max(100).default(''),cursor:uuid.optional()}).parse(req.query);
    const rows=(await ctx.db.query("SELECT l.id,l.title,l.price,l.currency,l.collection_area,l.terms,l.created_at,s.unit,f.name AS seller_name,GREATEST(0,LEAST(l.remaining_quantity,s.quantity-s.reserved_quantity)) AS available_quantity FROM market_listings l JOIN stock_items s ON s.id=l.stock_item_id JOIN farms f ON f.id=l.farm_id WHERE l.status='active' AND l.title ILIKE '%'||$1||'%' AND ($2::uuid IS NULL OR l.id>$2) AND NOT EXISTS(SELECT 1 FROM treatment_restrictions r WHERE r.farm_id=l.farm_id AND r.project_id=s.project_id AND r.starts_at<=now() AND r.ends_at>now() AND r.scope IN ('all','sale')) ORDER BY l.id LIMIT 101",[query.q,query.cursor??null])).rows;
    return {items:rows.slice(0,100),nextCursor:rows.length>100?rows[99].id:null};
  });
  app.post('/v1/farms/:farmId/listings',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply,managers);if(!auth)return;const data=listingInput.parse(req.body);
    const replayed=await ctx.transaction(async(client)=>{
      await operationLock(client,`listing:${data.id}`);
      const existing=(await client.query('SELECT farm_id,created_by,payload_hash FROM market_listings WHERE id=$1',[data.id])).rows[0];
      if(existing){if(existing.farm_id!==auth.farmId||existing.created_by!==auth.userId||existing.payload_hash!==hash(data))throw new ApiError('idempotency_conflict',409);return true;}
      const stock=await stockForRelease(client,auth.farmId,data.stockItemId);
      // Live animal counts use the livestock event ledger. Do not sell a second,
      // independently entered inventory count while that ledger is unreserved.
      if(['bird','rabbit','fish'].includes(stock.unit))throw new ApiError('live_animal_market_not_ready',409);
      if(stock.unit==='count'&&stock.project_id){
        const project=(await client.query('SELECT enterprise_type FROM projects WHERE id=$1',[stock.project_id])).rows[0];
        if(project?.enterprise_type!=='crop')throw new ApiError('live_animal_market_not_ready',409);
      }
      if(!['kg','g','l','ml'].includes(stock.unit)&&!Number.isInteger(data.quantity))throw new ApiError('whole_count_required');
      if(Number(stock.quantity)-Number(stock.reserved_quantity)<data.quantity)throw new ApiError('insufficient_stock',409);
      await client.query('INSERT INTO market_listings(id,farm_id,stock_item_id,created_by,title,quantity,remaining_quantity,price,currency,collection_area,terms,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11)',[data.id,auth.farmId,data.stockItemId,auth.userId,data.title,data.quantity,data.price,data.currency,data.collectionArea,data.terms,hash(data)]);return false;
    });return reply.code(replayed?200:201).send({id:data.id,status:'active'});
  });
  app.post('/v1/farms/:farmId/listings/:listingId/archive',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply,managers);if(!auth)return;const {listingId}=z.object({listingId:uuid}).parse(req.params);
    requireRow((await ctx.db.query("UPDATE market_listings SET status='archived' WHERE farm_id=$1 AND id=$2 RETURNING id",[auth.farmId,listingId])).rows[0]);return {id:listingId,status:'archived'};
  });
  app.post('/v1/market/listings/:listingId/orders',async(req,reply)=>{
    const userId=await ctx.user(req,reply);if(!userId)return;
    const {listingId}=z.object({listingId:uuid}).parse(req.params);const data=z.object({id:uuid,quantity}).strict().parse(req.body);
    const outcome=await ctx.transaction(async(client)=>{
      await operationLock(client,`order:${data.id}`);
      const prior=(await client.query('SELECT * FROM market_orders WHERE id=$1',[data.id])).rows[0];
      if(prior){if(prior.buyer_id!==userId||prior.listing_id!==listingId||prior.payload_hash!==hash(data))throw new ApiError('idempotency_conflict',409);return {order:prior,replayed:true};}
      await operationLock(client,`listing:${listingId}`);
      const listing=requireRow((await client.query('SELECT * FROM market_listings WHERE id=$1',[listingId])).rows[0]);
      const stock=await stockForRelease(client,listing.farm_id,listing.stock_item_id);
      const current=requireRow((await client.query('SELECT * FROM market_listings WHERE id=$1 FOR UPDATE',[listingId])).rows[0]);
      if(current.status!=='active')throw new ApiError('listing_unavailable',409);
      if(!['kg','g','l','ml'].includes(stock.unit)&&!Number.isInteger(data.quantity))throw new ApiError('whole_count_required');
      if(data.quantity>Number(current.remaining_quantity)||data.quantity>Number(stock.quantity)-Number(stock.reserved_quantity))throw new ApiError('insufficient_stock',409);
      if(data.quantity*Number(listing.price)>999999999)throw new ApiError('amount_too_large');
      await client.query('UPDATE stock_items SET reserved_quantity=reserved_quantity+$2,version=version+1 WHERE id=$1',[stock.id,data.quantity]);
      await client.query('UPDATE market_listings SET remaining_quantity=remaining_quantity-$2 WHERE id=$1',[listingId,data.quantity]);
      const inserted=await client.query("INSERT INTO market_orders(id,listing_id,buyer_id,quantity,unit,amount,currency,payload_hash) VALUES($1,$2,$3,$4,$5,round($6::numeric*$4::numeric,2),$7,$8) RETURNING *",[data.id,listingId,userId,data.quantity,stock.unit,listing.price,listing.currency,hash(data)]);
      return {order:inserted.rows[0],replayed:false};
    });return reply.code(outcome.replayed?200:201).send(outcome.order);
  });
  app.get('/v1/market/orders',async(req,reply)=>{
    const userId=await ctx.user(req,reply);if(!userId)return;
    return {items:(await ctx.db.query("SELECT o.id,o.listing_id,l.title,o.quantity,o.unit,o.amount,o.currency,o.status,o.created_at,(o.buyer_id=$1) AS is_buyer,EXISTS(SELECT 1 FROM memberships m WHERE m.farm_id=l.farm_id AND m.user_id=$1 AND m.role IN ('owner','manager')) AS is_seller,COALESCE((SELECT sum(p.amount) FROM commerce_payments p WHERE p.order_id=o.id),0) AS manually_recorded_paid FROM market_orders o JOIN market_listings l ON l.id=o.listing_id WHERE o.buyer_id=$1 OR EXISTS(SELECT 1 FROM memberships m WHERE m.farm_id=l.farm_id AND m.user_id=$1 AND m.role IN ('owner','manager')) ORDER BY o.created_at DESC LIMIT 100",[userId])).rows};
  });
  app.post('/v1/market/orders/:orderId/status',async(req,reply)=>{
    const userId=await ctx.user(req,reply);if(!userId)return;const {orderId}=z.object({orderId:uuid}).parse(req.params);
    const {status}=z.object({status:z.enum(['cancelled','fulfilled'])}).strict().parse(req.body);
    return ctx.transaction(async(client)=>{
      const order=requireRow((await client.query('SELECT o.*,l.farm_id,l.stock_item_id FROM market_orders o JOIN market_listings l ON l.id=o.listing_id WHERE o.id=$1 FOR UPDATE OF o',[orderId])).rows[0]);
      const seller=await ctx.member(order.farm_id,userId,managers);
      if(!seller && (status!=='cancelled'||order.buyer_id!==userId))throw new ApiError('not_found',404);
      if(order.status===status)return {id:orderId,status};
      if(order.status!=='reserved')throw new ApiError('invalid_transition',409);
      await operationLock(client,`listing:${order.listing_id}`);
      const stock=await stockForRelease(client,order.farm_id,order.stock_item_id,status==='fulfilled');
      if(Number(stock.reserved_quantity)<Number(order.quantity))throw new ApiError('stock_reconciliation_required',409);
      if(status==='cancelled'){
        await client.query('UPDATE stock_items SET reserved_quantity=reserved_quantity-$2,version=version+1 WHERE id=$1',[stock.id,order.quantity]);
        await client.query('UPDATE market_listings SET remaining_quantity=remaining_quantity+$2 WHERE id=$1',[order.listing_id,order.quantity]);
      }else{
        await client.query('UPDATE stock_items SET quantity=quantity-$2,reserved_quantity=reserved_quantity-$2,version=version+1 WHERE id=$1',[stock.id,order.quantity]);
        await client.query("INSERT INTO stock_movements(id,farm_id,stock_item_id,project_id,actor_id,kind,quantity,unit,source_type,source_id,observed_at) VALUES($1,$2,$3,$4,$5,'sale',-$6::numeric,$7,'market_order',$8,now())",[randomUUID(),order.farm_id,stock.id,stock.project_id,userId,order.quantity,order.unit,orderId]);
        await client.query("INSERT INTO financial_entries(id,farm_id,project_id,actor_id,kind,amount,currency,source_type,source_id,observed_at) VALUES($1,$2,$3,$4,'revenue',$5,$6,'market_order',$7,now())",[randomUUID(),order.farm_id,stock.project_id,userId,order.amount,order.currency,orderId]);
      }
      await client.query('UPDATE market_orders SET status=$2,updated_at=now() WHERE id=$1',[orderId,status]);return {id:orderId,status};
    });
  });
  app.post('/v1/market/orders/:orderId/payments',async(req,reply)=>{
    const userId=await ctx.user(req,reply);if(!userId)return;const {orderId}=z.object({orderId:uuid}).parse(req.params);
    const data=z.object({id:uuid,amount:money.refine(v=>v>0),currency,note:z.string().max(500).default('')}).strict().parse(req.body);
    const replayed=await ctx.transaction(async(client)=>{
      await operationLock(client,`payment:${data.id}`);
      const order=requireRow((await client.query('SELECT o.*,l.farm_id,s.project_id FROM market_orders o JOIN market_listings l ON l.id=o.listing_id JOIN stock_items s ON s.id=l.stock_item_id WHERE o.id=$1 FOR UPDATE OF o',[orderId])).rows[0]);
      if(!await ctx.member(order.farm_id,userId,managers))throw new ApiError('not_found',404);
      const old=(await client.query('SELECT * FROM commerce_payments WHERE id=$1',[data.id])).rows[0];
      if(old){if(old.order_id!==orderId||old.recorded_by!==userId||Number(old.amount)!==data.amount||old.currency!==data.currency||old.note!==data.note)throw new ApiError('idempotency_conflict',409);return true;}
      if(order.status!=='fulfilled')throw new ApiError('order_not_fulfilled',409);
      if(order.currency!==data.currency)throw new ApiError('currency_mismatch',409);
      const paid=Number((await client.query('SELECT COALESCE(sum(amount),0) AS paid FROM commerce_payments WHERE order_id=$1',[orderId])).rows[0].paid);
      if(Math.round((paid+data.amount)*100)>Math.round(Number(order.amount)*100))throw new ApiError('payment_exceeds_balance',409);
      await client.query('INSERT INTO commerce_payments(id,order_id,recorded_by,amount,currency,note) VALUES($1,$2,$3,$4,$5,$6)',[data.id,orderId,userId,data.amount,data.currency,data.note]);
      await client.query("INSERT INTO financial_entries(id,farm_id,project_id,actor_id,kind,amount,currency,source_type,source_id,observed_at) VALUES($1,$2,$3,$4,'payment',$5,$6,'manual_market_payment',$7,now())",[randomUUID(),order.farm_id,order.project_id,userId,data.amount,data.currency,data.id]);return false;
    });return reply.code(replayed?200:201).send({id:data.id,provenance:'manual',providerVerified:false});
  });
  app.get('/v1/services',async(req)=>{
    const {q}=z.object({q:z.string().max(100).default('')}).parse(req.query);
    return {items:(await ctx.db.query("SELECT s.id,s.name,s.description,s.service_area,s.rate,s.currency,s.rate_basis,s.operator_included,s.fuel_included,s.terms,f.name AS provider_name FROM service_listings s JOIN farms f ON f.id=s.farm_id WHERE s.active AND s.name ILIKE '%'||$1||'%' ORDER BY s.name LIMIT 100",[q])).rows};
  });
  app.post('/v1/farms/:farmId/services',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply,managers);if(!auth)return;const data=serviceInput.parse(req.body);
    const replayed=await ctx.transaction(async(client)=>{
      await operationLock(client,`service:${data.id}`);
      const old=(await client.query('SELECT * FROM service_listings WHERE id=$1',[data.id])).rows[0];
      if(old){if(old.farm_id!==auth.farmId||old.created_by!==auth.userId||old.payload_hash!==hash(data))throw new ApiError('idempotency_conflict',409);return true;}
      if(data.resourceAssetId)requireRow((await client.query('SELECT id FROM assets WHERE id=$1 AND farm_id=$2',[data.resourceAssetId,auth.farmId])).rows[0]);
      await client.query('INSERT INTO service_listings(id,farm_id,created_by,name,description,service_area,rate,currency,rate_basis,operator_included,fuel_included,terms,payload_hash,resource_asset_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[data.id,auth.farmId,auth.userId,data.name,data.description,data.serviceArea,data.rate,data.currency,data.rateBasis,data.operatorIncluded,data.fuelIncluded,data.terms,hash(data),data.resourceAssetId]);return false;
    });return reply.code(replayed?200:201).send({id:data.id});
  });
  app.post('/v1/services/:serviceId/bookings',async(req,reply)=>{
    const userId=await ctx.user(req,reply);if(!userId)return;const {serviceId}=z.object({serviceId:uuid}).parse(req.params);
    const data=z.object({id:uuid,farmId:uuid,projectId:uuid.nullable().default(null),startsAt:instant,endsAt:instant,note:z.string().max(1500).default('')}).strict().parse(req.body);
    if(!await ctx.member(data.farmId,userId,managers))throw new ApiError('not_found',404);
    if(new Date(data.endsAt).getTime()<=new Date(data.startsAt).getTime())throw new ApiError('invalid_booking_dates');
    const outcome=await ctx.transaction(async(client)=>{
      await operationLock(client,`booking:${data.id}`);
      const prior=(await client.query('SELECT * FROM service_bookings WHERE id=$1',[data.id])).rows[0];
      if(prior){if(prior.requested_by!==userId||prior.service_id!==serviceId||prior.payload_hash!==hash(data))throw new ApiError('idempotency_conflict',409);return {booking:prior,replayed:true};}
      requireRow((await client.query('SELECT id FROM service_listings WHERE id=$1 AND active',[serviceId])).rows[0]);
      if(data.projectId)requireRow((await client.query('SELECT id FROM projects WHERE farm_id=$1 AND id=$2',[data.farmId,data.projectId])).rows[0]);
      const result=await client.query('INSERT INTO service_bookings(id,service_id,farm_id,project_id,requested_by,starts_at,ends_at,note,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[data.id,serviceId,data.farmId,data.projectId,userId,data.startsAt,data.endsAt,data.note,hash(data)]);
      await client.query("INSERT INTO booking_audit(booking_id,actor_id,status,version) VALUES($1,$2,'requested',1)",[data.id,userId]);
      return {booking:result.rows[0],replayed:false};
    });return reply.code(outcome.replayed?200:201).send(outcome.booking);
  });
  app.get('/v1/farms/:farmId/bookings',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply,managers);if(!auth)return;
    return {items:(await ctx.db.query('SELECT b.*,s.name,(s.farm_id=$1) AS is_provider,(b.farm_id=$1) AS is_customer FROM service_bookings b JOIN service_listings s ON s.id=b.service_id WHERE b.farm_id=$1 OR s.farm_id=$1 ORDER BY b.starts_at DESC LIMIT 100',[auth.farmId])).rows};
  });
  app.post('/v1/farms/:farmId/bookings/:bookingId/status',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply,managers);if(!auth)return;const {bookingId}=z.object({bookingId:uuid}).parse(req.params);
    const data=z.object({status:z.enum(['quoted','confirmed','completed','cancelled']),version:z.number().int().positive(),amount:money.optional(),currency:currency.optional()}).strict().parse(req.body);
    return ctx.transaction(async(client)=>{
      const snapshot=requireRow((await client.query('SELECT b.service_id,b.farm_id AS customer_farm_id,s.farm_id AS provider_farm_id,s.resource_asset_id FROM service_bookings b JOIN service_listings s ON s.id=b.service_id WHERE b.id=$1',[bookingId])).rows[0]);
      if(snapshot.customer_farm_id!==auth.farmId&&snapshot.provider_farm_id!==auth.farmId)throw new ApiError('not_found',404);
      // A linked resource is immutable in this API. Lock it before the listing
      // so different services using one tractor share the same scheduling lock.
      if(snapshot.resource_asset_id)requireRow((await client.query('SELECT id FROM assets WHERE id=$1 AND farm_id=$2 FOR UPDATE',[snapshot.resource_asset_id,snapshot.provider_farm_id])).rows[0]);
      const service=requireRow((await client.query('SELECT * FROM service_listings WHERE id=$1 FOR UPDATE',[snapshot.service_id])).rows[0]);
      if(service.resource_asset_id!==snapshot.resource_asset_id)throw new ApiError('retry_transaction',409);
      const booking=requireRow((await client.query('SELECT * FROM service_bookings WHERE id=$1 FOR UPDATE',[bookingId])).rows[0]);
      const provider=service.farm_id===auth.farmId;const customer=booking.farm_id===auth.farmId;
      if(!provider&&!customer)throw new ApiError('not_found',404);
      if(data.version!==booking.version)throw new ApiError('version_conflict',409);
      let amount=booking.amount,code=booking.currency;
      if(data.status==='quoted'){
        if(!provider||!['requested','quoted'].includes(booking.status))throw new ApiError('invalid_transition',409);
        if(data.amount===undefined||!data.currency)throw new ApiError('quote_amount_required');amount=data.amount;code=data.currency;
      }else if(data.status==='confirmed'){
        if(!customer||booking.status!=='quoted')throw new ApiError('invalid_transition',409);
        if(!service.active)throw new ApiError('service_unavailable',409);
        if((await client.query("SELECT 1 FROM service_bookings b JOIN service_listings s ON s.id=b.service_id WHERE b.id<>$2 AND b.status IN ('confirmed','completed') AND b.starts_at<$3 AND b.ends_at>$4 AND (b.service_id=$1 OR ($5::uuid IS NOT NULL AND s.farm_id=$6 AND s.resource_asset_id=$5)) LIMIT 1",[service.id,bookingId,booking.ends_at,booking.starts_at,service.resource_asset_id,service.farm_id])).rowCount)throw new ApiError('booking_overlap',409);
      }else if(data.status==='completed'){
        if(!customer||booking.status!=='confirmed')throw new ApiError('invalid_transition',409);
        await client.query("INSERT INTO financial_entries(id,farm_id,project_id,actor_id,kind,amount,currency,source_type,source_id,observed_at) VALUES($1,$2,$3,$4,'expense',$5,$6,'service_booking',$7,now())",[randomUUID(),booking.farm_id,booking.project_id,auth.userId,amount,code,bookingId]);
      }else if(!['requested','quoted','confirmed'].includes(booking.status))throw new ApiError('invalid_transition',409);
      const next=await client.query('UPDATE service_bookings SET status=$2,amount=$3,currency=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[bookingId,data.status,amount,code]);
      await client.query('INSERT INTO booking_audit(booking_id,actor_id,status,amount,currency,version) VALUES($1,$2,$3,$4,$5,$6)',[bookingId,auth.userId,data.status,amount,code,next.rows[0].version]);return next.rows[0];
    });
  });
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
