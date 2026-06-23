# Plan: `bspec fix` — a self-correcting fix-until-green loop

## Context

`bspec` today is a *deterministic* harness: SPEC.md → AI **planner** picks blocks → `plan.json` → **build** composes blocks into `dist/`, authoring "gap" blocks via Pi only on first build. The AI is "a picker/author, not a builder." There is **no** capability that drives an arbitrary codebase to "build clean + tests pass."

`goal-loop.md` specifies exactly that loop and *why naive versions fail* (oscillation, premature "done," reward hacking, runaway token spend), then prescribes a layered controller `D(C(B(A)))`: a supervised outer controller (budget + stuck detection + escalation) running **sequenced build→test gates**, each guarded by a **deterministic verifier + anti-hack diff-guard**, wrapping a **reflexive Pi edit-agent**.

We will add a new top-level command, **`bspec fix`**, that implements this controller. Per the decisions below it is a **generic** tool: it drives **any** target project's build/test commands to green, decoupled from bspec's block/plan/cache machinery. The harness — not the model — owns the stop condition (exit codes), which is the whole point.

### Decisions locked (from clarifying Q&A)
1. **Architecture:** *Generic fix-until-green.* `bspec fix --project <dir>` operates on any codebase's own build/test commands. It does **not** touch blocks, plans, or the cache.
2. **Implementation tier:** *Tier 2 — SDK embed.* A TypeScript controller embeds Pi (cwd-bound, **tool-enabled** session) like `PiPlanner`/`PiBlockAuthor`, with an event-stream stuck detector and a `FakeFixer` seam for offline tests.
3. **Gate definition:** *`.bspec/fix.json` (+ optional SPEC.md section).* The target project's `.bspec/fix.json` holds `build.cmd`, `test.cmd`, and `protected` globs; CLI flags override; a SPEC.md verification section is an optional secondary source.

### Why this is genuinely new ground in bspec
Every Pi session today is **tool-less** (`noTools: "all"`), in-memory, single-JSON-return (`src/lib/planner-pi.ts`, `src/lib/block-author-pi.ts`). The fixer is the **first** Pi session that runs **with file-editing tools enabled, bound to the project `cwd`**. I confirmed the SDK supports this: `CreateAgentSessionOptions` exposes `cwd`, built-in tools `read/bash/edit/write`, `tools`/`excludeTools` allow/deny-lists, and an `AgentSessionEvent` stream + `ContextUsage` (`node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts`, `core/agent-session.d.ts`). This is also the main new **risk surface** (running arbitrary build/test + AI edits on the host) — see Risks.

---

## High-level architecture (`D(C(B(A)))`, mapped to modules)

```
bspec fix  (src/commands/fix.ts)
└─ controller            src/lib/fix/controller.ts        [D] outer loop
   ├─ budget + iteration cap + token ceiling + escalation ladder
   ├─ stuck detector     src/lib/fix/stuck.ts             [D] repeat / ping-pong
   ├─ strategy ladder    src/lib/fix/strategy.ts          [D] diagnose→minimal→fresh→switch-model
   ├─ ledger (the spine) src/lib/fix/ledger.ts            on-disk state, immutable updates
   ├─ checkpointer       src/lib/fix/checkpoint.ts         git OR .bspec snapshot (tar)
   ├─ gates (verify)     src/lib/fix/gates.ts             [C][B] sequenced build→test, exit codes
   ├─ diff-guard         src/lib/fix/diff-guard.ts        [B] reject+revert edits to protected globs
   └─ fixer (the agent)  src/lib/fix/fixer.ts  (+ fixer-pi.ts / FakeFixer)  [A] reflexive edits
```

The six non-negotiables from `goal-loop.md §7` map 1:1: harness runs the gate (`gates.ts`), sequence build→tests (`controller.ts`), detect repeats & change strategy (`stuck.ts`+`strategy.ts`), budget+cap+escalate (`controller.ts`), protected files + diff-guard (`diff-guard.ts`), state+checkpoints on disk (`ledger.ts`+`checkpoint.ts`).

---

## New CLI surface (`src/cli.ts` + `src/commands/fix.ts`)

```
bspec fix [--project <dir>]
  --build-cmd <cmd>        override fix.json build.cmd
  --test-cmd  <cmd>        override fix.json test.cmd
  --agent <selector>       model selector (reuses resolveAgentSelector)
  --max-iters <n>          iteration cap (default 12)
  --token-budget <n>       token ceiling (default 2_000_000)
  --yes                    skip the start confirmation (unattended)
  --no-checkpoint          disable checkpoints (discouraged; warns)
```
Registered in `src/cli.ts` with the existing `commander` pattern (mirrors the `build` command wiring at `src/cli.ts:58-73`).

---

## Config & state on disk

**Config (read each run):** `<project>/.bspec/fix.json`, validated with a new zod schema in `src/lib/fix/config.ts` (mirrors `src/config.ts` `configSchema`):
```jsonc
{
  "build": { "cmd": "npm run build" },
  "test":  { "cmd": "npm test" },
  "protected": ["**/*.test.*","**/*.spec.*","tests/**","spec/**","**/conftest.py","**/vitest.config.*","**/jest.config.*"],
  "maxIters": 12,
  "tokenBudget": 2000000
}
```
Resolution order per field: CLI flag → `fix.json` → optional `SPEC.md` `## Verification` section → built-in default (protected globs have a sane default; build/test cmd are **required** — error clearly if absent, suggesting `bspec fix` flags). Keep this separate from the global `~/.bspec/config.json` (planner model only).

**State (the ledger / "spine"):** `<project>/.bspec/fix/`:
- `ledger.json` — iterations[], tried signatures, counters, per-iteration `{phase, signature, strategy, model, tokensUsed, outcome, touchedProtected, checkpointRef}`.
- `ledger.md` — human-readable run log (the handoff artifact on escalation).
- `snapshots/<label>/outputs.tar.gz` — checkpoint payloads when not a git repo.
- `logs/iter-<n>.log` — full gate output per iteration.

---

## Module-by-module plan (small files, per coding-style rules; heavy reuse)

**`src/lib/fix/gates.ts`** — deterministic verification.
- `runGate(cmd, cwd, timeoutMs): Promise<GateResult>` (`{ ok, code, log, durationMs }`). Use async `spawn` via a shell, capturing stdout+stderr — reuse the spawn pattern in `src/lib/blocks.ts:16-33` (`runBlock`); do **not** introduce `execSync`.
- `buildGate`/`testGate` thin wrappers over config commands. The **sequence** (build green before test is in scope, `fix-loop §5.1`) lives in the controller.

**`src/lib/fix/stuck.ts`** — progress/oscillation detection (`fix-loop §5.2`, §6 Tier-2).
- `failureSignature(phase, log): string` = `sha256Hex(phase + firstFailingLine.replace(/[0-9]+/g,'#')).slice(0,12)` — reuse `sha256Hex` from `src/lib/hash.ts`. Normalizes line/col so the same failure hashes equal.
- `StuckDetector` (pure class): tracks last N signatures; `repeat>=2` ⇒ stuck; `A,B,A,B` (6 window) ⇒ ping-pong.
- `isStuckEvents(events)` — ports the `fix-loop §6` event primitive over `(tool,args,thought)` tuples for **mid-run** detection from the Pi event stream.

**`src/lib/fix/strategy.ts`** — escalation ladder (`fix-loop §5.3`), pure.
- `nextStrategy(state) → { directive, restoreCheckpoint, model }` cycling: `force-diagnose → minimal-fix → fresh-start(restore) → switch-model`, then `ESCALATE`. Model switch resolves a fallback via `resolveAgentSelector`/`pickDefaultModel`.

**`src/lib/fix/ledger.ts`** — on-disk state, immutable updates (return new state, per coding-style). Load/append iteration records; render `ledger.md`.

**`src/lib/fix/checkpoint.ts`** — snapshot/rollback (`fix-loop §5.7`). `Checkpointer { snapshot(): Promise<Ref>; restore(ref): Promise<void> }` with two impls auto-selected by presence of `.git`:
- `GitCheckpointer` — `git rev-parse HEAD` / `git add -A && git commit` / `git reset --hard <ref>`.
- `SnapshotCheckpointer` — tar the working tree into `.bspec/fix/snapshots/<label>/` reusing `createTarGz`/`extractTarGz` from `src/lib/archive.ts`.

**`src/lib/fix/diff-guard.ts`** — anti-reward-hacking (`fix-loop §5.5`). `changedFiles(cwd, sinceRef)` (git diff, or snapshot hash compare) ∩ protected globs ⇒ list of violations. Controller **reverts** the iteration and records `REJECTED(touched tests)` when non-empty. Secondary (non-blocking in v1): `scanSourceTells(diff)` flags added `skip`/`xfail`/`.only`/weakened asserts.

**`src/lib/fix/fixer.ts`** — the testability seam (mirrors `BlockAuthor` in `src/lib/block-author.ts:33-37`).
```ts
interface Fixer { fix(input: FixInput): Promise<FixResult>; provenance?(): PlannerProvenanceInfo }
```
`FixInput = { cwd, phase, gateCommand, failureLog(trimmed), triedSummary, directive, protectedGlobs, model }`; `FixResult = { tokensUsed, summary }`.

**`src/lib/fix/fixer-pi.ts`** — `PiFixer` (the real, **tool-enabled** session). Reuse the construction pattern from `src/lib/planner-pi.ts:101-150` (`loadPi`, `AuthStorage`, `ModelRegistry`, `DefaultResourceLoader`, `createAgentSession`, `resolveModel`) with these deliberate differences:
- `cwd: <project>` (so file tools act on the target).
- Tools **enabled**: default built-ins minus shell — `excludeTools: ["bash"]` so the agent edits via `read/edit/write` but can't run arbitrary commands or spoof the gate (configurable).
- Allow project context (do **not** set `noContextFiles:true`) so an existing `AGENTS.md`/repo conventions inform fixes; bspec still injects the hard rules via system prompt + per-turn directive regardless.
- System prompt = the `fix-loop §6` contract ("never edit/skip/weaken tests; fix the implementation; smallest change; diagnose root cause first"). Per-turn prompt = focused: current phase, the one gate command, trimmed current failure only, the ledger of what's been tried, the strategy directive (`fix-loop §5.6`). Reuse the repair/prompt-render style from `block-author-pi.ts:187-212`.
- Subscribe to the `AgentSessionEvent` stream for token accounting and `isStuckEvents` mid-run.

**`test/helpers/fake-fixer.ts`** — `FakeFixer` mirroring `FakeBlockAuthor` (`test/helpers/fake-block-author.ts`): scripted file mutations applied to the temp project, records inputs. Makes the whole controller testable offline.

**`src/lib/fix/controller.ts`** — the outer loop. Pure orchestration over the injected `Fixer`, `Checkpointer`, gates, detectors, ledger — directly realizing `fix-loop §6` Tier-1 logic, embedded and event-aware. Returns `FixResult = { status: "success" | "escalated", reason?, ledger }`.

**`src/commands/fix.ts`** — parse opts; resolve project + config; resolve agent (`resolveAgentSelector` from `src/lib/agent.ts`); **confirm start** unless `--yes` (reuse `makeAsker` from `src/commands/build.ts:494-508`) with a sandbox warning; pick checkpointer; build `PiFixer` (or injected fake); run controller; print per-iteration lines + final summary / escalation report. Errors via `BspecError` (`src/lib/errors.ts`), surfaced by the existing `cli.ts` catch.

---

## Implementation phases (TDD — tests first per rules)

1. **Config + schema** — `src/lib/fix/config.ts` + zod; resolution order; unit tests for parse/required-field errors.
2. **Deterministic core (pure, no Pi):** `gates.ts`, `stuck.ts` (signature + detector), `strategy.ts`, `diff-guard.ts`, `ledger.ts`, `checkpoint.ts`. Unit-test each in isolation (this is the bulk of correctness and is fully offline).
3. **Fixer seam:** `fixer.ts` interface + `test/helpers/fake-fixer.ts`.
4. **Controller:** `controller.ts` wired over the deterministic core + `FakeFixer`. Integration tests (below).
5. **Real Pi fixer:** `fixer-pi.ts` (tool-enabled session, event stream). Behind the same interface; covered by the optional live test.
6. **Command + CLI:** `src/commands/fix.ts`, register in `src/cli.ts`, start-confirmation + summary output.
7. **Docs:** short `## Verification`/fix section in DESIGN.md + a sample `.bspec/fix.json`.

---

## Testing plan (Bun `bun test`; `BSPEC_HOME`/tmp dirs; offline; optional live behind env — matches existing conventions)

- **Unit:** gate exit-code capture (spawn a scripted pass/fail command); `failureSignature` normalization; `StuckDetector` repeat + ping-pong; `strategy` ladder transitions incl. switch-model; `diff-guard` glob intersection; `ledger` immutable append/render; `SnapshotCheckpointer` tar round-trip (via `archive.ts`); config parsing.
- **Integration (FakeFixer, no network):** (a) temp project with a known bug that `FakeFixer` repairs in N scripted edits → reaches green + commits; (b) `FakeFixer` edits a protected test file → iteration rejected **and reverted**, no false "green"; (c) no-progress `FakeFixer` → escalates after the ladder, ledger written; (d) iteration-cap and token-budget exits hit cleanly.
- **Optional live (`BSPEC_LIVE=1`):** `PiFixer` drives a tiny intentionally-broken project to green. Mirrors `test/integration/planner-live.test.ts`.
- Target ≥80% coverage on the deterministic modules.

---

## Risks & mitigations

- **HIGH — Sandboxing.** Runs the project's build/test (arbitrary code) repeatedly **and** lets Pi edit files on the host (`fix-loop §6`: Pi has no built-in sandbox). Mitigate: explicit start confirmation; `--project` isolation; checkpoints + auto-revert; `excludeTools:["bash"]`; strong docs to run in a container/disposable checkout.
- **HIGH — Reward hacking** (METR ~30%+; `fix-loop §5.5`). The objective invites it. Mitigate: diff-guard **revert** is the primary, unspoofable enforcement (SDK can't do path-level tool denial, so this is essential); default protected globs; secondary source-tell scan; optional held-out final verify from a clean copy (note as a v1.1 follow-up).
- **MEDIUM — Tool-enabled Pi session is new** in bspec. Confirm exact event field for token usage and finalize `excludeTools` semantics during phase 5 (surface confirmed: `cwd`, `read/bash/edit/write`, `AgentSessionEvent`).
- **MEDIUM — Over-aggressive stuck detection** killing slow-but-valid work (`fix-loop §4D`, OpenHands #5355). Mitigate: compare on **semantic** signatures (not wall-clock), generous gate timeouts/budgets.
- **MEDIUM — Generic projects lack `.bspec`/SPEC.md.** Clear "no build/test command found" error pointing at `fix.json`/flags; flags alone are sufficient to run.
- **LOW — Bun host vs target toolchain.** Gates spawn the target's own commands; unaffected by bspec running under Bun.

---

## Verification (end-to-end, once built)

1. `bun test` green; `bun run typecheck` clean.
2. Offline demo: create a temp project with a failing build then a failing test, a `.bspec/fix.json`, and run `bspec fix --project <tmp> --yes` with the **FakeFixer** wired (test harness) → observe sequenced build→test, green, commit, and `ledger.md`.
3. Reward-hack check: script the fake to edit a `*.test.*` file → confirm the iteration is reverted and the run does not report success.
4. Optional live: `BSPEC_LIVE=1 bspec fix --project <tiny-broken-project> --agent anthropic/claude-opus-4-8` drives it to green.

---

## Out of scope (v1)
- Folding fixes back into bspec blocks/plans/cache (this is the *generic* loop, by decision).
- Held-out clean-checkout verification and the LLM "critic" anti-hack pass (note as v1.1).
- Tier-3 Pi extension packaging and parallel worktree sub-agents (`fix-loop §4C`).
- A `bspec fix init` config generator (manual `fix.json`/flags for now).
