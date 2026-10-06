import { expect, test } from "bun:test";
import type { Aircraft } from "./aircraft";
import { createAlerts, parseDevice } from "./alerts";

const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA", auth: "tBHItJI5svbpez7KI4CCXg" } };
const home = { filter: "mil", lat: 48.78, lon: 9.18, radius: 10 };

test("parseDevice", () => {
  expect(parseDevice({ subscription, alerts: [home] })).toEqual({ subscription, alerts: [home] });
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
  const alerts = createAlerts({
    dbPath: ":memory:",
    fetchArea: async () => traffic,
    send: async (_sub, payload) => { sent.push(JSON.parse(payload).hex); },
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
