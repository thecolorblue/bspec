import { createHash } from "node:crypto";

/** sha256 hex digest of a string or binary buffer. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
