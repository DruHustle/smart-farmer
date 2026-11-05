import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { sha256, token } from "../src/security.js";
import { buildApp } from "../src/app.js";
import { getObjectStore } from "../src/integrations/media.js";
const exec = promisify(execFile),
  url = process.env.TEST_DATABASE_URL;

test("published 001–006 records upgrade through the real migration runner without losing money, media, restrictions or per-unit prices", async () => {
  assert.ok(
    url,
    "TEST_DATABASE_URL is required for migration upgrade evidence",
  );
  const admin = new pg.Pool({ connectionString: url }),
    schema = `upgrade_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new pg.Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
  });
  const media = await mkdtemp(join(tmpdir(), "upgrade-media-"));
  process.env.MEDIA_ROOT = media;
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    const migrations = (
      await readdir(new URL("../migrations", import.meta.url))
    )
      .filter((n) => n.endsWith(".sql"))
      .sort();
    await db.query(
      "CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of migrations.filter((n) => n.slice(0, 3) <= "006")) {
      await db.query(
        await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
      await db.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    }
    const owner = randomUUID(),
      worker = randomUUID(),
      farm = randomUUID(),
      project = randomUUID(),
      activity = randomUUID(),
      mediaId = randomUUID(),
      stock = randomUUID(),
      expense = randomUUID(),
      opening = randomUUID(),
      allocation = randomUUID(),
      listing = randomUUID(),
      restriction = randomUUID(),
      ownerToken = token(),
      workerToken = token();
    for (const [id, username, role, credential] of [
      [owner, "upgrade_owner", "owner", ownerToken],
      [worker, "upgrade_worker", "worker", workerToken],
    ]) {
      await db.query(
        "INSERT INTO users(id,username,password_hash,language) VALUES($1,$2,'fixture-not-a-live-password','sn')",
        [id, username],
      );
      if (id === owner)
        await db.query(
          "INSERT INTO farms(id,name,timezone) VALUES($1,'Upgrade fixture','Africa/Harare')",
          [farm],
        );
      await db.query(
        "INSERT INTO memberships(user_id,farm_id,role) VALUES($1,$2,$3)",
        [id, farm, role],
      );
      await db.query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",
        [sha256(credential), id],
      );
    }
    await db.query(
      "INSERT INTO projects(id,farm_id,name,crop,created_by,payload_hash) VALUES($1,$2,'Existing recorded crop','maize',$3,'fixture')",
      [project, farm, owner],
    );
    await db.query(
      "INSERT INTO activities(id,farm_id,project_id,actor_id,kind,observed_at,note,payload_hash) VALUES($1,$2,$3,$4,'observation','2026-11-03T08:00:00Z','Privately linked invoice image','fixture')",
      [activity, farm, project, owner],
    );
    const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9XkAAAAASUVORK5CYII=",
        "base64",
      ),
      fingerprint = sha256(bytes),
      key = `${farm}/${mediaId}-${fingerprint}`;
    await getObjectStore().put(key, bytes);
    await db.query(
      "INSERT INTO private_media(id,farm_id,activity_id,actor_id,mime_type,size_bytes,content_hash,object_key,filename) VALUES($1,$2,$3,$4,'image/png',$5,$6,$7,'existing-receipt.png')",
      [mediaId, farm, activity, owner, bytes.length, fingerprint, key],
    );
    await db.query(
      "INSERT INTO stock_items(id,farm_id,project_id,name,unit,quantity,unit_cost,currency,created_by,payload_hash) VALUES($1,$2,$3,'Existing harvest','kg',10,2,'USD',$4,'fixture')",
      [stock, farm, project, owner],
    );
    await db.query(
      "INSERT INTO stock_movements(id,farm_id,stock_item_id,project_id,actor_id,kind,quantity,unit,source_type,source_id,observed_at) VALUES($1,$2,$3,$4,$5,'opening',10,'kg','stock_opening',$3,now())",
      [randomUUID(), farm, stock, project, owner],
    );
    await db.query(
      "INSERT INTO financial_entries(id,farm_id,actor_id,kind,amount,currency,source_type,source_id,observed_at,category,receipt_activity_id) VALUES($1,$2,$3,'expense',100,'USD','documented_expense',$1,'2026-11-03T08:00:00Z','transport',$4)",
      [expense, farm, owner, activity],
    );
    await db.query(
      "INSERT INTO expense_allocations(id,request_id,farm_id,entry_id,project_id,amount,basis,created_by) VALUES($1,$2,$3,$4,$5,30,'Documented shared work',$6)",
      [allocation, randomUUID(), farm, expense, project, owner],
    );
    await db.query(
      "INSERT INTO opening_financial_balances(id,farm_id,project_id,as_of_date,kind,amount,currency,source,created_by) VALUES($1,$2,$3,'2026-11-01','cost',20,'USD','Existing dated opening invoice',$4)",
      [opening, farm, project, owner],
    );
    await db.query(
      "INSERT INTO market_listings(id,farm_id,stock_item_id,created_by,title,quantity,remaining_quantity,price,currency,collection_area,payload_hash) VALUES($1,$2,$3,$4,'Existing per-unit listing',10,10,2,'USD','Public district','fixture')",
      [listing, farm, stock, owner],
    );
    await db.query(
      "INSERT INTO treatment_restrictions(id,farm_id,project_id,starts_at,ends_at,scope,reason,authorized_by,created_by) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day','sale','Recorded verified release hold','Named professional',$4)",
      [restriction, farm, project, owner],
    );
    const before = (
      await db.query(
        "SELECT amount,currency,source_type,receipt_activity_id FROM financial_entries WHERE id=$1",
        [expense],
      )
    ).rows[0];
    const upgradeUrl = new URL(url);
    upgradeUrl.searchParams.set("options", `-c search_path=${schema}`);
    const env = { ...process.env, DATABASE_URL: upgradeUrl.toString() };
    const first = await exec(
      process.execPath,
      ["--import", "tsx", "src/migrate.ts"],
      { env, cwd: new URL("..", import.meta.url), timeout: 30000 },
    );
    assert.match(first.stdout, /Applied 007_asset_media.sql/);
    assert.match(first.stdout, /Applied 008_product_refinements.sql/);
    assert.deepEqual(
      (
        await db.query(
          "SELECT amount,currency,source_type,receipt_activity_id FROM financial_entries WHERE id=$1",
          [expense],
        )
      ).rows[0],
      // Widening to three decimal places preserves the exact old value while
      // allowing currencies such as KWD; only its textual scale changes.
      { ...before, amount: before.amount + "0" },
    );
    assert.equal(
      (
        await db.query(
          "SELECT version FROM opening_financial_balances WHERE id=$1",
          [opening],
        )
      ).rows[0].version,
      1,
    );
    assert.equal(
      (
        await db.query(
          "SELECT reversed_at FROM expense_allocations WHERE id=$1",
          [allocation],
        )
      ).rows[0].reversed_at,
      null,
    );
    assert.equal(
      Number(
        (
          await db.query(
            "SELECT price_quantity FROM market_listings WHERE id=$1",
            [listing],
          )
        ).rows[0].price_quantity,
      ),
      1,
    );
    assert.equal(
      (
        await db.query("SELECT asset_id FROM private_media WHERE id=$1", [
          mediaId,
        ])
      ).rows[0].asset_id,
      null,
    );
    const second = await exec(
      process.execPath,
      ["--import", "tsx", "src/migrate.ts"],
      { env, cwd: new URL("..", import.meta.url), timeout: 30000 },
    );
    assert.equal(
      second.stdout.trim(),
      "",
      "completed migrations do not run twice",
    );
    assert.equal(
      Number(
        (await db.query("SELECT count(*) FROM schema_migrations")).rows[0]
          .count,
      ),
      migrations.length,
    );
    app = buildApp(db, "http://localhost:5173");
    const path = `/v1/farms/${farm}`,
      headers = { authorization: `Bearer ${ownerToken}` };
    const request = (
      method: any,
      route: string,
      payload?: object,
      h = headers,
    ) =>
      app!.inject({
        method,
        url: route.startsWith("/v1") ? route : path + route,
        headers: h,
        ...(payload ? { payload } : {}),
      });
    const receipt = await request("GET", `/media/${mediaId}/content`);
    assert.equal(receipt.statusCode, 200, receipt.body);
    assert.deepEqual(receipt.rawPayload, bytes);
    assert.equal(
      (
        await request("GET", `/media/${mediaId}/content`, undefined, {
          authorization: `Bearer ${workerToken}`,
        })
      ).statusCode,
      404,
      "legacy non-cost receipt remains private through receipt linkage",
    );
    const report = await request(
      "GET",
      `/reports/summary?projectId=${project}`,
    );
    assert.equal(report.statusCode, 200, report.body);
    assert.equal(report.json().byCurrency[0].recordedCosts, 50);
    assert.equal(
      (await request("GET", `/v1/market/listings/${listing}`)).statusCode,
      404,
      "recorded release hold survives upgrade",
    );
    await db.query(
      "UPDATE treatment_restrictions SET starts_at=clock_timestamp()-interval '2 hours',ends_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
      [restriction],
    );
    const ordered = await request(
      "POST",
      `/v1/market/listings/${listing}/orders`,
      { id: randomUUID(), quantity: 2 },
    );
    assert.equal(ordered.statusCode, 201, ordered.body);
    assert.equal(Number(ordered.json().amount), 4);
    assert.equal(
      Number(
        (
          await db.query(
            "SELECT reserved_quantity FROM stock_items WHERE id=$1",
            [stock],
          )
        ).rows[0].reserved_quantity,
      ),
      2,
    );
  } finally {
    if (app) await app.close();
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(media, { recursive: true, force: true });
  }
});
