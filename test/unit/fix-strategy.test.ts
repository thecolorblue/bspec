import { expect, test } from "bun:test";
import {
  isLadderExhausted,
  LADDER,
  pickAlternativeModel,
  strategyAt,
} from "../../src/lib/fix/strategy.ts";

test("the ladder escalates diagnose → minimal → fresh-start(restore) → switch-model", () => {
  expect(LADDER.map((r) => r.name)).toEqual([
    "force-diagnose",
    "minimal-fix",
    "fresh-start",
    "switch-model",
  ]);
  expect(strategyAt(2).restoreCheckpoint).toBe(true);
  expect(strategyAt(3).switchModel).toBe(true);
});

test("isLadderExhausted is true once the index passes the last rung", () => {
  expect(isLadderExhausted(3)).toBe(false);
  expect(isLadderExhausted(4)).toBe(true);
});

test("strategyAt clamps out-of-range indices to the last rung", () => {
  expect(strategyAt(99).name).toBe("switch-model");
  expect(strategyAt(0).name).toBe("force-diagnose");
});

test("pickAlternativeModel returns a model other than the current selector", () => {
  const available = [
    { provider: "anthropic", id: "claude-haiku-4-5" },
    { provider: "anthropic", id: "claude-opus-4-8" },
  ];
  expect(pickAlternativeModel("anthropic/claude-haiku-4-5", available)).toEqual({
    provider: "anthropic",
    id: "claude-opus-4-8",
  });
});

test("pickAlternativeModel returns undefined when no alternative exists", () => {
  const only = [{ provider: "anthropic", id: "claude-opus-4-8" }];
  expect(pickAlternativeModel("anthropic/claude-opus-4-8", only)).toBeUndefined();
  expect(pickAlternativeModel("anthropic/claude-opus-4-8", [])).toBeUndefined();
});

test("pickAlternativeModel skips already-tried models", () => {
  const available = [
    { provider: "anthropic", id: "claude-haiku-4-5" },
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { provider: "anthropic", id: "claude-opus-4-8" },
  ];
  // Current is haiku; sonnet was already tried → opus is the only fresh option.
  expect(
    pickAlternativeModel("anthropic/claude-haiku-4-5", available, ["anthropic/claude-sonnet-4-6"]),
  ).toEqual({ provider: "anthropic", id: "claude-opus-4-8" });

  // Every alternative already tried → none left, so the controller escalates.
  expect(
    pickAlternativeModel("anthropic/claude-haiku-4-5", available, [
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-8",
    ]),
  ).toBeUndefined();
});
