import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BspecError } from "./errors.ts";
import piPackageJson from "@earendil-works/pi-coding-agent/package.json" with { type: "json" };

/** The Pi SDK module type, loaded lazily so non-planning commands stay offline. */
export type PiModule = typeof import("@earendil-works/pi-coding-agent");

let materializedPiPackageDir: string | undefined;

/**
 * Point Pi at a real package directory before its module init runs.
 *
 * When bspec ships as a `bun build --compile` single-file binary, Pi detects the
 * embedded `$bunfs` URL as a "bun binary" and resolves its own package.json next
 * to `process.execPath` (e.g. `dist/package.json`), which does not exist — so its
 * top-level init throws ENOENT and `plan` fails with a misleading "Pi could not be
 * loaded". We sidestep this with Pi's documented `PI_PACKAGE_DIR` escape hatch:
 * write the embedded package.json to a temp dir and aim Pi there. A user-provided
 * `PI_PACKAGE_DIR` always wins.
 */
export function ensurePiPackageDir(): void {
  if (process.env.PI_PACKAGE_DIR) return;
  if (!materializedPiPackageDir) {
    const dir = mkdtempSync(join(tmpdir(), "bspec-pi-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify(piPackageJson));
    materializedPiPackageDir = dir;
  }
  process.env.PI_PACKAGE_DIR = materializedPiPackageDir;
}

/**
 * Load the Pi SDK on demand. Planning is the only networked path in bspec, so Pi
 * is imported only when `plan`/`config models` actually need it — and a missing
 * install surfaces as a plain, actionable error rather than a module-load crash.
 */
export async function loadPi(): Promise<PiModule> {
  try {
    ensurePiPackageDir();
    return await import("@earendil-works/pi-coding-agent");
  } catch (cause) {
    throw new BspecError(
      "Pi is required for planning but could not be loaded. " +
        "Install @earendil-works/pi-coding-agent.",
      { cause },
    );
  }
}
