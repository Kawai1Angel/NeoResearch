import { hasCompleteMechanism } from "../literature/contract"
import { createHash } from "crypto"
import taskEvidenceConfig from "./config/tsf-task-evidence.v1.json" with { type: "json" }
import type { CardRelation, KnowledgeCard } from "../literature/contract"
import { matchApplicability } from "./applicability-matcher"
import { bindCardToIntents } from "./card-intent-binder"
import {
  ExcludedTaskEvidenceSchema,
  RetrieveTaskContextSchema,
  TaskEvidenceBundleSchema,
  TaskEvidenceEntrySchema,
  type ConceptTransformation,
  type DatasetQuantitativeAnalysis,
  type ExcludedTaskEvidence,
  type RetrievalBudgets,
  type RetrievalCandidate,
  type RetrievalIntent,
  type RetrieveLiteratureBridgeResult,
  type RetrieveTaskContext,
  type TaskEvidenceBundle,
  type TaskEvidenceEntry,
  type TaskEvidenceRole,
} from "./contract"

export type TaskEvidenceKnowledgeSource = {
  getCard(cardID: string): KnowledgeCard | undefined
  listRelations(): CardRelation[]
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function sha256(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex")
}

function unique(values: readonly string[]) {
  return [...new Set(values)].toSorted()
}

export function normalizeRetrieveTaskContext(
  report: DatasetQuantitativeAnalysis,
  value?: RetrieveTaskContext,
): { context: RetrieveTaskContext; source: "research_task" | "report_fallback" } {
  if (value !== undefined) return { context: RetrieveTaskContextSchema.parse(value), source: "research_task" }
  return {
    context: RetrieveTaskContextSchema.parse({
      taskType: "forecasting",
      domain: report.domain,
      objective: { probabilistic: false },
      constraints: { computeProfile: "unknown" },
    }),
    source: "report_fallback",
  }
}

export function taskContextDigest(context: RetrieveTaskContext) {
  return sha256(RetrieveTaskContextSchema.parse(context))
}

function rolesFor(card: KnowledgeCard): TaskEvidenceRole[] {
  const role: Record<KnowledgeCard["cardType"], TaskEvidenceRole> = {
    model_mechanism: "supports_mechanism",
    empirical_finding: "supports_applicability",
    applicability_rule: "supports_applicability",
    limitation: "warns_limitation",
    evaluation_protocol: "defines_evaluation",
    implementation_hint: "suggests_implementation",
    domain_prior: "supports_applicability",
  }
  return [card.status === "contradicted" ? "contradicts" : role[card.cardType]]
}

function exclude(cardID: string, paperID: string, reason: ExcludedTaskEvidence["reasons"][number], detail: string) {
  return ExcludedTaskEvidenceSchema.parse({ cardID, paperID, reasons: [reason], detail: [detail] })
}

function statusRank(status: TaskEvidenceEntry["cardStatus"]) {
  return status === "corroborated" ? 3 : status === "paper_backed" ? 2 : 1
}

function entryQualityRank(left: TaskEvidenceEntry, right: TaskEvidenceEntry) {
  return right.relevance.score - left.relevance.score ||
    Number(right.relevance.reasons.some((reason) => reason.startsWith("refines:"))) -
      Number(left.relevance.reasons.some((reason) => reason.startsWith("refines:"))) ||
    statusRank(right.cardStatus) - statusRank(left.cardStatus) ||
    right.evidenceRefs.filter((item) => item.directness === "direct" && item.verification === "exact_span").length -
      left.evidenceRefs.filter((item) => item.directness === "direct" && item.verification === "exact_span").length ||
    right.confidence.transferability - left.confidence.transferability
}

function entryRank(left: TaskEvidenceEntry, right: TaskEvidenceEntry) {
  return entryQualityRank(left, right) || left.paperID.localeCompare(right.paperID) ||
    left.cardID.localeCompare(right.cardID)
}

function betterDuplicate(left: TaskEvidenceEntry, right: TaskEvidenceEntry) {
  const ranked = [left, right].toSorted((a, b) =>
    statusRank(b.cardStatus) - statusRank(a.cardStatus) ||
    b.evidenceRefs.filter((item) => item.directness === "direct" && item.verification === "exact_span").length -
      a.evidenceRefs.filter((item) => item.directness === "direct" && item.verification === "exact_span").length ||
    b.cardRevision - a.cardRevision ||
    entryRank(a, b),
  )
  return ranked[0]!
}

function addRole(entry: TaskEvidenceEntry, role: TaskEvidenceRole): TaskEvidenceEntry {
  if (entry.roles.includes(role)) return entry
  return TaskEvidenceEntrySchema.parse({ ...entry, roles: unique([...entry.roles, role]) })
}

function coversIntent(entry: TaskEvidenceEntry, intent: RetrievalIntent) {
  return entry.linkage.intentIDs.includes(intent.intentID) &&
    (!/how|mechanism|address/i.test(intent.question) || entry.roles.includes("supports_mechanism"))
}

function selectEntries(input: {
  readonly entries: readonly TaskEvidenceEntry[]
  readonly intents: readonly RetrievalIntent[]
  readonly budgets: RetrievalBudgets
}) {
  const selected: TaskEvidenceEntry[] = []
  const selectedCards = new Set<string>()
  const perIntent = new Map<string, number>()
  const papers = new Set<string>()
  const add = (entry: TaskEvidenceEntry) => {
    if (selectedCards.has(entry.cardID) || selected.length >= input.budgets.maxTaskEvidenceEntries) return false
    if (entry.linkage.intentIDs.some((intentID) => (perIntent.get(intentID) ?? 0) >= input.budgets.maxTaskEvidencePerIntent)) return false
    selected.push(entry)
    selectedCards.add(entry.cardID)
    papers.add(entry.paperID)
    for (const intentID of entry.linkage.intentIDs) perIntent.set(intentID, (perIntent.get(intentID) ?? 0) + 1)
    return true
  }
  const rankRemaining = () => input.entries.filter((entry) => !selectedCards.has(entry.cardID)).toSorted((left, right) => {
    const leftDiversity = papers.has(left.paperID) ? 0 : 1
    const rightDiversity = papers.has(right.paperID) ? 0 : 1
    return entryQualityRank(left, right) ||
      rightDiversity - leftDiversity || entryRank(left, right)
  })
  const orderedIntents = [...input.intents].toSorted((a, b) => Number(b.mustCover) - Number(a.mustCover) || b.priority - a.priority || a.intentID.localeCompare(b.intentID))
  for (const intent of orderedIntents) {
    if (selected.some((entry) => coversIntent(entry, intent))) continue
    for (const candidate of rankRemaining().filter((entry) => coversIntent(entry, intent))) {
      if (add(candidate)) break
    }
  }
  for (const intent of orderedIntents) {
    const warnings = rankRemaining().filter((entry) =>
      entry.linkage.intentIDs.includes(intent.intentID) &&
      (entry.roles.includes("warns_limitation") || entry.roles.includes("contradicts")) &&
      !selectedCards.has(entry.cardID),
    )
    for (const warning of warnings) {
      if (add(warning)) break
    }
  }
  while (rankRemaining().some((entry) => add(entry))) {
    // Re-rank after each selection so paper diversity reflects the current set.
  }
  return {
    entries: selected.toSorted((left, right) => entryRank(left, right)),
    omitted: input.entries.filter((entry) => !selectedCards.has(entry.cardID)),
  }
}

function gapReason(input: {
  readonly intent: RetrievalIntent
  readonly candidates: readonly RetrievalCandidate[]
  readonly literatureResults: readonly RetrieveLiteratureBridgeResult["papers"][number][]
  readonly acceptedIDs: ReadonlySet<string>
  readonly eligibleBeforeBudget: readonly TaskEvidenceEntry[]
  readonly selected: readonly TaskEvidenceEntry[]
}) {
  const intentCandidates = input.candidates.filter((item) => item.intentID === input.intent.intentID)
  if (intentCandidates.length === 0) return "no_candidate" as const
  if (!intentCandidates.some((item) => item.localPDF)) return "no_local_pdf" as const
  const papers = input.literatureResults.filter((item) => item.intentIDs.includes(input.intent.intentID))
  if (papers.some((item) => item.status === "failed" || item.status === "partial") &&
      !input.eligibleBeforeBudget.some((entry) => entry.linkage.intentIDs.includes(input.intent.intentID))) {
    return "literature_failed" as const
  }
  if (!papers.some((paper) => paper.acceptedCardIDs.some((cardID) => input.acceptedIDs.has(cardID)))) return "no_accepted_card" as const
  if (!input.eligibleBeforeBudget.some((entry) => entry.linkage.intentIDs.includes(input.intent.intentID))) return "no_eligible_card" as const
  if (!input.selected.some((entry) => entry.linkage.intentIDs.includes(input.intent.intentID))) return "selection_budget" as const
  return undefined
}

export function buildTaskEvidence(input: {
  readonly componentRelations?: TaskEvidenceBundle["mechanismRelations"]
  readonly consolidation?: TaskEvidenceBundle["consolidation"]
  readonly paperTitles?: Readonly<Record<string, string>>
  readonly semanticGroups?: readonly { cardIDs: readonly string[]; rationale: string }[]
  readonly retrieveRunID: string
  readonly quantitativeReportArtifactID: string
  readonly report: DatasetQuantitativeAnalysis
  readonly taskContext: RetrieveTaskContext
  readonly transformations: readonly ConceptTransformation[]
  readonly intents: readonly RetrievalIntent[]
  readonly candidates: readonly RetrievalCandidate[]
  readonly literatureResults: readonly RetrieveLiteratureBridgeResult["papers"][number][]
  readonly knowledgeSource: TaskEvidenceKnowledgeSource
  readonly budgets: RetrievalBudgets
}): TaskEvidenceBundle {
  const contextDigest = taskContextDigest(input.taskContext)
  const transformationByID = new Map(input.transformations.map((item) => [item.transformationID, item]))
  const candidateByPaperIntent = new Map<string, RetrievalCandidate[]>()
  for (const candidate of input.candidates) {
    const key = `${candidate.paperID}\0${candidate.intentID}`
    candidateByPaperIntent.set(key, [...(candidateByPaperIntent.get(key) ?? []), candidate])
  }
  const acceptedIDs = new Set<string>()
  const loadedIDs = new Set<string>()
  const acceptedPaper = new Map<string, string>()
  const excluded: ExcludedTaskEvidence[] = []
  const eligible: TaskEvidenceEntry[] = []

  for (const literature of input.literatureResults.toSorted((left, right) => left.paperID.localeCompare(right.paperID))) {
    for (const cardID of unique(literature.acceptedCardIDs)) {
      acceptedIDs.add(cardID)
      const priorPaper = acceptedPaper.get(cardID)
      if (priorPaper && priorPaper !== literature.paperID) {
        throw new Error(`Accepted card ${cardID} is referenced by multiple papers: ${priorPaper}, ${literature.paperID}`)
      }
      acceptedPaper.set(cardID, literature.paperID)
      const card = input.knowledgeSource.getCard(cardID)
      if (!card) {
        excluded.push(exclude(cardID, literature.paperID, "card_not_found", "Accepted card was not found in KnowledgeStore."))
        continue
      }
      if (card.paperID !== literature.paperID) {
        excluded.push(exclude(cardID, literature.paperID, "paper_mismatch", `KnowledgeCard paperID is ${card.paperID}.`))
        continue
      }
      loadedIDs.add(cardID)
      if (card.status !== "paper_backed" && card.status !== "corroborated" && card.status !== "contradicted") {
        excluded.push(exclude(cardID, card.paperID, "status_not_eligible", `Card status ${card.status} is not task-evidence eligible.`))
        continue
      }
      const directExact = card.evidence.filter((item) =>
        item.directness === "direct" && item.verification === "exact_span" && item.evidenceType !== "agent_inference",
      )
      if (directExact.length === 0) {
        excluded.push(exclude(cardID, card.paperID, "no_direct_exact_evidence", "No direct exact-span paper evidence was available."))
        continue
      }
      if (card.cardType === "model_mechanism" && !hasCompleteMechanism(card)) {
        excluded.push(exclude(cardID, card.paperID, "mechanism_incomplete", "Legacy/incomplete mechanism requires source-based re-extraction."))
        continue
      }
      if (card.cardType === "model_mechanism" && !["evidence_verifier_v3", "evidence_verifier_v4"].includes(card.provenance.verifierPromptVersion ?? "")) {
        excluded.push(exclude(cardID, card.paperID, "card_validation_required", "Mechanism has not passed the current typed verification rule."))
        continue
      }
      const bindings = bindCardToIntents({
        card,
        intentIDs: unique(input.candidates.filter((candidate) => candidate.paperID === card.paperID).map((candidate) => candidate.intentID)),
        intents: input.intents,
        transformations: input.transformations,
        taskType: input.taskContext.taskType,
        domain: input.taskContext.domain,
      })
      if (bindings.length === 0) {
        excluded.push(exclude(cardID, card.paperID, "no_intent_match", "No scientific/data-feature or method/mechanism intent match passed the threshold."))
        continue
      }
      const intentIDs = unique(bindings.map((item) => item.intentID))
      const transformations = intentIDs.map((intentID) => {
        const intent = input.intents.find((item) => item.intentID === intentID)
        if (!intent) throw new Error(`Card binding references an unknown intent: ${intentID}`)
        const transformation = transformationByID.get(intent.transformationID)
        if (!transformation) throw new Error(`Card binding references an unknown transformation: ${intent.transformationID}`)
        return transformation
      })
      const conceptIDs = unique(transformations.flatMap((item) => item.scientificConcepts.map((concept) => concept.conceptID)))
      const applicability = matchApplicability({ card, report: input.report, taskContext: input.taskContext, conceptIDs })
      let roles = rolesFor(card)
      if (applicability.status === "conflicted") {
        roles = unique([
          ...roles.filter((role) => role === "warns_limitation" || role === "contradicts"),
          "warns_limitation",
        ]) as TaskEvidenceRole[]
      }
      const candidateIDs = unique(intentIDs.flatMap((intentID) =>
        (candidateByPaperIntent.get(`${card.paperID}\0${intentID}`) ?? []).map((candidate) => candidate.candidateID),
      ))
      if (intentIDs.some((intentID) => !candidateByPaperIntent.has(`${card.paperID}\0${intentID}`))) {
        throw new Error(`No retrieval candidate provenance exists for ${cardID}`)
      }
      eligible.push(TaskEvidenceEntrySchema.parse({
        evidenceEntryID: `te_${sha256({ cardID, revision: card.revision, intentIDs, contextDigest }).slice(0, 16)}`,
        cardID,
        cardRevision: card.revision,
        paperID: card.paperID,
        cardType: card.cardType,
        cardStatus: card.status,
        claim: card.claim,
        paperTitle: input.paperTitles?.[card.paperID],
        problem: card.problem,
        mechanism: card.mechanism,
        linkage: {
          intentIDs,
          candidateIDs,
          transformationIDs: unique(transformations.map((item) => item.transformationID)),
          conceptIDs,
          methodConceptIDs: unique(transformations.flatMap((item) => item.methodConcepts.map((concept) => concept.conceptID))),
          datasetEvidencePaths: unique(transformations.flatMap((item) => item.datasetEvidence.map((evidence) => evidence.path))),
        },
        roles,
        relevance: {
          score: Math.max(...bindings.map((item) => item.score)),
          matchedTerms: unique(bindings.flatMap((item) => item.matchedTerms)),
          reasons: unique(bindings.flatMap((item) => item.reasons)),
        },
        applicability,
        evidenceRefs: card.evidence
          .filter((item) => item.evidenceType !== "agent_inference")
          .map((item) => ({
            evidenceID: item.evidenceID,
            evidenceSpan: item.evidenceSpan,
            chunkID: item.chunkID,
            section: item.section,
            pageStart: item.pageStart,
            pageEnd: item.pageEnd,
            directness: item.directness,
            verification: item.verification,
          })),
        limitations: card.limitations,
        ...(card.implementation === undefined ? {} : { implementation: card.implementation }),
        confidence: card.confidence,
      }))
    }
  }

  if (acceptedIDs.size > 0 && loadedIDs.size === 0) {
    throw new Error("All accepted KnowledgeCard provenance is unavailable or corrupt")
  }

  const entryByCard = new Map(eligible.map((entry) => [entry.cardID, entry]))
  const duplicateLosers = new Set<string>()
  const relations = input.knowledgeSource.listRelations()
    .filter((relation) => entryByCard.has(relation.sourceCardID) && entryByCard.has(relation.targetCardID))
    .toSorted((left, right) => left.relationID.localeCompare(right.relationID))
  for (const relation of relations.filter((item) => item.relationType === "contradicts")) {
    const source = entryByCard.get(relation.sourceCardID)
    const target = entryByCard.get(relation.targetCardID)
    if (source) entryByCard.set(source.cardID, addRole(source, "contradicts"))
    if (target) entryByCard.set(target.cardID, addRole(target, "contradicts"))
  }
  for (const relation of relations.filter((item) => item.relationType === "supports" || item.relationType === "refines")) {
    const source = entryByCard.get(relation.sourceCardID)!
    entryByCard.set(source.cardID, {
      ...source,
      relevance: { ...source.relevance, reasons: unique([
        ...source.relevance.reasons,
        `${relation.relationType}:${relation.targetCardID} (${relation.relationID}): ${relation.rationale}`,
      ]) },
    })
  }
  // Merge equivalent operations before quota selection, never parent/component relations.
  // Preserve canonical cards and their revision-specific source evidence in the handoff.
  const groups = [...(input.semanticGroups ?? []), ...relations
    .filter((item) => item.relationType === "duplicates")
    .map((item) => ({ cardIDs: [item.sourceCardID, item.targetCardID], rationale: item.rationale }))]
  const canonical = new Map<string, string>()
  const resolve = (id: string): string => canonical.has(id) ? resolve(canonical.get(id)!) : id
  for (const group of groups) {
    const members = unique(group.cardIDs.map(resolve)).map((id) => entryByCard.get(id))
      .filter((entry): entry is TaskEvidenceEntry => !!entry && !duplicateLosers.has(entry.cardID))
    if (members.length < 2) continue
    const winner = members.reduce(betterDuplicate)
    for (const member of members) {
      if (member.cardID === winner.cardID || member.paperID !== winner.paperID || member.cardType !== winner.cardType) continue
      const a = input.knowledgeSource.getCard(member.cardID)!
      const b = input.knowledgeSource.getCard(winner.cardID)!
      // Different applicability or contradictory claims are not interchangeable evidence.
      const safeTaskScope = [member, winner].every((entry) =>
        entry.applicability.violatedConditions.length === 0 && entry.applicability.uncertainConditions.length === 0)
      if ((!safeTaskScope && stableJson(a.applicability) !== stableJson(b.applicability)) ||
          stableJson(a.notApplicableWhen) !== stableJson(b.notApplicableWhen) ||
          relations.some((relation) => relation.relationType === "contradicts" &&
            [member.cardID, winner.cardID].includes(relation.sourceCardID) &&
            [member.cardID, winner.cardID].includes(relation.targetCardID))) continue
      winner.mergedSources = [...(winner.mergedSources ?? []), {
        cardID: member.cardID, cardRevision: member.cardRevision,
        claim: member.claim, problem: member.problem, mechanism: member.mechanism,
        rationale: group.rationale,
        applicability: a.applicability,
        evidenceRefs: a.evidence.filter((item) => item.directness === "direct" && item.verification === "exact_span")
          .map(({ evidenceID, chunkID, evidenceSpan, section, pageStart, pageEnd }) => ({ evidenceID, chunkID, evidenceSpan, section, pageStart, pageEnd })),
      }, ...(member.mergedSources ?? [])]
      winner.limitations = unique([...winner.limitations, ...member.limitations])
      for (const key of Object.keys(winner.linkage) as Array<keyof TaskEvidenceEntry["linkage"]>) {
        winner.linkage[key] = unique([...winner.linkage[key], ...member.linkage[key]])
      }
      winner.roles = [...new Set([...winner.roles, ...member.roles])]
      winner.relevance = {
        score: Math.max(winner.relevance.score, member.relevance.score),
        matchedTerms: unique([...winner.relevance.matchedTerms, ...member.relevance.matchedTerms]),
        reasons: unique([...winner.relevance.reasons, ...member.relevance.reasons]),
      }
      canonical.set(member.cardID, winner.cardID)
      duplicateLosers.add(member.cardID)
    }
  }
  for (const cardID of duplicateLosers) {
    const entry = entryByCard.get(cardID)!
    excluded.push(exclude(cardID, entry.paperID, "duplicate_claim", `Equivalent mechanism retained with source trace in ${[...entryByCard.values()].find((value) => value.mergedSources?.some((source) => source.cardID === cardID))?.cardID ?? "representative"}.`))
  }
  const deduplicated = [...entryByCard.values()].filter((entry) => !duplicateLosers.has(entry.cardID))
  const selection = selectEntries({ entries: deduplicated, intents: input.intents, budgets: input.budgets })
  for (const entry of selection.omitted) {
    excluded.push(exclude(entry.cardID, entry.paperID, "selection_budget",
      `Task evidence selection budget was exhausted. Roles: ${entry.roles.join(", ")}. Claim: ${entry.claim}`))
    if (entry.roles.includes("warns_limitation") || entry.roles.includes("contradicts")) {
      for (const selected of selection.entries) {
        if (!selected.linkage.intentIDs.some((intentID) => entry.linkage.intentIDs.includes(intentID))) continue
        selected.limitations = unique([...selected.limitations,
          `Unselected warning ${entry.cardID}@${entry.cardRevision}: ${entry.claim}`,
          ...entry.limitations, ...entry.applicability.violatedConditions,
        ])
      }
    }
  }
  const conflicts = relations
    .filter((relation) => relation.relationType === "contradicts")
    .map((relation) => ({
      relationID: relation.relationID,
      sourceCardID: relation.sourceCardID,
      targetCardID: relation.targetCardID,
      rationale: relation.rationale,
      confidence: relation.confidence,
    }))
  const gaps = [...input.intents].toSorted((a, b) => a.intentID.localeCompare(b.intentID)).flatMap((intent) => {
    if (selection.entries.some((entry) => coversIntent(entry, intent))) return []
    const transformation = transformationByID.get(intent.transformationID)
    if (!transformation) throw new Error(`Retrieval intent references an unknown transformation: ${intent.intentID}`)
    const reason = gapReason({
      intent,
      candidates: input.candidates,
      literatureResults: input.literatureResults,
      acceptedIDs,
      eligibleBeforeBudget: deduplicated,
      selected: selection.entries,
    })
    return [{
      intentID: intent.intentID,
      conceptIDs: unique(transformation.scientificConcepts.map((item) => item.conceptID)),
      mustCover: intent.mustCover,
      reason: reason ?? "no_eligible_card" as const,
    }]
  })
  const coveredIntentCount = input.intents.filter((intent) =>
    selection.entries.some((entry) => coversIntent(entry, intent)),
  ).length
  const uncoveredMustCoverIntentCount = gaps.filter((gap) => gap.mustCover).length
  const highConfidenceCriticalConflict = conflicts.some((conflict) =>
    conflict.confidence >= taskEvidenceConfig.highConfidenceContradiction &&
    deduplicated.some((entry) =>
      (entry.cardID === conflict.sourceCardID || entry.cardID === conflict.targetCardID) &&
      entry.linkage.intentIDs.some((intentID) => input.intents.find((intent) => intent.intentID === intentID)?.mustCover),
    ),
  )
  const hasPartialLiterature = input.literatureResults.some((paper) => paper.status === "partial" || paper.status === "failed")
  const hasProvenanceExclusions = excluded.some((item) => item.reasons.includes("card_not_found") || item.reasons.includes("paper_mismatch"))
  const readiness: TaskEvidenceBundle["readiness"] = selection.entries.length === 0
    ? "ready_data_only"
    : highConfidenceCriticalConflict
      ? "evidence_conflict"
      : uncoveredMustCoverIntentCount > 0 || hasPartialLiterature || hasProvenanceExclusions
        ? "partial_evidence"
        : "ready_with_evidence"
  return TaskEvidenceBundleSchema.parse({
    schemaVersion: "task_evidence_bundle_v1",
    consolidation: input.consolidation,
    mechanismRelations: (input.componentRelations ?? []).flatMap((relation) => {
      const representative = (id: string) => selection.entries.find((entry) => entry.cardID === id ||
        entry.mergedSources?.some((source) => source.cardID === id))?.cardID
      const parentCardID = representative(relation.parentCardID)
      const componentCardID = representative(relation.componentCardID)
      return parentCardID && componentCardID && parentCardID !== componentCardID
        ? [{ ...relation, parentCardID, componentCardID }] : []
    }).filter((relation, index, all) => all.findIndex((item) => item.parentCardID === relation.parentCardID &&
      item.componentCardID === relation.componentCardID) === index),
    retrieveRunID: input.retrieveRunID,
    taskID: input.report.taskID,
    quantitativeReportArtifactID: input.quantitativeReportArtifactID,
    taskContextDigest: contextDigest,
    readiness,
    entries: selection.entries,
    excluded: excluded.toSorted((left, right) => left.paperID.localeCompare(right.paperID) || left.cardID.localeCompare(right.cardID)),
    conflicts,
    gaps,
    summary: {
      acceptedCardCount: acceptedIDs.size,
      selectedEntryCount: selection.entries.length,
      excludedCardCount: excluded.length,
      coveredIntentCount,
      uncoveredMustCoverIntentCount,
      conflictCount: conflicts.length,
    },
  })
}
