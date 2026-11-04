import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import sharp from "sharp";
import { buildApp } from "../src/app.js";
import { runProductMaintenance } from "../src/product.js";
import { addFarmDays } from "../src/product/planning.js";
const url = process.env.TEST_DATABASE_URL;
const at = "2026-11-03T10:00:00+02:00";
const future = () => new Date(Date.now() + 86400000 * 7).toISOString();
async function fixture() {
  assert.ok(
    url,
    "TEST_DATABASE_URL is required; product tests use real disposable PostgreSQL.",
  );
  const admin = new pg.Pool({ connectionString: url }),
    schema = `product_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new pg.Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
  });
  for (const name of (await readdir(new URL("../migrations", import.meta.url)))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await db.query(
      await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
    );
  const media = await mkdtemp(join(tmpdir(), "product-media-"));
  process.env.MEDIA_ROOT = media;
  const app = buildApp(db, "http://localhost:5173");
  const register = async (name: string) => {
    const username = `${name}_${randomUUID().slice(0, 8)}`,
      password = "test-product-password-2026";
    const created = await app.inject({
      method: "POST",
      url: "/v1/register",
      payload: {
        username,
        password,
        language: "sn",
        farmName: `${name} fixture`,
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const login = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { username, password },
    });
    assert.equal(login.statusCode, 200, login.body);
    return {
      ...created.json(),
      headers: { authorization: `Bearer ${login.json().token}` },
    };
  };
  const owner = await register("owner"),
    prefix = `/v1/farms/${owner.farmId}`;
  const send = async (
    method: any,
    path: string,
    payload?: any,
    actor = owner,
  ) =>
    app.inject({
      method,
      url: path.startsWith("/v1") ? path : prefix + path,
      headers: actor.headers,
      ...(payload === undefined ? {} : { payload }),
    });
  const post = async (
    path: string,
    payload: any,
    status = 201,
    actor = owner,
  ) => {
    const r = await send("POST", path, payload, actor);
    assert.equal(r.statusCode, status, `${path}: ${r.body}`);
    return r.json();
  };
  const get = async (path: string, actor = owner) => {
    const r = await send("GET", path, undefined, actor);
    assert.equal(r.statusCode, 200, `${path}: ${r.body}`);
    return r.json();
  };
  const project = async (
    type = "crop",
    count = 0,
    more: any = {},
    actor = owner,
  ) =>
    post(
      `/v1/farms/${actor.farmId}/projects`,
      type === "crop"
        ? { name: "Existing maize", crop: "maize", ...more }
        : {
            name: `${type} fixture`,
            enterpriseType: type,
            asOfDate: "2026-11-03",
            openingCount: count,
            countBasis: "verified",
            ...more,
          },
      201,
      actor,
    );
  const stock = async (
    name: string,
    unit: string,
    quantity: number,
    more: any = {},
  ) => post("/stock", { id: randomUUID(), name, unit, quantity, ...more });
  const event = async (id: string, type: string, more: any = {}) =>
    post(`/projects/${id}/events`, {
      id: randomUUID(),
      type,
      observedAt: at,
      ...more,
    });
  const count = async (id: string) =>
    Number(
      (await db.query("SELECT current_count FROM projects WHERE id=$1", [id]))
        .rows[0].current_count,
    );
  const state = async (id: string) =>
    (await db.query("SELECT * FROM projects WHERE id=$1", [id])).rows[0];
  const close = async () => {
    await app.close();
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(media, { recursive: true, force: true });
  };
  return {
    app,
    db,
    owner,
    prefix,
    register,
    send,
    post,
    get,
    project,
    stock,
    event,
    count,
    state,
    close,
  };
}

test("versioned sourced plans require approval, preserve completed work and reject changed reschedule previews", async () => {
  const f = await fixture();
  try {
    const p = await f.project("crop", 0, { onboardingMode: "new" });
    assert.equal((await f.state(p.id)).planting_date, null);
    await f.post(`/projects/${p.id}/records`, {
      id: randomUUID(),
      type: "assessment",
      observedAt: at,
      details: {
        soilType: "Observed sandy soil",
        waterAvailability: "Recorded borehole",
        pastCrops: "Recorded beans",
        usableAreaHa: 2,
        source: "Owner field assessment",
      },
    });
    assert.equal(
      (
        await f.send("POST", `/projects/${p.id}/records`, {
          id: randomUUID(),
          type: "soil_test",
          observedAt: at,
          details: {
            measurement: "pH",
            value: 6.2,
            unit: "pH",
            sampleLocation: "Plot A",
          },
        })
      ).statusCode,
      400,
      "soil observations require source and report date",
    );
    const t = await f.post("/templates", {
      id: randomUUID(),
      name: "Sourced field plan",
      enterpriseType: "crop",
      source: "Farmer approved agronomist sheet",
      sourceDate: "2026-11-01",
      language: "sn",
      steps: [
        {
          key: "inspect",
          title: "Ongorora munda",
          instructions: "Record observed condition",
          offsetDays: 0,
          requiredEvidence: "Field observation",
        },
        {
          key: "review",
          title: "Ongorora zvakare",
          instructions: "Review measured result",
          offsetDays: 7,
        },
      ],
    });
    const edit = await f.send("PATCH", `/templates/${t.id}`, {
      version: 1,
      reason: "Agronomist revised schedule",
      steps: [
        {
          key: "inspect",
          title: "Revised title",
          instructions: "Revised instruction",
          offsetDays: 1,
        },
      ],
    });
    assert.equal(edit.statusCode, 200, edit.body);
    const plan = await f.post(`/projects/${p.id}/plans`, {
      id: randomUUID(),
      templateId: t.id,
      templateVersion: 1,
      anchorAt: at,
      assigneeId: f.owner.userId,
    });
    assert.equal(plan.preview.length, 2);
    assert.equal(plan.template_snapshot.steps[0].title, "Ongorora munda");
    assert.equal((await f.get("/tasks")).items.length, 0);
    const approval = { id: randomUUID(), version: 1, confirmed: true };
    const approvals = await Promise.all([
      f.send("POST", `/projects/${p.id}/plans/${plan.id}/approve`, approval),
      f.send("POST", `/projects/${p.id}/plans/${plan.id}/approve`, approval),
    ]);
    assert.deepEqual(approvals.map((r) => r.statusCode).sort(), [200, 201]);
    const approved = approvals[0].json(),
      tasks = (await f.get("/tasks")).items;
    assert.equal(tasks.length, 2);
    assert.equal(
      Number(
        (await f.db.query("SELECT count(*) FROM activities")).rows[0].count,
      ),
      0,
      "approval schedules work without claiming completion",
    );
    const completed = tasks.find((t: any) => t.plan_step_key === "inspect");
    assert.equal(
      (
        await f.send("PATCH", `/tasks/${completed.id}`, {
          version: 1,
          status: "completed",
          evidence: "Observed and recorded",
        })
      ).statusCode,
      200,
    );
    const body = {
      id: randomUUID(),
      version: approved.version,
      anchorAt: "2026-11-10T10:00:00+02:00",
      reason: "Farmer confirmed new start",
      confirmed: false,
    };
    const preview = await f.post(
      `/projects/${p.id}/plans/${plan.id}/reschedule`,
      body,
      200,
    );
    assert.equal(preview.changes.length, 1);
    const changed = preview.changes[0];
    assert.equal(
      (
        await f.send("PATCH", `/tasks/${changed.taskId}`, {
          version: 1,
          dueAt: "2026-11-15T10:00:00+02:00",
          reason: "Manager changed date",
        })
      ).statusCode,
      200,
    );
    const stale = await f.send(
      "POST",
      `/projects/${p.id}/plans/${plan.id}/reschedule`,
      { ...body, confirmed: true, impactToken: preview.impactToken },
    );
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, "schedule_preview_required");
    const refreshed = await f.post(
      `/projects/${p.id}/plans/${plan.id}/reschedule`,
      body,
      200,
    );
    const applied = await f.post(
      `/projects/${p.id}/plans/${plan.id}/reschedule`,
      { ...body, confirmed: true, impactToken: refreshed.impactToken },
      200,
    );
    assert.equal(applied.requiresConfirmation, false);
    assert.equal(
      (await f.get("/tasks")).items.find((t: any) => t.id === completed.id)
        .status,
      "completed",
    );
    assert.equal((await f.get(`/templates/${t.id}/versions`)).items.length, 2);
    assert.equal(
      addFarmDays("2026-03-07T10:00:00-05:00", 1, "America/New_York"),
      "2026-03-08T14:00:00.000Z",
      "farm wall time survives daylight-saving transition",
    );
    const compare = await f.post(`/projects/${p.id}/comparisons`, {
      id: randomUUID(),
      objective: "Compare sourced choices",
      budget: 100,
      currency: "USD",
      candidates: [
        {
          crop: "maize",
          reason: "Existing experience",
          source: "Owner",
          estimatedCost: 90,
          currency: "USD",
          waterFit: "suitable",
          labourFit: "unknown",
          soilFit: "suitable",
        },
        {
          crop: "beans",
          reason: "Alternative",
          source: "Owner",
          waterFit: "unknown",
          labourFit: "unsuitable",
        },
      ],
    });
    assert.equal(compare.candidates[0].crop, "maize");
    assert.ok(compare.candidates[0].missing.includes("marketFit"));
    assert.ok(compare.candidates[0].estimate);
    assert.equal((await f.state(p.id)).crop, "maize");
  } finally {
    await f.close();
  }
});

test("pack valuation, losses, shared expenses, budgets and matched receivables reconcile without double counting", async () => {
  const f = await fixture();
  try {
    const a = await f.project(),
      b = await f.project("crop", 0, { name: "Second crop" });
    const feed = await f.stock("Documented bags", "kg", 0, {
      projectId: a.id,
      packSize: 50,
      packUnit: "kg",
    });
    const purchase = {
      id: randomUUID(),
      kind: "purchase",
      packCount: 2,
      observedAt: at,
      reason: "Invoice quantity and total",
      amount: 200,
      currency: "USD",
    };
    await f.post(`/stock/${feed.id}/packs`, purchase);
    await f.post(`/stock/${feed.id}/packs`, purchase, 200);
    await f.post(`/stock/${feed.id}/packs`, {
      id: randomUUID(),
      kind: "consumption",
      packCount: 1,
      observedAt: at,
      reason: "Measured use",
    });
    await f.post(`/stock/${feed.id}/movements`, {
      id: randomUUID(),
      kind: "loss",
      quantity: 10,
      unit: "kg",
      observedAt: at,
      reason: "Measured damaged stock",
    });
    const s = (await f.get("/stock")).items.find((s: any) => s.id === feed.id);
    assert.equal(Number(s.quantity), 40);
    assert.equal(Number(s.unit_cost), 2);
    const cost = await f.post("/expenses", {
      id: randomUUID(),
      category: "fuel",
      amount: 100,
      currency: "USD",
      observedAt: at,
      note: "Shared invoice",
    });
    const races = await Promise.all([
      f.send("POST", `/expenses/${cost.id}/allocations`, {
        id: randomUUID(),
        allocations: [
          { projectId: a.id, amount: 60, basis: "Recorded operating hours" },
        ],
      }),
      f.send("POST", `/expenses/${cost.id}/allocations`, {
        id: randomUUID(),
        allocations: [
          { projectId: b.id, amount: 60, basis: "Recorded operating hours" },
        ],
      }),
    ]);
    assert.deepEqual(races.map((r) => r.statusCode).sort(), [201, 409]);
    const allocated = (await f.get(`/expenses/${cost.id}/allocations`))
        .items[0],
      other = allocated.project_id === a.id ? b.id : a.id;
    await f.post(`/expenses/${cost.id}/allocations`, {
      id: randomUUID(),
      allocations: [
        { projectId: other, amount: 40, basis: "Remaining recorded hours" },
      ],
    });
    await f.post(`/projects/${a.id}/opening-balances`, {
      id: randomUUID(),
      asOfDate: "2026-11-01",
      kind: "cost",
      amount: 25,
      currency: "USD",
      source: "Reviewed opening invoice",
    });
    await f.post(`/projects/${a.id}/budgets`, {
      id: randomUUID(),
      versionName: "Approved budget",
      reason: "Owner documented estimate",
      lines: [
        {
          category: "feed",
          description: "Documented planning amount",
          amount: 300,
          currency: "USD",
        },
      ],
    });
    const totals = await f.get("/reports/summary?period=week");
    const usd = totals.byCurrency.find((b: any) => b.currency === "USD");
    assert.equal(usd.recordedCosts, 245);
    assert.equal(usd.inventoryPurchases, 200);
    assert.equal(usd.inputConsumption, 120);
    assert.equal(usd.profit, null);
    assert.equal(totals.budgetByCurrency[0].budget, 300);
    assert.equal((await f.get("/reconciliation")).balanced, true);
    const livestock = await f.project("broiler", 5, { asOfDate: "2026-10-01" });
    await f.event(livestock.id, "sale", {
      count: 1,
      amount: 50,
      currency: "USD",
      observedAt: "2026-10-10T12:00:00Z",
    });
    const revenue = (
      await f.get(`/projects/${livestock.id}/ledger`)
    ).items.find((x: any) => x.kind === "revenue");
    await f.post(`/projects/${livestock.id}/payments`, {
      id: randomUUID(),
      revenueId: revenue.id,
      amount: 20,
      currency: "USD",
      observedAt: at,
      note: "Cash received this period for earlier sale",
    });
    const period = await f.get(
      "/reports/summary?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z",
    );
    const periodUsd = period.byCurrency.find((x: any) => x.currency === "USD");
    assert.equal(periodUsd.recordedSales, 0);
    assert.equal(periodUsd.cashReceived, 20);
    assert.equal(
      periodUsd.outstandingRecordedSales,
      30,
      "receivable matches the earlier obligation, not period cash minus sales",
    );
    const unpriced = await f.stock("Unpriced opening material", "kg", 2);
    await f.post("/activities", {
      id: randomUUID(),
      projectId: a.id,
      kind: "input_use",
      observedAt: at,
      stockItemId: unpriced.id,
      quantity: 1,
      unit: "kg",
    });
    assert.equal((await f.get("/reports/summary")).missing.unpricedInputs, 1);
    if (process.env.PRODUCT_PDF_OUTPUT) {
      await f.post("/expenses", {
        id: randomUUID(),
        category: "care",
        amount: 80,
        currency: "ZAR",
        observedAt: at,
        note: "Synthetic multi-currency rendering evidence",
      });
      for (let i = 0; i < 24; i++)
        await f.stock(
          `Chibage / umumbu ɓ ɗ ŋ — ${i} Recorded long name retained exactly for report line wrapping`,
          "kg",
          i + 1,
        );
    }
    for (const language of ["sn", "nd"]) {
      const pdf = await f.send(
        "GET",
        `/reports/summary.pdf?language=${language}`,
      );
      assert.equal(pdf.statusCode, 200, pdf.body);
      assert.equal(pdf.headers["content-type"], "application/pdf");
      assert.equal(pdf.rawPayload.subarray(0, 5).toString(), "%PDF-");
      assert.ok(pdf.rawPayload.length > 8000);
      if (process.env.PRODUCT_PDF_OUTPUT)
        await writeFile(
          join(process.env.PRODUCT_PDF_OUTPUT, `report-${language}.pdf`),
          pdf.rawPayload,
        );
    }
  } finally {
    await f.close();
  }
});

test("audited duplicate correction compensates stock and cost once and blocks a task whose sole evidence was reversed", async () => {
  const f = await fixture();
  try {
    const p = await f.project(),
      stock = await f.stock("Priced material", "kg", 5, {
        unitCost: 2,
        currency: "USD",
      }),
      task = await f.post("/tasks", {
        id: randomUUID(),
        projectId: p.id,
        title: "Measure material use",
        assigneeId: f.owner.userId,
      });
    const activity = {
      id: randomUUID(),
      projectId: p.id,
      kind: "input_use",
      observedAt: at,
      stockItemId: stock.id,
      quantity: 1,
      unit: "kg",
      taskId: task.id,
      taskVersion: 1,
    };
    await f.post("/activities", activity);
    await f.post("/activities", {
      ...activity,
      id: randomUUID(),
      taskId: null,
      taskVersion: null,
    });
    const review = await f.get("/record-review");
    assert.equal(review.items.length, 1);
    assert.equal(review.automaticReversal, false);
    const correction = {
      id: randomUUID(),
      action: "reverse",
      reason: "Manager reviewed duplicate",
    };
    await f.post(`/activities/${activity.id}/corrections`, correction);
    await f.post(`/activities/${activity.id}/corrections`, correction, 200);
    assert.equal(
      (
        await f.send("POST", `/activities/${activity.id}/corrections`, {
          ...correction,
          id: randomUUID(),
        })
      ).statusCode,
      409,
    );
    assert.equal(
      Number(
        (
          await f.db.query("SELECT quantity FROM stock_items WHERE id=$1", [
            stock.id,
          ])
        ).rows[0].quantity,
      ),
      4,
    );
    assert.equal((await f.get("/tasks")).items[0].status, "blocked");
    assert.equal(
      (await f.get("/reports/summary")).byCurrency[0].recordedCosts,
      2,
    );
    assert.equal((await f.get("/reconciliation")).balanced, true);
    assert.equal(
      Number(
        (await f.db.query("SELECT count(*) FROM activities")).rows[0].count,
      ),
      2,
      "original observations remain auditable",
    );
  } finally {
    await f.close();
  }
});

test("fish spawning keeps broodstock separate from eggs, hatch losses and estimated fry/grow-out counts", async () => {
  const f = await fixture();
  try {
    const brood = await f.project("fish_breeder", 10),
      eggs = await f.project("fish_hatchery"),
      nursery = await f.project("fish_nursery"),
      grow = await f.project("fish");
    const dam = await f.post(`/projects/${brood.id}/animals`, {
        id: randomUUID(),
        identifier: "Dam F",
        sex: "female",
      }),
      sire = await f.post(`/projects/${brood.id}/animals`, {
        id: randomUUID(),
        identifier: "Sire F",
        sex: "male",
      });
    await f.event(brood.id, "spawning", {
      count: 100,
      destinationProjectId: eggs.id,
      metadata: {
        eggCountBasis: "estimated",
        source: "Observed egg estimate",
        damId: dam.id,
        sireId: sire.id,
      },
    });
    assert.equal(await f.count(brood.id), 10);
    assert.equal(await f.count(eggs.id), 100);
    assert.equal((await f.state(eggs.id)).count_basis, "estimated");
    assert.equal(
      (
        await f.send("POST", `/projects/${eggs.id}/events`, {
          id: randomUUID(),
          type: "transfer",
          observedAt: at,
          count: 10,
          destinationProjectId: grow.id,
        })
      ).statusCode,
      400,
      "eggs cannot become live fish through generic transfer",
    );
    await f.event(eggs.id, "fish_hatch", {
      count: 70,
      destinationProjectId: nursery.id,
      metadata: { eggsProcessed: 80, source: "Counted live fry" },
    });
    await f.event(eggs.id, "egg_disposition", {
      count: 20,
      note: "Observed remaining failed eggs",
      metadata: { disposition: "loss", source: "Hatch observation" },
    });
    assert.equal(await f.count(eggs.id), 0);
    assert.equal(await f.count(nursery.id), 70);
    assert.equal((await f.state(nursery.id)).count_basis, "estimated");
    await f.event(nursery.id, "transfer", {
      count: 50,
      destinationProjectId: grow.id,
    });
    assert.equal(await f.count(nursery.id), 20);
    assert.equal(await f.count(grow.id), 50);
    assert.equal((await f.state(grow.id)).count_basis, "estimated");
    const perf = await f.get(`/projects/${eggs.id}/performance`);
    assert.equal(perf.hatchRate, 70 / 80);
    assert.equal(perf.eggLoss, 20);
    assert.equal(perf.historyComplete, false);
    assert.ok(
      (await f.get(`/animals/${dam.id}/timeline`)).items.some(
        (x: any) => x.type === "spawning",
      ),
    );
    const restricted = await f.post(`/projects/${brood.id}/restrictions`, {
      id: randomUUID(),
      startsAt: new Date(Date.now() - 60000).toISOString(),
      endsAt: future(),
      scope: "transfer",
      reason: "Verified temporary release hold",
      authorizedBy: "Named qualified professional",
    });
    assert.ok(restricted.id);
    assert.equal(
      (
        await f.send("POST", `/projects/${brood.id}/events`, {
          id: randomUUID(),
          type: "spawning",
          observedAt: "2020-01-01T00:00:00Z",
          count: 1,
          destinationProjectId: eggs.id,
          metadata: { eggCountBasis: "verified", source: "Observed" },
        })
      ).statusCode,
      409,
      "backdating does not bypass present restrictions",
    );
  } finally {
    await f.close();
  }
});

test("live-animal orders and direct events share a single reservation ledger under competing sales", async () => {
  const f = await fixture();
  try {
    const p = await f.project("broiler", 10, { countBasis: "estimated" }),
      buyer = await f.register("buyer");
    const listing = await f.post("/listings", {
      id: randomUUID(),
      animalProjectId: p.id,
      category: "animal",
      title: "Recorded birds",
      quantity: 10,
      price: 5,
      currency: "USD",
      collectionArea: "Public district",
    });
    const publicListing = await f.get(`/v1/market/listings/${listing.id}`);
    assert.equal(publicListing.count_basis, "estimated");
    assert.equal(publicListing.animal_project_id, undefined);
    assert.equal(publicListing.farm_id, undefined);
    const orders = await Promise.all([
      f.send(
        "POST",
        `/v1/market/listings/${listing.id}/orders`,
        { id: randomUUID(), quantity: 6 },
        buyer,
      ),
      f.send(
        "POST",
        `/v1/market/listings/${listing.id}/orders`,
        { id: randomUUID(), quantity: 6 },
        buyer,
      ),
    ]);
    assert.deepEqual(orders.map((r) => r.statusCode).sort(), [201, 409]);
    const order = orders.find((r) => r.statusCode === 201)!.json();
    assert.equal(Number((await f.state(p.id)).reserved_count), 6);
    assert.equal(await f.count(p.id), 10);
    const direct = await f.send("POST", `/projects/${p.id}/events`, {
      id: randomUUID(),
      type: "sale",
      observedAt: at,
      count: 5,
      amount: 25,
      currency: "USD",
    });
    assert.equal(direct.statusCode, 409);
    assert.equal(direct.json().error, "animals_reserved");
    const fulfil = await Promise.all([
      f.send("POST", `/v1/market/orders/${order.id}/status`, {
        status: "fulfilled",
      }),
      f.send("POST", `/v1/market/orders/${order.id}/status`, {
        status: "fulfilled",
      }),
    ]);
    assert.deepEqual(
      fulfil.map((r) => r.statusCode),
      [200, 200],
    );
    assert.equal(await f.count(p.id), 4);
    assert.equal(Number((await f.state(p.id)).reserved_count), 0);
    assert.equal(
      Number(
        (
          await f.db.query(
            "SELECT count(*) FROM animal_events WHERE metadata->>'marketOrderId'=$1",
            [order.id],
          )
        ).rows[0].count,
      ),
      1,
    );
    assert.equal(
      Number(
        (
          await f.db.query(
            "SELECT count(*) FROM financial_entries WHERE source_type='market_order' AND source_id=$1",
            [order.id],
          )
        ).rows[0].count,
      ),
      1,
    );
    const last = await f.post(
      `/v1/market/listings/${listing.id}/orders`,
      { id: randomUUID(), quantity: 4 },
      201,
      buyer,
    );
    await f.post(`/projects/${p.id}/restrictions`, {
      id: randomUUID(),
      startsAt: new Date(Date.now() - 1000).toISOString(),
      endsAt: future(),
      scope: "sale",
      reason: "Verified release period",
      authorizedBy: "Qualified professional",
    });
    assert.equal(
      (
        await f.send("POST", `/v1/market/orders/${last.id}/status`, {
          status: "fulfilled",
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.send(
          "POST",
          `/v1/market/orders/${last.id}/status`,
          { status: "cancelled" },
          buyer,
        )
      ).statusCode,
      200,
    );
    assert.equal(Number((await f.state(p.id)).reserved_count), 0);
    assert.equal((await f.get("/reconciliation")).balanced, true);
  } finally {
    await f.close();
  }
});

test("identified mortality and corrections cancel incompatible live commitments; expired orders release atomically", async () => {
  const f = await fixture();
  try {
    const p = await f.project("rabbit_growout", 10);
    const identity = await f.post(`/projects/${p.id}/animals`, {
      id: randomUUID(),
      identifier: "R-001",
      sex: "female",
    });
    const l = await f.post("/listings", {
      id: randomUUID(),
      animalProjectId: p.id,
      category: "animal",
      title: "Rabbits",
      quantity: 10,
      price: 10,
      currency: "USD",
      collectionArea: "District",
    });
    const o = await f.post(`/v1/market/listings/${l.id}/orders`, {
      id: randomUUID(),
      quantity: 1,
      identityIds: [identity.id],
    });
    await f.event(p.id, "mortality", {
      count: 1,
      note: "Observed identified loss",
      metadata: { identityIds: [identity.id] },
    });
    assert.equal(await f.count(p.id), 9);
    assert.equal(Number((await f.state(p.id)).reserved_count), 0);
    const cancelled = (await f.get("/v1/market/orders")).items.find(
      (item: any) => item.id === o.id,
    );
    assert.equal(cancelled.status, "cancelled");
    assert.equal(
      cancelled.cancellation_reason,
      "physical_loss_or_count_correction",
    );
    assert.equal(
      (await f.get(`/animals/${identity.id}/timeline`)).animal.status,
      "dead",
    );
    const reserved = await f.post(`/v1/market/listings/${l.id}/orders`, {
      id: randomUUID(),
      quantity: 8,
    });
    await f.event(p.id, "adjustment", {
      count: 3,
      metadata: { reason: "Verified recount", countBasis: "verified" },
    });
    assert.equal(await f.count(p.id), 3);
    assert.equal(
      (
        await f.db.query("SELECT status FROM market_orders WHERE id=$1", [
          reserved.id,
        ])
      ).rows[0].status,
      "cancelled",
    );
    const expiring = await f.post(`/v1/market/listings/${l.id}/orders`, {
      id: randomUUID(),
      quantity: 3,
    });
    await f.db.query(
      "UPDATE market_orders SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [expiring.id],
    );
    assert.equal(
      (
        await f.send("POST", `/v1/market/orders/${expiring.id}/status`, {
          status: "fulfilled",
        })
      ).statusCode,
      409,
    );
    const c = await f.db.connect();
    try {
      await c.query("BEGIN");
      await runProductMaintenance(c);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    assert.equal(Number((await f.state(p.id)).reserved_count), 0);
    assert.equal(
      (
        await f.db.query(
          "SELECT cancellation_reason FROM market_orders WHERE id=$1",
          [expiring.id],
        )
      ).rows[0].cancellation_reason,
      "reservation_expired",
    );
    assert.equal((await f.get("/reconciliation")).balanced, true);
  } finally {
    await f.close();
  }
});

test("public trade preserves private originals, strips EXIF, supports provisional listings, offers, enquiries, requests and moderation", async () => {
  const f = await fixture();
  try {
    const p = await f.project(),
      stock = await f.stock("Expected maize", "kg", 0, { projectId: p.id }),
      buyer = await f.register("buyer"),
      outsider = await f.register("outsider");
    const activity = await f.post("/activities", {
      id: randomUUID(),
      projectId: p.id,
      kind: "observation",
      observedAt: at,
      note: "Photo evidence",
    });
    const source = await sharp({
      create: { width: 40, height: 20, channels: 3, background: "#88aa44" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({
        IFD0: {
          Artist: "Private owner",
          ImageDescription: "private GPS location",
        },
      })
      .toBuffer();
    assert.ok((await sharp(source).metadata()).exif);
    const media = await f.post("/media", {
      id: randomUUID(),
      activityId: activity.id,
      mimeType: "image/jpeg",
      dataBase64: source.toString("base64"),
      filename: "private-evidence.jpg",
    });
    const listing = await f.post("/listings", {
      id: randomUUID(),
      stockItemId: stock.id,
      title: "Expected maize",
      quantity: 20,
      price: 2,
      currency: "USD",
      collectionArea: "Broad district",
      expectedHarvest: true,
      photoMediaIds: [media.id],
      expiresAt: future(),
    });
    const publicPhoto = await f.send(
      "GET",
      `/v1/market/listings/${listing.id}/photos/${media.id}`,
    );
    assert.equal(publicPhoto.statusCode, 200, publicPhoto.body);
    const sanitized = await sharp(publicPhoto.rawPayload).metadata();
    assert.equal(sanitized.exif, undefined);
    assert.equal(sanitized.orientation, undefined);
    assert.equal(sanitized.width, 20);
    assert.equal(sanitized.height, 40);
    const privatePhoto = await f.send("GET", `/media/${media.id}/content`);
    assert.deepEqual(privatePhoto.rawPayload, source);
    assert.equal(
      (
        await f.send(
          "POST",
          `/v1/market/listings/${listing.id}/orders`,
          { id: randomUUID(), quantity: 1 },
          buyer,
        )
      ).json().error,
      "expected_harvest_not_available",
    );
    const enquiry = await f.post(
      `/v1/market/listings/${listing.id}/enquiries`,
      { id: randomUUID(), message: "When will recorded stock be ready?" },
      201,
      buyer,
    );
    await f.post(`/v1/market/enquiries/${enquiry.id}/messages`, {
      id: randomUUID(),
      message: "After observed harvest.",
    });
    assert.equal(
      (await f.get(`/v1/market/listings/${listing.id}/enquiries`, buyer))
        .items[0].messages.length,
      2,
    );
    assert.equal(
      (await f.get(`/v1/market/listings/${listing.id}/enquiries`, outsider))
        .items.length,
      0,
    );
    await f.post("/activities", {
      id: randomUUID(),
      projectId: p.id,
      kind: "harvest",
      observedAt: at,
      stockItemId: stock.id,
      quantity: 20,
      unit: "kg",
    });
    const actual = await f.send("PATCH", `/listings/${listing.id}`, {
      version: 1,
      reason: "Harvest recorded and counted",
      expectedHarvest: false,
    });
    assert.equal(actual.statusCode, 200, actual.body);
    const offer = await f.post(
      `/v1/market/listings/${listing.id}/offers`,
      {
        id: randomUUID(),
        quantity: 5,
        amount: 8,
        currency: "USD",
        expiresAt: future(),
        message: "Recorded offer total",
      },
      201,
      buyer,
    );
    const acceptBody = { id: randomUUID(), version: 1, status: "accepted" };
    const accepted = await f.post(
      `/v1/market/offers/${offer.id}/status`,
      acceptBody,
    );
    assert.ok(accepted.orderId);
    await f.post(`/v1/market/offers/${offer.id}/status`, acceptBody, 200);
    const order = (await f.get("/v1/market/orders", buyer)).items[0];
    assert.equal(Number(order.amount), 8);
    assert.equal(
      Number(
        (
          await f.db.query(
            "SELECT reserved_quantity FROM stock_items WHERE id=$1",
            [stock.id],
          )
        ).rows[0].reserved_quantity,
      ),
      5,
    );
    const request = await f.post(
      "/v1/market/requests",
      {
        id: randomUUID(),
        title: "Buyer needs maize",
        category: "produce",
        quantity: 10,
        unit: "kg",
        area: "District",
        details: "Specified dry maize",
        expiresAt: future(),
      },
      201,
      buyer,
    );
    await f.post(`/v1/market/requests/${request.id}/responses`, {
      id: randomUUID(),
      message: "Available confirmed maize",
      listingId: listing.id,
    });
    assert.equal(
      (await f.get(`/v1/market/requests/${request.id}/responses`, buyer)).items
        .length,
      1,
    );
    assert.equal(
      (await f.get(`/v1/market/requests/${request.id}/responses`, outsider))
        .items.length,
      0,
    );
    assert.equal(
      (await f.get("/v1/market/my-requests", buyer)).items[0].id,
      request.id,
    );
    const report = await f.post(
      "/v1/market/reports",
      {
        id: randomUUID(),
        listingId: listing.id,
        reason: "Seller should review listing terms",
      },
      201,
      buyer,
    );
    assert.equal(
      (await f.send("GET", "/v1/market/moderation", undefined, buyer))
        .statusCode,
      404,
    );
    await f.post(`/moderation/${report.id}/resolve`, {
      id: randomUUID(),
      action: "archive",
      note: "Seller archived to review",
    });
    assert.equal(
      (await f.send("GET", `/v1/market/listings/${listing.id}`)).statusCode,
      404,
    );
    assert.equal(
      (
        await f.send(
          "GET",
          `/v1/market/listings/${listing.id}/photos/${media.id}`,
        )
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test("service quotes, deposits, actual work, accepted amendments and project-linked completion keep both ledgers consistent", async () => {
  const f = await fixture();
  try {
    const buyer = await f.register("customer"),
      bp = `/v1/farms/${buyer.farmId}`,
      p = await f.project("crop", 0, {}, buyer),
      task = await f.post(
        `${bp}/tasks`,
        { id: randomUUID(), projectId: p.id, title: "Prepare recorded field" },
        201,
        buyer,
      );
    const service = await f.post("/services", {
      id: randomUUID(),
      name: "Recorded tillage service",
      description: "Agreed service scope",
      serviceArea: "District",
      rate: 20,
      currency: "USD",
      rateBasis: "ha",
      operatorIncluded: true,
      fuelIncluded: true,
      minimumCharge: 50,
      mobilisationCharge: 10,
    });
    const booking = await f.post(
      `/v1/services/${service.id}/bookings`,
      {
        id: randomUUID(),
        farmId: buyer.farmId,
        projectId: p.id,
        taskId: task.id,
        startsAt: "2026-12-01T08:00:00Z",
        endsAt: "2026-12-01T12:00:00Z",
        requestedQuantity: 3,
        requestedUnit: "ha",
      },
      201,
      buyer,
    );
    assert.equal(booking.indicativeCharge, 70);
    const quote = {
      status: "quoted",
      version: 1,
      amount: 70,
      currency: "USD",
      quotedQuantity: 3,
      quotedUnit: "ha",
      workDescription: "Agreed three hectares",
      depositRequired: 20,
    };
    assert.equal(
      (
        await f.send("POST", `/bookings/${booking.id}/status`, {
          ...quote,
          amount: 55,
        })
      ).json().error,
      "quote_below_minimum",
    );
    await f.post(`/bookings/${booking.id}/status`, quote, 200);
    await f.post(
      `${bp}/bookings/${booking.id}/status`,
      { status: "confirmed", version: 2 },
      200,
      buyer,
    );
    const declared = await f.post(
      `${bp}/bookings/${booking.id}/payments`,
      {
        id: randomUUID(),
        kind: "deposit",
        amount: 20,
        currency: "USD",
        note: "Customer declares cash transfer",
      },
      201,
      buyer,
    );
    assert.equal(declared.status, "declared");
    assert.equal(
      Number(
        (
          await f.db.query(
            "SELECT count(*) FROM financial_entries WHERE source_id=$1",
            [declared.id],
          )
        ).rows[0].count,
      ),
      0,
    );
    assert.equal(
      (
        await f.send(
          "POST",
          `${bp}/bookings/${booking.id}/payments/${declared.id}/acknowledge`,
          {},
          buyer,
        )
      ).statusCode,
      404,
    );
    const acknowledgments = await Promise.all([
      f.send(
        "POST",
        `/bookings/${booking.id}/payments/${declared.id}/acknowledge`,
        {},
      ),
      f.send(
        "POST",
        `/bookings/${booking.id}/payments/${declared.id}/acknowledge`,
        {},
      ),
    ]);
    assert.deepEqual(
      acknowledgments.map((r) => r.statusCode),
      [200, 200],
    );
    assert.equal(
      Number(
        (
          await f.db.query(
            "SELECT count(*) FROM financial_entries WHERE source_id=$1",
            [declared.id],
          )
        ).rows[0].count,
      ),
      2,
    );
    assert.equal(
      (await f.get(`/bookings/${booking.id}/payments`)).depositOutstanding,
      0,
    );
    assert.equal(
      (await f.get("/reports/summary")).byCurrency[0].unearnedServiceDeposits,
      20,
    );
    await f.post(`/bookings/${booking.id}/work`, {
      id: randomUUID(),
      observedAt: at,
      quantity: 3.5,
      unit: "ha",
      note: "Measured actual area after work",
    });
    const amendment = await f.post(`/bookings/${booking.id}/amendments`, {
      id: randomUUID(),
      version: 3,
      amount: 90,
      currency: "USD",
      reason: "Additional measured area agreed",
      workDescription: "Actual three and a half hectares",
    });
    assert.equal(
      (
        await f.send(
          "POST",
          `${bp}/bookings/${booking.id}/status`,
          { status: "completed", version: 3 },
          buyer,
        )
      ).json().error,
      "amendment_acceptance_required",
    );
    await f.post(
      `${bp}/bookings/${booking.id}/amendments/${amendment.id}/accept`,
      { version: 3, confirmed: true },
      200,
      buyer,
    );
    assert.equal(
      (
        await f.send(
          "POST",
          `${bp}/bookings/${booking.id}/status`,
          { status: "completed", version: 3 },
          buyer,
        )
      ).statusCode,
      409,
    );
    await f.post(
      `${bp}/bookings/${booking.id}/status`,
      { status: "completed", version: 4 },
      200,
      buyer,
    );
    const effects = (
      await f.db.query(
        "SELECT farm_id,kind,amount FROM financial_entries WHERE source_type='service_booking' AND source_id=$1 ORDER BY kind",
        [booking.id],
      )
    ).rows;
    assert.equal(effects.length, 2);
    assert.equal(Number(effects.find((e) => e.kind === "expense").amount), 90);
    assert.equal(Number(effects.find((e) => e.kind === "revenue").amount), 90);
    assert.equal(
      (await f.get(`${bp}/tasks`, buyer)).items[0].status,
      "completed",
    );
    assert.equal(
      (
        await f.send("POST", `/bookings/${booking.id}/payments`, {
          id: randomUUID(),
          kind: "balance",
          amount: 71,
          currency: "USD",
          note: "Too much",
        })
      ).statusCode,
      409,
    );
    await f.post(`/bookings/${booking.id}/payments`, {
      id: randomUUID(),
      kind: "balance",
      amount: 70,
      currency: "USD",
      note: "Provider records remaining cash",
    });
    await f.post(`/bookings/${booking.id}/payments`, {
      id: randomUUID(),
      kind: "refund",
      amount: 10,
      currency: "USD",
      note: "Provider records partial refund",
    });
    assert.equal(
      (await f.get(`/bookings/${booking.id}/payments`)).manuallyRecordedPaid,
      80,
    );
    const summary = await f.get("/reports/summary");
    assert.equal(summary.byCurrency[0].recordedSales, 90);
    assert.equal(summary.byCurrency[0].cashReceived, 80);
    assert.equal(summary.byCurrency[0].outstandingRecordedSales, 10);
    assert.equal(summary.byCurrency[0].unearnedServiceDeposits, 0);
    const review = await f.post(
      "/v1/reviews",
      {
        id: randomUUID(),
        bookingId: booking.id,
        rating: 4,
        note: "Completed work reviewed",
      },
      201,
      buyer,
    );
    assert.equal(
      (await f.get(`/v1/services/${service.id}/reviews`)).items[0].id,
      review.id,
    );
    const history = await f.get(`/bookings/${booking.id}/history`);
    assert.equal(history.work[0].quantity, "3.500000");
    assert.equal(history.amendments[0].status, "accepted");
    assert.ok(history.items.some((x: any) => x.status === "amended"));
  } finally {
    await f.close();
  }
});

test("stock transfers conserve convertible quantities, carry restrictions and valuation, and never create a duplicate expense", async () => {
  const f = await fixture();
  try {
    const a = await f.project(),
      b = await f.project("crop", 0, { name: "Second store project" }),
      source = await f.stock("Measured input", "g", 3000, {
        projectId: a.id,
        unitCost: 0.002,
        currency: "USD",
      }),
      dest = await f.stock("Transferred input", "kg", 0, { projectId: b.id }),
      wrong = await f.stock("Volume stock", "l", 0, { projectId: b.id });
    const transfer = {
      id: randomUUID(),
      destinationStockItemId: dest.id,
      quantity: 1,
      unit: "kg",
      observedAt: at,
      reason: "Recorded move between stores",
    };
    const moved = await f.post(`/stock/${source.id}/transfers`, transfer);
    assert.equal(Number(moved.source_quantity), 1000);
    assert.equal(Number(moved.destination_quantity), 1);
    await f.post(`/stock/${source.id}/transfers`, transfer, 200);
    assert.equal(
      Number(
        (
          await f.db.query("SELECT unit_cost FROM stock_items WHERE id=$1", [
            dest.id,
          ])
        ).rows[0].unit_cost,
      ),
      2,
    );
    assert.equal(
      (
        await f.send("POST", `/stock/${source.id}/transfers`, {
          ...transfer,
          id: randomUUID(),
          destinationStockItemId: wrong.id,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      Number(
        (await f.db.query("SELECT count(*) FROM financial_entries")).rows[0]
          .count,
      ),
      0,
    );
    await f.post(`/projects/${a.id}/restrictions`, {
      id: randomUUID(),
      startsAt: new Date(Date.now() - 1000).toISOString(),
      endsAt: future(),
      scope: "sale",
      reason: "Verified release condition",
      authorizedBy: "Qualified professional",
    });
    await f.post(`/stock/${source.id}/transfers`, {
      ...transfer,
      id: randomUUID(),
    });
    assert.equal(
      (await f.get(`/projects/${b.id}/restrictions`)).items.length,
      1,
    );
    const held = await f.send("POST", "/listings", {
      id: randomUUID(),
      stockItemId: dest.id,
      title: "Restricted moved output",
      quantity: 1,
      price: 1,
      currency: "USD",
      collectionArea: "District",
    });
    assert.equal(held.statusCode, 409);
    assert.equal(held.json().error, "treatment_restriction");
    assert.equal((await f.get("/reconciliation")).balanced, true);
    const unknown = await f.stock("Unknown-priced material", "kg", 3);
    await f.post("/activities", {
      id: randomUUID(),
      projectId: a.id,
      kind: "input_use",
      observedAt: at,
      stockItemId: unknown.id,
      quantity: 1,
      unit: "kg",
    });
    const current = (await f.get("/stock")).items.find(
      (x: any) => x.id === unknown.id,
    );
    await f.post(`/stock/${unknown.id}/valuations`, {
      id: randomUUID(),
      version: current.version,
      unitCost: 4,
      currency: "USD",
      source: "Reviewed documented unit cost",
      reason: "Confirm value for future use",
    });
    await f.post("/activities", {
      id: randomUUID(),
      projectId: a.id,
      kind: "input_use",
      observedAt: at,
      stockItemId: unknown.id,
      quantity: 1,
      unit: "kg",
    });
    const summary = await f.get("/reports/summary");
    assert.equal(
      summary.missing.unpricedInputs,
      1,
      "forward valuation does not reprice undocumented past use",
    );
    assert.equal(summary.byCurrency[0].recordedCosts, 4);
  } finally {
    await f.close();
  }
});

test("historical-only animal evidence preserves opening balances and identified birth cohorts remain capped across transfers", async () => {
  const f = await fixture();
  try {
    const existing = await f.project("broiler", 10);
    const old = await f.send("POST", `/projects/${existing.id}/events`, {
      id: randomUUID(),
      type: "acquisition",
      observedAt: "2026-10-01T10:00:00Z",
      count: 12,
    });
    assert.equal(old.statusCode, 409);
    assert.equal(old.json().error, "historical_record_required");
    await f.event(existing.id, "acquisition", {
      historicalOnly: true,
      observedAt: "2026-10-01T10:00:00Z",
      count: 12,
      note: "Past purchase already represented in opening count",
      metadata: { historySource: "Original dated delivery record" },
    });
    assert.equal(await f.count(existing.id), 10);
    assert.equal(
      Number(
        (await f.db.query("SELECT count(*) FROM financial_entries")).rows[0]
          .count,
      ),
      0,
    );
    await f.event(existing.id, "mortality", {
      count: 1,
      note: "Current observed loss",
    });
    let reconciled = (await f.get("/reconciliation")).animals.find(
      (p: any) => p.id === existing.id,
    );
    assert.equal(reconciled.ledgerCount, 9);
    assert.equal(reconciled.ledgerBalanced, true);
    assert.equal(
      (await f.get(`/projects/${existing.id}/performance`))
        .acquiredRecordedCount,
      0,
      "pre-opening history is not counted again in current-cycle production",
    );
    const breeders = await f.project("rabbit_breeding", 2),
      litters = await f.project("rabbit_growout"),
      other = await f.project("rabbit_growout", 3);
    const dam = await f.post(`/projects/${breeders.id}/animals`, {
        id: randomUUID(),
        identifier: "Doe",
        sex: "female",
      }),
      sire = await f.post(`/projects/${breeders.id}/animals`, {
        id: randomUUID(),
        identifier: "Buck",
        sex: "male",
      });
    const mating = await f.event(breeders.id, "mating", {
        metadata: { damId: dam.id, sireId: sire.id },
      }),
      birth = await f.event(breeders.id, "kindling", {
        count: 2,
        destinationProjectId: litters.id,
        metadata: { matingEventId: mating.id, stillborn: 0 },
      });
    const child = await f.post(`/projects/${litters.id}/animals`, {
      id: randomUUID(),
      identifier: "Kit 1",
      sex: "unknown",
      damId: dam.id,
      sireId: sire.id,
      birthEventId: birth.id,
    });
    await f.event(litters.id, "weaning", {
      count: 1,
      destinationProjectId: other.id,
      metadata: { identityIds: [child.id] },
    });
    const candidates = await f.get(`/projects/${other.id}/cohort-births`);
    assert.equal(candidates.items[0].id, birth.id);
    assert.equal(Number(candidates.items[0].remainingIdentities), 1);
    const race = await Promise.all([
      f.send("POST", `/projects/${litters.id}/animals`, {
        id: randomUUID(),
        identifier: "Candidate A",
        birthEventId: birth.id,
      }),
      f.send("POST", `/projects/${other.id}/animals`, {
        id: randomUUID(),
        identifier: "Candidate B",
        birthEventId: birth.id,
      }),
    ]);
    assert.deepEqual(race.map((r) => r.statusCode).sort(), [201, 409]);
    const timeline = await f.get(`/animals/${child.id}/timeline`);
    assert.equal(timeline.birthEvent.id, birth.id);
    assert.equal(timeline.siblings.length, 1);
    assert.equal(timeline.parents.length, 2);
    assert.equal(timeline.animal.project_id, other.id);
    assert.ok(timeline.items.some((e: any) => e.type === "weaning"));
    assert.equal((await f.get("/reconciliation")).balanced, true);
  } finally {
    await f.close();
  }
});

test("birth-linked rabbit identities inherit documented parents, reject conflicting lineage and replay without duplicating counts", async () => {
  const f = await fixture();
  try {
    const breeders = await f.project("rabbit_breeding", 3),
      kits = await f.project("rabbit_growout"),
      unrelated = await f.project("rabbit_growout", 1);
    const dam = await f.post(`/projects/${breeders.id}/animals`, {
        id: randomUUID(),
        identifier: "Recorded doe",
        sex: "female",
      }),
      sire = await f.post(`/projects/${breeders.id}/animals`, {
        id: randomUUID(),
        identifier: "Recorded buck",
        sex: "male",
      }),
      differentDam = await f.post(`/projects/${breeders.id}/animals`, {
        id: randomUUID(),
        identifier: "Other doe",
        sex: "female",
      });
    const mating = await f.event(breeders.id, "mating", {
        metadata: { damId: dam.id, sireId: sire.id },
      }),
      birth = await f.event(breeders.id, "kindling", {
        count: 2,
        destinationProjectId: kits.id,
        metadata: { matingEventId: mating.id, stillborn: 0 },
      });
    const first = {
      id: randomUUID(),
      identifier: "Kit with blank selectors",
      birthEventId: birth.id,
      damId: null,
      sireId: null,
    };
    await f.post(`/projects/${kits.id}/animals`, first);
    await f.post(`/projects/${kits.id}/animals`, first);
    await f.post(`/projects/${kits.id}/animals`, {
      ...first,
      damId: dam.id,
      sireId: sire.id,
    });
    const conflict = await f.send("POST", `/projects/${kits.id}/animals`, {
      id: randomUUID(),
      identifier: "Conflicting lineage",
      birthEventId: birth.id,
      damId: differentDam.id,
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error, "birth_parent_mismatch");
    const second = await f.post(`/projects/${kits.id}/animals`, {
      id: randomUUID(),
      identifier: "Kit with omitted parents",
      birthEventId: birth.id,
    });
    await f.post(`/projects/${kits.id}/animals`, first);
    const timeline = await f.get(`/animals/${first.id}/timeline`);
    assert.equal(timeline.birthEvent.id, birth.id);
    assert.equal(timeline.animal.dam_id, dam.id);
    assert.equal(timeline.animal.sire_id, sire.id);
    assert.deepEqual(
      timeline.parents.map((item: any) => item.id).sort(),
      [dam.id, sire.id].sort(),
    );
    assert.deepEqual(
      timeline.siblings.map((item: any) => item.id),
      [second.id],
    );
    assert.equal(
      Number(
        (
          await f.db.query(
            "SELECT count(*) AS n FROM animal_identities WHERE birth_event_id=$1",
            [birth.id],
          )
        ).rows[0].n,
      ),
      2,
    );
    assert.equal(
      await f.count(kits.id),
      2,
      "Identity registration never creates extra live animals",
    );
    const unknown = await f.post(`/projects/${unrelated.id}/animals`, {
      id: randomUUID(),
      identifier: "Parentage not recorded",
    });
    const unknownTimeline = await f.get(`/animals/${unknown.id}/timeline`);
    assert.equal(unknownTimeline.animal.dam_id, null);
    assert.equal(unknownTimeline.animal.sire_id, null);
    assert.deepEqual(
      unknownTimeline.parents,
      [],
      "Unlinked parentage stays unknown",
    );
  } finally {
    await f.close();
  }
});

test("identification cannot consume an anonymous animal reservation; cancellation and refunds preserve unearned cash", async () => {
  const f = await fixture();
  try {
    const birds = await f.project("broiler", 2),
      listing = await f.post("/listings", {
        id: randomUUID(),
        animalProjectId: birds.id,
        category: "animal",
        title: "Two birds",
        quantity: 2,
        price: 5,
        currency: "USD",
        collectionArea: "District",
      });
    const order = await f.post(`/v1/market/listings/${listing.id}/orders`, {
      id: randomUUID(),
      quantity: 2,
    });
    assert.equal(
      (
        await f.send("POST", `/projects/${birds.id}/animals`, {
          id: randomUUID(),
          identifier: "Reserved anonymous bird",
        })
      ).json().error,
      "unidentified_animals_reserved",
    );
    await f.post(
      `/v1/market/orders/${order.id}/status`,
      { status: "fulfilled" },
      200,
    );
    assert.equal((await f.get("/reconciliation")).balanced, true);
    const customer = await f.register("customer"),
      cp = `/v1/farms/${customer.farmId}`,
      service = await f.post("/services", {
        id: randomUUID(),
        name: "Transport",
        description: "Recorded hire",
        serviceArea: "District",
        rate: 10,
        currency: "USD",
        rateBasis: "hour",
        operatorIncluded: true,
        fuelIncluded: true,
      });
    const b = await f.post(
      `/v1/services/${service.id}/bookings`,
      {
        id: randomUUID(),
        farmId: customer.farmId,
        startsAt: "2026-12-20T08:00:00Z",
        endsAt: "2026-12-20T09:00:00Z",
      },
      201,
      customer,
    );
    await f.post(
      `/bookings/${b.id}/status`,
      {
        status: "quoted",
        version: 1,
        amount: 10,
        currency: "USD",
        depositRequired: 10,
      },
      200,
    );
    await f.post(
      `${cp}/bookings/${b.id}/status`,
      { status: "confirmed", version: 2 },
      200,
      customer,
    );
    await f.post(`/bookings/${b.id}/payments`, {
      id: randomUUID(),
      kind: "deposit",
      amount: 10,
      currency: "USD",
      note: "Provider received advance",
    });
    await f.post(`/bookings/${b.id}/amendments`, {
      id: randomUUID(),
      version: 3,
      amount: 15,
      currency: "USD",
      reason: "Proposed additional work",
      workDescription: "Longer trip",
    });
    await f.post(
      `${cp}/bookings/${b.id}/status`,
      { status: "cancelled", version: 3 },
      200,
      customer,
    );
    assert.equal(
      (await f.get(`/bookings/${b.id}/history`)).amendments[0].status,
      "rejected",
    );
    assert.equal(
      (await f.get(`/bookings/${b.id}/payments`)).cancelledHeldPayment,
      10,
    );
    assert.equal(
      Number(
        (
          await f.db.query(
            "SELECT count(*) FROM financial_entries WHERE source_type='service_booking' AND source_id=$1",
            [b.id],
          )
        ).rows[0].count,
      ),
      0,
      "cancelled unperformed work never becomes revenue or expense",
    );
    assert.equal(
      (
        await f.send(
          "POST",
          `${cp}/bookings/${b.id}/payments`,
          {
            id: randomUUID(),
            kind: "refund",
            amount: 1,
            currency: "USD",
            note: "Customer cannot fabricate refund",
          },
          customer,
        )
      ).statusCode,
      403,
    );
    const refunds = await Promise.all([
      f.send("POST", `/bookings/${b.id}/payments`, {
        id: randomUUID(),
        kind: "refund",
        amount: 7,
        currency: "USD",
        note: "Recorded refund",
      }),
      f.send("POST", `/bookings/${b.id}/payments`, {
        id: randomUUID(),
        kind: "refund",
        amount: 7,
        currency: "USD",
        note: "Competing refund",
      }),
    ]);
    assert.deepEqual(refunds.map((r) => r.statusCode).sort(), [201, 409]);
    await f.post(`/bookings/${b.id}/payments`, {
      id: randomUUID(),
      kind: "refund",
      amount: 3,
      currency: "USD",
      note: "Remaining refund",
    });
    assert.equal(
      (await f.get(`/bookings/${b.id}/payments`)).manuallyRecordedPaid,
      0,
    );
  } finally {
    await f.close();
  }
});

test("advisers can contribute observed evidence without financial, count, stock or task powers; pagination and receipt privacy stay scoped", async () => {
  const f = await fixture();
  try {
    const invite = await f.post("/invitations", { role: "adviser" }),
      username = `adviser_${randomUUID().slice(0, 8)}`,
      password = "adviser-fixture-password";
    const joined = await f.app.inject({
      method: "POST",
      url: "/v1/invitations/accept",
      payload: { token: invite.token, username, password, language: "nd" },
    });
    assert.equal(joined.statusCode, 201, joined.body);
    const login = await f.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { username, password },
    });
    const adviser = {
        ...joined.json(),
        farmId: f.owner.farmId,
        headers: { authorization: `Bearer ${login.json().token}` },
      },
      p = await f.project(),
      birds = await f.project("broiler", 5),
      stock = await f.stock("Input", "kg", 5, { unitCost: 2, currency: "USD" });
    const observation = await f.post(
      "/activities",
      {
        id: randomUUID(),
        projectId: p.id,
        kind: "observation",
        observedAt: at,
        note: "Adviser observed field condition",
      },
      201,
      adviser,
    );
    assert.equal(
      (
        await f.send(
          "POST",
          "/activities",
          {
            id: randomUUID(),
            projectId: p.id,
            kind: "input_use",
            observedAt: at,
            stockItemId: stock.id,
            quantity: 1,
            unit: "kg",
          },
          adviser,
        )
      ).statusCode,
      403,
    );
    await f.post(
      `/projects/${birds.id}/events`,
      {
        id: randomUUID(),
        type: "care",
        observedAt: at,
        note: "Recorded verified veterinary instructions",
        metadata: {
          authorizedBy: "Named professional",
          administeredBy: "Recorded operator",
          instructionsSource: "Dated verified care sheet",
        },
      },
      201,
      adviser,
    );
    assert.equal(
      (
        await f.send(
          "POST",
          `/projects/${birds.id}/events`,
          {
            id: randomUUID(),
            type: "mortality",
            observedAt: at,
            count: 1,
            note: "Cannot change counts",
          },
          adviser,
        )
      ).statusCode,
      403,
    );
    assert.equal(await f.count(birds.id), 5);
    for (let n = 0; n < 5; n++)
      await f.post(
        `/projects/${p.id}/records`,
        {
          id: randomUUID(),
          type: "assessment",
          observedAt: at,
          details: {
            source: "Adviser recorded inspection",
            soilType: `Recorded ${n}`,
          },
        },
        201,
        adviser,
      );
    const ids = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await f.get(
        `/projects/${p.id}/records?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        adviser,
      );
      for (const record of page.items) {
        assert.ok(!ids.has(record.id));
        ids.add(record.id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(ids.size, 5);
    assert.equal(
      (await f.send("GET", `/projects/${p.id}/budgets`, undefined, adviser))
        .statusCode,
      404,
    );
    assert.equal(
      (await f.get(`/projects/${p.id}/companion`, adviser)).finance,
      undefined,
    );
    assert.equal(
      (await f.get(`/projects/${p.id}/performance`, adviser)).finance,
      undefined,
    );
    const incident = await f.post(
      "/incidents",
      {
        id: randomUUID(),
        projectId: p.id,
        title: "Observed issue",
        severity: "medium",
      },
      201,
      adviser,
    );
    assert.equal(
      (
        await f.send(
          "PATCH",
          `/incidents/${incident.id}`,
          {
            version: 1,
            status: "acknowledged",
            note: "Professional following up",
          },
          adviser,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.get(`/incidents/${incident.id}/history`, adviser)).items[0]
        .reason,
      "Professional following up",
    );
    const image = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    const media = await f.post(
      "/media",
      {
        id: randomUUID(),
        activityId: observation.id,
        mimeType: "image/png",
        dataBase64: image.toString("base64"),
        filename: "evidence.png",
      },
      201,
      adviser,
    );
    assert.equal(
      (await f.send("GET", `/media/${media.id}/content`, undefined, adviser))
        .statusCode,
      200,
    );
    await f.post("/expenses", {
      id: randomUUID(),
      category: "care",
      amount: 5,
      currency: "USD",
      observedAt: at,
      note: "Owner linked financial supporting evidence",
      receiptActivityId: observation.id,
    });
    assert.equal(
      (await f.send("GET", `/media/${media.id}/content`, undefined, adviser))
        .statusCode,
      404,
    );
    assert.ok(
      !(await f.get("/media", adviser)).items.some(
        (m: any) => m.id === media.id,
      ),
    );
    assert.ok(
      !(await f.get("/activities", adviser)).items.some(
        (a: any) => a.id === observation.id,
      ),
    );
    const stranger = await f.register("stranger");
    assert.equal(
      (
        await f.send(
          "GET",
          `/projects/${p.id}/cohort-births`,
          undefined,
          stranger,
        )
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test("opening financial corrections and expense reallocation preserve audit and compensate costs only once", async () => {
  const f = await fixture();
  try {
    const a = await f.project(),
      b = await f.project("crop", 0, { name: "Second cycle" });
    const opening = await f.post(`/projects/${a.id}/opening-balances`, {
      id: randomUUID(),
      asOfDate: "2026-11-01",
      kind: "cost",
      amount: 30,
      currency: "USD",
      source: "Original documented opening balance",
    });
    const corrected = await f.send(
      "PATCH",
      `/projects/${a.id}/opening-balances/${opening.id}`,
      {
        version: 1,
        amount: 25,
        asOfDate: "2026-11-01",
        source: "Verified corrected opening receipt",
        reason: "Transcription corrected",
      },
    );
    assert.equal(corrected.statusCode, 200, corrected.body);
    assert.equal(
      (
        await f.send(
          "PATCH",
          `/projects/${a.id}/opening-balances/${opening.id}`,
          {
            version: 1,
            amount: 99,
            asOfDate: "2026-11-01",
            source: "Stale edit",
            reason: "Must not overwrite",
          },
        )
      ).statusCode,
      409,
    );
    const expense = await f.post("/expenses", {
      id: randomUUID(),
      category: "transport",
      amount: 100,
      currency: "USD",
      observedAt: at,
      note: "Documented shared charge",
    });
    await f.post(`/expenses/${expense.id}/allocations`, {
      id: randomUUID(),
      allocations: [
        { projectId: a.id, amount: 100, basis: "Initial reviewed attribution" },
      ],
    });
    await f.post(`/expenses/${expense.id}/reallocate`, {
      id: randomUUID(),
      reason: "Reviewed actual allocation",
      allocations: [
        { projectId: a.id, amount: 40, basis: "Measured share A" },
        { projectId: b.id, amount: 60, basis: "Measured share B" },
      ],
    });
    assert.equal(
      (await f.get(`/expenses/${expense.id}/allocations`)).items.length,
      2,
    );
    const history = (await f.get(`/expenses/${expense.id}/allocations/history`))
      .items;
    assert.equal(history.length, 3);
    assert.equal(history.filter((x: any) => x.reversed_at).length, 1);
    assert.equal(
      (await f.get(`/reports/summary?projectId=${a.id}`)).byCurrency[0]
        .recordedCosts,
      65,
    );
    assert.equal(
      (await f.get(`/reports/summary?projectId=${b.id}`)).byCurrency[0]
        .recordedCosts,
      60,
    );
    const correction = {
      id: randomUUID(),
      reason: "Duplicate documented expense confirmed",
    };
    await f.post(`/expenses/${expense.id}/corrections`, correction);
    await f.post(`/expenses/${expense.id}/corrections`, correction, 200);
    assert.equal(
      (
        await f.send("POST", `/expenses/${expense.id}/corrections`, {
          ...correction,
          id: randomUUID(),
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.send("POST", `/expenses/${expense.id}/allocations`, {
          id: randomUUID(),
          allocations: [
            {
              projectId: b.id,
              amount: 10,
              basis: "Cannot allocate reversed expense",
            },
          ],
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await f.get("/reports/summary")).byCurrency[0].recordedCosts,
      25,
    );
    assert.equal(
      (await f.get(`/expenses/${expense.id}/allocations`)).items.length,
      0,
    );
    assert.equal(
      Number(
        (
          await f.db.query(
            "SELECT count(*) FROM audit_events WHERE entity_type='opening_balance' AND entity_id=$1 AND action='corrected'",
            [opening.id],
          )
        ).rows[0].count,
      ),
      1,
    );
  } finally {
    await f.close();
  }
});

test("advertised bag or lot prices require an explicit base quantity and orders charge that basis", async () => {
  const f = await fixture();
  try {
    const p = await f.project(),
      stock = await f.stock("Bagged maize", "kg", 100, {
        projectId: p.id,
        packSize: 50,
        packUnit: "kg",
      });
    const listing = {
      id: randomUUID(),
      stockItemId: stock.id,
      title: "50 kg bags",
      quantity: 100,
      price: 20,
      currency: "USD",
      collectionArea: "District",
      priceBasis: "bag",
    };
    assert.equal(
      (await f.send("POST", "/listings", listing)).json().error,
      "price_quantity_required",
    );
    const created = await f.post("/listings", {
      ...listing,
      priceQuantity: 50,
    });
    assert.equal(
      Number((await f.get(`/v1/market/listings/${created.id}`)).price_quantity),
      50,
    );
    const order = await f.post(`/v1/market/listings/${created.id}/orders`, {
      id: randomUUID(),
      quantity: 50,
    });
    assert.equal(
      Number(order.amount),
      20,
      "one 50 kg bag costs one advertised price, not fifty prices",
    );
    assert.equal(order.unit, "kg");
    const updated = await f.send("PATCH", `/listings/${created.id}`, {
      version: 2,
      reason: "New price for later orders",
      price: 25,
      priceQuantity: 50,
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(
      Number((await f.get("/v1/market/orders")).items[0].amount),
      20,
      "accepted order retains its price snapshot",
    );
  } finally {
    await f.close();
  }
});

test("cross-project input/feed consumption enforces source transfer holds and preserves output restrictions while local feeding remains available", async () => {
  const f = await fixture();
  try {
    const source = await f.project("layer", 5),
      destination = await f.project("broiler", 5),
      crop = await f.project(),
      feed = await f.stock("Recorded transferable material", "kg", 10, {
        projectId: source.id,
        unitCost: 1,
        currency: "USD",
      });
    const hold = await f.post(`/projects/${source.id}/restrictions`, {
      id: randomUUID(),
      startsAt: new Date(Date.now() - 1000).toISOString(),
      endsAt: future(),
      scope: "all",
      reason: "Verified source movement hold",
      authorizedBy: "Named professional",
    });
    const input = {
      id: randomUUID(),
      projectId: crop.id,
      kind: "input_use",
      observedAt: at,
      stockItemId: feed.id,
      quantity: 1,
      unit: "kg",
    };
    assert.equal(
      (await f.send("POST", "/activities", input)).json().error,
      "treatment_restriction",
    );
    assert.equal(
      (
        await f.send("POST", `/projects/${destination.id}/events`, {
          id: randomUUID(),
          type: "feed",
          observedAt: at,
          stockItemId: feed.id,
          quantity: 1,
          unit: "kg",
        })
      ).json().error,
      "treatment_restriction",
    );
    await f.event(source.id, "feed", {
      stockItemId: feed.id,
      quantity: 1,
      unit: "kg",
    });
    assert.equal(
      Number(
        (
          await f.db.query("SELECT quantity FROM stock_items WHERE id=$1", [
            feed.id,
          ])
        ).rows[0].quantity,
      ),
      9,
      "ordinary same-project feeding does not release the held animals",
    );
    await f.db.query(
      "UPDATE treatment_restrictions SET scope='sale' WHERE id=$1",
      [hold.id],
    );
    await f.post("/activities", input);
    await f.event(destination.id, "feed", {
      stockItemId: feed.id,
      quantity: 1,
      unit: "kg",
    });
    for (const p of [crop, destination]) {
      const carried = (await f.get(`/projects/${p.id}/restrictions`)).items[0];
      assert.equal(carried.scope, "sale");
      assert.equal(carried.authorized_by, "Named professional");
      assert.equal(carried.source_project_id, source.id);
    }
    assert.equal(
      (
        await f.send("POST", `/projects/${destination.id}/events`, {
          id: randomUUID(),
          type: "sale",
          observedAt: at,
          count: 1,
          amount: 5,
          currency: "USD",
        })
      ).json().error,
      "treatment_restriction",
    );
    assert.equal((await f.get("/reconciliation")).balanced, true);
    const independent = await f.stock("Unrestricted measured input", "kg", 10),
      barrier = await f.db.connect();
    await barrier.query("BEGIN");
    await barrier.query(
      "SELECT id FROM projects WHERE id=$1 FOR NO KEY UPDATE",
      [crop.id],
    );
    const actions = [1, 2].map(() =>
      f.send("POST", "/activities", {
        id: randomUUID(),
        projectId: crop.id,
        kind: "input_use",
        observedAt: at,
        stockItemId: independent.id,
        quantity: 2,
        unit: "kg",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await barrier.query("COMMIT");
    barrier.release();
    const both = await Promise.all(actions);
    assert.deepEqual(
      both.map((r) => r.statusCode),
      [201, 201],
      both.map((r) => r.body).join("\n"),
    );
    assert.equal(
      Number(
        (
          await f.db.query("SELECT quantity FROM stock_items WHERE id=$1", [
            independent.id,
          ])
        ).rows[0].quantity,
      ),
      6,
      "foreign-key readers do not deadlock two legitimate consuming events",
    );
  } finally {
    await f.close();
  }
});
