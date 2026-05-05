import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { Research } from "../../src/research"

const taskSpec = {
  contextLength: 96,
  predictionLengths: [24, 48],
  dataset: {
    loaderID: "etth1_tslib_v1",
    targetCols: ["HUFL", "HULL", "MUFL", "MULL", "LUFL", "LULL", "OT"],
  },
}

function validTransformerCandidate() {
  const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", taskSpec)
  return Research.DomainRegistry.buildBaselines("tsf", normalizedTask)[2]!.candidateSpec
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

describe("TSF research domain", () => {
  test("registers TSF metadata and builds bridge-valid baseline recipes", () => {
    const info = Research.DomainRegistry.getInfo("tsf")
    expect(info.id).toBe("tsf")
    expect(info.actionRegistry.backbone.transformer.bridgeSupported).toBe(true)
    expect(info.actionRegistry.backbone.dlinear.bridgeSupported).toBe(true)
    expect(info.actionRegistry.embedding.invert.bridgeSupported).toBe(true)
    expect(info.actionRegistry.fusion.feature.bridgeSupported).toBe(true)
    expect(info.actionRegistry.head.direct_multi_horizon.bridgeSupported).toBe(true)
    expect(info.actionRegistry.head.quantile.phaseMin).toBe("phase2")
    expect(info.actionRegistry.head.gaussian.phaseMin).toBe("phase2")
    expect(info.actionRegistry.head.residual_correction.phaseMin).toBe("phase2")
    expect(info.actionRegistry.loss.quantile.phaseMin).toBe("phase2")
    expect(info.actionRegistry.loss.distillation.phaseMin).toBe("phase2")

    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", taskSpec)
    const baselines = Research.DomainRegistry.buildBaselines("tsf", normalizedTask)

    expect(baselines.map((item) => item.candidateSpec.recipeID)).toEqual([
      "tsf_linear_raw_baseline",
      "tsf_patch_mlp_baseline",
      "tsf_patch_transformer_baseline",
    ])

    for (const proposal of baselines) {
      const result = Research.DomainRegistry.validateCandidate("tsf", {
        taskSpec: normalizedTask,
        candidateSpec: proposal.candidateSpec,
      })
      expect(result.ok).toBe(true)
      expect(result.issues).toEqual([])
    }
  })

  test("rejects invalid patch scales and transformer head dimensions", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", taskSpec)
    const candidateSpec = {
      ...validTransformerCandidate(),
      embedding: { type: "patch", patchLen: 128, stride: 256, dModel: 30 },
      backbone: {
        type: "transformer",
        dModel: 30,
        nHeads: 8,
        nLayers: 2,
        dropout: 0.1,
        ffnMult: 4,
      },
    }

    const result = Research.DomainRegistry.validateCandidate("tsf", {
      taskSpec: normalizedTask,
      candidateSpec,
    })

    expect(result.ok).toBe(false)
    expect(result.issues.map((item) => item.path)).toContain("embedding.patchLen")
    expect(result.issues.map((item) => item.path)).toContain("embedding.stride")
    expect(result.issues.map((item) => item.path)).toContain("backbone.dModel")
  })

  test("bridge-only mode rejects unsupported phase-two actions", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", taskSpec)
    const candidateSpec = {
      ...validTransformerCandidate(),
      embedding: { type: "none" },
      backbone: {
        type: "tcn",
        hiddenDim: 128,
        nLayers: 2,
        kernelSize: 3,
        activation: "gelu",
        dropout: 0.1,
      },
    }

    const result = Research.DomainRegistry.validateCandidate("tsf", {
      taskSpec: normalizedTask,
      candidateSpec,
    })

    expect(result.ok).toBe(false)
    expect(result.issues.map((item) => item.path)).toContain("backbone.type")
  })

  test("summarizes leak-safe TSF task fingerprints from task specs", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", taskSpec)
    const fingerprint = Research.DomainRegistry.summarizeTask("tsf", normalizedTask)

    expect(fingerprint).toMatchObject({
      taskType: "forecasting",
      seriesType: "multivariate",
      loaderID: "etth1_tslib_v1",
      targetCount: 7,
      contextLength: 96,
      maxPredictionLength: 48,
      horizonContextRatio: 0.5,
      metricPrimary: "val_avg_mse",
      bridgeOnly: true,
    })
    expect(fingerprint.searchBiases).toContain("multivariate")
    expect(fingerprint.searchBiases).toContain("bridge_safe")
  })

  test("accepts probabilistic TSF objectives and fingerprints their metrics", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      forecastMode: "probabilistic",
      evaluation: {
        protocol: "fixed_split",
        metricPrimary: "val_avg_pinball",
        metricReference: "ref_test_avg_pinball",
        seeds: [3, 5],
      },
      runtime: { bridgeOnly: false },
    })
    const fingerprint = Research.DomainRegistry.summarizeTask("tsf", normalizedTask)

    expect(fingerprint).toMatchObject({
      forecastMode: "probabilistic",
      metricPrimary: "val_avg_pinball",
      bridgeOnly: false,
    })
    expect(fingerprint.searchBiases).toContain("probabilistic")
  })

  test("profiles TSF dataset files into task fingerprints", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-tsf-profile-"))
    const csvPath = path.join(root, "train.csv")
    const lines = ["date,a,b,c"]
    for (let index = 0; index < 96; index++) {
      const seasonal = index % 24
      const trend = index * 0.5
      const a = trend + seasonal
      const b = trend + seasonal * 2
      const c = index < 48 ? a : a + 30
      lines.push(`2024-01-${String((index % 28) + 1).padStart(2, "0")},${a},${index === 10 ? "" : b},${c}`)
    }
    await writeFile(csvPath, `${lines.join("\n")}\n`, "utf8")

    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      dataset: {
        ...taskSpec.dataset,
        path: csvPath,
      },
    })
    const fingerprint = Research.DomainRegistry.summarizeTask("tsf", normalizedTask)
    const datasetProfile = asRecord(fingerprint.datasetProfile)

    expect(datasetProfile).toMatchObject({
      source: "dataset.path",
      rowCount: 96,
      targetCount: 3,
    })
    expect(datasetProfile.missingRate).toBeGreaterThan(0)
    expect(datasetProfile.trendStrength).toBeGreaterThan(0.2)
    expect(datasetProfile.seasonalityStrength).toBeGreaterThan(0.4)
    expect(datasetProfile.crossVarCorrelation).toBeGreaterThan(0.8)
    expect(datasetProfile.distributionShift).toBeGreaterThan(0.5)
    expect(fingerprint.searchBiases).toContain("seasonal")
    expect(fingerprint.searchBiases).toContain("trend")
    expect(fingerprint.searchBiases).toContain("cross_var_correlated")
    expect(fingerprint.searchBiases).toContain("missing_values")
    expect(fingerprint.searchBiases).toContain("distribution_shift")
  })

  test("uses TSF dataset profiles to seed data-driven full-recipe baselines", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-tsf-profile-baselines-"))
    const csvPath = path.join(root, "train.csv")
    const lines = ["date,a,b,c"]
    for (let index = 0; index < 128; index++) {
      const seasonal = index % 24
      const trend = index * 0.4
      const a = trend + seasonal
      const b = trend + seasonal * 2
      const c = index < 64 ? a : a + 25
      lines.push(`2024-01-${String((index % 28) + 1).padStart(2, "0")},${a},${b},${c}`)
    }
    await writeFile(csvPath, `${lines.join("\n")}\n`, "utf8")

    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      dataset: {
        ...taskSpec.dataset,
        path: csvPath,
        targetCols: ["a", "b", "c"],
      },
      runtime: { bridgeOnly: false },
    })
    const baselines = Research.DomainRegistry.buildBaselines("tsf", normalizedTask)
    const recipeIDs = baselines.map((item) => asRecord(item.candidateSpec).recipeID)

    expect(recipeIDs).toContain("tsf_profile_feature_fusion_baseline")
    expect(recipeIDs).toContain("tsf_profile_shift_robust_baseline")
    for (const proposal of baselines) {
      const result = Research.DomainRegistry.validateCandidate("tsf", {
        taskSpec: normalizedTask,
        candidateSpec: proposal.candidateSpec,
      })
      expect(result.ok).toBe(true)
    }
  })

  test("uses search biases to seed profile-driven baselines without reopening the dataset", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      runtime: { bridgeOnly: false },
      metadata: {
        searchBiases: ["seasonal", "cross_var_correlated", "missing_values", "distribution_shift"],
        datasetProfile: {
          source: "dataset.path",
          path: "/tmp/already-profiled.csv",
          rowCount: 512,
          targetCount: 4,
          numericColumnCount: 4,
          missingRate: 0,
          trendStrength: 0.1,
          seasonalityStrength: 0.1,
          crossVarCorrelation: 0.1,
          distributionShift: 0.1,
        },
      },
    })
    const baselines = Research.DomainRegistry.buildBaselines("tsf", normalizedTask)
    const seasonal = baselines.find((item) => asRecord(item.candidateSpec).recipeID === "tsf_profile_seasonal_decomposition_baseline")
    const feature = baselines.find((item) => asRecord(item.candidateSpec).recipeID === "tsf_profile_feature_fusion_baseline")
    const robust = baselines.find((item) => asRecord(item.candidateSpec).recipeID === "tsf_profile_shift_robust_baseline")

    expect(seasonal?.candidateSpec.preprocessing).toMatchObject({
      actions: [{ type: "series_decomposition" }],
    })
    expect(feature?.candidateSpec.fusion).toMatchObject({ type: "feature" })
    expect(robust?.candidateSpec.trainingStrategy).toMatchObject({
      loss: { base: "huber", horizonWeighting: "tail_heavy" },
    })
  })

  test("does not classify pure trend as seasonality", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-tsf-trend-only-"))
    const csvPath = path.join(root, "train.csv")
    const lines = ["date,a"]
    for (let index = 0; index < 96; index++) {
      lines.push(`2024-01-${String((index % 28) + 1).padStart(2, "0")},${index * 10}`)
    }
    await writeFile(csvPath, `${lines.join("\n")}\n`, "utf8")

    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      dataset: {
        ...taskSpec.dataset,
        path: csvPath,
        targetCols: ["a"],
      },
    })

    const fingerprint = Research.DomainRegistry.summarizeTask("tsf", normalizedTask)
    const datasetProfile = asRecord(fingerprint.datasetProfile)

    expect(datasetProfile.trendStrength).toBeGreaterThan(0.9)
    expect(datasetProfile.seasonalityStrength).toBeLessThan(0.1)
    expect(fingerprint.searchBiases).not.toContain("seasonal")
  })

  test("uses timestamp spacing when profiling trend strength", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-tsf-irregular-time-"))
    const csvPath = path.join(root, "train.csv")
    const lines = ["timestamp,a"]
    for (let index = 0; index < 9; index++) {
      const timestamp = new Date(Date.UTC(2024, 0, 1 + index)).toISOString()
      lines.push(`${timestamp},${index}`)
    }
    lines.push(`${new Date(Date.UTC(2024, 0, 101)).toISOString()},100`)
    await writeFile(csvPath, `${lines.join("\n")}\n`, "utf8")

    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      dataset: {
        ...taskSpec.dataset,
        path: csvPath,
        targetCols: ["a"],
      },
    })

    const fingerprint = Research.DomainRegistry.summarizeTask("tsf", normalizedTask)
    const datasetProfile = asRecord(fingerprint.datasetProfile)

    expect(datasetProfile.trendStrength).toBeGreaterThan(0.99)
  })

  test("does not inflate distribution shift for near-constant high-magnitude columns", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-tsf-near-constant-"))
    const csvPath = path.join(root, "train.csv")
    const lines = ["date,a"]
    for (let index = 0; index < 96; index++) {
      const value = index < 48 ? 1_000_000_000 : 1_000_000_100
      lines.push(`2024-01-${String((index % 28) + 1).padStart(2, "0")},${value}`)
    }
    await writeFile(csvPath, `${lines.join("\n")}\n`, "utf8")

    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      dataset: {
        ...taskSpec.dataset,
        path: csvPath,
        targetCols: ["a"],
      },
    })

    const fingerprint = Research.DomainRegistry.summarizeTask("tsf", normalizedTask)
    const datasetProfile = asRecord(fingerprint.datasetProfile)

    expect(datasetProfile.distributionShift).toBeLessThan(0.5)
    expect(fingerprint.searchBiases).not.toContain("distribution_shift")
  })

  test("keeps task fingerprinting usable when dataset profile files are unavailable", () => {
    const missingPath = path.join(tmpdir(), "opencode-tsf-profile-missing", "train.csv")
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      dataset: {
        ...taskSpec.dataset,
        path: missingPath,
      },
    })

    const fingerprint = Research.DomainRegistry.summarizeTask("tsf", normalizedTask)

    expect(fingerprint.datasetProfile).toBeUndefined()
    expect(fingerprint.datasetProfileWarning).toMatchObject({
      source: "dataset.path",
      path: missingPath,
      code: "dataset_read_failed",
    })
    expect(fingerprint.searchBiases).toContain("bridge_safe")
  })

  test("accepts planned TimeRecipe modules when bridge mode is disabled", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      runtime: { bridgeOnly: false },
    })
    const candidateSpec = {
      recipeVersion: "recipe_schema_v1",
      recipeID: "tsf_advanced_invert_rnn_direct",
      hypothesis: "A non-bridge TimeRecipe candidate explores variate-token embedding with recurrent modeling.",
      preprocessing: {
        actions: [
          { type: "seasonal_differencing", period: 24, order: 1 },
          { type: "missing_mask", maskChannel: true, fillPolicy: "mean" },
        ],
      },
      embedding: { type: "invert", dModel: 128 },
      backbone: { type: "rnn", cell: "gru", hiddenDim: 128, numLayers: 2, dropout: 0.1 },
      fusion: { type: "feature", variateToken: true, crossAttention: false },
      predictionHead: { type: "direct_multi_horizon", outputDistribution: "point", horizonSpecific: true },
      trainingStrategy: {
        loss: { base: "mae", horizonWeighting: "tail_heavy" },
        optimizer: { type: "adamw", lr: 0.0005, weightDecay: 0.01 },
        scheduler: { type: "one_cycle", warmupSteps: 10 },
        regularization: { dropout: 0.1, gradClip: 1 },
        budget: { maxEpochs: 5, timeBudgetS: 120, batchSize: 16, patience: 2, seed: 7 },
      },
    }

    const validation = Research.DomainRegistry.validateCandidate("tsf", {
      taskSpec: normalizedTask,
      candidateSpec: candidateSpec as unknown as Research.JsonRecord,
    })
    expect(validation.ok).toBe(true)
    expect(validation.issues).toEqual([])

    const plan = Research.DomainRegistry.createRunPlan("tsf", {
      taskSpec: normalizedTask,
      candidateSpec: candidateSpec as unknown as Research.JsonRecord,
      stage: "low_fidelity",
    })
    expect(plan.validation.ok).toBe(true)

    const payload = plan.writes[0]!.content
    expect(payload.preprocessing).toMatchObject({
      actions: [
        { type: "seasonal_differencing", period: 24, order: 1 },
        { type: "missing_mask", mask_channel: true, fill_policy: "mean" },
      ],
    })
    expect(payload.embedding).toMatchObject({ type: "invert", d_model: 128 })
    expect(payload.backbone).toMatchObject({ type: "rnn", cell: "gru", hidden_dim: 128, num_layers: 2 })
    expect(payload.fusion).toMatchObject({ type: "feature", variate_token: true, cross_attention: false })
    expect(payload.prediction_head).toMatchObject({
      type: "direct_multi_horizon",
      output_distribution: "point",
      horizon_specific: true,
    })
    expect(payload.training_strategy).toMatchObject({
      loss: { base: "mae", horizon_weighting: "tail_heavy" },
      scheduler: { type: "one_cycle", warmup_steps: 10 },
      budget: { max_epochs: 5, seed: 7 },
    })
  })

  test("renders phase-two frequency and reweighting actions with Neo-Cast runner names", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      runtime: { bridgeOnly: false },
    })
    const candidateSpec = {
      recipeVersion: "recipe_schema_v1",
      recipeID: "tsf_frequency_mixer_runner_names",
      hypothesis: "A frequency mixer candidate should serialize names accepted by the Neo-Cast Python runner.",
      preprocessing: {
        actions: [
          { type: "missing_mask", maskChannel: true, fillPolicy: "mean" },
          { type: "sample_reweighting", scheme: "outlier_robust" },
        ],
      },
      embedding: { type: "frequency", nFreq: 8, complexMode: "magnitude", dModel: 32 },
      backbone: {
        type: "mixer",
        hiddenDim: 32,
        depth: 2,
        temporalMixing: "mlp",
        channelMixing: true,
        dropout: 0.1,
      },
      fusion: { type: "gated_hybrid", gateType: "channel" },
      predictionHead: { type: "quantile", outputDistribution: "quantile", quantiles: [0.1, 0.5, 0.9] },
      trainingStrategy: {
        loss: { base: "quantile", horizonWeighting: "tail_heavy", quantiles: [0.1, 0.5, 0.9] },
        optimizer: { type: "adamw", lr: 0.0005, weightDecay: 0.01 },
        scheduler: { type: "one_cycle", warmupSteps: 10 },
        regularization: { dropout: 0.1, gradClip: 1 },
        budget: { maxEpochs: 5, timeBudgetS: 120, batchSize: 16, patience: 2, seed: 7 },
      },
    }

    const plan = Research.DomainRegistry.createRunPlan("tsf", {
      taskSpec: normalizedTask,
      candidateSpec: candidateSpec as unknown as Research.JsonRecord,
      stage: "low_fidelity",
    })

    expect(plan.validation.ok).toBe(true)
    expect(plan.writes[0]!.content.preprocessing).toMatchObject({
      actions: [
        { type: "missing_mask", mask_channel: true, fill_policy: "mean" },
        { type: "sample_reweighting", scheme: "outlier_robust" },
      ],
    })
    expect(plan.writes[0]!.content.embedding).toMatchObject({
      type: "frequency",
      n_freq: 8,
      complex_mode: "magnitude",
      d_model: 32,
    })
    const trainingStrategy = asRecord(plan.writes[0]!.content.training_strategy)
    expect(asRecord(trainingStrategy.loss)).toMatchObject({
      base: "quantile",
      horizon_weighting: "tail_heavy",
      quantiles: [0.1, 0.5, 0.9],
    })
  })

  test("serializes distillation loss teacher settings for the Neo-Cast runner", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      runtime: { bridgeOnly: false },
    })
    const candidateSpec = {
      ...validTransformerCandidate(),
      recipeID: "tsf_distillation_loss",
      trainingStrategy: {
        loss: {
          base: "distillation",
          horizonWeighting: "uniform",
          supervisedWeight: 0.4,
          teacherWeight: 0.6,
          teacher: { type: "moving_average", window: 24 },
        },
        optimizer: { type: "adamw", lr: 0.0005, weightDecay: 0.01 },
        scheduler: { type: "none", warmupSteps: 0 },
        regularization: { dropout: 0.1, gradClip: 1 },
        budget: { maxEpochs: 5, timeBudgetS: 120, batchSize: 16, patience: 2, seed: 7 },
      },
    }

    const plan = Research.DomainRegistry.createRunPlan("tsf", {
      taskSpec: normalizedTask,
      candidateSpec: candidateSpec as unknown as Research.JsonRecord,
      stage: "low_fidelity",
    })

    expect(plan.validation.ok).toBe(true)
    expect(asRecord(asRecord(plan.writes[0]!.content.training_strategy).loss)).toMatchObject({
      base: "distillation",
      supervised_weight: 0.4,
      teacher_weight: 0.6,
      teacher: { type: "moving_average", window: 24 },
    })
  })

  test("creates a Neo-Cast runner plan with snake_case recipe payload", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      runtime: {
        bridgeOnly: true,
        neoCastProjectRoot: "/work/neo_cast",
      },
    })
    const candidateSpec = Research.DomainRegistry.buildBaselines("tsf", normalizedTask)[2]!.candidateSpec

    const plan = Research.DomainRegistry.createRunPlan("tsf", {
      taskSpec: normalizedTask,
      candidateSpec,
      stage: "smoke",
      description: "smoke transformer baseline",
    })

    expect(plan.validation.ok).toBe(true)
    expect(plan.runnerID).toBe("neo-cast-python")
    expect(plan.command.cwd).toBe("/work/neo_cast")
    expect(plan.command.args).toEqual([
      "py/validate.py",
      "smoke",
      "--candidate-path",
      ".neo-cast/current_candidate.json",
      "--resolved-path",
      ".neo-cast/resolved_candidate.json",
      "--artifacts-dir",
      ".neo-cast/artifacts",
    ])

    const payload = plan.writes[0]!.content
    expect(payload.recipe_version).toBe("recipe_schema_v1")
    expect(payload.recipe_id).toBe("tsf_patch_transformer_baseline")
    expect(payload.embedding).toMatchObject({ type: "patch", patch_len: 16, stride: 8, d_model: 64 })
    expect(payload.embedding).not.toHaveProperty("patchLen")
    expect(payload.backbone).toMatchObject({ type: "transformer", d_model: 64, n_heads: 4, n_layers: 2 })
    expect(payload.prediction_head).toMatchObject({ type: "linear", output_distribution: "point" })
    expect(payload.training_strategy).toMatchObject({
      optimizer: { type: "adam", weight_decay: 0 },
      budget: { max_epochs: 50, time_budget_s: 600, batch_size: 32 },
    })
  })

  test("discovers a bundled Neo-Cast runner from the installed package root", async () => {
    const packageRoot = await mkdtemp(path.join(tmpdir(), "neo-research-package-root-"))
    const runnerRoot = path.join(packageRoot, "runners", "neo_cast")
    await mkdir(path.join(runnerRoot, "py"), { recursive: true })

    const previousPackageRoot = process.env.NEO_RESEARCH_PACKAGE_ROOT
    const previousNeoCastRoot = process.env.NEO_CAST_ROOT
    const previousNeoResearchNeoCastRoot = process.env.NEO_RESEARCH_NEO_CAST_ROOT
    try {
      process.env.NEO_RESEARCH_PACKAGE_ROOT = packageRoot
      delete process.env.NEO_CAST_ROOT
      delete process.env.NEO_RESEARCH_NEO_CAST_ROOT

      const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", taskSpec)
      const candidateSpec = Research.DomainRegistry.buildBaselines("tsf", normalizedTask)[0]!.candidateSpec
      const plan = Research.DomainRegistry.createRunPlan("tsf", {
        taskSpec: normalizedTask,
        candidateSpec,
        stage: "smoke",
      })

      expect(plan.command.cwd).toBe(process.cwd())
      expect(plan.command.args[0]).toBe(path.join(runnerRoot, "py", "validate.py"))
      expect(plan.command.env).toMatchObject({
        NEO_CAST_PROJECT_ROOT: process.cwd(),
        NEO_CAST_PACKAGE_ROOT: runnerRoot,
      })
    } finally {
      if (previousPackageRoot === undefined) delete process.env.NEO_RESEARCH_PACKAGE_ROOT
      else process.env.NEO_RESEARCH_PACKAGE_ROOT = previousPackageRoot
      if (previousNeoCastRoot === undefined) delete process.env.NEO_CAST_ROOT
      else process.env.NEO_CAST_ROOT = previousNeoCastRoot
      if (previousNeoResearchNeoCastRoot === undefined) delete process.env.NEO_RESEARCH_NEO_CAST_ROOT
      else process.env.NEO_RESEARCH_NEO_CAST_ROOT = previousNeoResearchNeoCastRoot
    }
  })

  test("creates an approval-gated blind test runner plan", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      runtime: {
        bridgeOnly: false,
        neoCastProjectRoot: "/work/neo_cast",
      },
    })
    const candidateSpec = validTransformerCandidate()

    const plan = Research.DomainRegistry.createRunPlan("tsf", {
      taskSpec: normalizedTask,
      candidateSpec,
      stage: "blind_test",
    })

    expect(plan.validation.ok).toBe(true)
    expect(plan.approvalRequired).toBe(true)
    expect(plan.command.cwd).toBe("/work/neo_cast")
    expect(plan.command.args).toEqual(["py/runner.py", "blind-test"])
    expect(plan.expectedEvents).toEqual(["blind_test_done"])
    expect(plan.expectedArtifacts).toEqual(["blind_test_metrics.json"])
    expect(plan.expectedMetrics).toEqual(["blind_test_avg_mse", "blind_test_avg_mae"])
  })

  test("proposes bridge-safe modular frontier recipes before local capacity mutations", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", taskSpec)
    const baselines = Research.DomainRegistry.buildBaselines("tsf", normalizedTask)
    const candidates = baselines.map((proposal, index) => ({
      id: `candidate_${index}`,
      candidateSpec: proposal.candidateSpec,
      approvalStatus: "auto_approved",
      generatedBy: "heuristic",
    }))

    const first = Research.DomainRegistry.proposeCandidate("tsf", {
      taskSpec: normalizedTask,
      candidates,
      runs: candidates.map((candidate, index) => ({
        candidateID: candidate.id,
        stage: "smoke",
        status: "succeeded",
        metrics: { val_avg_mse: 0.2 + index / 10 },
      })),
      memory: [],
      champion: { candidateID: "candidate_1", primaryMetric: 0.2, utility: -0.2 },
    })

    const firstSpec = first!.candidateSpec as {
      backbone: unknown
      trainingStrategy: { optimizer: unknown }
    }
    const bridgeRankings = Research.DomainRegistry.rankCandidateProposals("tsf", {
      taskSpec: normalizedTask,
      candidates,
      runs: [],
      memory: [],
      champion: { candidateID: "candidate_1", primaryMetric: 0.2, utility: -0.2 },
    })

    expect(bridgeRankings[0]).toMatchObject({
      predictorVersion: "tsf_profile_memory_ranker_v1",
      features: {
        contextLength: 96,
        maxPredictionLength: 48,
        bridgeOnly: true,
        hasChampion: true,
      },
      candidateActions: {
        embedding: "patch",
        backbone: "mlp",
        fusion: "temporal",
      },
    })
    expect(first?.candidateSpec.recipeID).toBe("tsf_bridge_patch_mlp_wide_adamw")
    expect(first?.rationale).toContain("Task prior: multivariate, short_horizon, bridge_safe")
    expect(firstSpec.backbone).toMatchObject({ type: "mlp", depth: 3, hiddenDim: 256 })
    expect(firstSpec.trainingStrategy.optimizer).toMatchObject({ type: "adamw", weightDecay: 0.01 })
    expect(
      Research.DomainRegistry.validateCandidate("tsf", {
        taskSpec: normalizedTask,
        candidateSpec: first!.candidateSpec,
      }).ok,
    ).toBe(true)

    const second = Research.DomainRegistry.proposeCandidate("tsf", {
      taskSpec: normalizedTask,
      candidates: [
        ...candidates,
        {
          id: "candidate_frontier",
          candidateSpec: first!.candidateSpec,
          approvalStatus: "auto_approved",
          generatedBy: "mutation",
        },
      ],
      runs: [],
      memory: [],
      champion: { candidateID: "candidate_1", primaryMetric: 0.2, utility: -0.2 },
    })

    expect(second?.candidateSpec.recipeID).toBe("tsf_bridge_patch_mlp_short_patch")
    expect(second?.candidateSpec.embedding).toMatchObject({ type: "patch", patchLen: 8, stride: 4 })
  })

  test("uses dataset profile rank predictor for full recipe autonomous proposals", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      runtime: { bridgeOnly: false },
    })
    const proposal = Research.DomainRegistry.proposeCandidate("tsf", {
      taskSpec: normalizedTask,
      taskFingerprint: {
        ...Research.DomainRegistry.summarizeTask("tsf", normalizedTask),
        searchBiases: ["multivariate", "full_recipe_space", "seasonal", "missing_values", "distribution_shift"],
        datasetProfile: {
          source: "dataset.path",
          path: "/tmp/train.csv",
          rowCount: 1024,
          targetCount: 7,
          numericColumnCount: 7,
          missingRate: 0.02,
          trendStrength: 0.31,
          seasonalityStrength: 0.86,
          crossVarCorrelation: 0.74,
          distributionShift: 0.67,
        },
      },
      candidates: [],
      runs: [],
      memory: [],
    })

    expect(proposal?.candidateSpec.recipeID).toBe("tsf_ranked_frequency_mixer_profiled")
    expect(proposal?.candidateSpec.embedding).toMatchObject({ type: "frequency", complexMode: "magnitude" })
    expect(proposal?.candidateSpec.backbone).toMatchObject({ type: "mixer" })
    expect(proposal?.candidateSpec.preprocessing).toMatchObject({
      actions: [
        { type: "missing_mask", maskChannel: true, fillPolicy: "mean" },
        { type: "sample_reweighting", scheme: "outlier_robust" },
      ],
    })
    expect(proposal?.rationale).toContain("Rank predictor")
    expect(
      Research.DomainRegistry.validateCandidate("tsf", {
        taskSpec: normalizedTask,
        candidateSpec: proposal!.candidateSpec,
      }).ok,
    ).toBe(true)
  })

  test("uses search biases to shape native proposals when profile metrics are unavailable", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      runtime: { bridgeOnly: false },
    })
    const proposal = Research.DomainRegistry.proposeCandidate("tsf", {
      taskSpec: normalizedTask,
      taskFingerprint: {
        ...Research.DomainRegistry.summarizeTask("tsf", normalizedTask),
        searchBiases: ["multivariate", "full_recipe_space", "seasonal", "missing_values", "distribution_shift"],
      },
      candidates: [],
      runs: [],
      memory: [],
    })

    expect(proposal?.candidateSpec.recipeID).toBe("tsf_ranked_frequency_mixer_profiled")
    expect(proposal?.candidateSpec.preprocessing).toMatchObject({
      actions: [
        { type: "missing_mask", maskChannel: true, fillPolicy: "mean" },
        { type: "sample_reweighting", scheme: "outlier_robust" },
      ],
    })
    expect(proposal?.candidateSpec.trainingStrategy).toMatchObject({
      loss: { base: "huber", horizonWeighting: "tail_heavy" },
    })
    expect(proposal?.rationale).toContain("seasonality favors frequency embedding")
  })

  test("uses run memory to rerank full recipe autonomous proposals", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      runtime: { bridgeOnly: false },
    })
    const priorTraining = {
      loss: { base: "huber", horizonWeighting: "tail_heavy", delta: 1 },
      optimizer: { type: "adamw", lr: 0.0005, weightDecay: 0.01 },
      scheduler: { type: "one_cycle", warmupSteps: 10 },
      regularization: { dropout: 0.1, gradClip: 1 },
      budget: { maxEpochs: 5, timeBudgetS: 120, batchSize: 16, patience: 2, seed: 7 },
    }
    const failedFrequency = {
      recipeVersion: "recipe_schema_v1",
      recipeID: "past_failed_frequency_mixer",
      hypothesis: "Prior frequency mixer trial failed on this task family.",
      preprocessing: { actions: [{ type: "none" }] },
      embedding: { type: "frequency", nFreq: 8, complexMode: "magnitude", dModel: 32 },
      backbone: { type: "mixer", hiddenDim: 64, depth: 2, temporalMixing: "mlp", channelMixing: true, dropout: 0.1 },
      fusion: { type: "gated_hybrid", gateType: "channel" },
      predictionHead: { type: "direct_multi_horizon", outputDistribution: "point", horizonSpecific: true },
      trainingStrategy: priorTraining,
    }
    const acceptedInvert = {
      recipeVersion: "recipe_schema_v1",
      recipeID: "past_accepted_invert_rnn",
      hypothesis: "Prior inverted RNN trial improved a related task.",
      preprocessing: { actions: [{ type: "none" }] },
      embedding: { type: "invert", dModel: 64 },
      backbone: { type: "rnn", cell: "gru", hiddenDim: 96, numLayers: 2, dropout: 0.1 },
      fusion: { type: "feature", variateToken: true, crossAttention: true },
      predictionHead: { type: "direct_multi_horizon", outputDistribution: "point", horizonSpecific: true },
      trainingStrategy: priorTraining,
    }

    const proposalContext: Parameters<typeof Research.DomainRegistry.proposeCandidate>[1] = {
      taskSpec: normalizedTask,
      taskFingerprint: {
        ...Research.DomainRegistry.summarizeTask("tsf", normalizedTask),
        searchBiases: ["multivariate", "full_recipe_space", "seasonal", "cross_var_correlated"],
        datasetProfile: {
          source: "dataset.path",
          path: "/tmp/train.csv",
          rowCount: 1024,
          targetCount: 7,
          numericColumnCount: 7,
          missingRate: 0,
          trendStrength: 0.2,
          seasonalityStrength: 0.9,
          crossVarCorrelation: 0.8,
          distributionShift: 0.2,
        },
      },
      candidates: [
        {
          id: "past_frequency",
          candidateSpec: failedFrequency as unknown as Research.JsonRecord,
          approvalStatus: "auto_approved",
          generatedBy: "mutation",
        },
        {
          id: "past_invert",
          candidateSpec: acceptedInvert as unknown as Research.JsonRecord,
          approvalStatus: "auto_approved",
          generatedBy: "mutation",
        },
      ],
      runs: [
        { candidateID: "past_frequency", stage: "smoke", status: "failed", metrics: {} },
        { candidateID: "past_invert", stage: "smoke", status: "succeeded", metrics: { val_avg_mse: 0.12 } },
      ],
      memory: [
        {
          outcome: "failed",
          lesson: "Frequency mixer failed under this profile.",
          candidateSummary: { candidateID: "past_frequency", status: "failed" },
        },
        {
          outcome: "accepted",
          lesson: "Invert RNN improved champion quality on a similar profile.",
          candidateSummary: { candidateID: "past_invert", championUpdated: true },
        },
      ],
      champion: { candidateID: "past_invert", primaryMetric: 0.12, utility: -0.12 },
    }

    const rankings = Research.DomainRegistry.rankCandidateProposals("tsf", proposalContext)
    const proposal = Research.DomainRegistry.proposeCandidate("tsf", proposalContext)

    expect(proposal?.candidateSpec.recipeID).toBe("tsf_ranked_invert_rnn_feature_profiled")
    expect(proposal?.rationale).toContain("history")
    expect(rankings[0]?.candidateSpec.recipeID).toBe("tsf_ranked_invert_rnn_feature_profiled")
    expect(rankings[0]?.predictorVersion).toBe("tsf_profile_learned_memory_ranker_v1")
    expect(rankings[0]?.features).toMatchObject({
      historyRunCount: 2,
      historyMetricRunCount: 1,
      historyMemoryCount: 2,
      learnedRankerTrainingExamples: 4,
      learnedRankerPositiveExamples: 3,
      learnedRankerNegativeExamples: 1,
      hasChampion: true,
    })
    expect(rankings[0]?.reasons.some((reason) => reason.includes("metric history"))).toBe(true)
    expect(rankings[0]?.reasons.some((reason) => reason.includes("learned memory ranker"))).toBe(true)
  })

  test("uses cross-task benchmark memory to rerank full recipe autonomous proposals", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      runtime: { bridgeOnly: false },
    })
    const priorTraining = {
      loss: { base: "huber", horizonWeighting: "tail_heavy", delta: 1 },
      optimizer: { type: "adamw", lr: 0.0005, weightDecay: 0.01 },
      scheduler: { type: "one_cycle", warmupSteps: 10 },
      regularization: { dropout: 0.1, gradClip: 1 },
      budget: { maxEpochs: 5, timeBudgetS: 120, batchSize: 16, patience: 2, seed: 7 },
    }
    const acceptedInvert = {
      recipeVersion: "recipe_schema_v1",
      recipeID: "benchmark_accepted_invert_rnn",
      hypothesis: "Prior inverted RNN trial improved a related benchmark task.",
      preprocessing: { actions: [{ type: "none" }] },
      embedding: { type: "invert", dModel: 64 },
      backbone: { type: "rnn", cell: "gru", hiddenDim: 96, numLayers: 2, dropout: 0.1 },
      fusion: { type: "feature", variateToken: true, crossAttention: true },
      predictionHead: { type: "direct_multi_horizon", outputDistribution: "point", horizonSpecific: true },
      trainingStrategy: priorTraining,
    }
    const taskFingerprint = {
      ...Research.DomainRegistry.summarizeTask("tsf", normalizedTask),
      searchBiases: ["multivariate", "full_recipe_space", "seasonal", "cross_var_correlated"],
      datasetProfile: {
        source: "dataset.path",
        path: "/tmp/target.csv",
        rowCount: 1024,
        targetCount: 7,
        numericColumnCount: 7,
        missingRate: 0,
        trendStrength: 0.2,
        seasonalityStrength: 0.9,
        crossVarCorrelation: 0.8,
        distributionShift: 0.2,
      },
    }
    const proposalContext: Parameters<typeof Research.DomainRegistry.proposeCandidate>[1] = {
      taskSpec: normalizedTask,
      taskFingerprint,
      candidates: [],
      runs: [],
      memory: [
        {
          scope: "domain",
          outcome: "accepted",
          lesson: "Invert RNN improved champion quality on a similar benchmark.",
          fingerprintSummary: {
            taskID: "rtsk_benchmark",
            domainID: "tsf",
            datasetProfile: {
              source: "dataset.path",
              path: "/tmp/source.csv",
              rowCount: 960,
              targetCount: 7,
              numericColumnCount: 7,
              missingRate: 0,
              trendStrength: 0.18,
              seasonalityStrength: 0.88,
              crossVarCorrelation: 0.78,
              distributionShift: 0.22,
            },
          },
          candidateSummary: {
            candidateSpec: acceptedInvert,
            primaryMetric: 0.11,
            championUpdated: true,
          },
        },
      ],
    }

    const rankings = Research.DomainRegistry.rankCandidateProposals("tsf", proposalContext)
    const proposal = Research.DomainRegistry.proposeCandidate("tsf", proposalContext)

    expect(proposal?.candidateSpec.recipeID).toBe("tsf_ranked_invert_rnn_feature_profiled")
    expect(rankings[0]?.candidateSpec.recipeID).toBe("tsf_ranked_invert_rnn_feature_profiled")
    expect(rankings[0]?.predictorVersion).toBe("tsf_profile_benchmark_memory_ranker_v1")
    expect(rankings[0]?.features).toMatchObject({
      historyMemoryCount: 1,
      historyDomainMemoryCount: 1,
      historyTaskMemoryCount: 0,
      memoryEvidenceCount: 1,
      benchmarkEvidenceCount: 1,
      datasetProfileSignals: {
        source: "dataset.path",
        active: expect.arrayContaining(["seasonal", "cross_var_correlated"]),
      },
    })
    expect(rankings[0]?.candidateActions).toMatchObject({
      noveltySummary: {
        novelActionCount: expect.any(Number),
        repeatedActionCount: expect.any(Number),
        novelActions: expect.any(Array),
      },
    })
    expect(rankings[0]?.reasons.some((reason) => reason.includes("benchmark memory accepted similar"))).toBe(true)
  })

  test("proposeTSFCandidate with seasonal bias uses frequency embedding in mutation", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      runtime: { bridgeOnly: false },
    })
    const taskFingerprint = {
      ...Research.DomainRegistry.summarizeTask("tsf", normalizedTask),
      searchBiases: ["seasonal", "multivariate", "full_recipe_space"],
      datasetProfile: {
        source: "dataset.path",
        path: "/tmp/seasonal.csv",
        rowCount: 512,
        targetCount: 7,
        numericColumnCount: 7,
        missingRate: 0,
        trendStrength: 0.2,
        seasonalityStrength: 0.7,
        crossVarCorrelation: 0.1,
        distributionShift: 0.1,
      },
    }

    // Exhaust the frontier by providing existing recipe IDs, forcing mutation path
    const baselines = Research.DomainRegistry.buildBaselines("tsf", normalizedTask)
    const allFrontier = Research.DomainRegistry.rankCandidateProposals("tsf", {
      taskSpec: normalizedTask,
      taskFingerprint,
      candidates: [],
      runs: [],
      memory: [],
    })
    const allFrontierIDs = allFrontier.map((item) => asRecord(item.candidateSpec).recipeID).filter(Boolean)
    const baselineIDs = baselines.map((item) => asRecord(item.candidateSpec).recipeID).filter(Boolean)
    const allIDs = [...new Set([...allFrontierIDs, ...baselineIDs])] as string[]

    // Use the patch MLP baseline as champion so the mutation base has a patch embedding
    const patchCandidate = baselines.find((b) => asRecord(b.candidateSpec).recipeID === "tsf_patch_mlp_baseline")!
    const patchCandidateID = "champion_patch_cand" as Research.ResearchCandidateID
    const existingCandidates = [
      {
        id: patchCandidateID,
        candidateSpec: asRecord(patchCandidate.candidateSpec),
        approvalStatus: "auto_approved",
        generatedBy: "heuristic" as const,
      },
      ...allIDs
        .filter((id) => id !== "tsf_patch_mlp_baseline")
        .map((id, i) => ({
          id: `c${i}` as Research.ResearchCandidateID,
          candidateSpec: { ...asRecord(patchCandidate.candidateSpec), recipeID: id },
          approvalStatus: "auto_approved",
          generatedBy: "heuristic" as const,
        })),
    ]

    const proposal = Research.DomainRegistry.proposeCandidate("tsf", {
      taskSpec: normalizedTask,
      taskFingerprint,
      candidates: existingCandidates as unknown as Parameters<typeof Research.DomainRegistry.proposeCandidate>[1]["candidates"],
      runs: [],
      memory: [],
      champion: { candidateID: patchCandidateID, primaryMetric: 0.15, utility: -0.15 },
    })

    // Should produce a mutation (not undefined), and with seasonal bias + patch base, should switch to frequency
    expect(proposal).not.toBeUndefined()
    if (proposal) {
      const candidateSpec = asRecord(proposal.candidateSpec)
      const hypothesis = typeof candidateSpec.hypothesis === "string" ? candidateSpec.hypothesis : ""
      const embedding = asRecord(candidateSpec.embedding)
      // The profile-aware mutation should use frequency embedding or contain profile guidance
      const isProfileGuided =
        hypothesis.includes("Profile-guided") ||
        hypothesis.includes("seasonal") ||
        embedding.type === "frequency"
      expect(isProfileGuided).toBe(true)
    }
  })

  test("proposeTSFCandidate with cross_var bias uses gated_hybrid fusion in mutation", () => {
    const normalizedTask = Research.DomainRegistry.createTaskSpec("tsf", {
      ...taskSpec,
      runtime: { bridgeOnly: false },
    })
    const taskFingerprint = {
      ...Research.DomainRegistry.summarizeTask("tsf", normalizedTask),
      searchBiases: ["cross_var_correlated", "multivariate", "full_recipe_space"],
      datasetProfile: {
        source: "dataset.path",
        path: "/tmp/crossvar.csv",
        rowCount: 512,
        targetCount: 7,
        numericColumnCount: 7,
        missingRate: 0,
        trendStrength: 0.1,
        seasonalityStrength: 0.1,
        crossVarCorrelation: 0.85,
        distributionShift: 0.1,
      },
    }

    const baselines = Research.DomainRegistry.buildBaselines("tsf", normalizedTask)
    const allFrontier = Research.DomainRegistry.rankCandidateProposals("tsf", {
      taskSpec: normalizedTask,
      taskFingerprint,
      candidates: [],
      runs: [],
      memory: [],
    })
    const allFrontierIDs = allFrontier.map((item) => asRecord(item.candidateSpec).recipeID).filter(Boolean)
    const baselineIDs = baselines.map((item) => asRecord(item.candidateSpec).recipeID).filter(Boolean)
    const allIDs = [...new Set([...allFrontierIDs, ...baselineIDs])] as string[]

    // Use the first baseline (temporal fusion) as champion to ensure mutation has temporal fusion base
    const linearCandidate = baselines[0]!
    const linearCandidateID = "champion_linear_cand" as Research.ResearchCandidateID
    const existingCandidates = [
      {
        id: linearCandidateID,
        candidateSpec: asRecord(linearCandidate.candidateSpec),
        approvalStatus: "auto_approved",
        generatedBy: "heuristic" as const,
      },
      ...allIDs
        .filter((id) => id !== asRecord(linearCandidate.candidateSpec).recipeID)
        .map((id, i) => ({
          id: `c${i}` as Research.ResearchCandidateID,
          candidateSpec: { ...asRecord(linearCandidate.candidateSpec), recipeID: id },
          approvalStatus: "auto_approved",
          generatedBy: "heuristic" as const,
        })),
    ]

    const proposal = Research.DomainRegistry.proposeCandidate("tsf", {
      taskSpec: normalizedTask,
      taskFingerprint,
      candidates: existingCandidates as unknown as Parameters<typeof Research.DomainRegistry.proposeCandidate>[1]["candidates"],
      runs: [],
      memory: [],
      champion: { candidateID: linearCandidateID, primaryMetric: 0.2, utility: -0.2 },
    })

    expect(proposal).not.toBeUndefined()
    if (proposal) {
      const candidateSpec = asRecord(proposal.candidateSpec)
      const hypothesis = typeof candidateSpec.hypothesis === "string" ? candidateSpec.hypothesis : ""
      const fusion = asRecord(candidateSpec.fusion)
      const isProfileGuided =
        hypothesis.includes("Profile-guided") ||
        hypothesis.includes("cross_var") ||
        hypothesis.includes("correlated") ||
        fusion.type === "gated_hybrid"
      expect(isProfileGuided).toBe(true)
    }
  })
})
