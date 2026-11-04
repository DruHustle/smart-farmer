import mqtt from "mqtt";
import ModbusRTU from "modbus-serial";
const finite = (n) => typeof n === "number" && Number.isFinite(n);
export function validateConfig(config) {
  if (
    !config ||
    config.version !== 1 ||
    !["http", "mqtt", "modbus-tcp", "modbus-rtu"].includes(config.protocol) ||
    !Array.isArray(config.telemetry) ||
    !config.telemetry.length ||
    config.telemetry.length > 50 ||
    !Array.isArray(config.commands) ||
    config.commands.length > 2 ||
    !String(config.configurationHash).match(/^[a-f0-9]{64}$/)
  )
    throw new Error("Invalid approved integration configuration");
  const names = new Set();
  for (const m of config.telemetry) {
    if (
      !/^[a-z][a-z0-9_]{0,49}$/.test(m.name) ||
      names.has(m.name) ||
      !m.address ||
      !m.unit ||
      (m.scale !== undefined && (!finite(m.scale) || m.scale === 0)) ||
      (m.offset !== undefined && !finite(m.offset))
    )
      throw new Error("Invalid telemetry mapping");
    names.add(m.name);
  }
  const commands = new Set();
  for (const m of config.commands) {
    if (
      !["start", "stop"].includes(m.name) ||
      commands.has(m.name) ||
      !m.address ||
      !(
        typeof m.value === "boolean" ||
        (Number.isInteger(m.value) && m.value >= 0 && m.value <= 65535)
      )
    )
      throw new Error("Invalid command mapping");
    commands.add(m.name);
  }
  if (commands.size && (!names.has("running") || !names.has("interlock_ok")))
    throw new Error(
      "Running and local interlock feedback mappings are required",
    );
  return config;
}
function endpoint(value, protocols, allowInsecure) {
  const u = new URL(value);
  if (!protocols.includes(u.protocol) || u.username || u.password || u.hash)
    throw new Error("Invalid private endpoint");
  if (["http:", "mqtt:", "ws:"].includes(u.protocol) && !allowInsecure)
    throw new Error(
      "Explicit isolated-network acknowledgement required for plaintext device protocol",
    );
  return u;
}
function secret(name) {
  if (name === undefined) return undefined;
  if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(name))
    throw new Error("Credentials must use environment references");
  const value = process.env[name];
  if (!value) throw new Error("Referenced credential is unavailable");
  return value;
}
function mapped(config, raw) {
  const values = {};
  for (const m of config.telemetry) {
    let value = raw[m.name];
    if (value === undefined) continue;
    if (finite(value)) value = value * (m.scale ?? 1) + (m.offset ?? 0);
    if (
      !["number", "boolean", "string"].includes(typeof value) ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      throw new Error("Invalid telemetry value");
    values[m.name] = value;
  }
  return values;
}
function pointer(raw, address) {
  const keys = address.startsWith("/")
    ? address
        .slice(1)
        .split("/")
        .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"))
    : address.split(".");
  let value = raw;
  for (const key of keys) {
    if (
      ["__proto__", "prototype", "constructor"].includes(key) ||
      !value ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    value = value[key];
  }
  return value;
}
async function boundedJson(response) {
  if (!response.ok) throw new Error("Device request failed");
  const reader = response.body.getReader();
  let size = 0;
  const parts = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) throw new Error("Device response too large");
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export async function createTransport(input) {
  const config = validateConfig(input),
    timeout = Math.max(500, Math.min(10000, config.timeoutMs ?? 3000));
  const command = (name) => {
    const m = config.commands.find((x) => x.name === name);
    if (!m) throw new Error("Command is not mapped");
    return m;
  };
  if (config.protocol === "http") {
    const base = endpoint(
      config.connection.url,
      ["https:", "http:"],
      config.connection.allowInsecure === true,
    );
    const credential = secret(config.connection.tokenEnv);
    const headers = {
      Accept: "application/json",
      ...(credential ? { Authorization: "Bearer " + credential } : {}),
    };
    const url = (path) => {
      const target = new URL(path, base);
      if (target.origin !== base.origin || target.username || target.password)
        throw new Error("Device path must stay on the configured origin");
      return target;
    };
    return {
      async read() {
        const body = await boundedJson(
          await fetch(url(config.connection.telemetryPath || "/telemetry"), {
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(timeout),
          }),
        );
        const raw = {};
        for (const m of config.telemetry)
          raw[m.name] = pointer(body, m.address);
        return {
          values: mapped(config, raw),
          observedAt: new Date().toISOString(),
        };
      },
      async write(name, id, expiresAt) {
        const m = command(name);
        if (Date.parse(expiresAt) <= Date.now())
          throw new Error("Command expired");
        const response = await fetch(url(m.address), {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "Idempotency-Key": id,
          },
          body: JSON.stringify({ id, value: m.value, expiresAt }),
          redirect: "error",
          signal: AbortSignal.timeout(
            Math.min(timeout, Date.parse(expiresAt) - Date.now()),
          ),
        });
        if (!response.ok) throw new Error("Device rejected command");
      },
      async close() {},
    };
  }
  if (config.protocol === "mqtt") {
    const u = endpoint(
        config.connection.url,
        ["mqtts:", "mqtt:", "wss:", "ws:"],
        config.connection.allowInsecure === true,
      ),
      client = await mqtt.connectAsync(u.href, {
        username: secret(config.connection.usernameEnv),
        password: secret(config.connection.passwordEnv),
        rejectUnauthorized: true,
        reconnectPeriod: 0,
        connectTimeout: timeout,
        clean: true,
      });
    const values = {},
      observed = {};
    client.on("message", (topic, data) => {
      if (data.length > 65536) return;
      try {
        const payload = JSON.parse(data.toString());
        for (const m of config.telemetry) {
          const [topicName, path = "value"] = m.address.split("#");
          if (topicName !== topic) continue;
          values[m.name] = pointer(payload, path);
          observed[m.name] = Date.now();
        }
      } catch {}
    });
    client.on("error", () => {});
    for (const topic of new Set(
      config.telemetry.map((m) => m.address.split("#")[0]),
    )) {
      if (!topic || /[+#]/.test(topic))
        throw new Error("Concrete MQTT telemetry topics required");
      await client.subscribeAsync(topic, { qos: 1 });
    }
    return {
      async read() {
        const maxAge = config.staleAfterMs ?? 10000;
        if (
          config.telemetry.some(
            (m) => !observed[m.name] || Date.now() - observed[m.name] > maxAge,
          )
        )
          throw new Error("MQTT feedback is stale or incomplete");
        return {
          values: mapped(config, values),
          observedAt: new Date(
            Math.min(...Object.values(observed)),
          ).toISOString(),
        };
      },
      async write(name, id, expiresAt) {
        const m = command(name);
        if (/[+#]/.test(m.address) || Date.parse(expiresAt) <= Date.now())
          throw new Error("Invalid or expired MQTT command");
        await client.publishAsync(
          m.address,
          JSON.stringify({ id, value: m.value, expiresAt }),
          { qos: 1, retain: false },
        );
      },
      async close() {
        await client.endAsync(true);
      },
    };
  }
  const client = new ModbusRTU();
  client.setTimeout(timeout);
  const connection = config.connection;
  if (!connection.allowInsecure)
    throw new Error(
      "Modbus requires explicit isolated-network acknowledgement",
    );
  if (
    !Number.isInteger(connection.unitId) ||
    connection.unitId < 1 ||
    connection.unitId > 247
  )
    throw new Error("An explicit Modbus unit ID is required");
  if (config.protocol === "modbus-tcp") {
    if (
      !connection.host ||
      !Number.isInteger(connection.port) ||
      connection.port < 1 ||
      connection.port > 65535
    )
      throw new Error("Explicit Modbus TCP endpoint required");
    await client.connectTCP(connection.host, { port: connection.port });
  } else {
    if (
      !/^(\/dev\/tty[A-Za-z0-9_-]+|\/dev\/pts\/[0-9]+|\/dev\/serial\/by-id\/[A-Za-z0-9_.:-]+|COM[1-9][0-9]*)$/.test(
        connection.path,
      ) ||
      !Number.isInteger(connection.baudRate) ||
      connection.baudRate < 1200 ||
      connection.baudRate > 115200
    )
      throw new Error("Explicit approved serial port and baud rate required");
    await client.connectRTUBuffered(connection.path, {
      baudRate: connection.baudRate,
      parity: connection.parity ?? "none",
      dataBits: 8,
      stopBits: connection.stopBits ?? 1,
    });
  }
  client.setID(connection.unitId);
  function address(value) {
    const m = /^(coil|discrete|holding|input):(\d{1,5})$/.exec(value);
    if (!m || Number(m[2]) > 65535)
      throw new Error("Invalid mapped Modbus address");
    return { type: m[1], offset: Number(m[2]) };
  }
  return {
    async read() {
      const raw = {};
      for (const m of config.telemetry) {
        const a = address(m.address);
        const length = m.format === "float32" ? 2 : 1;
        if (a.offset + length > 65536)
          throw new Error("Invalid mapped Modbus range");
        const result =
          a.type === "coil"
            ? await client.readCoils(a.offset, length)
            : a.type === "discrete"
              ? await client.readDiscreteInputs(a.offset, length)
              : a.type === "holding"
                ? await client.readHoldingRegisters(a.offset, length)
                : await client.readInputRegisters(a.offset, length);
        let value = result.data[0];
        if (m.format === "int16" && value > 32767) value -= 65536;
        if (m.format === "float32") {
          const b = Buffer.alloc(4);
          const registers =
            m.wordOrder === "little"
              ? [result.data[1], result.data[0]]
              : result.data;
          b.writeUInt16BE(registers[0], 0);
          b.writeUInt16BE(registers[1], 2);
          value = b.readFloatBE();
        }
        raw[m.name] = value;
      }
      return {
        values: mapped(config, raw),
        observedAt: new Date().toISOString(),
      };
    },
    async write(name, id, expiresAt) {
      const m = command(name),
        a = address(m.address);
      if (Date.parse(expiresAt) <= Date.now())
        throw new Error("Command expired");
      if (a.type === "coil" && typeof m.value === "boolean")
        await client.writeCoil(a.offset, m.value);
      else if (a.type === "holding" && Number.isInteger(m.value))
        await client.writeRegister(a.offset, m.value);
      else throw new Error("Write is not an approved coil or register mapping");
    },
    async close() {
      await new Promise((resolve) => client.close(resolve));
    },
  };
}
