import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, type Context } from './context.js';

const params = z.object({ farmId: z.string().uuid() });

export function registerViewerOverview(app: FastifyInstance, { db, user }: Context) {
  app.get('/v1/farms/:farmId/viewer-overview', async (req, reply) => {
    const actor = await user(req, reply);
    if (!actor) return;
    const { farmId } = params.parse(req.params);
    // Use one database snapshot for the membership and the selected fields.
    const result = await db.query(`
      SELECT jsonb_build_object(
        'projects', COALESCE((SELECT jsonb_agg(p ORDER BY p.name, p.id) FROM (
          SELECT id, name, enterprise_type, status FROM projects
          WHERE farm_id=$1 ORDER BY name, id LIMIT 50
        ) p), '[]'::jsonb),
        'tasks', COALESCE((SELECT jsonb_agg(t ORDER BY t.title, t.id) FROM (
          SELECT id, title, status, due_at FROM tasks
          WHERE farm_id=$1 ORDER BY title, id LIMIT 50
        ) t), '[]'::jsonb),
        'stock', COALESCE((SELECT jsonb_agg(s ORDER BY s.name, s.id) FROM (
          SELECT id, name, quantity::text, unit FROM stock_items
          WHERE farm_id=$1 ORDER BY name, id LIMIT 50
        ) s), '[]'::jsonb),
        'incidents', COALESCE((SELECT jsonb_agg(i ORDER BY i.created_at DESC, i.id) FROM (
          SELECT id, title, severity, status, created_at FROM incidents
          WHERE farm_id=$1 ORDER BY created_at DESC, id LIMIT 50
        ) i), '[]'::jsonb)
      ) AS overview
      FROM memberships WHERE farm_id=$1 AND user_id=$2 AND role='viewer'
    `, [farmId, actor]);
    if (!result.rowCount) throw new ApiError('not_found', 404);
    return result.rows[0].overview;
  });
}
