import { sha256Hex } from "../hash.ts";

const WINDOW = 6;
const REPEAT_THRESHOLD = 2;
const MAX_LOG_CHARS = 4000;

const FAIL_LINE = /\b(error|fail(ed|ure)?|panic|exception)\b|✗|✘|×/i;

/**
 * A stable 12-char signature of the *current* failure: phase + the first
 * failing line with all digit runs collapsed to `#`. The same error at a
 * different line/column hashes identically, so a signature only changes when
 * the *class* of failure changes — which is what "progress" means here.
 */
export function failureSignature(phase: string, log: string): string {
  const normalized = firstFailingLine(log).replace(/[0-9]+/g, "#");
  return sha256Hex(`${phase}\n${normalized}`).slice(0, 12);
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

function firstFailingLine(log: string): string {
  const lines = log.split("\n").map((l) => l.trim());
  for (const line of lines) {
    if (line && FAIL_LINE.test(line)) return line;
  }
  // No obvious failing line — fall back to the last non-empty line.
  const nonEmpty = lines.filter(Boolean);
  return nonEmpty[nonEmpty.length - 1] ?? "";
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
