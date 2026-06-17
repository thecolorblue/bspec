import { z } from "zod";

/** Manifest printed by a generated block via `--manifest`. */
export const manifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  summary: z.string(),
  params: z.record(z.unknown()).default({}),
  produces: z.array(z.string()),
  needs: z.array(z.string()).default([]),
});
export type Manifest = z.infer<typeof manifestSchema>;

/** A single step in a handwritten plan.json. */
export const planStepSchema = z.object({
  id: z.string().min(1, "step id is required"),
  version: z.string().min(1, "step version is required"),
  summary: z.string().optional(),
  params: z.record(z.unknown()).default({}),
  needs: z.array(z.string()).default([]),
});
export type PlanStep = z.infer<typeof planStepSchema>;

export const planSchema = z.object({
  spec_hash: z.string().optional(),
  steps: z.array(planStepSchema).min(1, "steps must be a non-empty array"),
});
export type Plan = z.infer<typeof planSchema>;

/** meta.json stored alongside a cache entry's outputs.tar.gz. */
export const cacheMetaSchema = z.object({
  block_id: z.string(),
  version: z.string(),
  params_hash: z.string(),
  produces: z.array(z.string()),
  cached_at: z.string(),
});
export type CacheMeta = z.infer<typeof cacheMetaSchema>;
