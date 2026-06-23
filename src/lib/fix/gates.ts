import { spawn } from "node:child_process";
import type { ResolvedFixConfig } from "./config.ts";

export interface GateResult {
  /** True only on a clean (exit 0) run that did not time out. */
  readonly ok: boolean;
  /** Process exit code, or -1 when killed by the timeout / failed to spawn. */
  readonly code: number;
  /** Combined stdout + stderr, in arrival order. */
  readonly log: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

/**
 * Run an arbitrary build/test command via a shell, capturing combined output
 * with a hard timeout. Extends the async-spawn-and-capture pattern of
 * `runBlock` (src/lib/blocks.ts) but spawns `/bin/sh -c <cmd>` so any command
 * works, and adds a timeout that kills the whole process group (build tools
 * fork children; killing only the shell would orphan them).
 *
 * Never rejects on a non-zero exit — a red gate is a normal, expected result;
 * the controller decides what a failure means by reading `ok`/`code`.
 */
export function runGate(cmd: string, cwd: string, timeoutMs: number): Promise<GateResult> {
  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group, so a timeout can kill the whole tree
    });

    let log = "";
    const append = (d: Buffer): void => {
      log += d.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: -1,
        log: `${log}\n[spawn error] ${err.message}`,
        durationMs: performance.now() - start,
        timedOut: false,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const exit = code ?? 0;
      resolve({
        ok: exit === 0 && !timedOut,
        code: timedOut ? -1 : exit,
        log,
        durationMs: performance.now() - start,
        timedOut,
      });
    });
  });
}

/** Run the configured build command. */
export function buildGate(config: ResolvedFixConfig, cwd: string): Promise<GateResult> {
  return runGate(config.build.cmd, cwd, config.buildTimeoutMs);
}

/** Run the configured test command. */
export function testGate(config: ResolvedFixConfig, cwd: string): Promise<GateResult> {
  return runGate(config.test.cmd, cwd, config.testTimeoutMs);
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    // A negative pid targets the whole process group (the child is detached).
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already exited — nothing to kill.
  }
}
