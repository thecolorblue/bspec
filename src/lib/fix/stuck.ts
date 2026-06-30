import { sha256Hex } from "../hash.ts";

const WINDOW = 6;
const REPEAT_THRESHOLD = 2;
const MAX_LOG_CHARS = 4000;
const MAX_DIAGNOSTICS = 12;

const FAIL_LINE = /\b(error|fail(ed|ure)?|panic|exception)\b|✗|✘|×/i;

/**
 * Build-tool status/banner lines that are *not* the real diagnostic. Gradle, for
 * instance, prints a constant `> Task :app:compileDebugKotlin FAILED` above the
 * actual `e: …` compiler error; fingerprinting that line collapses every
 * distinct compile error to one signature, so the loop reads steady progress as
 * a stall. These are skipped when choosing what to fingerprint.
 */
const NOISE_LINE =
  /^(>\s*task\b|>?\s*configure project|FAILURE:\s|BUILD FAILED\b|BUILD SUCCESSFUL\b|Execution failed for task\b|>?\s*Compilation error\b|\*\s|>\s*Run with\b|>\s*Get more help\b|See the report at\b|\d+ actionable task)/i;

/**
 * Markers of a real diagnostic line across common toolchains:
 *   Kotlin    `e: file://….kt:1:2 message`
 *   tsc       `src/x.ts:1:2 - error TS2322: …` / `error TS2322: …`
 *   gcc/clang `path:1:2: error: …`
 *   Rust      `error[E0382]: …`
 *   runners   `✗ name`, `FAIL path`, pytest `E   AssertionError: …`
 */
const DIAGNOSTIC_LINE =
  /^e:\s|(^|\s)error\b|(^|\s)(fatal|panic|exception)\b|\b(fail|failed|failure)\b|:\d+:\d+\b|error\[[A-Za-z]*\d+\]|^✗|^✘|^×|^E\s/i;

// A compiler/tool *warning* (Kotlin `w:`, or a line whose only marker is the word
// "warning"). Skipped so constant warnings don't crowd out the real errors in the
// fingerprint — unless the line also carries an error marker.
const WARNING_LINE = /^w:\s|(^|\s)warning\b/i;
const ERROR_LINE = /^e:\s|(^|\s)(error|fatal|panic|exception)\b/i;

/**
 * A stable 12-char signature of the *current* failure: phase + the normalized
 * set of real diagnostic lines (build-tool status/banner noise removed, file
 * paths and line/column numbers stripped, remaining digit runs collapsed to
 * `#`). Because the signature reflects the *set of actual errors*, it changes as
 * errors are knocked down — which is exactly the progress signal the loop needs
 * — and the same error at a different location still hashes identically.
 */
export function failureSignature(phase: string, log: string): string {
  const diags = diagnosticLines(log);
  const body = diags.length > 0 ? diags.join("\n") : normalizeDiagnostic(firstFailingLine(log));
  return sha256Hex(`${phase}\n${body}`).slice(0, 12);
}

/**
 * Trim a gate log for the fixer prompt (§5.6 context hygiene): hoist the first
 * failing line to the top, then append a bounded tail — errors and summary
 * lines cluster at the end of build/test output.
 */
export function trimFailureLog(log: string, maxChars = MAX_LOG_CHARS): string {
  const first = firstFailingLine(log);
  const tail = log.length > maxChars ? log.slice(-maxChars) : log;
  if (!first || tail.includes(first)) return tail;
  return `${first}\n…\n${tail}`;
}

/** The distinct, normalized diagnostic lines of a gate log (noise excluded). */
function diagnosticLines(log: string): string[] {
  const lines = log
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (NOISE_LINE.test(line) || !DIAGNOSTIC_LINE.test(line)) continue;
    if (WARNING_LINE.test(line) && !ERROR_LINE.test(line)) continue;
    const norm = normalizeDiagnostic(line);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= MAX_DIAGNOSTICS) break;
  }
  return out;
}

/** Strip locations (file URIs, paths, line/col) and collapse digits to `#`. */
function normalizeDiagnostic(line: string): string {
  return line
    .replace(/file:\/\/\/?\S+/gi, "") // file:// URIs (carry their own :line:col)
    .replace(/(?:[\w.+-]+\/)+[\w.+-]+/g, "") // path-like tokens (contain a slash)
    .replace(/:\d+(?::\d+)?/g, "") // :line[:col]
    .replace(/\d+/g, "#") // remaining digit runs
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The most informative failing line for the fixer prompt: a real diagnostic if
 * one exists, else any failing-looking line that is not build-tool noise, else
 * the last non-empty line.
 */
function firstFailingLine(log: string): string {
  const lines = log
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!NOISE_LINE.test(line) && DIAGNOSTIC_LINE.test(line)) return line;
  }
  for (const line of lines) {
    if (!NOISE_LINE.test(line) && FAIL_LINE.test(line)) return line;
  }
  return lines[lines.length - 1] ?? "";
}

/**
 * Tracks recent failure signatures to detect a loop spinning on the same
 * failure (`repeat >= 2`, i.e. three identical in a row) or ping-ponging
 * between two failures (A,B,A,B…). Immutable: `observe`/`reset` return a new
 * detector (per the codebase's no-mutation rule).
 */
export class StuckDetector {
  private constructor(
    private readonly window: readonly string[],
    private readonly repeat: number,
  ) {}

  static empty(): StuckDetector {
    return new StuckDetector([], 0);
  }

  observe(signature: string): StuckDetector {
    const last = this.window[this.window.length - 1];
    const repeat = signature === last ? this.repeat + 1 : 0;
    const window = [...this.window, signature].slice(-WINDOW);
    return new StuckDetector(window, repeat);
  }

  reset(): StuckDetector {
    return StuckDetector.empty();
  }

  isStuck(): boolean {
    if (this.repeat >= REPEAT_THRESHOLD) return true;
    return isPingPong(this.window);
  }
}

function isPingPong(window: readonly string[]): boolean {
  if (window.length < WINDOW) return false;
  const tail = window.slice(-WINDOW);
  const [a, b] = tail;
  if (a === b) return false; // a steady repeat, handled by the repeat counter
  return tail.every((s, i) => s === (i % 2 === 0 ? a : b));
}

/** One tool action observed mid-run, from a `tool_execution_start` event. */
export interface ToolEvent {
  readonly toolName: string;
  readonly args: unknown;
}

/**
 * Mid-run stall detector over the Pi event stream: flags when the last 6 tool
 * actions are all identical, or alternate in an A,B,A,B ping-pong — e.g. the
 * agent reading→editing the same file repeatedly with no gate progress. Lets
 * the fixer abort a spinning turn before it wastes a whole iteration's budget.
 */
export function isStuckEvents(events: readonly ToolEvent[]): boolean {
  if (events.length < WINDOW) return false;
  const sigs = events.slice(-WINDOW).map(eventSignature);
  const [a, b] = sigs;
  if (sigs.every((s) => s === a)) return true; // identical repeat
  if (a !== b && sigs.every((s, i) => s === (i % 2 === 0 ? a : b))) return true; // ping-pong
  return false;
}

function eventSignature(e: ToolEvent): string {
  let args: string;
  try {
    args = JSON.stringify(e.args);
  } catch {
    args = String(e.args);
  }
  return `${e.toolName}|${args}`;
}
