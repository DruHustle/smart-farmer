import { readFile, mkdir, readdir, rm, open, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { OnvifCamera } from "./onvif.mjs";
import { cameraEventPermitted } from "./camera-policy.mjs";
const config = JSON.parse(await readFile(process.env.CAMERA_CONFIG, "utf8")),
  base = new URL(process.env.API_URL),
  credential = process.env.ASSET_GATEWAY_TOKEN;
if (
  !/^[A-Za-z0-9_-]{43}$/.test(credential ?? "") ||
  base.username ||
  base.password ||
  base.pathname !== "/" ||
  base.search ||
  base.hash ||
  (base.protocol !== "https:" &&
    !(
      process.env.NODE_ENV !== "production" &&
      base.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(base.hostname)
    ))
)
  throw new Error("Private camera API configuration is required");
const directory = resolve(process.env.GATEWAY_STATE_DIR || ".data/camera");
await mkdir(directory, { recursive: true, mode: 0o700 });
const stateFile = join(directory, "state.json");
let state = {
  version: 1,
  sequence: 0,
  buffer: [],
  dropped: 0,
  lastEvents: {},
  demand: null,
};
try {
  state = { ...state, ...JSON.parse(await readFile(stateFile, "utf8")) };
  if (state.version !== 1 || !Array.isArray(state.buffer))
    throw new Error("Invalid camera state");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
async function save() {
  const temp = stateFile + "." + randomUUID(),
    f = await open(temp, "wx", 0o600);
  try {
    await f.writeFile(JSON.stringify(state));
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(temp, stateFile);
}
async function post(path, body) {
  const r = await fetch(new URL(path, base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + credential,
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) {
    const e = new Error("Camera API request rejected");
    e.status = r.status;
    throw e;
  }
  return r.json();
}
let stopped = false,
  child,
  camera;
const stop = () => {
  stopped = true;
  child?.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
async function ffmpeg(args) {
  await new Promise((resolveRun, reject) => {
    child = spawn(
      process.env.FFMPEG_PATH || "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-nostdin", ...args],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    const timer = setTimeout(() => child?.kill("SIGKILL"), 20000);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      child = null;
      code === 0
        ? resolveRun()
        : reject(new Error("Private stream capture failed"));
    });
  });
}
function trimBuffer() {
  while (state.buffer.length > 120) {
    const first = state.buffer.shift();
    state.dropped++;
    if (first.path === "/v1/edge/camera/events") {
      const before = state.buffer.length;
      state.buffer = state.buffer.filter(
        (e) => e.body.eventId !== first.body.id,
      );
      state.dropped += before - state.buffer.length;
    }
  }
}
async function capture(eventId, snapshotOnly = false) {
  const folder = join(directory, "capture-" + randomUUID());
  await mkdir(folder, { mode: 0o700 });
  const start = Date.now();
  try {
    const input = [
      "-rtsp_transport",
      "tcp",
      "-rw_timeout",
      "5000000",
      "-i",
      camera.streamUrl(),
    ];
    const image = join(folder, "snapshot.jpg");
    if (snapshotOnly) {
      await ffmpeg([
        ...input,
        "-frames:v",
        "1",
        "-vf",
        "scale=640:-2",
        "-update",
        "1",
        image,
      ]);
    } else {
      await ffmpeg([
        ...input,
        "-t",
        "8",
        "-an",
        "-vf",
        "scale=640:-2,fps=10",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "20",
        "-b:v",
        "350k",
        "-f",
        "segment",
        "-segment_time",
        "2",
        "-reset_timestamps",
        "0",
        join(folder, "%03d.ts"),
      ]);
      let i = 0;
      const files = (await readdir(folder))
        .filter((f) => f.endsWith(".ts"))
        .sort();
      for (const file of files) {
        const bytes = await readFile(join(folder, file));
        if (bytes.length > 5242880) throw new Error("Segment quota exceeded");
        state.sequence++;
        state.buffer.push({
          path: "/v1/edge/camera/segments",
          body: {
            id: randomUUID(),
            sequence: state.sequence,
            observedAt: new Date(start + i++ * 2000).toISOString(),
            duration: 2,
            discontinuity: i === 1,
            eventId,
            dataBase64: bytes.toString("base64"),
          },
          createdAt: Date.now(),
        });
      }
      if (files[0])
        await ffmpeg([
          "-i",
          join(folder, files[0]),
          "-frames:v",
          "1",
          "-update",
          "1",
          image,
        ]);
    }
    const thumbnail = await readFile(image);
    if (thumbnail.length <= 5242880)
      state.buffer.push({
        path: "/v1/edge/camera/snapshot",
        body: {
          id: randomUUID(),
          observedAt: new Date(start).toISOString(),
          dataBase64: thumbnail.toString("base64"),
        },
        createdAt: Date.now(),
      });
    trimBuffer();
    await save();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
async function flush() {
  while (state.buffer.length && !stopped) {
    const first = state.buffer[0];
    if (
      first.path.endsWith("/segments") &&
      !first.body.eventId &&
      Date.now() - first.createdAt > 30000
    ) {
      state.buffer.shift();
      state.dropped++;
      await save();
      continue;
    }
    try {
      const result = await post(first.path, first.body);
      if (first.path === "/v1/edge/camera/events") {
        if (
          ["ignored_schedule", "ignored_unmapped_zone"].includes(result.status)
        ) {
          state.buffer = state.buffer.filter(
            (e) => e.body.eventId !== first.body.id,
          );
        } else if (result.id && result.id !== first.body.id) {
          for (const e of state.buffer)
            if (e.body.eventId === first.body.id) e.body.eventId = result.id;
        }
      }
    } catch (e) {
      if ([400, 404, 409].includes(e.status)) {
        state.buffer.shift();
        state.dropped++;
        if (first.path === "/v1/edge/camera/events")
          state.buffer = state.buffer.filter(
            (e) => e.body.eventId !== first.body.id,
          );
        await save();
        continue;
      }
      throw e;
    }
    state.buffer.shift();
    await save();
  }
}
while (!stopped) {
  try {
    if (!camera) {
      camera = new OnvifCamera(config);
      const caps = await camera.discover();
      console.log(JSON.stringify({ event: "camera_discovered", ...caps }));
    }
    let online = true,
      demand;
    try {
      demand = await post("/v1/edge/camera/demand", {});
      state.demand = { ...demand, live: false, snapshot: false };
      await save();
      await flush();
    } catch (e) {
      if (e.status === 401) throw e;
      online = false;
      demand = { ...state.demand, live: false, snapshot: false };
    }
    let captured = false;
    if (demand?.eventsEnabled) {
      for (const event of await camera.pull()) {
        if (!cameraEventPermitted(demand, event)) continue;
        const key = event.kind + ":" + (event.zoneId ?? ""),
          at = Date.parse(event.observedAt);
        if (at - (state.lastEvents[key] ?? 0) < 30000) continue;
        state.lastEvents[key] = at;
        const id = randomUUID();
        state.buffer.push({
          path: "/v1/edge/camera/events",
          body: { id, ...event },
          createdAt: Date.now(),
        });
        trimBuffer();
        await save();
        await capture(id);
        captured = true;
        break;
      }
    }
    if (online && demand?.live && !captured) await capture(null);
    else if (online && demand?.snapshot && !captured) await capture(null, true);
    if (online) await flush();
    console.log(
      JSON.stringify({
        event: "camera_synced",
        online,
        pending: state.buffer.length,
        dropped: state.dropped,
      }),
    );
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "camera_gateway_failed",
        httpStatus: e.status ?? null,
        pending: state.buffer.length,
        dropped: state.dropped,
      }),
    );
    camera = undefined;
    if (e.status === 401) {
      stopped = true;
      process.exitCode = 1;
    }
  }
  if (!stopped) await delay(3000);
}
await save();
