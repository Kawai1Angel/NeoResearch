import type { LiteratureProgress } from "../literature-phase-executor"
import { createHash } from "crypto"
import path from "path"
import { LiteratureAgent } from "../literature/literature-agent"
import type { LiteratureExtractionModel } from "../literature/extraction-model"
import { KnowledgeStore } from "../literature/knowledge-store"
import {
  DEFAULT_RETRIEVAL_BUDGETS,
  RetrieveResultSchema,
  type DatasetQuantitativeAnalysis,
  type RetrievalBudgets,
  type RetrievalCandidate,
  type RetrieveResult,
  type RetrieveTaskContext,
} from "./contract"
import { buildRetrievalCandidates, selectBridgeCandidates } from "./candidate-selector"
import { extractDatasetEvidence } from "./dataset-evidence"
import { runLiteratureBridge, type LiteratureAgentBridgeTarget } from "./literature-bridge"
import { buildLocalIndex } from "./local-index-builder"
import { METHOD_CONCEPT_MAPPING_VERSION } from "./method-concept-mapper"
import { PAPER_LANGUAGE_MAPPING_VERSION } from "./paper-language-translator"
import { readQuantitativeReport, readQuantitativeReportValue } from "./quantitative-report-reader"
import { buildConceptTransformations, buildRetrievalIntents } from "./retrieval-intent"
import { RetrieveStore } from "./retrieve-store"
import { mapScientificConcepts, SCIENTIFIC_CONCEPT_MAPPING_VERSION } from "./scientific-concept-mapper"
import { searchBM25 } from "./bm25-search"
import {
  buildTaskEvidence,
  normalizeRetrieveTaskContext,
  taskContextDigest,
  type TaskEvidenceKnowledgeSource,
} from "./task-evidence-builder"
import { TASK_EVIDENCE_MAPPING_VERSION } from "./card-intent-binder"

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`
  return JSON.stringify(value)
}

function digest(value: unknown) { return createHash("sha256").update(stableJson(value)).digest("hex") }

function validatedBudgets(value: Partial<RetrievalBudgets> | undefined): RetrievalBudgets {
  const budgets = { ...DEFAULT_RETRIEVAL_BUDGETS, ...value }
  for (const [name, number] of Object.entries(budgets)) {
    if (!Number.isInteger(number) || number < 1 || number > 1000) throw new Error(`${name} must be an integer between 1 and 1000`)
  }
  return budgets
}

function skippedPapers(candidates: readonly RetrievalCandidate[]) {
  const grouped = new Map<string, { paperID: string; intentIDs: string[]; candidateIDs: string[] }>()
  for (const candidate of candidates.filter((item) => item.decision === "skipped_pdf_unavailable")) {
    const item = grouped.get(candidate.paperID) ?? { paperID: candidate.paperID, intentIDs: [], candidateIDs: [] }
    if (!item.intentIDs.includes(candidate.intentID)) item.intentIDs.push(candidate.intentID)
    if (!item.candidateIDs.includes(candidate.candidateID)) item.candidateIDs.push(candidate.candidateID)
    grouped.set(candidate.paperID, item)
  }
  return [...grouped.values()].map((item) => ({
    ...item,
    status: "skipped_pdf_unavailable" as const,
    acceptedCardIDs: [],
    rejectedCandidateCount: 0,
    warningCount: 0,
  }))
}

export type RetrieveAgentInput = {
  readonly quantitativeReport: DatasetQuantitativeAnalysis | string
  readonly quantitativeReportArtifactID?: string
  readonly force?: boolean
  readonly budgets?: Partial<RetrievalBudgets>
  readonly maxCardsPerPaper?: number
  readonly catalogPath?: string
  readonly taskContext?: RetrieveTaskContext
}

export class RetrieveAgent {
  private readonly retrievalRoot: string
  private readonly store: RetrieveStore
  private readonly literatureAgent: LiteratureAgentBridgeTarget
  private readonly ownedLiteratureAgent?: LiteratureAgent
  private readonly knowledgeSource: TaskEvidenceKnowledgeSource
  private readonly ownedKnowledgeSource?: KnowledgeStore

  constructor(private readonly config: {
    readonly onProgress?: (progress: LiteratureProgress) => Promise<void>
    readonly neoCastRoot: string
    readonly workspaceRoot: string
    readonly retrievalRoot?: string
    readonly knowledgeRoot?: string
    readonly literatureAgent?: LiteratureAgentBridgeTarget
    readonly literatureModel?: LiteratureExtractionModel
    readonly knowledgeSource?: TaskEvidenceKnowledgeSource
  }) {
    this.retrievalRoot = path.resolve(config.retrievalRoot ?? path.join(config.neoCastRoot, ".neo-cast", "literature-retrieval"))
    this.store = new RetrieveStore(this.retrievalRoot)
    if (config.literatureAgent) {
      this.literatureAgent = config.literatureAgent
    } else {
      this.ownedLiteratureAgent = new LiteratureAgent({
        neoCastRoot: config.neoCastRoot,
        workspaceRoot: config.workspaceRoot,
        onProgress: config.onProgress,
        ...(config.literatureModel === undefined ? {} : { model: config.literatureModel }),
        ...(config.knowledgeRoot === undefined ? {} : { knowledgeRoot: config.knowledgeRoot }),
      })
      this.literatureAgent = this.ownedLiteratureAgent
    }
    if (config.knowledgeSource) {
      this.knowledgeSource = config.knowledgeSource
    } else {
      const knowledgeRoot = path.resolve(config.knowledgeRoot ?? path.join(config.neoCastRoot, ".neo-cast", "literature-knowledge"))
      this.ownedKnowledgeSource = new KnowledgeStore(path.join(knowledgeRoot, "knowledge.db"))
      this.knowledgeSource = this.ownedKnowledgeSource
    }
  }

  close() {
    this.ownedKnowledgeSource?.close()
    this.ownedLiteratureAgent?.close()
  }

  async prepare(input: RetrieveAgentInput) {
    const report = typeof input.quantitativeReport === "string"
      ? await readQuantitativeReport(input.quantitativeReport)
      : readQuantitativeReportValue(input.quantitativeReport)
    const budgets = validatedBudgets(input.budgets)
    const normalizedTaskContext = normalizeRetrieveTaskContext(report, input.taskContext)
    const contextDigest = taskContextDigest(normalizedTaskContext.context)
    const maxCardsPerPaper = input.maxCardsPerPaper ?? 30
    if (!Number.isInteger(maxCardsPerPaper) || maxCardsPerPaper < 1 || maxCardsPerPaper > 1000) {
      throw new Error("maxCardsPerPaper must be an integer between 1 and 1000")
    }
    const index = await buildLocalIndex({
      neoCastRoot: this.config.neoCastRoot,
      retrievalRoot: this.retrievalRoot,
      ...(this.config.knowledgeRoot === undefined ? {} : { knowledgeRoot: this.config.knowledgeRoot }),
      ...(input.catalogPath === undefined ? {} : { catalogPath: input.catalogPath }),
    })
    const reportDigest = digest(report)
    const quantitativeReportArtifactID = input.quantitativeReportArtifactID ?? report.sourceArtifactIDs[0] ?? "unregistered_quantitative_report"
    const runDigest = digest({
      reportDigest,
      quantitativeReportArtifactID,
      indexDigest: index.indexDigest,
      budgets,
      taskContextDigest: contextDigest,
      maxCardsPerPaper,
      literatureModel: this.config.literatureModel
        ? {
            model: this.config.literatureModel.modelIdentifier,
            candidatePrompt: this.config.literatureModel.candidatePromptVersion,
            verifierPrompt: this.config.literatureModel.verifierPromptVersion,
          }
        : this.config.literatureAgent ? "external_bridge" : "disabled",
      versions: {
        scientific: SCIENTIFIC_CONCEPT_MAPPING_VERSION,
        method: METHOD_CONCEPT_MAPPING_VERSION,
        paperLanguage: PAPER_LANGUAGE_MAPPING_VERSION,
        taskEvidence: TASK_EVIDENCE_MAPPING_VERSION,
      },
    })
    const retrieveRunID = `retrieve_${runDigest.slice(0, 16)}`
    const datasetEvidence = extractDatasetEvidence(report)
    const mappings = mapScientificConcepts(report, datasetEvidence)
    const transformations = buildConceptTransformations(report, mappings)
    const intents = buildRetrievalIntents(transformations, budgets.maxIntents)
    const candidates = intents.flatMap((intent) => buildRetrievalCandidates(
      intent,
      searchBM25(index, intent, budgets.maxCandidatesPerIntent),
      budgets.maxLiteraturePapersPerIntent,
    ))
    const selectedCandidates = selectBridgeCandidates(candidates, budgets)
    return { report, budgets, normalizedTaskContext, contextDigest, maxCardsPerPaper, index,
      reportDigest, quantitativeReportArtifactID, runDigest, retrieveRunID, datasetEvidence,
      mappings, transformations, intents, candidates, selectedCandidates }
  }

  async run(input: RetrieveAgentInput, prepared?: Awaited<ReturnType<RetrieveAgent["prepare"]>>): Promise<RetrieveResult> {
    const { report, budgets, normalizedTaskContext, contextDigest, maxCardsPerPaper, index,
      reportDigest, quantitativeReportArtifactID, runDigest, retrieveRunID, datasetEvidence,
      transformations, intents, candidates, selectedCandidates } = prepared ?? await this.prepare(input)
    if (!input.force) {
      const existing = await this.store.loadResult(retrieveRunID)
      if (existing) {
        await this.config.onProgress?.({ step: "assemble_evidence", status: "completed", cached: true })
        return existing
      }
    }
    await this.config.onProgress?.({ step: "prepare_intents", status: "completed", counts: { intents: intents.length } })
    await this.config.onProgress?.({ step: "search", status: "completed", counts: { candidates: candidates.length } })
    await this.config.onProgress?.({ step: "select", status: "completed", counts: { papers: selectedCandidates.length } })
    const bridge = await runLiteratureBridge(this.literatureAgent, {
      retrieveRunID,
      candidates: selectedCandidates,
      literatureOptions: {
        includeAgentInference: false,
        requireExactEvidenceSpan: true,
        maxCardsPerPaper,
      },
    })
    const literatureResults = [...bridge.papers, ...skippedPapers(candidates)]
      .toSorted((left, right) => left.paperID.localeCompare(right.paperID))
    await this.config.onProgress?.({ step: "assemble_evidence", status: "running" })
    const taskEvidence = buildTaskEvidence({
      retrieveRunID,
      quantitativeReportArtifactID,
      report,
      taskContext: normalizedTaskContext.context,
      transformations,
      intents,
      candidates,
      literatureResults,
      knowledgeSource: this.knowledgeSource,
      budgets,
    })
    const result = RetrieveResultSchema.parse({
      schemaVersion: "retrieve_result_v2",
      retrieveRunID,
      taskID: report.taskID,
      quantitativeReportArtifactID,
      transformations,
      intents,
      candidates,
      literatureResults,
      taskEvidence,
      summary: {
        intentCount: intents.length,
        bm25CandidateCount: candidates.length,
        literaturePaperCount: bridge.papers.length,
        paperBackedCardCount: bridge.papers.reduce((sum, paper) => sum + paper.acceptedCardIDs.length, 0),
        missingPDFCount: literatureResults.filter((paper) => paper.status === "skipped_pdf_unavailable").length,
        failedPaperCount: literatureResults.filter((paper) => paper.status === "failed").length,
      },
    })
    const status = result.summary.failedPaperCount > 0 || result.summary.missingPDFCount > 0 ? "completed_with_warnings" : "completed"
    await this.store.save({
      result,
      runInput: { ...input, quantitativeReport: report },
      datasetEvidence,
      selectedCandidates,
      manifest: {
        schemaVersion: "retrieve_run_manifest_v1",
        retrieveRunID,
        runDigest,
        reportDigest,
        indexDigest: index.indexDigest,
        mappingVersions: {
          scientific: SCIENTIFIC_CONCEPT_MAPPING_VERSION,
          method: METHOD_CONCEPT_MAPPING_VERSION,
          paperLanguage: PAPER_LANGUAGE_MAPPING_VERSION,
          taskEvidence: TASK_EVIDENCE_MAPPING_VERSION,
        },
        taskContext: normalizedTaskContext.context,
        taskContextDigest: contextDigest,
        taskContextSource: normalizedTaskContext.source,
        llm: {
          used: this.config.literatureModel?.available ?? false,
          managedExternally: this.config.literatureAgent !== undefined,
          ...(this.config.literatureModel === undefined ? {} : {
            model: this.config.literatureModel.modelIdentifier,
            candidatePromptVersion: this.config.literatureModel.candidatePromptVersion,
            verifierPromptVersion: this.config.literatureModel.verifierPromptVersion,
          }),
        },
        queries: intents.map((intent) => ({ intentID: intent.intentID, queryText: intent.paperLanguageQuery.queryText })),
        budgets,
        literatureOptions: { includeAgentInference: false, requireExactEvidenceSpan: true, maxCardsPerPaper },
        literatureRunIDs: bridge.papers.flatMap((paper) => paper.literatureRunID ? [paper.literatureRunID] : []),
        status,
        warnings: literatureResults.filter((paper) => paper.status !== "completed").map((paper) => `${paper.paperID}: ${paper.status}`),
        errors: literatureResults.flatMap((paper) => paper.status === "failed"
          ? [{ paperID: paper.paperID, error: "error" in paper ? paper.error : undefined }]
          : []),
        finishedAt: new Date().toISOString(),
      },
    })
    return result
  }
}
