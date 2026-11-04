import { createHash, randomBytes } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  processEntities: false,
});
const escape = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const array = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
function find(value, name) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, name)) return value[name];
  for (const child of Object.values(value)) {
    const found = find(child, name);
    if (found !== undefined) return found;
  }
}
export function validateCameraUrl(value, config, stream = false) {
  const u = new URL(value);
  const allowed = stream ? ["rtsp:", "rtsps:"] : ["https:", "http:"];
  if (
    !allowed.includes(u.protocol) ||
    u.username ||
    u.password ||
    u.hash ||
    !config.allowedHosts?.includes(u.hostname)
  )
    throw new Error("Camera returned a URL outside its explicit allowlist");
  if (["http:", "rtsp:"].includes(u.protocol) && config.allowInsecure !== true)
    throw new Error("Isolated-network acknowledgement required");
  return u;
}
export class OnvifCamera {
  constructor(config) {
    this.config = config;
    this.device = validateCameraUrl(config.deviceService, config).href;
    const names = [config.usernameEnv, config.passwordEnv];
    if (
      names.some(
        (n) => !n || !/^[A-Z][A-Z0-9_]{0,99}$/.test(n) || !process.env[n],
      )
    )
      throw new Error("Private camera credential references required");
    this.username = process.env[config.usernameEnv];
    this.password = process.env[config.passwordEnv];
  }
  async soap(url, action, body) {
    validateCameraUrl(url, this.config);
    const nonce = randomBytes(20),
      created = new Date().toISOString(),
      digest = createHash("sha1")
        .update(
          Buffer.concat([
            nonce,
            Buffer.from(created),
            Buffer.from(this.password),
          ]),
        )
        .digest("base64");
    const security = `<wsse:Security s:mustUnderstand="1"><wsse:UsernameToken><wsse:Username>${escape(this.username)}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`;
    const xml = `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" xmlns:wsa="http://www.w3.org/2005/08/addressing" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"><s:Header>${security}<wsa:Action>${escape(action)}</wsa:Action><wsa:To>${escape(url)}</wsa:To></s:Header><s:Body>${body}</s:Body></s:Envelope>`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": `application/soap+xml; charset=utf-8; action="${action}"`,
      },
      body: xml,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("ONVIF request rejected");
    const reader = r.body.getReader();
    let size = 0;
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1000000) throw new Error("ONVIF response too large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const raw = Buffer.concat(chunks).toString();
    if (/<!DOCTYPE|<!ENTITY/i.test(raw))
      throw new Error("XML entities are forbidden");
    const parsed = parser.parse(raw);
    if (find(parsed, "Fault")) throw new Error("ONVIF fault");
    return parsed;
  }
  async discover() {
    const caps = await this.soap(
      this.device,
      "http://www.onvif.org/ver10/device/wsdl/GetCapabilities",
      "<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>",
    );
    const c = find(caps, "Capabilities");
    this.media = validateCameraUrl(c?.Media?.XAddr, this.config).href;
    this.events = c?.Events?.XAddr
      ? validateCameraUrl(c.Events.XAddr, this.config).href
      : null;
    const r = await this.soap(
      this.media,
      "http://www.onvif.org/ver10/media/wsdl/GetProfiles",
      "<trt:GetProfiles/>",
    );
    const profiles = array(find(r, "Profiles"));
    const profile = profiles.find(
      (p) => p["@token"] === this.config.profileToken,
    );
    if (!profile)
      throw new Error(
        "Explicit camera profile token does not match a reported profile",
      );
    this.profile = profile["@token"];
    const stream = await this.soap(
      this.media,
      "http://www.onvif.org/ver10/media/wsdl/GetStreamUri",
      `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${escape(this.profile)}</trt:ProfileToken></trt:GetStreamUri>`,
    );
    this.stream = validateCameraUrl(
      find(stream, "MediaUri")?.Uri,
      this.config,
      true,
    ).href;
    return {
      profileToken: this.profile,
      events: Boolean(this.events),
      ptzReported: Boolean(profile.PTZConfiguration),
      ptzEnabled: false,
    };
  }
  streamUrl() {
    if (!this.stream) throw new Error("Camera has not been discovered");
    const u = new URL(this.stream);
    u.username = this.username;
    u.password = this.password;
    return u.href;
  }
  async snapshot() {
    const r = await this.soap(
      this.media,
      "http://www.onvif.org/ver10/media/wsdl/GetSnapshotUri",
      `<trt:GetSnapshotUri><trt:ProfileToken>${escape(this.profile)}</trt:ProfileToken></trt:GetSnapshotUri>`,
    );
    const u = validateCameraUrl(find(r, "MediaUri")?.Uri, this.config);
    return u;
  }
  async subscribe() {
    if (!this.events) return false;
    const r = await this.soap(
      this.events,
      "http://www.onvif.org/ver10/events/wsdl/EventPortType/CreatePullPointSubscriptionRequest",
      "<tev:CreatePullPointSubscription><tev:InitialTerminationTime>PT60S</tev:InitialTerminationTime></tev:CreatePullPointSubscription>",
    );
    const address = find(r, "SubscriptionReference")?.Address;
    this.subscription = validateCameraUrl(
      typeof address === "string" ? address : address?.["#text"],
      this.config,
    ).href;
    this.subscriptionExpires = Date.now() + 50000;
    return true;
  }
  async pull() {
    if (!this.subscription || this.subscriptionExpires < Date.now())
      if (!(await this.subscribe())) return [];
    const r = await this.soap(
      this.subscription,
      "http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest",
      "<tev:PullMessages><tev:Timeout>PT5S</tev:Timeout><tev:MessageLimit>20</tev:MessageLimit></tev:PullMessages>",
    );
    return array(find(r, "NotificationMessage")).flatMap((n) => {
      const topic =
        typeof n.Topic === "string" ? n.Topic : n.Topic?.["#text"] || "";
      const message = n.Message?.Message ?? n.Message;
      const items = array(message?.Data?.SimpleItem);
      const positive = items.some((i) => ["true", "1"].includes(i["@Value"]));
      const observed = message?.["@UtcTime"];
      if (!positive || !observed || !Number.isFinite(Date.parse(observed)))
        return [];
      const rule = (this.config.eventTopics ?? []).find(
        (t) => t.topic === topic,
      );
      if (
        !rule ||
        !["motion", "person"].includes(rule.kind) ||
        (rule.kind === "person" && this.config.personAnalyticsVerified !== true)
      )
        return [];
      return [
        {
          kind: rule.kind,
          observedAt: new Date(observed).toISOString(),
          zoneId: rule.zoneId ?? null,
          confidence: null,
        },
      ];
    });
  }
}
