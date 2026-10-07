// Regenerates types.json: ICAO type designator -> [ICAO Doc 8643 description, wake turbulence category],
// e.g. A320 -> ["L2J", "M"] (landplane, 2 engines, jet; medium). Run: just types
// Source: tar1090-db (derived from the Mictronics aircraft database; no licence stated, personal use).
const SOURCE = "https://raw.githubusercontent.com/wiedehopf/tar1090-db/master/db/icao_aircraft_types2.js";

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`${SOURCE}: ${res.status}`);
// served as .js but gzipped JSON: { A320: ["AIRBUS A-320", "L2J", "M"], ... }
const raw: Record<string, [string, string, string]> = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer()))));

const types = Object.fromEntries(
  Object.entries(raw)
    .filter(([, [, desc]]) => /^[LSAHGTBRDVP][0-8C-][JTPERM-]$/.test(desc))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, [, desc, wtc]]) => [type, [desc, wtc]]),
);
await Bun.write(`${import.meta.dir}/../types.json`, JSON.stringify(types));
console.log(`types.json: ${Object.keys(types).length} of ${Object.keys(raw).length} types`);
