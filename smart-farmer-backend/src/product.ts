import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import type { Context } from "./context.js";
import { registerPlanning } from "./product/planning.js";
import { registerFinance } from "./product/finance.js";
import { registerFinancialCorrections } from "./product/financial-admin.js";
import { registerInventory } from "./product/inventory.js";
import { registerProduction } from "./product/production.js";
import { runMarketMaintenance } from "./product/market-ledger.js";
export function registerProduct(app: FastifyInstance, ctx: Context) {
  registerPlanning(app, ctx);
  registerFinance(app, ctx);
  registerProduction(app, ctx);
  registerInventory(app, ctx);
  registerFinancialCorrections(app, ctx);
}
export async function runProductMaintenance(client: PoolClient) {
  return runMarketMaintenance(client);
}
