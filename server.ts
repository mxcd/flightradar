import index from "./index.html";
import { createAlerts } from "./alerts";
import { POINT_CACHE_MS, TYPE_CACHE_MS, pointKey, pointUrls, typeUrls, upstream } from "./upstream";

const MAX_NM = 250;
// PWA files served as-is next to the bundled page
const STATIC_FILES = ["sw.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];

export function parseQuery(url: URL) {
  const num = (k: string) => {
    const v = url.searchParams.get(k);
    return v === null || v.trim() === "" ? NaN : Number(v);
  };
  const lat = num("lat");
  const lon = num("lon");
  const nm = url.searchParams.has("nm") ? num("nm") : 25;
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || !(nm >= 1 && nm <= MAX_NM)) return null;
  // ~1 km grid: shared cache hits across clients, and the exact location never leaves the box
  return { lat: Number(lat.toFixed(2)), lon: Number(lon.toFixed(2)), nm: Math.round(nm) };
}

export function parseType(url: URL) {
  const t = (url.searchParams.get("t") ?? "").toUpperCase();
  return /^[A-Z0-9]{2,4}$/.test(t) ? t : null;
}

async function respond(key: string, ttl: number, urls: string[]) {
  try {
    const { body, stale } = await upstream(key, ttl, urls);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (stale) headers["x-stale"] = stale;
    return new Response(body, { headers });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}

function aircraft(req: Request) {
  const q = parseQuery(new URL(req.url));
  if (!q) return Response.json({ error: `need lat, lon and optional nm (1-${MAX_NM})` }, { status: 400 });
  return respond(pointKey(q.lat, q.lon, q.nm), POINT_CACHE_MS, pointUrls(q.lat, q.lon, q.nm));
}

function aircraftByType(req: Request) {
  const t = parseType(new URL(req.url));
  if (!t) return Response.json({ error: "need t, an ICAO type designator (2-4 letters/digits)" }, { status: 400 });
  return respond(`type/${t}`, TYPE_CACHE_MS, typeUrls(t));
}

if (import.meta.main) {
  const alerts = createAlerts({ dbPath: process.env.DB_PATH ?? "flightradar.db" });
  alerts.start();
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 3000),
    // no HMR client or error overlay: it reaches phones through the tunnel and swaps code mid-session
    development: false,
    routes: {
      "/": index,
      "/api/aircraft": aircraft,
      "/api/type": aircraftByType,
      "/api/push/key": () => Response.json({ publicKey: alerts.publicKey }),
      "/api/alerts": { PUT: alerts.put },
      ...Object.fromEntries(STATIC_FILES.map((f) => [
        `/${f}`,
        () => new Response(Bun.file(`${import.meta.dir}/${f}`), { headers: { "cache-control": "no-cache" } }),
      ])),
    },
  });
  console.log(`radar on ${server.url}`);
}
