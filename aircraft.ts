// Aircraft helpers shared by the page and the server (alerts), so both read "mil" or "beluga" alike.

// the readsb fields this app reads
export type Aircraft = {
  hex: string;
  flight?: string;
  r?: string;
  t?: string;
  desc?: string;
  dbFlags?: number;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  gs?: number;
  track?: number;
};

// names people search for -> ICAO type designators
export const ALIASES: Record<string, string> = {
  beluga: "A3ST A337", // A300-600ST Beluga, A330-743L BelugaXL
  a380: "A388",
  "747": "B741 B742 B743 B744 B748 B74S",
  dreamliner: "B788 B789 B78X",
  concorde: "CONC",
};

const words = (text: string) => text.toLowerCase().split(/[\s,]+/).filter(Boolean);

export const filterTerms = (text: string) => words(text).flatMap((t) => (ALIASES[t] ?? t).toLowerCase().split(" "));

// terms that look like a full ICAO type designator (A3ST, B748, C172) get a worldwide lookup;
// a digit is required so airline prefixes like DLH don't trigger one, aliases (CONC) always do
export function globalTypes(text: string) {
  const fromAlias = words(text).flatMap((t) => ALIASES[t]?.toLowerCase().split(" ") ?? []);
  return [...new Set(filterTerms(text).filter((t) => fromAlias.includes(t) || /^(?=.*\d)[a-z0-9]{3,4}$/.test(t)))];
}

// filter text -> predicate: any term is a substring of callsign, registration, type or description;
// "mil" matches airframes the readsb database flags as military (dbFlags bit 0)
export function matcher(text: string): (a: Aircraft) => boolean {
  const terms = filterTerms(text);
  if (!terms.length) return () => true;
  return (a) => {
    const hay = [a.flight, a.r, a.t, a.desc].filter(Boolean).join(" ").toLowerCase();
    return terms.some((t) => (t === "mil" ? ((a.dbFlags ?? 0) & 1) === 1 : hay.includes(t)));
  };
}

export const callsign = (a: Aircraft) => (a.flight ?? "").trim() || a.r || a.hex.toUpperCase();

export const altText = (a: Aircraft) =>
  a.alt_baro === "ground" ? "GND" : a.alt_baro == null ? "-" : a.alt_baro >= 10000 ? `FL${Math.round(a.alt_baro / 100)}` : `${a.alt_baro} ft`;

// distance (nm) and bearing (degrees true) from a point to an aircraft
// ponytail: flat-earth projection, a few % off beyond ~300 nm
export function relative(from: { lat: number; lon: number }, a: { lat: number; lon: number }) {
  const east = ((((a.lon - from.lon + 180) % 360) + 360) % 360 - 180) * 60 * Math.cos((from.lat * Math.PI) / 180);
  const north = (a.lat - from.lat) * 60;
  return { dist: Math.hypot(east, north), bearing: ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360 };
}
