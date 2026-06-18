import { expect, test } from "bun:test";
import {
  manifestSchema,
  paramSpecSchema,
  planSchema,
  plannerOutputSchema,
} from "../../src/lib/schemas.ts";

test("paramSpecSchema accepts scalar types and defaults required to false", () => {
  const parsed = paramSpecSchema.parse({ type: "string" });
  expect(parsed.required).toBe(false);
  for (const type of ["number", "boolean"] as const) {
    expect(paramSpecSchema.parse({ type }).type).toBe(type);
  }
});

test("paramSpecSchema requires enum values when type is enum", () => {
  expect(paramSpecSchema.safeParse({ type: "enum" }).success).toBe(false);
  expect(paramSpecSchema.safeParse({ type: "enum", enum: ["a", "b"] }).success).toBe(true);
});

test("manifest params accepts empty {} (v0 blocks) and a populated schema", () => {
  const empty = manifestSchema.parse({
    id: "hello",
    version: "0.1.0",
    summary: "s",
    produces: ["a"],
  });
  expect(empty.params).toEqual({});

  const populated = manifestSchema.parse({
    id: "greeting-page",
    version: "1.0.0",
    summary: "s",
    params: { title: { type: "string", required: true } },
    produces: ["index.html"],
  });
  expect(populated.params.title.required).toBe(true);
});

test("manifest rejects an invalid param spec", () => {
  const result = manifestSchema.safeParse({
    id: "x",
    version: "0.1.0",
    summary: "s",
    params: { mode: { type: "enum" } }, // missing enum values
    produces: [],
  });
  expect(result.success).toBe(false);
});

test("plannerOutputSchema accepts a valid plan and defaults gaps/questions", () => {
  const out = plannerOutputSchema.parse({
    steps: [{ id: "b", version: "1.0.0", summary: "Building b", params: {} }],
  });
  expect(out.gaps).toEqual([]);
  expect(out.questions).toEqual([]);
  expect(out.steps[0].needs).toEqual([]);
});

test("plannerOutputSchema rejects a step missing summary", () => {
  const result = plannerOutputSchema.safeParse({
    steps: [{ id: "b", version: "1.0.0", params: {} }],
  });
  expect(result.success).toBe(false);
});

test("plannerOutputSchema rejects non-empty needs (v1 is linear)", () => {
  const result = plannerOutputSchema.safeParse({
    steps: [{ id: "b", version: "1.0.0", summary: "x", params: {}, needs: ["a"] }],
  });
  expect(result.success).toBe(false);
});

test("plannerOutputSchema rejects steps of the wrong type", () => {
  expect(plannerOutputSchema.safeParse({ steps: "nope" }).success).toBe(false);
});

test("planSchema still accepts a handwritten v0 plan and defaults gaps", () => {
  const plan = planSchema.parse({
    spec_hash: "manual-v0",
    steps: [{ id: "hello", version: "0.1.0", params: {}, needs: [] }],
  });
  expect(plan.gaps).toEqual([]);
  expect(plan.planner).toBeUndefined();
});

test("planSchema accepts planner provenance and gaps", () => {
  const plan = planSchema.parse({
    steps: [{ id: "b", version: "1.0.0" }],
    gaps: [{ feature: "login", reason: "no block provides authentication" }],
    planner: {
      agent: "anthropic/claude-opus-4-5",
      pi_version: "0.76.0",
      planned_at: "2026-06-17T00:00:00.000Z",
    },
  });
  expect(plan.gaps[0].feature).toBe("login");
  expect(plan.planner?.agent).toBe("anthropic/claude-opus-4-5");
});
