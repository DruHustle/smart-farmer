// Launch from the Farmer checkout using Node 24. CI must check out a pinned
// Portal revision, install its locked frontend/backend dependencies and install
// the locked Farmer backend and web dependencies. Both PostgreSQL 17 databases must be disposable,
// on loopback, and named *_test. No production credentials are used.
// Required: PORTAL_CHECKOUT, PORTAL_TEST_DATABASE_URL, FARMER_TEST_DATABASE_URL,
// TEST_TLS_CERT, TEST_TLS_KEY and a new FIXTURE_READY_FILE outside either repo.
// Optional: PORTAL_TEST_ORIGIN (https://localhost:46501) and FARMER_TEST_ORIGIN
// (https://127.0.0.1:46502). Native debug builds can use http://127.0.0.1:46504.
// Device browsers and native clients must trust the test certificate.
// The TLS server mounts the actual Portal account React screen and both real
// APIs. The Apple/Google trust association and OS callback are exercised by
// the device job, independently from an uploaded public release.
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  unlinkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";

const scripts = dirname(fileURLToPath(import.meta.url)),
  farmer = resolve(scripts, "..");
function required(name) {
  if (!process.env[name]) throw new Error(name + " is required");
  return process.env[name];
}
function testDb(name) {
  const value = required(name),
    url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/[a-zA-Z0-9_]+_test$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error(
      name + " must reference a disposable loopback PostgreSQL database",
    );
  return value;
}
function testOrigin(name, fallback) {
  const value = process.env[name] || fallback,
    url = new URL(value);
  if (
    url.origin !== value ||
    url.protocol !== "https:" ||
    !url.port ||
    !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    throw new Error(
      name + " must be an exact HTTPS loopback origin with a port",
    );
  return url;
}
const portal = resolve(required("PORTAL_CHECKOUT")),
  portalApi = join(portal, "onesa-company-portal-backend"),
  portalWeb = join(portal, "onesa-company-portal-frontend"),
  farmerApi = join(farmer, "smart-farmer-backend"),
  farmerWeb = join(farmer, "smart-farmer-frontend/web");
const portalDb = testDb("PORTAL_TEST_DATABASE_URL"),
  farmerDb = testDb("FARMER_TEST_DATABASE_URL");
if (new URL(portalDb).pathname === new URL(farmerDb).pathname)
  throw new Error(
    "Use separate disposable database names for Portal and Farmer",
  );
const issuerOrigin = testOrigin(
  "PORTAL_TEST_ORIGIN",
  "https://localhost:46501",
);
const appOrigin = testOrigin("FARMER_TEST_ORIGIN", "https://127.0.0.1:46502");
if (new Set([issuerOrigin.port, appOrigin.port, "46504", "46506"]).size !== 4)
  throw new Error("Fixture listener ports must be distinct");
const ready = resolve(required("FIXTURE_READY_FILE"));
if (
  existsSync(ready) ||
  [portal, farmer].some(
    (root) => ready === root || ready.startsWith(root + "/"),
  )
)
  throw new Error("Choose a new readiness JSON file outside both repositories");
const cert = resolve(required("TEST_TLS_CERT")),
  tls = {
    cert: readFileSync(cert),
    key: readFileSync(required("TEST_TLS_KEY")),
  };
const children = new Set(),
  servers = [],
  temp = mkdtempSync(join(tmpdir(), "farmer-portal-device-"));
const localEnv = {};
for (const key of [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "LANG",
  "CI",
])
  if (process.env[key]) localEnv[key] = process.env[key];
Object.assign(localEnv, {
  NODE_ENV: "test",
  NODE_EXTRA_CA_CERTS: cert,
  AWS_EC2_METADATA_DISABLED: "true",
});
const password = "Device fixture " + randomBytes(18).toString("hex"),
  codes = Array.from({ length: 8 }, () => randomUUID()),
  proxyKey = randomBytes(32).toString("hex"),
  clientSecret = randomBytes(48).toString("hex"),
  issuer = issuerOrigin.origin + "/api/v1/identity";
const client = {
  product: "farmer",
  clientId: "synthetic_farmer_device",
  clientSecret,
  redirectUri: appOrigin.origin + "/auth/onesa/callback",
  applicationUrl: appOrigin.origin + "/",
};
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = {
  issuer,
  clients: [client],
  cookieKeys: [randomBytes(48).toString("hex")],
  jwks: {
    keys: [
      {
        ...privateKey.export({ format: "jwk" }),
        kid: "temporary_device_test",
        alg: "RS256",
        use: "sig",
      },
    ],
  },
};
const portalEnv = {
  ...localEnv,
  DATABASE_URL: portalDb,
  PUBLIC_ORIGIN: issuerOrigin.origin,
  SESSION_KEY: randomBytes(32).toString("hex"),
  PROXY_SHARED_KEY: proxyKey,
  ONESA_IDENTITY_ENABLED: "true",
  ONESA_IDENTITY_CONFIG_B64: Buffer.from(JSON.stringify(config)).toString(
    "base64",
  ),
};
const farmerEnv = {
  ...localEnv,
  DATABASE_URL: farmerDb,
  WEB_ORIGIN: appOrigin.origin,
  ONESA_IDENTITY_ENABLED: "true",
  ONESA_IDENTITY_ISSUER: issuer,
  ONESA_IDENTITY_CLIENT_ID: client.clientId,
  ONESA_IDENTITY_CLIENT_SECRET: clientSecret,
  LOG_LEVEL: "silent",
};
let stopping = false;
function cleanup() {
  if (stopping) return;
  stopping = true;
  for (const server of servers) server.close();
  for (const child of children) child.kill();
  rmSync(temp, { recursive: true, force: true });
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("exit", cleanup);
function start(cwd, env, args, longLived = false) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.add(child);
  child.once("exit", () => {
    children.delete(child);
    if (longLived && !stopping) {
      cleanup();
      process.exitCode = 1;
    }
  });
  return child;
}
async function run(cwd, env, args) {
  const [code] = await once(start(cwd, env, args), "exit");
  if (code !== 0) throw new Error("Fixture setup failed in " + cwd);
}
async function publicApi(path, data, bearer) {
  const response = await fetch("http://127.0.0.1:46504" + path, {
    method: data ? "POST" : "GET",
    signal: AbortSignal.timeout(10000),
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: "Bearer " + bearer } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  if (!response.ok) throw new Error(path + " returned " + response.status);
  return response.json();
}
const page =
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Onesa account</title><link rel="stylesheet" href="/portal.css"><div id="root"></div><script src="/portal.js" defer></script></html>';
async function listen(origin, isPortal) {
  const server = https.createServer(tls, (request, response) => {
    const path = new URL(request.url, origin).pathname;
    if (
      (isPortal && path.startsWith("/api/")) ||
      (!isPortal && path.startsWith("/v1/"))
    ) {
      const headers = { ...request.headers, "x-forwarded-proto": "https" };
      if (isPortal) {
        headers["x-portal-proxy-key"] = proxyKey;
        headers["x-portal-client-ip"] = "127.0.0.1";
      }
      const upstream = http.request(
        {
          hostname: "127.0.0.1",
          port: isPortal ? 46506 : 46504,
          path: request.url,
          method: request.method,
          headers,
        },
        (reply) => {
          response.writeHead(reply.statusCode, reply.headers);
          reply.pipe(response);
        },
      );
      upstream.on("error", () => {
        response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
      return;
    }
    if (!isPortal && path === "/auth/onesa/callback") {
      response.setHeader("content-type", "text/html");
      response.end(readFileSync(join(temp, "farmer.html")));
      return;
    }
    const assets = isPortal
      ? ["/portal.js", "/portal.css"]
      : ["/farmer.js", "/farmer.css"];
    if (assets.includes(path)) {
      response.setHeader(
        "content-type",
        path.endsWith(".js") ? "application/javascript" : "text/css",
      );
      response.end(readFileSync(join(temp, path.slice(1))));
      return;
    }
    if (
      isPortal &&
      (path === "/account" || /^\/account\/sign-in\/[A-Za-z0-9_-]+$/.test(path))
    ) {
      response.setHeader("content-type", "text/html");
      response.end(page);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  servers.push(server);
  await new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(Number(origin.port), "127.0.0.1", res);
  });
}
try {
  const { build } = createRequire(join(portalApi, "package.json"))("esbuild");
  await build({
    stdin: {
      contents: `import React from 'react';import{createRoot}from'react-dom/client';import{OnesaAccount}from'./src/features/account/account';const interactionId=location.pathname.match(/^\\/account\\/sign-in\\/([A-Za-z0-9_-]+)$/)?.[1];createRoot(document.getElementById('root')).render(<OnesaAccount interactionId={interactionId}/>);`,
      loader: "tsx",
      resolveDir: portalWeb,
    },
    outfile: join(temp, "portal.js"),
    bundle: true,
    minify: true,
    jsx: "automatic",
    tsconfig: join(portalWeb, "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".module.css": "local-css" },
  });
  await build({
    entryPoints: [join(farmerWeb, "src/main.tsx")],
    outfile: join(temp, "farmer.js"),
    bundle: true,
    minify: true,
    format: "esm",
    jsx: "automatic",
    tsconfig: join(farmerWeb, "tsconfig.json"),
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": JSON.stringify({
        PROD: false,
        VITE_API_URL: appOrigin.origin,
      }),
    },
  });
  writeFileSync(
    join(temp, "farmer.html"),
    readFileSync(join(farmerWeb, "index.html"), "utf8")
      .replace("</head>", '<link rel="stylesheet" href="/farmer.css"></head>')
      .replace("/src/main.tsx", "/farmer.js"),
  );
  await run(
    portalApi,
    {
      ...portalEnv,
      FIXTURE_PASSWORD: password,
      FIXTURE_RECOVERY_CODES: JSON.stringify(codes),
    },
    ["--import", "tsx", join(scripts, "device-fixture", "seed-portal.mjs")],
  );
  await run(farmerApi, farmerEnv, ["--import", "tsx", "src/migrate.ts"]);
  start(
    portalApi,
    portalEnv,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "import {buildApp} from './src/app.ts';const app=await buildApp({logging:false});await app.listen({host:'127.0.0.1',port:46506})",
    ],
    true,
  );
  start(
    farmerApi,
    farmerEnv,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "import {buildApp} from './src/app.ts';import {pool} from './src/db.ts';const app=buildApp(pool,process.env.WEB_ORIGIN);await app.listen({host:'127.0.0.1',port:46504})",
    ],
    true,
  );
  await listen(issuerOrigin, true);
  await listen(appOrigin, false);
  let healthy = false;
  for (let i = 0; i < 100 && !stopping; i++) {
    try {
      const farmerConfig = await publicApi("/v1/onesa/config");
      const response = await fetch(
        "http://127.0.0.1:46506/api/v1/account/config",
        {
          headers: { "x-portal-proxy-key": proxyKey },
          signal: AbortSignal.timeout(3000),
        },
      );
      if (farmerConfig.callback === client.redirectUri && response.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* wait for startup */
    }
    await delay(250);
  }
  if (!healthy) throw new Error("Both fixture APIs must be listening");
  const local = { username: "device_fixture_owner", password };
  const account = await publicApi("/v1/register", {
    ...local,
    language: "sn",
    farmName: "Device Qualification Farm",
  });
  const owner = await publicApi("/v1/sessions", local);
  const base = "/v1/farms/" + account.farmId;
  const worker = await publicApi(
    base + "/invitations",
    { role: "worker" },
    owner.token,
  );
  const adviser = await publicApi(
    base + "/invitations",
    { role: "adviser" },
    owner.token,
  );
  const title = "Morning irrigation inspection";
  await publicApi(
    base + "/forum/discussions",
    {
      id: randomUUID(),
      displayName: "Fixture owner",
      topic: "irrigation",
      title,
      body: "Check the north field before the next irrigation cycle.",
      shareWithCommunity: true,
    },
    owner.token,
  );
  const git = (cwd) =>
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
  const privateReceipt = ready + "." + randomUUID();
  writeFileSync(
    privateReceipt,
    JSON.stringify(
      {
        PORTAL_REVISION: git(portal),
        FARMER_REVISION: git(farmer),
        MEMBER_EMAIL: "member@example.invalid",
        ADMIN_EMAIL: "administrator@example.invalid",
        PASSWORD: password,
        ADMIN_MFA: codes[0],
        ADMIN_RECOVERY_CODES: codes,
        MEMBER_INVITE: worker.token,
        ADMIN_INVITE: adviser.token,
        FARM_ID: account.farmId,
        FARM_NAME: "Device Qualification Farm",
        FORUM_TITLE: title,
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
  try {
    linkSync(privateReceipt, ready);
  } finally {
    unlinkSync(privateReceipt);
  }
  console.log(
    "Disposable Portal and Farmer fixture ready. Both Portal users start without a farm membership.",
  );
} catch (error) {
  cleanup();
  console.error(error.message);
  process.exitCode = 1;
}
