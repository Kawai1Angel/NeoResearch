import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import type { LiteratureAgentInput, LiteratureAgentResult } from "../../../src/research/literature/contract"
import { card, document, chunk } from "../literature/fixtures"
import { KnowledgeStore } from "../../../src/research/literature/knowledge-store"
import {
  DatasetQuantitativeAnalysisSchema,
  RetrieveAgent,
  AnyRetrieveResultSchema,
  RetrieveResultV2Schema,
  extractDatasetEvidence,
  mapScientificConcepts,
  type DatasetQuantitativeAnalysis,
} from "../../../src/research/retrieve"

function report(overrides: Partial<DatasetQuantitativeAnalysis> = {}): DatasetQuantitativeAnalysis {
  return DatasetQuantitativeAnalysisSchema.parse({
    schemaVersion: "dataset_quantitative_analysis_v1",
    taskID: "researchTask_fixture",
    domain: "electricity_load",
    dataset: {
      samplingFrequency: "hourly",
      targetColumns: ["load"],
      observedPastCovariates: ["temperature"],
      knownFutureCovariates: ["temperature", "holiday"],
      staticCovariates: [],
    },
    forecast: { contextLength: 168, predictionLengths: [24, 168], horizonContextRatio: 1 },
    profile: {
      rowCount: 20_000, missingRate: 0, trendStrength: 0.63, seasonalityStrength: 0.91,
      crossVarCorrelation: 0.52, distributionShift: 0.44, outlierRate: 0.02, irregularIntervalRatio: 0,
    },
    statistics: {
      stationarity: { adfStatistic: -2.31, adfStationary: false, kpssStatistic: 0.71, kpssStationary: false },
      acf: { topLag: 24, topCorrelation: 0.88, pacfTopLag: 24, pacfTopCorrelation: 0.62 },
      decomposition: { period: 24, trendVarianceShare: 0.28, seasonalVarianceShare: 0.57, residualVarianceShare: 0.15 },
      frequency: { dominantPeriod: 24, dominantPowerShare: 0.49, spectralPeaks: [
        { period: 24, powerShare: 0.49, significant: true },
        { period: 168, powerShare: 0.21, significant: true },
      ] },
      changepoint: { index: 12_600, score: 0.68, severity: "medium" },
      crossLag: { source: "temperature", target: "load", lag: 2, correlation: 0.58 },
    },
    warnings: [],
    sourceArtifactIDs: ["researchArtifact_fixture"],
    ...overrides,
  })
}

test("concept mapping requires evidence and never turns method hypotheses into conclusions", () => {
  const value = report()
  const mappings = mapScientificConcepts(value, extractDatasetEvidence(value))
  expect(mappings.map((item) => item.conceptID)).toContain("multiple_seasonalities")
  expect(mappings.map((item) => item.conceptID)).toContain("non_stationarity")
  expect(mappings.every((item) => item.evidence.length > 0)).toBe(true)

  const onePeak = report({
    statistics: {
      ...value.statistics,
      frequency: { dominantPeriod: 24, dominantPowerShare: 0.49, spectralPeaks: [{ period: 24, powerShare: 0.49, significant: true }] },
    },
  })
  expect(mapScientificConcepts(onePeak, extractDatasetEvidence(onePeak)).map((item) => item.conceptID)).not.toContain("multiple_seasonalities")

  const trendOnly = report({
    profile: { ...value.profile, distributionShift: 0 },
    statistics: { ...value.statistics, stationarity: { adfStationary: true, kpssStationary: true } },
  })
  expect(mapScientificConcepts(trendOnly, extractDatasetEvidence(trendOnly)).map((item) => item.conceptID)).not.toContain("non_stationarity")
})

test("RetrieveAgent performs one BM25 recall per intent and bridges each paper once", async () => {
  await using tmp = await tmpdir()
  const neoCastRoot = path.join(tmp.path, "neo_cast")
  const sourceRoot = path.join(neoCastRoot, ".neo-cast", "literature-source")
  const catalogRoot = path.join(sourceRoot, "catalog")
  const pdfRoot = path.join(sourceRoot, "pdfs")
  await mkdir(catalogRoot, { recursive: true })
  await mkdir(pdfRoot, { recursive: true })
  await writeFile(path.join(pdfRoot, "frequency.pdf"), "%PDF-fixture")
  await writeFile(path.join(pdfRoot, "domain.pdf"), "%PDF-fixture")
  const records = [
    {
      paper_id: "paper-frequency", title: "Frequency-domain seasonal patterns forecasting with multiple seasonalities", year: 2025,
      venue: "ICLR", publication_status: "peer_reviewed", identifiers: { doi: "10.fixture/frequency", arxiv: null },
      download: { status: "downloaded", path: "pdfs/frequency.pdf", sha256: null },
    },
    {
      paper_id: "paper-domain", title: "Electricity load benchmark", year: 2024,
      venue: "Journal", publication_status: "peer_reviewed", identifiers: { doi: null, arxiv: null },
      download: { status: "downloaded", path: "pdfs/domain.pdf", sha256: null },
    },
    {
      paper_id: "paper-no-pdf", title: "Multi-periodic frequency-domain time series forecasting", year: 2023,
      venue: "arXiv", publication_status: "preprint", identifiers: { doi: null, arxiv: "2301.00001" },
      download: { status: "no_public_pdf", path: null, sha256: null },
    },
  ]
  await writeFile(path.join(catalogRoot, "papers.jsonl"), `${records.map((item) => JSON.stringify(item)).join("\n")}\n`)

  const calls: LiteratureAgentInput[] = []
  const knowledge = new KnowledgeStore(path.join(neoCastRoot, ".neo-cast", "literature-knowledge", "knowledge.db"))
  const literatureAgent = {
    async run(input: LiteratureAgentInput): Promise<LiteratureAgentResult> {
      calls.push(input)
      knowledge.transaction(() => {
        knowledge.saveDocument({ document: { ...document(), paperID: "paper-frequency" },
          chunks: [chunk({ paperID: "paper-frequency" })], documentPath: path.join(tmp.path, "document.json"), parseStatus: "parsed" })
        knowledge.saveCard(knowledgeCard)
      })
      return {
        agent: "LiteratureAgent",
        runIDs: ["lerun_fixture"],
        processed: [{
          paperID: "paper-frequency", documentID: "doc_fixture", status: "completed",
          acceptedCardIDs: ["kc_123456789abc"], rejectedCandidateCount: 0, warningCount: 0,
          reviewPath: path.join(tmp.path, "review.md"),
        }],
        summary: { paperCount: 1, acceptedCardCount: 1, paperBackedCount: 1, agentInferenceCount: 0, duplicateCount: 0, failedCount: 0 },
      }
    },
  }
  const knowledgeCard = card({
    paperID: "paper-frequency",
    claim: "Frequency-domain modeling captures multiple seasonalities in forecasting.",
    normalizedClaim: { subject: "multiple_seasonalities", predicate: "uses", object: "frequency_domain_modeling" },
    implementation: { recipeConcepts: ["frequency modeling"], registryMappings: ["embedding.frequency"],
      estimatedComplexity: "medium", notes: ["Compare with a time-domain baseline"] },
    mechanism: {
      mechanismID: "mechanism_frequency",
      name: "frequency multi-scale modeling",
      principle: "Model multiple periodic structures in the frequency domain.",
      components: ["spectral peaks", "multi-period aggregation"],
    },
    tags: ["multiple_seasonalities", "frequency_multiscale"],
  })
  const agent = new RetrieveAgent({
    neoCastRoot,
    workspaceRoot: tmp.path,
    literatureAgent,
  })
  const result = await agent.run({ quantitativeReport: report() })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.sources).toEqual([{ kind: "catalog_paper", paperID: "paper-frequency" }])
  expect(calls[0]!.options).toMatchObject({ includeAgentInference: false, requireExactEvidenceSpan: true })
  expect(result.intents).toHaveLength(6)
  expect(result.intents.every((item) => typeof item.paperLanguageQuery.queryText === "string")).toBe(true)
  expect(result.candidates.some((item) => item.paperID === "paper-no-pdf" && item.decision === "skipped_pdf_unavailable")).toBe(true)
  expect(result.candidates.some((item) => item.paperID === "paper-domain" && item.decision === "domain_only" && item.evidenceLevel === "metadata_only")).toBe(true)
  expect(result.literatureResults.find((item) => item.paperID === "paper-frequency")?.acceptedCardIDs).toEqual(["kc_123456789abc"])
  expect(result.literatureResults.find((item) => item.paperID === "paper-frequency")!.intentIDs.length).toBeGreaterThan(1)
  expect(result.summary.paperBackedCardCount).toBe(1)
  expect(result.schemaVersion).toBe("retrieve_result_v2")
  const { taskEvidence: _bundle, schemaVersion: _version, ...legacy } = result
  const old = { ...legacy, schemaVersion: "retrieve_result_v1" }
  expect(AnyRetrieveResultSchema.safeParse(old).success).toBe(true)
  expect(RetrieveResultV2Schema.safeParse(old).success).toBe(false)
  expect(result.taskEvidence.schemaVersion).toBe("task_evidence_bundle_v1")
  expect(result.taskEvidence.entries[0]?.cardID).toBe("kc_123456789abc")
  const runRoot = path.join(neoCastRoot, ".neo-cast", "literature-retrieval", "runs", result.retrieveRunID)
  expect(JSON.parse(await readFile(path.join(runRoot, "task_evidence_bundle.json"), "utf8"))).toEqual(result.taskEvidence)
  expect(await readFile(path.join(runRoot, "report.md"), "utf8")).toContain("kc_123456789abc")
  expect(await readFile(path.join(runRoot, "task_evidence_excluded.jsonl"), "utf8")).toBeDefined()
  const repeated = await agent.run({ quantitativeReport: report() })
  expect(repeated.retrieveRunID).toBe(result.retrieveRunID)
  expect(calls).toHaveLength(1)
  const reRegistered = await agent.run({ quantitativeReport: report(), quantitativeReportArtifactID: "artifact_new" })
  expect(reRegistered.retrieveRunID).not.toBe(result.retrieveRunID)
  expect(reRegistered.taskEvidence.quantitativeReportArtifactID).toBe("artifact_new")
  const differentContext = await agent.run({ quantitativeReport: report(), taskContext: {
    taskType: "forecasting", domain: "electricity_load", objective: { probabilistic: true }, constraints: { computeProfile: "low" },
  } })
  expect(differentContext.retrieveRunID).not.toBe(result.retrieveRunID)
  const manifest = JSON.parse(await readFile(path.join(neoCastRoot, ".neo-cast", "literature-retrieval", "runs", differentContext.retrieveRunID, "run_manifest.json"), "utf8"))
  expect(JSON.stringify(manifest)).toContain("research_task")
  expect(knowledge.getCard(knowledgeCard.cardID)).not.toHaveProperty("taskEvidence")
  agent.close()
  knowledge.close()
})

test("RetrieveAgent recalls the classic library independently of the source catalog route", async () => {
  await using tmp = await tmpdir()
  const neoCastRoot = path.join(tmp.path, "neo_cast")
  const catalogRoot = path.join(neoCastRoot, ".neo-cast", "literature-source", "catalog")
  await mkdir(catalogRoot, { recursive: true })
  await writeFile(path.join(catalogRoot, "papers.jsonl"), [
    { paper_id: "source-frequency", title: "Frequency domain forecasting with multiple seasonalities",
      publication_status: "peer_reviewed", identifiers: {}, download: { status: "no_public_pdf" } },
    { paper_id: "classic-patchtst", title: "A Time Series is Worth 64 Words: Long-term Forecasting with Transformers",
      publication_status: "peer_reviewed", identifiers: { arxiv: "2211.14730" }, download: { status: "no_public_pdf" } },
  ].map((item) => JSON.stringify(item)).join("\n") + "\n")
  const agent = new RetrieveAgent({ neoCastRoot, workspaceRoot: tmp.path })
  try {
    const prepared = await agent.prepare({ quantitativeReport: report() })
    expect(prepared.candidates.some((item) => item.paperID === "source-frequency" && item.recallRoute === "source_catalog")).toBe(true)
    expect(prepared.candidates.some((item) => item.paperID === "classic-patchtst" && item.recallRoute === "classic_library")).toBe(true)
    expect(prepared.candidates.every((item) => item.paperID !== "classic-patchtst" || item.recallRoute === "classic_library")).toBe(true)
  } finally {
    agent.close()
  }
})
