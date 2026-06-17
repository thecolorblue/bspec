import { sha256Hex } from "./hash.ts";
import { stableStringify } from "./json-stable.ts";

export interface CacheKeyInput {
  id: string;
  version: string;
  params: Record<string, unknown>;
  /** Content hashes of outputs produced by needed steps. Empty in v0. */
  needsHashes: string[];
}

/**
 * v0 cache key:
 *   sha256(block_id + version + normalized_params + sorted(hashes_of_needed_outputs))
 */
export function computeCacheKey(input: CacheKeyInput): string {
  const parts = [
    input.id,
    input.version,
    stableStringify(input.params),
    stableStringify([...input.needsHashes].sort()),
  ];
  return sha256Hex(parts.join("\n"));
}
