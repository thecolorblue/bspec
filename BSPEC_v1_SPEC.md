# SPEC.md — bspec v1: The AI Planner (SPEC.md → plan.json) via Pi

## Overview

Build `bspec` v1 as the next layer on top of the working v0 harness. v0 proved the
deterministic core: a folder becomes a single self-describing block, a **handwritten**
`plan.json` builds it into `dist/`, and a re-build replays from cache. v1 adds the one and
only piece of AI in the entire system — **the planner** — and the command that drives it:

1. The user writes a plain-language `SPEC.md`.
2. `bspec plan` reads that spec, reads the menu of every installed block's `summary` and
   parameter schema, and asks an LLM (through **Pi**) to choose blocks and fill in their
   settings — producing a `plan.json`.
3. The planner pauses to ask clarifying questions when the spec is ambiguous, prints the
   plan in plain English for review, and writes `plan.json` only after the user approves.
4. `bspec build` then runs **exactly as in v0** — no AI, fully deterministic — turning the
   planned steps into a built app and recording provenance.

The defining property of bspec is preserved and made explicit in v1: **the AI is a picker,
not a builder.** The model selects from prebuilt, tested blocks and fills their parameters.
It never writes files, never runs code, and never emits anything but plan *data*. Building
stays deterministic and offline.

This document builds directly on the code already in `src/` (see
[BSPEC_v0_SPEC_bun.md](./BSPEC_v0_SPEC_bun.md) for what exists) and on the architecture in
[DESIGN.md](./DESIGN.md) §6 item 2.

### What v1 adds, in one paragraph

A `~/.bspec/config` file plus a `BSPEC_AGENT` setting; a thin **Pi planner adapter** that
calls Pi's SDK in-process with tools disabled; a `bspec plan` command with a
clarifying-question loop, plain-English review, and an explicit approval gate; an extended
(but backward-compatible) block manifest that declares a **parameter schema**; a
**validation pipeline** that guarantees the model can only ever produce a plan referencing
real, installed blocks with valid parameters; and provenance that records which model
produced the plan. `bspec build` and every other v0 command are unchanged.

---

## Users

### Primary user (v1)

A builder who writes a plain `SPEC.md` and runs `bspec plan` + `bspec build` to get a working
app from prebuilt blocks, without hand-authoring `plan.json`.

### Secondary user

The block author who keeps the registry healthy. v1 introduces **parameterized** blocks
(beyond v0's folder snapshots), so authors now write blocks that declare and consume params.

### Not yet the target

The fully non-technical user served by `bspec init`, `change`, `fix`, `undo`, and `report`.
Those are **v2** (DESIGN §6 item 3) and are out of scope here. v1 still expects a
hand-written `SPEC.md`.

---

## Platform Requirement

- **Bun** on `PATH` as `bun` (unchanged from v0). Developed and tested on macOS first.
- **Pi** (`@earendil-works/pi-coding-agent`) available, with at least one authenticated
  provider. v1 integrates Pi **as a library dependency** (in-process SDK), not by shelling
  out. Pi must therefore be resolvable as an npm dependency of bspec.
- A working Pi auth for at least one provider (Anthropic, OpenAI, or OpenRouter at minimum).
  Auth is configured **entirely through Pi** (`pi` `/login`, `~/.pi/agent/auth.json`, or
  provider env vars). **bspec never asks for, stores, or logs API keys.**
- Network access is required for `bspec plan` (the planning call). `bspec build`,
  `preview`, `blocks`, and `cache` remain fully offline.

---

## Product Principles

Carried over from v0 and extended for v1:

- **Deterministic builds only.** `bspec build` makes zero model calls in v1, exactly as v0.
- **AI is a picker, not a builder (now enforced).** The planner runs with **all Pi tools
  disabled** (`noTools: "all"`). The model cannot read, write, edit, or run anything; it can
  only return plan data, which is then validated against the registry before use.
- **Every output file still comes from a block.** The planner only *selects* blocks; the
  files come from the same tested `--apply` path as v0.
- **Pi owns the model and the auth.** bspec is LLM-agnostic by delegation: it supports every
  provider Pi supports (Anthropic, OpenAI, OpenRouter, Google, …) and stores no credentials.
- **The plan is reviewable in plain English and gated by approval.** `bspec plan` never
  writes `plan.json` until the user approves.
- **Ask, don't guess.** When the spec is ambiguous about which block or what parameter value
  to use, the planner asks a clarifying question instead of inventing an answer.
- **Backward compatibility is mandatory.** Every v0 command, output format, and test must
  keep passing. A handwritten v0 `plan.json` must still build unchanged.
- **Tests prove behavior on the real filesystem and never call a live model.** Planning is
  tested through an injected fake planner; a single optional test exercises real Pi behind a
  flag.

---

## Chosen Implementation Stack

Continue with Bun + TypeScript and the existing libraries. Add Pi.

`package.json` dependency additions:

```jsonc
{
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^0.76.0", // Pi SDK: planner adapter
    "commander": "^12.1.0",                        // existing
    "tar": "^7.4.3",                               // existing
    "zod": "^3.23.8"                               // existing
  }
}
```

Required package scripts are unchanged from v0 (`bspec`, `test`, `typecheck`, `build:bin`).

The planner adapter imports from the Pi SDK only:

```ts
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
```

> **Risk / Bun compatibility (see Risks).** Pi is a Node package; bspec runs on Bun. The
> implementer must verify Bun can import and run the Pi SDK. If a blocking incompatibility is
> found, fall back to invoking `pi --mode json --no-session --no-tools` as a subprocess (the
> same JSONL contract), preserving every other part of this spec. The `Planner` interface
> below makes that swap a one-file change.

---

## Command Invocation

Unchanged from v0 — all commands run through Bun during development:

```bash
bun run bspec -- <command> [args]

# new in v1:
bun run bspec -- plan --project demo-app
bun run bspec -- config get
```

---

## Configuration

### `~/.bspec/config` (new)

v0's `src/config.ts` only resolves `BSPEC_HOME` and the blocks/cache directories. v1 adds a
small JSON config file and a loader. It holds the planner model selection (and is the future
home for registry remotes, DESIGN §3).

`${BSPEC_HOME}/config.json`:

```json
{
  "agent": "anthropic/claude-opus-4-5"
}
```

Resolution order for the planner model (`BSPEC_AGENT`), highest priority first:

1. `--agent <selector>` flag on `bspec plan` (per-invocation override).
2. `BSPEC_AGENT` environment variable.
3. `agent` field in `${BSPEC_HOME}/config.json`.
4. Unset → let Pi pick its default available model, and **print which model was chosen**
   (honesty about what ran).

A **model selector** is a Pi model pattern, preferably `provider/id`:

- `anthropic/claude-opus-4-5`
- `openai/gpt-4o`
- `openrouter/anthropic/claude-3.5-sonnet`
- optional thinking suffix: `anthropic/claude-opus-4-5:high` → maps to Pi `thinkingLevel`.

bspec parses the selector into `{ provider, id, thinking? }` and resolves it through Pi's
`ModelRegistry` (see Planner Adapter). bspec **does not** maintain its own provider list.

### `bspec config` (new command)

```text
bspec config get                 # print the resolved agent + its source (flag/env/file/default)
bspec config set-agent <sel>     # write { "agent": "<sel>" } to ${BSPEC_HOME}/config.json
bspec config models [search]     # list selectable models via Pi (delegates to the model registry)
```

`config models` is the "model picker": it lists models Pi reports as available (those with
valid auth), so the user can copy a selector into `set-agent`. It must never print secrets.

### Secrets

bspec stores **no** secrets. All credentials live in Pi (`~/.pi/agent/auth.json` or env).
The bspec config file contains only a non-secret model selector. Logs must never contain
auth material.

---

## SPEC.md format

v1 expects a hand-written `SPEC.md` at the project root (`<project>/SPEC.md`). The guided
`bspec init` interview that *writes* this file is **v2**. v1 ships a template and a sample
instead (see Fixtures), and `bspec plan` errors clearly if the file is missing.

The recommended structure follows DESIGN §5 (plain prose under each heading):

```text
# Overview      one paragraph: what & why
# Users         who uses it
# Features      plain wishes — "I want a button that saves my current tab"
# Screens       the few views and what's on them
# Data          what it remembers, and where
# Acceptance    plain checks — "After I click Save, my tab is in the list"
# References     links to apps it should resemble
# Out of scope   what NOT to build
```

bspec passes the **full text** of `SPEC.md` to the planner; it does not require the headings
and does not parse them into structure in v1 (the model reads the prose). The headings exist
to help the user write a clear spec and to make the plan reviewable against the Acceptance
lines.

`spec_hash` is `sha256Hex(SPEC.md bytes)` and is recorded in `plan.json` (it is already an
optional field in the v0 `planSchema`). It lets later versions detect spec drift; v1 only
records it.

---

## Block manifest: parameter schema (extended, backward-compatible)

v0's manifest declares `params` but folder-snapshot blocks always emit `params: {}`. v1 gives
`params` a defined shape so the planner knows what a block accepts and bspec can validate what
the model fills in. **An empty object remains valid**, so every v0 block keeps working.

A manifest's `params` is a map of **parameter name → parameter spec**:

```jsonc
{
  "id": "greeting-page",
  "version": "1.0.0",
  "summary": "A single HTML greeting page with a customizable title and message.",
  "params": {
    "title":   { "type": "string", "required": true,  "description": "Page heading." },
    "message": { "type": "string", "required": false, "default": "Welcome!", "description": "Body text." }
  },
  "produces": ["index.html"],
  "needs": []
}
```

Parameter spec fields:

| Field | Required | Meaning |
|---|---|---|
| `type` | yes | one of `"string"`, `"number"`, `"boolean"`, `"enum"` |
| `required` | no (default `false`) | whether the planner must supply a value |
| `description` | no | guidance shown to the planner |
| `enum` | only when `type:"enum"` | allowed string values |
| `default` | no | value used when omitted |

This is expressed in `src/lib/schemas.ts` by tightening `manifestSchema.params` from
`z.record(z.unknown())` to `z.record(paramSpecSchema).default({})`, where `paramSpecSchema`
encodes the table above. Distinguish clearly in code and docs:

- **manifest `params`** = the *schema* of accepted parameters (author-defined).
- **plan step `params`** = the *values* filled in for a specific use (planner-defined).

---

## The block menu (what the planner sees)

`bspec plan` builds a compact menu from every installed block by loading each manifest (reuse
`listBlockFiles` + `loadManifest` from `src/lib/blocks.ts`). The menu sent to the model
contains only metadata — **never** the embedded file payloads:

```jsonc
[
  {
    "id": "greeting-page",
    "version": "1.0.0",
    "summary": "A single HTML greeting page with a customizable title and message.",
    "params": { "title": { "type": "string", "required": true }, "message": { "type": "string" } },
    "produces": ["index.html"]
  }
]
```

---

## The planner contract

### Planner interface (the testability seam)

The `plan` command depends on a small interface, not on Pi directly — mirroring how v0
commands accept an injectable `home`/`project`. The real implementation wraps Pi; tests
inject a deterministic fake.

```ts
export interface BlockMenuEntry {
  id: string;
  version: string;
  summary: string;
  params: Record<string, ParamSpec>;
  produces: string[];
}

export interface ClarifyingAnswer { id: string; answer: string; }

export interface PlannerInput {
  spec: string;                 // full SPEC.md text
  menu: BlockMenuEntry[];       // installed blocks
  answers?: ClarifyingAnswer[]; // folded in on a re-plan round
}

export interface PlannerOutput {
  steps: PlanStep[];            // ordered; needs must be [] in v1
  gaps: PlanGap[];              // spec wishes that matched no block
  questions: PlanQuestion[];    // clarifying questions; empty when confident
}

export interface Planner {
  plan(input: PlannerInput): Promise<PlannerOutput>;
}
```

- **Real:** `PiPlanner` (in `src/lib/planner-pi.ts`).
- **Fake:** `FakePlanner` (in tests) constructed with canned output(s) — one per round to
  exercise the clarifying-question loop.

`bspec plan` accepts `{ planner?: Planner }` and defaults to `PiPlanner`.

### Planner output JSON (what the model must return)

The model is instructed to return exactly one JSON object:

```jsonc
{
  "steps": [
    {
      "id": "greeting-page",
      "version": "1.0.0",
      "summary": "Building your greeting page",   // plain-English progress phrase
      "params": { "title": "Tab Saver", "message": "Welcome!" },
      "needs": []
    }
  ],
  "gaps": [
    { "feature": "a login screen", "reason": "no block in the menu provides authentication" }
  ],
  "questions": [
    { "id": "q1", "question": "Should the greeting say 'Welcome!' or your app's name?", "why": "the 'message' parameter is ambiguous in the spec" }
  ]
}
```

Validated by `plannerOutputSchema` (zod). Rules: `steps[].needs` must be `[]` (v1 is linear;
dependency-graph execution is v3); `steps[].summary` is required (build prints it);
`gaps`/`questions` default to `[]`.

### Planner system prompt (behavioral contract)

The `PiPlanner` sends a focused system prompt (via `DefaultResourceLoader`'s
`systemPromptOverride`) that establishes:

- You are a **planner**. Select only from the provided block menu. Never invent a block `id`
  or `version`; copy them verbatim from the menu (pin versions exactly).
- Fill each chosen block's `params` according to that block's parameter schema: include all
  `required` params, respect `type` and `enum`, omit unknown params.
- Order steps sensibly (scaffolding before features).
- If a spec feature matches no block, list it under `gaps` — do **not** approximate it with an
  unrelated block.
- If choosing a block or a parameter value requires a guess, ask under `questions` instead.
- Output **only** the single JSON object. No prose, no code fences.

---

## The Pi planner adapter (`PiPlanner`)

`PiPlanner.plan()` runs one tool-less, in-memory Pi session per round:

1. **Auth & registry (Pi-owned):**
   ```ts
   const authStorage = AuthStorage.create();          // ~/.pi/agent/auth.json + env vars
   const modelRegistry = ModelRegistry.create(authStorage);
   ```
2. **Resolve the model** from the selector (`provider/id[:thinking]`):
   ```ts
   const model = modelRegistry.find(provider, id);
   const available = await modelRegistry.getAvailable();   // models with valid auth
   // error clearly if model is null or not in `available`
   ```
   If no selector is configured, choose the first `available` model and print it.
3. **Build the session, tools disabled, no persistence, no ambient context:**
   ```ts
   const loader = new DefaultResourceLoader({
     systemPromptOverride: () => PLANNER_SYSTEM_PROMPT,
   });
   await loader.reload();
   const { session } = await createAgentSession({
     model,
     thinkingLevel,                       // from selector, default "off"
     noTools: "all",                      // <- the picker-not-builder guarantee
     authStorage,
     modelRegistry,
     resourceLoader: loader,
     sessionManager: SessionManager.inMemory(),
     settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
   });
   ```
   Disabling tools, ambient `AGENTS.md`/`CLAUDE.md` discovery, extensions, and persistence
   keeps planning deterministic and isolated from the user's global Pi setup.
4. **Prompt** with the spec + menu (+ folded-in answers) rendered as a single user message
   requesting the JSON object.
5. **Collect the answer:** after `await session.prompt(...)` resolves, read the final
   assistant message text from `session.messages` (concatenate its text content). Streaming
   `message_update` events may be surfaced as progress but the authoritative output is the
   final assistant text.
6. **Hand the raw text to the validation pipeline.** `PiPlanner` does not trust the model; it
   returns a `PlannerOutput` only after the pipeline passes.

---

## Validation pipeline (the heart of v1 correctness)

Raw model text → trusted `PlannerOutput`, with bounded repair. Implemented in
`src/lib/plan-validate.ts` and used by `PiPlanner`:

1. **Extract JSON.** Trim, strip ``` fences if present, and locate the single top-level JSON
   object. On no parseable object → repair (step 6).
2. **Parse.** `JSON.parse`. On failure → repair.
3. **Shape-validate.** `plannerOutputSchema.safeParse`. On failure → repair.
4. **Semantic-validate against the live registry** — for every step:
   - `id` names an installed block (else: hallucinated-block error).
   - `version` equals that block's manifest version exactly (else: version-mismatch error).
   - `params` conforms to the block's parameter schema: all `required` present, each value's
     `type` matches, `enum` values allowed, **no unknown params** (else: param error).
   - `needs` is empty (else: unsupported-graph error — v1 is linear).
5. **Pass** → return the typed `PlannerOutput` (including any `gaps`/`questions`).
6. **Repair (bounded).** On any failure in 1–4, re-prompt the *same* session once more with a
   precise description of what was wrong, asking for a corrected JSON object. Default
   `maxRepairs = 2`. If still failing, throw a `BspecError` with a plain message and write the
   raw model output to `<project>/.bspec/logs/plan.log` for `bspec report` (v2).

This pipeline is what makes "the AI is a picker" a guarantee rather than a hope: nothing the
model says can introduce a block that isn't real or a parameter a block doesn't accept.

---

## `bspec plan` command

```text
bspec plan [--project <dir>] [--agent <selector>] [--yes] [--answers <file>]
```

Options:

- `--project <dir>` — project directory (defaults to cwd), like `build`.
- `--agent <selector>` — override the model for this run.
- `--yes` — non-interactive: skip the approval prompt and write `plan.json`. If the planner
  returns `questions` and no `--answers` are supplied, fail with a clear message rather than
  guessing.
- `--answers <file>` — JSON array of `{ "id": "...", "answer": "..." }` used to answer
  clarifying questions non-interactively (for CI and tests).

Behavior:

1. Resolve `project`, `home`, and the model selector (with its source).
2. Read `<project>/SPEC.md`. Missing → `No SPEC.md found at <path>. Write one (see the
   template) before running bspec plan.`
3. Compute `spec_hash`.
4. Build the block menu. Empty registry → clear message to add blocks first.
5. **Plan round:** call `planner.plan({ spec, menu, answers })`.
6. **Clarifying questions:** if `questions` is non-empty:
   - Interactive TTY (no `--yes`): print each question (and its `why`), read answers from
     stdin, then re-run step 5 with the folded-in answers. Repeat until no questions or a
     small round cap (default 3) is hit.
   - Non-interactive: use `--answers` if given; else fail (`--yes`) or print the questions and
     stop without writing a plan.
7. **Plain-English review:** print the proposed plan (see output below), including any `gaps`.
8. **Approval gate:** interactive → prompt `Write this plan? [y/N]`; `--yes` → proceed.
   Anything but yes → exit without writing.
9. **Write** `<project>/.bspec/plan.json` (schema below), creating `.bspec/` if needed. Then
   print the next step: `Run: bspec build --project <dir>`.

### `bspec plan` output

```text
$ bun run bspec -- plan --project demo-app
Planning from SPEC.md using anthropic/claude-opus-4-5 (from $BSPEC_AGENT)…

Here's the plan:
  1. Building your greeting page    greeting-page@1.0.0
        title:   "Tab Saver"
        message: "Welcome!"

Not covered by any block (would need a new block):
  - a login screen — no block in the menu provides authentication

Write this plan? [y/N] y
Wrote demo-app/.bspec/plan.json
Run: bspec build --project demo-app
```

When the planner needs to ask first:

```text
The plan needs a couple of answers before I can finish:
  q1. Should the greeting say 'Welcome!' or your app's name?
      (why: the 'message' parameter is ambiguous in the spec)
> your app's name
Re-planning with your answers…
```

---

## plan.json format (extended, backward-compatible)

The `steps` array is **byte-identical in shape** to v0, so `src/commands/build.ts` consumes a
planned plan with zero changes. v1 adds optional provenance and gaps, which `build` ignores.

```jsonc
{
  "spec_hash": "9f2b…",
  "steps": [
    {
      "id": "greeting-page",
      "version": "1.0.0",
      "summary": "Building your greeting page",
      "params": { "title": "Tab Saver", "message": "Welcome!" },
      "needs": []
    }
  ],
  "gaps": [
    { "feature": "a login screen", "reason": "no block provides authentication" }
  ],
  "planner": {
    "agent": "anthropic/claude-opus-4-5",
    "pi_version": "0.76.0",
    "planned_at": "2026-06-17T00:00:00.000Z"
  }
}
```

`planSchema` in `src/lib/schemas.ts` gains optional `gaps` and `planner` fields; existing
fields are untouched, so handwritten v0 plans still validate.

---

## Provenance

- **`build.json`** is already written by v0's `build.ts` (per-output `{ by, cache, hash }`).
  v1 leaves this exactly as is — it is the file-level provenance the user debugs with.
- **`plan.json.planner`** is the new plan-level provenance: which model produced the plan,
  the Pi version, and when. This answers "what made this plan?" without affecting the build.

Together they close the provenance loop DESIGN §6 item 2 calls for, on top of v0's file-level
records.

---

## Backward compatibility (hard requirements)

- All v0 commands (`blocks add/list/test`, `build`, `cache ls/verify`, `preview`) keep their
  behavior and output.
- All existing tests in `test/` continue to pass unchanged.
- A handwritten v0 `plan.json` (no `gaps`, no `planner`, `params: {}`) builds identically.
- The `manifestSchema.params` tightening accepts `{}` (every folder-snapshot block).
- `bspec build` performs no model calls and works fully offline.

---

## Parameterized block fixture (hand-written)

v0's `blocks add` only generates **empty-param** folder snapshots. To prove param-filling
end to end, v1 introduces a hand-written parameterized block. (Teaching `blocks add` to author
parameterized blocks is future work, not v1.) Ship this as a test/demo fixture, e.g.
`test/fixtures/greeting-page.block.ts`. It honors the universal contract and **reads
`params.json`** on `--apply`:

```ts
#!/usr/bin/env bun
// Hand-written parameterized block fixture for bspec v1 (tests + demo).
import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const MANIFEST = {
  id: "greeting-page",
  version: "1.0.0",
  summary: "A single HTML greeting page with a customizable title and message.",
  params: {
    title:   { type: "string", required: true,  description: "Page heading." },
    message: { type: "string", required: false, default: "Welcome!", description: "Body text." },
  },
  produces: ["index.html"],
  needs: [] as string[],
} as const;

interface Params { title: string; message?: string }

function render(p: Params): string {
  const message = p.message ?? "Welcome!";
  return `<!doctype html>
<html>
  <head><title>${p.title}</title></head>
  <body>
    <h1>${p.title}</h1>
    <p>${message}</p>
  </body>
</html>
`;
}

async function readParams(file?: string): Promise<Params> {
  if (!file) return { title: "Hello" };
  return JSON.parse(await readFile(file, "utf8")) as Params;
}

async function applyTo(outDir: string, params: Params): Promise<void> {
  const dest = join(outDir, "index.html");
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, render(params));
}

async function selfTest(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "greeting-page-test-"));
  try {
    await applyTo(dir, { title: "Test Title", message: "Hi" });
    const html = await readFile(join(dir, "index.html"), "utf8");
    if (!html.includes("Test Title")) throw new Error("title not rendered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [flag, ...rest] = process.argv.slice(2);
  if (flag === "--manifest") { process.stdout.write(JSON.stringify(MANIFEST, null, 2) + "\n"); return; }
  if (flag === "--apply") {
    const outDir = rest[0];
    if (!outDir) { process.stderr.write("Usage: <block> --apply <out_dir> <params.json>\n"); process.exit(2); }
    await applyTo(outDir, await readParams(rest[1]));
    return;
  }
  if (flag === "--test") {
    try { await selfTest(); process.stdout.write("ok\n"); }
    catch (err) { process.stderr.write("FAIL: " + (err as Error).message + "\n"); process.exit(1); }
    return;
  }
  process.stderr.write("Unknown command. Use --manifest, --apply, or --test.\n");
  process.exit(2);
}

main().catch((err) => { process.stderr.write(String((err as Error)?.stack ?? err) + "\n"); process.exit(1); });
```

The v0 runner already writes `__params.json` and passes it to `--apply` (see
`build.ts:runStep`), so once this block is installed the full select → fill → build → replay
loop works with no runner changes.

---

## Test fixtures

- **`test/fixtures/hello-extension-source/`** — unchanged from v0 (empty-param folder block).
- **`test/fixtures/greeting-page.block.ts`** — the parameterized block above.
- **`test/fixtures/spec/SPEC.md`** — a sample spec whose wishes map onto the installed
  fixtures, e.g.:

  ```markdown
  # Overview
  A simple personal landing page.

  # Features
  - I want a greeting page that shows the title "Tab Saver" and a short welcome message.

  # Acceptance
  - The page heading reads "Tab Saver".
  ```

- **`examples/SPEC.md`** — a copy of the template shipped for the manual demo.

---

## Testability strategy

- **No live model in `bun test`.** All planning tests inject `FakePlanner`, which returns
  scripted `PlannerOutput`(s). This is the same dependency-injection seam v0 uses for
  `home`/`project`.
- **Validation tested directly.** The validation pipeline is pure (raw text + menu →
  `PlannerOutput` or error) and is unit-tested without any session.
- **One optional live test.** A single integration test calls the real `PiPlanner`, skipped
  unless `BSPEC_LIVE=1` (and Pi is authed). It asserts only that a parseable, registry-valid
  plan comes back — never exact wording. CI leaves it skipped.

---

## Required automated tests

### Unit tests

1. `spec_hash` is stable for identical SPEC.md content and changes when content changes.
2. Block-menu builder returns `{ id, version, summary, params, produces }` for installed
   blocks and omits embedded payloads.
3. `plannerOutputSchema` accepts a valid object and rejects malformed ones (missing
   `summary`, non-empty `needs`, wrong types).
4. Model selector parsing: `provider/id`, `provider/id:thinking`, and bare `id` parse
   correctly; precedence flag > env > file > default is honored.
5. Manifest `params` schema: `{}` is valid (v0 blocks); a populated param schema validates.
6. Validation pipeline — JSON extraction strips code fences and finds the object.
7. Validation pipeline — rejects a hallucinated block `id` with a clear error.
8. Validation pipeline — rejects a version mismatch.
9. Validation pipeline — param checks: missing `required`, unknown param, and `type`/`enum`
   mismatches are each rejected; a valid param set passes.
10. Validation pipeline — non-empty `needs` is rejected (v1 linear).

### Integration tests (all with `FakePlanner`, no network)

1. `bspec plan` with a fake planner writes a `plan.json` containing `spec_hash`, the chosen
   step(s), and a `planner` provenance block.
2. The plan produced by `bspec plan` then builds with the **unchanged** `bspec build`,
   landing files in `dist/`.
3. **Param-filling end to end:** fake planner fills `greeting-page` params; the plan validates
   against the block's param schema; `build` runs the block and `dist/index.html` contains the
   filled `title` (and `message`).
4. **Clarifying-question loop:** fake planner returns a question on round 1 and a clean plan
   on round 2 once answers are folded in; `plan.json` is written and contains no questions.
5. **Gaps surfaced:** fake planner returns a `gap`; `bspec plan` prints it and records it in
   `plan.json`.
6. **Semantic-failure path:** fake planner returns a hallucinated block id/version (with
   repairs exhausted); `bspec plan` throws a `BspecError`, writes **no** `plan.json`, and
   leaves a raw `plan.log`.
7. **Approval gate:** without `--yes` and with a "no" answer, `bspec plan` exits without
   writing `plan.json`.
8. **Non-interactive:** `--answers <file>` resolves questions and `--yes` writes the plan
   without prompting.
9. **Backward compatibility:** a handwritten v0 `plan.json` still builds (existing v0 test
   retained), and a planned `plan.json` with `gaps`/`planner` builds identically.
10. **End-to-end:** `bspec plan` (fake) → `bspec build` (first `[ran]`, second `[replayed]`,
    same cache key) → `bspec preview` lists the built files.

### Optional live test

11. `BSPEC_LIVE=1` → real `PiPlanner` returns a registry-valid, schema-valid plan for the
    sample spec. Skipped by default.

---

## Manual demo script

```bash
export BSPEC_HOME="$(pwd)/.tmp/bspec-home"
export BSPEC_AGENT="anthropic/claude-opus-4-5"   # or any Pi-authed provider/model
rm -rf .tmp demo-app
mkdir -p "$BSPEC_HOME/blocks" demo-app

# 1) Install both blocks: the v0 folder snapshot + the v1 parameterized block.
bun run bspec -- blocks add ./test/fixtures/hello-extension-source \
  --id hello-extension --version 0.1.0 \
  --summary "A minimal hello extension fixture"
cp ./test/fixtures/greeting-page.block.ts "$BSPEC_HOME/blocks/greeting-page.block.ts"
chmod +x "$BSPEC_HOME/blocks/greeting-page.block.ts"

bun run bspec -- blocks list
bun run bspec -- blocks test greeting-page

# 2) Write the spec, then let the planner choose blocks + fill params.
cp ./examples/SPEC.md demo-app/SPEC.md
bun run bspec -- plan --project demo-app           # review the plan, approve

# 3) Build deterministically (no AI), then re-build to show replay.
bun run bspec -- build --project demo-app          # [ran]
bun run bspec -- build --project demo-app          # [replayed]
bun run bspec -- preview --project demo-app
```

Expected: `bspec plan` prints a plain-English plan (with filled params), writes
`demo-app/.bspec/plan.json` after approval; the first build shows `[ran]`, the second
`[replayed]`; `demo-app/dist/index.html` reflects the params the planner filled.

---

## Error handling

Plain and actionable, via `BspecError` (consistent with v0):

- Missing spec: `No SPEC.md found at <project>/SPEC.md. Write one (see the template) before running bspec plan.`
- Empty registry: `No blocks installed in <BSPEC_HOME>/blocks. Add blocks before planning.`
- No model configured and none available:
  `No usable model. Set BSPEC_AGENT (e.g. anthropic/claude-opus-4-5) and authenticate it with Pi (\`pi\` then /login), or run \`bspec config models\`.`
- Selector resolves to nothing: `Model "<sel>" is not available in Pi. Run \`bspec config models\` to see options.`
- Planner output invalid after repairs:
  `The planner did not return a usable plan after N attempts. Raw output saved to <project>/.bspec/logs/plan.log.`
- Hallucinated block: `The planner chose "<id>@<version>", which isn't installed. Available: <list>.`
- Param error: `The planner set "<param>" on "<id>", which doesn't accept it.` / `"<id>" requires "<param>".`
- Clarifying questions unanswered in non-interactive mode:
  `The plan needs answers but none were provided. Re-run interactively or pass --answers <file>.`
- Pi/SDK unavailable: `Pi is required for planning but could not be loaded. Install @earendil-works/pi-coding-agent.`

`bspec build` keeps all of v0's error messages unchanged.

---

## Risks

- **HIGH — Bun ↔ Pi SDK compatibility.** Pi is a Node package; bspec runs on Bun. *Mitigation:*
  verify import/run under Bun early; the `Planner` interface lets us fall back to a
  `pi --mode json --no-session --no-tools` subprocess with no other spec changes.
- **HIGH — Trusting model output.** *Mitigation:* the validation pipeline (parse → shape →
  semantic-against-registry → bounded repair) is mandatory; nothing unvalidated is written or
  run, and tools are disabled so the model can't act regardless.
- **MED — Non-determinism of planning.** Different runs may pick differently. *Mitigation:*
  approval gate + plain-English review + recorded `planner` provenance + `spec_hash`; isolate
  Pi from ambient context (no AGENTS.md/extensions, in-memory session, compaction off).
- **MED — Pi version drift.** Output shape or APIs may change across Pi versions.
  *Mitigation:* pin the dependency; record `pi_version` in provenance; the live test (behind a
  flag) catches breakage.
- **MED — Auth/UX confusion.** Users may expect bspec to manage keys. *Mitigation:* explicit
  messaging that auth lives in Pi; `bspec config models` to surface what's available.
- **LOW — Secret leakage in logs.** *Mitigation:* bspec never handles keys and must never log
  auth material; only the model selector (non-secret) is stored.

---

## Out of scope for v1

Deferred to later phases per DESIGN §6:

- `bspec init` interview that writes `SPEC.md` (v2).
- `bspec change`, `bspec fix`, `bspec undo`/`snapshot`/`restore`, `bspec report`,
  `bspec diff`, `bspec explain`, drift detection (v2).
- Dependency-graph execution, parallel builds (v3). v1 plans are linear; `needs` stays `[]`.
- Registry remotes, `blocks publish`/`pull`, shared-block version policy (v3).
- Teaching `blocks add` to author parameterized blocks (v1 uses hand-written param blocks).
- Multiple concurrent planners or any non-Pi provider integration (LLM-agnosticism is
  achieved *through* Pi, not by adding providers in bspec).
- Streaming the planner's partial output as a UI (final assistant text is authoritative).

---

## Definition of Done

v1 is done when:

1. `bspec config` resolves the planner model from flag/env/file/default and `config models`
   lists Pi-available models without leaking secrets.
2. `bspec plan` reads `SPEC.md`, builds the block menu, and calls Pi **with tools disabled**
   through the SDK, using **Pi's auth** and the **BSPEC_AGENT** model.
3. The planner selects blocks by meaning **and fills their parameters**; the validation
   pipeline rejects any hallucinated block, version mismatch, or invalid parameter, with clear
   messages and no `plan.json` written on failure.
4. `bspec plan` asks clarifying questions when ambiguous, prints the plan (and any gaps) in
   plain English, and writes `plan.json` only after approval (or `--yes`).
5. `bspec build` builds the planned `plan.json` with **zero** model calls, identical to v0,
   recording file provenance in `build.json`; `plan.json` records planner provenance.
6. The parameterized fixture proves select → fill → build → replay end to end, with built
   output reflecting the filled params.
7. All v0 tests still pass; the v1 unit + integration tests (with the fake planner) pass with
   no network; the optional live test passes behind `BSPEC_LIVE=1`.
8. The manual demo runs from a clean checkout: `SPEC.md` → `plan` → `build` (`[ran]` then
   `[replayed]`) → `preview`.
