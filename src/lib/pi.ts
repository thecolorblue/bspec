import { BspecError } from "./errors.ts";

/** The Pi SDK module type, loaded lazily so non-planning commands stay offline. */
export type PiModule = typeof import("@earendil-works/pi-coding-agent");

/**
 * Load the Pi SDK on demand. Planning is the only networked path in bspec, so Pi
 * is imported only when `plan`/`config models` actually need it — and a missing
 * install surfaces as a plain, actionable error rather than a module-load crash.
 */
export async function loadPi(): Promise<PiModule> {
  try {
    return await import("@earendil-works/pi-coding-agent");
  } catch {
    throw new BspecError(
      "Pi is required for planning but could not be loaded. " +
        "Install @earendil-works/pi-coding-agent.",
    );
  }
}
