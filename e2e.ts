// Browser E2E against live upstream data: bun e2e.ts (needs `bunx playwright install chromium` once)
import { chromium } from "playwright";
import { expect } from "bun:test";

const port = 30000 + Math.floor(Math.random() * 10000);
const server = Bun.spawn(["bun", "server.ts"], { env: { ...process.env, PORT: String(port) }, stdout: "ignore" });
const url = `http://localhost:${port}`;
await Bun.sleep(1500);
const browser = await chromium.launch();
// settings: always shown on desktop, behind ⋮ on touch devices; open it unless visible (idempotent)
const menu = async (p: import("playwright").Page) => {
  if (!(await p.isVisible("#range"))) await p.click("#menu-btn");
};
// #hdg is written by the draw loop, so it lags one animation frame
const hdg = (p: import("playwright").Page, v: string) =>
  p.waitForFunction((v) => document.getElementById("hdg")!.textContent === v, v, { timeout: 2000 });

try {
  // desktop: drag a quarter turn clockwise -> heading 270, persisted across reload
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`${url}/?lat=48.78&lon=9.18`);
  expect(await page.isHidden("#compass")).toBe(true);
  expect(await page.isHidden("#menu-btn")).toBe(true);
  expect(await page.isVisible("#range")).toBe(true);
  const box = (await page.locator("#radar").boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx + 200, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    const a = (i / 10) * Math.PI / 2;
    await page.mouse.move(cx + 200 * Math.cos(a), cy + 200 * Math.sin(a));
  }
  await page.mouse.up();
  await hdg(page, "270");
  await page.reload();
  await hdg(page, "270");
  await menu(page);
  await page.selectOption("#range", "50");
  await page.reload();
  expect(await page.inputValue("#range")).toBe("50");
  // wheel zooms the radar continuously; the preset shows the fetch radius at or above it
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -400); // in: 50 * e^-0.8 ≈ 22.5 nm
  await page.waitForFunction(() => Number(localStorage.range) < 25 && Number(localStorage.range) > 20);
  expect(await page.inputValue("#range")).toBe("25");
  await page.reload();
  expect(await page.inputValue("#range")).toBe("25");
  // lock: dragging no longer rotates, persists across reload
  await menu(page);
  await page.click("#lock");
  const drag90 = async () => {
    await page.mouse.move(cx + 200, cy);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      const a = (i / 10) * Math.PI / 2;
      await page.mouse.move(cx + 200 * Math.cos(a), cy + 200 * Math.sin(a));
    }
    await page.mouse.up();
  };
  await page.reload();
  expect(await page.getAttribute("#lock", "class")).toBe("on");
  await drag90();
  await hdg(page, "270");
  await page.click("#lock");
  await menu(page);
  await page.click("#north");
  await hdg(page, "000");

  // manual coords: rejects junk, accepts Google Maps style, persists
  await page.goto(url);
  for (const bad of ["48.78,", "abc", "91, 9", "1, 2, 3"]) {
    await menu(page);
    await page.fill("#coords", bad);
    await menu(page);
    await page.click("#loc button");
    expect(await page.textContent("#status")).toContain("expected");
  }
  await menu(page);
  await page.fill("#coords", "50.0333 8.5706");
  await menu(page);
  await page.click("#loc button");
  await page.waitForFunction(() => document.getElementById("status")!.textContent!.startsWith("50.033, 8.571"));
  await page.reload();
  expect(await page.inputValue("#coords")).toBe("50.03330, 8.57060");

  // map layer: OSM tiles load, attribution shows, choice persists
  expect(await page.isVisible("#attrib")).toBe(true); // OSM dark is the default
  await menu(page);
  await page.selectOption("#layer", "");
  expect(await page.isHidden("#attrib")).toBe(true);
  await page.reload();
  expect(await page.inputValue("#layer")).toBe("");
  // a fresh area, so the tiles cannot come from cache
  await menu(page);
  await page.fill("#coords", "40.4168, -3.7038");
  await page.click("#loc button");
  const tileLoaded = page.waitForResponse((r) => r.url().startsWith("https://tile.openstreetmap.org/") && r.ok());
  await page.selectOption("#layer", "dark");
  await tileLoaded;
  expect(await page.isVisible("#attrib")).toBe(true);
  await page.reload();
  expect(await page.inputValue("#layer")).toBe("dark");
  expect(await page.getAttribute("#map", "class")).toBe("dark");

  // favourites: save current position under a name, switch back to it, persists, delete
  page.on("dialog", (d) => d.accept("Home"));
await menu(page);
await page.fill("#coords", "48.70000, 9.10000");
  await menu(page);
  await page.click("#loc button");
  await menu(page);
  await page.click("#save-place");
  await menu(page);
  await page.fill("#coords", "52.5, 13.4");
  await menu(page);
  await page.click("#loc button");
  expect(await page.inputValue("#places")).toBe("");
  await menu(page);
  await page.selectOption("#places", { label: "Home" });
  expect(await page.inputValue("#coords")).toBe("48.70000, 9.10000");
  await page.reload();
  expect(await page.inputValue("#places")).toBe("0"); // saved home equals the favourite
  await menu(page);
  await page.click("#del-place");
  expect(await page.$$eval("#places option", (o) => o.length)).toBe(1);

  // filter: a type code from the current list keeps only that type, count shows shown/total
  await page.waitForSelector("#list tr");
  const listed = await page.$$eval("#list tr td:nth-child(2)", (tds) => tds.map((td) => td.textContent!));
  const type = listed.find((t) => /^[A-Z0-9]{3,4}$/.test(t))!;
  await page.fill("#filter", type.toLowerCase());
  const shown = await page.$$eval("#list tr td:nth-child(2)", (tds) => tds.map((td) => td.textContent));
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.every((t) => t!.includes(type))).toBe(true);
  expect(await page.textContent("#count")).toMatch(/^\(\d+\/\d+\)$/);
  await page.fill("#filter", "");

  // beluga: worldwide type lookup (mocked) shows a far match in the list and on the rim
  const typeApi = (u: URL) => u.pathname === "/api/type";
  await page.route(typeApi, (route) => route.fulfill({
    json: { ac: route.request().url().endsWith("A337")
      ? [{ hex: "39cf0a", flight: "BGA110J ", r: "F-GXLJ", t: "A337", lat: 45.26, lon: 7.46, alt_baro: 34000 }]
      : [] },
  }));
  await menu(page);
  await page.fill("#coords", "48.78, 9.18");
  await menu(page);
  await page.click("#loc button");
  await page.fill("#filter", "beluga");
  await page.waitForSelector("#list tr[data-hex='39cf0a']");
  const row = await page.textContent("#list tr[data-hex='39cf0a']");
  expect(row).toContain("BGA110J");
  expect(row).toMatch(/2[12]\d\.\d nm/); // Stuttgart -> near Turin
  await page.screenshot({ path: "/tmp/radar-beluga.png" });
  await page.fill("#filter", "");
  await page.unroute(typeApi);

  // mil: only airframes flagged military in dbFlags
  await page.route((u) => u.pathname === "/api/aircraft", (route) => route.fulfill({
    json: { ac: [
      { hex: "ae1234", flight: "DUKE89  ", t: "BE20", lat: 48.8, lon: 9.2, dbFlags: 1 },
      { hex: "3c6635", flight: "DLH9C   ", t: "A320", lat: 48.7, lon: 9.1, dbFlags: 8 },
    ] },
  }));
  await page.reload();
  await page.fill("#filter", "mil");
  await page.waitForFunction(() => document.querySelectorAll("#list tr").length === 1);
  expect(await page.textContent("#list tr")).toContain("DUKE89");
  await page.fill("#filter", "");

  // mobile: compass button, device facing east -> heading 090
  const mobile = await browser.newContext({
    viewport: { width: 400, height: 800 }, isMobile: true, hasTouch: true,
    permissions: ["accelerometer", "gyroscope", "magnetometer"],
  });
  const m = await mobile.newPage();
  await m.goto(`${url}/?lat=48.78&lon=9.18`);
  expect(await m.isVisible("#menu-btn")).toBe(true);
  expect(await m.isHidden("#range")).toBe(true);
  await menu(m);
  await m.click("#compass");
  await m.waitForSelector("#compass.on");
  await m.evaluate(() => {
    for (let i = 0; i < 60; i++) dispatchEvent(new DeviceOrientationEvent("deviceorientationabsolute", { alpha: 270, absolute: true }));
  });
  await hdg(m, "090");
  // pinch: two real touch points spreading apart zoom in (CDP touch, so pointer capture works)
  await m.evaluate(() => { localStorage.range = "100"; });
  await m.reload();
  const cdp = await mobile.newCDPSession(m);
  const mb = (await m.locator("#radar").boundingBox())!;
  const mx = mb.x + mb.width / 2, my = mb.y + mb.height / 2;
  const touch = (type: string, d: number) => cdp.send("Input.dispatchTouchEvent", {
    type, touchPoints: type === "touchEnd" ? [] : [{ x: mx - d, y: my, id: 1 }, { x: mx + d, y: my, id: 2 }],
  });
  await touch("touchStart", 20);
  for (const d of [30, 40, 60, 80]) await touch("touchMove", d);
  await touch("touchEnd", 0);
  expect(Number(await m.evaluate(() => localStorage.range))).toBeCloseTo(25, 0); // spread x4 -> range / 4

  // orientation: phone portrait stacks the list under the radar, landscape puts it beside
  await m.setViewportSize({ width: 800, height: 400 });
  await m.waitForFunction(() => getComputedStyle(document.body).flexDirection === "row");
  await m.setViewportSize({ width: 400, height: 800 });
  await m.waitForFunction(() => getComputedStyle(document.body).flexDirection === "column");
  // radar canvas backing store follows the element after the flip
  await m.waitForFunction(() => {
    const c = document.getElementById("radar") as HTMLCanvasElement;
    return Math.abs(c.width - c.clientWidth * devicePixelRatio) < 2;
  });

  console.log("e2e ok");
} finally {
  await browser.close();
  server.kill();
}
