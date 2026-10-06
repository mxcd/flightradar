// Cached access to the ADS-B feeds, shared by page requests and the alert checker.
// Both feeds return readsb JSON ({ ac: [...] }) and send no CORS headers, hence the proxy.
// adsb.fi documents 1 req/s per IP; adsb.lol has an undocumented, tighter per-IP limit (429s at ~0.3 req/s).

export const POINT_CACHE_MS = 4000;
export const TYPE_CACHE_MS = 30_000;

export const pointUrls = (lat: number, lon: number, nm: number) => [
  `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${nm}`,
  `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`,
];
// worldwide search by ICAO type; adsb.fi has no equivalent
export const typeUrls = (type: string) => [`https://api.adsb.lol/v2/type/${type}`];

const cache = new Map<string, { expires: number; body: Promise<string> }>();
// last good body per key, served when every upstream fails (rate limit, outage)
// ponytail: unbounded, one entry per distinct lat/lon/range or type; fine for a home radar
const lastGood = new Map<string, string>();

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

// one upstream fetch per key and TTL, shared by all callers; failures stay cached for the TTL as backoff.
// stale is set when every upstream failed and the last good body stands in; throws when there is none.
export async function upstream(key: string, ttl: number, urls: string[]): Promise<{ body: string; stale?: string }> {
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
    return { body };
  } catch (e) {
    const stale = lastGood.get(key);
    if (stale) return { body: stale, stale: String(e) };
    throw e;
  }
}

export const pointKey = (lat: number, lon: number, nm: number) => `point/${lat}/${lon}/${nm}`;
