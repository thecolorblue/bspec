import { expect, test } from "bun:test";
import { pickDefaultModel } from "../../src/lib/default-model.ts";

const haiku35 = { provider: "anthropic", id: "claude-3-5-haiku-20241022" };
const haiku45 = { provider: "anthropic", id: "claude-haiku-4-5-20251001" };
const sonnet45 = { provider: "anthropic", id: "claude-sonnet-4-5" };
const opus45 = { provider: "anthropic", id: "claude-opus-4-5" };
const gpt = { provider: "openai", id: "gpt-4o" };

test("returns undefined when nothing is available", () => {
  expect(pickDefaultModel([])).toBeUndefined();
});

test("skips Pi's deprecated-first ordering for a current haiku", () => {
  // Pi lists the deprecated 3.5 haiku first; the picker must not choose it.
  const chosen = pickDefaultModel([haiku35, haiku45, sonnet45, opus45]);
  expect(chosen).toBe(haiku45);
});

test("falls back to sonnet, then opus, when no current haiku is present", () => {
  expect(pickDefaultModel([haiku35, sonnet45, opus45])).toBe(sonnet45);
  expect(pickDefaultModel([haiku35, opus45])).toBe(opus45);
});

test("never selects the deprecated 3.5 haiku over a current Claude 4 model", () => {
  expect(pickDefaultModel([haiku35, opus45])?.id).not.toBe(haiku35.id);
});

test("falls back to Pi's first model for non-anthropic providers", () => {
  expect(pickDefaultModel([gpt])).toBe(gpt);
});

test("prefers a current anthropic model even when listed after another provider", () => {
  expect(pickDefaultModel([gpt, haiku45])).toBe(haiku45);
});
