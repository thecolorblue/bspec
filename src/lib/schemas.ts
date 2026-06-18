import { z } from "zod";

/**
 * Parameter spec: the SCHEMA of a single parameter a block accepts
 * (author-defined, lives in a block's manifest `params`). This is distinct from
 * a plan step's `params`, which holds the VALUES filled in for a specific use.
 */
export const paramTypeSchema = z.enum(["string", "number", "boolean", "enum"]);
export type ParamType = z.infer<typeof paramTypeSchema>;

export const paramSpecSchema = z
  .object({
    type: paramTypeSchema,
    required: z.boolean().default(false),
    description: z.string().optional(),
    enum: z.array(z.string()).optional(),
    default: z.unknown().optional(),
  })
  .superRefine((spec, ctx) => {
    if (spec.type === "enum" && (spec.enum === undefined || spec.enum.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a param of type "enum" must list its allowed values in "enum"',
      });
    }
  });
export type ParamSpec = z.infer<typeof paramSpecSchema>;

/** Manifest printed by a block via `--manifest`. */
export const manifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  summary: z.string(),
  // The schema of accepted params. Empty `{}` is valid (v0 folder snapshots).
  params: z.record(paramSpecSchema).default({}),
  produces: z.array(z.string()),
  needs: z.array(z.string()).default([]),
});
export type Manifest = z.infer<typeof manifestSchema>;

/** A single step in a plan.json (handwritten or planner-produced). */
export const planStepSchema = z.object({
  id: z.string().min(1, "step id is required"),
  version: z.string().min(1, "step version is required"),
  summary: z.string().optional(),
  // The VALUES for this step; validated against the block's param schema at plan time.
  params: z.record(z.unknown()).default({}),
  needs: z.array(z.string()).default([]),
});
export type PlanStep = z.infer<typeof planStepSchema>;

/** A spec wish that matched no installed block (a request for a new block). */
export const planGapSchema = z.object({
  feature: z.string(),
  reason: z.string(),
});
export type PlanGap = z.infer<typeof planGapSchema>;

/** Plan-level provenance: which model produced the plan, through Pi. */
export const plannerProvenanceSchema = z.object({
  agent: z.string(),
  pi_version: z.string(),
  planned_at: z.string(),
});
export type PlannerProvenance = z.infer<typeof plannerProvenanceSchema>;

export const planSchema = z.object({
  spec_hash: z.string().optional(),
  steps: z.array(planStepSchema).min(1, "steps must be a non-empty array"),
  gaps: z.array(planGapSchema).default([]),
  planner: plannerProvenanceSchema.optional(),
});
export type Plan = z.infer<typeof planSchema>;

/** A clarifying question the planner asks before a plan is finalized. */
export const planQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  why: z.string().optional(),
});
export type PlanQuestion = z.infer<typeof planQuestionSchema>;

/**
 * A step as emitted by the planner. Stricter than `planStepSchema`: `summary`
 * is required (build prints it) and `needs` must be empty — v1 plans are
 * linear; dependency-graph execution is v3.
 */
export const plannerStepSchema = planStepSchema.extend({
  summary: z.string().min(1, "planner step summary is required"),
  needs: z
    .array(z.string())
    .max(0, "v1 plans are linear; needs must be empty")
    .default([]),
});
export type PlannerStep = z.infer<typeof plannerStepSchema>;

/** The shape the planner returns, before semantic validation against the registry. */
export const plannerOutputSchema = z.object({
  steps: z.array(plannerStepSchema),
  gaps: z.array(planGapSchema).default([]),
  questions: z.array(planQuestionSchema).default([]),
});
export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

/** meta.json stored alongside a cache entry's outputs.tar.gz. */
export const cacheMetaSchema = z.object({
  block_id: z.string(),
  version: z.string(),
  params_hash: z.string(),
  produces: z.array(z.string()),
  cached_at: z.string(),
});
export type CacheMeta = z.infer<typeof cacheMetaSchema>;
