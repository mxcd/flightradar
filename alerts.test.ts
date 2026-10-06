import { expect, test } from "bun:test";
import type { Aircraft } from "./aircraft";
import { createAlerts, parseDevice } from "./alerts";

const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA", auth: "tBHItJI5svbpez7KI4CCXg" } };
const home = { filter: "mil", lat: 48.78, lon: 9.18, radius: 10 };

test("parseDevice", () => {
  expect(parseDevice({ subscription, alerts: [home] })).toEqual({ subscription, alerts: [home], units: "imperial" });
  expect(parseDevice({ subscription, alerts: [home], units: "metric" })).toMatchObject({ units: "metric" });
  expect(parseDevice({ subscription, alerts: [home], units: "furlongs" })).toMatchObject({ units: "imperial" });
  expect(parseDevice({ subscription, alerts: [{ ...home, filter: "  beluga " }] })).toMatchObject({ alerts: [{ filter: "beluga" }] });
  // only browser push services: anything else would make the server an HTTP relay
  expect(parseDevice({ subscription: { ...subscription, endpoint: "https://evil.example/x" }, alerts: [] })).toBeString();
  expect(parseDevice({ subscription: { ...subscription, endpoint: "http://fcm.googleapis.com/x" }, alerts: [] })).toBeString();
  expect(parseDevice({ subscription: { ...subscription, endpoint: "https://fcm.googleapis.com.evil.example/x" }, alerts: [] })).toBeString();
  expect(parseDevice({ subscription: { ...subscription, endpoint: "https://web.push.apple.com/x" }, alerts: [] })).toBeObject();
  expect(parseDevice({ subscription: { endpoint: subscription.endpoint }, alerts: [] })).toBeString();
  expect(parseDevice({ subscription, alerts: [{ ...home, radius: 0 }] })).toBeString();
  expect(parseDevice({ subscription, alerts: [{ ...home, lat: "48" }] })).toBeString();
  expect(parseDevice({ subscription, alerts: Array(11).fill(home) })).toBeString();
  expect(parseDevice(null)).toBeString();
});

test("alert fires once when a match enters, not for targets already inside, again after it was gone", async () => {
  let traffic: Aircraft[] = [];
  const sent: string[] = [];
  const titles: string[] = [];
  const alerts = createAlerts({
    dbPath: ":memory:",
    fetchArea: async () => traffic,
    send: async (_sub, payload) => { sent.push(JSON.parse(payload).hex); titles.push(JSON.parse(payload).title); },
  });
  const put = (body: object) => alerts.put(new Request("http://x/api/alerts", { method: "PUT", body: JSON.stringify(body) }));
  expect((await put({ subscription, alerts: [home] })).status).toBe(204);

  const duke = { hex: "ae0001", flight: "DUKE89", t: "BE20", lat: 48.8, lon: 9.2, dbFlags: 1 };
  const far = { hex: "ae0002", flight: "RCH123", t: "C17", lat: 49.5, lon: 9.2, dbFlags: 1 }; // ~43 nm out
  const civil = { hex: "3c6635", flight: "DLH9C", t: "A320", lat: 48.79, lon: 9.19, dbFlags: 0 };

  traffic = [duke];
  await alerts.check(); // first look: duke already inside, learned silently
  expect(sent).toEqual([]);

  const newcomer = { ...duke, hex: "ae0003", flight: "TOPCAT1" };
  traffic = [duke, far, civil, newcomer];
  await alerts.check();
  expect(sent).toEqual(["ae0003"]); // only the military target that entered
  expect(titles).toEqual(["TOPCAT1 within 10 nm"]);

  await alerts.check();
  expect(sent).toEqual(["ae0003"]); // still inside: no repeat

  expect((await put({ subscription, alerts: [] })).status).toBe(204); // removing all alerts drops the device
  await alerts.check();
  expect(sent).toEqual(["ae0003"]);
});

test("expired subscription is removed", async () => {
  let calls = 0;
  const alerts = createAlerts({
    dbPath: ":memory:",
    fetchArea: async () => (calls++ ? [{ hex: "ae0001", lat: 48.78, lon: 9.18, dbFlags: 1 }] : []),
    send: async () => { throw Object.assign(new Error("gone"), { statusCode: 410 }); },
  });
  await alerts.put(new Request("http://x", { method: "PUT", body: JSON.stringify({ subscription, alerts: [home] }) }));
  await alerts.check(); // seeds
  await alerts.check(); // enters -> 410 -> device removed
  await alerts.check(); // nothing left to check
  expect(calls).toBe(2);
});

test("notifications use the device's units; databases from before units get imperial", async () => {
  const { Database } = await import("bun:sqlite");
  const path = `/tmp/flightradar-units-${process.pid}.db`;
  const old = new Database(path);
  old.run("CREATE TABLE devices (endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL, alerts TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  old.run("INSERT INTO devices VALUES (?, ?, ?, 0)", [subscription.endpoint, JSON.stringify(subscription), JSON.stringify([home])]);
  old.close();

  let traffic: Aircraft[] = [];
  const bodies: string[] = [];
  const alerts = createAlerts({ dbPath: path, fetchArea: async () => traffic, send: async (_s, p) => { bodies.push(JSON.parse(p).title + " | " + JSON.parse(p).body); } });
  await alerts.check();
  traffic = [{ hex: "ae0009", flight: "DUKE1", t: "BE20", lat: 48.8, lon: 9.2, dbFlags: 1, alt_baro: 3500 }];
  await alerts.check();
  expect(bodies.at(-1)).toStartWith("DUKE1 within 10 nm | mil · BE20 · 3500 ft · 1.4 nm NE");

  await alerts.put(new Request("http://x", { method: "PUT", body: JSON.stringify({ subscription, alerts: [{ ...home, radius: 10 / 1.852 }], units: "metric" }) }));
  await alerts.check(); // changed rule: first look again
  traffic = [{ hex: "ae0010", flight: "DUKE2", t: "BE20", lat: 48.8, lon: 9.2, dbFlags: 1, alt_baro: 3500 }];
  await alerts.check();
  expect(bodies.at(-1)).toStartWith("DUKE2 within 10 km | mil · BE20 · 1.07 km · 2.7 km NE");
  for (const suffix of ["", "-wal", "-shm"]) await Bun.file(path + suffix).delete().catch(() => {});
});
