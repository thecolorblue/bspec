import { expect, test } from "bun:test";
import { stableStringify } from "../../src/lib/json-stable.ts";

test("stable JSON normalization returns the same string for reordered keys", () => {
  const a = { b: 1, a: 2, c: { z: 9, y: 8 } };
  const b = { c: { y: 8, z: 9 }, a: 2, b: 1 };
  expect(stableStringify(a)).toBe(stableStringify(b));
});

test("stable JSON preserves array order", () => {
  expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
});

test("stable JSON handles empty params", () => {
  expect(stableStringify({})).toBe("{}");
});
