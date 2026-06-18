# v1_TESTING_PLAN.md — Real-World Test Plan for bspec v1 (The AI Planner)

A step-by-step script for **thoroughly** validating bspec v1 against a **live model**
through Pi, end to end: `SPEC.md` → `bspec plan` (real LLM) → review/approve →
`bspec build` (deterministic) → replay → `preview`, plus every failure path the
spec promises.

Reference: [BSPEC_v1_SPEC.md](./BSPEC_v1_SPEC.md). This plan maps directly to that
document's **Definition of Done** (§ "Definition of Done", items 1–8).

> **What "real-world test" means here.** Unlike `bun test` (which injects
> `FakePlanner` and never touches the network), this plan exercises the **real
> `PiPlanner`** calling a real provider with **tools disabled**. It proves the
> "AI is a picker, not a builder" guarantee on live output, not canned output.

---

## 0. Preconditions — implementation status (read first)

This plan assumes v1 is **fully implemented**. The live path is now wired: the Pi
adapter, validation pipeline, `bspec plan`, `bspec config models`, and the
fixtures all exist, and a live `plan → build → replay` run has been verified
against a real model. Confirm each of the following exists before running the
live sections; if any is missing, that is a **test blocker**, not a test failure.

| Needed for live test | Spec ref | Exists today? | Check |
|---|---|---|---|
| `@earendil-works/pi-coding-agent` installed | Stack | ✅ v0.76.0 | `ls node_modules/@earendil-works` |
| `src/lib/planner-pi.ts` (`PiPlanner`) | Pi adapter | ✅ | `test -f src/lib/planner-pi.ts` |
| `src/lib/plan-validate.ts` (validation pipeline) | Validation | ✅ | `test -f src/lib/plan-validate.ts` |
| `bspec plan` wired into `src/cli.ts` | plan command | ✅ | `bun run bspec -- plan --help` |
| `bspec config models` subcommand | config | ✅ | `bun run bspec -- config models` |
| `test/fixtures/greeting-page.block.ts` | Fixtures | ✅ | `test -f test/fixtures/greeting-page.block.ts` |
| `examples/SPEC.md` + `test/fixtures/spec/SPEC.md` | Fixtures | ✅ | `test -f examples/SPEC.md` |
| Pi auth present | Platform | ✅ `~/.pi/agent/auth.json` | `test -f ~/.pi/agent/auth.json` |
| Bun on PATH | Platform | ✅ | `bun --version` |

Run the readiness probe:

```bash
echo "bun:        $(bun --version 2>/dev/null || echo MISSING)"
echo "pi sdk:     $(ls node_modules/@earendil-works 2>/dev/null || echo MISSING)"
echo "pi auth:    $(test -f ~/.pi/agent/auth.json && echo present || echo MISSING)"
test -f src/lib/planner-pi.ts   && echo "PiPlanner:  ok" || echo "PiPlanner:  MISSING"
test -f src/lib/plan-validate.ts && echo "validate:   ok" || echo "validate:   MISSING"
bun run bspec -- plan --help >/dev/null 2>&1 && echo "plan cmd:   ok" || echo "plan cmd:   MISSING"
```

If anything reads `MISSING`, finish that implementation before continuing past
Section 3.

---

## 1. Environment isolation (never touch the real home)

All state lives under a throwaway `BSPEC_HOME` so your real `~/.bspec` and `dist/`
are untouched. Run every command below from the repo root.

```bash
cd /Users/brad/Documents/bspec

export BSPEC_HOME="$(pwd)/.tmp/bspec-home"
export TESTDIR="$(pwd)/.tmp/realworld"
rm -rf "$BSPEC_HOME" "$TESTDIR"
mkdir -p "$BSPEC_HOME/blocks" "$TESTDIR"

export BSPEC_AGENT="anthropic/claude-opus-4-5"

echo "HOME=$BSPEC_HOME"
echo "AGENT=$BSPEC_AGENT"
```

> **Why this matters:** the spec requires `bspec build` to be fully offline and
> deterministic and `bspec plan` to be the *only* networked command. Isolating
> `BSPEC_HOME` lets you prove cache `[ran]`/`[replayed]` behavior without
> interference from prior runs.

**PASS:** both directories exist and are empty; `BSPEC_AGENT` is a model you can
authenticate (verified in Section 4).

---

## 2. Automated test suite (the deterministic floor)

Before any live call, the offline suite must be green. This proves backward
compatibility and the fake-planner-driven integration paths.

```bash
bun run typecheck          # tsc --noEmit — must be clean
bun test                   # all unit + integration tests, no network
```

**PASS criteria**
- `typecheck` exits 0 with no errors.
- `bun test` is fully green. In particular confirm these spec-mandated cases ran
  (grep the output / test files):
  - `spec_hash` stable for identical content, changes on edit.
  - Block-menu builder returns `{id,version,summary,params,produces}` and omits
    payloads.
  - `plannerOutputSchema` accepts valid / rejects missing `summary`, non-empty
    `needs`, wrong types.
  - Selector precedence flag > env > file > default.
  - Validation pipeline: fence stripping, hallucinated id, version mismatch,
    param errors (missing required / unknown / type / enum), non-empty `needs`.
  - Integration: plan→build, param-fill→`dist/index.html`, clarifying loop, gaps,
    semantic-failure (no `plan.json`, leaves `plan.log`), approval gate,
    `--answers`+`--yes`, **v0 handwritten `plan.json` still builds**, full
    plan→build`[ran]`→build`[replayed]`→preview.

> If the live path isn't implemented yet, **stop here** — Sections 4–10 require it.
> Sections 1–3 plus this suite already validate everything that does not need a model.

---

## 3. Install the block registry (the menu the planner picks from)

Install both block kinds so the planner has a real, non-trivial menu: the v0
empty-param folder snapshot and the v1 parameterized block.

```bash
# v0 folder-snapshot block (empty params).
bun run bspec -- blocks add ./test/fixtures/hello-extension-source \
  --id hello-extension --version 0.1.0 \
  --summary "A minimal browser-extension hello popup"

# v1 hand-written parameterized block (reads params.json on --apply).
cp ./test/fixtures/greeting-page.block.ts "$BSPEC_HOME/blocks/greeting-page.block.ts"
chmod +x "$BSPEC_HOME/blocks/greeting-page.block.ts"

# Prove the registry is healthy.
bun run bspec -- blocks list
bun run bspec -- blocks test greeting-page
bun run bspec -- blocks test hello-extension
```

**PASS criteria**
- `blocks list` shows **both** blocks with correct ids/versions/summaries.
- `blocks test greeting-page` prints `ok` (its self-test renders a title).
- `blocks test hello-extension` passes.

---

## 4. Model selection & secret hygiene (`config`)

Validates Definition-of-Done item 1: model resolves from flag/env/file/default and
`config models` lists Pi-available models **without leaking secrets**.

```bash
# Resolution + source reporting.
bun run bspec -- config get
#   expect: "agent: anthropic/claude-opus-4-5 (from $BSPEC_AGENT)"

# Precedence: flag should win over env (if --agent on plan is supported, test there;
# otherwise confirm env beats file):
unset BSPEC_AGENT
bun run bspec -- config set-agent anthropic/claude-opus-4-8
bun run bspec -- config get        # -> "(from config.json)"
export BSPEC_AGENT="anthropic/claude-opus-4-5"
bun run bspec -- config get        # -> env wins again

# The model picker — must list ONLY auth-valid models, and NO secrets.
bun run bspec -- config models | tee "$TESTDIR/models.txt"
```

**PASS criteria**
- `config get` labels the source correctly as you change precedence.
- `config models` lists at least one model and your chosen `BSPEC_AGENT` appears.
- **Secret hygiene:** the output contains **no** API keys/tokens. Verify:

```bash
grep -Ei 'sk-|api[_-]?key|bearer|secret|token|authorization' "$TESTDIR/models.txt" \
  && echo "FAIL: possible secret leaked" || echo "PASS: no secret-looking strings"
```

---

## 5. Write a real-world SPEC.md (richer than the demo)

A genuine test uses prose that maps onto **multiple** blocks, includes a **gap**
(a wish no block satisfies), and contains a mild ambiguity that *may* trigger a
clarifying question. Write it into the demo project.

```bash
cat > "$TESTDIR/SPEC.md" <<'EOF'
# Overview
A tiny personal landing site for a side project called "Tab Saver", plus a
companion browser-extension hello popup. Keep it minimal and static.

# Users
Me, and people I send the link to.

# Features
- I want a landing page whose big heading reads "Tab Saver" and shows a short,
  friendly welcome message under it.
- I want a minimal browser-extension hello popup to go alongside it.
- I'd like visitors to be able to sign in so I can greet them by name.

# Screens
- The landing page (heading + welcome line).
- The extension popup.

# Data
Nothing persistent for now.

# Acceptance
- The landing page heading reads exactly "Tab Saver".
- There is an extension popup file in the output.

# Out of scope
- Any backend or database.
EOF

cp "$TESTDIR/SPEC.md" "$TESTDIR/SPEC.copy.md"   # for spec_hash determinism check
```

Design intent of this spec (what each line is *meant* to exercise):
- "heading reads Tab Saver" + "welcome message" → **greeting-page** with filled
  `title` (required) and `message` params.
- "browser-extension hello popup" → **hello-extension** (empty params).
- "sign in / greet by name" → **gap** (no auth block in the menu).
- The welcome wording is unspecified → the planner *may* ask a clarifying
  question about the `message` value (Section 7 covers both branches).

---

## 6. The real-world live plan (the core test)

This is the headline run: a **live** model call with tools disabled.

```bash
bun run bspec -- plan --project "$TESTDIR"
```

Walk the interactive flow:
1. Header prints the model and its source, e.g.
   `Planning from SPEC.md using anthropic/claude-opus-4-5 (from $BSPEC_AGENT)…`
2. If it asks clarifying questions → see **Section 7**, answer, let it re-plan.
3. It prints a plain-English plan with filled params and a "Not covered by any
   block" gaps section.
4. At `Write this plan? [y/N]` → first answer **n** to test the gate (Section 8),
   then re-run and answer **y** to write.

**PASS criteria for the approved run**
- Plan lists **greeting-page@1.0.0** with `title: "Tab Saver"` and some `message`.
- Gaps section names the sign-in/auth wish (mapped to **no** block — it must NOT
  be approximated by an unrelated block).
- After `y`: `Wrote .../.bspec/plan.json` then `Run: bspec build --project …`.

Inspect the written plan:

```bash
cat "$TESTDIR/.bspec/plan.json"
```

**Assert on `plan.json` (Definition-of-Done items 3, 4, 5 provenance):**

```bash
PLAN="$TESTDIR/.bspec/plan.json"
bun -e '
  const p = require("'"$PLAN"'");
  const ok = [];
  ok.push(["spec_hash present", typeof p.spec_hash === "string" && p.spec_hash.length === 64]);
  ok.push(["has greeting-page step", p.steps.some(s=>s.id==="greeting-page" && s.version==="1.0.0")]);
  ok.push(["title filled = Tab Saver", p.steps.some(s=>s.params?.title==="Tab Saver")]);
  ok.push(["needs empty (linear v1)", p.steps.every(s=>(s.needs??[]).length===0)]);
  ok.push(["gap recorded", (p.gaps??[]).length>=1]);
  ok.push(["planner provenance.agent", !!p.planner?.agent]);
  ok.push(["planner provenance.pi_version", !!p.planner?.pi_version]);
  ok.push(["planner provenance.planned_at", !!p.planner?.planned_at]);
  for (const [k,v] of ok) console.log((v?"PASS":"FAIL")+": "+k);
  if (ok.some(([,v])=>!v)) process.exit(1);
'
```

Every line must read `PASS`.

> **Picker-not-builder evidence:** confirm `bspec plan` created **no** source
> files itself — only `.bspec/plan.json` (and possibly `.bspec/logs/`). The model
> ran with `noTools: "all"`; it cannot write. Verify nothing landed in `dist/`:
> `test -d "$TESTDIR/dist" && echo "UNEXPECTED dist before build" || echo "ok: no dist yet"`.

---

## 7. Clarifying-question loop (live, ambiguity branch)

Definition-of-Done item 4 requires the planner to **stop and ask** when the spec
underspecifies a required parameter. This section now fails if no question is
asked.

```bash
# An intentionally underspecified spec (missing the welcome message param).
cat > "$TESTDIR/SPEC.md" <<'EOF'
# Overview
A landing page for "Tab Saver".

# Features
- A greeting page with the heading "Tab Saver" and a welcome message.
EOF

# Guard: force a non-interactive run with no answers.
set +e
OUT=$(bun run bspec -- plan --project "$TESTDIR" --yes 2>&1)
STATUS=$?
set -e
echo "$OUT"
if [ "$STATUS" -eq 0 ]; then
  echo "FAIL: planner wrote a plan without asking for the missing message."
  exit 1
fi
echo "$OUT" | grep -F "The plan needs answers but none were provided." \
  || { echo "FAIL: expected unanswered-question error."; exit 1; }
test -f "$TESTDIR/.bspec/plan.json" && { echo "FAIL: plan.json written despite unanswered questions."; exit 1; }
```

Now answer the question explicitly and re-run to prove the loop succeeds:

```bash
cat > "$TESTDIR/answers.json" <<'EOF'
[{ "id": "q1", "answer": "Use the welcome message: Save every tab, find it later." }]
EOF

bun run bspec -- plan --project "$TESTDIR" --answers "$TESTDIR/answers.json" --yes
```

**PASS criteria**
- The unanswered run exits non-zero, prints the `"needs answers"` message, and
  does **not** write `.bspec/plan.json`.
- The answered run succeeds without prompting, writes `plan.json`, and that file
  contains **no** lingering `questions` entries.

Restore the richer spec for later sections:
```bash
cp "$TESTDIR/SPEC.copy.md" "$TESTDIR/SPEC.md"
```

---

## 8. Approval gate (no surprise writes)

Definition-of-Done item 4: nothing is written without approval.

```bash
rm -f "$TESTDIR/.bspec/plan.json"
printf 'n\n' | bun run bspec -- plan --project "$TESTDIR"
test -f "$TESTDIR/.bspec/plan.json" \
  && echo "FAIL: plan.json written despite 'n'" \
  || echo "PASS: no plan.json written on rejection"
```

**PASS:** answering anything but yes exits without writing `plan.json`.

(Then re-approve once with `--yes` or `y` to regenerate a plan for Section 9.)

```bash
bun run bspec -- plan --project "$TESTDIR" --yes
```

---

## 9. Deterministic build, replay, and preview (offline)

Definition-of-Done items 5, 6, 8. The planned `plan.json` builds with **zero**
model calls — prove it by killing the network if possible.

```bash
# Optional hard proof of offline build: run with networking disabled.
#   On macOS you can't easily drop the net per-process; instead assert no Pi import
#   path runs by trusting build's design and checking timing/quiet output.

# First build: every step runs.
bun run bspec -- build --project "$TESTDIR"      # expect [ran] for each step

# Second build: identical inputs → cache replay.
bun run bspec -- build --project "$TESTDIR"      # expect [replayed] for each step

# Inspect produced files.
bun run bspec -- preview --project "$TESTDIR"
```

**PASS criteria**
- First build prints `[ran]` per step; second prints `[replayed]` per step with
  the **same cache key**.
- `preview` lists the produced files.
- The param the planner filled is reflected in the output:

```bash
test -f "$TESTDIR/dist/index.html" && \
  grep -q "Tab Saver" "$TESTDIR/dist/index.html" \
  && echo "PASS: dist/index.html contains filled title" \
  || echo "FAIL: title not rendered"

# Extension file from the second block is present.
ls "$TESTDIR/dist" && echo "(confirm a popup/manifest file from hello-extension exists)"
```

**File-level provenance** (`build.json`, unchanged from v0):
```bash
cat "$TESTDIR/dist/build.json" 2>/dev/null || find "$TESTDIR" -name build.json -print
#   each output records { by, cache, hash }; second build flips cache hit -> true.
```

```bash
bun run bspec -- cache ls       # the entries that backed the replay
bun run bspec -- cache verify   # archived outputs + metadata still intact
```

---

## 10. Failure paths the spec promises (robustness)

These prove the validation pipeline and error handling — the heart of v1
correctness. Most can be driven without a live model; the hallucination case is
now covered here with the real planner as well.

### Live validation failure drills (real planner)

Each drill starts from a clean slate: delete any prior plan so failures are
observable.

```bash
rm -f "$TESTDIR/.bspec/plan.json"
```

1. **Hallucinated / missing block.** Temporarily remove the parameterized block
   so the planner still picks it but validation rejects it.
   ```bash
   mv "$BSPEC_HOME/blocks/greeting-page.block.ts" \
      "$BSPEC_HOME/blocks/greeting-page.block.ts.saved"

   set +e
   OUT=$(bun run bspec -- plan --project "$TESTDIR" \
       --answers "$TESTDIR/answers.json" --yes 2>&1)
   STATUS=$?
   set -e
   echo "$OUT"
   test "$STATUS" -ne 0 || { echo "FAIL: expected planner rejection for missing block."; exit 1; }
   echo "$OUT" | grep -F 'The planner chose "greeting-page@1.0.0", which isn'\''t installed.' \
     || { echo "FAIL: missing-block error not reported."; exit 1; }
   test -f "$TESTDIR/.bspec/plan.json" && { echo "FAIL: plan.json written despite missing block."; exit 1; }
   test -f "$TESTDIR/.bspec/logs/plan.log" \
     || { echo "FAIL: raw planner output log not captured."; exit 1; }

   mv "$BSPEC_HOME/blocks/greeting-page.block.ts.saved" \
      "$BSPEC_HOME/blocks/greeting-page.block.ts"
   ```

2. **Invalid parameters from the planner.** Make the block demand an extra
   required parameter (`subtitle`) so validation fails with the promised message,
   then restore the original file.
   ```bash
   rm -f "$TESTDIR/.bspec/plan.json"
   cp "$BSPEC_HOME/blocks/greeting-page.block.ts" \
      "$BSPEC_HOME/blocks/greeting-page.block.ts.orig"
   BLOCK="$BSPEC_HOME/blocks/greeting-page.block.ts" node <<'EOF'
   const fs = require("fs");
   const path = process.env.BLOCK;
   const src = fs.readFileSync(path, "utf8");
   let out = src.replace(
     'required: ["title", "message"],',
     'required: ["title", "message", "subtitle"],'
   );
   out = out.replace(
     "message: { type: \"string\" }",
     'message: { type: "string" },\n      subtitle: { type: "string" }'
   );
   if (out === src) throw new Error("patch failed - schema shape unexpected");
   fs.writeFileSync(path, out);
   EOF

   set +e
   OUT=$(bun run bspec -- plan --project "$TESTDIR" \
       --answers "$TESTDIR/answers.json" --yes 2>&1)
   STATUS=$?
   set -e
   echo "$OUT"
   test "$STATUS" -ne 0 || { echo "FAIL: expected planner rejection for missing subtitle param."; exit 1; }
   echo "$OUT" | grep -F '"greeting-page" requires "subtitle".' \
     || { echo "FAIL: missing-param error not reported."; exit 1; }
   test -f "$TESTDIR/.bspec/plan.json" && { echo "FAIL: plan.json written despite invalid params."; exit 1; }
   test -f "$TESTDIR/.bspec/logs/plan.log" \
     || { echo "FAIL: raw planner output log not captured."; exit 1; }

   mv "$BSPEC_HOME/blocks/greeting-page.block.ts.orig" \
      "$BSPEC_HOME/blocks/greeting-page.block.ts"
   ```

   After restoring the block, re-run `bun run bspec -- blocks test greeting-page`
   to confirm the registry is healthy.

---

| # | Scenario | How to trigger | Expected |
|---|---|---|---|
| 1 | Missing spec | `rm SPEC.md; bspec plan` | `No SPEC.md found at …/SPEC.md. Write one …` and exit 1 |
| 2 | Empty registry | point `BSPEC_HOME` at an empty dir, `bspec plan` | `No blocks installed in …/blocks. Add blocks before planning.` |
| 3 | No usable model | `unset BSPEC_AGENT` + config empty + (sim) no auth | `No usable model. Set BSPEC_AGENT …` |
| 4 | Bad selector | `bspec plan --agent "nope/does-not-exist"` | `Model "nope/does-not-exist" is not available in Pi. Run \`bspec config models\` …` |
| 5 | Hallucinated block (repairs exhausted) | **Run the live drill above** | `The planner chose "<id>@<ver>", which isn't installed. Available: …` + **no** `plan.json` + `.bspec/logs/plan.log` written |
| 6 | Param error | **Run the live drill above** | `… set "<param>" on "<id>", which doesn't accept it.` / `"<id>" requires "<param>".` |
| 7 | Unanswered questions, non-interactive | Section 7 guard | `The plan needs answers but none were provided. Re-run interactively or pass --answers <file>.` |

Drivers for the live-CLI cases:

```bash
# (1) Missing spec
( cd "$TESTDIR" && rm -f SPEC.md && bun run bspec -- plan ; echo "exit=$?" )
cp "$TESTDIR/SPEC.copy.md" "$TESTDIR/SPEC.md"

# (2) Empty registry
EMPTY="$(pwd)/.tmp/empty-home"; rm -rf "$EMPTY"; mkdir -p "$EMPTY/blocks"
BSPEC_HOME="$EMPTY" bun run bspec -- plan --project "$TESTDIR" ; echo "exit=$?"

# (4) Unresolvable selector
bun run bspec -- plan --project "$TESTDIR" --agent "nope/does-not-exist" ; echo "exit=$?"
```

**PASS:** each prints the exact (or clearly equivalent) spec message, exits
non-zero, and writes **no** `plan.json`. For (5), confirm a raw `plan.log` exists
for `bspec report` (v2) to consume.

---

## 11. Backward compatibility (hard requirement)

A handwritten v0 `plan.json` (no `gaps`, no `planner`, `params: {}`) must build
identically. The repo ships one at `examples/plan.json`.

```bash
V0DIR="$(pwd)/.tmp/v0compat"; rm -rf "$V0DIR"; mkdir -p "$V0DIR/.bspec"
cp examples/plan.json "$V0DIR/.bspec/plan.json"
bun run bspec -- build --project "$V0DIR"     # [ran]
bun run bspec -- build --project "$V0DIR"     # [replayed]
bun run bspec -- preview --project "$V0DIR"
```

**PASS:** builds with no warnings about the missing v1 fields; replay works; output
matches v0 behavior. (Whatever block `examples/plan.json` references must be
installed in `BSPEC_HOME` first — install it the same way as Section 3 if needed.)

---

## 12. Optional: the spec's own live integration test

The repo's single live test (behind `BSPEC_LIVE=1`) asserts a parseable,
registry-valid plan comes back for the sample spec — never exact wording.

```bash
BSPEC_LIVE=1 bun test                # runs the one live test; rest stay green
```

**PASS:** the live test passes (Pi authed); all other tests still pass. With the
flag unset, that test is skipped.

---

## 13. `spec_hash` determinism spot-check

```bash
bun -e '
  const { createHash } = require("crypto");
  const a = require("fs").readFileSync(process.env.TESTDIR+"/SPEC.md");
  const b = require("fs").readFileSync(process.env.TESTDIR+"/SPEC.copy.md");
  const h = x => createHash("sha256").update(x).digest("hex");
  console.log(h(a)===h(b) ? "PASS: identical bytes -> identical hash" : "FAIL");
'
```

Then edit one byte of `SPEC.md`, re-plan, and confirm `plan.json.spec_hash`
changes.

---

## 14. Cleanup

```bash
rm -rf "$(pwd)/.tmp"
unset BSPEC_HOME BSPEC_AGENT TESTDIR
```

The real `~/.bspec`, `~/.pi`, and the repo's tracked files are untouched throughout.

---

## 15. Sign-off checklist (maps to Definition of Done)

| DoD | Item | Section | Result |
|---|---|---|---|
| 1 | `config` resolves flag/env/file/default; `config models` no secrets | 4 | ☐ |
| 2 | `plan` reads SPEC.md, builds menu, calls Pi **tools disabled**, Pi auth, BSPEC_AGENT | 6 | ☐ |
| 3 | Selects blocks **and fills params**; pipeline rejects hallucination/version/param, no plan on fail | 6, 10 | ☐ |
| 4 | Asks clarifying questions; prints plan + gaps; writes only after approval/`--yes` | 6, 7, 8 | ☐ |
| 5 | `build` zero model calls, identical to v0; `build.json` provenance; `plan.json` planner provenance | 6, 9 | ☐ |
| 6 | Parameterized fixture: select → fill → build → replay, output reflects params | 9 | ☐ |
| 7 | v0 tests pass; v1 unit+integration (fake) pass offline; live test passes behind flag | 2, 12 | ☐ |
| 8 | Manual demo runs clean: SPEC → plan → build `[ran]`→`[replayed]` → preview | 3, 6, 9 | ☐ |
| — | Backward-compat: handwritten v0 `plan.json` builds identically | 11 | ☐ |
| — | `spec_hash` deterministic, changes on edit | 6, 13 | ☐ |
| — | Secret hygiene: no auth material in any output or log | 4, 10 | ☐ |

**Overall v1 real-world test:** ☐ PASS ☐ FAIL — notes: ________________________
