import z from "zod"
import { RESEARCH_MAX_RUNS_SAFETY_LIMIT } from "./defaults"

const count = z.number().int().min(1).max(1000)
export const LoopConfigurationSchema = z
  .object({
    maxIterations: z.number().int().min(1).max(200),
    maxTrialsPerDesign: count,
    maxNoImprovePerDesign: count,
    maxNoImprove: z.number().int().min(0).max(1000),
    maxCrashStreak: z.number().int().min(0).max(1000),
    maxRuns: z.number().int().min(0).max(RESEARCH_MAX_RUNS_SAFETY_LIMIT),
    timeBudgetSeconds: z.number().finite().positive().nullable(),
    targetMetricValue: z.number().finite().nullable(),
    minRelativeImprovement: z.number().finite().min(0),
  })
  .strict()
export type LoopConfiguration = z.infer<typeof LoopConfigurationSchema>

export const LoopConfigurationStateSchema = z.object({
  taskID: z.string(),
  revision: z.number().int().nonnegative(),
  cycleID: z.string().nullable(),
  locked: z.boolean(),
  lockReason: z.string().nullable(),
  configuration: LoopConfigurationSchema.extend({ maxIterations: z.number().int().positive() }),
})
export type LoopConfigurationState = z.infer<typeof LoopConfigurationStateSchema>
export const UpdateLoopConfigurationSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    configuration: LoopConfigurationSchema,
  })
  .strict()

export const LoopControlActionSchema = z.enum(["trial", "design", "finish-design"])
export type LoopControlAction = z.infer<typeof LoopControlActionSchema>
export const LoopControlInputSchema = z
  .object({
    action: LoopControlActionSchema,
    expectedRevision: z.number().int().nonnegative(),
    expectedDesignID: z.string().nullable(),
  })
  .strict()
export const SavedLoopControlSchema = z.object({
  action: LoopControlActionSchema,
  cycleID: z.string(),
  designID: z.string().nullable(),
  completedTrialsBefore: z.number().int().nonnegative(),
  status: z.enum(["active", "paused", "stopped"]),
})
export type SavedLoopControl = z.infer<typeof SavedLoopControlSchema>
