import type { LiteratureProgress } from "../literature-phase-executor"
import { createHash } from "crypto"
import path from "path"
import { KNOWLEDGE_V2_VERSIONS } from "../literature/knowledge-v2-contract"
import type { PrincipleModel } from "../literature/principle-model"
import { buildPrincipleTaskEvidence, reviewedPrinciple, type PrincipleKnowledgeSource } from "./principle-evidence"
import { LiteratureAgent } from "../literature/literature-agent"
import { KnowledgeV2Store } from "../literature/knowledge-v2-store"
import {
  DEFAULT_RETRIEVAL_BUDGETS,
  RetrieveResultSchema,
  type DatasetQuantitativeAnalysis,
  type RetrievalBudgets,
  type RetrievalCandidate,
  type RetrieveResult,
  type RetrieveTaskContext,
} from "./contract"
import { buildRetrievalCandidates, CLASSIC_COMPONENT_MAPPING_VERSION, COMPATIBILITY_REVIEW_VERSION, PAPER_SCOPE_SCREEN_VERSION, PDF_IDENTITY_SCREEN_VERSION, selectBridgeCandidates, type ModelRecipeCompatibilityReview } from "./candidate-selector"
import { CLASSIC_LIBRARY_VERSION, CLASSIC_PAPERS, classicPaperName } from "./classic-library"
import { MODEL_RECIPE_SCREEN_VERSION } from "./model-recipe-screen"
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
  normalizeRetrieveTaskContext,
  taskContextDigest,
} from "./task-evidence-builder"
import { TASK_EVIDENCE_MAPPING_VERSION } from "./card-intent-binder"
import { APPLICABILITY_MATCHER_VERSION } from "./applicability-matcher"
import { KNOWLEDGE_RECALL_VERSION, recallKnowledge } from "./knowledge-recall"
import { ARCHITECTURE_KNOWLEDGE_VERSION, architectureKnowledgePrompt } from "./architecture-knowledge"
import { MODEL_CAPABILITIES } from "../model-capabilities"
import { ARCHITECTURE_SELECTION_POLICY } from "./architecture-eligibility"
import { ARCHITECTURE_LIMITS, distillArchitectureKnowledge } from "./architecture-distiller"
import { loadArchitectureCorpus } from "./architecture-corpus"
import { PAPER_SELECTION_VERSION } from "./candidate-selector"

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`
  return JSON.stringify(value)
}

function digest(value: unknown) { return createHash("sha256").update(stableJson(value)).digest("hex") }

function knowledgeSnapshot(source: PrincipleKnowledgeSource) {
  const cards = (source.listCards?.() ?? []).map(reviewedPrinciple).filter((card) => !!card).toSorted((a, b) => a.knowledgeID.localeCompare(b.knowledgeID))
  const hash = digest({ versions: KNOWLEDGE_V2_VERSIONS, cards })
  return { cards, hash }
}

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
  readonly compatibilityReviews?: readonly ModelRecipeCompatibilityReview[]
}

export class RetrieveAgent {
  private readonly retrievalRoot: string
  private readonly store: RetrieveStore
  private readonly literatureAgent: LiteratureAgentBridgeTarget
  private readonly ownedLiteratureAgent?: LiteratureAgent
  private readonly knowledgeSource: PrincipleKnowledgeSource
  private readonly ownedKnowledgeSource?: KnowledgeV2Store

  constructor(private readonly config: {
    readonly onProgress?: (progress: LiteratureProgress) => Promise<void>
    readonly neoCastRoot: string
    readonly workspaceRoot: string
    readonly retrievalRoot?: string
    readonly knowledgeRoot?: string
    readonly literatureAgent?: LiteratureAgentBridgeTarget
    readonly principleModel?: PrincipleModel
    readonly signal?: AbortSignal
    readonly knowledgeSource?: PrincipleKnowledgeSource
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
        principleModel: config.principleModel, signal: config.signal,
        ...(config.knowledgeRoot === undefined ? {} : { knowledgeRoot: config.knowledgeRoot }),
      })
      this.literatureAgent = this.ownedLiteratureAgent
    }
    if (config.knowledgeSource) {
      this.knowledgeSource = config.knowledgeSource
    } else {
      const knowledgeRoot = path.resolve(config.knowledgeRoot ?? path.join(config.neoCastRoot, ".neo-cast", "literature-knowledge"))
      this.ownedKnowledgeSource = new KnowledgeV2Store(path.join(knowledgeRoot, "knowledge.db"))
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
    const classicDocuments = index.documents.filter((paper) => classicPaperName(paper) !== undefined)
    const sourceDocuments = index.documents.filter((paper) => classicPaperName(paper) === undefined)
    const reportDigest = digest(report)
    const quantitativeReportArtifactID = input.quantitativeReportArtifactID ?? report.sourceArtifactIDs[0] ?? "unregistered_quantitative_report"
    const { cards: storedCards, hash: knowledgeDigest } = knowledgeSnapshot(this.knowledgeSource)
    const architectureCorpus = await loadArchitectureCorpus({ activeCards: storedCards,
      neoCastRoot: this.config.neoCastRoot, knowledgeRoot: this.config.knowledgeRoot })
    const runDigest = digest({
      reportDigest,
      quantitativeReportArtifactID,
      indexDigest: index.indexDigest,
      knowledgeDigest,
      architectureKnowledge: { version: ARCHITECTURE_KNOWLEDGE_VERSION, corpusDigest: architectureCorpus.digest, limits: ARCHITECTURE_LIMITS,
        selectionPolicy: ARCHITECTURE_SELECTION_POLICY, modelCapabilities: MODEL_CAPABILITIES,
        prompts: (["recall", "extract", "review", "revise", "curate"] as const).map(architectureKnowledgePrompt) },
      paperSelection: PAPER_SELECTION_VERSION,
      classicLibrary: { version: CLASSIC_LIBRARY_VERSION, papers: CLASSIC_PAPERS },
      classicComponentMapping: CLASSIC_COMPONENT_MAPPING_VERSION,
      compatibilityReview: { version: COMPATIBILITY_REVIEW_VERSION, reviews: input.compatibilityReviews ?? [] },
      pdfIdentityScreen: PDF_IDENTITY_SCREEN_VERSION,
      paperScopeScreen: PAPER_SCOPE_SCREEN_VERSION,
      modelRecipeScreen: MODEL_RECIPE_SCREEN_VERSION,
      budgets,
      taskContextDigest: contextDigest,
      maxCardsPerPaper,
      literatureModel: this.config.principleModel
        ? { model: this.config.principleModel.modelIdentifier, ...KNOWLEDGE_V2_VERSIONS }
        : this.config.literatureAgent ? "external_bridge" : "disabled",
      versions: {
        evidenceValidation: KNOWLEDGE_V2_VERSIONS.verifier,
        scientific: SCIENTIFIC_CONCEPT_MAPPING_VERSION,
        method: METHOD_CONCEPT_MAPPING_VERSION,
        paperLanguage: PAPER_LANGUAGE_MAPPING_VERSION,
        taskEvidence: TASK_EVIDENCE_MAPPING_VERSION,
        applicability: APPLICABILITY_MATCHER_VERSION,
        knowledgeRecall: KNOWLEDGE_RECALL_VERSION,
        knowledgeCard: KNOWLEDGE_V2_VERSIONS,
      },
    })
    const retrieveRunID = `retrieve_${runDigest.slice(0, 16)}`
    const datasetEvidence = extractDatasetEvidence(report)
    const mappings = mapScientificConcepts(report, datasetEvidence)
    const transformations = buildConceptTransformations(report, mappings)
    const intents = buildRetrievalIntents(transformations, budgets.maxIntents)
    const recalled = recallKnowledge({ cards: storedCards, report, taskContext: normalizedTaskContext.context,
      transformations, intents, budgets, compatibilityReviews: input.compatibilityReviews })
    const candidates = intents.flatMap((intent) => buildRetrievalCandidates(
      intent,
      [
        ...searchBM25({ documents: sourceDocuments }, intent, budgets.maxCandidatesPerIntent)
          .map((result) => ({ ...result, recallRoute: "source_catalog" as const })),
        ...searchBM25({ documents: classicDocuments }, intent, Math.max(budgets.maxCandidatesPerIntent, classicDocuments.length))
          .map((result) => ({ ...result, recallRoute: "classic_library" as const })),
      ],
      budgets.maxLiteraturePapersPerIntent,
      normalizedTaskContext.context.objective.probabilistic,
      input.compatibilityReviews,
      input.force ? new Set() : recalled.coveredPaperIntents,
    ))
    const selectedCandidates = selectBridgeCandidates(candidates, budgets)
    candidates.push(...recalled.candidates)
    return { report, budgets, normalizedTaskContext, contextDigest, maxCardsPerPaper, index,
      reportDigest, quantitativeReportArtifactID, runDigest, retrieveRunID, datasetEvidence,
      mappings, transformations, intents, candidates, selectedCandidates, recalled, knowledgeDigest, architectureCorpus }
  }

  async run(input: RetrieveAgentInput, prepared?: Awaited<ReturnType<RetrieveAgent["prepare"]>>): Promise<RetrieveResult> {
    const { report, budgets, normalizedTaskContext, contextDigest, maxCardsPerPaper, index,
      reportDigest, quantitativeReportArtifactID, runDigest, retrieveRunID, datasetEvidence,
      transformations, intents, candidates, selectedCandidates, recalled, knowledgeDigest, architectureCorpus } = prepared ?? await this.prepare(input)
    if (prepared && knowledgeSnapshot(this.knowledgeSource).hash !== knowledgeDigest) {
      throw new Error("Knowledge snapshot changed after retrieval preparation; prepare again before using cached evidence.")
    }
    this.config.signal?.throwIfAborted()
    if (!input.force) {
      const existing = await this.store.loadResult(retrieveRunID)
      if (existing && existing.taskEvidence.schemaVersion === "task_evidence_bundle_v2" && (existing.taskEvidence.architectureKnowledge?.status === "completed" ||
        (!this.config.principleModel && existing.taskEvidence.architectureKnowledge?.status === "unavailable"))) {
        await this.config.onProgress?.({ step: "assemble_evidence", status: "completed", cached: true })
        return existing
      }
    }
    await this.config.onProgress?.({ step: "prepare_intents", status: "completed", counts: { intents: intents.length } })
    await this.config.onProgress?.({ step: "search", status: "completed", counts: { candidates: candidates.length,
      unique_papers: new Set(candidates.map((c) => c.paperID)).size, architecture_pool_cards: architectureCorpus.cards.length } })
    await this.config.onProgress?.({ step: "select", status: "completed", counts: { new_papers: selectedCandidates.length,
      reused_papers: recalled.papers.length, reused_cards: new Set(recalled.papers.flatMap((p) => p.acceptedCardIDs)).size } })
    const bridge = await runLiteratureBridge(this.literatureAgent, {
      retrieveRunID,
      candidates: selectedCandidates,
      literatureOptions: {
        force: input.force,
        includeAgentInference: false,
        requireExactEvidenceSpan: true,
        maxCardsPerPaper,
      },
    })
    // A completed extraction supersedes the pre-run snapshot, including a valid zero-card result.
    const completedPapers = new Set(bridge.papers.filter((paper) => paper.status === "completed").map((paper) => paper.paperID))
    const reused = recalled.papers.filter((paper) => !completedPapers.has(paper.paperID))
    const recalledPapers = new Set(reused.map((paper) => paper.paperID))
    const literatureResults = [...bridge.papers, ...reused,
      ...skippedPapers(candidates).filter((paper) => !recalledPapers.has(paper.paperID))]
      .toSorted((left, right) => left.paperID.localeCompare(right.paperID))
    await this.config.onProgress?.({ step: "assemble_evidence", status: "running" })
    const sourceEvidence = buildPrincipleTaskEvidence({
      paperTitles: Object.fromEntries(index.documents.map((document) => [document.paperID, document.title])),
      retrieveRunID,
      quantitativeReportArtifactID,
      report,
      taskContext: normalizedTaskContext.context,
      transformations,
      intents,
      candidates,
      literatureResults,
      knowledgeSource: this.knowledgeSource,
      compatibilityReviews: input.compatibilityReviews,
      budgets,
    })
    // Broad source reading precedes any downstream use of the old intent-limited selection.
    const corpusCards = new Map(architectureCorpus.cards.filter((c) => architectureCorpus.historicalCardIDs.includes(c.knowledgeID)).map((c) => [c.knowledgeID, c]))
    const currentCards = knowledgeSnapshot(this.knowledgeSource).cards
    for (const card of currentCards) corpusCards.set(card.knowledgeID, card)
    const historicalCardIDs = architectureCorpus.historicalCardIDs.filter((id) => !currentCards.some((c) => c.knowledgeID === id))
    const architectureKnowledge = await distillArchitectureKnowledge({
      corpus: { cards: [...corpusCards.values()], historicalCardIDs, warnings: architectureCorpus.warnings,
        digest: digest({ cards: [...corpusCards.values()], historicalCardIDs }) },
      model: this.config.principleModel, task: { quantitativeReport: report, taskContext: normalizedTaskContext.context },
      datasetEvidencePaths: datasetEvidence.map((e) => e.path), maxDecisions: budgets.maxTaskEvidenceEntries,
      auditRoot: path.join(this.store.runRoot(retrieveRunID), "architecture-audit"),
      signal: this.config.signal, onProgress: this.config.onProgress,
    })
    const taskEvidence = { ...sourceEvidence, architectureKnowledge,
      readiness: !architectureKnowledge.decisions.length ? "ready_data_only" as const
        : architectureKnowledge.status === "partial" || architectureKnowledge.decisions.some((d) => d.taskFit === "conditional")
          ? "partial_evidence" as const : "ready_with_evidence" as const }
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
        bm25CandidateCount: candidates.filter((item) => item.recallRoute !== "knowledge_store").length,
        literaturePaperCount: bridge.papers.length,
        architectureDecisionCount: architectureKnowledge.decisions.length,
        architectureSourceCardCount: architectureKnowledge.sourceCards.length,
        paperBackedCardCount: new Set(literatureResults.flatMap((paper) => paper.acceptedCardIDs)).size,
        missingPDFCount: literatureResults.filter((paper) => paper.status === "skipped_pdf_unavailable").length,
        failedPaperCount: literatureResults.filter((paper) => paper.status === "failed").length,
      },
    })
    const status = result.summary.failedPaperCount > 0 || result.summary.missingPDFCount > 0 || architectureKnowledge.status !== "completed" ? "completed_with_warnings" : "completed"
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
        knowledgeDigest,
        architectureKnowledge: { version: architectureKnowledge.version, status: architectureKnowledge.status,
          corpusDigest: architectureKnowledge.corpusDigest, consideredCardCount: architectureKnowledge.consideredCardCount,
          readCardCount: architectureKnowledge.readCardCount, decisionCount: architectureKnowledge.decisions.length },
        reusedKnowledge: recalled.papers,
        classicLibraryVersion: CLASSIC_LIBRARY_VERSION,
        classicLibraryPapers: CLASSIC_PAPERS,
        modelRecipeScreenVersion: MODEL_RECIPE_SCREEN_VERSION,
        mappingVersions: {
          scientific: SCIENTIFIC_CONCEPT_MAPPING_VERSION,
          method: METHOD_CONCEPT_MAPPING_VERSION,
          paperLanguage: PAPER_LANGUAGE_MAPPING_VERSION,
          taskEvidence: TASK_EVIDENCE_MAPPING_VERSION,
          applicability: APPLICABILITY_MATCHER_VERSION,
          knowledgeRecall: KNOWLEDGE_RECALL_VERSION,
          knowledgeCard: KNOWLEDGE_V2_VERSIONS,
        },
        taskContext: normalizedTaskContext.context,
        taskContextDigest: contextDigest,
        taskContextSource: normalizedTaskContext.source,
        llm: {
          used: !!this.config.principleModel,
          managedExternally: this.config.literatureAgent !== undefined,
          ...(this.config.principleModel === undefined ? {} : { model: this.config.principleModel.modelIdentifier, ...KNOWLEDGE_V2_VERSIONS }),
        },
        queries: intents.map((intent) => ({ intentID: intent.intentID, queryText: intent.paperLanguageQuery.queryText })),
        budgets,
        literatureOptions: { includeAgentInference: false, requireExactEvidenceSpan: true, maxCardsPerPaper },
        literatureRunIDs: bridge.papers.flatMap((paper) => paper.literatureRunID ? [paper.literatureRunID] : []),
        status,
        warnings: [...literatureResults.filter((paper) => !["completed", "reused_knowledge"].includes(paper.status)).map((paper) => `${paper.paperID}: ${paper.status}`), ...architectureKnowledge.warnings],
        errors: literatureResults.flatMap((paper) => paper.status === "failed"
          ? [{ paperID: paper.paperID, error: "error" in paper ? paper.error : undefined }]
          : []),
        finishedAt: new Date().toISOString(),
      },
    })
    return result
  }
}
