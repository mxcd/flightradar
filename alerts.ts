import { Database } from "bun:sqlite";
import webpush from "web-push";
import { type Aircraft, type Units, altText, callsign, distText, matcher, relative } from "./aircraft";
import { POINT_CACHE_MS, pointKey, pointUrls, upstream } from "./upstream";

// Alerts: "a target matching <filter> comes within <radius> nm of <point>", delivered as Web Push so they
// arrive with the app closed. Rules and push subscriptions live in SQLite; the page re-sends its rules on
// every open, so the DB is the copy that survives restarts, not the only one.

const CHECK_MS = 30_000;
// a target unseen inside the radius this long counts as gone, so a later return alerts again;
// also stops in/out flapping at the boundary from re-alerting
const FORGET_MS = 5 * 60_000;
const MAX_ALERTS = 10; // per device
const MAX_DEVICES = 100;
// distinct areas fetched per check; at 30 s that stays well under adsb.fi's 1 req/s alongside live clients
// ponytail: alerts beyond this many areas are silently skipped that round; a queue if this ever fills up
const MAX_AREAS = 25;
// the page's range presets, so alert areas hit the same cache entries as people watching the radar
const PRESETS = [10, 25, 50, 100, 250];
// browser push services; any other endpoint would turn the server into an open HTTP relay
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "push.apple.com", "notify.windows.com"];
const DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export type Alert = { filter: string; lat: number; lon: number; radius: number };
type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };

export type AlertsOptions = {
  dbPath: string;
  // defaults: the shared upstream cache and web-push; replaced in tests
  fetchArea?: (lat: number, lon: number, nm: number) => Promise<Aircraft[] | null>;
  send?: (subscription: Subscription, payload: string) => Promise<unknown>;
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isKey = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{8,200}={0,2}$/.test(v);

// PUT /api/alerts body -> device, or the reason it was rejected
export function parseDevice(body: any): { subscription: Subscription; alerts: Alert[]; units: Units } | string {
  const sub = body?.subscription;
  let host = "";
  try {
    const url = new URL(sub?.endpoint);
    if (url.protocol === "https:") host = url.hostname;
  } catch {}
  if (!PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return "subscription.endpoint must be a browser push service";
  if (!isKey(sub.keys?.p256dh) || !isKey(sub.keys?.auth)) return "subscription.keys missing";
  if (!Array.isArray(body.alerts) || body.alerts.length > MAX_ALERTS) return `alerts must be a list of at most ${MAX_ALERTS}`;

  const alerts: Alert[] = [];
  for (const a of body.alerts) {
    // an empty filter is allowed: anything that comes close
    if (typeof a?.filter !== "string" || a.filter.length > 100) return "alert.filter must be text up to 100 characters";
    if (!isNum(a.lat) || !isNum(a.lon) || !isNum(a.radius) || Math.abs(a.lat) > 90 || Math.abs(a.lon) > 180 || a.radius < 1 || a.radius > 250) {
      return "alert needs lat, lon and radius (1-250 nm)";
    }
    alerts.push({ filter: a.filter.trim(), lat: a.lat, lon: a.lon, radius: a.radius });
  }
  const units: Units = body.units === "metric" ? "metric" : "imperial";
  return { subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, alerts, units };
}

export function createAlerts(options: AlertsOptions) {
  const db = new Database(options.dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run(`CREATE TABLE IF NOT EXISTS devices (
    endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL, alerts TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  // added in v0.3.0; databases from before get the column with the old behaviour as default
  if (!db.query("SELECT 1 FROM pragma_table_info('devices') WHERE name = 'units'").get()) {
    db.run("ALTER TABLE devices ADD COLUMN units TEXT NOT NULL DEFAULT 'imperial'");
  }

  // VAPID keys are generated once and stored next to the subscriptions they sign for: lose one, lose both
  let row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'vapid'").get();
  if (!row) {
    row = { value: JSON.stringify(webpush.generateVAPIDKeys()) };
    db.run("INSERT INTO meta (key, value) VALUES ('vapid', ?)", [row.value]);
  }
  const vapid: { publicKey: string; privateKey: string } = JSON.parse(row.value);
  const vapidDetails = { subject: process.env.VAPID_SUBJECT ?? "https://github.com/mxcd/flightradar", ...vapid };

  const send = options.send ?? ((subscription, payload) =>
    webpush.sendNotification(subscription, payload, { TTL: 300, urgency: "high", vapidDetails }));
  const fetchArea = options.fetchArea ?? (async (lat, lon, nm) => {
    const { body, stale } = await upstream(pointKey(lat, lon, nm), POINT_CACHE_MS, pointUrls(lat, lon, nm));
    return stale ? null : JSON.parse(body).ac ?? []; // old positions would raise old news
  });

  const removeDevice = (endpoint: string) => db.run("DELETE FROM devices WHERE endpoint = ?", [endpoint]);

  async function put(req: Request) {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const device = parseDevice(body);
    if (typeof device === "string") return Response.json({ error: device }, { status: 400 });

    const { endpoint } = device.subscription;
    if (!device.alerts.length) {
      removeDevice(endpoint);
      return new Response(null, { status: 204 });
    }
    const known = db.query("SELECT 1 FROM devices WHERE endpoint = ?").get(endpoint);
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM devices").get()!.n;
    if (!known && count >= MAX_DEVICES) return Response.json({ error: "alert capacity reached" }, { status: 503 });

    db.run(
      `INSERT INTO devices (endpoint, subscription, alerts, units, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         subscription = excluded.subscription, alerts = excluded.alerts, units = excluded.units, updated_at = excluded.updated_at`,
      [endpoint, JSON.stringify(device.subscription), JSON.stringify(device.alerts), device.units, Date.now()],
    );
    return new Response(null, { status: 204 });
  }

  // false when the push service says the subscription is gone, which also removes the device
  async function notify(subscription: Subscription, units: Units, alert: Alert, a: Aircraft, dist: number, bearing: number) {
    const payload = JSON.stringify({
      title: `${callsign(a)} within ${distText(alert.radius, units, 0)}`,
      body: `${alert.filter || "any"} · ${a.desc ?? a.t ?? "?"} · ${altText(a, units)} · ${distText(dist, units)} ${DIRECTIONS[Math.round(bearing / 45) % 8]}`,
      hex: a.hex,
    });
    try {
      await send(subscription, payload);
      return true;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        removeDevice(subscription.endpoint);
        return false;
      }
      console.error(`push to ${new URL(subscription.endpoint).host} failed: ${e?.statusCode ?? e}`);
      return true;
    }
  }

  // per alert (device + rule): hex -> last time seen inside the radius
  const inside = new Map<string, Map<string, number>>();

  async function check() {
    const devices = db.query<{ subscription: string; alerts: string; units: Units }, []>("SELECT subscription, alerts, units FROM devices").all();
    const areas = new Map<string, Promise<Aircraft[] | null>>();
    // fetch centre snaps to the page's ~1 km grid, so the radius grows by 1 nm to still cover the alert circle
    const area = (alert: Alert) => {
      const lat = Number(alert.lat.toFixed(2)), lon = Number(alert.lon.toFixed(2));
      const nm = PRESETS.find((p) => p >= alert.radius + 1) ?? 250;
      const key = `${lat}/${lon}/${nm}`;
      if (!areas.has(key)) {
        if (areas.size >= MAX_AREAS) return Promise.resolve(null);
        areas.set(key, fetchArea(lat, lon, nm).catch(() => null));
      }
      return areas.get(key)!;
    };

    const now = Date.now();
    const live = new Set<string>();
    for (const device of devices) {
      const subscription: Subscription = JSON.parse(device.subscription);
      let reachable = true;
      for (const alert of JSON.parse(device.alerts) as Alert[]) {
        const key = `${subscription.endpoint} ${JSON.stringify(alert)}`;
        live.add(key);
        const aircraft = await area(alert);
        if (!aircraft || !reachable) continue;

        const seen = inside.get(key);
        const state = seen ?? new Map<string, number>();
        const match = matcher(alert.filter);
        for (const a of aircraft) {
          if (a.lat == null || a.lon == null || !match(a)) continue;
          const { dist, bearing } = relative(alert, { lat: a.lat, lon: a.lon });
          if (dist > alert.radius) continue;
          // the first check of an alert (new, or after a restart) only learns who is already inside
          if (seen && !state.has(a.hex) && reachable) reachable = await notify(subscription, device.units, alert, a, dist, bearing);
          state.set(a.hex, now);
        }
        for (const [hex, at] of state) if (now - at > FORGET_MS) state.delete(hex);
        inside.set(key, state);
      }
    }
    for (const key of inside.keys()) if (!live.has(key)) inside.delete(key);
  }

  let running = false;
  return {
    publicKey: vapid.publicKey,
    put,
    check,
    start() {
      setInterval(async () => {
        if (running) return; // a slow upstream must not stack checks
        running = true;
        try {
          await check();
        } catch (e) {
          console.error("alert check failed:", e);
        } finally {
          running = false;
        }
      }, CHECK_MS);
    },
  };
}
