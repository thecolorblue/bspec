# SPEC.md — Spec‑Driven Build CLI on top of pi

> A Node.js CLI that reads a user‑supplied `SPEC.md`, asks the pre‑build
> questions embedded in it, then drives the [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi-mono)
> binary (`pi`) — authenticated against the user's chosen LLM via
> **Anthropic OAuth (Claude Pro / Max subscription)**,
> **OpenAI OAuth (ChatGPT Plus / Pro subscription)**,
> **Google OAuth (Gemini Advanced / Google One AI Premium subscription)**, or
> **OpenRouter OAuth (PKCE, bring‑your‑own‑model)** — to produce the app described by the spec. After the agent drafts a
> `PLAN.md`, the CLI executes the plan one numbered step at a time, pausing
> between steps for the user to approve, stop, or re‑plan.
>
> This document is itself a SPEC.md and can be fed into the very CLI it
> describes. Treat any section a builder doesn't understand as a question to
> escalate to a human, not as license to invent behavior.

---

## 1. Glossary

| Term | Meaning |
|------|---------|
| **Builder** | The CLI defined by this SPEC.md (`spec-builder`). |
| **Target Spec** | A `SPEC.md` file the user feeds into the Builder. |
| **Target App** | The application the agent produces from a Target Spec. |
| **Pre‑Build Questions** | A YAML/Markdown block inside a Target Spec listing questions the Builder must ask the user *before* invoking the agent. Answered at build time, not at spec‑authoring time. |
| **pi** | [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — the TypeScript coding agent the Builder wraps. Successor to the deprecated `@mariozechner/pi-coding-agent`. |
| **Plan phase** | The first pi invocation, constrained to produce `PLAN.md` only. |
| **Execute phase** | A sequence of pi invocations, one per numbered step in `PLAN.md`. |
| **Checkpoint** | An automatic post-step action: the Builder records state and, if a git repo is present, commits before proceeding. |
| **Agent Step** | A single NDJSON event emitted by `pi --mode json` on stdout. |
| **Run Log** | Append‑only structured log of one build session, under `~/.spec-builder/logs/<UUIDv7>/`. |
| **Living Spec** | The copy of SPEC.md written by the agent into `output_dir` during the repair loop. Starts as an empty file (or the agent-copied initial spec) and accumulates fix notes and clarified requirements with each repair iteration. |

---

## 2. Goals & Non‑Goals

### 2.1 Goals
1. Let any developer drop a `SPEC.md` next to a working `node` install and produce a scaffolded app, with no config file editing.
2. Defer environment‑specific decisions (OS, language, paths) to **build time** via the Target Spec's pre‑build questions.
3. Reuse pi for everything pi already does well: tool calling, file editing, shell execution, session continuity. Add only what pi lacks.
4. Support four authentication modes — **Anthropic OAuth** (Claude Pro / Max subscription, no per‑token billing, Claude models only), **OpenAI OAuth** (ChatGPT Plus / Pro subscription via pi's `openai-codex` OAuth provider, no per‑token billing), **Google API key** (Gemini models billed per token; no subscription OAuth available in pi), and **OpenRouter OAuth (PKCE)** (any tool‑capable model, billed per token to the user's OpenRouter account) — with no API keys living in the Builder's codebase.
5. Produce a complete, replayable audit trail (raw NDJSON event stream, resolved spec, stderr) under `$HOME`.
6. Make the **plan visible and editable** before any source code is written, with the Builder automatically checkpointing (git commit when available) after each step before moving on.

### 2.2 Non‑Goals
- A GUI. The Builder is a TUI CLI; GUIs can be authored separately on top of the same modules.
- A "port matrix" for multiple agent runtimes. Pi handles every Target Spec language because the agent runtime is independent of the Target App language. If a different runtime is ever needed, fork.
- Hosting, deploying, or distributing the Target App.
- Acting as a code reviewer beyond what the agent itself does.
- Multi‑user / SaaS operation. The Builder is single‑user and local.
- Generating SPEC.md files from scratch.

---

## 3. High‑Level Flow

```
┌───────────────────────────────────┐
│ 1. spec-builder login (one-time)  │  Anthropic OAuth (Pro/Max)
│    --provider anthropic           │  OR OpenAI OAuth (Plus/Pro)
│               |openai             │  OR Google OAuth (Gemini Advanced)
│               |google             │  OR OpenRouter OAuth PKCE
│               |openrouter         │
└───────────────┬───────────────────┘
                ▼
┌───────────────────────────────────┐
│ 2. spec-builder <path-to-SPEC.md> │
└───────────────┬───────────────────┘
                ▼
┌───────────────────────────────────┐
│ 3. Resolve provider + models      │
│    Anthropic: hardcoded Claude    │
│      model list (Pro/Max-eligible)│
│    OpenAI: hardcoded GPT/o-series │
│      model list (Plus/Pro-eligible│
│    Google: hardcoded Gemini model │
│      list (Advanced-eligible)     │
│    OpenRouter: GET /v1/models     │
└───────────────┬───────────────────┘
                ▼
┌───────────────────────────────────┐
│ 4. User picks model               │
└───────────────┬───────────────────┘
                ▼
┌───────────────────────────────────┐
│ 5. Parse SPEC.md, extract         │
│    pre-build questions            │
└───────────────┬───────────────────┘
                ▼
┌───────────────────────────────────┐
│ 6. Render TUI form,               │
│    user answers questions         │
└───────────────┬───────────────────┘
                ▼
┌───────────────────────────────────┐
│ 7. Compose resolved-spec.md       │
│    (frontmatter + body)           │
└───────────────┬───────────────────┘
                ▼
┌───────────────────────────────────┐
│ 8. PLAN PHASE                     │
│    spawn pi → produce PLAN.md     │
└───────────────┬───────────────────┘
                ▼
┌───────────────────────────────────┐
│ 9. User reviews PLAN.md           │  approve / edit / abort
└───────────────┬───────────────────┘
                ▼
┌───────────────────────────────────┐
│ 10. EXECUTE PHASE                 │
│     for each step in PLAN.md:     │
│       spawn pi for step N         │
│       git commit (if repo)        │
│       auto-advance                │
└───────────────┬───────────────────┘
                ▼
┌───────────────────────────────────┐
│ 11. Target App in output_dir      │
│     Session log at ~/.spec-builder/logs/<id>/
└───────────────┬───────────────────┘
                ▼
┌───────────────────────────────────┐
│ 12. REPAIR LOOP (interactive)     │
│     User pastes errors / issues   │
│     Agent fixes source +          │
│       updates output_dir/SPEC.md  │
│     Type "done" or Ctrl+C to exit │
└───────────────────────────────────┘
```

---

## 4. Architecture

The Builder is a small set of Node.js modules under `src/`. No MVC framework, no service registry, no event bus — just plain functions that compose. Pi handles the heavy lifting; our code is the orchestration thin layer above it.

### 4.1 Module map

| Module | Responsibility |
|---|---|
| `src/cli.ts` | Argv parsing, top‑level flow (login → models → questions → orchestrate). |
| `src/spec-parser.ts` | Parse Target Spec markdown → `SpecFile`, honoring §5.2 rules. |
| `src/question-runner.ts` | Render `Question[]` as TUI prompts (`@inquirer/prompts`), honoring `depends_on` and `validation`. |
| `src/resolved-spec.ts` | Merge answers + body into `resolved-spec.md` (YAML frontmatter + body). |
| `src/auth.ts` | Provider dispatch — resolves the active provider and returns the credentials object for `pi-runner` to consume. |
| `src/anthropic-auth.ts` | Anthropic OAuth (Claude Pro / Max) login flow; delegates to pi's built‑in Anthropic OAuth provider, stores the resulting refresh/access tokens in the OS keychain. |
| `src/openai-auth.ts` | OpenAI OAuth (ChatGPT Plus / Pro) login flow; delegates to pi's built‑in OpenAI OAuth provider, stores tokens in the OS keychain. |
| `src/google-auth.ts` | Google OAuth (Gemini Advanced / Google One AI Premium) login flow; delegates to pi's built‑in Google OAuth provider, stores tokens in the OS keychain. |
| `src/openrouter-auth.ts` | PKCE login flow, keychain (via `keytar`) with 0600 file fallback. |
| `src/openrouter-models.ts` | `GET /api/v1/models`, filter to `supports_tools`. |
| `src/anthropic-models.ts` | Returns the small, curated list of Claude models eligible under Pro / Max subscriptions (e.g. `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`). |
| `src/openai-models.ts` | Returns the curated list of OpenAI models accessible via pi's `openai-codex` subscription endpoint (e.g. `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`). |
| `src/google-models.ts` | Returns the curated list of Gemini models eligible under Gemini Advanced / Google One AI Premium (e.g. `gemini-2.5-pro`, `gemini-2.5-flash`). |
| `src/orchestrator.ts` | Plan‑confirm‑execute with automatic post‑step git checkpoints, followed by the interactive repair loop. |
| `src/pi-runner.ts` | Spawn `pi -p --mode json --provider openrouter`, parse NDJSON, forward events to log + progress callback. |
| `src/session-log.ts` | Write `~/.spec-builder/logs/<UUIDv7>/{session.json, steps.ndjson, stdout.log, stderr.log, resolved-spec.md}`. |
| `src/paths.ts` | Canonical paths under `~/.spec-builder/`. |
| `src/types.ts` | All shared data shapes. |

### 4.2 Data shapes

#### 4.2.1 `Question` (§5)
```
Question {
  id:          string                // stable slug, e.g. "target_os"
  prompt:      string                // human-facing question
  help:        string | null
  kind:        "single_select" | "multi_select" | "text" | "path" | "bool" | "number"
  options:     Option[] | null       // for *_select
  default:     any
  required:    bool
  validation:  { regex?: string; min?: number; max?: number; must_exist?: bool } | null
  depends_on:  { question_id: string; equals: any }[]
}

Option { value: string; label: string; description: string | null }
```

#### 4.2.2 `SpecFile`
```
SpecFile {
  path:                   string
  raw_markdown:           string
  title:                  string                // first H1
  summary:                string                // first paragraph after title
  questions:              Question[]            // parsed from prebuild-questions blocks
  body_without_questions: string                // markdown stripped of question blocks
  checksum_sha256:        string                // for log correlation / replay
}
```

#### 4.2.3 `BuildTarget` / `ResolvedSpec`
```
BuildTarget {
  os:           "macos" | "linux" | "windows"
  language:     string                          // "typescript" | "python" | ...
  ui_paradigm:  "cli" | "tui" | "desktop" | "web" | "library"
  data_dir:     string
}

ResolvedSpec {
  spec:              SpecFile
  answers:           Answer[]
  target:            BuildTarget
  output_dir:        string                     // absolute path, must be writable
  resolved_markdown: string                     // YAML frontmatter + body_without_questions
}
```

#### 4.2.4 `AgentStep`
One per NDJSON event from pi.
```
AgentStep {
  seq:         int                              // monotonic within a session
  ts:          ISO8601
  kind:        "model_request" | "model_response" | "tool_call" |
               "tool_result"   | "status"        | "error" | "checkpoint"
  payload:     object                           // pi event verbatim
  tokens_in:   int | null
  tokens_out:  int | null
  duration_ms: int | null
}
```

`kind` is derived from pi's `type` field (case‑insensitive — see §10 gotcha).
`checkpoint` is emitted by the Builder (not pi) at the plan/execute boundary, around each plan step (pre/post), and at the start of each repair iteration. Execute checkpoints include `{phase: "execute", step: N, boundary: "pre-step" | "post-step", summary, gitCommit?: {sha, message}}`, where `gitCommit` is populated after a successful step when a git repository is present. Repair checkpoints include `{phase: "repair", issue_seq: N, summary: <first 120 chars of user input>}` in their payload.

The live console display (§9.6) is a *projection* of this event stream — the canonical, complete record always lives in `steps.ndjson`. Console rendering may drop or coalesce events; the on‑disk log must not.

### 4.3 Combination rules
1. A build can start **iff** valid credentials for the selected provider are present (Anthropic OAuth tokens in pi's store, OpenAI OAuth tokens in pi's store, Google OAuth tokens in pi's store, OpenRouter key from keychain or `OPENROUTER_API_KEY` env, or the relevant `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` env vars as last‑resort escape hatches), a model is selected, the spec is loaded, and every `Question` with `required = true` has a valid `Answer`.
2. `resolved_markdown` = YAML frontmatter (`spec_sha256`, `resolved_at`, `build_target`, `answers`) followed by `SpecFile.body_without_questions`. The frontmatter is wrapped in `---` fences.
3. Every NDJSON event from pi is written to `steps.ndjson` **before** being passed to the progress callback. The on‑disk log is always at least as fresh as the console.

---

## 5. SPEC.md File Format

A Target Spec is a valid Markdown document with at least one fenced code block tagged `prebuild-questions` containing YAML. Everything else is freeform Markdown for the agent to read as a brief.

### 5.1 Minimal example

````markdown
# My Todo App

A small offline-first todo app.

```prebuild-questions
- id: target_os
  prompt: Which operating system are you building for?
  kind: single_select
  required: true
  options:
    - { value: macos,   label: "macOS" }
    - { value: linux,   label: "Linux" }
    - { value: windows, label: "Windows" }

- id: language
  prompt: Preferred language?
  kind: single_select
  required: true
  options:
    - { value: typescript, label: "TypeScript (Node.js)" }
    - { value: python,     label: "Python" }

- id: output_dir
  prompt: Where should the agent write the project?
  kind: path
  required: true
  default: "~/projects/my-todo-app"

- id: include_sync
  prompt: Include cloud sync?
  kind: bool
  default: false

- id: sync_backend
  prompt: Which sync backend?
  kind: single_select
  depends_on: [{ question_id: include_sync, equals: true }]
  options:
    - { value: dropbox, label: "Dropbox" }
    - { value: s3,      label: "S3-compatible" }
```

## Requirements
- CRUD todos with priorities and due dates
- Offline-first; sync optional
````

### 5.2 Parser rules
- The Builder MUST locate `prebuild-questions` blocks **by fence info string**, not by position.
- The Builder MUST track open code‑fence state so a `prebuild-questions` fence **nested inside another fence** (as in this very SPEC.md's §5.1 example) is treated as content, not as a question block. CommonMark allows the inner fence to use a shorter marker than the outer fence; the parser respects fence length when matching.
- Multiple top‑level `prebuild-questions` blocks are concatenated in document order.
- Unknown YAML keys are preserved but ignored — authors extend the format additively.
- If the YAML is invalid, the Builder MUST refuse to proceed and surface the YAML parser error with the line where the block started.
- The agent receives `body_without_questions` (spec stripped of question blocks) plus the resolved frontmatter. This avoids the agent being confused by un‑answered questions.

### 5.3 Reserved question IDs
The Builder recognizes these IDs and uses them to populate `BuildTarget` and `output_dir` automatically:

| ID | Maps to |
|----|---------|
| `target_os` | `BuildTarget.os` |
| `language` | `BuildTarget.language` |
| `ui_paradigm` | `BuildTarget.ui_paradigm` |
| `data_dir` | `BuildTarget.data_dir` |
| `output_dir` | `ResolvedSpec.output_dir` |

If `target_os`, `language`, or `output_dir` is absent, the Builder MUST inject a synthetic question with sensible defaults (host OS detection, language list from OS detection, `~/projects/${project name}`) before showing the form.

---

## 6. Pi Integration

The Builder shells out to the `pi` binary installed via `@earendil-works/pi-coding-agent`. No fork, no patched build — the published npm package.

### 6.1 Why subprocess, not library import

`@earendil-works/pi-agent-core` exposes `runAgentLoop()` as a library, but:
- Pi already OAuths against Anthropic (Claude Pro / Max), GitHub Copilot, OpenAI (ChatGPT Plus / Pro), and Google (Gemini Advanced). For these providers, the Builder reuses pi's existing OAuth flows rather than reimplementing them — the Builder just triggers `pi auth login --provider <anthropic|openai|google>` (or the equivalent programmatic call) and trusts pi's token store under `~/.pi/`.
- OpenRouter OAuth is NOT part of pi. We implement it ourselves; the rest of pi works fine with an API‑key provider via env var.
- Pi's transports, OAuth providers, session storage, tool registration, and system prompts are tightly integrated with its CLI. Reimplementing the wiring around `runAgentLoop` is more risk than reward when `pi -p --mode json` already gives us a stable NDJSON event stream.

If a future Builder needs in‑process control (e.g. a custom checkpoint tool the model can call), revisit this decision.

### 6.2 Invocation

```bash
pi -p \
   --mode json \
   --provider <anthropic|openai|google|openrouter> \
   --model <model_id> \
   --session-id <piSessionId> \
   --append-system-prompt "<phase-specific prompt>" \
   @<absolute-path-to-resolved-spec.md> \
   "<short inline instruction>"
```

**Provider = `openrouter`:** env `OPENROUTER_API_KEY=<key>` (pi reads this natively). The key MUST be passed via env var, never argv.

**Provider = `anthropic`:** no env var required when the user has logged in via `spec-builder login --provider anthropic` — pi reads the OAuth tokens from its own keychain entry / `~/.pi/` token store and refreshes them automatically. As an escape hatch, `ANTHROPIC_API_KEY=<key>` is honored if the user prefers a raw API key over the Pro/Max subscription path; in that case Anthropic bills per token and the Claude Pro quota does NOT apply.

**Provider = `openai`:** no env var required when the user has logged in via `spec-builder login --provider openai` — pi reads the OAuth tokens from `~/.pi/` and refreshes them automatically. As an escape hatch, `OPENAI_API_KEY=<key>` is honored; in that case OpenAI bills per token and the ChatGPT Plus/Pro quota does NOT apply.

**Provider = `google`:** no env var required when the user has logged in via `spec-builder login --provider google` — pi reads the OAuth tokens from `~/.pi/` and refreshes them automatically. As an escape hatch, `GOOGLE_API_KEY=<key>` is honored; in that case Google bills per token and the Gemini Advanced quota does NOT apply.

### 6.3 Hard‑won invocation rules (lessons from initial dogfood)

These four rules are non‑obvious and broke the first three test runs. Future implementers MUST honor them:

1. **Pass spec content via pi's `@<filepath>` mechanism, never as an argv string.** Pi's argv parser interprets a leading `---` (YAML frontmatter) as an unknown flag and exits with `Error: Unknown option: ---`. The resolved spec is also typically ≥30 KB, which would be brittle as a single argv anyway.

2. **Do not use `--` as an option terminator.** Pi rejects it with `Error: Unknown option: --`. Use `@<file>` for any long or potentially‑flag‑shaped content; for the trailing positional, supply a short instruction that cannot start with `-`.

3. **Pi's `--mode json` event types use camelCase and `_` separators interchangeably** (`toolCall`, `toolcall_start`, `toolcall_delta`, `tool_execution_start`, …). Classify them case‑**insensitively**. The first implementation case‑sensitively grep'd for `"call"` in `"toolCall"` and missed every tool call.

4. **The high‑volume event types — `thinking_delta`, `toolcall_delta`, `message_update`, `text_delta`, `thinking` — flood the console.** Log them all to `steps.ndjson` (cheap), but route events to the live display regions described in §9.6 as follows:

   | Region | Driven by |
   |---|---|
   | Progress bar (line 1) | Builder‑emitted `checkpoint` events only — never raw pi events |
   | Step summary + state prefix (line 2) | The resolved plan step text; the prefix is derived from pi event transitions (see §10.1) |
   | LLM tail (lines 3–7) | `text`, `text_delta`, `text_start`, `thinking`, `thinking_delta`, `thinking_start`, `message_update` |
   | Scrollback above the live region | `error`, `agent_error` |
   | Logged only, not displayed | `toolCall`, `toolcall_*`, `tool_execution_*`, `turn_start`, `turn_end`, `agent_start`, `agent_end`, and any unrecognized event |

   The mapping in §10's table is normative; if it ever conflicts with this list, §10 wins.

### 6.4 Plan / Execute prompting

**Plan phase system prompt (appended via `--append-system-prompt`):**
```
You are in PLANNING mode for a SPEC-driven build.
- Read the SPEC carefully (supplied below as a @file).
- Produce ONLY a file named PLAN.md in the current working directory.
- The plan MUST be a markdown document with a top-level "# Plan" heading
  and a numbered list under a "## Steps" heading.
- Each numbered step MUST be self-contained, executable in isolation,
  and named so a developer (or another agent) can pick it up and run it.
- Do NOT write any source code, do NOT modify any other files.
- After writing PLAN.md, stop.
```

**Execute phase system prompt (per step N):**
```
You are in EXECUTE mode for step N of the build plan.
- The full plan lives at ./PLAN.md for context. Re-read if needed.
- Your scope for THIS invocation is ONLY step N, reproduced verbatim:
    <step text>
- Implement that step end-to-end. Do not start the next step.
- When done, briefly summarize what you changed and stop.
```

---
UX Standards Across UI apps

- Buttons should include and icon and text. They should not be smaller that 30 pixels on a desktop app and 48 pixels on a mobile app. Higher numbers should be used for displays that are higher density.

---
macOS app packaging requirements

All macOS GUI apps must be built as proper .app bundles, not bare Mach-O executables. A raw binary launched from Finder/Terminal gets no Dock icon, no menu
bar, and no keyboard focus, because LaunchServices won't treat it as a regular app without an Info.plist.

Build script must produce this layout:
dist/<AppName>.app/
  Contents/
    Info.plist
    MacOS/<AppName>      # the compiled executable (chmod +x)
    Resources/           # icons, assets, .icns
    _CodeSignature/      # populated by codesign

Info.plist must include at minimum:
- CFBundleIdentifier (reverse-DNS, e.g. com.example.recipeorders)
- CFBundleExecutable — must match the binary name in Contents/MacOS/
- CFBundleName, CFBundleDisplayName
- CFBundleVersion, CFBundleShortVersionString
- CFBundlePackageType = APPL
- LSMinimumSystemVersion (match Package.swift platform target)
- NSPrincipalClass = NSApplication
- NSHighResolutionCapable = true
- CFBundleIconFile if shipping an icon

Build script steps (Swift Package Manager apps):
1. swift build -c release --product <AppName>
2. Create the .app directory tree under dist/.
3. Copy the release binary to Contents/MacOS/<AppName>.
4. Write Info.plist (use plutil -convert binary1 for the final form).
5. Copy resources/icons into Contents/Resources/.
6. Ad-hoc sign for local runs: codesign --force --deep --sign - dist/<AppName>.app.
7. Strip quarantine when testing locally: xattr -dr com.apple.quarantine dist/<AppName>.app.

App entry point must also:
- Call NSApplication.shared.setActivationPolicy(.regular) before NSApp.run() (belt-and-suspenders — needed for headless launches and ensures menu bar / Dock
activation even outside a bundle).
- Construct a real NSMenu with at least an Application menu (Quit item with ⌘Q) and an Edit menu (Cut/Copy/Paste/Select All with standard selectors) —
without an Edit menu, text fields can't use system keyboard shortcuts.

Verification checklist before declaring the build done:
- file dist/<AppName>.app/Contents/MacOS/<AppName> reports a Mach-O executable
  (it MUST NOT be a shell script, Python script, or any text file with a `#!` shebang —
  if it is, LaunchServices launches the app via Terminal.app and a terminal window
  appears before the GUI, which is the #1 symptom of a broken bundle)
- head -c 4 dist/<AppName>.app/Contents/MacOS/<AppName> | xxd shows the Mach-O magic
  (`cffaedfe`, `cefaedfe`, `cafebabe`, or `bebafeca`) — NOT `2321` (`#!`)
- CFBundleExecutable in Info.plist points directly at the compiled binary,
  never at a `.sh`, `.command`, `.py`, or any wrapper script
- No launcher / trampoline script exists anywhere in Contents/MacOS/
- plutil -lint dist/<AppName>.app/Contents/Info.plist passes
- open dist/<AppName>.app launches with a Dock icon AND no Terminal window appears
- The app owns the system menu bar when frontmost
- Text fields accept keyboard input and ⌘C/⌘V work
- codesign -dv dist/<AppName>.app succeeds

Do not mark the task complete by only verifying that swift build succeeded — always launch the resulting .app from Finder (double-click) and confirm:
1. No Terminal window opens at any point
2. The app appears in the Dock with its real icon
3. The app owns the menu bar
4. Text fields accept keyboard input and ⌘C/⌘V work

If a Terminal window appears on launch, the bundle is broken — the executable at
Contents/MacOS/<AppName> is a script, not a Mach-O binary. Fix the build script to
copy the actual compiled binary (e.g. `.build/release/<AppName>` from SwiftPM, or
the cargo/go release binary) directly into Contents/MacOS/, with no shell wrapper
in between. If the app legitimately needs a launcher (e.g. to set env vars), the
launcher itself MUST be a compiled binary, not a shell script.

---


**Repair phase system prompt (per user issue):**
```
You are in REPAIR mode for the app built in output_dir.
- The user has reported an error or issue, reproduced verbatim below.
- Your scope for THIS invocation is ONLY the reported issue.
- Investigate the symptom, locate the cause in the source files, and fix it.
- Do NOT refactor unrelated code or add unrequested features.
- After fixing the issue, update the SPEC.md in output_dir to reflect what changed:
    - If the fix revealed a missing requirement, add it under the relevant section.
    - If the fix corrected a misspecified behavior, amend the relevant description.
    - If the fix was purely a bug (typo, off-by-one, wrong API call) with no spec
      implication, add a brief note under a "## Known Fixes" section at the end
      of the SPEC.md so future rebuilds avoid the same mistake.
    - Do NOT restructure or rewrite the spec; make the smallest accurate update.
- Do not complete the repair phase. The user will end the repair phase when they are done.
```

The user's pasted issue text is passed as the trailing positional instruction (never as an argv starting with `-`).

The agent writes its SPEC.md updates to the copy of SPEC.md **inside `output_dir`** (the Target App's own spec), not to the Builder's own SPEC.md or the resolved-spec.md in the session log. If no SPEC.md exists in `output_dir`, the agent creates one with just a `# Spec` heading and the relevant additions.

All plan, execute, and repair invocations share the same `--session-id` so pi accumulates conversational context across them. The Builder owns the session id (`uuidv7`), reuses the same id for its own log directory, and writes `resolved-spec.md` into that directory; pi's session store is separate and lives under `~/.pi/`.

### 6.5 Plan parser
`PLAN.md` is parsed by `readPlanSteps(path)` which:
- Skips everything before a `## Steps` heading.
- Stops at the next `## ` heading.
- Recognizes step markers `1.` or `1)` at the start of a line (any leading whitespace).
- Merges continuation lines (non‑empty, non‑numbered) into the current step's text.
- Returns `[]` (and the orchestrator fails the session with a clear error) if no steps were found, or the file is missing.

---

## 7. Authentication

The Builder supports four provider auth modes. Exactly one is active per build, selected at `spec-builder login` time via `--provider anthropic|openai|google|openrouter` (default: `anthropic`, since most users have a Claude Pro / Max subscription). The choice is persisted in `~/.spec-builder/config.json` and can be overridden per‑run via `--provider`.

| Provider | Auth flow | Quota / billing | Model selection |
|---|---|---|---|
| `anthropic` | OAuth via pi's built‑in Anthropic provider (Claude Pro / Max subscription) | Counts against the user's Claude Pro / Max subscription rate limits; no per‑token charge | Curated Claude model list (Opus / Sonnet / Haiku 4.x) |
| `openai` | OAuth via pi's built‑in `openai-codex` OAuth provider (ChatGPT Plus / Pro subscription) | Counts against the user's ChatGPT Plus / Pro subscription rate limits; no per‑token charge | Curated model list via chatgpt.com/backend-api (gpt-5.4, gpt-5.4-mini, etc.) |
| `google` | API key (`GEMINI_API_KEY`) stored in OS keychain; no OAuth available in pi | Billed per token at standard Gemini API rates | Curated Gemini model list (gemini-2.5-pro, gemini-2.5-flash, etc.) |
| `openrouter` | PKCE OAuth implemented by the Builder | Billed per token to the user's OpenRouter account | Any model exposing `tools` in `supported_parameters` |

### 7.0 Anthropic OAuth (Claude Pro / Max)

Pi already ships an Anthropic OAuth provider that targets `claude.ai` subscription accounts. The Builder reuses it rather than reimplementing PKCE for Anthropic.

#### 7.0.1 Flow
1. On `spec-builder login --provider anthropic` (or first build when `provider = anthropic` and no tokens exist):
   - The Builder shells out to pi's auth subcommand (`pi auth login --provider anthropic`) or invokes pi‑agent‑core's Anthropic OAuth helper directly.
   - Pi opens the system browser to `https://claude.ai/oauth/authorize?...`, captures the redirect, exchanges the code, and stores the refresh + access tokens in its own store under `~/.pi/`.
   - The Builder records `{ provider: "anthropic", logged_in_at: <ISO8601> }` in `~/.spec-builder/config.json`. It does NOT duplicate the tokens — pi owns them.
2. At build time, the Builder invokes pi with `--provider anthropic`. Pi reads its own stored tokens, refreshes them if needed, and routes requests through the user's Claude subscription.
3. The Builder MUST surface a clear error if pi reports the subscription is exhausted (HTTP 429 with `subscription_quota_exceeded`) or the account does not have Pro / Max entitlement.

#### 7.0.2 Model list
Anthropic does not expose a public "list models" endpoint scoped to Pro / Max entitlement. The Builder ships a hardcoded list of Pro/Max‑eligible Claude models, updated per release:

- `claude-opus-4-7` (deepest reasoning; counts heavily against Pro quota)
- `claude-sonnet-4-6` (best coding model; default)
- `claude-haiku-4-5` (lightest; preferred for long execute phases)

If Anthropic ships a new Claude model, the Builder is updated; users can pass `--model <id>` to override.

#### 7.0.3 Failure modes
- **No Pro / Max subscription:** pi returns 403; Builder prints "Your Anthropic account does not have an active Claude Pro or Max subscription — either subscribe, or run `spec-builder login --provider openrouter`."
- **OAuth flow times out / browser never returns:** same handling as §7.3.
- **Subscription quota exhausted mid‑run:** pi surfaces a 429 event; the current step ends with `failed`, the session is preserved, and the Builder advises waiting for the rate‑limit window to reset (printed from the error body) or switching providers.

---

### 7.1 OpenAI OAuth (ChatGPT Plus / Pro)

Pi already ships a built‑in OpenAI OAuth provider. The Builder reuses it, mirroring the Anthropic path exactly.

#### 7.1.1 Flow
1. On `spec-builder login --provider openai` (or first build when `provider = openai` and no tokens exist):
   - The Builder invokes pi‑agent‑core's `AuthStorage.create().login("openai-codex", ...)`. The `"openai-codex"` string is the pi‑internal OAuth provider ID for ChatGPT subscription access (it routes through `chatgpt.com/backend-api`); the user‑facing provider name remains `"openai"`.
   - Pi opens the system browser to `https://auth.openai.com/oauth/authorize`, captures the redirect, exchanges the code, and stores the refresh + access tokens in its own store under `~/.pi/`.
   - The Builder records `{ provider: "openai", logged_in_at: <ISO8601> }` in `~/.spec-builder/config.json`. It does NOT duplicate the tokens — pi owns them.
2. At build time, the Builder invokes pi with `--provider openai-codex` (not `--provider openai`). Pi reads the stored `openai-codex` tokens, refreshes them if needed, and routes requests through the user's ChatGPT subscription endpoint.
3. The Builder MUST surface a clear error if pi reports the subscription is exhausted (HTTP 429 with `subscription_quota_exceeded`) or the account does not have Plus / Pro entitlement.

#### 7.1.2 Model list
The Builder ships a hardcoded list of models accessible via pi's `openai-codex` subscription endpoint (chatgpt.com/backend-api), updated per release:

- `gpt-5.4` (deepest reasoning; counts heavily against Plus/Pro quota)
- `gpt-5.4-mini` (fast reasoning; **default**)
- `gpt-5.3-codex-spark` (lightest; preferred for long execute phases)

Users can pass `--model <id>` to override.

#### 7.1.3 Failure modes
- **No Plus / Pro subscription:** pi returns 403; Builder prints "Your OpenAI account does not have an active ChatGPT Plus or Pro subscription — either subscribe, or run `spec-builder login --provider openrouter`."
- **OAuth flow times out / browser never returns:** same handling as §7.3.
- **Subscription quota exhausted mid‑run:** pi surfaces a 429 event; the current step ends with `failed`, the session is preserved, and the Builder advises waiting for the rate‑limit window to reset or switching providers.

---

### 7.2 Google / Gemini (API key)

Pi ships a built‑in `google` provider that routes requests to the Gemini API, but pi does NOT include a Google OAuth flow. Authentication is via a **GEMINI_API_KEY** obtained from [Google AI Studio](https://aistudio.google.com/apikey). The Builder prompts the user for the key on first login and stores it in the OS keychain (service `spec-builder`, account `google`), with a 0600 file fallback.

> Unlike the Anthropic and OpenAI providers, the Google provider is **API‑key‑based** — usage is billed per token at standard Gemini API rates. There is no subscription quota path available.

#### 7.2.1 Flow
1. On `spec-builder login --provider google` (or first build when `provider = google` and no key is stored):
   - The Builder prompts: "Paste your GEMINI_API_KEY (from https://aistudio.google.com/apikey):"
   - The key is stored in the OS keychain via `keytar` (service `spec-builder`, account `google`). If keytar is unavailable, it falls back to `~/.spec-builder/google-credentials.json` (mode 0600).
   - The Builder records `{ provider: "google", logged_in_at: <ISO8601> }` in `~/.spec-builder/config.json`.
2. At build time, the Builder reads the key and passes it to pi as the `GEMINI_API_KEY` environment variable. Pi invokes the Gemini API with `--provider google`.

#### 7.2.2 Model list
The Builder ships a hardcoded list of supported Gemini models, updated per release:

- `gemini-2.5-pro` (deepest reasoning)
- `gemini-2.5-flash` (fast; **default**)
- `gemini-2.5-flash-lite` (lightest; preferred for long execute phases)

Users can pass `--model <id>` to override.

#### 7.2.3 Failure modes
- **Invalid or missing API key:** pi returns 401/403; Builder prints "No Google API key found — run `spec-builder login --provider google`."
- **API quota exceeded:** pi surfaces a 429 event; the current step ends with `failed`, the session is preserved, and the Builder advises waiting for the rate‑limit window to reset.

---

### 7.3 OpenRouter OAuth (PKCE) — Flow
1. On `spec-builder login` (or first build with no stored key):
   - Generate a 64‑byte `code_verifier`; `code_challenge = base64url(sha256(code_verifier))`.
   - **Bind the local callback listener BEFORE opening the browser.** The bound port goes into the auth URL — opening the browser first races against bind failure.
   - Walk ports 3000..3009 to dodge collisions.
   - Open the system browser to:
     ```
     https://openrouter.ai/auth
       ?callback_url=http://localhost:<port>/callback
       &code_challenge=<challenge>
       &code_challenge_method=S256
     ```
2. User logs in and authorizes; OpenRouter redirects to `http://localhost:<port>/callback?code=<code>`.
3. Local server captures `code`, returns a friendly "You can close this tab" HTML page, then closes.
4. The Builder POSTs to `https://openrouter.ai/api/v1/auth/keys`:
   ```json
   { "code": "<code>", "code_verifier": "<verifier>", "code_challenge_method": "S256" }
   ```
5. Response includes a user‑controlled API key. The Builder stores it in the OS keychain via `keytar` (service `spec-builder`, account `openrouter`). It is never written to a plain config file.

### 7.3 OpenRouter failure modes
- **No free callback port in 3000..3009:** surface an error; the user must free one.
- **User never authorizes:** the local server times out after 5 minutes; auth state → error.
- **Key exchange returns non‑2xx:** surface OpenRouter's body verbatim; offer retry.
- **No keychain available** (`keytar` cannot link — rare Linux without Secret Service, or a fresh CI runner): fall back to `~/.spec-builder/credentials.json` with mode `0600`, log a prominent warning.

### 7.4 Credential resolution order at runtime

**When `provider = anthropic`:**
1. `ANTHROPIC_API_KEY` env var (escape hatch; bypasses Pro/Max — billed per token).
2. Pi's Anthropic OAuth token store under `~/.pi/` (the Pro/Max path).
3. None → prompt for `spec-builder login --provider anthropic`.

**When `provider = openai`:**
1. `OPENAI_API_KEY` env var (escape hatch; bypasses Plus/Pro subscription — billed per token; pi invoked with `--provider openai`).
2. Pi's `openai-codex` OAuth token store under `~/.pi/` (the Plus/Pro subscription path; pi invoked with `--provider openai-codex`).
3. None → prompt for `spec-builder login --provider openai`.

**When `provider = google`:**
1. `GEMINI_API_KEY` env var (pi reads this natively for the `google` provider).
2. Keychain entry (`spec-builder` / `google`) or `~/.spec-builder/google-credentials.json`.
3. None → prompt for `spec-builder login --provider google`.

**When `provider = openrouter`:**
1. `OPENROUTER_API_KEY` env var (for CI / scripting).
2. `keytar` (`spec-builder` / `openrouter`).
3. `~/.spec-builder/credentials.json`.
4. None → prompt for `spec-builder login --provider openrouter`.

### 7.5 Model selection
- **`provider = anthropic`:** the Builder shows the curated Claude model list from §7.0.2 in a TUI picker. The chosen id is the bare Anthropic model id (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`) — NOT the OpenRouter‑namespaced form.
- **`provider = openai`:** the Builder shows the curated model list from §7.1.2 in a TUI picker. The chosen id is the bare model id (`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`) — NOT the OpenRouter‑namespaced form. Pi is invoked with `--provider openai-codex` (the pi-internal provider name for this OAuth path).
- **`provider = google`:** the Builder shows the curated Gemini model list from §7.2.2 in a TUI picker. The chosen id is the bare model id (`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`) — NOT the OpenRouter‑namespaced form. Pi is invoked with `--provider google` and `GEMINI_API_KEY` in the environment.
- **`provider = openrouter`:** the Builder fetches `GET https://openrouter.ai/api/v1/models` with the bearer key. It filters to models whose `supported_parameters` contain `tools` or `tool_choice`, sorts by name, shows the top N in a TUI picker. The chosen id is the literal OpenRouter model id (`anthropic/claude-opus-4-7`, `openai/gpt-5`, etc.). The Builder does NOT cache the model list — fetched fresh each run since OpenRouter ships new models weekly.

---

## 8. Logging

All logs go under **`~/.spec-builder/logs/`**.

### 8.1 Layout
```
~/.spec-builder/
├── credentials.json          (only if keychain unavailable, mode 0600)
└── logs/
    └── <UUIDv7>/
        ├── session.json      (BuildSession header + artifacts; rewritten on each step)
        ├── steps.ndjson      (one AgentStep per line, append-only; includes repair checkpoints)
        ├── stdout.log        (pi process stdout, verbatim; all phases including repair)
        ├── stderr.log        (pi process stderr, verbatim)
        └── resolved-spec.md  (the exact prompt the agent received via @file)
```

The session id is a UUIDv7 generated by `uuidv7` from `@earendil-works/pi-agent-core` so log directories sort chronologically.

### 8.2 NDJSON step format
One JSON object per line:
```json
{"seq":42,"ts":"2026-05-27T22:38:14.118Z","kind":"tool_call","payload":{"type":"toolCall","tool":"write","path":"src/main.ts"},"tokens_in":null,"tokens_out":null,"duration_ms":null}
```

`payload` is the pi NDJSON event verbatim. The Builder does NOT impose a schema on it — pi event shapes evolve, and storing them raw keeps the log faithful.

### 8.3 Redaction (planned, not yet implemented)
- The OpenRouter API key MUST be replaced with `REDACTED` if any field in `payload` ever contains it. Today the Builder passes the key only via env var, so this is preventative.
- Payload fields larger than 64 KiB SHOULD be spilled to `blobs/<sha256>` with a `{"_truncated": true, "sha256": "...", "bytes": N}` placeholder. Today, large payloads land in `steps.ndjson` as‑is.

### 8.4 Retention
No automatic deletion. A future `spec-builder clear-logs --older-than <N>d` command will require explicit confirmation.

---

## 9. Build Lifecycle

1. **Validate inputs.** Combination rule §4.3.1 must hold.
2. **Create session directory** at `logs/<UUIDv7>/`. Write `session.json` with `status = "queued"`.
3. **Materialize `resolved-spec.md`** into the session directory. The orchestrator passes its absolute path to pi via `@<path>` (§6.3 rule 1).
4. **Plan phase.** Spawn pi once with the plan system prompt; expect `PLAN.md` in `output_dir`. Console shows live `[plan] turn N tools N last: <tool>`.
5. **Approval gate.** Parse `PLAN.md` → step count. If zero, fail the session with a clear error. Otherwise show the path, the step count, and three choices: approve / edit / abort. On `edit`, wait for the user to save changes and press Enter, then re‑parse.
6. **Execute phase.** For each step N:
   a. Log a synthetic `kind: "checkpoint"` step with `{phase: "execute", step: N, boundary: "pre-step", summary}`.
   b. Spawn pi with the execute system prompt for step N, same `--session-id` as the plan phase so context carries.
   c. Console renders the live execute display described in §9.3 (fixed seven‑line region: progress bar, state‑prefixed step summary, five‑line LLM tail).
   d. On exit code 0:
      i. Detect whether `output_dir` (or the configured working folder) is inside a git worktree via `git rev-parse --is-inside-work-tree`.
      ii. If inside a git repo and `git status --porcelain` is non-empty, run `git add -A` and `git commit -m "Step N: <plan step text>"` (trimmed to 72 characters) with cwd = `output_dir`. If the tree is clean, skip the commit.
      iii. Emit a post-step `checkpoint` event with `{phase: "execute", step: N, boundary: "post-step", gitCommit}` where `gitCommit = {sha, message}` only when a commit was created.
      iv. Immediately continue to step N+1; no user prompt is shown.
      v. Treat any git failure as a build failure (`failed`) with the git command's stderr surfaced.
   e. On non-zero exit code, end with `failed`, exit code captured.
7. **Finalize execute phase.** Update `session.json` with `status = "built"`, `exit_code`, `finished_at`, totals.
8. **Surface result.** Print `Session <id>: <status>; steps <done>/<total>; output <dir>`.
9. **Repair loop.** After the execute phase completes (status `built` or `cancelled`), enter the interactive repair loop:
   a. Print: `App built at <output_dir>. Paste an error or issue (or type "done" to exit):`
   b. Read multi‑line user input until a blank line (i.e. the user presses Enter twice) or the sentinel `done`.
   c. If the input is empty or `done`, exit cleanly.
   d. Log a synthetic `kind: "checkpoint"` step with `{phase: "repair", issue_seq: N, summary: <first 120 chars of input>}`.
   e. Spawn pi with the repair system prompt (§6.4) and the user's issue text, same `--session-id` so the agent retains full context.
   f. Console shows live `[repair N] turn N tools N last: <tool>` (same format as execute phase).
   g. On pi exit code 0, print a one‑line summary of what was changed (source + SPEC.md) and loop back to step (a).
   h. On non‑zero exit code, print the error and loop back to step (a) — the repair loop never auto‑exits on agent failure.
      Note: the agent is responsible for updating `output_dir/SPEC.md`; the Builder does not validate whether the update happened.
   i. Ctrl+C at any point sends `SIGTERM`/`SIGKILL` to the child (§9.1) and exits the repair loop cleanly; `session.json` gets `repair_issues: N` appended.
   j. `--skip-repair` CLI flag (or `OrchestrateOptions.skipRepair = true`) bypasses step 9 entirely for non‑interactive / CI use.

### 9.1 Cancellation
The Builder forwards an `AbortSignal` to the child: `SIGTERM`, then `SIGKILL` after 5 s. The session closes with `status = "cancelled"`. Partial artifacts in `output_dir` are NOT deleted.

### 9.2 Replay (future)
Re‑invoke the agent with the same `resolved-spec.md`, same model id, into a fresh `output_dir`. A new session id is generated — replay never overwrites old logs.

### 9.3 Execute‑phase live display

During the execute phase, on a TTY, the Builder renders a fixed seven‑line region that is redrawn in place. The region replaces the append‑only `[step N/total] turn N tools N` lines used in earlier revisions.

#### 9.3.1 Layout

```
Step <N>/<total> [████████░░░░░░░░░░░░] <pct>%
<state-prefix> <step-summary-text>
  <llm-tail-line-1>
  <llm-tail-line-2>
  <llm-tail-line-3>
  <llm-tail-line-4>
  <llm-tail-line-5>
```

- **Line 1 — progress bar.** Format `Step <N>/<total> [<bar>] <pct>%`. The bar is ASCII (`█` filled, `░` empty); width is `min(terminal_width − prefix − 8, 40)` characters. The bar updates only at step boundaries (pre‑step / post‑step `checkpoint` events emitted by the Builder).
- **Line 2 — state‑prefixed step summary.** The verbatim plan step text for step N from `PLAN.md`, single line, hard‑truncated to `terminal_width − prefix − 2` and terminated with `…` if it would overflow. The leading prefix glyph reflects the LLM state machine defined in §10.1 and updates as pi events arrive.
- **Lines 3–7 — LLM tail.** A rolling 5‑line buffer of the most recent assistant `text` / `thinking` stream content, oldest on top, newest at the bottom. Each visible line is hard‑truncated to terminal width with no wrapping. The tail is a liveness indicator only — it is NOT intended for diagnosis. Users who want full output read `~/.spec-builder/logs/<id>/steps.ndjson`.

#### 9.3.2 Redraw mechanics

- On entering each step, the Builder reserves seven rows below the cursor (printing seven newlines, then moving up).
- Redraws use `\r\x1b[<n>A\x1b[J` to move to the top of the region and rewrite all seven lines.
- Redraws are throttled to **≤10 Hz**. Pending deltas that arrive between frames are coalesced into the next frame (never dropped from the tail buffer, never dropped from `steps.ndjson`).
- On `SIGWINCH` (terminal resize), the Builder clears the region, recomputes the bar width and truncation widths from the new `terminal_width`, and redraws on the next frame.
- If no event arrives for 2 s while a step is in flight, the Builder renders an animated spinner glyph at the right edge of the progress bar (one frame per second) so the user knows the process is alive. The spinner does NOT replace the state prefix on line 2 — a stuck `⏳` is itself a useful signal.

#### 9.3.3 Non‑TTY fallback

When stdout is not a TTY (CI, piped output, `tee`), the live region is suppressed entirely. Instead the Builder emits:

- One line per pre‑step checkpoint: `[step N/total] <step summary>`.
- One line per `error` / `agent_error` event with the full message.
- One line per post‑step checkpoint: `[step N/total] done` or `[step N/total] failed: <reason>`.

No ANSI escape sequences are written in non‑TTY mode. No per‑turn or per‑tool counters are emitted.

#### 9.3.4 Final state

When the execute phase ends:
- Progress bar is left at `100%` on success, frozen at the failing step on `failed`, or frozen at the cancelled step on `cancelled`.
- The step summary line is replaced with `Built` / `Failed: <reason>` / `Cancelled` (state prefix becomes `✔` / `✖` / `■` respectively, with `[OK]` / `[!!]` / `[--]` in ASCII mode).
- The LLM tail region is cleared (five blank lines) so subsequent output (repair loop prompt, error scrollback) reads cleanly.

---

## 10. Pi NDJSON event reference

Pi emits events on stdout (one per line) with a `type` field. Observed types and the Builder's classification:

| pi `type` | Builder `kind` | Render region (§9.3) | State transition (§10.1) |
|---|---|---|---|
| `session`, `agent_start` | `model_request` | none (log only) | → `processing` |
| `turn_start`, `message_start` | `model_request` | none (log only) | → `processing` |
| `turn_end`, `agent_end`, `message_end` | `model_response` | none (log only) | → `idle` |
| `text`, `text_start`, `thinking`, `thinking_start` | `model_response` | LLM tail (replace buffer with last 5 wrapped lines of `payload.text`) | → `generating` |
| `text_delta`, `thinking_delta`, `message_update` | `model_response` | LLM tail (append `payload.delta`) | → `generating` |
| `toolCall`, `toolcall_start`, `tool_execution_start` | `tool_call` | none (log only) | → `tool_running` |
| `toolcall_delta` | `tool_call` | none (log only) | (no change) |
| `toolcall_end`, `tool_execution_end`, anything containing `result` | `tool_result` | none (log only) | → `processing` |
| `error`, `agent_error` | `error` | scrollback above region (print full message) | → `error` (frozen until step ends) |
| any other | `status` | none (log only) | (no change) |

Matching is **case‑insensitive** on the lowercased type string. New pi event types fall through to `status` and still log — no version pin is required when pi adds events.

### 10.1 LLM tail and state‑prefix derivation

The execute‑phase live display (§9.3) needs two derived signals that pi does NOT expose directly: a rolling tail of the model's most recent visible output, and a coarse state classification (processing prompt vs. generating response vs. running a tool). Both are computed from the same NDJSON event stream that lands in `steps.ndjson`.

#### 10.1.1 Tail buffer rules

- The tail is a single rolling buffer of up to 5 display lines, regardless of whether the active content stream is `text` or `thinking`. Switching streams does NOT clear the buffer — the previous stream's content stays visible until overwritten.
- On `text_delta` / `thinking_delta`: append `payload.delta` (string) to the active stream. Re‑wrap the active stream's full accumulated text to terminal width, then keep only the last 5 wrapped lines as the visible buffer.
- On `text` / `thinking` (full snapshots): replace the active stream's accumulated text with `payload.text`, re‑wrap, keep the last 5 lines.
- ANSI escape sequences in `payload.text` / `payload.delta` MUST be stripped before wrapping — pi sometimes emits markdown‑rendered output containing them.
- Truncation uses *display width* (East Asian Wide characters count as 2, zero‑width joiners as 0), not byte length.
- Errors do NOT write to the tail; they print to scrollback above the region.

#### 10.1.2 State machine

The Builder tracks `current_phase ∈ {processing, generating, tool_running, idle, error}` per step. Initial state at pre‑step checkpoint is `processing` (the request is in flight; no response tokens have arrived yet). Transitions:

| From | Event | To |
|---|---|---|
| any (except `error`) | `text_*`, `thinking_*`, `message_update` | `generating` |
| `generating` | `tool_execution_start`, `toolcall_start`, `toolCall` | `tool_running` |
| `tool_running` | `tool_execution_end`, `toolcall_end`, anything containing `result` | `processing` |
| `generating` | `turn_end`, `message_end`, `agent_end` | `idle` |
| `idle` | `turn_start`, `message_start`, `agent_start`, `session` | `processing` |
| any | `error`, `agent_error` | `error` (frozen until step ends) |

The displayed prefix is derived purely from `current_phase`:

| Phase | UTF‑8 glyph | ASCII fallback | Meaning |
|---|---|---|---|
| `processing` | `⏳` | `[..]` | Prompt sent; awaiting first response token |
| `generating` | `✎` | `[>>]` | Model is streaming response tokens |
| `tool_running` | `⚙` | `[**]` | Agent is executing a tool call |
| `idle` | `►` | `[->]` | Between turns (brief, often invisible) |
| `error` | `✖` | `[!!]` | Error emitted; summary frozen until step end |

ASCII fallback is used when `LANG` / `LC_ALL` does not advertise UTF‑8 or when `TERM=dumb`.

This spec does NOT require pi to expose an explicit phase signal. If a future pi version surfaces one, the Builder MAY refine the mapping additively — the contract above defines the minimum acceptable behavior.

---

## 11. Security & Privacy

- The OpenRouter API key lives in the OS keychain or a 0600 file. Never in environment files committed to source control.
- Anthropic, OpenAI, and Google OAuth refresh / access tokens are owned and stored by pi under `~/.pi/` (the same path pi uses for its own `pi auth login`). The Builder never reads or copies them — it only invokes pi to mint or refresh them. Revocation is done via `pi auth logout --provider <anthropic|openai|google>` (or by signing out in the respective service's account settings).
- The Builder itself makes only two network calls (both `openrouter` path only): OpenRouter `/auth/keys` and OpenRouter `/models`. All subscription OAuth paths (Anthropic, OpenAI, Google) delegate entirely to pi. Pi initiates its own LLM calls; the Builder does not proxy them.
- Logs are local. There is no telemetry.
- The pi agent runs as the current user — it can read and write anything the user can. The Builder warns about this on first build and requires acknowledgment.
- `output_dir` MUST be writable by the user and MUST NOT be a system directory (`/`, `/usr`, `C:\Windows`, etc.). The Builder validates this before invocation.

---

## 12. Extensibility

- **New question kinds:** add a case in `question-runner.ts:promptOne` and a validator in `validate`. There is no plugin loader; if a Target Spec author needs a custom kind, fork.
- **New reserved question IDs:** authors may add IDs prefixed with `x_` (e.g. `x_license`). The Builder passes these through to the resolved frontmatter unchanged.
- **Post‑build hooks (future):** an optional `~/.spec-builder/hooks/post-build` script, if executable, would be invoked with the session id and output dir. Not implemented today.
- **Spec versioning:** future Target Specs may include `spec_version` in YAML frontmatter at the top of the document. Specs without a version are treated as version `1`.

---

## 13. Pre‑Build Questions for THIS SPEC.md

These are the questions the Builder asks when run against its own SPEC.md. They are intentionally minimal — the Builder is a CLI, so most of the original (desktop‑era) questions are now baked in.

```prebuild-questions
- id: target_os
  prompt: Which operating system will you run the Builder on?
  kind: single_select
  required: true
  options:
    - { value: macos,   label: "macOS (Intel or Apple Silicon)" }
    - { value: linux,   label: "Linux (x86_64 or aarch64)" }
    - { value: windows, label: "Windows 10/11 (WSL2 recommended)" }

- id: language
  prompt: Implementation language of the Builder itself?
  kind: single_select
  required: true
  default: typescript
  help: >
    This is the language of the Builder CLI, not the language of the apps it
    produces. The reference implementation is TypeScript on Node ≥20.
  options:
    - { value: typescript, label: "TypeScript (Node.js ≥20)" }
    - { value: python,     label: "Python 3.12+ (reimplementation)" }
    - { value: go,         label: "Go 1.22+ (reimplementation)" }

- id: ui_paradigm
  prompt: UI paradigm?
  kind: single_select
  required: true
  default: tui
  options:
    - { value: tui, label: "Terminal UI / CLI (recommended — matches pi's UX)" }
    - { value: desktop, label: "Desktop (Electron / Tauri) — out of scope for v1" }

- id: data_dir
  prompt: Where should the Builder store its logs?
  kind: path
  required: true
  default: "~/.spec-builder"

- id: auth_provider
  prompt: Which auth provider should the Builder default to?
  kind: single_select
  required: true
  default: anthropic
  help: >
    `anthropic` uses your Claude Pro / Max subscription via Anthropic OAuth
    (no per-token billing; Claude models only).
    `openai` uses your ChatGPT Plus / Pro subscription via OpenAI OAuth
    (no per-token billing; OpenAI models only).
    `google` uses your Gemini Advanced / Google One AI Premium subscription
    via Google OAuth (no per-token billing; Gemini models only).
    `openrouter` uses OpenRouter PKCE OAuth (any tool-capable model;
    per-token billing).
  options:
    - { value: anthropic,  label: "Anthropic OAuth — Claude Pro / Max subscription (recommended)" }
    - { value: openai,     label: "OpenAI OAuth — ChatGPT Plus / Pro subscription" }
    - { value: google,     label: "Google OAuth — Gemini Advanced / Google One AI Premium" }
    - { value: openrouter, label: "OpenRouter OAuth — bring-your-own-model, per-token billing" }

- id: keychain_strategy
  prompt: How should the API key / OAuth tokens be stored?
  kind: single_select
  required: true
  default: os_keychain
  options:
    - { value: os_keychain,    label: "OS keychain via keytar (recommended)" }
    - { value: encrypted_file, label: "0600 file in data_dir (fallback)" }

- id: default_callback_port
  prompt: First OAuth callback port to try (Builder will walk +9 from here)?
  kind: number
  required: true
  default: 3000
  validation: { min: 1024, max: 65526 }

- id: output_dir
  prompt: Where should the agent write the Builder's source code?
  kind: path
  required: true
  default: "~/projects/spec-builder"
```

---

## 14. Acceptance Criteria

The Builder is considered complete when **all** of the following hold:

1. A fresh user on macOS / Linux can `npm install`, `npm run build`, `node dist/cli.js login` (Anthropic OAuth by default, or `--provider openai|google|openrouter`), `node dist/cli.js <SPEC.md>`, answer the questions, approve the plan, and end with a working scaffold in `output_dir`. Each subscription path (Anthropic, OpenAI, Google) completes a full build using only the user's subscription quota, with no API key configured.
2. Every NDJSON event from pi is preserved in `~/.spec-builder/logs/<id>/steps.ndjson`, valid one‑object‑per‑line, even if the agent process crashes.
3. The Builder runs end‑to‑end against the §5.1 example and produces a runnable scaffold in the answered language.
4. Killing the agent process mid‑run leaves `session.json.status = "cancelled"` and `steps.ndjson` valid NDJSON to the last byte written.
5. The Builder uses the OS keychain when available; no plaintext secret is ever written to disk under that path. For the Anthropic provider, the Builder relies on pi's own token store and does not duplicate tokens.
6. Running the Builder against **this very SPEC.md** (§13's questions) produces a Builder.
7. Console liveness: during plan and repair phases, the CLI never appears frozen for >2 s without printing something. During the execute phase, this is satisfied by the live region described in §9.3 (state prefix updates, tail updates, or the 2 s‑idle spinner glyph).
8. After execute phase completes, the Builder enters the repair loop and accepts at least one pasted error; the agent fixes the source **and** updates `output_dir/SPEC.md` with the relevant fix note or requirement amendment. Loop re-prompts after each fix. Ctrl+C exits cleanly and `steps.ndjson` remains valid NDJSON. `--skip-repair` suppresses the loop entirely.
9. During the execute phase on a TTY, the console renders the fixed seven‑line region defined in §9.3 (progress bar, state‑prefixed step summary, five‑line LLM tail) updating in place. Scrollback above the region is reserved for errors and the final session summary — no per‑turn or per‑tool status lines are emitted.
10. The step summary's leading state prefix reflects the LLM phase derived from pi events per §10.1: `processing` at step entry, transitioning to `generating` on the first response‑token event, `tool_running` during tool execution, and back as the agent continues. ASCII fallback glyphs are used when the terminal does not advertise UTF‑8.
11. On a non‑TTY stdout (`node dist/cli.js spec.md | tee log.txt`), the Builder emits exactly one line per pre‑step checkpoint, one per post‑step checkpoint, and one per `error` / `agent_error` event — with no ANSI escape sequences and no per‑turn or per‑tool counters.

---

## 15. Out of Scope (explicitly)

- A GUI.
- Authoring or editing SPEC.md files inside the Builder.
- Multi‑model / multi‑agent orchestration in one session.
- Running the agent on a remote machine.
- OpenRouter account management beyond OAuth sign‑in/out.
- Generating tests for the Target App unless the Target Spec asks for them.
- A "port matrix" / alternate agent runtime — pi is the only supported runtime.

---

## 16. Gotchas & Lessons from Initial Dogfood

Things that broke during the first three real runs against OpenRouter + pi. Any reimplementation MUST handle these.

### 16.1 Pi argv parser hard‑edges
- **`---` is rejected as an unknown flag.** Never pass markdown with YAML frontmatter as an argv. Use `@<file>`.
- **`--` is rejected as an unknown flag** (it is NOT the conventional option terminator in pi). Don't try to use it as a sentinel.
- **The trailing positional MUST NOT start with `-`.** Use a short, neutral instruction like "Read the attached spec and produce PLAN.md."

### 16.2 Pi event naming is mixed
- camelCase (`toolCall`), snake_case (`tool_execution_start`), and lower‑with‑underscore (`toolcall_delta`) all appear. Classify case‑insensitively.
- New event types appear between pi versions. Always fall through unknowns to `status` rather than throwing.

### 16.3 Pi is verbose by default
- A single non‑trivial build emits **thousands** of NDJSON events. Without explicit console‑progress filtering, the user sees nothing for minutes and assumes the CLI is hung; with naive passthrough, the terminal scrollback is destroyed. The Builder must:
  - Log all events to `steps.ndjson` (cheap).
  - During the execute phase, render the fixed seven‑line live region defined in §9.3 instead of streaming status lines.
  - During the plan and repair phases (where there are no discrete steps), render an in‑place one‑line status (`\r\x1b[2K…`) rather than scrolling.

### 16.4 Pi spec dependencies
- The legacy `@mariozechner/pi-coding-agent` is **deprecated**. Pin `@earendil-works/pi-coding-agent ≥0.76.0` (and the matching `pi-agent-core`, `pi-ai`).
- Pi's `pi` binary lives in `./node_modules/.bin/pi`. Either rely on `npm`/`npx` PATH injection or vendor the binary path.

### 16.5 OpenRouter model ids
- The picker shows whatever `/api/v1/models` returns. OpenRouter occasionally returns model ids that the underlying provider rejects ("model not found" at request time). The session log will show the failure clearly, but the Builder cannot pre‑validate. If users hit this, fall back to a well‑known id like `anthropic/claude-opus-4-7` or `openai/gpt-5`.

### 16.6 Long plan phases look hung
- The plan phase for a non‑trivial spec routinely runs **5–15 minutes** with high‑reasoning models. The Builder MUST display a live progress line (turns, tools, last tool) so the user knows the agent is alive. A spinner alone is insufficient — show the last tool name.

### 16.7 OAuth callback bind order
- Bind the local HTTP server BEFORE opening the browser. The bound port must be in the auth URL, and bind can fail (port in use). Opening the browser first races against bind and produces a broken URL.

### 16.8 Append‑only execute‑phase progress destroys scrollback and hides the LLM
- The first execute‑phase UI printed one line per step plus per‑turn / per‑tool counters (`[step N/total] turn N tools N`). Two problems surfaced immediately:
  1. Users couldn't see what the agent was actually saying — only how many turns and tools had elapsed — so a long step felt indistinguishable from a hung process.
  2. A 50‑step plan filled the scrollback with status lines, burying earlier errors and final summaries the user might want to read.
- The fix is the fixed redrawn region in §9.3: progress bar + state‑prefixed step summary + 5‑line LLM tail, all redrawn in place. Scrollback is reserved for things worth keeping (errors, final session line); the live region is for liveness.
- The state prefix on line 2 (§10.1) addresses a related foot‑gun: without it, "agent generating tokens" and "agent waiting on a tool" looked identical to the user. The prefix lets the user distinguish a slow model from a slow tool without reading the NDJSON log.

---

## 17. Open questions for the implementer

- Whether `Question.validation` should grow a small expression DSL or stay as the current per‑field object (`{regex, min, max, must_exist}`). The current shape is good enough for everything in §13.
- Whether to add a custom pi tool (`await_plan_step_approval`) registered via pi‑agent‑core's `defineTool` so checkpoints can happen inside a single pi invocation instead of one‑pi‑per‑step. Today's N‑invocations approach is simpler and works; revisit if step‑level context cost becomes a problem.
- Whether to add a `replay` subcommand (§9.2). The session log has everything needed; it's purely UX.
- Whether to expose a non‑interactive mode (`--auto-approve`) that skips the plan‑approval gate (per-step execution already auto-advances with git checkpoints). Implemented internally as `OrchestrateOptions.autoApprove`; just needs a CLI flag.
- Whether the repair loop should accept a `--repair-file <path>` flag that reads issues from a newline‑delimited text file and processes them sequentially without human interaction. Useful for scripted QA pipelines where test output is piped in.
