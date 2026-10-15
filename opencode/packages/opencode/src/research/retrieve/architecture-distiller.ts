import z from "zod"
import path from "path"
import { createHash } from "crypto"
import { mkdir, readFile, writeFile, rename } from "fs/promises"
import type { PrincipleModel, PrincipleStage } from "../literature/principle-model"
import {
  ARCHITECTURE_KNOWLEDGE_VERSION, ArchitectureRecallSchema, ArchitectureExtractionSchema, ArchitectureReviewSchema, ArchitectureRevisionSchema,
  architectureKnowledgePrompt, parseArchitectureJSON, projectArchitectureSourceCard, decisionCardIDs,
  validateRecallPartition, validateArchitectureExtraction, validateArchitectureReview, type ArchitectureDecision,
} from "./architecture-knowledge"
import { ArchitecturePacketSchema, type ArchitecturePacket } from "./architecture-packet"
import { diverseCards, type ArchitectureCorpus } from "./architecture-corpus"
import { ARCHITECTURE_SELECTION_POLICY, ArchitectureEligibilitySchema, architectureEligibilityIssues, architectureSelectionContext, matchedTargetEvidenceIssues, conditionLogicIssues, familyWitnessIssues, normalizeFamilyWitness } from "./architecture-eligibility"
import { TSFCandidateRecipe } from "../domains/tsf"

export const ARCHITECTURE_LIMITS = { recalledCards: 128, readCards: 40, batchCards: 4, batchChars: 220_000,
  readingSelection: "llm_global_family_shortlist_v1", reviewRecovery: "preserve_valid_isolated_v2",
  witnessDeclarations: "runtime_owned_adapter_v1", extractionCriteria: "family_pure_data_conditions_v3",
  semanticRevisionRounds: 2, conditionAssessment: "source_bound_and_or_input_output_v1" } as const
const checks = z.object({
  dataCondition: z.boolean(), nonCircular: z.boolean(), structuralChoice: z.boolean(),
  sourceFaithful: z.boolean(), counterevidencePreserved: z.boolean(), taskFitCorrect: z.boolean(),
  conditionLogicPreserved: z.boolean(), inputOutputDistinguished: z.boolean(), familyAbstraction: z.boolean(), noLocalReplication: z.boolean(),
}).strict()
const sourceReview = z.object({ reviews: z.array(ArchitectureReviewSchema.shape.reviews.element.extend({
  checks, eligibility: ArchitectureEligibilitySchema.extend({ conditionLogic: ArchitectureEligibilitySchema.shape.conditionLogic.unwrap() }),
  revisionAdvice: ArchitectureReviewSchema.shape.reviews.element.shape.revisionAdvice.unwrap(),
})) }).strict()
const curation = z.object({ selectedDecisionIDs: z.array(z.string()), excluded: z.array(z.object({ decisionID: z.string(), reason: z.string() }).strict()) }).strict()

export async function distillArchitectureKnowledge(input: {
  corpus: ArchitectureCorpus; model?: PrincipleModel; task: Record<string, unknown>;
  datasetEvidencePaths: string[]; maxDecisions: number; auditRoot: string; signal?: AbortSignal;
  onProgress?: (event: { step: "recall_architecture" | "distill_architecture" | "review_architecture"; status: string; counts?: Record<string, number> }) => Promise<void>;
}): Promise<ArchitecturePacket> {
  const packet: ArchitecturePacket = {
    version: ARCHITECTURE_KNOWLEDGE_VERSION, status: input.model ? "completed" : "unavailable",
    selectionPolicy: ARCHITECTURE_SELECTION_POLICY,
    model: input.model?.modelIdentifier ?? "unavailable", corpusDigest: input.corpus.digest,
    consideredCardCount: 0, readCardCount: 0, decisions: [], sourceCards: [], historicalCardIDs: [],
    datasetEvidencePaths: input.datasetEvidencePaths, reviews: [], exclusions: [], warnings: [...input.corpus.warnings],
  }
  if (!input.model) { packet.warnings.push("Architecture extraction requires a configured LLM; raw cards do not become architectural decisions."); return packet }
  await mkdir(input.auditRoot, { recursive: true })
  const abort = () => input.signal?.throwIfAborted()
  async function ask<T>(name: string, stage: "recall" | "extract" | "review" | "revise" | "curate", schema: z.ZodType<T>, data: object, validate: (value: T) => void,
    options?: { attempts?: 1 | 2; parse?: (raw: unknown) => T; retryInvalidCache?: boolean }): Promise<T> {
    let repair: object = {}
    const attempts = options?.attempts ?? 2
    for (let attempt = 1; attempt <= attempts; attempt++) {
      abort()
      const request = { ...data, task: architectureSelectionContext(input.task), ...repair, outputSchema: z.toJSONSchema(schema) }
      const digest = createHash("sha256").update(JSON.stringify({ version: ARCHITECTURE_KNOWLEDGE_VERSION,
        model: input.model!.modelIdentifier, prompt: architectureKnowledgePrompt(stage), request })).digest("hex")
      const file = path.join(input.auditRoot, `${name}-${attempt}-${digest.slice(0, 16)}.json`)
      const cached = await readFile(file, "utf8").then(JSON.parse).catch(() => undefined)
      const response = cached?.digest === digest && !(options?.retryInvalidCache && cached.validationError)
        ? cached.response : await input.model!.request(`architecture_${stage}` as PrincipleStage, request)
      abort()
      const temporary = `${file}.tmp-${process.pid}`
      await writeFile(temporary, JSON.stringify({ digest, model: packet.model, stage, request, response }, null, 2))
      await rename(temporary, file)
      try {
        const raw = parseArchitectureJSON(response.text)
        const result = options?.parse ? options.parse(raw) : schema.parse(raw)
        validate(result)
        return result
      } catch (error) {
        // This catch only covers local JSON/schema/reference validation, never
        // provider transport failures. Keep its reason available for inspection.
        await writeFile(temporary, JSON.stringify({ digest, model: packet.model, stage, request, response,
          validationError: String(error) }, null, 2))
        await rename(temporary, file)
        if (attempt === attempts) throw error
        repair = { previousResponse: response.text, repairError: String(error),
          repairInstruction: "Repair JSON, references and complete partitions only; never change scientific content to evade an error. For acceptance inspect all cited sources and ensure all checks are true." }
      }
    }
    throw new Error("Unreachable")
  }
  const failed = (stage: string, error: unknown) => {
    abort()
    packet.status = "partial"
    // Provider errors may include request metadata; never persist raw transport errors or credentials.
    packet.warnings.push(`${stage} failed; its unreviewed decisions were withheld. See locally saved responses if available.`)
  }
  const pool = diverseCards(input.corpus.cards, ARCHITECTURE_LIMITS.recalledCards)
  packet.consideredCardCount = pool.length
  const poolIDs = new Set(pool.map((c) => c.knowledgeID))
  packet.exclusions.push(...input.corpus.cards.filter((c) => !poolIDs.has(c.knowledgeID))
    .map((c) => ({ id: c.knowledgeID, stage: "recall_budget", reason: "Deferred by paper-diverse broad-recall budget" })))
  await input.onProgress?.({ step: "recall_architecture", status: "running", counts: { cards: pool.length, papers: new Set(pool.map((c) => c.paperID)).size } })
  const selectedIDs = new Set<string>()
  for (let start = 0; start < pool.length; start += 16) {
    const batch = pool.slice(start, start + 16)
    try {
      const recalled = await ask(`recall-${start}`, "recall", ArchitectureRecallSchema, { task: input.task,
        cards: batch.map((c) => ({ cardID: c.knowledgeID, paperID: c.paperID, principle: c.principle,
          transferableInsight: c.transferableInsight, epistemicStatus: c.epistemicStatus })),
      }, (value) => validateRecallPartition(value, batch.map((c) => c.knowledgeID)))
      recalled.selected.forEach((id) => selectedIDs.add(id))
      packet.exclusions.push(...recalled.excluded.map((x) => ({ id: x.cardID, stage: "recall", reason: x.reason })))
    } catch (error) {
      failed("architecture recall", error)
      packet.exclusions.push(...batch.map((c) => ({ id: c.knowledgeID, stage: "recall_failed", reason: "Recall did not return a valid complete partition" })))
    }
  }
  const candidates = pool.filter((c) => selectedIDs.has(c.knowledgeID))
  let selected = candidates
  if (candidates.length > ARCHITECTURE_LIMITS.readCards) {
    try {
      // Paper diversity is useful for broad discovery, but a round-robin slice
      // here can discard the strongest family evidence in favor of card order.
      const shortlist = await ask("recall-shortlist", "recall", ArchitectureRecallSchema, {
        cards: candidates.map((c) => ({ cardID: c.knowledgeID, paperID: c.paperID, principle: c.principle,
          transferableInsight: c.transferableInsight, epistemicStatus: c.epistemicStatus })),
        instruction: `Choose at most ${ARCHITECTURE_LIMITS.readCards} cards globally for original-source reading. Prioritize concrete source-backed mechanism-family decisions matching target data, not input order or one-card-per-paper quotas. Complementary cards from one paper can separately explain trend handling, level-shift normalization or local semantics. Merge duplicate leads by choosing the best version. Do not privilege exact operator reproduction. Account for every input card once in selected/excluded.`,
      }, (value) => validateRecallPartition(value, candidates.map((c) => c.knowledgeID)))
      selected = shortlist.selected.map((id) => candidates.find((c) => c.knowledgeID === id)!)
      packet.exclusions.push(...shortlist.excluded.map((x) => ({ id: x.cardID, stage: "reading_shortlist", reason: x.reason })))
    } catch (error) {
      failed("architecture reading shortlist", error)
      // Unranked cards do not become an authorized fallback.
      selected = []
      packet.exclusions.push(...candidates.map((c) => ({ id: c.knowledgeID, stage: "reading_shortlist_failed", reason: "No valid global original-source shortlist" })))
    }
  }
  const readIDs = new Set(selected.map((c) => c.knowledgeID))
  packet.exclusions.push(...pool.filter((c) => selectedIDs.has(c.knowledgeID) && !readIDs.has(c.knowledgeID))
    .filter((c) => !packet.exclusions.some((e) => e.id === c.knowledgeID && e.stage.startsWith("reading_shortlist")))
    .map((c) => ({ id: c.knowledgeID, stage: "reading_budget", reason: "Deferred by original-source reading budget" })))
  packet.readCardCount = selected.length
  await input.onProgress?.({ step: "recall_architecture", status: "completed", counts: { recalled_cards: pool.length, source_read_cards: selected.length } })
  const batches: typeof selected[] = []
  for (const card of selected.sort((a, b) => a.paperID.localeCompare(b.paperID))) {
    const last = batches.at(-1)
    if (!last || last.length >= ARCHITECTURE_LIMITS.batchCards || JSON.stringify([...last, card]).length > ARCHITECTURE_LIMITS.batchChars) batches.push([card])
    else last.push(card)
  }
  const proposals: ArchitectureDecision[] = []
  const reviews: ArchitecturePacket["reviews"] = []
  await input.onProgress?.({ step: "distill_architecture", status: "running", counts: { batches: batches.length } })
  for (const [index, batch] of batches.entries()) {
    if (JSON.stringify(batch).length > ARCHITECTURE_LIMITS.batchChars) {
      packet.status = "partial"
      packet.exclusions.push(...batch.map((c) => ({ id: c.knowledgeID, stage: "context_budget", reason: "Card exceeds bounded source-reading context; not truncated" })))
      continue
    }
    try {
      const sources = batch.map(projectArchitectureSourceCard)
      const extracted = await ask(`extract-${index}`, "extract", ArchitectureExtractionSchema, { task: input.task, cards: sources,
        instruction: "Read original method prose for source-backed data-linked explanations. Do not copy a card's operator-conditioned headline into dataCondition. Existing Transformer/point-token design belongs in prefer/avoid, not dataCondition. Express local continuity/pattern structure itself as the condition when sources justify local subseries representations. Source evidence from multivariate benchmarks does not make multiple target channels a prerequisite for local patches. Do not prescribe larger windows or derive accuracy from token-count savings. A source saying distribution shift does not license inventing a necessary last-value/mean threshold, an observed level-only shift, or a measured future trend. Distill distinct trend handling, normalization or representation principles separately, at the authors' stated epistemic level; no isolated component gain or local replication prerequisite. Original cards and all contrary sources remain available for verification.",
      },
        (value) => validateArchitectureExtraction(value, batch))
      packet.exclusions.push(...extracted.unused.map((x) => ({ id: x.cardID, stage: "extract", reason: x.reason })))
      const decisions = extracted.decisions.map((d, i) => ({ ...d, decisionID: `architecture_${index}_${i}` }))
      if (!decisions.length) continue
      const relatedCards = (items: ArchitectureDecision[]) => {
        const ids = new Set(items.flatMap(decisionCardIDs))
        return batch.filter((card) => ids.has(card.knowledgeID))
      }
      const reviewData = (items: ArchitectureDecision[], cards = relatedCards(items)) => ({ task: input.task,
        cards: cards.map(projectArchitectureSourceCard), decisions: items,
        instruction: "Evaluate each checks field independently. An accepted verdict requires all checks true. A resource bottleneck or the choice to use a module is not a data condition. No required number of accepted rules.",
      })
      const validateReviews = (items: ArchitectureDecision[], cards = relatedCards(items)) => (value: z.infer<typeof sourceReview>) => {
        validateArchitectureReview(value, items, cards)
        if (value.reviews.some((r) => r.verdict === "accepted" && Object.values(r.checks).some((v) => !v))) throw new Error("Accepted review has failed semantic checks")
        for (const review of value.reviews) {
          // The library illustration is not an executable experiment. Runtime
          // owns adapter IO declarations; all remaining fields still validate.
          review.eligibility = { ...normalizeFamilyWitness(review.eligibility), conditionLogic: review.eligibility.conditionLogic }
          const issues = matchedTargetEvidenceIssues(review.eligibility, input.task)
          if (issues.length) throw new Error(`${issues.join("; ")}. Use exact paths and values from the supplied task. An unknown condition must remain unknown, not matched.`)
          const logicIssues = conditionLogicIssues(review.eligibility)
          if (logicIssues.length) throw new Error(`${logicIssues.join("; ")}. Correct the assessment without adding or removing source prerequisites or requiring local replication.`)
          if (review.verdict === "accepted" && review.eligibility.implementation === "family_supported" &&
            review.eligibility.target === "matched" && review.eligibility.objective === "prediction") {
            const witnessIssues = familyWitnessIssues(review.eligibility)
            if (witnessIssues.length) {
              const parsed = TSFCandidateRecipe.safeParse(review.eligibility.recipe)
              throw new Error(`${witnessIssues.join("; ")}. ${parsed.success ? "" : JSON.stringify(parsed.error.issues)} Repair only the representative recipe/schema fields to express the SAME source-backed family; do not change scientific claims or data prerequisites. If this family is actually unavailable, mark implementation=unsupported rather than substituting an unrelated family.`)
            }
          }
        }
      }
      type SourceReview = z.infer<typeof sourceReview>["reviews"][number]
      const retained = new Map<string, SourceReview>()
      const receipt = (decision: ArchitectureDecision) => {
        const digest = createHash("sha256").update(JSON.stringify({ version: ARCHITECTURE_KNOWLEDGE_VERSION,
          model: packet.model, prompt: architectureKnowledgePrompt("review"),
          request: { ...reviewData([decision]), task: architectureSelectionContext(input.task), outputSchema: z.toJSONSchema(sourceReview) },
        })).digest("hex")
        return { digest, file: path.join(input.auditRoot, `source-review-${decision.decisionID}-${digest.slice(0, 16)}.json`) }
      }
      const saveReview = async (decision: ArchitectureDecision) => {
        const { digest, file } = receipt(decision)
        const temporary = `${file}.tmp-${process.pid}`
        await writeFile(temporary, JSON.stringify({ digest, review: retained.get(decision.decisionID) }, null, 2))
        await rename(temporary, file)
      }
      // Revalidate receipts against the exact model, prompt, decision, task and
      // complete source context. Failed responses never become review receipts.
      for (const decision of decisions) {
        const { digest, file } = receipt(decision)
        const cached = await readFile(file, "utf8").then(JSON.parse).catch(() => undefined)
        if (cached?.digest !== digest) continue
        try {
          const value = sourceReview.parse({ reviews: [cached.review] })
          validateReviews([decision])(value)
          retained.set(decision.decisionID, value.reviews[0]!)
        } catch { /* Invalid receipts must be independently reviewed again. */ }
      }
      const pending = decisions.filter((decision) => !retained.has(decision.decisionID))
      if (pending.length > 1) {
        try {
          await ask(`review-${index}`, "review", sourceReview, reviewData(pending), () => {}, {
            attempts: 1,
            parse(raw) {
              const envelope = z.object({ reviews: z.array(z.unknown()) }).strict().parse(raw)
              const failures: string[] = []
              for (const decision of pending) {
                const entries = envelope.reviews.filter((entry) => entry && typeof entry === "object" &&
                  "decisionID" in entry && entry.decisionID === decision.decisionID)
                try {
                  if (entries.length !== 1) throw new Error("Review must occur exactly once")
                  const value = sourceReview.parse({ reviews: entries })
                  validateReviews([decision])(value)
                  retained.set(decision.decisionID, value.reviews[0]!)
                } catch (error) { failures.push(`${decision.decisionID}: ${String(error)}`) }
              }
              if (failures.length) throw new Error(failures.join("\n"))
              return { reviews: pending.map((decision) => retained.get(decision.decisionID)!) }
            },
          })
        } catch { abort() }
        // Save qualified siblings before attempting any failed entry, including
        // when the batch envelope was valid but one review failed its gates.
        for (const decision of pending) if (retained.has(decision.decisionID)) await saveReview(decision)
      }
      for (const decision of pending.filter((decision) => !retained.has(decision.decisionID))) {
        try {
          const single = await ask(decisions.length === 1 ? `review-${index}` : `review-${index}-${decision.decisionID}`,
            "review", sourceReview, reviewData([decision]), validateReviews([decision]), { retryInvalidCache: true })
          retained.set(decision.decisionID, single.reviews[0]!)
          await saveReview(decision)
        } catch (error) {
          failed(`architecture decision ${decision.decisionID}`, error)
          packet.exclusions.push({ id: decision.decisionID, stage: "source_review_failed", reason: "No valid independent review after bounded isolated recovery" })
        }
      }
      const reviewed = { reviews: decisions.flatMap((decision) => retained.has(decision.decisionID) ? [retained.get(decision.decisionID)!] : []) }
      for (const original of decisions) {
        let d = original
        let r = reviewed.reviews.find((r) => r.decisionID === d.decisionID)
        if (!r) continue
        // Semantic repair has its own stage, immutable originals and fresh review.
        // A genuine unknown prerequisite is not a reason to keep retrying.
        let withdrawn = false
        for (let round = 1; round <= ARCHITECTURE_LIMITS.semanticRevisionRounds; round++) {
          const admissionIssues = architectureEligibilityIssues(r.eligibility, input.task)
          if (r.verdict === "accepted" && !admissionIssues.length) break
          if (r.revisionAdvice.action === "none") break
          try {
            const revisionCards = relatedCards([d, original])
            const revision = await ask(`revise-${index}-${d.decisionID}-${round}`, "revise", ArchitectureRevisionSchema, {
              cards: revisionCards.map(projectArchitectureSourceCard), previousDecision: d, originalDecision: original,
              independentReview: r, admissionIssues,
            }, (value) => {
              if (!value.decision) return
              if (value.decision.decisionID !== original.decisionID) throw new Error("Revision must preserve decisionID")
              const used = new Set(decisionCardIDs(value.decision))
              validateArchitectureExtraction({ decisions: [value.decision],
                unused: revisionCards.filter((c) => !used.has(c.knowledgeID)).map((c) => ({ cardID: c.knowledgeID, reason: "Not cited by this revision" })),
              }, revisionCards)
            })
            if (!revision.decision) {
              packet.exclusions.push({ id: d.decisionID, stage: "revision_withdrawn", reason: revision.reason })
              withdrawn = true
              break
            }
            d = revision.decision
            const fresh = await ask(`review-revision-${index}-${d.decisionID}-${round}`, "review", sourceReview,
              reviewData([d], revisionCards), validateReviews([d], revisionCards), { retryInvalidCache: true })
            r = fresh.reviews[0]!
          } catch (error) {
            failed(`architecture semantic revision ${d.decisionID}`, error)
            packet.exclusions.push({ id: d.decisionID, stage: "semantic_revision_failed", reason: "Revision or its fresh independent review did not pass validation" })
            withdrawn = true
            break
          }
        }
        if (withdrawn) continue
        if (r.verdict !== "accepted") {
          packet.exclusions.push({ id: d.decisionID, stage: "source_review", reason: r.reason })
          continue
        }
        const admissionIssues = architectureEligibilityIssues(r.eligibility, input.task)
        if (admissionIssues.length) {
          packet.exclusions.push({ id: d.decisionID, stage: "task_admission", reason: admissionIssues.join("; ") })
          continue
        }
        // The independent target assessment owns admission. Lack of a local
        // replication must not turn established data prerequisites into unknown.
        // Scientific choices/claims stay unchanged; only task applicability is corrected.
        proposals.push({ ...d, taskFit: "supported", taskReason: r.eligibility.targetReason })
        const { checks, ...review } = r
        reviews.push(review)
      }
    } catch (error) {
      failed(`architecture source batch ${index}`, error)
      packet.exclusions.push(...batch.map((c) => ({ id: c.knowledgeID, stage: "source_review_failed", reason: "No valid independently reviewed decision" })))
    }
    await input.onProgress?.({ step: "distill_architecture", status: "running", counts: { processed_batches: index + 1, batches: batches.length, reviewed_decisions: proposals.length } })
  }
  await input.onProgress?.({ step: "distill_architecture", status: "completed", counts: { reviewed_decisions: proposals.length } })
  await input.onProgress?.({ step: "review_architecture", status: "running" })
  if (proposals.length) {
    try {
      // Only executable, matched prediction rules reach deduplication.
      const final = await ask("curate", "curate", curation, { maxDecisions: input.maxDecisions, decisions: proposals }, (value) => {
        const ids = [...value.selectedDecisionIDs, ...value.excluded.map((x) => x.decisionID)]
        if (ids.length !== proposals.length || new Set(ids).size !== ids.length || ids.some((id) => !proposals.some((d) => d.decisionID === id))) throw new Error("Curation must account for every decision exactly once")
        if (value.selectedDecisionIDs.length > input.maxDecisions) throw new Error("Curation exceeds decision budget")
      })
      packet.decisions = proposals.filter((d) => final.selectedDecisionIDs.includes(d.decisionID))
      packet.reviews = reviews.filter((r) => final.selectedDecisionIDs.includes(r.decisionID))
      packet.exclusions.push(...final.excluded.map((x) => ({ id: x.decisionID, stage: "curate", reason: x.reason })))
    } catch (error) { failed("architecture usefulness audit", error) }
  }
  const cited = new Set(packet.decisions.flatMap(decisionCardIDs))
  packet.sourceCards = selected.filter((c) => cited.has(c.knowledgeID))
  // Keep complete batch/revision evidence in the audit, while the handoff
  // authorizes only source cards of selected decisions.
  packet.reviews = packet.reviews.map((r) => ({ ...r, reviewedSources: r.reviewedSources.filter((s) => cited.has(s.cardID)) }))
  packet.historicalCardIDs = input.corpus.historicalCardIDs.filter((id) => cited.has(id))
  await input.onProgress?.({ step: "review_architecture", status: packet.status, counts: { decisions: packet.decisions.length, source_cards: packet.sourceCards.length } })
  return ArchitecturePacketSchema.parse(packet)
}
