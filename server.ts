import index from "./index.html";

// Both return readsb JSON ({ ac: [...] }) and send no CORS headers, hence this proxy.
// adsb.fi documents 1 req/s per IP; adsb.lol has an undocumented, tighter per-IP limit (429s at ~0.3 req/s).
const POINT_UPSTREAMS = [
  (lat: number, lon: number, nm: number) => `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${nm}`,
  (lat: number, lon: number, nm: number) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`,
];
// worldwide search by ICAO type; adsb.fi has no equivalent
const TYPE_UPSTREAM = (type: string) => `https://api.adsb.lol/v2/type/${type}`;
const POINT_CACHE_MS = 4000;
const TYPE_CACHE_MS = 30_000;
const MAX_NM = 250;

const cache = new Map<string, { expires: number; body: Promise<string> }>();
// last good body per key, served when every upstream fails (rate limit, outage)
// ponytail: unbounded, one entry per distinct lat/lon/range or type; fine for a home radar
const lastGood = new Map<string, string>();

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

async function fetchFirst(urls: string[]) {
  const errors: string[] = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return await res.text();
      errors.push(`${new URL(url).host} ${res.status}`);
    } catch (e) {
      errors.push(`${new URL(url).host} ${e}`);
    }
  }
  throw new Error(errors.join(", "));
}

// one upstream fetch per key and TTL, shared by all clients; failures stay cached for the TTL as backoff
async function cached(key: string, ttl: number, urls: string[]) {
  const now = Date.now();
  for (const [k, v] of cache) if (now > v.expires) cache.delete(k);

  let entry = cache.get(key);
  if (!entry) {
    entry = { expires: now + ttl, body: fetchFirst(urls) };
    cache.set(key, entry);
  }
  try {
    const body = await entry.body;
    lastGood.set(key, body);
    return new Response(body, { headers: { "content-type": "application/json" } });
  } catch (e) {
    const stale = lastGood.get(key);
    if (stale) return new Response(stale, { headers: { "content-type": "application/json", "x-stale": String(e) } });
    return Response.json({ error: String(e) }, { status: 502 });
  }
}

function aircraft(req: Request) {
  const q = parseQuery(new URL(req.url));
  if (!q) return Response.json({ error: `need lat, lon and optional nm (1-${MAX_NM})` }, { status: 400 });
  return cached(`point/${q.lat}/${q.lon}/${q.nm}`, POINT_CACHE_MS, POINT_UPSTREAMS.map((u) => u(q.lat, q.lon, q.nm)));
}

function aircraftByType(req: Request) {
  const t = parseType(new URL(req.url));
  if (!t) return Response.json({ error: "need t, an ICAO type designator (2-4 letters/digits)" }, { status: 400 });
  return cached(`type/${t}`, TYPE_CACHE_MS, [TYPE_UPSTREAM(t)]);
}

if (import.meta.main) {
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 3000),
    // no HMR client or error overlay: it reaches phones through the tunnel and swaps code mid-session
    development: false,
    routes: { "/": index, "/api/aircraft": aircraft, "/api/type": aircraftByType },
  });
  console.log(`radar on ${server.url}`);
}
