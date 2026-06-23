import { expect, test } from "bun:test";
import {
  failureSignature,
  isStuckEvents,
  StuckDetector,
  trimFailureLog,
  type ToolEvent,
} from "../../src/lib/fix/stuck.ts";

test("failureSignature is stable across line/column number changes", () => {
  const a = failureSignature("BUILD", "src/x.ts:10:5 - error TS2322: Type 'string'");
  const b = failureSignature("BUILD", "src/x.ts:42:99 - error TS2322: Type 'string'");
  expect(a).toBe(b);
  expect(a).toHaveLength(12);
});

test("failureSignature distinguishes phases and failure classes", () => {
  const build = failureSignature("BUILD", "error TS2322");
  const test = failureSignature("TEST", "error TS2322");
  const other = failureSignature("BUILD", "error TS1005 expected ';'");
  expect(build).not.toBe(test);
  expect(build).not.toBe(other);
});

test("StuckDetector flags three identical signatures in a row", () => {
  let d = StuckDetector.empty().observe("A");
  expect(d.isStuck()).toBe(false);
  d = d.observe("A");
  expect(d.isStuck()).toBe(false);
  d = d.observe("A");
  expect(d.isStuck()).toBe(true);
});

test("StuckDetector flags an A,B,A,B ping-pong", () => {
  let d = StuckDetector.empty();
  for (const s of ["A", "B", "A", "B", "A", "B"]) d = d.observe(s);
  expect(d.isStuck()).toBe(true);
});

test("StuckDetector resets its window", () => {
  let d = StuckDetector.empty().observe("A").observe("A").observe("A");
  expect(d.isStuck()).toBe(true);
  expect(d.reset().isStuck()).toBe(false);
});

test("StuckDetector does not flag steady progress", () => {
  let d = StuckDetector.empty();
  for (const s of ["A", "B", "C", "D", "E", "F"]) d = d.observe(s);
  expect(d.isStuck()).toBe(false);
});

test("isStuckEvents detects repeated and ping-pong tool actions", () => {
  const rd = (p: string): ToolEvent => ({ toolName: "read", args: { path: p } });
  const ed = (p: string): ToolEvent => ({ toolName: "edit", args: { path: p } });
  expect(isStuckEvents([rd("a"), rd("a"), rd("a"), rd("a"), rd("a"), rd("a")])).toBe(true);
  expect(isStuckEvents([rd("a"), ed("a"), rd("a"), ed("a"), rd("a"), ed("a")])).toBe(true);
  expect(isStuckEvents([rd("a"), ed("b"), rd("c"), ed("d"), rd("e"), ed("f")])).toBe(false);
  expect(isStuckEvents([rd("a"), rd("a")])).toBe(false); // too few to judge
});

test("trimFailureLog hoists the first failing line and bounds length", () => {
  const log = ["info: starting", "compiling…", "error TS2322: bad type", "frame 1"].join("\n");
  expect(trimFailureLog(log, 1000)).toContain("error TS2322");

  const big = `${"x\n".repeat(5000)}error: boom\n${"y\n".repeat(5000)}`;
  const trimmed = trimFailureLog(big, 2000);
  expect(trimmed.length).toBeLessThan(2200);
  expect(trimmed).toContain("error: boom");
});
