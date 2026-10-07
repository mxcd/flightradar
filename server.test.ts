import { expect, test } from "bun:test";
import { parseQuery, parseType } from "./server";
import { globalTypes, matcher } from "./aircraft";

const q = (s: string) => parseQuery(new URL(`http://x/api/aircraft?${s}`));

test("parseQuery", () => {
  expect(q("lat=48.7812&lon=9.1834")).toEqual({ lat: 48.78, lon: 9.18, nm: 25 });
  expect(q("lat=48.78&lon=9.18&nm=50.4")).toEqual({ lat: 48.78, lon: 9.18, nm: 50 });
  expect(q("lon=9.18")).toBeNull();
  expect(q("lat=&lon=9.18")).toBeNull();
  expect(q("lat=91&lon=9")).toBeNull();
  expect(q("lat=48&lon=abc")).toBeNull();
  expect(q("lat=48&lon=9&nm=0")).toBeNull();
  expect(q("lat=48&lon=9&nm=251")).toBeNull();
});

test("parseType", () => {
  const t = (s: string) => parseType(new URL(`http://x/api/type?${s}`));
  expect(t("t=a3st")).toBe("A3ST");
  expect(t("t=A337")).toBe("A337");
  expect(t("t=")).toBeNull();
  expect(t("t=A3STX")).toBeNull();
  expect(t("t=../x")).toBeNull();
  expect(t("")).toBeNull();
});

test("matcher", () => {
  const m = (f: string, a: object) => matcher(f)({ hex: "abc", ...a });
  expect(m("", {})).toBe(true);
  expect(m("beluga", { t: "A337" })).toBe(true);
  expect(m("beluga", { t: "A320" })).toBe(false);
  expect(m("mil", { dbFlags: 1 })).toBe(true);
  expect(m("mil", { dbFlags: 8 })).toBe(false);
  expect(m("dlh a33", { flight: "DLH9C   " })).toBe(true);
  expect(m("a33", { t: "A333" })).toBe(true);
  expect(globalTypes("beluga dlh a33 b748")).toEqual(["a3st", "a337", "a33", "b748"]); // a33: partial code, lookup returns nothing; dlh: no digit, no lookup
});

test("unit formatting", async () => {
  const { altText, climbText, distText, speedText } = await import("./aircraft");
  const a = (alt_baro: number | "ground") => ({ hex: "x", alt_baro });
  expect(altText(a(3500))).toBe("3500 ft");
  expect(altText(a(34000))).toBe("FL340");
  expect(altText(a(3500), "metric")).toBe("1067 m");
  expect(altText(a(3000), "metric")).toBe("914 m");
  expect(altText(a(35000), "metric")).toBe("10668 m"); // never km
  expect(altText(a("ground"), "metric")).toBe("GND");
  expect(speedText(450, "metric")).toBe("833 km/h");
  expect(speedText(450, "imperial")).toBe("450 kt");
  expect(climbText(-1600, "metric")).toBe("-8.1 m/s");
  expect(climbText(undefined, "metric")).toBe("-");
  expect(distText(10, "metric")).toBe("18.5 km");
  expect(distText(5.4, "imperial", 0)).toBe("5 nm");
});

test("classify", async () => {
  const { classify, matcher } = await import("./aircraft");
  const c = (a: object) => classify({ hex: "x", ...a });
  expect(c({ t: "A388" })).toBe("heavy");
  expect(c({ t: "A3ST" })).toBe("heavy"); // beluga: L2J, wake H
  expect(c({ t: "A320" })).toBe("airliner");
  expect(c({ t: "E55P", category: "A2" })).toBe("bizjet");
  expect(c({ t: "C25A" })).toBe("bizjet"); // wake L
  expect(c({ t: "EUFI" })).toBe("fighter");
  expect(c({ t: "A320", category: "A6" })).toBe("fighter");
  expect(c({ t: "BE20" })).toBe("turboprop");
  expect(c({ t: "V22" })).toBe("turboprop");
  expect(c({ t: "C172" })).toBe("single");
  expect(c({ t: "PA34" })).toBe("twin");
  expect(c({ t: "EC35" })).toBe("heli");
  expect(c({ t: "GLID" })).toBe("glider");
  expect(c({ t: "BALL" })).toBe("balloon");
  expect(c({ category: "C2" })).toBe("ground");
  expect(c({ category: "A7" })).toBe("heli"); // no type: transponder category
  expect(c({ category: "A5" })).toBe("heavy");
  expect(c({})).toBe("unknown");
  expect(matcher("heli")({ hex: "x", t: "EC35" })).toBe(true);
  expect(matcher("jet")({ hex: "x", t: "C172" })).toBe(false);
  expect(matcher("prop")({ hex: "x", t: "C172" })).toBe(true);
});
