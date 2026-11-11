import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {ApiError, type Context} from './context.js';

const columns = 'id, status, requested_at AS "requestedAt"';
export function registerAccountDeletion(app: FastifyInstance, ctx: Context) {
  const route = '/v1/me/deletion-request';
  app.get(route, async (req, reply) => {
    const userId = await ctx.user(req, reply);
    if (!userId) return;
    const result = await ctx.db.query(`SELECT ${columns} FROM account_deletion_requests WHERE user_id=$1`, [userId]);
    return reply.header('Cache-Control', 'no-store').send({request: result.rows[0] ?? null});
  });
  app.post(route, async (req, reply) => {
    const userId = await ctx.user(req, reply);
    if (!userId) return;
    z.object({confirm: z.literal(true)}).strict().parse(req.body);
    const result = await ctx.db.query(`INSERT INTO account_deletion_requests(user_id) VALUES($1)
      ON CONFLICT (user_id) DO UPDATE SET user_id=excluded.user_id RETURNING ${columns}`, [userId]);
    return reply.header('Cache-Control', 'no-store').code(202).send({request: result.rows[0]});
  });
  app.delete(route, async (req, reply) => {
    const userId = await ctx.user(req, reply);
    if (!userId) return;
    await ctx.transaction(async client => {
      const row = await client.query('SELECT status FROM account_deletion_requests WHERE user_id=$1 FOR UPDATE', [userId]);
      if (row.rows[0]?.status === 'in_review') throw new ApiError('request_in_review', 409);
      await client.query("DELETE FROM account_deletion_requests WHERE user_id=$1 AND status='pending'", [userId]);
    });
    return reply.code(204).send();
  });
}
