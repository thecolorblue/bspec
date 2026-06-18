import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configGet, configSetAgent } from "../../src/commands/config.ts";
import { configPath, loadConfig } from "../../src/config.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bspec-home-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Capture everything written to process.stdout while fn runs. */
async function capture(fn: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  (process.stdout.write as unknown) = (chunk: string | Uint8Array) => {
    out += chunk.toString();
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

test("loadConfig returns an empty config when no file exists", async () => {
  expect(await loadConfig(home)).toEqual({});
});

test("loadConfig throws on invalid JSON", async () => {
  await writeFile(configPath(home), "{not json");
  await expect(loadConfig(home)).rejects.toThrow(/not valid JSON/);
});

test("loadConfig throws on a wrong-shaped config", async () => {
  await writeFile(configPath(home), JSON.stringify({ agent: 123 }));
  await expect(loadConfig(home)).rejects.toThrow(/Invalid config/);
});

test("configSetAgent writes a selector that loadConfig reads back", async () => {
  await capture(() => configSetAgent("anthropic/claude-opus-4-5", { home }));
  expect(await loadConfig(home)).toEqual({ agent: "anthropic/claude-opus-4-5" });
});

test("configSetAgent rejects an invalid selector and writes nothing", async () => {
  await expect(configSetAgent("/bad", { home })).rejects.toThrow();
  expect(await loadConfig(home)).toEqual({});
});

test("configSetAgent preserves the file while updating the agent", async () => {
  await writeFile(configPath(home), JSON.stringify({ agent: "old/model" }));
  await capture(() => configSetAgent("new/model", { home }));
  expect((await loadConfig(home)).agent).toBe("new/model");
});

test("configGet reports the resolved agent and its source", async () => {
  await capture(() => configSetAgent("openai/gpt-4o", { home }));
  const out = await capture(() => configGet({ home, env: {} }));
  expect(out).toContain("openai/gpt-4o");
  expect(out).toContain("config.json");
});

test("configGet reports the default when nothing is configured", async () => {
  const out = await capture(() => configGet({ home, env: {} }));
  expect(out).toContain("default");
});
