import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { buildApp } from "../src/app.js";
import type { IntegrationOptions } from "../src/integrations.js";
import {
  createPaymentProvider,
  PaymentProviderUnavailableError,
  UnconfiguredPaymentProvider,
  type PaymentProvider,
  type PaymentIntentRequest,
  type SettlementVerificationRequest,
} from "../src/integrations/payments.js";

const intentRequest = (): PaymentIntentRequest => ({
  idempotencyKey: randomUUID(),
  actorId: randomUUID(),
  reference: { farmId: randomUUID(), kind: "market_order", id: randomUUID() },
  money: { minorUnits: 1250n, currency: "USD" },
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
});

const verificationRequest = (): SettlementVerificationRequest => ({
  providerIntentId: "unconfigured-reference",
  reference: { farmId: randomUUID(), kind: "market_order", id: randomUUID() },
  expectedMoney: { minorUnits: 1250n, currency: "USD" },
});

const unavailable = (error: unknown) =>
  error instanceof PaymentProviderUnavailableError &&
  error.code === "payment_provider_unconfigured" &&
  error.status === 503 &&
  error.retryable === false;

test("payment provider defaults to unavailable, refuses intent/settlement operations and keeps test mode explicit", async () => {
  const provider = createPaymentProvider();
  assert.deepEqual(provider.getStatus(), {
    provider: null,
    mode: "unconfigured",
    configured: false,
    capabilities: { createIntents: false, verifySettlements: false },
    supportedCurrencies: [],
  });
  for (const kind of [
    "market_order",
    "animal_revenue",
    "service_booking",
  ] as const) {
    const intent = intentRequest(),
      verification = verificationRequest();
    await assert.rejects(
      provider.createIntent({
        ...intent,
        reference: { ...intent.reference, kind },
      }),
      unavailable,
    );
    await assert.rejects(
      provider.verifySettlement({
        ...verification,
        reference: { ...verification.reference, kind },
      }),
      unavailable,
    );
  }
  const testOnly: PaymentProvider = {
    getStatus: () => ({
      provider: "contract-fixture",
      mode: "test",
      configured: true,
      capabilities: { createIntents: false, verifySettlements: false },
      supportedCurrencies: [],
    }),
    createIntent: (request) => provider.createIntent(request),
    verifySettlement: (request) => provider.verifySettlement(request),
  };
  assert.equal(createPaymentProvider(testOnly).getStatus().mode, "test");
  assert.equal(
    createPaymentProvider().getStatus().mode,
    "unconfigured",
    "Injection cannot change another application instance",
  );
  await assert.rejects(testOnly.createIntent(intentRequest()), unavailable);
});

async function fixture(integrations: IntegrationOptions = {}) {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, "TEST_DATABASE_URL must identify disposable PostgreSQL");
  const schema = "payments_" + randomUUID().replaceAll("-", ""),
    admin = new pg.Pool({ connectionString: url });
  await admin.query("CREATE SCHEMA " + schema);
  const db = new pg.Pool({
    connectionString: url,
    options: "-c search_path=" + schema,
  });
  for (const file of (await readdir(new URL("../migrations", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await db.query(
      await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"),
    );
  }
  const app = buildApp(db, "http://localhost:5173", integrations);
  app.log.level = "silent";
  async function register() {
    const credentials = {
      username: "payments_" + randomUUID().slice(0, 8),
      password: "Payment-fixture-only!2026",
    };
    const created = await app.inject({
      method: "POST",
      url: "/v1/register",
      payload: {
        ...credentials,
        farmName: "Payment boundary fixture",
        language: "sn",
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const session = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: credentials,
    });
    assert.equal(session.statusCode, 200, session.body);
    return {
      ...created.json(),
      headers: { authorization: "Bearer " + session.json().token },
    };
  }
  const owner = await register(),
    prefix = "/v1/farms/" + owner.farmId;
  const send = (method: any, path: string, payload?: any, actor = owner) =>
    app.inject({
      method,
      url: path.startsWith("/v1") ? path : prefix + path,
      headers: actor.headers,
      ...(payload === undefined ? {} : { payload }),
    });
  async function ok(
    method: any,
    path: string,
    payload?: any,
    status = 200,
    actor = owner,
  ) {
    const response = await send(method, path, payload, actor);
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  }
  return {
    app,
    db,
    owner,
    prefix,
    register,
    send,
    ok,
    close: async () => {
      await app.close();
      await db.end();
      await admin.query("DROP SCHEMA " + schema + " CASCADE");
      await admin.end();
    },
  };
}

test("payment capability API requires current farm access, exposes no adapter secrets and has no financial effects", async () => {
  const base = new UnconfiguredPaymentProvider();
  let statusReads = 0;
  const provider: PaymentProvider = {
    getStatus: () => {
      statusReads++;
      return { ...base.getStatus(), secret: "private-test-adapter-secret" };
    },
    createIntent: (request) => base.createIntent(request),
    verifySettlement: (request) => base.verifySettlement(request),
  };
  const f = await fixture({ paymentProvider: provider });
  try {
    const path = f.prefix + "/payment-provider";
    assert.equal(
      (await f.app.inject({ method: "GET", url: path })).statusCode,
      401,
    );
    assert.equal(
      statusReads,
      0,
      "Unauthenticated access must not query an adapter",
    );
    const outsider = await f.register();
    assert.equal(
      (await f.send("GET", path, undefined, outsider)).statusCode,
      404,
    );
    assert.equal(statusReads, 0, "Cross-farm access must not query an adapter");
    const status = await f.ok("GET", path + "?mode=live&providerVerified=true");
    assert.deepEqual(status, {
      provider: null,
      mode: "unconfigured",
      configured: false,
      capabilities: { createIntents: false, verifySettlements: false },
      supportedCurrencies: [],
      manualReceipts: {
        available: true,
        provenance: "manual",
        providerVerified: false,
      },
    });
    assert.equal(statusReads, 1);
    assert.equal(
      JSON.stringify(status).includes("private-test-adapter-secret"),
      false,
    );
    await assert.rejects(provider.createIntent(intentRequest()), unavailable);
    await assert.rejects(
      provider.verifySettlement(verificationRequest()),
      unavailable,
    );
    for (const suffix of ["/intents", "/settlements"]) {
      const response = await f.send("POST", path + suffix, {
        providerVerified: true,
        amount: 12.5,
        currency: "USD",
      });
      assert.equal(
        response.statusCode,
        404,
        "There is no public route to assert processor settlement",
      );
    }
    for (const table of [
      "financial_entries",
      "commerce_payments",
      "manual_payment_records",
      "service_payment_records",
    ]) {
      assert.equal(
        Number(
          (await f.db.query("SELECT count(*) AS n FROM " + table)).rows[0].n,
        ),
        0,
      );
    }
    await f.db.query(
      "DELETE FROM memberships WHERE farm_id=$1 AND user_id=$2",
      [f.owner.farmId, f.owner.userId],
    );
    assert.equal(
      (await f.send("GET", path)).statusCode,
      404,
      "Current membership is rechecked on every capability read",
    );
  } finally {
    await f.close();
  }
});

test("manual market, animal and service receipts remain manual, idempotent and independent of the processor boundary", async () => {
  const base = new UnconfiguredPaymentProvider();
  let providerCalls = 0;
  const provider: PaymentProvider = {
    getStatus: () => base.getStatus(),
    createIntent: (request) => {
      providerCalls++;
      return base.createIntent(request);
    },
    verifySettlement: (request) => {
      providerCalls++;
      return base.verifySettlement(request);
    },
  };
  const f = await fixture({ paymentProvider: provider });
  try {
    const buyer = await f.register(),
      buyerPrefix = "/v1/farms/" + buyer.farmId;
    const stock = await f.ok(
      "POST",
      "/stock",
      {
        id: randomUUID(),
        name: "Manual payment produce",
        quantity: 5,
        unit: "kg",
      },
      201,
    );
    const listing = await f.ok(
      "POST",
      "/listings",
      {
        id: randomUUID(),
        stockItemId: stock.id,
        title: "Recorded produce",
        quantity: 5,
        price: 2,
        currency: "USD",
        collectionArea: "Test district",
      },
      201,
    );
    const order = await f.ok(
      "POST",
      `/v1/market/listings/${listing.id}/orders`,
      { id: randomUUID(), quantity: 2 },
      201,
      buyer,
    );
    await f.ok("POST", `/v1/market/orders/${order.id}/status`, {
      status: "fulfilled",
    });
    const marketBody = {
      id: randomUUID(),
      amount: 2,
      currency: "USD",
      note: "Cash receipt",
    };
    const marketPath = `/v1/market/orders/${order.id}/payments`;
    const market = await f.ok("POST", marketPath, marketBody, 201);
    assert.equal(market.provenance, "manual");
    assert.equal(market.providerVerified, false);
    await f.ok("POST", marketPath, marketBody);
    assert.equal(
      (
        await f.send("POST", marketPath, {
          ...marketBody,
          id: randomUUID(),
          providerVerified: true,
        })
      ).statusCode,
      400,
    );

    const now = new Date().toISOString();
    const animals = await f.ok(
      "POST",
      "/projects",
      {
        name: "Manual animal receipt",
        enterpriseType: "broiler",
        asOfDate: now.slice(0, 10),
        openingCount: 1,
        countBasis: "verified",
      },
      201,
    );
    const saleId = randomUUID();
    await f.ok(
      "POST",
      `/projects/${animals.id}/events`,
      {
        id: saleId,
        type: "sale",
        observedAt: now,
        count: 1,
        amount: 6,
        currency: "USD",
      },
      201,
    );
    const revenue = (
      await f.db.query(
        "SELECT id FROM financial_entries WHERE source_type='animal_event' AND source_id=$1 AND kind='revenue'",
        [saleId],
      )
    ).rows[0];
    const animalBody = {
      id: randomUUID(),
      revenueId: revenue.id,
      amount: 3,
      currency: "USD",
      observedAt: now,
      note: "Recorded animal cash receipt",
    };
    const animalPath = `/projects/${animals.id}/payments`;
    const animal = await f.ok("POST", animalPath, animalBody, 201);
    assert.equal(animal.provenance, "manual");
    assert.equal(animal.providerVerified, false);
    await f.ok("POST", animalPath, animalBody);
    assert.equal(
      (
        await f.send("POST", animalPath, {
          ...animalBody,
          id: randomUUID(),
          providerVerified: true,
        })
      ).statusCode,
      400,
    );

    const service = await f.ok(
      "POST",
      "/services",
      {
        id: randomUUID(),
        name: "Manual service receipt",
        description: "Test service",
        serviceArea: "Test district",
        rate: 10,
        currency: "USD",
        rateBasis: "hour",
        operatorIncluded: true,
        fuelIncluded: true,
      },
      201,
    );
    const booking = await f.ok(
      "POST",
      `/v1/services/${service.id}/bookings`,
      {
        id: randomUUID(),
        farmId: buyer.farmId,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 90_000_000).toISOString(),
      },
      201,
      buyer,
    );
    const quote = await f.ok("POST", `/bookings/${booking.id}/status`, {
      status: "quoted",
      version: 1,
      amount: 10,
      currency: "USD",
      depositRequired: 4,
    });
    await f.ok(
      "POST",
      `${buyerPrefix}/bookings/${booking.id}/status`,
      { status: "confirmed", version: quote.version },
      200,
      buyer,
    );
    const serviceBody = {
      id: randomUUID(),
      kind: "deposit",
      amount: 4,
      currency: "USD",
      note: "Provider records actual cash",
    };
    const servicePath = `/bookings/${booking.id}/payments`;
    const receipt = await f.ok("POST", servicePath, serviceBody, 201);
    assert.equal(receipt.provenance, "manual");
    assert.equal(receipt.providerVerified, false);
    await f.ok("POST", servicePath, serviceBody);
    assert.equal(
      (
        await f.send("POST", servicePath, {
          ...serviceBody,
          id: randomUUID(),
          providerVerified: true,
        })
      ).statusCode,
      400,
    );

    assert.deepEqual(
      (
        await f.db.query(
          "SELECT source_type,kind,amount::text FROM financial_entries WHERE source_id=ANY($1::uuid[]) ORDER BY source_type,kind",
          [[marketBody.id, animalBody.id, serviceBody.id]],
        )
      ).rows,
      [
        {
          source_type: "manual_animal_payment",
          kind: "payment",
          amount: "3.00",
        },
        {
          source_type: "manual_market_payment",
          kind: "payment",
          amount: "2.00",
        },
        {
          source_type: "manual_service_payment",
          kind: "cash_out",
          amount: "4.00",
        },
        {
          source_type: "manual_service_payment",
          kind: "payment",
          amount: "4.00",
        },
      ],
    );
    assert.equal(
      Number(
        (
          await f.db.query(
            "SELECT count(*) AS n FROM financial_entries WHERE source_type='service_booking'",
          )
        ).rows[0].n,
      ),
      0,
      "A service deposit is not completed-job revenue or expense",
    );
    assert.equal(
      providerCalls,
      0,
      "Manual recording never creates an external intent or asserts provider settlement",
    );
    assert.equal((await f.ok("GET", "/payment-provider")).mode, "unconfigured");
  } finally {
    await f.close();
  }
});
