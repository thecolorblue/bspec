import { expect, test } from "bun:test";
import { FakePlanner } from "../helpers/fake-planner.ts";
import type { PlannerOutput } from "../../src/lib/schemas.ts";

const out = (summary: string): PlannerOutput => ({
  steps: [{ id: "b", version: "1.0.0", summary, params: {}, needs: [] }],
  gaps: [],
  questions: [],
});

test("FakePlanner returns scripted outputs in order and repeats the last", async () => {
  const planner = new FakePlanner([out("one"), out("two")]);
  expect((await planner.plan({ spec: "", menu: [] })).steps[0].summary).toBe("one");
  expect((await planner.plan({ spec: "", menu: [] })).steps[0].summary).toBe("two");
  expect((await planner.plan({ spec: "", menu: [] })).steps[0].summary).toBe("two");
});

test("FakePlanner records the inputs it was called with", async () => {
  const planner = new FakePlanner(out("x"));
  await planner.plan({ spec: "S", menu: [], answers: [{ id: "q1", answer: "yes" }] });
  expect(planner.calls).toHaveLength(1);
  expect(planner.calls[0].answers?.[0]?.answer).toBe("yes");
});

test("FakePlanner requires at least one scripted output", () => {
  expect(() => new FakePlanner([])).toThrow();
});
