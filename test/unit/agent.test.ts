import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSelector, resolveAgentSelector } from "../../src/lib/agent.ts";
import { configPath } from "../../src/config.ts";

test("parseSelector splits provider/id", () => {
  expect(parseSelector("anthropic/claude-opus-4-5")).toEqual({
    provider: "anthropic",
    id: "claude-opus-4-5",
    thinking: undefined,
  });
});

test("parseSelector parses a thinking suffix", () => {
  expect(parseSelector("anthropic/claude-opus-4-5:high")).toEqual({
    provider: "anthropic",
    id: "claude-opus-4-5",
    thinking: "high",
  });
});

test("parseSelector keeps a bare model id (no provider)", () => {
  expect(parseSelector("gpt-4o")).toEqual({
    provider: undefined,
    id: "gpt-4o",
    thinking: undefined,
  });
});

test("parseSelector keeps slashes inside the id (openrouter)", () => {
  expect(parseSelector("openrouter/anthropic/claude-3.5-sonnet")).toEqual({
    provider: "openrouter",
    id: "anthropic/claude-3.5-sonnet",
    thinking: undefined,
  });
});

test("parseSelector treats a non-level colon as part of the id", () => {
  expect(parseSelector("p/some:model")).toEqual({
    provider: "p",
    id: "some:model",
    thinking: undefined,
  });
});

test("parseSelector rejects empty and malformed selectors", () => {
  expect(() => parseSelector("")).toThrow();
  expect(() => parseSelector("/id")).toThrow();
  expect(() => parseSelector("provider/")).toThrow();
});

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bspec-home-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("resolveAgentSelector precedence: flag > env > file", async () => {
  await writeFile(configPath(home), JSON.stringify({ agent: "file/model" }));

  expect(
    await resolveAgentSelector({ flag: "flag/model", env: { BSPEC_AGENT: "env/model" }, home }),
  ).toEqual({ selector: "flag/model", source: "flag" });

  expect(await resolveAgentSelector({ env: { BSPEC_AGENT: "env/model" }, home })).toEqual({
    selector: "env/model",
    source: "env",
  });

  expect(await resolveAgentSelector({ env: {}, home })).toEqual({
    selector: "file/model",
    source: "file",
  });
});

test("resolveAgentSelector falls back to default when nothing is set", async () => {
  expect(await resolveAgentSelector({ env: {}, home })).toEqual({
    selector: undefined,
    source: "default",
  });
});
