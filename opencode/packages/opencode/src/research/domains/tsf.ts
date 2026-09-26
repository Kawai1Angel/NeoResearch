import { createHash } from "node:crypto"
import z from "zod"
import { existsSync, readFileSync } from "fs"
import path from "path"

import {
  DomainRunStage,
  type DomainSummaryContext,
  issue,
  type DomainArtifactContext,
  type DomainArtifactRender,
  type DomainCandidateProposal,
  type DomainCandidateRanking,
  type DomainProposalContext,
  type DomainRunEvaluation,
  type DomainRunEvaluationContext,
  type DomainRunPlan,
  type DomainValidationIssue,
  type DomainValidationResult,
  type ResearchDomain,
} from "../domain"
import type { JsonRecord } from "../schema"
import { createNeoCastRunnerCommand, getNeoCastRunnerManifestForTask } from "../runners/neo-cast-runner"

const ACTION_REGISTRY = {
  preprocessing: {
    last_value_centering: { phaseMin: "phase0b", bridgeSupported: true },
    none: { phaseMin: "phase0b", bridgeSupported: true },
    instance_norm: { phaseMin: "phase1", bridgeSupported: true },
    series_decomposition: { phaseMin: "phase1", bridgeSupported: true },
    seasonal_differencing: { phaseMin: "phase2", bridgeSupported: true },
    missing_mask: { phaseMin: "phase2", bridgeSupported: true },
    sample_reweighting: { phaseMin: "phase2", bridgeSupported: true },
  },
  embedding: {
    none: { phaseMin: "phase0b", bridgeSupported: true },
    patch: { phaseMin: "phase0b", bridgeSupported: true },
    invert: { phaseMin: "phase2", bridgeSupported: true },
    frequency: { phaseMin: "phase2", bridgeSupported: true },
    calendar: { phaseMin: "phase2", bridgeSupported: true },
    multiscale_patch: { phaseMin: "phase2", bridgeSupported: true },
  },
  backbone: {
    diagonal_ssm: { phaseMin: "phase2", bridgeSupported: true },
    timesblock_encoder: { phaseMin: "phase2", bridgeSupported: true },
    mamba: { phaseMin: "phase2", bridgeSupported: true },
    linear: { phaseMin: "phase0b", bridgeSupported: true },
    mlp: { phaseMin: "phase0b", bridgeSupported: true },
    transformer: { phaseMin: "phase0b", bridgeSupported: true },
    rnn: { phaseMin: "phase2", bridgeSupported: true },
    dlinear: { phaseMin: "phase2", bridgeSupported: true },
    tcn: { phaseMin: "phase2", bridgeSupported: true },
    gated_depthwise_conv: { phaseMin: "phase2", bridgeSupported: true },
    mixer: { phaseMin: "phase2", bridgeSupported: true },
    nbeats: { phaseMin: "phase2", bridgeSupported: true },
    timesnet_lite: { phaseMin: "phase2", bridgeSupported: true },
  },
  fusion: {
    feature_mlp: { phaseMin: "phase2", bridgeSupported: true },
    temporal: { phaseMin: "phase0b", bridgeSupported: true },
    variate_attention: { phaseMin: "phase2", bridgeSupported: true },
    temporal_then_feature: { phaseMin: "phase2", bridgeSupported: true },
    feature_then_temporal: { phaseMin: "phase2", bridgeSupported: true },
    graph: { phaseMin: "phase2", bridgeSupported: true },
    gated_hybrid: { phaseMin: "phase2", bridgeSupported: true },
  },
  head: {
    linear: { phaseMin: "phase0b", bridgeSupported: true },
    direct_multi_horizon: { phaseMin: "phase2", bridgeSupported: true },
    quantile: { phaseMin: "phase2", bridgeSupported: true },
    gaussian: { phaseMin: "phase2", bridgeSupported: true },
    residual_correction: { phaseMin: "phase2", bridgeSupported: true },
  },
  loss: {
    mse: { phaseMin: "phase0b", bridgeSupported: true },
    gaussian_nll: { phaseMin: "phase2", bridgeSupported: true },
    mae: { phaseMin: "phase1", bridgeSupported: true },
    huber: { phaseMin: "phase1", bridgeSupported: true },
    quantile: { phaseMin: "phase2", bridgeSupported: true },
    distillation: { phaseMin: "phase2", bridgeSupported: true },
  },
  optimizer: {
    adam: { phaseMin: "phase0b", bridgeSupported: true },
    adamw: { phaseMin: "phase0b", bridgeSupported: true },
    sgd: { phaseMin: "phase1", bridgeSupported: true },
  },
  scheduler: {
    none: { phaseMin: "phase0b", bridgeSupported: true },
    cosine: { phaseMin: "phase1", bridgeSupported: false },
    one_cycle: { phaseMin: "phase2", bridgeSupported: false },
    plateau: { phaseMin: "phase2", bridgeSupported: false },
    lradj_type1: { phaseMin: "phase2", bridgeSupported: false },
    lradj_type2: { phaseMin: "phase2", bridgeSupported: false },
    lradj_type3: { phaseMin: "phase2", bridgeSupported: false },
    lradj_3: { phaseMin: "phase2", bridgeSupported: false },
    lradj_4: { phaseMin: "phase2", bridgeSupported: false },
    lradj_5: { phaseMin: "phase2", bridgeSupported: false },
    lradj_6: { phaseMin: "phase2", bridgeSupported: false },
  },
} as const

const TSF_PROFILE_HEURISTIC_RANKER_VERSION = "tsf_profile_heuristic_v1"
const TSF_PROFILE_MEMORY_RANKER_VERSION = "tsf_profile_memory_ranker_v1"
const TSF_PROFILE_METRIC_MEMORY_RANKER_VERSION = "tsf_profile_metric_memory_ranker_v1"
const TSF_PROFILE_BENCHMARK_MEMORY_RANKER_VERSION = "tsf_profile_benchmark_memory_ranker_v1"
const TSF_PROFILE_LEARNED_MEMORY_RANKER_VERSION = "tsf_profile_learned_memory_ranker_v1"
const LEARNED_RANK_MIN_EXAMPLES = 2

const PositiveInt = z.number().int().min(1)
const JsonObject = z.record(z.string(), z.unknown())
const ValidationMetric = z.enum([
  "cv_avg_mse",
  "cv_avg_mae",
  "cv_avg_pinball",
  "cv_avg_crps_approx",
  "val_avg_mse",
  "val_avg_mae",
  "val_avg_pinball",
  "val_avg_crps_approx",
])
const ReferenceMetric = z.enum([
  "ref_test_avg_mse",
  "ref_test_avg_mae",
  "ref_test_avg_pinball",
  "ref_test_avg_crps_approx",
])

const DatasetSplitRatios = z.tuple([
  z.number().positive(),
  z.number().positive(),
  z.number().positive(),
])
const DatasetRowRange = z.tuple([z.number().int().min(0), z.number().int().positive()])
const DatasetSplit = z
  .discriminatedUnion("method", [
    z
      .object({
        method: z.literal("ratio"),
        ratios: DatasetSplitRatios.default([7, 1, 2]),
      })
      .strict(),
    z
      .object({
        method: z.literal("row_ranges"),
        trainRows: DatasetRowRange,
        validationRows: DatasetRowRange,
        testRows: DatasetRowRange,
      })
      .strict(),
  ])
  .superRefine((split, ctx) => {
    if (split.method !== "row_ranges") return
    if (split.trainRows[0] !== 0) {
      ctx.addIssue({ code: "custom", path: ["trainRows"], message: "trainRows must start at row 0" })
    }
    if (split.trainRows[1] !== split.validationRows[0] || split.validationRows[1] !== split.testRows[0]) {
      ctx.addIssue({
        code: "custom",
        path: ["validationRows"],
        message: "train, validation, and test row ranges must be contiguous and non-overlapping",
      })
    }
    for (const [name, range] of [
      ["trainRows", split.trainRows],
      ["validationRows", split.validationRows],
      ["testRows", split.testRows],
    ] as const) {
      if (range[1] <= range[0]) {
        ctx.addIssue({ code: "custom", path: [name], message: `${name} must be a non-empty [start, end) range` })
      }
    }
  })
  .default({ method: "ratio", ratios: [7, 1, 2] })

export const TSFTaskSpec = z
  .object({
    taskType: z.literal("forecasting").default("forecasting"),
    forecastMode: z.enum(["point", "probabilistic"]).default("point"),
    seriesType: z.enum(["univariate", "multivariate"]).default("multivariate"),
    contextLength: PositiveInt.max(8192),
    predictionLengths: z.array(PositiveInt.max(8192)).min(1),
    dataset: z
      .object({
        loaderID: z.string().min(1),
        path: z.string().optional(),
        targetCols: z.array(z.string().min(1)).default([]),
        knownFutureCovariates: z.array(z.string()).max(0, "UNSUPPORTED_COVARIATE: knownFutureCovariates is unavailable").default([]),
        observedPastCovariates: z.array(z.string()).default([]),
        staticCovariates: z.array(z.string()).max(0, "UNSUPPORTED_COVARIATE: staticCovariates is unavailable").default([]),
        split: DatasetSplit,
      })
      .superRefine((dataset, ctx) => {
        for (const [name, columns] of Object.entries({
          targetCols: dataset.targetCols,
          knownFutureCovariates: dataset.knownFutureCovariates,
          observedPastCovariates: dataset.observedPastCovariates,
          staticCovariates: dataset.staticCovariates,
        })) {
          if (new Set(columns).size !== columns.length) {
            ctx.addIssue({ code: "custom", path: [name], message: `${name} must contain unique columns` })
          }
        }
        const covariates = new Set([
          ...dataset.knownFutureCovariates,
          ...dataset.observedPastCovariates,
          ...dataset.staticCovariates,
        ])
        const overlap = dataset.targetCols.filter((column) => covariates.has(column))
        if (overlap.length > 0) {
          ctx.addIssue({
            code: "custom",
            path: ["targetCols"],
            message: `targetCols must not overlap covariates: ${overlap.join(", ")}`,
          })
        }
      })
      .strict(),
    evaluation: z
      .object({
        protocol: z.enum(["expanding_window_ratio", "fixed_split"]).default("expanding_window_ratio"),
        metricPrimary: ValidationMetric.default("cv_avg_mse"),
        metricReference: ReferenceMetric.optional(),
        seeds: z.array(z.number().int().min(0)).min(1).default([42]),
      })
      .strict()
      .default({ protocol: "expanding_window_ratio", metricPrimary: "cv_avg_mse", seeds: [42] }),
    constraints: z
      .object({
        maxParams: PositiveInt.optional(),
        maxTrainingSeconds: PositiveInt.optional(),
        maxGpuHoursTotal: z.number().positive().optional(),
        maxTrials: PositiveInt.optional(),
      })
      .strict()
      .default({}),
    runtime: z
      .object({
        bridgeOnly: z.boolean().default(true),
        neoCastProjectRoot: z.string().optional(),
        literatureSessionTools: z.boolean().optional(),
        pythonExecutable: z.string().min(1).default("python3"),
        currentCandidatePath: z.string().min(1).default(".neo-cast/current_candidate.json"),
        resolvedCandidatePath: z.string().min(1).default(".neo-cast/resolved_candidate.json"),
        artifactsDir: z.string().min(1).default(".neo-cast/artifacts"),
        deploymentTarget: z.string().min(1).optional(),
      })
      .strict()
      .default({
        bridgeOnly: true,
        pythonExecutable: "python3",
        currentCandidatePath: ".neo-cast/current_candidate.json",
        resolvedCandidatePath: ".neo-cast/resolved_candidate.json",
        artifactsDir: ".neo-cast/artifacts",
      }),
    metadata: JsonObject.default({}),
  })
  .strict()
export type TSFTaskSpec = z.infer<typeof TSFTaskSpec>

const PreprocessingAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("last_value_centering") }).strict(),
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("instance_norm"),
      affine: z.boolean().default(false),
      eps: z.number().positive().default(1e-5),
    })
    .strict(),
  z
    .object({
      type: z.literal("series_decomposition"),
      method: z.literal("moving_average").optional(),
      kernelSize: z.number().int().min(3).max(255).default(25),
    })
    .strict(),
  z
    .object({
      type: z.literal("seasonal_differencing"),
      period: PositiveInt.max(10000),
      order: PositiveInt.max(3).default(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("missing_mask"),
      maskChannel: z.literal(true).default(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("sample_reweighting"),
      scheme: z.enum(["uniform", "horizon_tail", "outlier_robust"]),
    })
    .strict(),
])

const Embedding = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("patch"),
      patchLen: PositiveInt.max(512),
      stride: PositiveInt.max(512),
      dModel: PositiveInt.max(1024),
    })
    .strict(),
  z
    .object({
      type: z.literal("invert"),
      dModel: PositiveInt.max(1024),
    })
    .strict(),
  z
    .object({
      type: z.literal("frequency"),
      nFreq: PositiveInt.max(1024),
      complexMode: z.enum(["real_imag", "magnitude"]).default("real_imag"),
      dModel: PositiveInt.max(1024),
    })
    .strict(),
  z
    .object({
      type: z.literal("calendar"),
      fields: z.array(z.enum(["hour", "dayofweek", "day", "month", "position"])).min(1),
      embedDim: PositiveInt.max(1024),
    })
    .strict(),
  z
    .object({
      type: z.literal("multiscale_patch"),
      numBlocks: PositiveInt.max(4).optional(),
      scales: z
        .array(z.object({ patchLen: PositiveInt.max(512), stride: PositiveInt.max(512) }).strict())
        .min(2)
        .max(4),
      dModel: PositiveInt.max(1024),
    })
    .strict(),
])

const Backbone = z.discriminatedUnion("type", [
  z.object({ type: z.literal("diagonal_ssm"), dModel: PositiveInt.max(512), stateDim: PositiveInt.max(512), depth: PositiveInt.max(8), dropout: z.number().min(0).lt(1) }).strict(),
  z.object({ type: z.literal("timesblock_encoder"), dModel: PositiveInt.max(512), dFf: PositiveInt.max(2048), depth: PositiveInt.max(8), topK: PositiveInt.max(16), numKernels: PositiveInt.max(8), dropout: z.number().min(0).lt(1) }).strict(),
  z.object({ type: z.literal("mamba"), dModel: PositiveInt.max(512), dState: PositiveInt.max(512), dConv: PositiveInt.max(32), expand: PositiveInt.max(4), depth: PositiveInt.max(8), dropout: z.number().min(0).lt(1), backend: z.enum(["torch_reference", "cuda_optimized"]) }).strict(),
  z.object({ type: z.literal("linear"), attention: z.enum(["none", "lightweight", "full"]).optional(), shared: z.boolean().default(false), bias: z.boolean().default(true) }).strict(),
  z
    .object({
      type: z.literal("mlp"), attention: z.enum(["none", "lightweight", "full"]).optional(),
      depth: PositiveInt.max(24),
      hiddenDim: PositiveInt.max(4096),
      activation: z.enum(["gelu", "relu", "silu"]).default("gelu"),
      dropout: z.number().min(0).max(0.9).default(0.1),
    })
    .strict(),
  z
    .object({
      type: z.literal("transformer"), attention: z.enum(["none", "lightweight", "full"]).optional(),
      dModel: PositiveInt.max(1024),
      nHeads: PositiveInt.max(32),
      nLayers: PositiveInt.max(24),
      dropout: z.number().min(0).max(0.9).default(0.1),
      ffnMult: z.number().min(1).max(16).default(4),
    })
    .strict(),
  z
    .object({
      type: z.literal("rnn"), attention: z.enum(["none", "lightweight", "full"]).optional(),
      cell: z.enum(["gru", "lstm", "rnn"]),
      hiddenDim: PositiveInt.max(4096),
      numLayers: PositiveInt.max(24),
      dropout: z.number().min(0).max(0.9).default(0.1),
    })
    .strict(),
  z
    .object({
      type: z.literal("dlinear"), attention: z.enum(["none", "lightweight", "full"]).optional(),
      kernelSize: z.number().int().min(3).max(255),
      bias: z.boolean().default(true),
      individual: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      type: z.literal("tcn"), attention: z.enum(["none", "lightweight", "full"]).optional(),
      hiddenDim: PositiveInt.max(4096),
      nLayers: PositiveInt.max(24),
      kernelSize: z.number().int().min(2).max(255),
      activation: z.enum(["gelu", "relu", "silu"]).default("gelu"),
      dropout: z.number().min(0).max(0.9).default(0.1),
    })
    .strict(),
  z
    .object({
      type: z.literal("gated_depthwise_conv"), attention: z.enum(["none", "lightweight", "full"]).optional(),
      kernelSize: z.number().int().min(2).max(255).optional(),
      hiddenDim: PositiveInt.max(4096),
      depth: PositiveInt.max(24),
      dropout: z.number().min(0).max(0.9).default(0.1),
    })
    .strict(),
  z
    .object({
      type: z.literal("mixer"), attention: z.enum(["none", "lightweight", "full"]).optional(),
      activation: z.enum(["gelu", "relu", "silu"]).optional(),
      hiddenDim: PositiveInt.max(4096),
      depth: PositiveInt.max(24),
      temporalMixing: z.enum(["mlp", "conv"]).default("mlp"),
      channelMixing: z.enum(["mlp", "identity"]).default("mlp"),
      dropout: z.number().min(0).max(0.9).default(0.1),
    })
    .strict(),
  z
    .object({
      type: z.literal("nbeats"), attention: z.enum(["none", "lightweight", "full"]).optional(),
      hiddenDim: PositiveInt.max(4096),
      nBlocks: PositiveInt.max(64),
      nLayers: PositiveInt.max(24),
      activation: z.enum(["gelu", "relu", "silu"]).default("gelu"),
      dropout: z.number().min(0).max(0.9).default(0.1),
    })
    .strict(),
  z
    .object({
      type: z.literal("timesnet_lite"), attention: z.enum(["none", "lightweight", "full"]).optional(),
      hiddenDim: PositiveInt.max(4096),
      nLayers: PositiveInt.max(24),
      topK: PositiveInt.max(16),
      kernelSize: z.number().int().min(2).max(255),
      dropout: z.number().min(0).max(0.9).default(0.1),
    })
    .strict(),
])

const Fusion = z.discriminatedUnion("type", [
  z.object({ type: z.literal("feature_mlp") }).strict(),
  z
    .object({
      type: z.literal("temporal"),
      channelMode: z.enum(["independent", "shared"]).default("independent"),
    })
    .strict(),
  z
    .object({
      type: z.literal("variate_attention"),
    })
    .strict(),
  z
    .object({
      type: z.literal("temporal_then_feature"),
      gate: z.boolean().default(true),
      residual: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("feature_then_temporal"),
      gate: z.boolean().default(true),
      residual: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("graph"),
      adjacencySource: z.enum(["learned", "static", "correlation"]),
      topologyArtifact: z.string().min(1).optional(),
      sparsity: z.number().min(0).max(1).default(0.1),
    })
    .strict(),
  z
    .object({
      type: z.literal("gated_hybrid"),
      gateType: z.enum(["scalar", "channel", "time", "learned"]).default("channel"),
    })
    .strict(),
])

const PredictionHead = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("linear"),
      outputDistribution: z.literal("point").default("point"),
    })
    .strict(),
  z
    .object({
      type: z.literal("direct_multi_horizon"),
      outputDistribution: z.literal("point").default("point"),
    })
    .strict(),
  z
    .object({
      type: z.literal("quantile"),
      outputDistribution: z.literal("quantile").default("quantile"),
      quantiles: z.array(z.number().gt(0).lt(1)).min(1).max(21),
    })
    .strict(),
  z
    .object({
      type: z.literal("gaussian"),
      outputDistribution: z.literal("gaussian").default("gaussian"),
      varianceFloor: z.number().positive().default(1e-6),
    })
    .strict(),
  z
    .object({
      type: z.literal("residual_correction"),
      outputDistribution: z.literal("point").default("point"),
      correctionDim: PositiveInt.max(4096),
    })
    .strict(),
])

const Representation = z.object({
  layout: z.enum(["channel_latent", "sequence_latent", "channel_sequence"]),
  readout: z.enum(["mean", "last", "none"]), latentDim: PositiveInt.max(512),
}).strict()
const SecondaryBranch = z.object({ backbone: Backbone, embedding: Embedding, representation: Representation }).strict()
const Composition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("single") }).strict(),
  z.object({ type: z.literal("parallel_two_branch"), secondary: SecondaryBranch, merge: z.enum(["latent_gate", "history_time_gate", "forecast_step_gate"]) }).strict(),
  z.object({ type: z.literal("decomposition_two_branch"), secondary: SecondaryBranch, kernelSize: PositiveInt.min(3).max(255) }).strict(),
])

export const TSFCandidateRecipe = z
  .object({
    recipeVersion: z.enum(["recipe_schema_v2", "recipe_schema_v3"]),
    representation: Representation.optional(),
    composition: Composition.optional(),
    recipeID: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/)
      .optional(),
    hypothesis: z.string().min(8).max(1200),
    preprocessing: z.object({ actions: z.array(PreprocessingAction).min(1) }).strict(),
    embedding: Embedding,
    backbone: Backbone,
    fusion: Fusion,
    predictionHead: PredictionHead,
    trainingStrategy: z
      .object({
        loss: z
          .object({
            base: z.enum(["mse", "mae", "huber", "quantile", "distillation", "gaussian_nll"]),
            horizonWeighting: z.enum(["uniform", "front_heavy", "tail_heavy", "learned_static"]).default("uniform"),
            delta: z.number().positive().optional(),
            quantiles: z.array(z.number().gt(0).lt(1)).min(1).max(21).optional(),
            supervisedWeight: z.number().min(0).optional(),
            teacherWeight: z.number().min(0).optional(),
            teacher: z
              .object({
                type: z.enum(["last_value", "moving_average"]),
                window: z.number().int().min(1).optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
        optimizer: z
          .object({
            type: z.enum(["adam", "adamw", "sgd"]),
            lr: z.number().positive().max(1),
            weightDecay: z.number().min(0).max(1).default(0),
          })
          .strict(),
        scheduler: z
          .object({
            type: z.enum([
              "none",
              "cosine",
              "one_cycle",
              "plateau",
              "lradj_type1",
              "lradj_type2",
              "lradj_type3",
              "lradj_3",
              "lradj_4",
              "lradj_5",
              "lradj_6",
            ]),
            // Epoch granularity (not mini-batch steps); must be < trainingStrategy.budget.maxEpochs.
            warmupSteps: z.number().int().min(0).default(0),
          })
          .strict(),
        regularization: z
          .object({ gradClip: z.number().positive().optional() })
          .strict()
          .default({}),
        budget: z
          .object({
            maxEpochs: PositiveInt.max(1000),
            timeBudgetS: PositiveInt,
            batchSize: PositiveInt.max(512),
            patience: PositiveInt.max(100),
            seed: z.number().int().min(0).default(42),
          })
          .strict(),
      })
      .strict(),
    notes: z.string().max(16000).optional(),
  })
  .strict()
  .superRefine((recipe, ctx) => {
    const sequence = ["diagonal_ssm", "timesblock_encoder", "mamba"].includes(recipe.backbone.type)
    if (recipe.recipeVersion === "recipe_schema_v2" && (sequence || recipe.representation || recipe.composition)) {
      ctx.addIssue({ code: "custom", path: ["recipeVersion"], message: "Typed encoders and composition require recipe_schema_v3" })
    }
    if (recipe.recipeVersion === "recipe_schema_v3") {
      const repr = recipe.representation
      if (!repr || (sequence ? repr.layout === "channel_latent" || repr.readout === "none" : repr.layout !== "channel_latent" || repr.readout !== "none")) {
        ctx.addIssue({ code: "custom", path: ["representation"], message: "Declare a compatible explicit layout, readout and latentDim" })
      }
      if (sequence && recipe.embedding.type !== "none") ctx.addIssue({ code: "custom", path: ["embedding"], message: "Sequence encoders require none embedding" })
      const comp = recipe.composition
      if (comp && comp.type !== "single") {
        if (recipe.fusion.type !== "temporal" || recipe.fusion.channelMode !== "independent") ctx.addIssue({ code: "custom", path: ["fusion"], message: "Composition requires temporal/independent" })
        if (comp.type === "decomposition_two_branch" || comp.merge === "forecast_step_gate") {
          if (recipe.predictionHead.outputDistribution !== "point") ctx.addIssue({ code: "custom", path: ["composition"], message: "Forecast composition only supports point heads" })
        }
        if (comp.type === "decomposition_two_branch" && comp.kernelSize % 2 === 0) ctx.addIssue({ code: "custom", path: ["composition", "kernelSize"], message: "Kernel must be odd" })
        if (comp.type === "parallel_two_branch" && comp.merge !== "forecast_step_gate" && repr?.latentDim !== comp.secondary.representation.latentDim) ctx.addIssue({ code: "custom", path: ["composition"], message: "Adapter output widths must match" })
      }
    }
    const types = recipe.preprocessing.actions.map((action) => action.type)
    if (new Set(types).size !== types.length || (types.includes("none") && types.length > 1)) {
      ctx.addIssue({ code: "custom", path: ["preprocessing", "actions"], message: "Duplicate actions and none combined with transformations are invalid" })
    }
    if (types.includes("missing_mask") && types[0] !== "missing_mask") {
      ctx.addIssue({ code: "custom", path: ["preprocessing", "actions"], message: "missing_mask must be first" })
    }
    if (types.includes("missing_mask") && recipe.fusion.type === "temporal" && recipe.fusion.channelMode === "independent" && !(sequence && recipe.representation?.layout === "sequence_latent")) {
      ctx.addIssue({ code: "custom", path: ["fusion"], message: "missing_mask requires cross-variable fusion" })
    }
    if (recipe.backbone.type === "dlinear" && types.includes("series_decomposition")) {
      ctx.addIssue({ code: "custom", path: ["preprocessing", "actions"], message: "DLinear already owns decomposition" })
    }
    if (recipe.fusion.type === "graph" && ((recipe.fusion.adjacencySource === "static") !== Boolean(recipe.fusion.topologyArtifact))) {
      ctx.addIssue({ code: "custom", path: ["fusion", "topologyArtifact"], message: "Only static graph requires topologyArtifact" })
    }
    if (recipe.predictionHead.type === "gaussian" && types.includes("seasonal_differencing")) {
      ctx.addIssue({ code: "custom", path: ["preprocessing", "actions"], message: "Gaussian inverse seasonal covariance is unsupported" })
    }
    const head = recipe.predictionHead
    const loss = recipe.trainingStrategy.loss
    const allowed = head.type === "quantile" ? ["quantile"] : head.type === "gaussian" ? ["gaussian_nll"] : ["mse", "mae", "huber", "distillation"]
    if (!allowed.includes(loss.base)) {
      ctx.addIssue({ code: "custom", path: ["trainingStrategy", "loss", "base"], message: `${head.type} requires loss in ${allowed.join(", ")}` })
    }
    if (head.type === "quantile") {
      for (const [values, issuePath] of [
        [head.quantiles, ["predictionHead", "quantiles"]],
        [loss.quantiles ?? head.quantiles, ["trainingStrategy", "loss", "quantiles"]],
      ] as const) {
        if (values.some((value, index) => index > 0 && value <= values[index - 1])) {
          ctx.addIssue({ code: "custom", path: [...issuePath], message: "Quantiles must be strictly increasing and unique" })
        }
      }
      if (loss.quantiles && JSON.stringify(loss.quantiles) !== JSON.stringify(head.quantiles)) {
        ctx.addIssue({ code: "custom", path: ["trainingStrategy", "loss", "quantiles"], message: "Loss quantiles must match head quantiles" })
      }
    } else if (loss.quantiles) {
      ctx.addIssue({ code: "custom", path: ["trainingStrategy", "loss", "quantiles"], message: "Quantiles require a quantile head and loss" })
    }
  })
export type TSFCandidateRecipe = z.infer<typeof TSFCandidateRecipe>
type TSFPreprocessingAction = TSFCandidateRecipe["preprocessing"]["actions"][number]
type TSFEmbedding = TSFCandidateRecipe["embedding"]
type TSFBackbone = TSFCandidateRecipe["backbone"]
type TSFFusion = TSFCandidateRecipe["fusion"]
type TSFPredictionHead = TSFCandidateRecipe["predictionHead"]
type DatasetProfile = {
  source: "dataset.path"
  path: string
  sourceFingerprint?: string
  profileFingerprint?: string
  taskID?: string
  workspaceRoot?: string
  rowCount: number
  targetCount: number
  numericColumnCount: number
  profiledRowCount?: number
  profiledColumnCount?: number
  missingRate: number
  trendStrength: number
  seasonalityStrength: number
  crossVarCorrelation: number
  distributionShift: number
  outlierRate?: number
  acfMainPeriod?: number
  acfMainPeriodStrength?: number
  adfStatistic?: number
  adfStationary?: boolean
  correlationMatrix?: {
    columns: string[]
    values: number[][]
  }
  timestampColumn?: string
  duplicateTimestampRate?: number
  monotonicTimestamp?: boolean
  irregularIntervalRatio?: number
}
type DatasetProfileWarning = {
  source: "dataset.path"
  path: string
  code: "dataset_read_failed" | "dataset_empty" | "no_numeric_columns" | "missing_target_columns" | "unverified_training_data"
  message: string
}
type DatasetProfileResult = {
  profile?: DatasetProfile
  warning?: DatasetProfileWarning
}

function zodIssues(result: { success: true } | { success: false; error: z.ZodError }): DomainValidationIssue[] {
  if (result.success) return []
  return result.error.issues.map((item) => issue(item.path.length ? item.path.join(".") : "$", item.message))
}

function actionSupported(kind: keyof typeof ACTION_REGISTRY, actionType: string, bridgeOnly: boolean) {
  const registry = ACTION_REGISTRY[kind] as Record<string, { bridgeSupported: boolean }>
  const meta = registry[actionType]
  if (!meta) return false
  return !bridgeOnly || meta.bridgeSupported
}

function validatePatch(
  label: string,
  patchLen: number,
  stride: number,
  contextLength: number,
  issues: DomainValidationIssue[],
) {
  if (patchLen > contextLength)
    issues.push(issue(`${label}.patchLen`, `${patchLen} exceeds contextLength=${contextLength}`))
  if (stride > patchLen) issues.push(issue(`${label}.stride`, `${stride} cannot exceed patchLen=${patchLen}`))
}

export function validateTSFCandidate(taskSpec: unknown, candidateSpec: unknown): DomainValidationResult {
  const taskResult = TSFTaskSpec.safeParse(taskSpec)
  const candidateResult = TSFCandidateRecipe.safeParse(candidateSpec)
  const issues = [...zodIssues(taskResult), ...zodIssues(candidateResult)]

  if (!taskResult.success || !candidateResult.success) {
    return { ok: false, issues }
  }

  const task = taskResult.data
  const recipe = candidateResult.data
  const bridgeOnly = task.runtime.bridgeOnly
  const preprocessingTypes = recipe.preprocessing.actions.map((action) => action.type)

  if (preprocessingTypes.includes("none") && preprocessingTypes.length > 1) {
    issues.push(issue("preprocessing.actions", "preprocessing action 'none' cannot be combined with other actions"))
  }

  for (const actionType of preprocessingTypes) {
    if (!actionSupported("preprocessing", actionType, bridgeOnly)) {
      issues.push(issue("preprocessing.actions", `Unsupported preprocessing action for current runtime: ${actionType}`))
    }
  }

  const checks = [
    ["embedding", recipe.embedding.type],
    ["backbone", recipe.backbone.type],
    ["fusion", recipe.fusion.type],
    ["head", recipe.predictionHead.type],
    ["loss", recipe.trainingStrategy.loss.base],
    ["optimizer", recipe.trainingStrategy.optimizer.type],
    ["scheduler", recipe.trainingStrategy.scheduler.type],
  ] as const

  for (const [kind, actionType] of checks) {
    if (!actionSupported(kind, actionType, bridgeOnly)) {
      issues.push(issue(kind, `Unsupported ${kind} action for current runtime: ${actionType}`))
    }
  }

  if (bridgeOnly && recipe.fusion.type === "temporal" && recipe.fusion.channelMode !== "independent") {
    issues.push(issue("fusion.channelMode", "Phase A/B bridge only supports independent channel fusion"))
  }

  if (bridgeOnly) {
    const pair = `${recipe.embedding.type}+${recipe.backbone.type}`
    if (!["none+linear", "patch+mlp", "patch+transformer"].includes(pair)) {
      issues.push(
        issue("backbone.type", "Phase A/B bridge supports only none+linear, patch+mlp, and patch+transformer"),
      )
    }
  }

  if (recipe.embedding.type === "patch") {
    validatePatch("embedding", recipe.embedding.patchLen, recipe.embedding.stride, task.contextLength, issues)
  }

  if (recipe.embedding.type === "multiscale_patch") {
    const seen = new Set<string>()
    recipe.embedding.scales.forEach((scale, index) => {
      validatePatch(`embedding.scales.${index}`, scale.patchLen, scale.stride, task.contextLength, issues)
      const key = `${scale.patchLen}:${scale.stride}`
      if (seen.has(key)) issues.push(issue(`embedding.scales.${index}`, `Duplicate multiscale patch scale: ${key}`))
      seen.add(key)
    })
  }

  if (recipe.backbone.type === "transformer") {
    if (recipe.backbone.dModel % recipe.backbone.nHeads !== 0) {
      issues.push(
        issue(
          "backbone.dModel",
          `dModel=${recipe.backbone.dModel} must be divisible by nHeads=${recipe.backbone.nHeads}`,
        ),
      )
    }
    if (recipe.embedding.type === "patch" && recipe.embedding.dModel !== recipe.backbone.dModel) {
      issues.push(issue("embedding.dModel", "embedding.dModel must match backbone.dModel for transformer recipes"))
    }
  }

  if (["dlinear", "tcn", "nbeats", "timesnet_lite"].includes(recipe.backbone.type) && recipe.embedding.type !== "none") {
    issues.push(issue("embedding.type", `backbone.type='${recipe.backbone.type}' requires embedding.type='none'`))
  }

  if (recipe.trainingStrategy.scheduler.warmupSteps >= recipe.trainingStrategy.budget.maxEpochs) {
    issues.push(
      issue(
        "trainingStrategy.scheduler.warmupSteps",
        "training_strategy.scheduler.warmupSteps must be less than budget.maxEpochs",
      ),
    )
  }

  return {
    ok: issues.every((item) => item.severity !== "error"),
    issues,
    normalizedCandidateSpec: recipe as unknown as NonNullable<DomainValidationResult["normalizedCandidateSpec"]>,
  }
}

function snakePreprocessingAction(action: TSFPreprocessingAction) {
  if (action.type === "series_decomposition") {
    return { type: action.type, kernel_size: action.kernelSize, ...(action.method ? { method: action.method } : {}) }
  }
  if (action.type === "seasonal_differencing") {
    return { type: action.type, period: action.period, order: action.order }
  }
  if (action.type === "missing_mask") {
    return { type: action.type, mask_channel: action.maskChannel }
  }
  return action
}

function snakeEmbedding(embedding: TSFEmbedding) {
  if (embedding.type === "patch") {
    return {
      type: embedding.type,
      patch_len: embedding.patchLen,
      stride: embedding.stride,
      d_model: embedding.dModel,
    }
  }
  if (embedding.type === "multiscale_patch") {
    return {
      ...(embedding.numBlocks === undefined ? {} : { num_blocks: embedding.numBlocks }),
      type: embedding.type,
      scales: embedding.scales.map((scale) => ({
        patch_len: scale.patchLen,
        stride: scale.stride,
      })),
      d_model: embedding.dModel,
    }
  }
  if (embedding.type === "invert") {
    return { type: embedding.type, d_model: embedding.dModel }
  }
  if (embedding.type === "frequency") {
    return { type: embedding.type, n_freq: embedding.nFreq, complex_mode: embedding.complexMode, d_model: embedding.dModel }
  }
  if (embedding.type === "calendar") {
    return { type: embedding.type, fields: embedding.fields, embed_dim: embedding.embedDim }
  }
  return { type: embedding.type }
}

function snakeBackbone(backbone: TSFBackbone) {
  if (backbone.type === "diagonal_ssm") return { type: backbone.type, d_model: backbone.dModel, state_dim: backbone.stateDim, depth: backbone.depth, dropout: backbone.dropout }
  if (backbone.type === "timesblock_encoder") return { type: backbone.type, d_model: backbone.dModel, d_ff: backbone.dFf, depth: backbone.depth, top_k: backbone.topK, num_kernels: backbone.numKernels, dropout: backbone.dropout }
  if (backbone.type === "mamba") return { type: backbone.type, d_model: backbone.dModel, d_state: backbone.dState, d_conv: backbone.dConv, expand: backbone.expand, depth: backbone.depth, dropout: backbone.dropout, backend: backbone.backend }
  if (backbone.type === "linear") {
    return { type: backbone.type, shared: backbone.shared, bias: backbone.bias }
  }
  if (backbone.type === "mlp") {
    return {
      type: backbone.type,
      depth: backbone.depth,
      hidden_dim: backbone.hiddenDim,
      activation: backbone.activation,
      dropout: backbone.dropout,
    }
  }
  if (backbone.type === "transformer") {
    return {
      type: backbone.type,
      d_model: backbone.dModel,
      n_heads: backbone.nHeads,
      n_layers: backbone.nLayers,
      dropout: backbone.dropout,
      ffn_mult: backbone.ffnMult,
    }
  }
  if (backbone.type === "dlinear") {
    return { type: backbone.type, kernel_size: backbone.kernelSize, bias: backbone.bias, individual: backbone.individual }
  }
  if (backbone.type === "rnn") {
    return {
      type: backbone.type,
      cell: backbone.cell,
      hidden_dim: backbone.hiddenDim,
      num_layers: backbone.numLayers,
      dropout: backbone.dropout,
    }
  }
  if (backbone.type === "tcn") {
    return {
      type: backbone.type,
      hidden_dim: backbone.hiddenDim,
      n_layers: backbone.nLayers,
      kernel_size: backbone.kernelSize,
      activation: backbone.activation,
      dropout: backbone.dropout,
    }
  }
  if (backbone.type === "gated_depthwise_conv") {
    return {
      ...(backbone.kernelSize === undefined ? {} : { kernel_size: backbone.kernelSize }),
      type: backbone.type,
      hidden_dim: backbone.hiddenDim,
      depth: backbone.depth,
      dropout: backbone.dropout,
    }
  }
  if (backbone.type === "mixer") {
    return {
      ...(backbone.activation === undefined ? {} : { activation: backbone.activation }),
      type: backbone.type,
      hidden_dim: backbone.hiddenDim,
      depth: backbone.depth,
      temporal_mixing: backbone.temporalMixing,
      channel_mixing: backbone.channelMixing,
      dropout: backbone.dropout,
    }
  }
  if (backbone.type === "nbeats") {
    return {
      type: backbone.type,
      hidden_dim: backbone.hiddenDim,
      n_blocks: backbone.nBlocks,
      n_layers: backbone.nLayers,
      activation: backbone.activation,
      dropout: backbone.dropout,
    }
  }
  return {
    type: backbone.type,
    hidden_dim: backbone.hiddenDim,
    n_layers: backbone.nLayers,
    top_k: backbone.topK,
    kernel_size: backbone.kernelSize,
    dropout: backbone.dropout,
  }
}

function snakeFusion(fusion: TSFFusion) {
  if (fusion.type === "temporal") {
    return { type: fusion.type, channel_mode: fusion.channelMode }
  }
  if (fusion.type === "variate_attention" || fusion.type === "feature_mlp") {
    return { type: fusion.type }
  }
  if (fusion.type === "temporal_then_feature" || fusion.type === "feature_then_temporal") {
    return { type: fusion.type, gate: fusion.gate, residual: fusion.residual }
  }
  if (fusion.type === "graph") {
    return { type: fusion.type, adjacency_source: fusion.adjacencySource, sparsity: fusion.sparsity, ...(fusion.topologyArtifact ? { topology_artifact: fusion.topologyArtifact } : {}) }
  }
  return { type: fusion.type, gate_type: fusion.gateType }
}

function snakePredictionHead(head: TSFPredictionHead) {
  if (head.type === "linear") {
    return { type: head.type, output_distribution: head.outputDistribution }
  }
  if (head.type === "direct_multi_horizon") {
    return {
      type: head.type,
      output_distribution: head.outputDistribution,
    }
  }
  if (head.type === "quantile") {
    return { type: head.type, output_distribution: head.outputDistribution, quantiles: head.quantiles }
  }
  if (head.type === "gaussian") {
    return { type: head.type, output_distribution: head.outputDistribution, variance_floor: head.varianceFloor }
  }
  return {
    type: head.type,
    output_distribution: head.outputDistribution,
    correction_dim: head.correctionDim,
  }
}

function snakeTrainingStrategy(recipe: TSFCandidateRecipe) {
  const strategy = recipe.trainingStrategy
  return {
    loss: {
      base: strategy.loss.base,
      horizon_weighting: strategy.loss.horizonWeighting,
      ...(strategy.loss.delta === undefined ? {} : { delta: strategy.loss.delta }),
      ...(strategy.loss.quantiles === undefined ? {} : { quantiles: strategy.loss.quantiles }),
      ...(strategy.loss.supervisedWeight === undefined ? {} : { supervised_weight: strategy.loss.supervisedWeight }),
      ...(strategy.loss.teacherWeight === undefined ? {} : { teacher_weight: strategy.loss.teacherWeight }),
      ...(strategy.loss.teacher === undefined
        ? {}
        : {
            teacher: {
              type: strategy.loss.teacher.type,
              ...(strategy.loss.teacher.window === undefined ? {} : { window: strategy.loss.teacher.window }),
            },
          }),
    },
    optimizer: {
      type: strategy.optimizer.type,
      lr: strategy.optimizer.lr,
      weight_decay: strategy.optimizer.weightDecay,
    },
    scheduler: {
      type: strategy.scheduler.type,
      warmup_steps: strategy.scheduler.warmupSteps,
    },
    regularization: {
      ...(strategy.regularization.gradClip === undefined ? {} : { grad_clip: strategy.regularization.gradClip }),
    },
    budget: {
      max_epochs: strategy.budget.maxEpochs,
      time_budget_s: strategy.budget.timeBudgetS,
      batch_size: strategy.budget.batchSize,
      patience: strategy.budget.patience,
      seed: strategy.budget.seed,
    },
  }
}

export function toNeoCastRecipePayload(task: TSFTaskSpec, recipe: TSFCandidateRecipe) {
  const constraints: Record<string, unknown> = {}
  if (task.constraints.maxParams !== undefined) constraints.max_params = task.constraints.maxParams

  return {
    recipe_version: recipe.recipeVersion,
    ...(recipe.recipeID === undefined ? {} : { recipe_id: recipe.recipeID }),
    hypothesis: recipe.hypothesis,
    preprocessing: {
      actions: recipe.preprocessing.actions.map(snakePreprocessingAction),
    },
    embedding: snakeEmbedding(recipe.embedding),
    backbone: { ...snakeBackbone(recipe.backbone), ...(!("attention" in recipe.backbone) || recipe.backbone.attention === undefined ? {} : { attention: recipe.backbone.attention }) },
    ...(recipe.representation ? { representation: { layout: recipe.representation.layout, readout: recipe.representation.readout, latent_dim: recipe.representation.latentDim } } : {}),
    ...(recipe.composition ? { composition: recipe.composition.type === "single" ? { type: "single" } : {
      type: recipe.composition.type,
      ...(recipe.composition.type === "parallel_two_branch" ? { merge: recipe.composition.merge } : { kernel_size: recipe.composition.kernelSize }),
      secondary: { backbone: snakeBackbone(recipe.composition.secondary.backbone), embedding: snakeEmbedding(recipe.composition.secondary.embedding),
        representation: { layout: recipe.composition.secondary.representation.layout, readout: recipe.composition.secondary.representation.readout, latent_dim: recipe.composition.secondary.representation.latentDim } },
    } } : {}),
    fusion: snakeFusion(recipe.fusion),
    prediction_head: snakePredictionHead(recipe.predictionHead),
    training_strategy: snakeTrainingStrategy(recipe),
    ...(Object.keys(constraints).length === 0 ? {} : { constraints }),
    ...(recipe.notes === undefined ? {} : { notes: recipe.notes }),
  }
}

function commandTimeoutForRecipe(stage: DomainRunStage, recipe?: TSFCandidateRecipe) {
  if (stage !== "low_fidelity" && stage !== "full") return undefined
  const timeBudgetS = recipe?.trainingStrategy.budget.timeBudgetS
  if (typeof timeBudgetS !== "number" || !Number.isFinite(timeBudgetS)) return undefined
  const recipeTimeoutMs = Math.max(120, timeBudgetS + 120) * 1000
  return stage === "full" ? Math.max(3_600_000, recipeTimeoutMs) : recipeTimeoutMs
}

function commandForStage(
  stage: DomainRunStage,
  task: TSFTaskSpec,
  description: string,
  recipe?: TSFCandidateRecipe,
  runnerRunID?: string,
): DomainRunPlan["command"] {
  const runtime = task.runtime
  const command = createNeoCastRunnerCommand({
    stage,
    runtime,
    description,
    runnerRunID,
    explicitRoot: runtime.neoCastProjectRoot,
  })
  const timeoutMs = commandTimeoutForRecipe(stage, recipe)
  return timeoutMs === undefined ? command : { ...command, timeoutMs }
}

function expectedEvents(stage: DomainRunStage) {
  if (stage === "smoke") return ["candidate_resolved", "smoke_eval_done", "done"]
  if (stage === "ref_test") return ["ref_test_done"]
  if (stage === "blind_test") return ["blind_test_done"]
  return ["candidate_resolved", "eval_done", "artifact_ready", "done"]
}

function expectedArtifacts(stage: DomainRunStage) {
  if (stage === "smoke") return ["resolved_candidate.json", "val_metrics.json"]
  if (stage === "ref_test") return ["ref_test_metrics.json", "eval_report.md"]
  if (stage === "blind_test") return ["blind_test_metrics.json"]
  return ["resolved_candidate.json", "val_metrics.json", "training_summary.json", "model.pt", "eval_report.md"]
}

export function createTSFRunPlan(input: {
  taskSpec: JsonRecord
  candidateSpec: JsonRecord
  stage?: DomainRunStage
  description?: string
  runnerRunID?: string
}): DomainRunPlan {
  const task = TSFTaskSpec.parse(input.taskSpec)
  const stage = DomainRunStage.parse(input.stage ?? "smoke")
  const validation = validateTSFCandidate(task as unknown as JsonRecord, input.candidateSpec)
  const parsedCandidate = TSFCandidateRecipe.safeParse(input.candidateSpec)
  const recipe = parsedCandidate.success ? parsedCandidate.data : undefined
  const description = input.description ?? recipe?.hypothesis ?? `NeoResearch TSF ${stage} run`
  const payload = recipe === undefined ? {} : toNeoCastRecipePayload(task, recipe)
  const runnerManifest = getNeoCastRunnerManifestForTask(task.runtime.neoCastProjectRoot)

  return {
    domainID: "tsf",
    runnerID: runnerManifest.runnerID,
    runnerKind: runnerManifest.runnerKind,
    stage,
    approvalRequired: stage === "ref_test" || stage === "blind_test",
    validation,
    writes: [
      {
        path: task.runtime.currentCandidatePath,
        content: payload as DomainRunPlan["writes"][number]["content"],
      },
    ],
    command: commandForStage(stage, task, description, recipe, input.runnerRunID),
    expectedEvents: expectedEvents(stage),
    expectedMetrics:
      stage === "ref_test"
        ? ["ref_test_avg_mse", "ref_test_avg_mae"]
        : stage === "blind_test"
          ? ["blind_test_avg_mse", "blind_test_avg_mae"]
          : stage === "smoke"
            ? ["val_avg_mse", "val_avg_mae"]
            : ["cv_avg_mse", "cv_std_mse", "val_avg_mse", "val_avg_mae"],
    expectedArtifacts: expectedArtifacts(stage),
    notes:
      "Run plan only renders the Neo-Cast bridge payload and subprocess command; caller owns file writes and process execution.",
  }
}

function trainingBudget(task: TSFTaskSpec) {
  return {
    maxEpochs: Math.min(50, task.constraints.maxTrials ?? 50),
    timeBudgetS: task.constraints.maxTrainingSeconds ?? 1200,
    batchSize: 32,
    patience: 5,
    seed: task.evaluation.seeds[0] ?? 42,
  }
}

function splitCSVLine(line: string) {
  const cells: string[] = []
  let current = ""
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === '"' && line[index + 1] === '"') {
      current += '"'
      index += 1
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (char === "," && !quoted) {
      cells.push(current)
      current = ""
      continue
    }
    current += char
  }
  cells.push(current)
  return cells
}

function selectCSVCells(line: string, indexes: number[]) {
  const positions = new Map(indexes.map((index, position) => [index, position]))
  const cells = Array<string>(indexes.length).fill("")
  let columnIndex = 0
  let current = ""
  let quoted = false
  let position = positions.get(columnIndex)
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === '"' && line[index + 1] === '"') {
      if (position !== undefined) current += '"'
      index += 1
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (char === "," && !quoted) {
      if (position !== undefined) cells[position] = current
      columnIndex += 1
      position = positions.get(columnIndex)
      current = ""
      continue
    }
    if (position !== undefined) current += char
  }
  if (position !== undefined) cells[position] = current
  return cells
}

function parseNumberCell(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return Number.NaN
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function pearson(xs: number[], ys: number[]) {
  let count = 0
  let xMean = 0
  let yMean = 0
  let covariance = 0
  let xVariance = 0
  let yVariance = 0
  for (let index = 0; index < Math.min(xs.length, ys.length); index++) {
    const x = xs[index]
    const y = ys[index]
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    count += 1
    const dx = x! - xMean
    xMean += dx / count
    const dy = y! - yMean
    yMean += dy / count
    covariance += dx * (y! - yMean)
    xVariance += dx * (x! - xMean)
    yVariance += dy * (y! - yMean)
  }
  if (count < 3) return 0
  const denom = Math.sqrt(xVariance * yVariance)
  return denom === 0 ? 0 : covariance / denom
}

function meanFinite(values: number[]) {
  const finite = values.filter(Number.isFinite)
  return finite.length === 0 ? 0 : finite.reduce((sum, value) => sum + value, 0) / finite.length
}

function stdFinite(values: number[]) {
  const finite = values.filter(Number.isFinite)
  if (finite.length < 2) return 0
  const mean = meanFinite(finite)
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length
  return Math.sqrt(variance)
}

function roundProfileValue(value: number) {
  if (!Number.isFinite(value)) return 0
  return Number(value.toFixed(6))
}

function column(matrix: number[][], index: number) {
  return matrix.map((row) => row[index] ?? Number.NaN)
}

function profileTimeAxis(header: string[], rows: string[][]) {
  const timestampIndex = header.findIndex((item) => ["date", "time", "timestamp", "datetime"].includes(item.toLowerCase()))
  const index = timestampIndex >= 0 ? timestampIndex : 0
  const values = rows.map((row) => Date.parse(row[index] ?? ""))
  const finiteValues = values.filter(Number.isFinite)
  if (finiteValues.length < 3 || finiteValues.length / Math.max(rows.length, 1) < 0.8) return undefined

  let previous = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    if (value <= previous) return undefined
    previous = value
  }
  return values
}

function trendStrength(values: number[], timeAxis?: number[]) {
  const xs: number[] = []
  const ys: number[] = []
  for (let index = 0; index < values.length; index++) {
    const value = values[index]
    if (!Number.isFinite(value)) continue
    const time = timeAxis?.[index]
    if (timeAxis && !Number.isFinite(time)) continue
    xs.push(timeAxis ? time! : xs.length)
    ys.push(value)
  }
  return Math.abs(pearson(xs, ys))
}

function profileTrend(matrix: number[][], timeAxis?: number[]) {
  if (matrix.length < 3) return 0
  const strengths = matrix[0]!.map((_, index) => trendStrength(column(matrix, index), timeAxis))
  return meanFinite(strengths)
}

function firstDifference(values: number[]) {
  const result: number[] = []
  for (let index = 1; index < values.length; index++) {
    const current = values[index]
    const previous = values[index - 1]
    result.push(Number.isFinite(current) && Number.isFinite(previous) ? current! - previous! : Number.NaN)
  }
  return result
}

function profileSeasonality(matrix: number[][]) {
  if (matrix.length < 8) return 0
  const candidateLags = [24, 48, 96, 12, 7].filter((lag) => lag < (matrix.length - 1) / 2)
  if (candidateLags.length === 0) return 0
  const strengths: number[] = []
  for (let col = 0; col < matrix[0]!.length; col++) {
    const values = firstDifference(column(matrix, col))
    const best = Math.max(
      ...candidateLags.map((lag) => Math.abs(pearson(values.slice(lag), values.slice(0, values.length - lag)))),
    )
    strengths.push(best)
  }
  return meanFinite(strengths)
}

function profileACFMainPeriod(matrix: number[][]) {
  if (matrix.length < 8) return undefined
  const candidateLags = [24, 48, 96, 12, 7].filter((lag) => lag < (matrix.length - 1) / 2)
  if (candidateLags.length === 0) return undefined
  let bestLag = candidateLags[0]!
  let bestStrength = 0
  for (const lag of candidateLags) {
    const strengths: number[] = []
    for (let col = 0; col < matrix[0]!.length; col++) {
      const values = column(matrix, col)
      strengths.push(Math.abs(pearson(values.slice(lag), values.slice(0, values.length - lag))))
    }
    const strength = meanFinite(strengths)
    if (strength > bestStrength) {
      bestLag = lag
      bestStrength = strength
    }
  }
  return {
    lag: bestLag,
    strength: roundProfileValue(bestStrength),
  }
}

function adfStatistic(values: number[]) {
  const xs: number[] = []
  const ys: number[] = []
  for (let index = 1; index < values.length; index++) {
    const previous = values[index - 1]
    const current = values[index]
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue
    xs.push(previous!)
    ys.push(current! - previous!)
  }
  if (xs.length < 4) return undefined
  const xMean = meanFinite(xs)
  const yMean = meanFinite(ys)
  let xx = 0
  let xy = 0
  for (let index = 0; index < xs.length; index++) {
    const dx = xs[index]! - xMean
    xx += dx * dx
    xy += dx * (ys[index]! - yMean)
  }
  if (xx === 0) return undefined
  const beta = xy / xx
  const alpha = yMean - beta * xMean
  const rss = xs.reduce((sum, x, index) => {
    const residual = ys[index]! - (alpha + beta * x)
    return sum + residual * residual
  }, 0)
  const variance = rss / Math.max(xs.length - 2, 1)
  const standardError = Math.sqrt(variance / xx)
  if (standardError === 0) return undefined
  return beta / standardError
}

function profileADF(matrix: number[][]) {
  const statistics: number[] = []
  for (let col = 0; col < (matrix[0]?.length ?? 0); col++) {
    const statistic = adfStatistic(column(matrix, col))
    if (statistic !== undefined) statistics.push(statistic)
  }
  if (statistics.length === 0) return undefined
  const statistic = roundProfileValue(meanFinite(statistics))
  return {
    statistic,
    stationary: statistic <= -3,
  }
}

function profileCrossCorrelation(matrix: number[][]) {
  const width = matrix[0]?.length ?? 0
  if (width < 2) return 0
  const correlations: number[] = []
  for (let left = 0; left < width; left++) {
    for (let right = left + 1; right < width; right++) {
      correlations.push(Math.abs(pearson(column(matrix, left), column(matrix, right))))
    }
  }
  return meanFinite(correlations)
}

function profileCorrelationMatrix(matrix: number[][], columns: string[]) {
  const width = matrix[0]?.length ?? 0
  if (width === 0) return undefined
  const series = Array.from({ length: width }, (_, index) => column(matrix, index))
  const values = Array.from({ length: width }, () => Array<number>(width).fill(0))
  for (let left = 0; left < width; left++) {
    values[left]![left] = 1
    for (let right = left + 1; right < width; right++) {
      const correlation = roundProfileValue(pearson(series[left]!, series[right]!))
      values[left]![right] = correlation
      values[right]![left] = correlation
    }
  }
  return {
    columns,
    values,
  }
}

function crossCorrelationFromMatrix(matrix: NonNullable<DatasetProfile["correlationMatrix"]>) {
  const correlations: number[] = []
  for (let left = 0; left < matrix.values.length; left++) {
    for (let right = left + 1; right < matrix.values.length; right++) {
      correlations.push(Math.abs(matrix.values[left]?.[right] ?? 0))
    }
  }
  return meanFinite(correlations)
}

function profileDistributionShift(matrix: number[][]) {
  if (matrix.length < 4) return 0
  const midpoint = Math.floor(matrix.length / 2)
  const first = matrix.slice(0, midpoint)
  const second = matrix.slice(midpoint)
  const shifts: number[] = []
  for (let col = 0; col < matrix[0]!.length; col++) {
    const firstValues = column(first, col)
    const secondValues = column(second, col)
    const allValues = column(matrix, col)
    const scale = stdFinite(allValues)
    const nearConstantThreshold = Math.max(1e-9, Math.abs(meanFinite(allValues)) * 1e-6)
    if (scale <= nearConstantThreshold) {
      shifts.push(0)
      continue
    }
    const meanShift = Math.abs(meanFinite(secondValues) - meanFinite(firstValues)) / scale
    const stdShift = Math.abs(stdFinite(secondValues) - stdFinite(firstValues)) / scale
    shifts.push(meanShift + 0.5 * stdShift)
  }
  return meanFinite(shifts)
}

function profileTimestampQuality(header: string[], rows: string[][]) {
  const timestampIndex = header.findIndex((item) => ["date", "time", "timestamp", "datetime"].includes(item.toLowerCase()))
  const index = timestampIndex >= 0 ? timestampIndex : 0
  const values = rows.map((row) => Date.parse(row[index] ?? "")).filter((value) => Number.isFinite(value))
  if (values.length < 2) return {}
  const duplicates = values.length - new Set(values).size
  let monotonicBreaks = 0
  const deltas: number[] = []
  for (let idx = 1; idx < values.length; idx++) {
    const delta = values[idx]! - values[idx - 1]!
    if (delta <= 0) monotonicBreaks += 1
    else deltas.push(delta)
  }
  const sortedDeltas = [...deltas].sort((left, right) => left - right)
  const medianDelta = sortedDeltas[Math.floor(sortedDeltas.length / 2)]
  const irregular =
    medianDelta === undefined || medianDelta <= 0
      ? 0
      : deltas.filter((delta) => Math.abs(delta - medianDelta) / medianDelta > 0.05).length / Math.max(deltas.length, 1)
  return {
    timestampColumn: header[index],
    duplicateTimestampRate: roundProfileValue(duplicates / values.length),
    monotonicTimestamp: monotonicBreaks === 0,
    irregularIntervalRatio: roundProfileValue(irregular),
  }
}

function profileOutlierRate(matrix: number[][]) {
  const values = matrix.flat().filter(Number.isFinite)
  if (values.length < 8) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const q1 = sorted[Math.floor(sorted.length * 0.25)]!
  const q3 = sorted[Math.floor(sorted.length * 0.75)]!
  const iqr = q3 - q1
  if (iqr <= 0) return 0
  const low = q1 - 3 * iqr
  const high = q3 + 3 * iqr
  return values.filter((value) => value < low || value > high).length / values.length
}

function datasetProfileWarning(
  path: string,
  code: DatasetProfileWarning["code"],
  message: string,
): DatasetProfileWarning {
  return { source: "dataset.path", path, code, message }
}

function safeTaskId(taskId: string): string {
  return taskId.trim().replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 64)
}

function firstNonEmptyLines(raw: string, limit: number) {
  const lines: string[] = []
  let start = 0
  while (start <= raw.length && lines.length < limit) {
    const newline = raw.indexOf("\n", start)
    const end = newline === -1 ? raw.length : newline
    const line = raw.slice(start, end).replace(/\r$/, "")
    if (line.trim().length > 0) lines.push(line)
    if (newline === -1) break
    start = newline + 1
  }
  return lines
}

function countNonEmptyLines(raw: string) {
  let count = 0
  let content = false
  for (let index = 0; index < raw.length; index++) {
    const char = raw.charCodeAt(index)
    if (char === 10) {
      if (content) count += 1
      content = false
      continue
    }
    if (char !== 13 && char !== 32 && char !== 9) content = true
  }
  if (content) count += 1
  return count
}

function sampleEvenly(values: number[], limit: number) {
  if (values.length <= limit) return values
  return Array.from({ length: limit }, (_, index) =>
    values[Math.round((index * (values.length - 1)) / (limit - 1))]!,
  )
}

export function resolveTSFProfileSource(task: Pick<TSFTaskSpec, "dataset">, context?: DomainSummaryContext): {
  raw?: string
  sourceRaw?: string
  sourceFingerprint?: string
  datasetPath?: string
  usingTrainFile?: boolean
  warning?: DatasetProfileWarning
} {
  if (!task.dataset.path) return {}
  const sourcePath = path.resolve(context?.projectRoot ?? process.cwd(), task.dataset.path)
  const hash = (raw: string) => createHash("sha256").update(raw).digest("hex")
  let sourceRaw: string
  try {
    sourceRaw = readFileSync(sourcePath, "utf8")
  } catch (error) {
    return { warning: datasetProfileWarning(sourcePath, "dataset_read_failed", String(error)) }
  }
  const sourceFingerprint = hash(sourceRaw)
  let raw = sourceRaw
  let datasetPath = sourcePath
  let usingTrainFile = false
  let warning: DatasetProfileWarning | undefined
  // The runner package root is code, never a source of task data.
  if (context) {
    const dataRoot = path.join(context.workspaceRoot, ".neo-cast", "dataset")
    const trainPath = path.join(dataRoot, `${safeTaskId(task.dataset.loaderID)}_train.csv`)
    if (existsSync(trainPath)) {
      try {
        const specRaw = readFileSync(path.join(dataRoot, "dataset_spec.json"), "utf8")
        const spec = JSON.parse(specRaw)
        const provenance = JSON.parse(readFileSync(path.join(dataRoot, "profile_provenance.json"), "utf8"))
        const trainRaw = readFileSync(trainPath, "utf8")
        if (path.resolve(spec.source_csv) !== sourcePath ||
            provenance.source_sha256 !== sourceFingerprint ||
            provenance.train_sha256 !== hash(trainRaw) ||
            provenance.spec_sha256 !== hash(specRaw) ||
            JSON.stringify(spec.target_columns) !== JSON.stringify(task.dataset.targetCols)) {
          throw new Error("Prepared data source, content fingerprint, or target columns do not match this task")
        }
        raw = trainRaw
        datasetPath = trainPath
        usingTrainFile = true
      } catch (error) {
        warning = datasetProfileWarning(trainPath, "unverified_training_data", `${String(error)}; profiling the task source prefix instead`)
      }
    }
  }
  return { raw, sourceRaw, sourceFingerprint, datasetPath, usingTrainFile, warning }
}

function profileTSFDataset(task: TSFTaskSpec, context?: DomainSummaryContext): DatasetProfileResult {
  const input = resolveTSFProfileSource(task, context)
  const { raw, sourceRaw, sourceFingerprint, datasetPath, warning } = input
  if (raw === undefined || sourceRaw === undefined || sourceFingerprint === undefined || !datasetPath) return { warning }
  const MAX_PROFILE_COLS = 20
  const MAX_PROFILE_ROWS = 5000
  const lines = firstNonEmptyLines(raw, MAX_PROFILE_ROWS + 1)
  const header = lines[0] ? splitCSVLine(lines[0]) : undefined
  if (!header || lines.length < 2) {
    return {
      warning: datasetProfileWarning(datasetPath, "dataset_empty", "Dataset profile requires a header and data rows."),
    }
  }
  const dataLines = lines.slice(1)
  const totalRowCount = Math.max(0, countNonEmptyLines(sourceRaw) - 1)
  const missingTargets = task.dataset.targetCols.filter((target) => !header.includes(target))
  if (missingTargets.length > 0) {
    return { warning: datasetProfileWarning(datasetPath, "missing_target_columns", `Missing target columns: ${missingTargets.join(", ")}`) }
  }
  const targetIndexes = task.dataset.targetCols
    .map((target) => header.indexOf(target))
    .filter((index) => index >= 0)
  let fallbackRows: string[][] | undefined
  const allNumericIndexes =
    targetIndexes.length > 0
      ? targetIndexes
      : header
          .map((_, index) => index)
          .filter((index) => {
            fallbackRows ??= dataLines.map(splitCSVLine)
            const parsed = fallbackRows.map((row) => parseNumberCell(row[index] ?? ""))
            const valid = parsed.filter(Number.isFinite).length
            return valid > 0 && valid / fallbackRows.length >= 0.5
          })
  if (allNumericIndexes.length === 0) {
    return {
      warning: datasetProfileWarning(
        datasetPath,
        "no_numeric_columns",
        "Dataset profile could not find numeric target or fallback columns.",
      ),
    }
  }
  const numericIndexes = sampleEvenly(allNumericIndexes, MAX_PROFILE_COLS)
  const timestampIndex = header.findIndex((item) => ["date", "time", "timestamp", "datetime"].includes(item.toLowerCase()))
  const profileIndexes = [...new Set([timestampIndex >= 0 ? timestampIndex : 0, ...numericIndexes])].sort((left, right) => left - right)
  const profileHeader = profileIndexes.map((index) => header[index] ?? `col_${index}`)
  const profilePositions = new Map(profileIndexes.map((index, position) => [index, position]))
  const profileNumericIndexes = numericIndexes.map((index) => profilePositions.get(index)!)
  const dataRows = dataLines.map((line) => selectCSVCells(line, profileIndexes))

  let missing = 0
	  const matrix = dataRows.map((row) =>
	    profileNumericIndexes.map((index) => {
	      const value = parseNumberCell(row[index] ?? "")
	      if (!Number.isFinite(value)) missing += 1
	      return value
	    }),
	  )
	  const timeAxis = profileTimeAxis(profileHeader, dataRows)
	  const numericColumns = numericIndexes.map((index) => header[index] ?? `col_${index}`)
	  const acf = profileACFMainPeriod(matrix)
	  const adf = profileADF(matrix)
	  const correlationMatrix = profileCorrelationMatrix(matrix, numericColumns)
	  const totalCells = Math.max(dataRows.length * numericIndexes.length, 1)
	  const profileFingerprint = createHash("sha256")
	    .update(sourceFingerprint)
	    .update("\0")
	    .update(raw)
	    .update("\0")
	    .update(JSON.stringify(task.dataset.targetCols))
	    .digest("hex")
	  return {
	    ...(warning ? { warning } : {}),
	    profile: {
	      source: "dataset.path",
      path: datasetPath,
      sourceFingerprint,
      profileFingerprint,
      ...(context ? { taskID: context.taskID, workspaceRoot: context.workspaceRoot } : {}),
      rowCount: totalRowCount,
      targetCount: targetIndexes.length,
      numericColumnCount: allNumericIndexes.length,
      profiledRowCount: dataRows.length,
      profiledColumnCount: numericIndexes.length,
      missingRate: roundProfileValue(missing / totalCells),
      trendStrength: roundProfileValue(profileTrend(matrix, timeAxis)),
      seasonalityStrength: roundProfileValue(profileSeasonality(matrix)),
	      crossVarCorrelation: roundProfileValue(
	        correlationMatrix ? crossCorrelationFromMatrix(correlationMatrix) : profileCrossCorrelation(matrix),
	      ),
	      distributionShift: roundProfileValue(profileDistributionShift(matrix)),
	      outlierRate: roundProfileValue(profileOutlierRate(matrix)),
	      ...(acf === undefined
	        ? {}
	        : {
	            acfMainPeriod: acf.lag,
	            acfMainPeriodStrength: acf.strength,
	          }),
	      ...(adf === undefined
	        ? {}
	        : {
	            adfStatistic: adf.statistic,
	            adfStationary: adf.stationary,
	          }),
	      ...(correlationMatrix === undefined ? {} : { correlationMatrix }),
	      ...profileTimestampQuality(profileHeader, dataRows),
	    },
	  }
	}

function datasetProfileBiases(profile: DatasetProfile | undefined) {
  if (!profile) return []
  return [
    profile.seasonalityStrength >= 0.4 ? "seasonal" : undefined,
    profile.trendStrength >= 0.2 ? "trend" : undefined,
    profile.crossVarCorrelation >= 0.5 ? "cross_var_correlated" : undefined,
    profile.missingRate > 0 ? "missing_values" : undefined,
    profile.distributionShift >= 0.5 ? "distribution_shift" : undefined,
  ].filter((value): value is string => typeof value === "string")
}

function baseStrategy(task: TSFTaskSpec) {
  return {
    loss: { base: "mse", horizonWeighting: "uniform" },
    optimizer: { type: "adam", lr: 0.001, weightDecay: 0 },
    scheduler: { type: "none", warmupSteps: 0 },
    regularization: { gradClip: 1 },
    budget: trainingBudget(task),
  } satisfies TSFCandidateRecipe["trainingStrategy"]
}

export function summarizeTSFTask(taskSpec: unknown, context?: DomainSummaryContext): JsonRecord {
  const task = TSFTaskSpec.parse(taskSpec)
  const maxPredictionLength = Math.max(...task.predictionLengths)
  const horizonContextRatio = Number((maxPredictionLength / task.contextLength).toFixed(6))
  const datasetProfileResult = profileTSFDataset(task, context)
  const datasetProfile = datasetProfileResult.profile
  const metadataBiases = searchBiasList(task.metadata as JsonRecord)
  const effectiveSeriesType =
    task.dataset.targetCols.length === 1 ? "univariate" : task.seriesType
  const searchBiases = [
    effectiveSeriesType === "multivariate" ? "multivariate" : "univariate",
    horizonContextRatio >= 1 ? "long_horizon" : "short_horizon",
    task.runtime.bridgeOnly ? "bridge_safe" : "full_recipe_space",
    task.forecastMode === "probabilistic" ? "probabilistic" : "point_forecast",
    ...datasetProfileBiases(datasetProfile),
    ...metadataBiases,
  ]

  return {
    taskType: task.taskType,
    forecastMode: task.forecastMode,
    seriesType: effectiveSeriesType,
    loaderID: task.dataset.loaderID,
    dataSplit: task.dataset.split,
    targetCount: task.dataset.targetCols.length,
    contextLength: task.contextLength,
    predictionLengths: task.predictionLengths,
    maxPredictionLength,
    horizonContextRatio,
    horizonContextScore: Math.min(1, horizonContextRatio),
    metricPrimary: task.evaluation.metricPrimary,
    seedCount: task.evaluation.seeds.length,
    bridgeOnly: task.runtime.bridgeOnly,
    searchBiases: [...new Set(searchBiases)],
    ...(datasetProfile === undefined ? {} : { datasetProfile }),
    ...(datasetProfileResult.warning === undefined ? {} : { datasetProfileWarning: datasetProfileResult.warning }),
    ...(task.constraints.maxParams === undefined ? {} : { maxParams: task.constraints.maxParams }),
    ...(task.constraints.maxTrainingSeconds === undefined
      ? {}
      : { maxTrainingSeconds: task.constraints.maxTrainingSeconds }),
  } as unknown as JsonRecord
}

function recipe(
  task: TSFTaskSpec,
  input: Omit<TSFCandidateRecipe, "recipeVersion" | "trainingStrategy"> & {
    trainingStrategy?: TSFCandidateRecipe["trainingStrategy"]
  },
): TSFCandidateRecipe {
  return {
    recipeVersion: "recipe_schema_v3",
    representation: { layout: "channel_latent", readout: "none", latentDim: Math.min(task.contextLength, 64) },
    composition: { type: "single" },
    trainingStrategy: baseStrategy(task),
    ...input,
    fusion: input.fusion.type === "temporal" && input.fusion.channelMode === "shared" ? { type: "feature_mlp" } : input.fusion,
  }
}

function withOptimizer(
  candidate: TSFCandidateRecipe,
  optimizer: Partial<TSFCandidateRecipe["trainingStrategy"]["optimizer"]>,
): TSFCandidateRecipe {
  return {
    ...candidate,
    trainingStrategy: {
      ...candidate.trainingStrategy,
      optimizer: {
        ...candidate.trainingStrategy.optimizer,
        ...optimizer,
      },
    },
  }
}

export function buildTSFBaselines(taskSpec: unknown): DomainCandidateProposal[] {
  const task = TSFTaskSpec.parse(taskSpec)

  if (task.runtime.bridgeOnly) {
    const candidates = [
      recipe(task, {
        recipeID: "tsf_linear_raw_baseline",
        hypothesis: "A raw linear temporal baseline should establish the simplest forecasting floor.",
        preprocessing: { actions: [{ type: "none" }] },
        embedding: { type: "none" },
        backbone: { type: "linear", shared: false, bias: true },
        fusion: { type: "temporal", channelMode: "independent" },
        predictionHead: { type: "linear", outputDistribution: "point" },
      }),
    ]
    return candidates.map((candidate) => ({
      candidateSpec: candidate as unknown as DomainCandidateProposal["candidateSpec"],
      rationale: candidate.hypothesis,
      riskLevel: "low",
      approvalStatus: "pending",
      generatedBy: "heuristic",
    }))
  }

  const patchLen = Math.min(16, task.contextLength)
  const stride = Math.max(1, Math.floor(patchLen / 2))
  const dModel = 64
  const patchTSTDModel = 512
  const dlinearKernelSize = 25

  const candidates = [
    recipe(task, {
      recipeID: "tsf_baseline_patchtst",
      hypothesis:
        "PatchTST: instance-normalized patch embedding with a channel-independent transformer backbone should provide a strong general-purpose baseline.",
      preprocessing: { actions: [{ type: "instance_norm", affine: false, eps: 1e-5 }] },
      embedding: { type: "patch", patchLen, stride, dModel: patchTSTDModel },
      backbone: { type: "transformer", dModel: patchTSTDModel, nHeads: 8, nLayers: 2, dropout: 0.05, ffnMult: 4 },
      fusion: { type: "temporal", channelMode: "independent" },
      predictionHead: { type: "linear", outputDistribution: "point" },
      trainingStrategy: {
        ...baseStrategy(task),
        optimizer: { type: "adam", lr: 0.0001, weightDecay: 0 },
        scheduler: { type: "lradj_type3", warmupSteps: 0 },
        regularization: { gradClip: 1 },
        budget: {
          ...trainingBudget(task),
          maxEpochs: 100,
          batchSize: 128,
          patience: 100,
          seed: 2021,
        },
      },
    }),
    recipe(task, {
      recipeID: "tsf_baseline_dlinear",
      hypothesis:
        "DLinear: moving-average decomposition into trend and seasonal components, each modeled by a linear layer, should establish a decomposition-aware baseline.",
      preprocessing: { actions: [{ type: "none" }] },
      embedding: { type: "none" },
      backbone: { type: "dlinear", kernelSize: dlinearKernelSize, bias: true, individual: false },
      fusion: { type: "temporal", channelMode: "independent" },
      predictionHead: { type: "linear", outputDistribution: "point" },
      trainingStrategy: {
        ...baseStrategy(task),
        optimizer: { type: "adam", lr: 0.0001, weightDecay: 0 },
        scheduler: { type: "lradj_type1", warmupSteps: 0 },
        budget: {
          ...trainingBudget(task),
          maxEpochs: 10,
          batchSize: 32,
          patience: 3,
          seed: 2021,
        },
      },
    }),
    recipe(task, {
      recipeID: "tsf_baseline_itransformer",
      hypothesis:
        "iTransformer: inverted embedding treats each variate as a token and applies cross-variate attention, testing whether multivariate dependencies improve forecasts.",
      preprocessing: { actions: [{ type: "instance_norm", affine: true, eps: 1e-5 }] },
      embedding: { type: "invert", dModel: 512 },
      backbone: { type: "transformer", dModel: 512, nHeads: 8, nLayers: 2, dropout: 0.1, ffnMult: 4 },
      fusion: { type: "variate_attention" },
      predictionHead: { type: "direct_multi_horizon", outputDistribution: "point" },
      trainingStrategy: {
        ...baseStrategy(task),
        optimizer: { type: "adam", lr: 0.0001, weightDecay: 0 },
        scheduler: { type: "lradj_type1", warmupSteps: 0 },
        budget: {
          ...trainingBudget(task),
          maxEpochs: 10,
          batchSize: 32,
          patience: 3,
          seed: 2023,
        },
      },
    }),
  ]

  return candidates.map((candidate) => ({
    candidateSpec: candidate as unknown as DomainCandidateProposal["candidateSpec"],
    rationale: candidate.hypothesis,
    riskLevel: "low",
    approvalStatus: "pending",
    generatedBy: "heuristic",
  }))
}

function bridgeFrontierRecipes(task: TSFTaskSpec): TSFCandidateRecipe[] {
  const patchLen = Math.min(16, task.contextLength)
  const stride = Math.max(1, Math.floor(patchLen / 2))
  const shortPatchLen = Math.min(8, task.contextLength)
  const shortStride = Math.max(1, Math.floor(shortPatchLen / 2))
  const dModel = 64

  return [
    withOptimizer(
      recipe(task, {
        recipeID: "tsf_bridge_patch_mlp_wide_adamw",
        hypothesis: "A wider patch MLP with AdamW tests capacity and optimizer regularization together.",
        preprocessing: { actions: [{ type: "none" }] },
        embedding: { type: "patch", patchLen, stride, dModel },
        backbone: { type: "mlp", depth: 3, hiddenDim: 256, activation: "gelu", dropout: 0.1 },
        fusion: { type: "temporal", channelMode: "independent" },
        predictionHead: { type: "linear", outputDistribution: "point" },
        notes: "Bridge-safe modular frontier: embedding/backbone/optimizer combination.",
      }),
      { type: "adamw", lr: 0.0007, weightDecay: 0.01 },
    ),
    recipe(task, {
      recipeID: "tsf_bridge_patch_mlp_short_patch",
      hypothesis: "Shorter patches should increase local temporal resolution for the MLP backbone.",
      preprocessing: { actions: [{ type: "none" }] },
      embedding: { type: "patch", patchLen: shortPatchLen, stride: shortStride, dModel },
      backbone: { type: "mlp", depth: 3, hiddenDim: 192, activation: "gelu", dropout: 0.1 },
      fusion: { type: "temporal", channelMode: "independent" },
      predictionHead: { type: "linear", outputDistribution: "point" },
      notes: "Bridge-safe modular frontier: patch granularity variation.",
    }),
    recipe(task, {
      recipeID: "tsf_bridge_patch_transformer_deeper",
      hypothesis: "A deeper small transformer tests whether additional temporal attention improves validation error.",
      preprocessing: { actions: [{ type: "none" }] },
      embedding: { type: "patch", patchLen, stride, dModel },
      backbone: { type: "transformer", dModel, nHeads: 4, nLayers: 3, dropout: 0.08, ffnMult: 4 },
      fusion: { type: "temporal", channelMode: "independent" },
      predictionHead: { type: "linear", outputDistribution: "point" },
      notes: "Bridge-safe modular frontier: transformer depth variation.",
    }),
    withOptimizer(
      recipe(task, {
        recipeID: "tsf_bridge_patch_transformer_adamw",
        hypothesis: "AdamW regularization may stabilize the patch transformer baseline.",
        preprocessing: { actions: [{ type: "none" }] },
        embedding: { type: "patch", patchLen, stride, dModel },
        backbone: { type: "transformer", dModel, nHeads: 4, nLayers: 2, dropout: 0.15, ffnMult: 4 },
        fusion: { type: "temporal", channelMode: "independent" },
        predictionHead: { type: "linear", outputDistribution: "point" },
        notes: "Bridge-safe modular frontier: optimizer and dropout variation.",
      }),
      { type: "adamw", lr: 0.0007, weightDecay: 0.01 },
    ),
    withOptimizer(
      recipe(task, {
        recipeID: "tsf_bridge_linear_adamw_floor",
        hypothesis: "A regularized linear floor checks whether optimizer changes help without representation changes.",
        preprocessing: { actions: [{ type: "none" }] },
        embedding: { type: "none" },
        backbone: { type: "linear", shared: false, bias: true },
        fusion: { type: "temporal", channelMode: "independent" },
        predictionHead: { type: "linear", outputDistribution: "point" },
        notes: "Bridge-safe modular frontier: optimizer-only control.",
      }),
      { type: "adamw", lr: 0.0007, weightDecay: 0.01 },
    ),
  ]
}

function numberFromRecord(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function datasetProfileFromFingerprint(taskFingerprint: Record<string, unknown>): DatasetProfile | undefined {
  const rawProfile = taskFingerprint.datasetProfile
  if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) return undefined
  const record = rawProfile as Record<string, unknown>
  return {
    source: "dataset.path",
    path: typeof record.path === "string" ? record.path : "",
    rowCount: numberFromRecord(record, "rowCount"),
    targetCount: numberFromRecord(record, "targetCount"),
    numericColumnCount: numberFromRecord(record, "numericColumnCount"),
    missingRate: numberFromRecord(record, "missingRate"),
    trendStrength: numberFromRecord(record, "trendStrength"),
	    seasonalityStrength: numberFromRecord(record, "seasonalityStrength"),
	    crossVarCorrelation: numberFromRecord(record, "crossVarCorrelation"),
	    distributionShift: numberFromRecord(record, "distributionShift"),
	    ...(typeof record.outlierRate === "number" ? { outlierRate: numberFromRecord(record, "outlierRate") } : {}),
	    ...(typeof record.acfMainPeriod === "number" ? { acfMainPeriod: numberFromRecord(record, "acfMainPeriod") } : {}),
	    ...(typeof record.acfMainPeriodStrength === "number"
	      ? { acfMainPeriodStrength: numberFromRecord(record, "acfMainPeriodStrength") }
	      : {}),
	    ...(typeof record.adfStatistic === "number" ? { adfStatistic: numberFromRecord(record, "adfStatistic") } : {}),
	    ...(typeof record.adfStationary === "boolean" ? { adfStationary: record.adfStationary } : {}),
	  }
	}

function searchBiasSet(taskFingerprint: JsonRecord) {
  const biases = taskFingerprint.searchBiases
  return new Set(
    Array.isArray(biases) ? biases.filter((item): item is string => typeof item === "string" && item.length > 0) : [],
  )
}

function searchBiasList(taskFingerprint: JsonRecord) {
  const biases = taskFingerprint.searchBiases
  return Array.isArray(biases) ? biases.filter((item): item is string => typeof item === "string" && item.length > 0) : []
}

function datasetProfileSignals(taskFingerprint: JsonRecord): JsonRecord {
  const profile = datasetProfileFromFingerprint(taskFingerprint)
  const biases = searchBiasSet(taskFingerprint)
  const active = new Set<string>()
  if ((profile?.seasonalityStrength ?? 0) >= 0.4 || biases.has("seasonal")) active.add("seasonal")
  if ((profile?.trendStrength ?? 0) >= 0.2 || biases.has("trend")) active.add("trend")
  if ((profile?.crossVarCorrelation ?? 0) >= 0.5 || biases.has("cross_var_correlated")) {
    active.add("cross_var_correlated")
  }
  if ((profile?.missingRate ?? 0) > 0 || biases.has("missing_values")) active.add("missing_values")
  if ((profile?.distributionShift ?? 0) >= 0.5 || biases.has("distribution_shift")) active.add("distribution_shift")
  if (biases.has("probabilistic")) active.add("probabilistic")
  if (biases.has("bridge_safe")) active.add("bridge_safe")
  if (biases.has("full_recipe_space")) active.add("full_recipe_space")

  return {
    source: profile ? profile.source : "taskFingerprint",
    active: [...active].sort(),
    profileAvailable: profile !== undefined,
  } as unknown as JsonRecord
}

function rankEvidenceSummary(historyContext?: RankHistoryContext): JsonRecord {
  if (!historyContext) {
    return {
      memoryEvidenceCount: 0,
      benchmarkEvidenceCount: 0,
      metricEvidenceCount: 0,
      acceptedMemoryEvidenceCount: 0,
      failedMemoryEvidenceCount: 0,
    } as unknown as JsonRecord
  }
  return {
    memoryEvidenceCount: historyContext.memory.length,
    benchmarkEvidenceCount: historyContext.memory.filter(
      (item) => item.scope === "domain" && memoryCandidateRecipe(item) !== undefined,
    ).length,
    metricEvidenceCount: historyContext.runs.filter((run) => rankRunMetric(run) !== undefined).length,
    acceptedMemoryEvidenceCount: historyContext.memory.filter((item) => item.outcome === "accepted").length,
    failedMemoryEvidenceCount: historyContext.memory.filter((item) => item.outcome === "failed").length,
  } as unknown as JsonRecord
}

function rankFeatureVector(taskFingerprint: JsonRecord, historyContext?: RankHistoryContext): JsonRecord {
  const profile = datasetProfileFromFingerprint(taskFingerprint)
  const fingerprint = taskFingerprint as Record<string, unknown>
  const learned = learnedRankTrainingStats(taskFingerprint, historyContext)
  return {
    contextLength: numberFromRecord(fingerprint, "contextLength"),
    maxPredictionLength: numberFromRecord(fingerprint, "maxPredictionLength"),
    targetCount: profile?.targetCount ?? numberFromRecord(fingerprint, "targetCount"),
    bridgeOnly: fingerprint.bridgeOnly === true,
    searchBiases: searchBiasList(taskFingerprint),
    missingRate: profile?.missingRate ?? 0,
    trendStrength: profile?.trendStrength ?? 0,
    seasonalityStrength: profile?.seasonalityStrength ?? 0,
    crossVarCorrelation: profile?.crossVarCorrelation ?? 0,
    distributionShift: profile?.distributionShift ?? 0,
    datasetProfileSignals: datasetProfileSignals(taskFingerprint),
    ...rankHistoryFeatureVector(historyContext),
    ...rankEvidenceSummary(historyContext),
    ...learned,
  } as unknown as JsonRecord
}

function candidateActionLabels(candidate: TSFCandidateRecipe) {
  return [
    ...candidate.preprocessing.actions.map((action) => `preprocessing=${action.type}`),
    `embedding=${candidate.embedding.type}`,
    `backbone=${candidate.backbone.type}`,
    `fusion=${candidate.fusion.type}`,
    `predictionHead=${candidate.predictionHead.type}`,
    `outputDistribution=${candidate.predictionHead.outputDistribution}`,
    `loss=${candidate.trainingStrategy.loss.base}`,
    `optimizer=${candidate.trainingStrategy.optimizer.type}`,
    `scheduler=${candidate.trainingStrategy.scheduler.type}`,
  ]
}

function historicalActionLabels(historyContext?: RankHistoryContext) {
  const labels = new Set<string>()
  if (!historyContext) return labels
  for (const item of historyContext.candidates) {
    const parsed = TSFCandidateRecipe.safeParse(item.candidateSpec)
    if (parsed.success) {
      for (const label of candidateActionLabels(parsed.data)) labels.add(label)
    }
  }
  for (const item of historyContext.memory) {
    const recipe = memoryCandidateRecipe(item)
    if (recipe) {
      for (const label of candidateActionLabels(recipe)) labels.add(label)
    }
  }
  return labels
}

function candidateNoveltySummary(candidate: TSFCandidateRecipe, historyContext?: RankHistoryContext): JsonRecord {
  const labels = candidateActionLabels(candidate)
  const historical = historicalActionLabels(historyContext)
  const novelActions = labels.filter((label) => !historical.has(label))
  return {
    comparedActionCount: labels.length,
    novelActionCount: novelActions.length,
    repeatedActionCount: labels.length - novelActions.length,
    novelActions,
  } as unknown as JsonRecord
}

function candidateActionVector(candidate: TSFCandidateRecipe, historyContext?: RankHistoryContext): JsonRecord {
  return {
    preprocessing: candidate.preprocessing.actions.map((action) => action.type),
    embedding: candidate.embedding.type,
    backbone: candidate.backbone.type,
    fusion: candidate.fusion.type,
    predictionHead: candidate.predictionHead.type,
    outputDistribution: candidate.predictionHead.outputDistribution,
    loss: candidate.trainingStrategy.loss.base,
    optimizer: candidate.trainingStrategy.optimizer.type,
    scheduler: candidate.trainingStrategy.scheduler.type,
    noveltySummary: candidateNoveltySummary(candidate, historyContext),
  } as unknown as JsonRecord
}

function rankedPreprocessingActions(profile: DatasetProfile | undefined, biases: Set<string>): TSFPreprocessingAction[] {
  const actions: TSFPreprocessingAction[] = []
  if ((profile?.missingRate ?? 0) > 0 || biases.has("missing_values")) {
    actions.push({ type: "missing_mask", maskChannel: true })
  }
  if ((profile?.distributionShift ?? 0) >= 0.5 || biases.has("distribution_shift")) {
    actions.push({ type: "sample_reweighting", scheme: "outlier_robust" })
  }
  return actions.length > 0 ? actions : [{ type: "none" }]
}

function profiledStrategy(
  task: TSFTaskSpec,
  profile: DatasetProfile | undefined,
  biases: Set<string>,
  overrides: Partial<TSFCandidateRecipe["trainingStrategy"]> = {},
): TSFCandidateRecipe["trainingStrategy"] {
  const base = baseStrategy(task)
  const shifted = (profile?.distributionShift ?? 0) >= 0.5 || biases.has("distribution_shift")
  return {
    ...base,
    loss: {
      ...base.loss,
      base: shifted ? "huber" : base.loss.base,
      horizonWeighting: shifted ? "tail_heavy" : base.loss.horizonWeighting,
      ...(shifted ? { delta: 1 } : {}),
      ...overrides.loss,
    },
    optimizer: {
      ...base.optimizer,
      type: "adamw",
      lr: 0.0005,
      weightDecay: 0.01,
      ...overrides.optimizer,
    },
    scheduler: {
      ...base.scheduler,
      type: "one_cycle",
      warmupSteps: 10,
      ...overrides.scheduler,
    },
    regularization: {
      ...base.regularization,
      gradClip: 1,
      ...overrides.regularization,
    },
    budget: {
      ...base.budget,
      ...overrides.budget,
    },
  }
}

function nativeFrontierRecipes(task: TSFTaskSpec, taskFingerprint: JsonRecord): TSFCandidateRecipe[] {
  const profile = datasetProfileFromFingerprint(taskFingerprint)
  const biases = searchBiasSet(taskFingerprint)
  const frequencyCount = Math.max(1, Math.min(8, Math.floor(task.contextLength / 2)))
  const probabilistic = task.forecastMode === "probabilistic"
  const predictionHead: TSFPredictionHead = probabilistic
    ? { type: "quantile", outputDistribution: "quantile", quantiles: [0.1, 0.5, 0.9] }
    : { type: "direct_multi_horizon", outputDistribution: "point" }
  const trainingStrategy = profiledStrategy(task, profile, biases, {
    ...(probabilistic
      ? {
          loss: {
            base: "quantile",
            horizonWeighting: "tail_heavy",
            quantiles: [0.1, 0.5, 0.9],
          },
        }
      : {}),
  })

  return [
    {
      recipeVersion: "recipe_schema_v2",
      recipeID: "tsf_ranked_frequency_mixer_profiled",
      hypothesis:
        "Profile-ranked frequency embedding plus a mixer backbone targets seasonal structure, missing values, and distribution shift.",
      preprocessing: { actions: rankedPreprocessingActions(profile, biases) },
      embedding: { type: "frequency", nFreq: frequencyCount, complexMode: "magnitude", dModel: 32 },
      backbone: {
        type: "mixer",
        hiddenDim: 64,
        depth: 2,
        temporalMixing: "mlp",
        channelMixing: "mlp",
        dropout: 0.1,
      },
      fusion: { type: "gated_hybrid", gateType: "channel" },
      predictionHead,
      trainingStrategy,
      notes: "Ranked native TimeRecipe candidate: seasonal/frequency-first exploration.",
    },
    {
      recipeVersion: "recipe_schema_v2",
      recipeID: "tsf_ranked_invert_rnn_feature_profiled",
      hypothesis:
        "Profile-ranked inverted embedding with feature fusion tests whether cross-variate dependence improves forecasts.",
      preprocessing: { actions: rankedPreprocessingActions(profile, biases) },
      embedding: { type: "invert", dModel: 64 },
      backbone: { type: "rnn", cell: "gru", hiddenDim: 96, numLayers: 2, dropout: 0.1 },
      fusion: { type: "variate_attention" },
      predictionHead,
      trainingStrategy: profiledStrategy(task, profile, biases),
      notes: "Ranked native TimeRecipe candidate: cross-variate recurrent exploration.",
    },
    {
      recipeVersion: "recipe_schema_v2",
      recipeID: "tsf_ranked_gated_depthwise_conv_graph_profiled",
      hypothesis:
        "Profile-ranked gated depthwise convolution with train-only correlation graph tests local temporal and multivariate structure.",
      preprocessing: { actions: rankedPreprocessingActions(profile, biases) },
      embedding: { type: "none" },
      backbone: { type: "gated_depthwise_conv", hiddenDim: 64, depth: 2, dropout: 0.1 },
      fusion: { type: "graph", adjacencySource: "correlation", sparsity: 0.2 },
      predictionHead,
      trainingStrategy: profiledStrategy(task, profile, biases),
      notes: "Native gated convolution and correlation graph exploration; not a state-space model.",
    },
  ]
}

type RankHistoryContext = Pick<DomainProposalContext, "candidates" | "runs" | "memory" | "champion">

const RANK_METRIC_PRIORITY = [
  "cv_avg_mse",
  "cv_avg_mae",
  "val_avg_mse",
  "val_avg_mae",
  "ref_test_avg_mse",
  "ref_test_avg_mae",
  "mse",
  "mae",
]

function rankRunMetric(run: RankHistoryContext["runs"][number]) {
  const metrics = run.metrics as Record<string, unknown>
  for (const metricName of RANK_METRIC_PRIORITY) {
    const value = metrics[metricName]
    if (typeof value === "number" && Number.isFinite(value)) {
      return { name: metricName, value }
    }
  }
  return undefined
}

function rankHistoryFeatureVector(context: RankHistoryContext | undefined) {
  if (!context) {
    return {
      historyRunCount: 0,
      historySucceededRunCount: 0,
      historyFailedRunCount: 0,
      historyMetricRunCount: 0,
      historyMemoryCount: 0,
      historyTaskMemoryCount: 0,
      historyDomainMemoryCount: 0,
      hasChampion: false,
    }
  }
  const domainMemoryCount = context.memory.filter((item) => item.scope === "domain").length
  return {
    historyRunCount: context.runs.length,
    historySucceededRunCount: context.runs.filter((run) => run.status === "succeeded").length,
    historyFailedRunCount: context.runs.filter((run) => run.status === "failed" || run.status === "rejected").length,
    historyMetricRunCount: context.runs.filter((run) => rankRunMetric(run) !== undefined).length,
    historyMemoryCount: context.memory.length,
    historyTaskMemoryCount: context.memory.length - domainMemoryCount,
    historyDomainMemoryCount: domainMemoryCount,
    hasChampion: context.champion !== undefined,
  }
}

function memoryCandidateRecipe(item: RankHistoryContext["memory"][number]) {
  const parsed = TSFCandidateRecipe.safeParse(asRecord(item.candidateSummary).candidateSpec)
  return parsed.success ? parsed.data : undefined
}

function hasBenchmarkMemory(context: RankHistoryContext) {
  return context.memory.some((item) => item.scope === "domain" && memoryCandidateRecipe(item) !== undefined)
}

function rankPredictorVersion(context: RankHistoryContext | undefined, task: TSFTaskSpec) {
  if (!context) return TSF_PROFILE_HEURISTIC_RANKER_VERSION
  if (!task.runtime.bridgeOnly && learnedRankExampleCount({}, context) >= LEARNED_RANK_MIN_EXAMPLES) {
    return TSF_PROFILE_LEARNED_MEMORY_RANKER_VERSION
  }
  if (hasBenchmarkMemory(context)) return TSF_PROFILE_BENCHMARK_MEMORY_RANKER_VERSION
  if (context.runs.some((run) => rankRunMetric(run) !== undefined)) return TSF_PROFILE_METRIC_MEMORY_RANKER_VERSION
  if (context.runs.length > 0 || context.memory.length > 0 || context.champion !== undefined) {
    return TSF_PROFILE_MEMORY_RANKER_VERSION
  }
  return TSF_PROFILE_HEURISTIC_RANKER_VERSION
}

function recipeSimilarity(left: TSFCandidateRecipe, right: TSFCandidateRecipe) {
  let similarity = 0
  if (left.embedding.type === right.embedding.type) similarity += 1
  if (left.backbone.type === right.backbone.type) similarity += 2
  if (left.fusion.type === right.fusion.type) similarity += 1
  if (left.predictionHead.type === right.predictionHead.type) similarity += 0.5
  if (left.trainingStrategy.loss.base === right.trainingStrategy.loss.base) similarity += 0.5
  return similarity
}

function candidateIDFromMemory(item: RankHistoryContext["memory"][number]) {
  const summary = asRecord(item.candidateSummary)
  const candidateID = summary.candidateID
  return typeof candidateID === "string" && candidateID.length > 0 ? candidateID : undefined
}

function historicalRecipeByCandidateID(context: RankHistoryContext) {
  const recipes = new Map<string, TSFCandidateRecipe>()
  for (const item of context.candidates) {
    const parsed = TSFCandidateRecipe.safeParse(item.candidateSpec)
    if (parsed.success) recipes.set(item.id, parsed.data)
  }
  return recipes
}

type LearnedRankExample = {
  readonly recipe: TSFCandidateRecipe
  readonly label: number
  readonly weight: number
  readonly source: "memory" | "metric" | "champion"
}

function profileSimilarity(taskFingerprint: JsonRecord, memoryFingerprint: unknown) {
  const current = datasetProfileFromFingerprint(taskFingerprint)
  const previous = datasetProfileFromFingerprint(asRecord(memoryFingerprint))
  if (!current || !previous) return 0.75

  // Different source CSV → cross-dataset memory, cap similarity so it doesn't dominate ranking.
  const currentCsv = typeof taskFingerprint.sourceCsv === "string" ? taskFingerprint.sourceCsv : undefined
  const previousCsv = typeof (memoryFingerprint as Record<string, unknown>).sourceCsv === "string"
    ? (memoryFingerprint as Record<string, unknown>).sourceCsv
    : undefined
  if (currentCsv && previousCsv && currentCsv !== previousCsv) return 0.1

  const diffs = [
    Math.abs(current.missingRate - previous.missingRate),
    Math.abs(current.trendStrength - previous.trendStrength),
    Math.abs(current.seasonalityStrength - previous.seasonalityStrength),
    Math.abs(current.crossVarCorrelation - previous.crossVarCorrelation),
    Math.abs(current.distributionShift - previous.distributionShift),
    Math.abs(current.targetCount - previous.targetCount) / Math.max(current.targetCount, previous.targetCount, 1),
  ]
  const distance = diffs.reduce((sum, value) => sum + value, 0) / diffs.length
  return Math.max(0.25, Math.min(1.25, 1.25 - distance))
}

function outcomeLabel(outcome: string) {
  if (outcome === "accepted") return 1
  if (outcome === "failed") return -1
  if (outcome === "rejected") return -0.5
  return 0
}

function learnedRankFeatureKeys(candidate: TSFCandidateRecipe, taskFingerprint: JsonRecord) {
  const profile = datasetProfileFromFingerprint(taskFingerprint)
  const biases = searchBiasSet(taskFingerprint)
  const features = new Set<string>()
  for (const action of candidate.preprocessing.actions) features.add(`preprocessing=${action.type}`)
  features.add(`embedding=${candidate.embedding.type}`)
  features.add(`backbone=${candidate.backbone.type}`)
  features.add(`fusion=${candidate.fusion.type}`)
  features.add(`head=${candidate.predictionHead.type}`)
  features.add(`distribution=${candidate.predictionHead.outputDistribution}`)
  features.add(`loss=${candidate.trainingStrategy.loss.base}`)
  features.add(`optimizer=${candidate.trainingStrategy.optimizer.type}`)
  features.add(`scheduler=${candidate.trainingStrategy.scheduler.type}`)
  features.add(`pair.embedding_backbone=${candidate.embedding.type}+${candidate.backbone.type}`)
  features.add(`pair.backbone_fusion=${candidate.backbone.type}+${candidate.fusion.type}`)
  features.add(`pair.head_loss=${candidate.predictionHead.type}+${candidate.trainingStrategy.loss.base}`)

  if ((profile?.seasonalityStrength ?? 0) >= 0.4 || biases.has("seasonal")) {
    features.add(`profile.seasonal.embedding=${candidate.embedding.type}`)
    features.add(`profile.seasonal.backbone=${candidate.backbone.type}`)
  }
  if ((profile?.crossVarCorrelation ?? 0) >= 0.5 || biases.has("cross_var_correlated")) {
    features.add(`profile.cross_var.embedding=${candidate.embedding.type}`)
    features.add(`profile.cross_var.fusion=${candidate.fusion.type}`)
  }
  if ((profile?.missingRate ?? 0) > 0 || biases.has("missing_values")) {
    for (const action of candidate.preprocessing.actions) features.add(`profile.missing.preprocessing=${action.type}`)
  }
  if ((profile?.distributionShift ?? 0) >= 0.5 || biases.has("distribution_shift")) {
    features.add(`profile.shift.loss=${candidate.trainingStrategy.loss.base}`)
    features.add(`profile.shift.scheduler=${candidate.trainingStrategy.scheduler.type}`)
  }
  if (biases.has("probabilistic")) {
    features.add(`profile.probabilistic.head=${candidate.predictionHead.type}`)
  }

  return [...features]
}

function learnedRankExamples(
  taskFingerprint: JsonRecord,
  context: RankHistoryContext | undefined,
  previousRecipes = context ? historicalRecipeByCandidateID(context) : new Map<string, TSFCandidateRecipe>(),
): LearnedRankExample[] {
  if (!context) return []
  const examples: LearnedRankExample[] = []

  for (const item of context.memory) {
    const candidateID = candidateIDFromMemory(item)
    const recipe = (candidateID ? previousRecipes.get(candidateID) : undefined) ?? memoryCandidateRecipe(item)
    if (!recipe) continue
    const label = outcomeLabel(item.outcome)
    if (Math.abs(label) < 0.01) continue
    examples.push({
      recipe,
      label,
      weight: item.scope === "domain" ? profileSimilarity(taskFingerprint, item.fingerprintSummary) : 1,
      source: "memory",
    })
  }

  const metricRuns = context.runs
    .map((run) => {
      const metric = rankRunMetric(run)
      const recipe = previousRecipes.get(run.candidateID)
      return metric && recipe && run.status === "succeeded" ? { metric, recipe } : undefined
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
  const metricValues = metricRuns.map((item) => item.metric.value)
  const meanMetric = meanFinite(metricValues)
  const scale = stdFinite(metricValues) || Math.abs(meanMetric) || 1
  for (const item of metricRuns) {
    const label =
      metricRuns.length > 1 ? (meanMetric - item.metric.value) / scale : 1 / (1 + Math.max(0, item.metric.value))
    if (Math.abs(label) < 0.01) continue
    examples.push({
      recipe: item.recipe,
      label,
      weight: 0.75,
      source: "metric",
    })
  }

  if (context.champion) {
    const recipe = previousRecipes.get(context.champion.candidateID)
    if (recipe) {
      examples.push({
        recipe,
        label: Math.max(0.5, Math.min(1.5, Math.abs(context.champion.utility) || 1)),
        weight: 0.5,
        source: "champion",
      })
    }
  }

  return examples
}

function learnedRankExampleCount(taskFingerprint: JsonRecord, context: RankHistoryContext | undefined) {
  return learnedRankExamples(taskFingerprint, context).length
}

function learnedRankTrainingStats(taskFingerprint: JsonRecord, context: RankHistoryContext | undefined) {
  const examples = learnedRankExamples(taskFingerprint, context)
  return {
    learnedRankerTrainingExamples: examples.length,
    learnedRankerPositiveExamples: examples.filter((item) => item.label > 0).length,
    learnedRankerNegativeExamples: examples.filter((item) => item.label < 0).length,
  }
}

function learnedRankerModel(taskFingerprint: JsonRecord, context: RankHistoryContext | undefined) {
  if (!context) return undefined
  const previousRecipes = historicalRecipeByCandidateID(context)
  const examples = learnedRankExamples(taskFingerprint, context, previousRecipes)
  if (examples.length < LEARNED_RANK_MIN_EXAMPLES) return undefined

  const weights = new Map<string, number>()
  for (const example of examples) {
    const keys = learnedRankFeatureKeys(example.recipe, taskFingerprint)
    const norm = Math.sqrt(Math.max(1, keys.length))
    for (const key of keys) {
      weights.set(key, (weights.get(key) ?? 0) + (example.label * example.weight) / norm)
    }
  }

  return { examples, weights }
}

function learnedReasonLabel(key: string) {
  return key.replace(/^profile\./, "").replace(/^pair\./, "").replace(/[._]/g, " ")
}

function scoreLearnedNativeRecipe(
  candidate: TSFCandidateRecipe,
  taskFingerprint: JsonRecord,
  context: RankHistoryContext | undefined,
) {
  const model = learnedRankerModel(taskFingerprint, context)
  if (!model) return { score: 0, reasons: [] as string[] }
  const keys = learnedRankFeatureKeys(candidate, taskFingerprint)
  const norm = Math.sqrt(Math.max(1, keys.length))
  const contributions = keys
    .map((key) => ({
      key,
      value: (model.weights.get(key) ?? 0) / norm,
    }))
    .filter((item) => Math.abs(item.value) >= 0.02)
    .sort((left, right) => Math.abs(right.value) - Math.abs(left.value))
  const score = contributions.reduce((sum, item) => sum + item.value, 0)
  const reasons = contributions.slice(0, 4).map((item) => {
    const direction = item.value >= 0 ? "boosted" : "penalized"
    return `learned memory ranker ${direction} ${learnedReasonLabel(item.key)} (${Number(item.value.toPrecision(3))})`
  })
  return { score, reasons }
}

function scoreNativeRecipeMetricHistory(
  candidate: TSFCandidateRecipe,
  context: RankHistoryContext,
  previousRecipes: Map<string, TSFCandidateRecipe>,
) {
  const metricRuns = context.runs
    .map((run) => {
      const metric = rankRunMetric(run)
      const previous = previousRecipes.get(run.candidateID)
      return metric && previous && run.status === "succeeded" ? { run, metric, previous } : undefined
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
  if (metricRuns.length === 0) return { score: 0, reasons: [] as string[] }

  const metricValues = metricRuns.map((item) => item.metric.value)
  const meanMetric = meanFinite(metricValues)
  const scale = stdFinite(metricValues) || Math.abs(meanMetric) || 1
  const reasons: string[] = []
  let score = 0

  for (const item of metricRuns) {
    const similarity = recipeSimilarity(candidate, item.previous)
    if (similarity <= 0) continue
    const relativeUtility =
      metricRuns.length > 1 ? (meanMetric - item.metric.value) / scale : 1 / (1 + Math.max(0, item.metric.value))
    const contribution = similarity * relativeUtility * 0.75
    score += contribution
    if (contribution > 0.05) {
      reasons.push(
        `metric history boosted similar ${item.previous.recipeID ?? item.previous.backbone.type} (${item.metric.name}=${Number(item.metric.value.toPrecision(6))})`,
      )
    } else if (contribution < -0.05) {
      reasons.push(
        `metric history penalized similar ${item.previous.recipeID ?? item.previous.backbone.type} (${item.metric.name}=${Number(item.metric.value.toPrecision(6))})`,
      )
    }
  }

  return { score, reasons }
}

function scoreNativeRecipeHistory(
  candidate: TSFCandidateRecipe,
  taskFingerprint: JsonRecord,
  context: RankHistoryContext | undefined,
) {
  if (!context) return { score: 0, reasons: [] as string[] }

  const previousRecipes = historicalRecipeByCandidateID(context)
  const reasons: string[] = []
  let score = 0

  for (const item of context.memory) {
    const candidateID = candidateIDFromMemory(item)
    const previous = (candidateID ? previousRecipes.get(candidateID) : undefined) ?? memoryCandidateRecipe(item)
    if (!previous) continue
    const similarity = recipeSimilarity(candidate, previous)
    if (similarity <= 0) continue
    const benchmarkWeight =
      item.scope === "domain" ? profileSimilarity(taskFingerprint, item.fingerprintSummary) : 1
    const reasonPrefix = item.scope === "domain" ? "benchmark memory" : "history"

    if (item.outcome === "accepted") {
      score += similarity * 1.5 * benchmarkWeight
      reasons.push(`${reasonPrefix} accepted similar ${previous.recipeID ?? previous.backbone.type}`)
    } else if (item.outcome === "failed") {
      score -= similarity * 1.25 * benchmarkWeight
      reasons.push(`${reasonPrefix} penalized failed similar ${previous.recipeID ?? previous.backbone.type}`)
    } else {
      score -= similarity * 0.5 * benchmarkWeight
      reasons.push(`${reasonPrefix} downranked non-improving similar ${previous.recipeID ?? previous.backbone.type}`)
    }
  }

  for (const run of context.runs) {
    const previous = previousRecipes.get(run.candidateID)
    if (!previous) continue
    const similarity = recipeSimilarity(candidate, previous)
    if (similarity <= 0) continue

    if (run.status === "succeeded" && context.champion?.candidateID === run.candidateID) {
      score += similarity
      reasons.push(`history boosted champion-similar ${previous.recipeID ?? previous.backbone.type}`)
    } else if (run.status === "failed" || run.status === "rejected") {
      score -= similarity * 0.75
      reasons.push(`history penalized failed run similar ${previous.recipeID ?? previous.backbone.type}`)
    }
  }

  const metricHistory = scoreNativeRecipeMetricHistory(candidate, context, previousRecipes)
  score += metricHistory.score
  reasons.push(...metricHistory.reasons)

  return { score, reasons }
}

function scoreNativeRecipe(
  candidate: TSFCandidateRecipe,
  taskFingerprint: JsonRecord,
  historyContext?: RankHistoryContext,
) {
  const profile = datasetProfileFromFingerprint(taskFingerprint)
  const biases = searchBiasSet(taskFingerprint)
  const reasons: string[] = []
  let score = 0

  if (candidate.embedding.type === "frequency" && ((profile?.seasonalityStrength ?? 0) >= 0.4 || biases.has("seasonal"))) {
    score += 4
    reasons.push("seasonality favors frequency embedding")
  }
  if (candidate.backbone.type === "mixer" && (profile?.targetCount ?? 0) > 1) {
    score += 2
    reasons.push("multivariate target favors channel mixer")
  }
  if (candidate.embedding.type === "invert" && ((profile?.crossVarCorrelation ?? 0) >= 0.5 || biases.has("cross_var_correlated"))) {
    score += 3
    reasons.push("cross-var correlation favors inverted feature modeling")
  }
  if (candidate.fusion.type === "graph" && (profile?.crossVarCorrelation ?? 0) >= 0.7) {
    score += 2
    reasons.push("strong cross-var correlation favors graph fusion")
  }
  if (
    ((profile?.missingRate ?? 0) > 0 || biases.has("missing_values")) &&
    candidate.preprocessing.actions.some((action) => action.type === "missing_mask")
  ) {
    score += 1
    reasons.push("missing values require mask-aware preprocessing")
  }
  if (
    ((profile?.distributionShift ?? 0) >= 0.5 || biases.has("distribution_shift")) &&
    candidate.trainingStrategy.loss.base === "huber"
  ) {
    score += 1
    reasons.push("distribution shift favors robust loss")
  }
  if (biases.has("probabilistic") && candidate.predictionHead.type === "quantile") {
    score += 2
    reasons.push("probabilistic mode favors quantile head")
  }

  const history = scoreNativeRecipeHistory(candidate, taskFingerprint, historyContext)
  score += history.score
  reasons.push(...history.reasons)

  const learned = scoreLearnedNativeRecipe(candidate, taskFingerprint, historyContext)
  score += learned.score
  reasons.push(...learned.reasons)

  return { score, reasons }
}

function rankedNativeFrontierRecipes(task: TSFTaskSpec, taskFingerprint: JsonRecord, historyContext?: RankHistoryContext) {
  return nativeFrontierRecipes(task, taskFingerprint)
    .map((candidate) => ({ candidate, ranking: scoreNativeRecipe(candidate, taskFingerprint, historyContext) }))
    .sort((left, right) => {
      if (right.ranking.score !== left.ranking.score) return right.ranking.score - left.ranking.score
      return (left.candidate.recipeID ?? "").localeCompare(right.candidate.recipeID ?? "")
    })
}

function mutationRecipeID(baseID: string | undefined, ordinal: number) {
  const safeBase = (baseID ?? "candidate")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .slice(0, 36)
  return `tsf_mutation_${ordinal}_${safeBase || "candidate"}`
}

function patchEmbedding(task: TSFTaskSpec, base?: TSFEmbedding): Extract<TSFEmbedding, { type: "patch" }> {
  if (base?.type === "patch") return base
  const patchLen = Math.min(16, task.contextLength)
  return {
    type: "patch",
    patchLen,
    stride: Math.max(1, Math.floor(patchLen / 2)),
    dModel: 64,
  }
}

type ProfileMutationFactory = (base: TSFCandidateRecipe, recipeID: string) => TSFCandidateRecipe | undefined

function profileMutationSequence(task: TSFTaskSpec, taskFingerprint: JsonRecord): ProfileMutationFactory[] {
  const profile = datasetProfileFromFingerprint(taskFingerprint)
  const biases = searchBiasSet(taskFingerprint)
  const factories: ProfileMutationFactory[] = []

  // 1. Seasonal signal: switch patch embedding to frequency
  if (biases.has("seasonal") || (profile && profile.seasonalityStrength >= 0.4)) {
    const seasonality = profile ? Number(profile.seasonalityStrength.toFixed(3)) : "unknown"
    factories.push((base, recipeID) => {
      if (base.embedding.type !== "patch") return undefined
      const nFreq = Math.min(base.embedding.dModel, 256)
      const dModel = base.embedding.dModel
      return recipe(task, {
        recipeID,
        hypothesis: `Profile-guided mutation: seasonal signal (strength=${seasonality}), switching to frequency embedding to capture periodic structure.`,
        preprocessing: base.preprocessing,
        embedding: { type: "frequency", nFreq, complexMode: "real_imag", dModel },
        backbone: base.backbone,
        fusion: base.fusion,
        predictionHead: base.predictionHead,
        notes: `Profile-directed seasonal mutation from ${base.recipeID ?? "candidate"}.`,
      })
    })
  }

  // 2. Cross-var correlated: switch temporal fusion to gated_hybrid
  if (biases.has("cross_var_correlated") || (profile && profile.crossVarCorrelation >= 0.5)) {
    const crossVarCorrelation = profile ? Number(profile.crossVarCorrelation.toFixed(3)) : "unknown"
    factories.push((base, recipeID) => {
      if (base.fusion.type !== "temporal") return undefined
      return recipe(task, {
        recipeID,
        hypothesis: `Profile-guided mutation: correlated targets (corr=${crossVarCorrelation}), testing gated cross-variate fusion.`,
        preprocessing: base.preprocessing,
        embedding: base.embedding,
        backbone: base.backbone,
        fusion: { type: "gated_hybrid", gateType: "channel" },
        predictionHead: base.predictionHead,
        notes: `Profile-directed cross-var mutation from ${base.recipeID ?? "candidate"}.`,
      })
    })
  }

  // 3. Distribution shift: add instance_norm + huber loss
  if (biases.has("distribution_shift") || (profile && profile.distributionShift >= 0.5)) {
    const distributionShift = profile ? Number(profile.distributionShift.toFixed(3)) : "unknown"
    factories.push((base, recipeID) => {
      const alreadyHasInstanceNorm = base.preprocessing.actions.some((a) => a.type === "instance_norm")
      const alreadyHuber = base.trainingStrategy.loss.base === "huber"
      if (alreadyHasInstanceNorm && alreadyHuber) return undefined
      const newActions = alreadyHasInstanceNorm
        ? base.preprocessing.actions
        : [...base.preprocessing.actions.filter((a) => a.type !== "none"), { type: "instance_norm" as const, affine: false, eps: 1e-5 }]
      return {
        ...recipe(task, {
          recipeID,
          hypothesis: `Profile-guided mutation: distribution shift (strength=${distributionShift}), adding instance norm and robust huber loss.`,
          preprocessing: { actions: newActions.length > 0 ? newActions : [{ type: "none" }] },
          embedding: base.embedding,
          backbone: base.backbone,
          fusion: base.fusion,
          predictionHead: base.predictionHead,
          notes: `Profile-directed distribution shift mutation from ${base.recipeID ?? "candidate"}.`,
        }),
        trainingStrategy: {
          ...base.trainingStrategy,
          loss: { ...base.trainingStrategy.loss, base: "huber" as const },
        },
      }
    })
  }

  // 4. Missing values: add missing_mask preprocessing
  if (biases.has("missing_values") || (profile && profile.missingRate > 0)) {
    const missingRate = profile ? Number(profile.missingRate.toFixed(4)) : "unknown"
    factories.push((base, recipeID) => {
      const alreadyHasMask = base.preprocessing.actions.some((a) => a.type === "missing_mask")
      if (alreadyHasMask) return undefined
      const newActions = [{ type: "missing_mask" as const, maskChannel: true as const }, ...base.preprocessing.actions.filter((a) => a.type !== "none")]
      return recipe(task, {
        recipeID,
        hypothesis: `Profile-guided mutation: missing values (rate=${missingRate}), adding missing mask preprocessing.`,
        preprocessing: { actions: newActions },
        embedding: base.embedding,
        backbone: base.backbone,
        fusion: base.fusion.type === "temporal" && base.fusion.channelMode === "independent" ? { type: "feature_mlp" } : base.fusion,
        predictionHead: base.predictionHead,
        notes: `Profile-directed missing values mutation from ${base.recipeID ?? "candidate"}.`,
      })
    })
  }

  return factories
}

function mutateTSFRecipeGeneric(task: TSFTaskSpec, base: TSFCandidateRecipe, recipeID: string): TSFCandidateRecipe {
  const hypothesis = `Mutation of ${base.recipeID ?? "champion"} tests a small bridge-safe capacity change.`

  if (base.backbone.type === "transformer") {
    const dModel = base.backbone.dModel
    const embedding =
      base.embedding.type === "patch" && base.embedding.dModel === dModel
        ? base.embedding
        : { ...patchEmbedding(task), dModel }
    return recipe(task, {
      recipeID,
      hypothesis,
      preprocessing: base.preprocessing,
      embedding,
      backbone: {
        ...base.backbone,
        nLayers: Math.min(base.backbone.nLayers + 1, 4),
        dropout: Math.max(0, Number((base.backbone.dropout * 0.8).toFixed(3))),
      },
      fusion: { type: "temporal", channelMode: "independent" },
      predictionHead: { type: "linear", outputDistribution: "point" },
      notes: `Autonomous mutation from ${base.recipeID ?? "candidate"} after seeded candidates were exhausted.`,
    })
  }

  const embedding = patchEmbedding(task, base.embedding)
  const hiddenDim = base.backbone.type === "mlp" ? Math.min(base.backbone.hiddenDim * 2, 512) : 256
  const depth = base.backbone.type === "mlp" ? Math.min(base.backbone.depth + 1, 4) : 3
  return recipe(task, {
    recipeID,
    hypothesis,
    preprocessing: base.preprocessing,
    embedding,
    backbone: {
      type: "mlp",
      depth,
      hiddenDim,
      activation: "gelu",
      dropout: 0.1,
    },
    fusion: { type: "temporal", channelMode: "independent" },
    predictionHead: { type: "linear", outputDistribution: "point" },
    notes: `Autonomous mutation from ${base.recipeID ?? "candidate"} after seeded candidates were exhausted.`,
  })
}

function mutateTSFRecipe(
  task: TSFTaskSpec,
  base: TSFCandidateRecipe,
  ordinal: number,
  taskFingerprint?: JsonRecord,
): TSFCandidateRecipe {
  const recipeID = mutationRecipeID(base.recipeID, ordinal)

  if (taskFingerprint) {
    const profileFactories = profileMutationSequence(task, taskFingerprint)
    // Try profile mutations in priority order using the ordinal to pick different ones
    const factoryIndex = (ordinal - 1) % Math.max(profileFactories.length, 1)
    if (profileFactories.length > 0) {
      // Try from the factoryIndex, wrapping around, to find one that returns a result
      for (let i = 0; i < profileFactories.length; i++) {
        const idx = (factoryIndex + i) % profileFactories.length
        const result = profileFactories[idx]!(base, recipeID)
        if (result !== undefined) return result
      }
    }
  }

  return mutateTSFRecipeGeneric(task, base, recipeID)
}

function taskPriorText(taskFingerprint: JsonRecord) {
  const searchBiases = taskFingerprint.searchBiases
  if (!Array.isArray(searchBiases)) return undefined
  const labels = searchBiases.filter((item): item is string => typeof item === "string" && item.length > 0)
  if (labels.length === 0) return undefined
  return `Task prior: ${labels.join(", ")}.`
}

function proposalRationale(hypothesis: string, taskFingerprint: JsonRecord, latestLesson?: string) {
  return [hypothesis, taskPriorText(taskFingerprint), latestLesson ? `Latest memory: ${latestLesson}` : undefined]
    .filter((item): item is string => Boolean(item))
    .join(" ")
}

export function rankTSFCandidateProposals(input: DomainProposalContext): DomainCandidateRanking[] {
  const task = TSFTaskSpec.parse(input.taskSpec)
  const taskFingerprint = input.taskFingerprint ?? summarizeTSFTask(task)
  const features = rankFeatureVector(taskFingerprint, input)
  const predictorVersion = rankPredictorVersion(input, task)
  const latestLesson = input.memory[0]?.lesson
  const existingRecipeIDs = new Set(
    input.candidates
      .map((candidate) => candidate.candidateSpec.recipeID)
      .filter((value): value is string => typeof value === "string"),
  )

  if (!task.runtime.bridgeOnly) {
    return rankedNativeFrontierRecipes(task, taskFingerprint, input)
      .filter(({ candidate }) => candidate.recipeID && !existingRecipeIDs.has(candidate.recipeID))
      .map(({ candidate, ranking }, index) => {
        const reasons = ranking.reasons.length ? ranking.reasons : ["profile did not expose a strong prior"]
        return {
          rank: index + 1,
          score: ranking.score,
          reasons,
          predictorVersion,
          features,
          candidateActions: candidateActionVector(candidate, input),
          candidateSpec: candidate as unknown as JsonRecord,
          rationale: [
            proposalRationale(candidate.hypothesis, taskFingerprint, latestLesson),
            `Rank predictor: score=${ranking.score}; ${reasons.join("; ")}.`,
          ].join(" "),
          riskLevel: "medium",
          approvalStatus: "auto_approved",
          generatedBy: "mutation",
        }
      })
  }

  return bridgeFrontierRecipes(task)
    .filter((candidate) => candidate.recipeID && !existingRecipeIDs.has(candidate.recipeID))
    .map((candidate, index) => ({
      rank: index + 1,
      score: 0,
      reasons: ["bridge-safe frontier priority"],
      predictorVersion,
      features,
      candidateActions: candidateActionVector(candidate, input),
      candidateSpec: candidate as unknown as JsonRecord,
      rationale: proposalRationale(candidate.hypothesis, taskFingerprint, latestLesson),
      riskLevel: "low",
      approvalStatus: "auto_approved",
      generatedBy: "mutation",
    }))
}

export function proposeTSFCandidate(input: DomainProposalContext): DomainCandidateProposal | undefined {
  const task = TSFTaskSpec.parse(input.taskSpec)
  const taskFingerprint = input.taskFingerprint ?? summarizeTSFTask(task)
  const existingRecipeIDs = new Set(
    input.candidates
      .map((candidate) => candidate.candidateSpec.recipeID)
      .filter((value): value is string => typeof value === "string"),
  )
  const championCandidate =
    input.champion === undefined
      ? undefined
      : input.candidates.find((candidate) => candidate.id === input.champion?.candidateID)
  const parsedChampion = TSFCandidateRecipe.safeParse(championCandidate?.candidateSpec)
  const fallback = buildTSFBaselines(task)[0]?.candidateSpec
  const parsedFallback = TSFCandidateRecipe.safeParse(fallback)
  const base = parsedChampion.success ? parsedChampion.data : parsedFallback.success ? parsedFallback.data : undefined
  if (!base) return undefined

  const ranked = rankTSFCandidateProposals(input)[0]
  if (ranked) {
    return {
      candidateSpec: ranked.candidateSpec,
      rationale: ranked.rationale,
      riskLevel: ranked.riskLevel,
      approvalStatus: ranked.approvalStatus,
      generatedBy: ranked.generatedBy,
    }
  }

  for (let offset = 0; offset < 10; offset++) {
    const candidate = mutateTSFRecipe(task, base, input.candidates.length + offset + 1, taskFingerprint)
    if (candidate.recipeID && existingRecipeIDs.has(candidate.recipeID)) continue
    const latestLesson = input.memory[0]?.lesson
    return {
      candidateSpec: candidate as unknown as DomainCandidateProposal["candidateSpec"],
      rationale: proposalRationale(candidate.hypothesis, taskFingerprint, latestLesson),
      riskLevel: "low",
      approvalStatus: "auto_approved",
      generatedBy: "mutation",
    }
  }

  return undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function jsonBlock(value: unknown) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
}

function metricText(metrics: JsonRecord) {
  const entries = Object.entries(metrics)
  if (entries.length === 0) return "-"
  return entries
    .map(([key, value]) => `${key}=${typeof value === "number" ? Number(value.toPrecision(6)) : JSON.stringify(value)}`)
    .join(", ")
}

function probabilisticMetricName(candidateSpec: JsonRecord, fallbackMetric: string) {
  const parsed = TSFCandidateRecipe.safeParse(candidateSpec)
  if (!parsed.success) return fallbackMetric
  const distribution = parsed.data.predictionHead.outputDistribution
  const prefix = fallbackMetric.startsWith("cv_") ? "cv" : "val"
  if (distribution === "quantile") return `${prefix}_avg_pinball`
  if (distribution === "gaussian") return `${prefix}_avg_crps_approx`
  return fallbackMetric
}

function evaluateTSFRun(input: DomainRunEvaluationContext): DomainRunEvaluation | undefined {
  const task = TSFTaskSpec.safeParse(input.task.taskSpec)
  const objective = asRecord(input.task.objective)
  const fallbackMetricName =
    typeof objective.primaryMetric === "string"
      ? objective.primaryMetric
      : typeof objective.metric === "string"
        ? objective.metric
        : ((task.success ? task.data.evaluation.metricPrimary : undefined) ?? "cv_avg_mse")
  const primaryMetricName = probabilisticMetricName(input.candidate.candidateSpec, fallbackMetricName)
  const direction = objective.direction === "maximize" ? "maximize" : "minimize"
  const value = input.run.metrics[primaryMetricName]
  const primaryMetric = typeof value === "number" ? value : undefined

  return {
    primaryMetricName,
    primaryMetric,
    direction,
    utility: primaryMetric === undefined ? undefined : direction === "minimize" ? -primaryMetric : primaryMetric,
  }
}

function candidateRecipeID(candidateSpec: JsonRecord) {
  const recipeID = candidateSpec.recipeID
  return typeof recipeID === "string" && recipeID.length > 0 ? recipeID : undefined
}

function candidatePipeline(candidateSpec: JsonRecord) {
  const preprocessing = asRecord(candidateSpec.preprocessing).actions
  const preprocessingText = Array.isArray(preprocessing)
    ? preprocessing
        .map((action) => asRecord(action).type)
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .join("+")
    : undefined
  const embedding = asRecord(candidateSpec.embedding).type
  const backbone = asRecord(candidateSpec.backbone).type
  const fusion = asRecord(candidateSpec.fusion).type
  const head = asRecord(candidateSpec.predictionHead).type
  const optimizer = asRecord(asRecord(candidateSpec.trainingStrategy).optimizer).type
  return [preprocessingText, embedding, backbone, fusion, head, optimizer]
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .join(" / ")
}

function isDataAnalysisArtifact(kind: string) {
  return (
    kind === "dataset_analysis_report" ||
    kind === "dataset_quantitative_analysis_markdown" ||
    kind === "dataset_quantitative_analysis_json" ||
    kind === "dataset_qualitative_analysis_markdown" ||
    kind === "dataset_main_analysis_markdown" ||
    kind === "dataset_analysis_plot_png"
  )
}

function readFileURI(uri: string) {
  if (!uri.startsWith("file://")) return undefined
  try {
    return readFileSync(uri.replace(/^file:\/\//, ""), "utf8")
  } catch {
    return undefined
  }
}

function renderTSFArtifact(input: DomainArtifactContext): DomainArtifactRender | undefined {
  if (input.kind !== "research_report_markdown") return undefined
  const recipeCount = input.candidates.filter((candidate) => candidateRecipeID(candidate.candidateSpec)).length
  const dataAnalysisArtifacts = input.artifacts.filter((artifact) => isDataAnalysisArtifact(artifact.kind))
  const datasetAnalysisReport = dataAnalysisArtifacts.find((artifact) => artifact.kind === "dataset_analysis_report")
  const datasetAnalysisContent =
    datasetAnalysisReport === undefined ? undefined : readFileURI(datasetAnalysisReport.uri)?.trim()
  const lines = [
    `# ${input.task.title}`,
    "",
    "## Task",
    "",
    `- Task ID: ${input.task.id}`,
    `- Domain: ${input.task.domainID}`,
    `- Mode: ${input.task.mode}`,
    `- Status: ${input.task.status}`,
    "",
    "### Objective",
    "",
    jsonBlock(input.task.objective),
    "",
    "### Budget",
    "",
    jsonBlock(input.task.budget),
    "",
    "### Task Spec",
    "",
    jsonBlock(input.task.taskSpec),
    "",
    "## Champion",
    "",
  ]

  if (input.champion) {
    lines.push(
      `- Candidate ID: ${input.champion.candidateID}`,
      `- Run ID: ${input.champion.runID}`,
      `- Primary metric: ${input.champion.primaryMetric}`,
      `- Utility: ${input.champion.utility}`,
    )
  } else {
    lines.push("- None")
  }

  lines.push("", "## TSF Recipe Summary", "")
  if (input.candidates.length === 0) {
    lines.push("- None")
  } else {
    for (const candidate of input.candidates) {
      lines.push(
        `- ${candidateRecipeID(candidate.candidateSpec) ?? candidate.id}: ${candidatePipeline(candidate.candidateSpec) || "-"}`,
      )
    }
  }

  lines.push("", "## Candidates", "")
  if (input.candidates.length === 0) {
    lines.push("- None")
  } else {
    for (const candidate of input.candidates) {
      lines.push(
        `### ${candidateRecipeID(candidate.candidateSpec) ?? candidate.id}`,
        "",
        `- Candidate ID: ${candidate.id}`,
        `- Approval status: ${candidate.approvalStatus}`,
        `- Risk level: ${candidate.riskLevel}`,
        `- Generated by: ${candidate.generatedBy}`,
        `- Pipeline: ${candidatePipeline(candidate.candidateSpec) || "-"}`,
        `- Rationale: ${candidate.rationale}`,
        "",
        jsonBlock(candidate.candidateSpec),
        "",
      )
    }
  }

  lines.push("", "## Data Analysis Agents", "")
  if (dataAnalysisArtifacts.length === 0) {
    lines.push("- None")
  } else {
    if (datasetAnalysisContent !== undefined && datasetAnalysisContent.length > 0) {
      lines.push(datasetAnalysisContent, "")
    }
    for (const artifact of dataAnalysisArtifacts) {
      const role = typeof artifact.metadata.role === "string" ? artifact.metadata.role : "data-analysis-agent"
      lines.push(`- ${artifact.kind}: ${role} (${artifact.uri})`)
    }
  }

  lines.push("", "## Runs", "")
  if (input.runs.length === 0) {
    lines.push("- None")
  } else {
    for (const run of input.runs) {
      lines.push(`- ${run.id}: ${run.stage} / ${run.status} / ${metricText(run.metrics)}`)
    }
  }

  lines.push("", "## Approvals", "")
  if (input.approvals.length === 0) {
    lines.push("- None")
  } else {
    for (const approval of input.approvals) {
      lines.push(
        `- ${approval.id}: ${approval.status} ${approval.kind}${approval.candidateID ? ` for ${approval.candidateID}` : ""} - ${approval.reason}`,
      )
    }
  }

  lines.push("", "## Memory", "")
  if (input.memory.length === 0) {
    lines.push("- None")
  } else {
    for (const item of input.memory) {
      lines.push(`- ${item.outcome}: ${item.lesson}`)
    }
  }

  return {
    filename: "research-report.md",
    content: `${lines.join("\n")}\n`,
    metadata: {
      format: "markdown",
      domainID: "tsf",
      exporter: "tsf-domain",
      candidateRecipeCount: recipeCount,
    } as unknown as JsonRecord,
  }
}

export const TSFDomain: ResearchDomain = {
  info: {
    id: "tsf",
    displayName: "Time Series Forecasting",
    version: "0.1.0",
    taskSpecSchemaID: "neo-research.tsf.task_spec.v1",
    candidateSpecSchemaID: "neo-cast.recipe_schema_v2",
    actionRegistry: ACTION_REGISTRY,
  },
  createTaskSpec(input) {
    return TSFTaskSpec.parse(input) as unknown as JsonRecord
  },
  summarizeTask(taskSpec, context) {
    return summarizeTSFTask(taskSpec, context)
  },
  buildBaselines(taskSpec) {
    return buildTSFBaselines(taskSpec)
  },
  rankCandidateProposals(input) {
    return rankTSFCandidateProposals(input)
  },
  proposeCandidate(input) {
    return proposeTSFCandidate(input)
  },
  validateCandidate(input) {
    return validateTSFCandidate(input.taskSpec, input.candidateSpec)
  },
  evaluateRun(input) {
    return evaluateTSFRun(input)
  },
  renderArtifact(input) {
    return renderTSFArtifact(input)
  },
  createRunPlan(input) {
    return createTSFRunPlan(input)
  },
}
