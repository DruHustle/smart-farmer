import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, audit, manageRoles, type Context } from "../context.js";
import { uuid, money } from "../core.js";
import { guardAccountingEntry } from "../accounting/bridge.js";
import {
  auth,
  idempotent,
  row,
  text,
  project,
  listQuery,
  page,
} from "./common.js";
export function registerFinancialCorrections(
  app: FastifyInstance,
  ctx: Context,
) {
  app.patch(
    "/v1/farms/:farmId/projects/:projectId/opening-balances/:balanceId",
    async (req, reply) => {
      const a = await auth(ctx, req, reply, manageRoles);
      if (!a) return;
      const { projectId, balanceId } = z
        .object({ projectId: uuid, balanceId: uuid })
        .parse(req.params);
      const b = z
        .object({
          version: z.number().int().positive(),
          amount: money,
          asOfDate: z.iso.date(),
          source: text,
          reason: text,
        })
        .strict()
        .parse(req.body);
      return ctx.transaction(async (c) => {
        const old = row(
          (
            await c.query(
              "SELECT * FROM opening_financial_balances WHERE farm_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
              [a.farmId, projectId, balanceId],
            )
          ).rows[0],
        );
        if (old.version !== b.version)
          throw new ApiError("version_conflict", 409, { current: old });
        const next = (
          await c.query(
            "UPDATE opening_financial_balances SET amount=$4,as_of_date=$5,source=$6,version=version+1 WHERE farm_id=$1 AND project_id=$2 AND id=$3 RETURNING *",
            [a.farmId, projectId, balanceId, b.amount, b.asOfDate, b.source],
          )
        ).rows[0];
        await audit(
          c,
          a.farmId,
          a.actor,
          "opening_balance",
          balanceId,
          "corrected",
          b.reason,
          old,
          next,
        );
        return next;
      });
    },
  );
  app.get(
    "/v1/farms/:farmId/expenses/:entryId/allocations/history",
    async (req, reply) => {
      const a = await auth(ctx, req, reply, manageRoles);
      if (!a) return;
      const { entryId } = z.object({ entryId: uuid }).parse(req.params),
        q = listQuery.parse(req.query);
      return page(
        (
          await ctx.db.query(
            "SELECT * FROM expense_allocations WHERE farm_id=$1 AND entry_id=$2 AND ($3::uuid IS NULL OR id<$3) ORDER BY id DESC LIMIT $4",
            [a.farmId, entryId, q.cursor ?? null, q.limit + 1],
          )
        ).rows,
        q.limit,
      );
    },
  );
  app.post(
    "/v1/farms/:farmId/expenses/:entryId/reallocate",
    async (req, reply) => {
      const a = await auth(ctx, req, reply, manageRoles);
      if (!a) return;
      const { entryId } = z.object({ entryId: uuid }).parse(req.params);
      const b = z
        .object({
          id: uuid,
          reason: text,
          allocations: z
            .array(
              z
                .object({
                  projectId: uuid,
                  amount: money.refine((v) => v > 0),
                  basis: text,
                })
                .strict(),
            )
            .max(100),
        })
        .strict()
        .parse(req.body);
      if (
        new Set(b.allocations.map((v) => v.projectId)).size !==
        b.allocations.length
      )
        throw new ApiError("duplicate_allocation_project");
      const out = await idempotent(
        ctx,
        a.farmId,
        a.actor,
        b.id,
        { operation: "reallocate", entryId, ...b },
        async (c) => {
          await guardAccountingEntry(c, a.farmId, entryId);
          const expense = row(
            (
              await c.query(
                "SELECT * FROM financial_entries WHERE farm_id=$1 AND id=$2 AND kind='expense' AND amount>0 FOR UPDATE",
                [a.farmId, entryId],
              )
            ).rows[0],
          );
          if (
            (
              await c.query(
                "SELECT 1 FROM financial_corrections WHERE farm_id=$1 AND entry_id=$2 UNION ALL SELECT 1 FROM activity_corrections WHERE farm_id=$1 AND activity_id=$3 AND action='reverse'",
                [a.farmId, entryId, expense.source_id],
              )
            ).rowCount
          )
            throw new ApiError("record_reversed", 409);
          if (
            Math.round(b.allocations.reduce((n, v) => n + v.amount, 0) * 100) >
            Math.round(Number(expense.amount) * 100)
          )
            throw new ApiError("allocation_exceeds_expense", 409);
          const old = (
            await c.query(
              "SELECT * FROM expense_allocations WHERE entry_id=$1 AND reversed_at IS NULL",
              [entryId],
            )
          ).rows;
          await c.query(
            "UPDATE expense_allocations SET reversed_at=clock_timestamp(),reversed_by=$2 WHERE entry_id=$1 AND reversed_at IS NULL",
            [entryId, a.actor],
          );
          const items = [];
          for (const v of b.allocations) {
            await project(c, a.farmId, v.projectId);
            items.push(
              (
                await c.query(
                  "INSERT INTO expense_allocations(id,request_id,farm_id,entry_id,project_id,amount,basis,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
                  [
                    randomUUID(),
                    b.id,
                    a.farmId,
                    entryId,
                    v.projectId,
                    v.amount,
                    v.basis,
                    a.actor,
                  ],
                )
              ).rows[0],
            );
          }
          await audit(
            c,
            a.farmId,
            a.actor,
            "expense",
            entryId,
            "reallocated",
            b.reason,
            old,
            items,
          );
          return { items, previousAllocationsRetained: true };
        },
      );
      return reply.code(out.replayed ? 200 : 201).send(out.body);
    },
  );
  app.post(
    "/v1/farms/:farmId/expenses/:entryId/corrections",
    async (req, reply) => {
      const a = await auth(ctx, req, reply, manageRoles);
      if (!a) return;
      const { entryId } = z.object({ entryId: uuid }).parse(req.params);
      const b = z.object({ id: uuid, reason: text }).strict().parse(req.body);
      const out = await idempotent(
        ctx,
        a.farmId,
        a.actor,
        b.id,
        { operation: "expense_correction", entryId, ...b },
        async (c) => {
          await guardAccountingEntry(c, a.farmId, entryId);
          const original = row(
            (
              await c.query(
                "SELECT * FROM financial_entries WHERE farm_id=$1 AND id=$2 AND kind='expense' AND source_type='documented_expense' FOR UPDATE",
                [a.farmId, entryId],
              )
            ).rows[0],
          );
          if (
            (
              await c.query(
                "SELECT 1 FROM financial_corrections WHERE entry_id=$1",
                [entryId],
              )
            ).rowCount
          )
            throw new ApiError("record_already_reversed", 409);
          const allocations = (
            await c.query(
              "SELECT * FROM expense_allocations WHERE entry_id=$1 AND reversed_at IS NULL",
              [entryId],
            )
          ).rows;
          await c.query(
            "UPDATE expense_allocations SET reversed_at=clock_timestamp(),reversed_by=$2 WHERE entry_id=$1 AND reversed_at IS NULL",
            [entryId, a.actor],
          );
          await c.query(
            "INSERT INTO financial_corrections(id,farm_id,entry_id,reason,created_by) VALUES($1,$2,$3,$4,$5)",
            [b.id, a.farmId, entryId, b.reason, a.actor],
          );
          const compensation = (
            await c.query(
              "INSERT INTO financial_entries(id,farm_id,project_id,actor_id,kind,amount,currency,source_type,source_id,observed_at,note,category) VALUES($1,$2,$3,$4,'expense',-$5::numeric,$6,'record_correction',$7,clock_timestamp(),$8,$9) RETURNING *",
              [
                randomUUID(),
                a.farmId,
                original.project_id,
                a.actor,
                original.amount,
                original.currency,
                b.id,
                b.reason,
                original.category,
              ],
            )
          ).rows[0];
          await audit(
            c,
            a.farmId,
            a.actor,
            "expense",
            entryId,
            "reversed",
            b.reason,
            { original, allocations },
            compensation,
          );
          return {
            id: b.id,
            entryId,
            compensation,
            previousAllocationsRetained: true,
          };
        },
      );
      return reply.code(out.replayed ? 200 : 201).send(out.body);
    },
  );
}
