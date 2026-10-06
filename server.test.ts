import { expect, test } from "bun:test";
import { parseQuery, parseType } from "./server";

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
