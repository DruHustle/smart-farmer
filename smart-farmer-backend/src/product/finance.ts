import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import PDFDocument from "pdfkit";
import { guardAccountingEntry } from "../accounting/bridge.js";
import { z } from "zod";
import { ApiError, audit, manageRoles, type Context } from "../context.js";
import { currencyScale, decimalFromMinor, halfUp } from "../accounting/money.js";
import { outstandingInvoices } from "../accounting/reports.js";
import {
  uuid,
  when,
  money,
  currency,
  quantity,
  units,
  convertQuantity,
  stockMovement,
  finance,
  assertReleaseAllowed,
} from "../core.js";
import {
  auth,
  idempotent,
  listQuery,
  page,
  project,
  row,
  text,
  validateProject,
} from "./common.js";
const pp = z.object({ projectId: uuid });
const category = z.enum([
  "seed",
  "fertiliser",
  "feed",
  "fuel",
  "labour",
  "equipment",
  "transport",
  "care",
  "inventory",
  "other",
]);
export const reportQuery = z
  .object({
    projectId: uuid.optional(),
    from: when.optional(),
    to: when.optional(),
    period: z.enum(["day", "week", "season"]).default("season"),
    language: z.enum(["sn", "nd"]).optional(),
  })
  .refine(
    (q) => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to),
    "invalid_report_period",
  );
type ReportQuery = z.infer<typeof reportQuery>;
function reportCurrencyScale(code: string) { try { return currencyScale(code); } catch { return 3; } }
// PostgreSQL numeric sums/divisions may contain arbitrary trailing zeroes and
// exceed one invoice's input limit. Parse their exact thousandths without Number.
function reportScaled(value: unknown): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match || (match[3] ?? "").slice(3).replaceAll("0", "")) throw new ApiError("accounting_amount_invariant", 500);
  const amount = BigInt(match[2]) * 1000n + BigInt((match[3] ?? "").slice(0, 3).padEnd(3, "0"));
  return match[1] ? -amount : amount;
}
function reportAmount(value: bigint, code: string) {
  const scale = reportCurrencyScale(code), divisor = 10n ** BigInt(3 - scale);
  const rounded = (value < 0n ? -1n : 1n) * halfUp(value < 0n ? -value : value, divisor);
  return decimalFromMinor(rounded, scale);
}
export async function reportSummary(
  db: pg.Pool | pg.PoolClient,
  farmId: string,
  q: ReportQuery,
) {
  const farm = row(
    (await db.query("SELECT name,timezone FROM farms WHERE id=$1", [farmId]))
      .rows[0],
  );
  if (q.projectId)
    row(
      (
        await db.query("SELECT id FROM projects WHERE farm_id=$1 AND id=$2", [
          farmId,
          q.projectId,
        ])
      ).rows[0],
    );
  const args = [farmId, q.projectId ?? null, q.from ?? null, q.to ?? null];
  // A shared expense remains one farm expense. Project allocations move cost attribution
  // without creating cash or a second expense. Purchase costs remain separate from use.
  const effective = `WITH payment_history AS(
    SELECT p.*,sum(p.amount_minor) OVER(PARTITION BY p.invoice_id ORDER BY p.paid_on,p.created_at,p.id ROWS UNBOUNDED PRECEDING) AS cumulative_minor
    FROM accounting_payments p WHERE p.farm_id=$1
  ),effective AS(
    SELECT f.*,CASE WHEN $2::uuid IS NULL THEN f.amount
      WHEN managed.id IS NOT NULL THEN COALESCE(attributed.amount,0)
      WHEN f.project_id=$2 THEN f.amount-COALESCE((SELECT sum(a.amount) FROM expense_allocations a WHERE a.reversed_at IS NULL AND a.entry_id=f.id),0)+COALESCE((SELECT sum(a.amount) FROM expense_allocations a WHERE a.reversed_at IS NULL AND a.entry_id=f.id AND a.project_id=$2),0)
      ELSE COALESCE((SELECT sum(a.amount) FROM expense_allocations a WHERE a.reversed_at IS NULL AND a.entry_id=f.id AND a.project_id=$2),0) END AS effective_amount
    FROM financial_entries f
    LEFT JOIN payment_history cash ON f.kind IN('payment','cash_out') AND
      (cash.legacy_entry_id=f.id OR (f.source_type IN('accounting_payment','record_correction') AND cash.id=f.source_id))
    LEFT JOIN accounting_invoices managed ON managed.farm_id=f.farm_id AND managed.finalized_at IS NOT NULL AND (
      managed.financial_entry_id=f.id OR
      (f.source_type='record_correction' AND f.kind IN('expense','revenue') AND managed.id=f.source_id AND EXISTS(SELECT 1 FROM accounting_journals v WHERE v.farm_id=managed.farm_id AND v.source_kind='invoice_void' AND v.source_id=managed.id)) OR
      managed.id=cash.invoice_id)
    LEFT JOIN LATERAL(SELECT sum(CASE WHEN cash.id IS NULL THEN
        round(f.amount*part.cumulative/NULLIF(managed.total_minor,0),managed.minor_unit)
        -round(f.amount*(part.cumulative-part.amount)/NULLIF(managed.total_minor,0),managed.minor_unit)
      ELSE (round(cash.cumulative_minor*part.cumulative/NULLIF(managed.total_minor,0),0)
        -round(cash.cumulative_minor*(part.cumulative-part.amount)/NULLIF(managed.total_minor,0),0)
        -round((cash.cumulative_minor-cash.amount_minor)*part.cumulative/NULLIF(managed.total_minor,0),0)
        +round((cash.cumulative_minor-cash.amount_minor)*(part.cumulative-part.amount)/NULLIF(managed.total_minor,0),0))/power(10::numeric,managed.minor_unit) END) AS amount
      FROM (SELECT item->>'projectId' AS project_id,(item->>'totalMinor')::numeric AS amount,
        sum((item->>'totalMinor')::numeric) OVER(ORDER BY position) AS cumulative
        FROM jsonb_array_elements(managed.snapshot->'lines') WITH ORDINALITY AS lines(item,position)) part
      WHERE part.project_id::uuid=$2::uuid) attributed ON managed.id IS NOT NULL AND $2::uuid IS NOT NULL
    WHERE f.farm_id=$1 AND ($3::timestamptz IS NULL OR f.observed_at>=$3) AND ($4::timestamptz IS NULL OR f.observed_at<$4))`;

  const totals = (
    await db.query(
      `${effective} SELECT currency,kind,sum(effective_amount)::text AS amount FROM effective GROUP BY currency,kind HAVING sum(effective_amount)<>0 ORDER BY currency,kind`,
      args,
    )
  ).rows;
  const costRows = (
    await db.query(
      `${effective} SELECT currency,category,sum(effective_amount)::text AS amount FROM effective WHERE kind IN('expense','input_consumption') AND NOT (kind='expense' AND (source_type IN('stock_record','stock_pack') OR category='inventory')) GROUP BY currency,category`,
      args,
    )
  ).rows;
  const purchases = (
    await db.query(
      `${effective} SELECT currency,sum(effective_amount)::text AS amount FROM effective WHERE kind='expense' AND (source_type IN('stock_record','stock_pack') OR category='inventory') GROUP BY currency`,
      args,
    )
  ).rows;
  const opening = (
    await db.query(
      "SELECT currency,kind,sum(amount)::text AS amount FROM opening_financial_balances WHERE farm_id=$1 AND ($2::uuid IS NULL OR project_id=$2) AND ($3::timestamptz IS NULL OR (as_of_date::timestamp AT TIME ZONE $5)>=$3::timestamptz) AND ($4::timestamptz IS NULL OR (as_of_date::timestamp AT TIME ZONE $5)<$4::timestamptz) GROUP BY currency,kind",
      [...args, farm.timezone],
    )
  ).rows;
  const transfers = (
    await db.query(
      "SELECT currency,sum(CASE WHEN destination_project_id=$2 THEN amount ELSE 0 END)-sum(CASE WHEN source_project_id=$2 THEN amount ELSE 0 END) AS amount FROM project_cost_transfers WHERE farm_id=$1 AND $2::uuid IS NOT NULL AND ($3::timestamptz IS NULL OR created_at>=$3) AND ($4::timestamptz IS NULL OR created_at<$4) GROUP BY currency",
      args,
    )
  ).rows;
  const receivables = (
    await db.query(
      `WITH obligations AS(SELECT f.currency,f.amount,CASE f.source_type WHEN 'animal_event' THEN COALESCE((SELECT sum(p.amount) FROM manual_payment_records p JOIN financial_entries cash ON cash.farm_id=p.farm_id AND cash.source_type='manual_animal_payment' AND cash.source_id=p.id AND cash.kind='payment' WHERE p.revenue_id=f.id AND ($3::timestamptz IS NULL OR cash.observed_at<$3)),0) WHEN 'market_order' THEN COALESCE((SELECT sum(p.amount) FROM commerce_payments p JOIN financial_entries cash ON cash.farm_id=f.farm_id AND cash.source_type='manual_market_payment' AND cash.source_id=p.id AND cash.kind='payment' WHERE p.order_id=f.source_id AND ($3::timestamptz IS NULL OR cash.observed_at<$3)),0) WHEN 'service_booking' THEN COALESCE((SELECT sum(CASE WHEN p.kind='refund' THEN -p.amount ELSE p.amount END) FROM service_payment_records p WHERE p.booking_id=f.source_id AND p.status='recorded' AND ($3::timestamptz IS NULL OR p.acknowledged_at<$3)),0) ELSE 0 END AS paid FROM financial_entries f WHERE f.farm_id=$1 AND ($2::uuid IS NULL OR f.project_id=$2) AND f.kind='revenue' AND NOT EXISTS(SELECT 1 FROM accounting_invoices i WHERE i.farm_id=f.farm_id AND (i.source_entry_id=f.id OR i.financial_entry_id=f.id) AND i.finalized_at IS NOT NULL) AND ($3::timestamptz IS NULL OR f.observed_at<$3) UNION ALL SELECT currency,sum(CASE WHEN kind='sales' THEN amount ELSE 0 END),sum(CASE WHEN kind='cash_received' THEN amount ELSE 0 END) FROM opening_financial_balances WHERE farm_id=$1 AND ($2::uuid IS NULL OR project_id=$2) AND ($3::timestamptz IS NULL OR as_of_date::timestamp AT TIME ZONE $4<$3) GROUP BY currency,project_id) SELECT currency,sum(GREATEST(0,amount-paid)) AS amount FROM obligations GROUP BY currency`,
      [farmId, q.projectId ?? null, q.to ?? null, farm.timezone],
    )
  ).rows;
  const accountingAsOf = (await db.query("SELECT ((COALESCE($1::timestamptz,clock_timestamp())-CASE WHEN $1::timestamptz IS NULL THEN interval '0 seconds' ELSE interval '1 microsecond' END) AT TIME ZONE $2)::date::text AS day", [q.to ?? null, farm.timezone])).rows[0].day;
  const accountingOutstanding = await outstandingInvoices(db, farmId, accountingAsOf);
  const projectCredits = q.projectId ? (await db.query(`SELECT c.corrects_invoice_id,sum((line->>'totalMinor')::numeric)::text AS amount
    FROM accounting_invoices c CROSS JOIN LATERAL jsonb_array_elements(c.snapshot->'lines') line
    WHERE c.farm_id=$1 AND c.finalized_at IS NOT NULL AND c.corrects_invoice_id IS NOT NULL AND c.issue_date<=$2
      AND (line->>'projectId')::uuid=$3::uuid
      AND NOT EXISTS(SELECT 1 FROM accounting_journals v WHERE v.farm_id=c.farm_id AND v.source_kind='invoice_void' AND v.source_id=c.id AND v.posted_on<=$2)
    GROUP BY c.corrects_invoice_id`, [farmId, accountingAsOf, q.projectId])).rows : [];
  for (const invoice of accountingOutstanding.filter(invoice => invoice.kind === "sale")) {
    let amount = BigInt(invoice.balance_minor);
    if (q.projectId) {
      let cumulative = 0n, previous = 0n, share = 0n;
      const total = BigInt(invoice.snapshot.totals.totalMinor);
      const paid = BigInt(invoice.paid_minor);
      for (const line of invoice.snapshot.lines) {
        cumulative += BigInt(line.totalMinor);
        const allocated = total ? halfUp(paid * cumulative, total) : 0n;
        if (line.projectId === q.projectId) share += BigInt(line.totalMinor) - (allocated - previous);
        previous = allocated;
      }
      amount = share - BigInt(projectCredits.find(credit => credit.corrects_invoice_id === invoice.id)?.amount ?? "0");
    }
    receivables.push({ currency: invoice.currency, amount: decimalFromMinor(amount, invoice.minor_unit) });
  }
  const deposits = (
    await db.query(
      `SELECT p.currency,sum(CASE WHEN p.kind='refund' THEN -p.amount ELSE p.amount END) AS amount FROM service_payment_records p JOIN service_bookings b ON b.id=p.booking_id JOIN service_listings s ON s.id=b.service_id WHERE s.farm_id=$1 AND $2::uuid IS NULL AND p.status='recorded' AND ($3::timestamptz IS NULL OR p.acknowledged_at<$3) AND NOT EXISTS(SELECT 1 FROM financial_entries f WHERE f.farm_id=$1 AND f.kind='revenue' AND f.source_type='service_booking' AND f.source_id=b.id AND ($3::timestamptz IS NULL OR f.observed_at<$3)) GROUP BY p.currency`,
      [farmId, q.projectId ?? null, q.to ?? null],
    )
  ).rows;
  const currencies = [
    ...new Set(
      [
        ...totals,
        ...opening,
        ...costRows,
        ...transfers,
        ...receivables,
        ...deposits,
      ].map((r) => r.currency),
    ),
  ].sort();
  const byCurrency = currencies.map((code) => {
    const sum = (rows: any[], kind?: string): bigint =>
      rows
        .filter((r) => r.currency === code && (!kind || r.kind === kind))
        .reduce<bigint>((n, r) => n + reportScaled(r.amount), 0n);
    const recordedCosts = sum(costRows) + sum(opening, "cost") + sum(transfers),
      recordedSales = sum(totals, "revenue") + sum(opening, "sales"),
      cashReceived = sum(totals, "payment") + sum(opening, "cash_received"),
      cashPaid = sum(totals, "cash_out");
    const exact = {
      recordedCosts: reportAmount(recordedCosts, code), recordedSales: reportAmount(recordedSales, code),
      cashReceived: reportAmount(cashReceived, code), cashPaid: reportAmount(cashPaid, code),
      outstandingRecordedSales: reportAmount(sum(receivables), code), unearnedServiceDeposits: reportAmount(sum(deposits), code),
      recordedMargin: reportAmount(recordedSales - recordedCosts, code), inventoryPurchases: reportAmount(sum(purchases), code),
      inputConsumption: reportAmount(sum(totals, "input_consumption"), code), allocatedTransferNet: reportAmount(sum(transfers), code),
    };
    return {
      currency: code, minorUnit: reportCurrencyScale(code), exact,
      recordedCosts: Number(exact.recordedCosts),
      recordedSales: Number(exact.recordedSales),
      cashReceived: Number(exact.cashReceived),
      cashPaid: Number(exact.cashPaid),
      outstandingRecordedSales: Number(exact.outstandingRecordedSales),
      receivablesAsOf: q.to ?? new Date().toISOString(),
      unearnedServiceDeposits: Number(exact.unearnedServiceDeposits),
      recordedMargin: Number(exact.recordedMargin),
      inventoryPurchases: Number(exact.inventoryPurchases),
      inputConsumption: Number(exact.inputConsumption),
      profit: null,
      costsByCategory: costRows.filter((r) => r.currency === code),
      allocatedTransferNet: Number(exact.allocatedTransferNet),
    };
  });
  const missing = (
    await db.query(
      `SELECT count(*)::int AS unpriced_inputs FROM stock_movements m WHERE m.farm_id=$1 AND ($2::uuid IS NULL OR m.project_id=$2) AND m.kind IN('input_use','feed','incubation','consumption','loss') AND m.quantity<0 AND ($3::timestamptz IS NULL OR m.observed_at>=$3) AND ($4::timestamptz IS NULL OR m.observed_at<$4) AND NOT EXISTS(SELECT 1 FROM financial_entries f WHERE f.farm_id=m.farm_id AND f.source_type=m.source_type AND f.source_id=m.source_id AND f.kind='input_consumption') AND NOT EXISTS(SELECT 1 FROM activity_corrections c WHERE c.farm_id=m.farm_id AND c.activity_id=m.source_id AND c.action='reverse')`,
      args,
    )
  ).rows[0];
  const stock = (
    await db.query(
      "SELECT id,project_id,name,unit,quantity,reserved_quantity,unit_cost,currency,grade,location_id,pack_size,pack_unit,CASE WHEN unit_cost IS NULL THEN NULL ELSE round(quantity*unit_cost,2) END AS recorded_value FROM stock_items WHERE farm_id=$1 AND ($2::uuid IS NULL OR project_id=$2) ORDER BY id",
      args.slice(0, 2),
    )
  ).rows;
  const budgets = (
    await db.query(
      "SELECT * FROM project_budgets WHERE farm_id=$1 AND ($2::uuid IS NULL OR project_id=$2) AND NOT EXISTS(SELECT 1 FROM project_budgets b WHERE b.farm_id=project_budgets.farm_id AND b.project_id=project_budgets.project_id AND (b.created_at,b.id)>(project_budgets.created_at,project_budgets.id)) ORDER BY project_id",
      args.slice(0, 2),
    )
  ).rows;
  const budgetByCurrency: any[] = [];
  for (const b of budgets)
    for (const line of b.lines) {
      let bucket = budgetByCurrency.find((x) => x.currency === line.currency);
      if (!bucket) {
        bucket = { currency: line.currency, budget: 0 };
        budgetByCurrency.push(bucket);
      }
      bucket.budget =
        Math.round((bucket.budget + Number(line.amount)) * 10 ** reportCurrencyScale(line.currency)) / 10 ** reportCurrencyScale(line.currency);
    }
  for (const b of budgetByCurrency) {
    b.recordedCosts =
      byCurrency.find((x) => x.currency === b.currency)?.recordedCosts ?? 0;
    b.variance = Math.round((b.budget - b.recordedCosts) * 10 ** reportCurrencyScale(b.currency)) / 10 ** reportCurrencyScale(b.currency);
  }
  const bucket = q.period === "week" ? "week" : "day";
  const series =
    q.period === "season"
      ? []
      : (
          await db.query(
            `${effective} SELECT date_trunc('${bucket}',observed_at AT TIME ZONE $5)::date AS date,currency,kind,sum(effective_amount)::text AS amount FROM effective GROUP BY 1,currency,kind ORDER BY 1,currency,kind`,
            [...args, farm.timezone],
          )
        ).rows;
  return {
    farmName: farm.name,
    timezone: farm.timezone,
    projectId: q.projectId ?? null,
    projectReceivables: q.projectId ? { scope: "attributed_invoice_balance", signed: true, settlement: "invoice_only" } : null,
    from: q.from ?? null,
    to: q.to ?? null,
    period: q.period,
    generatedAt: new Date().toISOString(),
    totals,
    byCurrency,
    openingBalances: opening,
    budgetByCurrency,
    budgets,
    stock,
    series,
    missing: {
      unpricedInputs: missing.unpriced_inputs,
      unvaluedStock: stock.filter((s) => s.unit_cost === null).length,
      unrecordedCosts: "unknown",
      historicalCompleteness: "not_asserted",
    },
    profit: null,
    completeness: "not_asserted",
    basis: "recorded_costs_exclude_inventory_purchase_double_count",
    exchangeRatesApplied: false,
  };
}
const headings = {
  sn: {
    title: "Mushumo wepurazi",
    currency: "Mari",
    cost: "Mari yakashandiswa yakanyorwa",
    sales: "Kutengesa kwakanyorwa",
    received: "Mari yakagamuchirwa",
    paid: "Mari yakabhadharwa",
    margin: "Musiyano wemari yakanyorwa",
    missing: "Mashoko asipo",
    period: "Nguva",
    notice:
      "Uyu mushumo une zvinyorwa zviripo chete. Purofiti yakazara haisati yasimbiswa.",
    inventory: "Zviri mudura",
    budget: "Bhajeti",
    unpriced: "Zvishandiso zvakashandiswa kana kurasika zvisina mutengo",
    unvalued: "Zvinhu zvemudura zvisina mutengo",
    unknownCosts: "Dzimwe mari dzisina kunyorwa hadzizivikanwi.",
    asOf: "Mari ichiri kutarisirwa kubva mukutengesa kwakanyorwa",
    deposit: "Mari yebasa isati yava yekutengesa",
    stockDate: "Dura riri kuratidzwa sezvariri panguva yekugadzira mushumo.",
  },
  nd: {
    title: "Umbiko wepulazi",
    currency: "Imali",
    cost: "Izindleko ezibhaliweyo",
    sales: "Ukuthengiswa okubhaliweyo",
    received: "Imali eyamukelweyo",
    paid: "Imali ebhadalweyo",
    margin: "Umehluko wemali ebhaliweyo",
    missing: "Ulwazi olungekho",
    period: "Isikhathi",
    notice:
      "Umbiko usebenzisa okubhaliweyo kuphela. Inzuzo epheleleyo ayikaqinisekiswa.",
    inventory: "Okusesitolo",
    budget: "Ibhajethi",
    unpriced: "Okusetshenzisiweyo kumbe okulahlekileyo okungela ntengo",
    unvalued: "Okusesitolo okungela ntengo",
    unknownCosts: "Ezinye izindleko ezingabhalwanga azaziwa.",
    asOf: "Imali esele ikweletwa ekuthengiseni okubhaliweyo",
    deposit: "Imali yediphozithi yenkonzo engakapheli",
    stockDate: "Okusesitolo kuvezwa ngesikhathi sokwenziwa kombiko.",
  },
};
let reportFont: Promise<Buffer> | undefined;
export async function summaryPdf(summary: any, language: "sn" | "nd") {
  reportFont ??= readFile(
    new URL(
      "../../fixtures/fonts/NotoSans-Regular.ttf.base64",
      import.meta.url,
    ),
    "utf8",
  ).then((s) => Buffer.from(s, "base64"));
  const font = await reportFont;
  const formatQuantity = new Intl.NumberFormat(language + "-ZW", {
    maximumFractionDigits: 6,
  });
  const h = headings[language],
    doc = new PDFDocument({
      margin: 48,
      size: "A4",
      info: { Title: h.title, Author: "Smart Farmer" },
    });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc
    .font(font)
    .fontSize(22)
    .text(h.title)
    .fontSize(12)
    .text(summary.farmName)
    .moveDown();
  doc
    .fontSize(9)
    .text(
      `${h.period}: ${summary.from ?? "—"} / ${summary.to ?? "—"} (${summary.timezone})`,
    )
    .text(h.notice)
    .moveDown();
  for (const b of summary.byCurrency) {
    doc.fontSize(15).text(`${h.currency}: ${b.currency}`).fontSize(11);
    for (const [key, label] of [
      ["recordedCosts", h.cost],
      ["recordedSales", h.sales],
      ["cashReceived", h.received],
      ["cashPaid", h.paid],
      ["recordedMargin", h.margin],
      ["outstandingRecordedSales", h.asOf],
      ["unearnedServiceDeposits", h.deposit],
    ])
      doc.text(`${label}: ${b.exact?.[key as keyof typeof b.exact] ?? Number(b[key]).toFixed(b.minorUnit)}`);
    doc.moveDown();
  }
  doc.fontSize(14).text(h.inventory).fontSize(9).text(h.stockDate).fontSize(10);
  for (const item of summary.stock)
    doc.text(
      `${item.name}: ${formatQuantity.format(Number(item.quantity))}\u00a0${item.unit}${item.recorded_value === null ? "" : ` · ${item.recorded_value} ${item.currency}`}`,
    );
  doc
    .moveDown()
    .fontSize(14)
    .text(h.missing)
    .fontSize(11)
    .text(`${h.unpriced}: ${summary.missing.unpricedInputs}`)
    .text(`${h.unvalued}: ${summary.missing.unvaluedStock}`)
    .fontSize(10)
    .text(h.unknownCosts)
    .moveDown()
    .fontSize(9)
    .text(h.notice);
  doc.end();
  return done;
}
function csvCell(v: unknown) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function registerFinance(app: FastifyInstance, ctx: Context) {
  app.get(
    "/v1/farms/:farmId/projects/:projectId/budgets",
    async (req, reply) => {
      const a = await auth(ctx, req, reply, manageRoles);
      if (!a) return;
      const { projectId } = pp.parse(req.params),
        q = listQuery.parse(req.query);
      return page(
        (
          await ctx.db.query(
            "SELECT * FROM project_budgets WHERE farm_id=$1 AND project_id=$2 AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM project_budgets WHERE farm_id=$1 AND project_id=$2 AND id=$3)) ORDER BY created_at DESC,id DESC LIMIT $4",
            [a.farmId, projectId, q.cursor ?? null, q.limit + 1],
          )
        ).rows,
        q.limit,
      );
    },
  );
  app.post(
    "/v1/farms/:farmId/projects/:projectId/budgets",
    async (req, reply) => {
      const a = await auth(ctx, req, reply, manageRoles);
      if (!a) return;
      const { projectId } = pp.parse(req.params);
      const b = z
        .object({
          id: uuid,
          versionName: text,
          reason: text,
          lines: z
            .array(
              z
                .object({
                  category,
                  description: text,
                  amount: money,
                  currency,
                })
                .strict(),
            )
            .min(1)
            .max(200),
        })
        .strict()
        .parse(req.body);
      const out = await idempotent(
        ctx,
        a.farmId,
        a.actor,
        b.id,
        { kind: "budget", projectId, ...b },
        async (c) => {
          await project(c, a.farmId, projectId);
          return (
            await c.query(
              "INSERT INTO project_budgets(id,farm_id,project_id,version_name,lines,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
              [
                b.id,
                a.farmId,
                projectId,
                b.versionName,
                JSON.stringify(b.lines),
                b.reason,
                a.actor,
              ],
            )
          ).rows[0];
        },
      );
      return reply.code(out.replayed ? 200 : 201).send(out.body);
    },
  );
  app.get(
    "/v1/farms/:farmId/projects/:projectId/opening-balances",
    async (req, reply) => {
      const a = await auth(ctx, req, reply, manageRoles);
      if (!a) return;
      const { projectId } = pp.parse(req.params),
        q = listQuery.parse(req.query);
      return page(
        (
          await ctx.db.query(
            "SELECT * FROM opening_financial_balances WHERE farm_id=$1 AND project_id=$2 AND ($3::uuid IS NULL OR id<$3) ORDER BY id DESC LIMIT $4",
            [a.farmId, projectId, q.cursor ?? null, q.limit + 1],
          )
        ).rows,
        q.limit,
      );
    },
  );
  app.post(
    "/v1/farms/:farmId/projects/:projectId/opening-balances",
    async (req, reply) => {
      const a = await auth(ctx, req, reply, manageRoles);
      if (!a) return;
      const { projectId } = pp.parse(req.params);
      const b = z
        .object({
          id: uuid,
          asOfDate: z.iso.date(),
          kind: z.enum(["cost", "sales", "cash_received"]),
          amount: money,
          currency,
          source: text,
        })
        .strict()
        .parse(req.body);
      const out = await idempotent(
        ctx,
        a.farmId,
        a.actor,
        b.id,
        { operation: "opening_balance", projectId, ...b },
        async (c) => {
          await project(c, a.farmId, projectId, true);
          if (
            (
              await c.query(
                "SELECT 1 FROM opening_financial_balances WHERE farm_id=$1 AND project_id=$2 AND kind=$3 AND currency=$4",
                [a.farmId, projectId, b.kind, b.currency],
              )
            ).rowCount
          )
            throw new ApiError("opening_balance_already_recorded", 409);
          const result = (
            await c.query(
              "INSERT INTO opening_financial_balances(id,farm_id,project_id,as_of_date,kind,amount,currency,source,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
              [
                b.id,
                a.farmId,
                projectId,
                b.asOfDate,
                b.kind,
                b.amount,
                b.currency,
                b.source,
                a.actor,
              ],
            )
          ).rows[0];
          await audit(
            c,
            a.farmId,
            a.actor,
            "opening_balance",
            b.id,
            "recorded",
            b.source,
            null,
            result,
          );
          return result;
        },
      );
      return reply.code(out.replayed ? 200 : 201).send(out.body);
    },
  );
  app.get("/v1/farms/:farmId/expenses", async (req, reply) => {
    const a = await auth(ctx, req, reply, manageRoles);
    if (!a) return;
    const q = listQuery.parse(req.query);
    return page(
      (
        await ctx.db.query(
          "SELECT f.*,(SELECT i.id FROM accounting_invoices i WHERE i.farm_id=f.farm_id AND i.finalized_at IS NOT NULL AND f.id IN(i.source_entry_id,i.financial_entry_id) LIMIT 1) AS \"accountingInvoiceId\",EXISTS(SELECT 1 FROM accounting_invoices i WHERE i.farm_id=f.farm_id AND i.finalized_at IS NOT NULL AND f.id IN(i.source_entry_id,i.financial_entry_id)) AS \"accountingManaged\",EXISTS(SELECT 1 FROM financial_corrections c WHERE c.entry_id=f.id) AS reversed,COALESCE((SELECT sum(amount) FROM expense_allocations a WHERE a.reversed_at IS NULL AND a.entry_id=f.id),0) AS allocated FROM financial_entries f WHERE farm_id=$1 AND kind='expense' AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT $3",
          [a.farmId, q.cursor ?? null, q.limit + 1],
        )
      ).rows,
      q.limit,
    );
  });
  app.post("/v1/farms/:farmId/expenses", async (req, reply) => {
    const a = await auth(ctx, req, reply, manageRoles);
    if (!a) return;
    const b = z
      .object({
        id: uuid,
        projectId: uuid.nullable().default(null),
        category,
        amount: money.refine((v) => v > 0),
        currency,
        observedAt: when,
        note: text,
        receiptActivityId: uuid.nullable().default(null),
      })
      .strict()
      .parse(req.body);
    const out = await idempotent(
      ctx,
      a.farmId,
      a.actor,
      b.id,
      { operation: "expense", ...b },
      async (c) => {
        await validateProject(c, a.farmId, b.projectId);
        if (b.receiptActivityId)
          row(
            (
              await c.query(
                "SELECT id FROM activities WHERE farm_id=$1 AND id=$2",
                [a.farmId, b.receiptActivityId],
              )
            ).rows[0],
          );
        return (
          await c.query(
            "INSERT INTO financial_entries(id,farm_id,project_id,actor_id,kind,amount,currency,source_type,source_id,observed_at,note,category,receipt_activity_id) VALUES($1,$2,$3,$4,'expense',$5,$6,'documented_expense',$1,$7,$8,$9,$10) RETURNING *",
            [
              b.id,
              a.farmId,
              b.projectId,
              a.actor,
              b.amount,
              b.currency,
              b.observedAt,
              b.note,
              b.category,
              b.receiptActivityId,
            ],
          )
        ).rows[0];
      },
    );
    return reply.code(out.replayed ? 200 : 201).send(out.body);
  });
  app.get(
    "/v1/farms/:farmId/expenses/:entryId/allocations",
    async (req, reply) => {
      const a = await auth(ctx, req, reply, manageRoles);
      if (!a) return;
      const { entryId } = z.object({ entryId: uuid }).parse(req.params);
      return {
        items: (
          await ctx.db.query(
            "SELECT * FROM expense_allocations WHERE farm_id=$1 AND entry_id=$2 AND reversed_at IS NULL ORDER BY created_at,id",
            [a.farmId, entryId],
          )
        ).rows,
      };
    },
  );
  app.post(
    "/v1/farms/:farmId/expenses/:entryId/allocations",
    async (req, reply) => {
      const a = await auth(ctx, req, reply, manageRoles);
      if (!a) return;
      const { entryId } = z.object({ entryId: uuid }).parse(req.params);
      const b = z
        .object({
          id: uuid,
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
            .min(1)
            .max(100),
        })
        .strict()
        .parse(req.body);
      if (
        new Set(b.allocations.map((x) => x.projectId)).size !==
        b.allocations.length
      )
        throw new ApiError("duplicate_allocation_project");
      const out = await idempotent(
        ctx,
        a.farmId,
        a.actor,
        b.id,
        { operation: "allocate", entryId, ...b },
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
                "SELECT 1 FROM activity_corrections WHERE farm_id=$1 AND activity_id=$2 AND action='reverse' UNION ALL SELECT 1 FROM financial_corrections WHERE farm_id=$1 AND entry_id=$3",
                [a.farmId, expense.source_id, entryId],
              )
            ).rowCount
          )
            throw new ApiError("record_reversed", 409);
          const existing = Number(
            (
              await c.query(
                "SELECT COALESCE(sum(amount),0) AS n FROM expense_allocations WHERE entry_id=$1 AND reversed_at IS NULL",
                [entryId],
              )
            ).rows[0].n,
          );
          if (
            Math.round(
              (existing + b.allocations.reduce((s, x) => s + x.amount, 0)) *
                100,
            ) > Math.round(Number(expense.amount) * 100)
          )
            throw new ApiError("allocation_exceeds_expense", 409);
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
            "allocated",
            "documented_allocation_basis",
            null,
            items,
          );
          return { items };
        },
      );
      return reply.code(out.replayed ? 200 : 201).send(out.body);
    },
  );
  app.post("/v1/farms/:farmId/stock/:itemId/packs", async (req, reply) => {
    const a = await auth(ctx, req, reply, manageRoles);
    if (!a) return;
    const { itemId } = z.object({ itemId: uuid }).parse(req.params);
    const b = z
      .object({
        id: uuid,
        kind: z.enum(["purchase", "consumption", "loss"]),
        packCount: z.number().int().positive().max(1e9),
        observedAt: when,
        reason: text,
        amount: money.nullable().default(null),
        currency: currency.nullable().default(null),
      })
      .strict()
      .refine(
        (b) => (b.amount === null) === (b.currency === null),
        "amount_currency_pair_required",
      )
      .parse(req.body);
    if (b.kind !== "purchase" && b.amount !== null)
      throw new ApiError("purchase_amount_only");
    const out = await idempotent(
      ctx,
      a.farmId,
      a.actor,
      b.id,
      { operation: "packs", itemId, ...b },
      async (c) => {
        const snapshot = row(
          (
            await c.query(
              "SELECT project_id FROM stock_items WHERE farm_id=$1 AND id=$2",
              [a.farmId, itemId],
            )
          ).rows[0],
        );
        if (snapshot.project_id) {
          await project(c, a.farmId, snapshot.project_id, true);
          if (b.kind === "consumption")
            await assertReleaseAllowed(c, a.farmId, snapshot.project_id);
        }
        const item = row(
          (
            await c.query(
              "SELECT * FROM stock_items WHERE farm_id=$1 AND id=$2 FOR NO KEY UPDATE",
              [a.farmId, itemId],
            )
          ).rows[0],
        );
        if (!item.pack_size) throw new ApiError("pack_definition_required");
        const n = convertQuantity(
          b.packCount * Number(item.pack_size),
          item.pack_unit,
          item.unit,
        );
        if (n > 1e9) throw new ApiError("quantity_limit");
        await stockMovement(c, {
          farmId: a.farmId,
          itemId,
          projectId: item.project_id,
          actorId: a.actor,
          kind: b.kind,
          quantity: b.kind === "purchase" ? n : -n,
          unit: item.unit,
          sourceType: "stock_pack",
          sourceId: b.id,
          observedAt: b.observedAt,
          note: b.reason,
        });
        if (b.kind === "purchase") {
          const known =
            b.amount !== null &&
            (Number(item.quantity) === 0 ||
              (item.unit_cost !== null && item.currency === b.currency));
          const cost = known
            ? (Number(item.quantity) * Number(item.unit_cost ?? 0) +
                b.amount!) /
              (Number(item.quantity) + n)
            : null;
          await c.query(
            "UPDATE stock_items SET unit_cost=$2,currency=$3 WHERE id=$1",
            [
              itemId,
              cost === null ? null : Math.round(cost * 1e6) / 1e6,
              cost === null ? null : b.currency,
            ],
          );
          if (b.amount !== null)
            await finance(c, {
              farmId: a.farmId,
              projectId: item.project_id,
              actorId: a.actor,
              kind: "expense",
              amount: b.amount,
              currency: b.currency!,
              sourceType: "stock_pack",
              sourceId: b.id,
              observedAt: b.observedAt,
              note: b.reason,
            });
        } else if (
          ["consumption", "loss"].includes(b.kind) &&
          item.unit_cost !== null
        )
          await finance(c, {
            farmId: a.farmId,
            projectId: item.project_id,
            actorId: a.actor,
            kind: "input_consumption",
            amount: Math.round(n * Number(item.unit_cost) * 100) / 100,
            currency: item.currency,
            sourceType: "stock_pack",
            sourceId: b.id,
            observedAt: b.observedAt,
            note: b.reason,
          });
        return { id: b.id, quantity: n, unit: item.unit };
      },
    );
    return reply.code(out.replayed ? 200 : 201).send(out.body);
  });
  app.get("/v1/farms/:farmId/reconciliation", async (req, reply) => {
    const a = await auth(ctx, req, reply, manageRoles);
    if (!a) return;
    const stock = (
      await ctx.db.query(
        "SELECT s.id,s.name,s.quantity,COALESCE(sum(m.quantity),0) AS movement_quantity,s.reserved_quantity,COALESCE((SELECT sum(o.quantity) FROM market_orders o JOIN market_listings l ON l.id=o.listing_id WHERE l.stock_item_id=s.id AND o.status='reserved'),0) AS order_reserved FROM stock_items s LEFT JOIN stock_movements m ON m.farm_id=s.farm_id AND m.stock_item_id=s.id WHERE s.farm_id=$1 GROUP BY s.id ORDER BY s.id",
        [a.farmId],
      )
    ).rows.map((s) => ({
      ...s,
      balanced:
        Number(s.quantity) === Number(s.movement_quantity) &&
        Number(s.reserved_quantity) === Number(s.order_reserved),
    }));
    const { animalReconciliation } = await import("./production.js");
    const animals = await animalReconciliation(ctx.db, a.farmId);
    return {
      stock,
      animals,
      balanced:
        stock.every((s) => s.balanced) && animals.every((a) => a.balanced),
      automaticCorrections: false,
    };
  });
  for (const extension of ["", ".pdf", ".csv"])
    app.get(
      `/v1/farms/:farmId/reports/summary${extension}`,
      async (req, reply) => {
        const a = await auth(ctx, req, reply, manageRoles);
        if (!a) return;
        const q = reportQuery.parse(req.query);
        const summary = await ctx.transaction(async (c) => {
          await c.query(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
          );
          return reportSummary(c, a.farmId, q);
        });
        if (!extension) return summary;
        const language =
          q.language ??
          (row(
            (
              await ctx.db.query("SELECT language FROM users WHERE id=$1", [
                a.actor,
              ])
            ).rows[0],
          ).language as "sn" | "nd");
        if (extension === ".pdf")
          return reply
            .type("application/pdf")
            .header(
              "content-disposition",
              'attachment; filename="smart-farmer-report.pdf"',
            )
            .send(await summaryPdf(summary, language));
        const h = headings[language];
        const rows = [
          [h.currency, h.cost, h.sales, h.received, h.paid, h.margin],
          ...summary.byCurrency.map((b) => [
            b.currency,
            b.exact.recordedCosts,
            b.exact.recordedSales,
            b.exact.cashReceived,
            b.exact.cashPaid,
            b.exact.recordedMargin,
          ]),
        ];
        return reply
          .type("text/csv; charset=utf-8")
          .header(
            "content-disposition",
            'attachment; filename="smart-farmer-summary.csv"',
          )
          .send(
            "\uFEFF" +
              rows.map((r) => r.map(csvCell).join(",")).join("\r\n") +
              "\r\n" +
              csvCell(h.notice),
          );
      },
    );
}
