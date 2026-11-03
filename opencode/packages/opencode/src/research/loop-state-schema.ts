import z from "zod"
import { ResumeStateSchema } from "./recovery-schema"

export const LoopPhase = z.enum([
  "design",
  "training",
  "trial_finalization",
  "training_reflection",
  "optimization",
  "architecture_reflection",
  "outer_planning",
])
const json = z.record(z.string(), z.unknown())
const memory = z.object({
  id: z.string(),
  purpose: z.enum(["optimization", "architecture"]),
  status: z.string(),
  error: z.string().nullable(),
})
const reflection = z.object({
  status: z.enum(["pending", "facts_only", "completed"]),
  llmStatus: z.string().nullable(),
  summary: z.string().nullable(),
  artifactURI: z.string().nullable(),
  memoryWrites: z.array(memory),
})
const run = z.object({ id: z.string(), status: z.string(), error: z.string().nullable() })
const best = z.object({ runID: z.string(), candidateID: z.string(), metric: z.string(), value: z.number().finite() })
export const LoopTrialSchema = z.object({
  id: z.string(),
  index: z.number().int(),
  candidateID: z.string(),
  status: z.string(),
  charged: z.boolean(),
  smoke: run.nullable(),
  full: run.nullable(),
  metricValue: z.number().finite().nullable(),
  eligibleForRanking: z.boolean(),
  duplicate: z.boolean(),
  trainingStrategy: json,
  changes: z.array(z.object({ path: z.string(), before: z.unknown(), after: z.unknown() })),
  comparisonRunID: z.string().nullable(),
  repairRunID: z.string().nullable(),
  optimizerDecision: json.nullable(),
  trainingReflection: reflection,
})
export const LoopDesignSchema = z.object({
  id: z.string(),
  index: z.number().int(),
  hypothesisID: z.string().nullable(),
  reference: z.boolean(),
  status: z.string(),
  active: z.boolean(),
  fixedDesignDigest: z.string(),
  fixedRecipe: json,
  phase: LoopPhase.nullable(),
  currentTrialID: z.string().nullable(),
  noImprove: z.number().int(),
  stopReason: z.string().nullable(),
  bestModel: best.nullable(),
  architectureEvidence: json.nullable(),
  architectureReflection: reflection,
  trials: z.array(LoopTrialSchema),
})
export const LoopProgressSchema = z.object({
  taskID: z.string(),
  observedAt: z.number(),
  stoppedReason: z.string().nullable(),
  cycleID: z.string().nullable(),
  phase: LoopPhase.nullable(),
  activeDesignID: z.string().nullable(),
  activeTrialID: z.string().nullable(),
  primaryMetric: z.string(),
  direction: z.enum(["minimize", "maximize"]),
  policy: z.record(z.string(), z.number().optional()).nullable(),
  budget: z.object({
    trainingUsed: z.number().int(),
    trainingLimit: z.number().nullable(),
    runRecordsUsed: z.number().int(),
    runRecordsLimit: z.number().nullable(),
    elapsedSeconds: z.number(),
    deadlineAt: z.number().nullable(),
    remainingSeconds: z.number().nullable(),
  }),
  bestModel: best.nullable(),
  designs: z.array(LoopDesignSchema),
})
export const LoopStateSchema = LoopProgressSchema.extend({ recovery: ResumeStateSchema })
export type LoopProgress = z.infer<typeof LoopProgressSchema>
export type LoopState = z.infer<typeof LoopStateSchema>
export type LoopDesign = z.infer<typeof LoopDesignSchema>
export type LoopTrial = z.infer<typeof LoopTrialSchema>
