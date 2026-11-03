import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { once } from "node:events";
import mqtt from "mqtt";
import { Aedes } from "aedes";
import ModbusRTU from "modbus-serial";
import { createTransport, validateConfig } from "../src/transports.mjs";
import { OnvifCamera, validateCameraUrl } from "../src/onvif.mjs";
const base = {
  version: 1,
  configurationHash: "a".repeat(64),
  protocol: "http",
  connection: {},
  telemetry: [
    { name: "running", unit: "boolean", address: "running" },
    { name: "interlock_ok", unit: "boolean", address: "interlock_ok" },
    { name: "pressure_kpa", unit: "kPa", address: "pressure", scale: 0.1 },
  ],
  commands: [
    { name: "start", address: "/start", value: true },
    { name: "stop", address: "/stop", value: false },
  ],
};
async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server.address().port;
}
const expiry = () => new Date(Date.now() + 10000).toISOString();
test("HTTP transport reads mapped units, posts only approved commands, keeps explicit identity, rejects stale and external writes", async () => {
  let running = false;
  const writes = [];
  const server = httpServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      res.end(JSON.stringify({ running, interlock_ok: true, pressure: 120 }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const value = JSON.parse(body);
    writes.push({ url: req.url, id: req.headers["idempotency-key"], value });
    running = value.value;
    res.end("{}");
  });
  const port = await listen(server);
  const config = {
    ...base,
    connection: { url: "http://127.0.0.1:" + port, allowInsecure: true },
  };
  const transport = await createTransport(config);
  try {
    const before = await transport.read();
    assert.equal(before.values.pressure_kpa, 12);
    await transport.write("start", "test-command", expiry());
    assert.equal((await transport.read()).values.running, true);
    assert.equal(writes[0].id, "test-command");
    await assert.rejects(
      transport.write("arbitrary", "bad", expiry()),
      /not mapped/,
    );
    await assert.rejects(
      transport.write("start", "expired", "2000-01-01T00:00:00Z"),
      /expired/,
    );
    const bad = await createTransport({
      ...config,
      commands: [
        { name: "start", address: "http://example.org/write", value: true },
      ],
    });
    await assert.rejects(
      bad.write("start", "wrong-origin", expiry()),
      /configured origin/,
    );
    assert.equal(writes.length, 1);
    await bad.close();
  } finally {
    await transport.close();
    await new Promise((r) => server.close(r));
  }
});

test("MQTT broker simulation verifies feedback, nonretained scoped command publication and stale measurement rejection", async () => {
  const broker = await Aedes.createBroker();
  const server = tcpServer(broker.handle);
  const port = await listen(server),
    device = await mqtt.connectAsync("mqtt://127.0.0.1:" + port);
  const commands = [];
  device.on("message", (topic, data, packet) =>
    commands.push({ topic, data: JSON.parse(data), retain: packet.retain }),
  );
  await device.subscribeAsync("pump/command");
  const config = {
    ...base,
    protocol: "mqtt",
    connection: { url: "mqtt://127.0.0.1:" + port, allowInsecure: true },
    staleAfterMs: 10000,
    telemetry: [
      { name: "running", unit: "boolean", address: "pump/state#running" },
      {
        name: "interlock_ok",
        unit: "boolean",
        address: "pump/state#interlock_ok",
      },
    ],
    commands: [{ name: "start", address: "pump/command", value: true }],
  };
  const transport = await createTransport(config);
  try {
    await assert.rejects(transport.read(), /stale/);
    await device.publishAsync(
      "pump/state",
      JSON.stringify({ running: false, interlock_ok: true }),
      { qos: 1 },
    );
    let feedback;
    for (let i = 0; i < 20; i++) {
      try {
        feedback = await transport.read();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    assert.equal(feedback.values.interlock_ok, true);
    await transport.write("start", "mqtt-id", expiry());
    for (let i = 0; i < 20 && !commands.length; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(commands[0].data.id, "mqtt-id");
    assert.equal(commands[0].retain, false);
  } finally {
    await transport.close();
    await device.endAsync(true);
    await new Promise((r) => server.close(r));
    await broker.close();
  }
});

test("Modbus TCP simulator exercises coil feedback, scaled registers and whitelisted writes; serial configuration is explicit", async () => {
  const coils = { 0: false, 1: true },
    registers = { 3: 123 };
  const probe = tcpServer();
  const freePort = await listen(probe);
  await new Promise((r) => probe.close(r));
  const server = new ModbusRTU.ServerTCP(
    {
      getCoil: (a) => coils[a] ?? false,
      getHoldingRegister: (a) => registers[a] ?? 0,
      setCoil: (a, v) => {
        coils[a] = v;
      },
    },
    { host: "127.0.0.1", port: freePort, unitID: 1 },
  );
  await once(server._server, "listening");
  const port = server._server.address().port;
  const config = {
    ...base,
    protocol: "modbus-tcp",
    connection: { host: "127.0.0.1", port, unitId: 1, allowInsecure: true },
    telemetry: [
      { name: "running", unit: "boolean", address: "coil:0" },
      { name: "interlock_ok", unit: "boolean", address: "coil:1" },
      { name: "pressure_kpa", unit: "kPa", address: "holding:3", scale: 0.1 },
    ],
    commands: [
      { name: "start", address: "coil:0", value: true },
      { name: "stop", address: "coil:0", value: false },
    ],
  };
  const transport = await createTransport(config);
  try {
    assert.equal((await transport.read()).values.pressure_kpa, 12.3);
    await transport.write("start", "modbus-id", expiry());
    assert.equal((await transport.read()).values.running, true);
    await transport.write("stop", "modbus-stop", expiry());
    assert.equal((await transport.read()).values.running, false);
    await assert.rejects(
      createTransport({
        ...config,
        protocol: "modbus-rtu",
        connection: {
          path: "/etc/passwd",
          baudRate: 9600,
          unitId: 1,
          allowInsecure: true,
        },
      }),
      /serial port/,
    );
  } finally {
    await transport.close();
    await new Promise((r) => server.close(r));
  }
});

test("ONVIF SOAP fixture validates source URLs and exact event topics without treating motion as person analytics", async () => {
  process.env.FIXTURE_CAMERA_USER = "fixture";
  process.env.FIXTURE_CAMERA_PASS = "fixture-only";
  let origin = "";
  const server = httpServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.ok(body.includes("PasswordDigest"));
    assert.ok(!body.includes("fixture-only"));
    const action = req.headers["content-type"];
    let reply;
    if (action.includes("/GetCapabilities"))
      reply = `<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>${origin}/media</tt:XAddr></tt:Media><tt:Events><tt:XAddr>${origin}/events</tt:XAddr></tt:Events></tds:Capabilities></tds:GetCapabilitiesResponse>`;
    else if (action.includes("/GetProfiles"))
      reply =
        '<trt:GetProfilesResponse><trt:Profiles token="substream"><tt:Name>Low bandwidth</tt:Name></trt:Profiles></trt:GetProfilesResponse>';
    else if (action.includes("/GetStreamUri"))
      reply =
        "<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://127.0.0.1:8554/test</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>";
    else if (action.includes("CreatePullPoint"))
      reply = `<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference><wsa:Address>${origin}/pull</wsa:Address></tev:SubscriptionReference></tev:CreatePullPointSubscriptionResponse>`;
    else
      reply =
        '<tev:PullMessagesResponse><wsnt:NotificationMessage><wsnt:Topic>MotionAlarm</wsnt:Topic><wsnt:Message><tt:Message UtcTime="2026-11-03T12:00:00Z"><tt:Data><tt:SimpleItem Name="State" Value="true"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage></tev:PullMessagesResponse>';
    res.setHeader("content-type", "application/soap+xml");
    res.end(
      `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>${reply}</s:Body></s:Envelope>`,
    );
  });
  origin = "http://127.0.0.1:" + (await listen(server));
  const config = {
    deviceService: origin + "/device",
    allowedHosts: ["127.0.0.1"],
    allowInsecure: true,
    usernameEnv: "FIXTURE_CAMERA_USER",
    passwordEnv: "FIXTURE_CAMERA_PASS",
    profileToken: "substream",
    eventTopics: [{ topic: "MotionAlarm", kind: "motion" }],
  };
  try {
    const camera = new OnvifCamera(config),
      caps = await camera.discover();
    assert.equal(caps.ptzEnabled, false);
    assert.equal(caps.events, true);
    const events = await camera.pull();
    assert.equal(events[0].kind, "motion");
    assert.equal(events[0].observedAt, "2026-11-03T12:00:00.000Z");
    assert.throws(() =>
      validateCameraUrl("http://169.254.169.254/metadata", config),
    );
    const fakePerson = new OnvifCamera({
      ...config,
      eventTopics: [{ topic: "MotionAlarm", kind: "person" }],
    });
    await fakePerson.discover();
    assert.deepEqual(await fakePerson.pull(), []);
  } finally {
    await new Promise((r) => server.close(r));
    delete process.env.FIXTURE_CAMERA_USER;
    delete process.env.FIXTURE_CAMERA_PASS;
  }
});

test("mapping validation rejects duplicate telemetry, arbitrary control operations and absent feedback", () => {
  assert.throws(() =>
    validateConfig({
      ...base,
      telemetry: [base.telemetry[0], base.telemetry[0]],
    }),
  );
  assert.throws(() =>
    validateConfig({
      ...base,
      commands: [{ name: "raw_write", address: "holding:1", value: 1 }],
    }),
  );
  assert.throws(() =>
    validateConfig({ ...base, telemetry: [base.telemetry[0]] }),
  );
});

test(
  "Modbus RTU talks real serial framing and CRC through an isolated pseudo-terminal",
  { skip: process.platform !== "linux", timeout: 15000 },
  async () => {
    const { spawn } = await import("node:child_process");
    const program = `import os,pty,struct
master,slave=pty.openpty()
print(os.ttyname(slave),flush=True)
running=False
buffer=b''
def crc(data):
 value=65535
 for byte in data:
  value^=byte
  for _ in range(8):value=(value>>1)^40961 if value&1 else value>>1
 return struct.pack('<H',value)
while True:
 buffer+=os.read(master,1024)
 while len(buffer)>=8:
  req,buffer=buffer[:8],buffer[8:]
  if crc(req[:-2])!=req[-2:]:continue
  unit,fn,addr,count=struct.unpack('>BBHH',req[:6])
  if fn==1:
   value=running if addr==0 else True
   reply=bytes([unit,fn,1,1 if value else 0])
  elif fn==3:reply=bytes([unit,fn,2])+struct.pack('>H',234)
  elif fn==5:
   running=count==65280
   reply=req[:6]
  else:reply=bytes([unit,fn|128,1])
  os.write(master,reply+crc(reply))
`;
    const child = spawn("python3", ["-u", "-c", program], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b));
    let transport;
    try {
      const line = await Promise.race([
        once(child.stdout, "data").then(([b]) => b.toString().trim()),
        once(child, "exit").then(() => {
          throw new Error("Serial fixture failed " + stderr);
        }),
      ]);
      transport = await createTransport({
        ...base,
        protocol: "modbus-rtu",
        connection: {
          path: line,
          baudRate: 9600,
          unitId: 1,
          allowInsecure: true,
        },
        telemetry: [
          { name: "running", unit: "boolean", address: "coil:0" },
          { name: "interlock_ok", unit: "boolean", address: "coil:1" },
          {
            name: "pressure_kpa",
            unit: "kPa",
            address: "holding:3",
            scale: 0.1,
          },
        ],
        commands: [{ name: "start", address: "coil:0", value: true }],
      });
      const before = await transport.read();
      assert.equal(before.values.running, false);
      assert.equal(before.values.pressure_kpa, 23.400000000000002);
      await transport.write("start", "serial-fixture", expiry());
      assert.equal((await transport.read()).values.running, true);
    } finally {
      await transport?.close();
      child.kill("SIGTERM");
    }
  },
);

test("camera privacy schedule stays enforced offline and unconfigured detection zones cannot create footage", async () => {
  const { cameraEventPermitted } = await import("../src/camera-policy.mjs");
  const policy = {
    eventsEnabled: true,
    capabilities: { motion: true, person: false },
    timezone: "Africa/Harare",
    zones: [{ id: "gate" }],
    schedules: [{ days: [4], start: "22:00", end: "06:00" }],
  };
  const event = {
    kind: "motion",
    zoneId: "gate",
    observedAt: "2026-01-02T02:00:00Z",
  };
  assert.equal(cameraEventPermitted(policy, event), true);
  assert.equal(
    cameraEventPermitted(policy, {
      ...event,
      observedAt: "2026-01-02T09:00:00Z",
    }),
    false,
  );
  assert.equal(cameraEventPermitted(policy, { ...event, zoneId: null }), false);
  assert.equal(
    cameraEventPermitted(policy, { ...event, kind: "person" }),
    false,
  );
  assert.equal(
    cameraEventPermitted({ ...policy, eventsEnabled: false }, event),
    false,
  );
});
