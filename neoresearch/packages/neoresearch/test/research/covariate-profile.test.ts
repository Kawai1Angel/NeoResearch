import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { summarizeTSFTask, TSFTaskSpec } from "../../src/research/domains/tsf"
import { analyzeDataset, buildDatasetAnalysisContext } from "../../src/research/agents/data-analysis-agent"
import { analyzeDatasetProfileForPrompt, compactPromptContext } from "../../src/research/prompt-context"
import { extractDatasetEvidence } from "../../src/research/retrieve/dataset-evidence"
import { DatasetQuantitativeAnalysisSchema } from "../../src/research/retrieve/contract"
import { spectralPowers } from "../../src/research/spectral-analysis"
import type { ResearchTask } from "../../src/research/schema"

function task(source: string, covariates: string[]) {
  return {
    id: "covariate_profile_test",
    domainID: "tsf",
    title: "Covariate diagnostics",
    objective: { primaryMetric: "cv_avg_mse", direction: "minimize" },
    taskSpec: TSFTaskSpec.parse({
      contextLength: 96,
      predictionLengths: [96],
      dataset: { loaderID: "local_csv", path: source, targetCols: ["OT"], observedPastCovariates: covariates },
    }),
  } as unknown as ResearchTask
}

function noise(length: number) {
  let state = 42
  return Array.from({ length }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32 - 0.5
  })
}

test("single-target profiling analyzes historical inputs and measures target-related correlation without a matrix", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "source.csv")
  await Bun.write(
    source,
    [
      "date,OT,cycle,drift",
      ...Array.from({ length: 192 }, (_, index) => {
        const cycle = Math.sin((2 * Math.PI * index) / 24)
        return [
          new Date(Date.UTC(2024, 0, 1) + index * 3600000).toISOString(),
          cycle,
          -cycle * 1000,
          index === 31 ? "" : index === 100 ? 1e9 : index * 1e5,
        ].join(",")
      }),
    ].join("\n"),
  )
  const t = task(source, ["cycle", "drift"])
  const fingerprint = summarizeTSFTask(t.taskSpec)
  const profile = fingerprint.datasetProfile as any
  expect(profile).toMatchObject({
    targetCount: 1,
    observedPastCovariateCount: 2,
    numericColumnCount: 3,
    profiledColumnCount: 3,
  })
  expect(profile.correlationMatrix).toBeUndefined()
  expect(profile.correlations).toMatchObject({ scope: "target_covariate", evaluatedPairCount: 2, validPairCount: 2 })
  expect(profile.correlations.strongestPairs[0]).toEqual({ source: "cycle", target: "OT", correlation: -1 })
  expect(profile.crossVarCorrelation).toBeGreaterThan(0.49)
  expect(profile.covariateProfiles[0]).toMatchObject({ column: "cycle", acfMainPeriod: 24 })
  expect(profile.covariateProfiles[1].missingRate).toBeCloseTo(1 / 192, 5)
  expect(profile.covariateProfiles[1].outlierRate).toBeGreaterThan(0)
  const targetsOnly = summarizeTSFTask(task(source, []).taskSpec).datasetProfile as any
  for (const key of ["missingRate", "trendStrength", "seasonalityStrength", "outlierRate", "distributionShift"]) {
    expect(profile[key]).toBe(targetsOnly[key])
  }
  expect(profile.profileFingerprint).not.toBe(targetsOnly.profileFingerprint)
  const prompt = analyzeDatasetProfileForPrompt(profile)
  expect(prompt.covariates).toHaveLength(2)
  expect(prompt.correlationStructure).toMatchObject({ scope: "target_covariate" })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const context = await buildDatasetAnalysisContext(t, fingerprint)
      const analysis = analyzeDataset({ task: t, fingerprint, context })
      expect(analysis.reportJSON.analysisCoverage).toMatchObject({
        profiledRows: 192,
        statisticRows: 192,
        targetColumns: ["OT"],
        covariateColumns: ["cycle", "drift"],
      })
      expect(analysis.reportJSON.covariates).toHaveLength(2)
      const [cycle, drift] = analysis.reportJSON.covariates!
      expect(cycle!.statistics.decomposition.period).toBe(24)
      expect(cycle!.statistics.frequency.dominantPeriod).toBeCloseTo(24, 5)
      expect(cycle!.statistics.stationarity.adfStatistic).toBeNumber()
      expect(cycle!.statistics.stationarity.kpssStatistic).toBeNumber()
      expect(Math.abs(cycle!.statistics.acf.topCorrelation!)).toBeGreaterThan(0.9)
      expect(drift!.statistics.changepoint.score).toBeNumber()
      expect(drift!.profile.missingRate).toBeCloseTo(1 / 192, 5)
      expect(analysis.reportMarkdown).toContain("## Observed-past Covariate Analysis")
      expect(analysis.reportMarkdown).toContain("### cycle")
      expect(analysis.reportMarkdown).not.toContain("## Correlation Matrix")
      expect(extractDatasetEvidence(analysis.reportJSON).map((item) => item.path)).toContain("$.covariates")
      expect(DatasetQuantitativeAnalysisSchema.safeParse(analysis.reportJSON).success).toBe(true)
    },
  })
})

test("cross-lag detects a historical covariate leading the target, excluding covariate-to-covariate pairs", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "lag.csv")
  const driver = noise(240)
  await Bun.write(
    source,
    [
      "date,OT,driver,duplicate",
      ...driver.map((value, index) =>
        [
          new Date(Date.UTC(2024, 0, 1) + index * 3600000).toISOString(),
          driver[index - 3] ?? 0,
          value,
          value * 100,
        ].join(","),
      ),
    ].join("\n"),
  )
  const t = task(source, ["driver", "duplicate"])
  const fingerprint = summarizeTSFTask(t.taskSpec)
  expect((fingerprint.datasetProfile as any).correlations.evaluatedPairCount).toBe(2)
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const context = await buildDatasetAnalysisContext(t, fingerprint)
      expect(context.statistics.crossLag).toMatchObject({ target: "OT", lag: 3, correlation: 1 })
      for (const item of context.covariates!) {
        expect(item.statistics.crossLag).toMatchObject({ source: item.column, target: "OT", lag: 3, correlation: 1 })
      }
    },
  })
})

test("undefined dependence for constant or missing covariates is not reported as zero", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "missing.csv")
  await Bun.write(
    source,
    [
      "date,OT,constant,missing",
      ...noise(96).map((value, index) =>
        [new Date(Date.UTC(2024, 0, 1) + index * 3600000).toISOString(), value, 4, ""].join(","),
      ),
    ].join("\n"),
  )
  const t = task(source, ["constant", "missing"])
  const fingerprint = summarizeTSFTask(t.taskSpec)
  const profile = fingerprint.datasetProfile as any
  expect(profile.correlations).toMatchObject({ evaluatedPairCount: 2, validPairCount: 0, strongestPairs: [] })
  expect(profile.crossVarCorrelation).toBeUndefined()
  expect(profile.covariateProfiles[1].missingRate).toBe(1)
  expect((analyzeDatasetProfileForPrompt(profile).metrics as any).crossVarCorrelation).toBeUndefined()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const context = await buildDatasetAnalysisContext(t, fingerprint)
      expect(context.statistics.crossLag).toEqual({})
      expect(context.covariates![1]!.statistics.acf.topCorrelation).toBeUndefined()
      expect(analyzeDataset({ task: t, fingerprint, context }).reportJSON.profile.crossVarCorrelation).toBeUndefined()
    },
  })
})

test("missing configured covariates fail visibly rather than silently profiling targets only", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "source.csv")
  await Bun.write(source, "date,OT\n2024-01-01,1\n2024-01-02,2\n")
  const fingerprint = summarizeTSFTask(task(source, ["absent"]).taskSpec)
  expect(fingerprint.datasetProfile).toBeUndefined()
  expect(fingerprint.datasetProfileWarning).toMatchObject({ code: "missing_covariate_columns" })
})

test("verified training data supplies covariate diagnostics without exposing validation or test values", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "source.csv")
  const t = task(source, ["driver"])
  const prefix =
    [
      "date,OT,driver",
      ...noise(96).map((value, index) =>
        [new Date(Date.UTC(2024, 0, 1) + index * 3600000).toISOString(), value, value].join(","),
      ),
    ].join("\n") + "\n"
  const full = prefix + "2024-02-01,999999,-999999\n"
  await Bun.write(source, full)
  const workspaceRoot = path.join(tmp.path, ".neo-research/workspaces", t.id)
  const dataRoot = path.join(workspaceRoot, ".neo-cast/dataset")
  await mkdir(dataRoot, { recursive: true })
  const spec = JSON.stringify({ source_csv: source, target_columns: ["OT"], observed_past_covariates: ["driver"] })
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  await Bun.write(path.join(dataRoot, "dataset_spec.json"), spec)
  await Bun.write(path.join(dataRoot, "local_csv_train.csv"), prefix)
  await Bun.write(
    path.join(dataRoot, "profile_provenance.json"),
    JSON.stringify({ source_sha256: hash(full), train_sha256: hash(prefix), spec_sha256: hash(spec) }),
  )
  const fingerprint = summarizeTSFTask(t.taskSpec, { taskID: t.id, projectRoot: tmp.path, workspaceRoot })
  expect((fingerprint.datasetProfile as any).crossVarCorrelation).toBe(1)
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const context = await buildDatasetAnalysisContext(t, fingerprint)
      expect(context.covariates![0]!.profile.outlierRate).toBe(0)
    },
  })
  const changedRoles = { ...t.taskSpec, dataset: { ...(t.taskSpec.dataset as object), observedPastCovariates: [] } }
  expect(
    summarizeTSFTask(changedRoles, { taskID: t.id, projectRoot: tmp.path, workspaceRoot }).datasetProfileWarning,
  ).toMatchObject({ code: "unverified_training_data" })
})

test("frequency diagnostics resolve known periods at arbitrary sample lengths and retain spectral energy", () => {
  for (const length of [96, 125, 256]) {
    const values = Array.from({ length }, (_, index) => Math.sin((2 * Math.PI * 5 * index) / length))
    const powers = spectralPowers(values)
    const strongest = powers.toSorted((a, b) => b.power - a.power)[0]!
    expect(strongest.period).toBeCloseTo(length / 5, 8)
    expect(strongest.power).toBeCloseTo(length ** 2 / 4, 6)
    expect(powers.reduce((sum, item) => sum + item.power, 0)).toBeCloseTo(length ** 2 / 4, 6)
  }
})

test("wide covariate sets have their own bounded sampling and retain named diagnostics in prompts", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "wide.csv")
  const covariates = Array.from({ length: 25 }, (_, index) => `cov_${index}`)
  await Bun.write(
    source,
    [
      "date,OT," + covariates.join(","),
      ...noise(96).map((value, index) =>
        [new Date(Date.UTC(2024, 0, 1) + index * 3600000).toISOString(), value, ...covariates.map(() => value)].join(
          ",",
        ),
      ),
    ].join("\n"),
  )
  const profile = summarizeTSFTask(task(source, covariates).taskSpec).datasetProfile as any
  expect(profile).toMatchObject({
    targetCount: 1,
    observedPastCovariateCount: 25,
    numericColumnCount: 26,
    profiledColumnCount: 21,
  })
  expect(profile.profiledTargetColumns).toEqual(["OT"])
  expect(profile.covariateProfiles).toHaveLength(20)
  expect(profile.profiledCovariateColumns[0]).toBe("cov_0")
  expect(profile.profiledCovariateColumns.at(-1)).toBe("cov_24")
  expect(profile.correlations).toMatchObject({ scope: "target_covariate", evaluatedPairCount: 20 })
  const prompt = compactPromptContext({ datasetProfile: profile }) as any
  expect(prompt.datasetProfileAnalysis.covariates).toHaveLength(20)
  const twiceCompacted = compactPromptContext(prompt) as any
  expect(twiceCompacted.datasetProfileAnalysis.covariates).toHaveLength(20)
})
