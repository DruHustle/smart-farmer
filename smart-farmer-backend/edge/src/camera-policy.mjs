/** Enforce the last authorised capture schedule locally, including during WAN loss. */
export function cameraEventPermitted(policy, event) {
  if (!policy?.eventsEnabled || !policy.capabilities?.[event.kind])
    return false;
  if (policy.zones?.length && !policy.zones.some((z) => z.id === event.zoneId))
    return false;
  if (!policy.schedules?.length) return true;
  if (!policy.timezone || !Number.isFinite(Date.parse(event.observedAt)))
    return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: policy.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(event.observedAt));
  const get = (key) => parts.find((p) => p.type === key)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      get("weekday"),
    ),
    clock = get("hour") + ":" + get("minute");
  return policy.schedules.some((s) =>
    s.start === s.end
      ? s.days.includes(day)
      : s.start < s.end
        ? s.days.includes(day) && clock >= s.start && clock < s.end
        : (s.days.includes(day) && clock >= s.start) ||
          (s.days.includes((day + 6) % 7) && clock < s.end),
  );
}
