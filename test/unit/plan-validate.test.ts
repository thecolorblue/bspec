import { expect, test } from "bun:test";
import {
  checkRegistry,
  extractJsonObject,
  validateRawOutput,
} from "../../src/lib/plan-validate.ts";
import type { BlockMenuEntry } from "../../src/lib/planner.ts";

const MENU: BlockMenuEntry[] = [
  {
    id: "greeting-page",
    version: "1.0.0",
    summary: "A greeting page.",
    params: {
      title: { type: "string", required: true },
      message: { type: "string", required: false },
      theme: { type: "enum", required: false, enum: ["light", "dark"] },
      count: { type: "number", required: false },
    },
    produces: ["index.html"],
  },
];

const validStep = {
  id: "greeting-page",
  version: "1.0.0",
  summary: "Building your greeting page",
  params: { title: "Tab Saver" },
  needs: [],
};

const validJson = JSON.stringify({ steps: [validStep], gaps: [], questions: [] });

test("extractJsonObject strips a ```json code fence", () => {
  const raw = "```json\n" + validJson + "\n```";
  expect(extractJsonObject(raw)).toBe(validJson);
});

test("extractJsonObject finds the object amid surrounding prose", () => {
  const raw = `Here is the plan:\n${validJson}\nHope that helps!`;
  expect(extractJsonObject(raw)).toBe(validJson);
});

test("extractJsonObject ignores braces inside strings", () => {
  const obj = '{"steps":[],"gaps":[{"feature":"a {weird} thing","reason":"x"}],"questions":[]}';
  expect(extractJsonObject("noise " + obj + " trailing")).toBe(obj);
});

test("extractJsonObject returns null when there is no object", () => {
  expect(extractJsonObject("no json here")).toBeNull();
});

test("validateRawOutput accepts a valid, registry-matching plan", () => {
  const result = validateRawOutput(validJson, MENU);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.output.steps[0].params.title).toBe("Tab Saver");
});

test("validateRawOutput strips fences then validates", () => {
  const result = validateRawOutput("```\n" + validJson + "\n```", MENU);
  expect(result.ok).toBe(true);
});

test("validateRawOutput rejects a hallucinated block id", () => {
  const raw = JSON.stringify({
    steps: [{ ...validStep, id: "made-up-block" }],
  });
  const result = validateRawOutput(raw, MENU);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.message).toContain("made-up-block@1.0.0");
    expect(result.message).toContain("isn't installed");
    expect(result.message).toContain("greeting-page@1.0.0");
  }
});

test("validateRawOutput rejects a version mismatch", () => {
  const raw = JSON.stringify({ steps: [{ ...validStep, version: "9.9.9" }] });
  const result = validateRawOutput(raw, MENU);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain("installed version is 1.0.0");
});

test("validateRawOutput rejects a missing required param", () => {
  const raw = JSON.stringify({ steps: [{ ...validStep, params: {} }] });
  const result = validateRawOutput(raw, MENU);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain('requires "title"');
});

test("validateRawOutput rejects an unknown param", () => {
  const raw = JSON.stringify({
    steps: [{ ...validStep, params: { title: "x", nope: "y" } }],
  });
  const result = validateRawOutput(raw, MENU);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain("doesn't accept it");
});

test("validateRawOutput rejects a wrong-typed param", () => {
  const raw = JSON.stringify({
    steps: [{ ...validStep, params: { title: "x", count: "not-a-number" } }],
  });
  const result = validateRawOutput(raw, MENU);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain("expected number");
});

test("validateRawOutput rejects an out-of-range enum value", () => {
  const raw = JSON.stringify({
    steps: [{ ...validStep, params: { title: "x", theme: "neon" } }],
  });
  const result = validateRawOutput(raw, MENU);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.message).toContain("not one of");
    expect(result.message).toContain('"light"');
  }
});

test("validateRawOutput rejects non-empty needs (v1 is linear)", () => {
  const raw = JSON.stringify({ steps: [{ ...validStep, needs: ["other"] }] });
  const result = validateRawOutput(raw, MENU);
  expect(result.ok).toBe(false);
});

test("validateRawOutput rejects a step missing summary", () => {
  const raw = JSON.stringify({
    steps: [{ id: "greeting-page", version: "1.0.0", params: { title: "x" } }],
  });
  const result = validateRawOutput(raw, MENU);
  expect(result.ok).toBe(false);
});

test("validateRawOutput reports non-JSON output clearly", () => {
  const result = validateRawOutput("I cannot help with that.", MENU);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain("did not return a JSON object");
});

test("checkRegistry passes a valid output and reports the first gap-free error", () => {
  const ok = validateRawOutput(validJson, MENU);
  expect(ok.ok).toBe(true);
  if (ok.ok) expect(checkRegistry(ok.output, MENU)).toBeNull();
});
