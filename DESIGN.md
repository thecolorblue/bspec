# `bspec` — a step-caching app harness (design)

A bash CLI that turns a plain-language `SPEC.md` into a working app by planning it into
cached, tested, shareable **blocks**.

**The AI is a picker, not a builder.** It is used in exactly one place — turning your spec into a
plan by choosing prebuilt blocks and filling in their settings. Every file that ends up in your app
comes from a block a human wrote and tested. Building is fully deterministic: no model calls, no
surprises, instant and repeatable. `BSPEC_AGENT` points at whatever model does the planning.

---

## 1. What a "block" (step) is

A block is **one self-describing executable file**. Every block honors the same contract:

| Flag | Meaning |
|---|---|
| `--manifest` | print JSON metadata (id, version, summary, params, produces, needs). No side effects. |
| `--apply <out_dir> <params.json>` | template files into `out_dir` from the given settings |
| `--test` | run the block's own self-test in a throwaway dir; exit 0 if healthy |

This single format satisfies all three goals at once: **simple** (no schema engine — a script that
dispatches on `$1`), a **single shareable file** (`curl` it, drop it in the registry), and
**independently testable** (`./block.sh --test`).

Every block is deterministic: same settings in, same files out, every time.

### Example block (real, runnable)

```bash
#!/usr/bin/env bash
set -euo pipefail

manifest() { cat <<'JSON'
{ "id":"chrome-extension-boilerplate", "version":"1.2.0",
  "summary":"Minimal Manifest V3 Chrome extension skeleton.",
  "params":{ "name":{"type":"string","required":true} },
  "produces":["manifest.json","popup.html","popup.js","background.js"], "needs":[] }
JSON
}

apply() {  # $1=out_dir  $2=params.json
  local out="$1" name; name="$(jq -r .name "$2")"; mkdir -p "$out"
  jq -n --arg n "$name" '{manifest_version:3,name:$n,version:"0.1.0",
    action:{default_popup:"popup.html"},background:{service_worker:"background.js"}}' > "$out/manifest.json"
  printf '<!doctype html><body><h1>%s</h1><script src="popup.js"></script>' "$name" > "$out/popup.html"
  : > "$out/popup.js"; : > "$out/background.js"
}

selftest() {  # proves the block works on a canonical input
  local t; t="$(mktemp -d)"; echo '{"name":"Test"}' > "$t/p.json"
  apply "$t/out" "$t/p.json"
  jq -e '.manifest_version==3' "$t/out/manifest.json" >/dev/null
  test -f "$t/out/popup.html" && echo ok
}

case "${1:-}" in
  --manifest) manifest;; --apply) apply "$2" "$3";; --test) selftest;;
  *) echo "usage: $0 --manifest|--apply <out> <params.json>|--test" >&2; exit 2;;
esac
```

Blocks can carry logic too, as long as it's templated, not generated. A `popup-button` block might
take `{ "label":"Save tab", "action":"save-current-tab" }` and stamp out a button wired to a known,
prebuilt action from a fixed catalog. The author tested it once; everyone reuses it.

### Why this format over the alternatives

- **A plain tarball/patch per block** is close to viable now that everything is deterministic, but
  it can't take settings, can't describe itself, and can't self-test. The self-describing file is a
  strict superset (a block can still embed a tarball internally if it wants).
- **A git repo per block** gives versioning for free but is a heavier sharing unit than one file.
  Keep git for the *registry*, not for each block.

---

## 2. The two decisions: which block, and run-or-replay

These are separate, and keeping them apart is the whole design.

**Which block? (fuzzy — the planner AI)** The planner reads your spec on one side and a menu of
every block's one-line `summary` on the other, and matches them by meaning. A spec piece that
matches an existing block reuses it; a piece that matches nothing becomes a request for a new block
(which a developer writes, see §5). Matching is semantic, so "build a chrome extension" and "set up
an extension skeleton" both land on the same block — you'd never get that from string-matching.

**Run or replay? (exact — the runner)** Once the plan names a block + settings, the runner builds a
fingerprint and looks it up:

```
cache_key = sha( block_id + version + normalized_params + sorted(hashes of `needs` outputs) )
```

Seen this exact fingerprint → the runner **replays**: it drops in the saved files instantly without
executing the block. Never seen it → the runner **runs** the block's script (cheap and
deterministic) to generate a new step, then saves the result under that key. So throughout `bspec`,
**replayed** means a step served from cache and **ran** means a step generated fresh. A block can
exist in the registry and still need to *run* this time, simply because the settings are new.

Because the key folds in upstream output hashes, changing one block's settings automatically
re-runs only the blocks downstream of it. You never clear the cache by hand.

Note: since building is deterministic and fast, the cache is now a convenience, not a necessity. Its
real jobs are instant cross-app reuse of identical outputs, provenance, and partial rebuilds — not
saving expensive work.

---

## 3. Architecture & layout

```
~/.bspec/
  blocks/                        # registry — single-file shareable blocks
    chrome-extension-boilerplate.block.sh
    popup-button.block.sh
  cache/<key>/{outputs.tar,meta.json}
  config                         # BSPEC_AGENT (planner model), registry remotes

myapp/
  SPEC.md                        # source of truth (human-authored, plain language)
  .bspec/
    plan.json                    # the build plan (blocks + settings + needs + pinned versions)
    build.json                   # provenance: each output file -> block@version + cache key
    snapshots/<label>/           # undo checkpoints
    logs/<block-id>.log
  dist/                          # the actual built app
```

Four components: **planner** (AI: SPEC → `plan.json`, the only AI in the system), **registry** (the
blocks dir), **runner** (deterministic: cache-check → apply → record provenance), and **block
self-tests** (run when a block is published, to keep the registry healthy).

`plan.json`:
```json
{ "spec_hash":"…",
  "steps":[
    {"id":"chrome-extension-boilerplate","version":"1.2.0","params":{"name":"Tab Saver"},"needs":[]},
    {"id":"popup-button","version":"1.0.0","params":{"label":"Save tab","action":"save-current-tab"},"needs":["chrome-extension-boilerplate"]}
  ] }
```

`build.json` (provenance — the key to debugging):
```json
{ "outputs":{
    "manifest.json":{"by":"chrome-extension-boilerplate@1.2.0","cache":"a1b2"},
    "popup.js":{"by":"popup-button@1.0.0","cache":"f9e8"}
} }
```

---

## 4. CLI surface

**Authoring & building**
- `bspec init` — guided interview that writes a first `SPEC.md` (see §5).
- `bspec plan` — SPEC → `plan.json`; prints the plan in plain English and pauses for any clarifying questions before you approve.
- `bspec build [--resume]` — execute the plan; per block: cache-check → run/replay → record provenance.
- `bspec preview` / `bspec run` — actually launch the app so the user *sees* it.
- `bspec ship` — package for real use (zipped extension + load instructions, or deploy).

**Blocks & cache**
- `bspec blocks list|add|test|publish|pull` — manage/share the registry (`test --all` for CI).
- `bspec cache ls|verify|prune|clear [<block>]` — inspect/maintain saved outputs.

**Build & cache output**

`bspec build` prints one line per block — a plain-language progress phrase, the block's
`id@version`, a `[replayed]` or `[ran]` tag, and the resulting cache key — then a one-line summary.
`[replayed]` means the step was served from cache (no execution); `[ran]` means the step was
generated fresh and saved. The summary counts both:

```
$ bspec build
Setting up your extension…           chrome-extension-boilerplate@1.2.0  [replayed]  → a1b2
Adding the Save button…              popup-button@1.0.0                  [replayed]  → c3d4
Done. 2 blocks built (2 replayed, 0 ran).
```

`bspec cache ls` lists every saved entry — including superseded builds kept for instant reuse — by
cache key, block, version, and status. Below, the current plan uses `c3d4` for `popup-button`, while
`f9e8` (the previous `"Save tab"` build) is retained so reverting that change would replay rather
than run:

```
$ bspec cache ls
KEY    BLOCK                          VERSION  STATUS
a1b2   chrome-extension-boilerplate   1.2.0    fresh
f9e8   popup-button                   1.0.0    fresh      ← old "Save tab" build, still cached
c3d4   popup-button                   1.0.0    fresh      ← new "Keep" build
```

**Change & repair (non-technical front door)**
- `bspec change "<plain English>"` — re-plan the affected block(s) and rebuild just those.
- `bspec fix "<symptom>"` — symptom-driven diagnosis (see §5). *(Distinct from the implemented generic build/test repair loop — see §7.)*
- `bspec undo` / `bspec snapshot <label>` / `bspec restore <label>` — checkpoints.
- `bspec diff` — what changed between builds, in plain language.
- `bspec explain [<file|block>]` — what this does, in plain language.
- `bspec report` — bundle logs + plan + provenance into a shareable report for a developer.

---

## 5. Non-technical UX

### How a user *communicates* what to build

`bspec init` runs an **interview** (the planner asks: what does it do, who uses it, the main
screens/actions, must-haves vs nice-to-haves, any app it should resemble, what data it keeps) and
writes a structured-but-plain `SPEC.md`:

```
# Overview          one paragraph: what & why
# Users             who uses it
# Features          plain wishes — "I want a button that saves my current tab"
# Screens           the few views and what's on them
# Data              what it remembers, and where
# Acceptance        plain checks — "After I click Save, my tab is in the list"
# References         links/screenshots of apps it should resemble
# Out of scope       what NOT to build
```

Here the **Acceptance** lines mostly help confirm the *plan* picked the right blocks and settings —
they're how the user sanity-checks the plan in plain words before building. When `bspec plan` hits
ambiguity, it asks rather than guessing.

### What a user wants from an app builder

- **See it working now** — `bspec preview` launches the app. Seeing beats reading.
- **Plain language everywhere** — progress as "Setting up your extension… Adding the Save button… Done," never stack traces.
- **Undo and checkpoints** — they will break things and panic; `bspec undo` and named snapshots are psychological infrastructure.
- **Describe changes in English** — `bspec change "make the Save button say 'Keep'"`; the planner adjusts the settings and the rebuild is instant.
- **Honesty about limits** — show what each block does and what the app can/can't do. Builds are free and instant; the one small AI cost is planning.
- **Drift protection** — if they hand-edited a built file, detect it (output hash ≠ provenance) and warn before a rebuild overwrites it.
- **A clear "I'm stuck" path** — `bspec report` produces something a developer can act on.

### Debugging — only two things can go wrong

Because every file comes from a tested, deterministic block, a "bug" is always one of two things,
and provenance (`build.json`) tells you which block produced the broken file:

1. **Wrong block or wrong settings (a plan error).** The block works, it was just the wrong choice
   for what the user wanted. This is the *common* case and the *fixable-by-the-user* case: they say
   what's wrong in plain words (`bspec fix "the button does nothing"`), the planner re-plans that
   piece (different block, or different settings), and the deterministic rebuild is instant. To tell
   it's a plan error: the block's own `--test` still passes.

2. **The block's template is broken (a template error).** The block fails its own `--test`, or
   produces valid-but-wrong output. A non-technical user can't fix this — it escalates via
   `bspec report` to a developer, who fixes the shared block, **adds the reported symptom as a new
   regression test**, and publishes it as a new version. Every app that pulls the new version gets
   the fix; apps stay pinned to their version until they opt in, so one fix can't silently break
   another app.

The payoff of dropping AI from the build: the bug surface is tiny and predictable. Most problems are
"wrong choice in the plan," which is exactly the kind a non-technical user can fix by re-describing.

---

## 6. Suggested build order

1. **v0** — block contract + folder-to-block authoring + a hand-written linear plan + `build`/`preview`. Prove caching and the single-file format end-to-end. No AI yet (you write `plan.json` by hand). The anchoring capability is turning an existing folder of files into a block and replaying it into another folder:
   - `bspec blocks add <folder> --summary "<description>"` snapshots every file under `<folder>` into one self-describing block. The files ride along as an embedded tarball (the superset escape hatch from §1), and the generated manifest fills itself in: `id` (defaults to the folder name, overridable with `--id`), a starting `version`, the `--summary` text as `summary`, `params:{}`, `produces` set to the snapshotted file list, and `needs:[]`. On `--apply`, the block simply copies its embedded files into `out_dir`. This lets a user author a working block without hand-writing the dispatch script.
   - In a *separate* folder, hand-write a `plan.json` with one step naming that block (no `params`, empty `needs`).
   - `bspec build` runs the block's `--apply`, copying the snapshotted files into the new app's `dist/`; provenance and the cache key are recorded as usual. Running `bspec build` again confirms the step comes back `[replayed]` from cache rather than `[ran]`.

   That loop — snapshot a folder into a block, plan it, build it, see real files land in another folder, then watch a re-run turn into a replay — is the smallest end-to-end proof of the single-file format and the cache.
2. **v1** — planner AI (SPEC → plan) + `bspec plan` with plain-English review and clarifying questions + provenance (`build.json`).
3. **v2** — non-technical layer: `init` interview, `change`, `fix`, `undo`/snapshots, `report`, drift detection.
4. **v3** — dependency-graph rebuilds (parallel independent blocks), registry remotes (`blocks publish/pull`), shared-block versioning policy.

---

## 7. `bspec fix` — self-correcting fix-until-green loop

> The implemented, **generic** repair loop: `bspec fix --project <dir>` drives *any* project's own
> build and test commands to a clean exit by letting Pi edit files, under a deterministic controller
> that owns the stop condition. It is distinct from the v2 non-technical `change`/`fix "<symptom>"`
> front-door (§5) and does not touch bspec's blocks, plans, or cache.

Unlike planning — where the AI is a *picker* — here Pi runs as a **tool-enabled** agent bound to the
project directory, editing files with `read`/`edit`/`write` (shell is off by default, so it cannot
run, let alone spoof, the gate). The model never decides "done": the harness runs the gate and reads
exit codes.

### The loop

1. **Sequence the gates.** Drive the **build** command to exit 0 first; only then is the **test**
   command in scope. Each iteration re-runs the build, so a test-phase edit that breaks it is caught
   and repaired before tests resume.
2. **Detect stalls, escalate strategy.** A normalized signature of the current failure feeds a
   stuck-detector (same failure repeated, or an A,B,A,B ping-pong). On a stall the loop climbs a
   ladder — force-diagnose → minimal-fix → fresh-start (restore the last green build) → switch model —
   instead of re-running an identical attempt. Past the ladder it escalates to a human.
3. **Guard the tests (anti-reward-hacking).** After every iteration a diff-guard compares a content
   hash of the working tree against the pre-iteration snapshot; if the edit touched any **protected**
   file (tests, specs, runner configs), the whole iteration is **reverted** and recorded as rejected.
   This revert — not the prompt — is the primary, unspoofable defense.
4. **Checkpoints (files-only, never git).** The loop snapshots the working tree to
   `.bspec/fix/snapshots/` (a tar + a hash manifest) and reverts by overwriting from it. It never
   commits, resets, or cleans git — your branch, history, and stashes are untouched. Run in a
   disposable checkout anyway; uncommitted work may be overwritten by a revert.
5. **Hard budget.** An iteration cap and a token ceiling bound every run; on exhaustion the loop
   escalates with a written handoff.

State lives on disk — `.bspec/fix/ledger.json` plus a human-readable `ledger.md` (the handoff
artifact), and per-iteration gate logs under `.bspec/fix/logs/`.

### Configuration — `<project>/.bspec/fix.json`

```jsonc
{
  "build": { "cmd": "npm run build" },   // required (or --build-cmd / SPEC.md ## Verification)
  "test":  { "cmd": "npm test" },        // required (or --test-cmd  / SPEC.md ## Verification)
  "protected": [                         // never editable by the fixer (default shown)
    "**/*.test.*", "**/*.spec.*", "tests/**", "spec/**",
    "**/conftest.py", "**/vitest.config.*", "**/jest.config.*"
  ],
  "maxIters": 12,                        // iteration cap
  "tokenBudget": 2000000,                // token ceiling
  "buildTimeoutMs": 300000,              // per build-gate run
  "testTimeoutMs": 600000,               // per test-gate run
  "allowShell": false,                   // true → let the agent run shell commands
  "snapshotIgnore": [".git", "node_modules", ".bspec", ".DS_Store", "dist", ".next", "build"]
}
```

Resolution per field: **CLI flag → `fix.json` → SPEC.md `## Verification` → built-in default.** Build
and test commands are required (no default); their absence is a clear error. The SPEC.md fallback:

```md
## Verification
- build: `npm run build`
- test: `npm test`
```

### CLI

```
bspec fix [--project <dir>]
  --build-cmd <cmd>     override fix.json build.cmd
  --test-cmd  <cmd>     override fix.json test.cmd
  --agent <selector>    model selector (e.g. anthropic/claude-opus-4-8)
  --max-iters <n>       iteration cap
  --token-budget <n>    token ceiling
  --yes                 skip the start confirmation (unattended)
```

A sample config lives at `examples/fix.json`.
