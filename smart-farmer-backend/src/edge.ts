import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/);
const edgeGateway = z.object({
  farmId: z.string().uuid(),
  secret: z.string().min(32).max(256),
  sources: z.array(identifier).min(1).max(200)
}).strict();
const gatewaysSchema = z.record(identifier, edgeGateway);
const common = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  sourceId: identifier,
  observedAt: z.iso.datetime({offset: true})
});
export const farmEdgeEvent = z.discriminatedUnion('kind', [
  common.extend({
    kind: z.literal('measurement'),
    data: z.object({
      assetId: identifier, metric: identifier,
      value: z.number().finite(), unit: z.string().trim().min(1).max(32)
    }).strict()
  }).strict(),
  common.extend({
    kind: z.literal('equipment_status'),
    data: z.object({
      assetId: identifier,
      state: z.enum(['running','stopped','fault','unknown']),
      code: z.string().trim().max(100).optional()
    }).strict()
  }).strict()
]);

type EdgeRequest = FastifyRequest & { rawEdgeBody?: Buffer };
type EdgeConfig = z.infer<typeof edgeGateway>;

export function farmEdgeGateways(): Record<string, EdgeConfig> {
  const raw = process.env.SMART_FARMER_EDGE_GATEWAYS;
  if (!raw) return {};
  try { return gatewaysSchema.parse(JSON.parse(raw)); }
  catch { throw new Error('SMART_FARMER_EDGE_GATEWAYS must be a valid, reviewed gateway/farm/source allowlist'); }
}

export function verifyFarmEdgeSignature(
  raw: Buffer, timestamp: string | undefined, signature: string | undefined,
  secret: string, nowMs = Date.now()
): boolean {
  if (!timestamp || !/^\d{10}$/.test(timestamp) ||
      !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const age = Math.abs(nowMs / 1000 - Number(timestamp));
  if (age > 300) return false;
  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(timestamp).update('.').update(raw).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))
      .map(([key, item])=>[key, stable(item)]));
  return value;
}

export function registerFarmEdgeRoutes(
  app: FastifyInstance, db: pg.Pool,
  user: (req: FastifyRequest, reply: FastifyReply) => Promise<string|null>,
  member: (farmId: string, userId: string) => Promise<boolean>
) {
  // Custom type preserves exactly the raw bytes signed by the isolated gateway.
  app.addContentTypeParser('application/vnd.smart-farmer.edge+json',
    {parseAs:'buffer'}, (request, body, done) => {
      const buffer = Buffer.from(body as Buffer);
      (request as EdgeRequest).rawEdgeBody = buffer;
      try { done(null, JSON.parse(buffer.toString('utf8'))); }
      catch {
        const error = new Error('Invalid edge JSON') as Error & {statusCode: number};
        error.statusCode = 400; done(error);
      }
    });

  app.post('/v1/edge/:gatewayId/events', async (req, reply) => {
    const params = z.object({gatewayId: identifier}).parse(req.params);
    const gateway = farmEdgeGateways()[params.gatewayId];
    const raw = (req as EdgeRequest).rawEdgeBody;
    if (!gateway || !raw || !verifyFarmEdgeSignature(raw,
      req.headers['x-edge-timestamp'] as string | undefined,
      req.headers['x-edge-signature'] as string | undefined, gateway.secret))
      return reply.code(401).send({error:'edge_unauthorized'});
    const event = farmEdgeEvent.parse(req.body);
    if (!gateway.sources.includes(event.sourceId))
      return reply.code(403).send({error:'source_not_commissioned'});
    const at = Date.parse(event.observedAt);
    if (!Number.isFinite(at) || at > Date.now()+300_000)
      return reply.code(422).send({error:'invalid_observation_time'});

    const digest = createHash('sha256')
      .update(JSON.stringify(stable(event))).digest('hex');
    const result = await db.query(
      'INSERT INTO farm_edge_observations ' +
      '(farm_id,gateway_id,event_id,source_id,kind,observed_at,payload,payload_hash) ' +
      'VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ' +
      'ON CONFLICT(farm_id,gateway_id,event_id) DO NOTHING RETURNING event_id',
      [gateway.farmId,params.gatewayId,event.eventId,event.sourceId,event.kind,
       event.observedAt,JSON.stringify(event),digest]
    );
    if (!result.rowCount) {
      const old = await db.query(
        'SELECT payload_hash FROM farm_edge_observations WHERE farm_id=$1 AND gateway_id=$2 AND event_id=$3',
        [gateway.farmId,params.gatewayId,event.eventId]);
      return old.rows[0]?.payload_hash === digest
        ? reply.code(202).send({accepted:true,duplicate:true})
        : reply.code(409).send({error:'event_identity_conflict'});
    }
    return reply.code(202).send({accepted:true,duplicate:false});
  });

  app.get('/v1/farms/:farmId/equipment/observations',async(req,reply)=>{
    const {farmId}=z.object({farmId:z.string().uuid()}).parse(req.params);
    const userId=await user(req,reply); if(!userId)return;
    if(!await member(farmId,userId))return reply.code(404).send({error:'not_found'});
    const rows=await db.query(
      'SELECT gateway_id as "gatewayId", source_id as "sourceId", '+
      'event_id as "eventId", kind, observed_at as "observedAt", '+
      'received_at as "receivedAt", payload FROM farm_edge_observations '+
      'WHERE farm_id=$1 ORDER BY received_at DESC,event_id DESC LIMIT 100',[farmId]);
    return {
      items:rows.rows, evidence:'Unverified until each sensor and its calibration are commissioned',
      commandCapability:false
    };
  });
}
