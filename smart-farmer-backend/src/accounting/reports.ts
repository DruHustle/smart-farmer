import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { ApiError, manageRoles, type Context } from "../context.js";
import { auth } from "../product/common.js";
import { loadInvoiceDetail, type AccountingDb } from "./core.js";
import { currencyScale, decimalFromMinor, decimalScaled, supportedCurrencies } from "./money.js";
import type { AccountingReports, AccountingSummary, AccountingCurrencySummary, AccountingJournal, CurrencyScale, AccountingAccountType } from "./types.js";

const dates = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional(), asOf: z.iso.date().optional() }).refine(q => !q.from || !q.to || q.from <= q.to, "invalid_report_period");
const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(100), cursor: z.uuid().optional() });
const ledgerQuery = pageQuery.extend({ from: z.iso.date().optional(), to: z.iso.date().optional(), asOf: z.iso.date().optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional() }).refine(q => !q.from || !q.to || q.from <= q.to, "invalid_report_period");
const invoiceQuery = pageQuery.extend({ kind: z.enum(["purchase", "sale", "purchase_credit", "sale_credit"]).optional(), status: z.enum(["draft", "posted", "issued", "void"]).optional() });
type DateQuery = z.infer<typeof dates>;
type AccountTotal = { currency: string; minor_unit: CurrencyScale; code: string; name: string; type: AccountingAccountType; debit: string; credit: string };

async function reportRead<T>(ctx: Context, request: FastifyRequest, reply: FastifyReply, read: (client: PoolClient, farmId: string) => Promise<T>) {
  const access = await auth(ctx, request, reply, manageRoles); if (!access) return;
  return ctx.transaction(async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await client.query("SELECT id FROM farms WHERE id=$1 FOR SHARE", [access.farmId]);
    const member = (await client.query("SELECT role FROM memberships WHERE farm_id=$1 AND user_id=$2 FOR SHARE", [access.farmId, access.actor])).rows[0];
    if (!member || !manageRoles.includes(member.role)) throw new ApiError("not_found", 404);
    return read(client, access.farmId);
  });
}
async function reportDates(db: AccountingDb, farmId: string, input: DateQuery) {
  const today = (await db.query("SELECT (clock_timestamp() AT TIME ZONE timezone)::date::text AS today FROM farms WHERE id=$1", [farmId])).rows[0]?.today;
  if (!today) throw new ApiError("not_found", 404);
  const asOf = input.asOf ?? today, through = input.to ?? asOf;
  if (input.from && input.from > through) throw new ApiError("invalid_report_period");
  return { ...input, asOf, through };
}
async function accountTotals(db: AccountingDb, farmId: string, from: string | null, to: string): Promise<AccountTotal[]> {
  return (await db.query(`SELECT j.currency,j.minor_unit,a.code,a.name,a.type,sum(l.debit_minor)::text AS debit,sum(l.credit_minor)::text AS credit
    FROM accounting_journal_lines l JOIN accounting_journals j ON j.farm_id=l.farm_id AND j.id=l.journal_id
    JOIN accounting_accounts a ON a.farm_id=l.farm_id AND a.code=l.account_code
    WHERE j.farm_id=$1 AND ($2::date IS NULL OR j.posted_on>=$2) AND j.posted_on<=$3
    GROUP BY j.currency,j.minor_unit,a.code,a.name,a.type ORDER BY j.currency,a.code`, [farmId, from, to])).rows;
}

/** Invoice obligations at a calendar date, including payments, credits and voids
 * effective then. Later changes cannot rewrite an earlier aged balance. */
export async function outstandingInvoices(db: AccountingDb, farmId: string, asOf: string) {
  return (await db.query(`SELECT i.id,i.kind,i.currency,i.minor_unit,i.due_date::text AS due_date,i.issue_date::text AS issue_date,i.snapshot,
      COALESCE(p.paid,0)::text AS paid_minor,(i.total_minor-COALESCE(p.paid,0)-COALESCE(cr.credited,0))::text AS balance_minor
    FROM accounting_invoices i
    LEFT JOIN LATERAL(SELECT sum(amount_minor) AS paid FROM accounting_payments WHERE farm_id=i.farm_id AND invoice_id=i.id AND paid_on<=$2) p ON true
    LEFT JOIN LATERAL(SELECT sum(c.total_minor) AS credited FROM accounting_invoices c WHERE c.farm_id=i.farm_id AND c.corrects_invoice_id=i.id AND c.finalized_at IS NOT NULL AND c.issue_date<=$2
      AND NOT EXISTS(SELECT 1 FROM accounting_journals v WHERE v.farm_id=c.farm_id AND v.source_kind='invoice_void' AND v.source_id=c.id AND v.posted_on<=$2)) cr ON true
    WHERE i.farm_id=$1 AND i.kind IN('purchase','sale') AND i.finalized_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM accounting_journals original WHERE original.farm_id=i.farm_id AND original.source_kind='invoice' AND original.source_id=i.id AND original.posted_on<=$2)
      AND NOT EXISTS(SELECT 1 FROM accounting_journals v WHERE v.farm_id=i.farm_id AND v.source_kind='invoice_void' AND v.source_id=i.id AND v.posted_on<=$2)
    ORDER BY i.currency,i.due_date NULLS LAST,i.id`, [farmId, asOf])).rows as { id: string; kind: "purchase" | "sale"; currency: string; minor_unit: CurrencyScale; due_date: string | null; issue_date: string; snapshot: any; paid_minor: string; balance_minor: string }[];
}

export async function accountingReports(db: AccountingDb, farmId: string, input: DateQuery): Promise<AccountingReports> {
  const q = await reportDates(db, farmId, input);
  const flows = await accountTotals(db, farmId, q.from ?? null, q.through);
  const cumulative = await accountTotals(db, farmId, null, q.asOf);
  const obligations = await outstandingInvoices(db, farmId, q.asOf);
  const cash = (await db.query(`SELECT currency,sum(GREATEST(net,0))::text AS received,sum(GREATEST(-net,0))::text AS paid FROM (
    SELECT j.id,j.currency,sum(l.debit_minor-l.credit_minor) AS net FROM accounting_journals j JOIN accounting_journal_lines l ON l.farm_id=j.farm_id AND l.journal_id=j.id
    WHERE j.farm_id=$1 AND ($2::date IS NULL OR j.posted_on>=$2) AND j.posted_on<=$3 AND l.account_code IN('1000','1010','1020','1030') GROUP BY j.id,j.currency) cash GROUP BY currency`, [farmId, q.from ?? null, q.through])).rows;
  const codes = [...new Set([...flows, ...cumulative, ...obligations].map(x => x.currency))].sort();
  const net = (rows: AccountTotal[], type: AccountingAccountType, positive: "debit" | "credit") => rows.filter(x => x.type === type).reduce((sum, x) => sum + (positive === "debit" ? BigInt(x.debit) - BigInt(x.credit) : BigInt(x.credit) - BigInt(x.debit)), 0n);
  const accountNet = (rows: AccountTotal[], code: string, credit = false) => rows.filter(x => x.code === code).reduce((sum, x) => sum + (credit ? BigInt(x.credit) - BigInt(x.debit) : BigInt(x.debit) - BigInt(x.credit)), 0n);
  const byCurrency: AccountingCurrencySummary[] = [], trialBalance: AccountingReports["trialBalance"] = [], profitLoss: AccountingReports["profitLoss"] = [], balanceSheet: AccountingReports["balanceSheet"] = [], aging: AccountingReports["aging"] = [];
  for (const currency of codes) {
    const period = flows.filter(x => x.currency === currency), all = cumulative.filter(x => x.currency === currency);
    const minorUnit = [...all, ...period, ...obligations.filter(x => x.currency === currency)][0]?.minor_unit ?? currencyScale(currency);
    const income = net(period, "income", "credit"), expense = net(period, "expense", "debit"), movements = cash.find(x => x.currency === currency);
    const overdue = (kind: "purchase" | "sale") => obligations.filter(x => x.currency === currency && x.kind === kind && x.due_date && x.due_date < q.asOf).reduce((sum, x) => sum + BigInt(x.balance_minor), 0n);
    byCurrency.push({ currency, minorUnit, salesMinor: income.toString(), expensesMinor: expense.toString(), taxCollectedMinor: accountNet(period, "2100", true).toString(), taxOnPurchasesMinor: accountNet(period, "5100").toString(), cashReceivedMinor: movements?.received ?? "0", cashPaidMinor: movements?.paid ?? "0", receivableMinor: accountNet(all, "1100").toString(), payableMinor: accountNet(all, "2000", true).toString(), overdueReceivableMinor: overdue("sale").toString(), overduePayableMinor: overdue("purchase").toString() });
    trialBalance.push({ currency, minorUnit, accounts: all.map(x => ({ code: x.code, name: x.name, type: x.type, debitMinor: x.debit, creditMinor: x.credit, balanceMinor: (BigInt(x.debit) - BigInt(x.credit)).toString() })), totalDebitMinor: all.reduce((sum, x) => sum + BigInt(x.debit), 0n).toString(), totalCreditMinor: all.reduce((sum, x) => sum + BigInt(x.credit), 0n).toString() });
    profitLoss.push({ currency, minorUnit, incomeMinor: income.toString(), expenseMinor: expense.toString(), resultMinor: (income - expense).toString() });
    // Current retained result is included in equity; no unexplained imbalance.
    balanceSheet.push({ currency, minorUnit, assetsMinor: net(all, "asset", "debit").toString(), liabilitiesMinor: net(all, "liability", "credit").toString(), equityMinor: (net(all, "equity", "credit") + net(all, "income", "credit") - net(all, "expense", "debit")).toString() });
    for (const kind of ["purchase", "sale"] as const) {
      const bucket = { kind, currency, minorUnit, currentMinor: "0", days1To30Minor: "0", days31To60Minor: "0", days61To90Minor: "0", over90Minor: "0" };
      for (const invoice of obligations.filter(x => x.currency === currency && x.kind === kind)) {
        const amount = BigInt(invoice.balance_minor); if (amount < 0n) throw new ApiError("accounting_balance_invariant", 500);
        const overdueDays = invoice.due_date ? Math.floor((Date.parse(q.asOf) - Date.parse(invoice.due_date)) / 86400000) : 0;
        const key = overdueDays <= 0 ? "currentMinor" : overdueDays <= 30 ? "days1To30Minor" : overdueDays <= 60 ? "days31To60Minor" : overdueDays <= 90 ? "days61To90Minor" : "over90Minor";
        bucket[key] = (BigInt(bucket[key]) + amount).toString();
      }
      aging.push(bucket);
    }
  }
  const counts = (await db.query(`SELECT (SELECT count(*)::int FROM accounting_invoices WHERE farm_id=$1 AND status='draft') AS drafts,
    (SELECT count(*)::int FROM financial_entries f WHERE f.farm_id=$1 AND f.kind IN('expense','revenue','input_consumption') AND f.source_type NOT IN('accounting_invoice','accounting_payment','record_correction','manual_service_refund')
      AND NOT EXISTS(SELECT 1 FROM accounting_invoices i WHERE i.farm_id=f.farm_id AND (i.source_entry_id=f.id OR i.financial_entry_id=f.id) AND i.finalized_at IS NOT NULL)) AS legacy`, [farmId])).rows[0];
  const summary: AccountingSummary = { from: q.from ?? null, to: q.to ?? null, asOf: q.asOf, byCurrency, draftCount: counts.drafts, unlinkedLegacyEntries: counts.legacy, scope: "accounting_postings", exchangeRatesApplied: false };
  return { summary, trialBalance, profitLoss, balanceSheet, aging };
}

async function journals(db: AccountingDb, farmId: string, query: z.infer<typeof ledgerQuery>, limit = query.limit) {
  if (query.currency) currencyScale(query.currency);
  const asOf = (await reportDates(db, farmId, query)).asOf;
  const through = query.to && query.to < asOf ? query.to : asOf;
  const rows = (await db.query(`SELECT j.*,j.posted_on::text AS posted_on,(SELECT r.id FROM accounting_journals r WHERE r.farm_id=j.farm_id AND r.reversal_of=j.id) AS reversed_by
    FROM accounting_journals j WHERE j.farm_id=$1 AND ($2::uuid IS NULL OR j.id<$2) AND ($3::date IS NULL OR j.posted_on>=$3) AND ($4::date IS NULL OR j.posted_on<=$4) AND ($5::text IS NULL OR j.currency=$5)
    ORDER BY j.id DESC LIMIT $6`, [farmId, query.cursor ?? null, query.from ?? null, through, query.currency ?? null, limit + 1])).rows;
  const visible = rows.slice(0, limit), ids = visible.map(x => x.id);
  const lines = ids.length ? (await db.query('SELECT journal_id,account_code AS "accountCode",debit_minor::text AS "debitMinor",credit_minor::text AS "creditMinor",description,project_id AS "projectId" FROM accounting_journal_lines WHERE farm_id=$1 AND journal_id=ANY($2::uuid[]) ORDER BY journal_id,position', [farmId, ids])).rows : [];
  return { items: visible.map(j => ({ id: j.id, currency: j.currency, minorUnit: j.minor_unit, postedOn: j.posted_on, description: j.description, reason: j.reason, sourceType: j.source_kind, sourceId: j.source_id, reversalOf: j.reversal_of, reversedBy: j.reversed_by, lines: lines.filter(l => l.journal_id === j.id).map(({ journal_id, ...line }) => line) } as AccountingJournal)), nextCursor: rows.length > limit ? visible[visible.length - 1].id : null };
}
const csv = (value: unknown) => { const s = String(value ?? ""); return '"' + (/^\s*[=+\-@\t\r]/.test(s) ? "'" : "") + s.replaceAll('"', '""') + '"'; };
const csvRows = (rows: unknown[][]) => "\uFEFF" + rows.map(row => row.map(csv).join(",")).join("\r\n") + "\r\n";

export function registerAccountingReports(app: FastifyInstance, ctx: Context) {
  const base = "/v1/farms/:farmId/accounting";
  for (const summaryOnly of [false, true]) app.get(`${base}/${summaryOnly ? "summary" : "reports"}`, async (request, reply) => {
    const query = dates.parse(request.query);
    return reportRead(ctx, request, reply, async (client, farmId) => { const report = await accountingReports(client, farmId, query); return summaryOnly ? report.summary : report; });
  });
  app.get(`${base}/invoices`, async (request, reply) => {
    const query = invoiceQuery.parse(request.query);
    return reportRead(ctx, request, reply, async (client, farmId) => {
      const rows = (await client.query("SELECT id FROM accounting_invoices WHERE farm_id=$1 AND ($2::uuid IS NULL OR id<$2) AND ($3::text IS NULL OR kind=$3) AND ($4::text IS NULL OR status=$4) ORDER BY id DESC LIMIT $5", [farmId, query.cursor ?? null, query.kind ?? null, query.status ?? null, query.limit + 1])).rows;
      const items = []; for (const row of rows.slice(0, query.limit)) items.push(await loadInvoiceDetail(client, farmId, row.id));
      return { items, nextCursor: rows.length > query.limit ? items[items.length - 1].id : null };
    });
  });
  app.get(`${base}/ledger`, async (request, reply) => { const query = ledgerQuery.parse(request.query); return reportRead(ctx, request, reply, (client, farmId) => journals(client, farmId, query)); });
  app.get(`${base}/ledger.csv`, async (request, reply) => {
    const query = ledgerQuery.parse(request.query);
    const output = await reportRead(ctx, request, reply, async (client, farmId) => {
      const asOf = (await reportDates(client, farmId, query)).asOf;
      const through = query.to && query.to < asOf ? query.to : asOf;
      // Bound exported lines before fetching descriptions; ask for a date range
      // instead of silently truncating a financial export.
      const count = (await client.query("SELECT count(*)::int AS n FROM accounting_journal_lines l JOIN accounting_journals j ON j.farm_id=l.farm_id AND j.id=l.journal_id WHERE j.farm_id=$1 AND ($2::date IS NULL OR j.posted_on>=$2) AND j.posted_on<=$3 AND ($4::text IS NULL OR j.currency=$4)", [farmId, query.from ?? null, through, query.currency ?? null])).rows[0].n;
      if (count > 20_000) throw new ApiError("export_too_large", 400);
      const ledger = await journals(client, farmId, { ...query, cursor: undefined }, 10_000);
      if (ledger.nextCursor) throw new ApiError("export_too_large", 400);
      return csvRows([["Journal", "Date", "As of", "Currency", "Minor unit", "Source type", "Source", "Account", "Debit minor", "Credit minor", "Debit", "Credit", "Description", "Reason", "Reversal of"], ...ledger.items.flatMap(j => j.lines.map(l => [j.id, j.postedOn, asOf, j.currency, j.minorUnit, j.sourceType, j.sourceId, l.accountCode, l.debitMinor, l.creditMinor, decimalFromMinor(l.debitMinor, j.minorUnit), decimalFromMinor(l.creditMinor, j.minorUnit), l.description || j.description, j.reason, j.reversalOf]))]);
    });
    if (output !== undefined) return reply.type("text/csv; charset=utf-8").header("Content-Disposition", 'attachment; filename="farmer-accounting-ledger.csv"').send(output);
  });
  app.get(`${base}/invoices.csv`, async (request, reply) => {
    const query = ledgerQuery.parse(request.query);
    const output = await reportRead(ctx, request, reply, async (client, farmId) => {
      const asOf = (await reportDates(client, farmId, query)).asOf;
      const rows = (await client.query(`SELECT i.*,i.issue_date::text AS issue_date,i.due_date::text AS due_date,COALESCE(p.paid,0)::text AS paid,COALESCE(c.credited,0)::text AS credited,
        EXISTS(SELECT 1 FROM accounting_journals v WHERE v.farm_id=i.farm_id AND v.source_kind='invoice_void' AND v.source_id=i.id AND v.posted_on<=$5) AS void_as_of
        FROM accounting_invoices i
        LEFT JOIN LATERAL(SELECT sum(amount_minor) AS paid FROM accounting_payments p WHERE p.farm_id=i.farm_id AND p.invoice_id=i.id AND p.paid_on<=$5) p ON true
        LEFT JOIN LATERAL(SELECT sum(total_minor) AS credited FROM accounting_invoices c WHERE c.farm_id=i.farm_id AND c.corrects_invoice_id=i.id AND c.finalized_at IS NOT NULL AND c.issue_date<=$5
          AND NOT EXISTS(SELECT 1 FROM accounting_journals v WHERE v.farm_id=c.farm_id AND v.source_kind='invoice_void' AND v.source_id=c.id AND v.posted_on<=$5)) c ON true
        WHERE i.farm_id=$1 AND i.issue_date<=$5 AND ($2::date IS NULL OR i.issue_date>=$2) AND ($3::date IS NULL OR i.issue_date<=$3) AND ($4::text IS NULL OR i.currency=$4) ORDER BY i.currency,i.issue_date,i.id LIMIT 10001`, [farmId, query.from ?? null, query.to ?? null, query.currency ?? null, asOf])).rows;
      if (rows.length > 10_000) throw new ApiError("export_too_large", 400);
      return csvRows([["Invoice", "Number", "Kind", "Status as of", "As of", "Counterparty", "Reference", "Date", "Due date", "Currency", "Minor unit", "Total minor", "Paid minor", "Credited minor", "Balance minor", "Total", "Balance"], ...rows.map(i => {
        const status = i.finalized_at ? i.void_as_of ? "void" : i.kind.startsWith("sale") ? "issued" : "posted" : i.status;
        const balance = i.finalized_at && !i.void_as_of && ["purchase", "sale"].includes(i.kind) ? BigInt(i.total_minor) - BigInt(i.paid) - BigInt(i.credited) : 0n;
        return [i.id, i.number, i.kind, status, asOf, i.content.party.name, i.content.reference, i.issue_date, i.due_date, i.currency, i.minor_unit, i.total_minor, i.paid, i.credited, balance.toString(), decimalFromMinor(i.total_minor, i.minor_unit), decimalFromMinor(balance, i.minor_unit)];
      })]);
    });
    if (output !== undefined) return reply.type("text/csv; charset=utf-8").header("Content-Disposition", 'attachment; filename="farmer-invoices.csv"').send(output);
  });
  app.get(`${base}/sources`, async (request, reply) => {
    const query = pageQuery.extend({ kind: z.enum(["purchase", "sale"]) }).parse(request.query);
    return reportRead(ctx, request, reply, async (client, farmId) => {
      const rows = (await client.query(`SELECT f.*,((f.observed_at AT TIME ZONE farm.timezone)::date)::text AS posted_on,i.id AS invoice_id FROM financial_entries f JOIN farms farm ON farm.id=f.farm_id
        LEFT JOIN accounting_invoices i ON i.farm_id=f.farm_id AND i.source_entry_id=f.id AND i.finalized_at IS NOT NULL AND i.status<>'void'
        WHERE f.farm_id=$1 AND f.kind=$2 AND f.amount>0 AND f.source_type NOT IN('accounting_invoice','accounting_payment','record_correction','manual_service_refund')
          AND NOT EXISTS(SELECT 1 FROM financial_corrections c WHERE c.farm_id=f.farm_id AND c.entry_id=f.id)
          AND NOT EXISTS(SELECT 1 FROM activity_corrections c WHERE c.farm_id=f.farm_id AND c.activity_id=f.source_id AND c.action='reverse')
          AND ($3::uuid IS NULL OR f.id<$3) AND f.currency=ANY($4::text[]) ORDER BY f.id DESC LIMIT $5`, [farmId, query.kind === "purchase" ? "expense" : "revenue", query.cursor ?? null, supportedCurrencies.map(x => x.code), query.limit + 1])).rows;
      const visible = rows.slice(0, query.limit);
      const allocations = visible.length ? (await client.query("SELECT entry_id,project_id,sum(amount)::text AS amount FROM expense_allocations WHERE farm_id=$1 AND entry_id=ANY($2::uuid[]) AND reversed_at IS NULL GROUP BY entry_id,project_id", [farmId, visible.map(x => x.id)])).rows : [];
      return { items: visible.map(f => {
        const minorUnit = currencyScale(f.currency);
        const projects = new Map<string | null, bigint>([[f.project_id, decimalScaled(f.amount, 3)]]);
        for (const allocation of allocations.filter(x => x.entry_id === f.id)) {
          const amount = decimalScaled(allocation.amount, 3);
          projects.set(f.project_id, (projects.get(f.project_id) ?? 0n) - amount);
          projects.set(allocation.project_id, (projects.get(allocation.project_id) ?? 0n) + amount);
        }
        let amountMinor: string | null = null, eligible = true;
        try { amountMinor = decimalScaled(f.amount, minorUnit).toString(); } catch { eligible = false; }
        const attribution = [...projects].filter(([,amount]) => amount !== 0n).map(([projectId,amount]) => {
          const originalAmount = decimalFromMinor(amount, 3); let projectMinor: string | null = null;
          try { projectMinor = decimalScaled(originalAmount, minorUnit).toString(); } catch { eligible = false; }
          return { projectId, amountMinor: projectMinor, originalAmount };
        });
        return { id: f.id, description: f.note, reference: "", postedOn: f.posted_on, amountMinor, originalAmount: f.amount, eligible, eligibilityError: eligible ? null : "source_currency_precision", currency: f.currency, minorUnit, sourceType: f.source_type, sourceId: f.source_id, alreadyInvoiced: Boolean(f.invoice_id), invoiceId: f.invoice_id ?? null, projects: attribution };
      }), nextCursor: rows.length > query.limit ? rows[query.limit - 1].id : null };
    });
  });
}
