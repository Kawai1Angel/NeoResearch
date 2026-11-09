import { ExperimentConstraints } from "@/research/experiment-constraints"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import {
  abandonHypothesisInPool,
  addHypothesisToPool,
  listHypothesesInPool,
  loadTaskEvidenceForSession,
  resolveTaskIDBySessionID,
  updateHypothesisInPool,
  HypothesisNotFoundError,
  selectNextExperimentInPool,
} from "@/research/hypothesis-store"
import { MODEL_CAPABILITIES, validMechanisms } from "@/research/model-capabilities"
import { validateHypothesisEvidence, type HypothesisObject } from "@/research/agents/hypo-planner-agent"

type SafeResult<T> = { ok: true; value: T } | { ok: false; error: string }

async function safe<T>(fn: () => Promise<T>): Promise<SafeResult<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error: error instanceof HypothesisNotFoundError ? error.message : String(error) }
  }
}

const StringArray = Schema.optional(Schema.Array(Schema.String))
const EvidenceLevel = Schema.Literals(["data_only", "paper_supported", "conflicted"])
const EvidenceRole = Schema.Literals([
  "supports_mechanism",
  "supports_applicability",
  "suggests_implementation",
  "defines_evaluation",
  "warns_limitation",
  "contradicts",
])
const LiteratureEvidence = Schema.optional(
  Schema.Array(
    Schema.Struct({
      cardID: Schema.String,
      cardRevision: Schema.Number,
      role: EvidenceRole,
    }),
  ),
)

const NOT_IN_RESEARCH_SESSION =
  "This tool can only be used inside a research task session — could not resolve the current research task."

const AddParameters = Schema.Struct({
  experimentContract: Schema.optional(Schema.Unknown).annotate({ description: "Structured experiment: mode=baseline|exploratory|controlled; controlled requires comparisonRunID, changes [{operation:set|add|remove,path,before,after}], frozenPaths, requiredValues [{path,value}], forbiddenMechanisms. Paths and recipe object values use normalized camelCase (embedding.nFreq/dModel/complexMode, trainingStrategy), not wire snake_case. Introducing frequency requires an explicit complexMode: magnitude or real_imag. All other recipe fields are frozen automatically." }),
  statement: Schema.String.annotate({ description: "The hypothesis statement, stated as a testable claim." }),
  motivation: StringArray.annotate({ description: "Evidence/observations motivating this hypothesis." }),
  expectedOutcome: Schema.optional(Schema.String).annotate({
    description: "Concrete, metric-referenced prediction if the hypothesis holds.",
  }),
  suggestedBackbones: StringArray.annotate({ description: "Candidate model backbones/architectures to try." }),
  suggestedPreprocessing: StringArray.annotate({ description: "Candidate preprocessing steps to try." }),
  requiredMechanisms: StringArray.annotate({
    description: `Mechanisms the experiment must actually implement: ${Object.keys(MODEL_CAPABILITIES.mechanisms).join(", ")}. Unsupported mechanisms cannot be tested by relabeling a backbone.`,
  }),
  risk: Schema.optional(Schema.String).annotate({ description: "Key risk or failure mode for this hypothesis." }),
  testable: Schema.optional(Schema.Boolean).annotate({
    description: "Whether this hypothesis can be tested with an experiment run. Defaults to true.",
  }),
  datasetEvidencePaths: StringArray.annotate({ description: "Dataset JSON paths grounding this hypothesis." }),
  literatureEvidence: LiteratureEvidence.annotate({
    description: "Exact cardID/revision/role references from the task evidence bundle.",
  }),
  applicabilityAssumptions: StringArray.annotate({ description: "Conditions that must hold for literature transfer." }),
  falsificationCriteria: StringArray.annotate({
    description: "Concrete observations that would reject the hypothesis.",
  }),
  evidenceLevel: Schema.optional(EvidenceLevel).annotate({ description: "data_only, paper_supported, or conflicted." }),
})

type AddArgs = Schema.Schema.Type<typeof AddParameters>

export const HypothesisAddTool = Tool.define(
  "hypothesis_add",
  Effect.succeed({
    description:
      "Add a new hypothesis to the current research task's hypothesis pool. Use this to record a new model-design direction to explore.",
    parameters: AddParameters,
    execute: (args: AddArgs, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const taskID = yield* Effect.promise(() => resolveTaskIDBySessionID(ctx.sessionID))
        if (!taskID) {
          return {
            title: "hypothesis_add",
            metadata: { hypoID: undefined as string | undefined },
            output: NOT_IN_RESEARCH_SESSION,
          }
        }
        const hypothesis = {
          ...(args.experimentContract === undefined ? {} : { experimentContract: ExperimentConstraints.parse(args.experimentContract) }),
          statement: args.statement,
          motivation: args.motivation ?? [],
          expectedOutcome: args.expectedOutcome ?? "",
          suggestedBackbones: args.suggestedBackbones ?? [],
          suggestedPreprocessing: args.suggestedPreprocessing ?? [],
          requiredMechanisms: (args.requiredMechanisms ?? []) as NonNullable<HypothesisObject["requiredMechanisms"]>,
          risk: args.risk ?? "",
          testable: args.testable ?? true,
          datasetEvidencePaths: args.datasetEvidencePaths ?? [],
          literatureEvidence: args.literatureEvidence ?? [],
          applicabilityAssumptions: args.applicabilityAssumptions ?? [],
          falsificationCriteria: args.falsificationCriteria ?? [],
          evidenceLevel: args.evidenceLevel ?? ("data_only" as const),
        }
        const result = yield* Effect.promise(() =>
          safe(async () => {
            if (!hypothesis.experimentContract) throw new Error("New hypotheses require an explicit experimentContract; read the comparison run before defining controlled changes.")
            if (!validMechanisms(hypothesis.requiredMechanisms)) throw new Error("Unknown required mechanism")
            const taskEvidence = await loadTaskEvidenceForSession(taskID, ctx.sessionID)
            validateHypothesisEvidence([{ id: "pending", status: "pending", ...hypothesis }], taskEvidence)
            return addHypothesisToPool(taskID, hypothesis)
          }),
        )
        if (!result.ok) {
          return {
            title: "hypothesis_add",
            metadata: { hypoID: undefined as string | undefined },
            output: result.error,
          }
        }
        const created = result.value
        return {
          title: "hypothesis_add",
          metadata: { hypoID: created.id as string | undefined },
          output: `Added hypothesis ${created.id}: ${created.statement}`,
        }
      }),
  }),
)

const UpdateParameters = Schema.Struct({
  experimentContract: Schema.optional(Schema.Unknown),
  hypoID: Schema.String.annotate({ description: "ID of the hypothesis to update (see hypothesis_list)." }),
  statement: Schema.optional(Schema.String),
  motivation: StringArray,
  expectedOutcome: Schema.optional(Schema.String),
  suggestedBackbones: StringArray,
  suggestedPreprocessing: StringArray,
  requiredMechanisms: StringArray,
  risk: Schema.optional(Schema.String),
  testable: Schema.optional(Schema.Boolean),
  datasetEvidencePaths: StringArray,
  literatureEvidence: LiteratureEvidence,
  applicabilityAssumptions: StringArray,
  falsificationCriteria: StringArray,
  evidenceLevel: Schema.optional(EvidenceLevel),
})

type UpdateArgs = Schema.Schema.Type<typeof UpdateParameters>

export const HypothesisUpdateTool = Tool.define(
  "hypothesis_update",
  Effect.succeed({
    description:
      "Update fields (and/or status) of an existing hypothesis in the current research task's hypothesis pool.",
    parameters: UpdateParameters,
    execute: (args: UpdateArgs, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const taskID = yield* Effect.promise(() => resolveTaskIDBySessionID(ctx.sessionID))
        if (!taskID) {
          return {
            title: "hypothesis_update",
            metadata: { hypoID: undefined as string | undefined },
            output: NOT_IN_RESEARCH_SESSION,
          }
        }
        const { hypoID, ...rest } = args
        const result = yield* Effect.promise(() =>
          safe(async () => {
            const existing = (await listHypothesesInPool(taskID, { includeAbandoned: true })).find(
              (item) => item.id === hypoID,
            )
            if (!existing) throw new HypothesisNotFoundError(hypoID)
            if (rest.requiredMechanisms && !validMechanisms(rest.requiredMechanisms))
              throw new Error("Unknown required mechanism")
            const candidate: HypothesisObject = {
              ...existing,
              ...rest,
              experimentContract: rest.experimentContract === undefined ? existing.experimentContract : ExperimentConstraints.parse(rest.experimentContract),
              requiredMechanisms:
                (rest.requiredMechanisms as HypothesisObject["requiredMechanisms"]) ?? existing.requiredMechanisms,
            }
            const taskEvidence = await loadTaskEvidenceForSession(taskID, ctx.sessionID)
            validateHypothesisEvidence([candidate], taskEvidence)
            return updateHypothesisInPool(taskID, hypoID, { ...rest, experimentContract: candidate.experimentContract, requiredMechanisms: candidate.requiredMechanisms })
          }),
        )
        if (!result.ok) {
          return {
            title: "hypothesis_update",
            metadata: { hypoID: hypoID as string | undefined },
            output: result.error,
          }
        }
        return {
          title: "hypothesis_update",
          metadata: { hypoID: result.value.id as string | undefined },
          output: `Updated hypothesis ${result.value.id} (status: ${result.value.status ?? "pending"})`,
        }
      }),
  }),
)

const AbandonParameters = Schema.Struct({
  hypoID: Schema.String.annotate({ description: "ID of the hypothesis to abandon (see hypothesis_list)." }),
  reason: Schema.String.annotate({ description: "Why this hypothesis is being abandoned." }),
})

type AbandonArgs = Schema.Schema.Type<typeof AbandonParameters>

export const HypothesisAbandonTool = Tool.define(
  "hypothesis_abandon",
  Effect.succeed({
    description:
      "Mark a hypothesis as abandoned (soft delete). It is kept in history with the given reason and excluded from hypothesis_list by default.",
    parameters: AbandonParameters,
    execute: (args: AbandonArgs, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const taskID = yield* Effect.promise(() => resolveTaskIDBySessionID(ctx.sessionID))
        if (!taskID) {
          return {
            title: "hypothesis_abandon",
            metadata: { hypoID: undefined as string | undefined },
            output: NOT_IN_RESEARCH_SESSION,
          }
        }
        const result = yield* Effect.promise(() =>
          safe(() => abandonHypothesisInPool(taskID, args.hypoID, args.reason)),
        )
        if (!result.ok) {
          return {
            title: "hypothesis_abandon",
            metadata: { hypoID: args.hypoID as string | undefined },
            output: result.error,
          }
        }
        return {
          title: "hypothesis_abandon",
          metadata: { hypoID: result.value.id as string | undefined },
          output: `Abandoned hypothesis ${result.value.id}: ${args.reason}`,
        }
      }),
  }),
)

const ListParameters = Schema.Struct({
  includeAbandoned: Schema.optional(Schema.Boolean).annotate({
    description: "Include abandoned hypotheses (default false).",
  }),
})

type ListArgs = Schema.Schema.Type<typeof ListParameters>

export const HypothesisListTool = Tool.define(
  "hypothesis_list",
  Effect.succeed({
    description:
      "List hypotheses currently in the research task's hypothesis pool. Use this before hypothesis_add/update/abandon to see existing IDs and avoid duplicates.",
    parameters: ListParameters,
    execute: (args: ListArgs, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const taskID = yield* Effect.promise(() => resolveTaskIDBySessionID(ctx.sessionID))
        if (!taskID) {
          return {
            title: "hypothesis_list",
            metadata: { count: undefined as number | undefined },
            output: NOT_IN_RESEARCH_SESSION,
          }
        }
        const hypotheses = yield* Effect.promise(() =>
          listHypothesesInPool(taskID, { includeAbandoned: args.includeAbandoned }),
        )
        return {
          title: "hypothesis_list",
          metadata: { count: hypotheses.length as number | undefined },
          output: JSON.stringify(hypotheses, null, 2),
        }
      }),
  }),
)

const SelectParameters = Schema.Struct({
  action: Schema.Literals(["experiment", "stop"]),
  hypoID: Schema.optional(Schema.String).annotate({
    description: "Open testable hypothesis ID; required for action=experiment.",
  }),
  rationale: Schema.String.annotate({
    description:
      "Evidence-based reason for the next experiment or for stopping. Explain exploration vs refinement and local plateau evidence.",
  }),
})

export const HypothesisSelectTool = Tool.define(
  "hypothesis_select",
  Effect.succeed({
    description:
      "Choose the next experiment explicitly after updating the pool, or stop the search. This decision, not priority or creation order, controls the next model design.",
    parameters: SelectParameters,
    execute: (args: Schema.Schema.Type<typeof SelectParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const taskID = yield* Effect.promise(() => resolveTaskIDBySessionID(ctx.sessionID))
        if (!taskID) return { title: "hypothesis_select", metadata: {}, output: NOT_IN_RESEARCH_SESSION }
        const result = yield* Effect.promise(() =>
          safe(async () => {
            if (!args.rationale.trim()) throw new Error("A selection rationale is required")
            if (args.action === "experiment" && !args.hypoID?.trim())
              throw new Error("hypoID is required for an experiment")
            return selectNextExperimentInPool(
              taskID,
              args.action === "stop"
                ? { action: "stop", rationale: args.rationale.trim() }
                : { action: "experiment", hypothesisID: args.hypoID!.trim(), rationale: args.rationale.trim() },
            )
          }),
        )
        return {
          title: "hypothesis_select",
          metadata: {},
          output: result.ok ? JSON.stringify(result.value) : result.error,
        }
      }),
  }),
)
