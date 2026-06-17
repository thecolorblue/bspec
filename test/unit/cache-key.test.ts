import { expect, test } from "bun:test";
import { computeCacheKey } from "../../src/lib/cache-key.ts";

const base = {
  id: "hello-extension",
  version: "0.1.0",
  params: {} as Record<string, unknown>,
  needsHashes: [] as string[],
};

test("cache key is stable for the same inputs", () => {
  expect(computeCacheKey(base)).toBe(computeCacheKey({ ...base }));
});

test("cache key is stable regardless of param key order", () => {
  const a = computeCacheKey({ ...base, params: { x: 1, y: 2 } });
  const b = computeCacheKey({ ...base, params: { y: 2, x: 1 } });
  expect(a).toBe(b);
});

test("cache key changes when the block version changes", () => {
  const a = computeCacheKey(base);
  const b = computeCacheKey({ ...base, version: "0.2.0" });
  expect(a).not.toBe(b);
});

test("cache key changes when params change", () => {
  const a = computeCacheKey(base);
  const b = computeCacheKey({ ...base, params: { foo: "bar" } });
  expect(a).not.toBe(b);
});
