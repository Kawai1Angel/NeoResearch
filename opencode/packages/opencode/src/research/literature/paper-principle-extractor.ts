import { createHash } from "node:crypto"
import z from "zod"
import type { DocumentChunk, NormalizedDocument } from "./contract"
import {
  KnowledgeCandidateSchema, KnowledgeSourceSchema, PaperAnalysisSchema, PrincipleReviewSchema,
  KNOWLEDGE_V2_VERSIONS, type KnowledgeCandidateV2, type KnowledgeCardV2, type PaperAnalysis,
} from "./knowledge-v2-contract"
import { finalizeKnowledgeCandidate, knowledgeCandidateHash, knowledgeV2CacheKey, validateKnowledgeCandidate, validatePrincipleReview, validatePrincipleReviewEnvelope, isSourceSupportedAssertion } from "./knowledge-v2-validator"
import { principleOutputSchema, type PrincipleModel, type PrincipleStage } from "./principle-model"
import { buildSourceRegistry, projectSources, hydrateCandidateSources } from "./source-registry"

const OutlineSchema = z.object({
  problem: z.string().min(1), contributions: z.array(z.unknown()), methodOutline: z.array(z.unknown()), unresolved: z.array(z.string()),
}).strict()
const OutlineItemSchema = PaperAnalysisSchema.shape.contributions.element.extend({ contributionIndex: z.number().int().nonnegative().optional() })
const OutlineOutputSchema = OutlineSchema.extend({ contributions: z.array(OutlineItemSchema), methodOutline: z.array(PaperAnalysisSchema.shape.methodOutline.element) })
const MaterialSchema = z.object({ materials: z.array(z.unknown()), unresolved: z.array(z.string()) }).strict()
const CandidateWireSchema = KnowledgeCandidateSchema.omit({ sources: true, principle: true }).extend({
  sources: z.array(z.string().min(1)).min(1).optional(), contributionIndexes: z.array(z.number().int().nonnegative()).min(1),
})
const SynthesisSchema = z.object({ candidates: z.array(KnowledgeCandidateSchema), unformed: z.array(z.string().min(1)) }).strict()
const SynthesisWireSchema = SynthesisSchema.extend({ candidates: z.array(CandidateWireSchema).max(1) })
const RevisionSchema = z.object({ candidate: KnowledgeCandidateSchema.nullable(), reason: z.string().min(1) }).strict()
const RevisionWireSchema = RevisionSchema.extend({ candidate: CandidateWireSchema.nullable() })
const ConsolidationSchema = z.object({
  candidates: z.array(KnowledgeCandidateSchema),
  dispositions: z.array(z.object({
    originalCandidateID: z.string().min(1), finalCandidateIDs: z.array(z.string().min(1)),
    action: z.enum(["retained", "merged", "component", "rejected"]), rationale: z.string().min(1),
  }).strict()),
}).strict()
const ConsolidationWireSchema = z.object({ groups: z.array(z.object({
  candidateIDs: z.array(z.string().min(1)).min(1), action: z.enum(["retain", "merge", "reject"]), rationale: z.string().min(1),
}).strict()) }).strict()
const PlanSchema = z.object({ plans: z.array(z.object({ planID: z.string().min(1), contributionIndexes: z.array(z.number().int().nonnegative()).min(1), focus: z.string().min(1).max(1600) }).strict()), unformed: z.array(z.string()) }).strict()
const MaterialRepairSchema = z.object({ repairs: z.array(z.object({ itemIndex: z.number().int().nonnegative(), material: z.unknown().nullable(), reason: z.string().min(1) }).strict()) }).strict()
const BindingRepairSchema = z.object({
  links: z.array(z.object({ evidenceID: z.string().min(1), assertionIDs: z.array(z.string().min(1)).min(1) }).strict()),
  sourceBindings: z.array(KnowledgeCandidateSchema.shape.support.element.omit({ evidenceID: true })).optional(),
  experimentBindings: z.array(z.object({ evidenceID: z.string().min(1), experimentID: z.string().min(1), sourceIDs: z.array(z.string().min(1)).min(1) }).strict()).optional(),
  scopeReplacements: z.array(z.object({ assertionID: z.string().min(1).optional(), statement: z.string().min(1), sourceIDs: z.array(z.string().min(1)).min(1) }).strict()),
  unresolved: z.array(z.string()),
}).strict()
const AnalysisMaterialSchema = PaperAnalysisSchema.shape.materials.element.omit({ materialID: true })
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export type PrincipleCall = {
  stage: PrincipleStage; attempt: number; inputHash: string; inputCharacters: number; outputHash?: string; elapsedMs: number
  response?: string
  usage?: Awaited<ReturnType<PrincipleModel["request"]>>["usage"]; error?: string
}
export type PrincipleExtraction = {
  schemaVersion: "paper_principle_run_v1"; runID: string; cacheKey: string; paperID: string
  status: "completed" | "partial"; analysis?: PaperAnalysis
  candidates: KnowledgeCandidateV2[]; cards: KnowledgeCardV2[]
  finalCandidates: KnowledgeCandidateV2[]
  plans: z.infer<typeof PlanSchema>["plans"]
  dispositions: z.infer<typeof ConsolidationSchema>["dispositions"]
  reviews: z.infer<typeof PrincipleReviewSchema>[]
  rejected: Array<{ candidateID: string; reasons: string[] }>
  stagedMaterials: Array<{ gapID: string; raw: unknown; reason: string }>
  unformed: string[]; errors: string[]; calls: PrincipleCall[]
}

class IncompleteAnalysis extends Error {}

// Related versions are comparison context, not the object being approved. Keep
// every assertion and adverse result; full protocols remain in originalChunks
// and in the current candidate, rather than repeating them for every version.
export function projectRelatedPrinciple(candidate: KnowledgeCandidateV2) {
  const { experiments, support, ...rest } = candidate
  return { ...rest, sources: candidate.sources.map((s) => s.sourceID), comparisonOnly: true,
    experimentResults: experiments.map(({ experimentID, intervention, comparator, dataset, metric, metricDirection, result, control, confounds, sourceIDs }) =>
      ({ experimentID, intervention, comparator, dataset, metric, metricDirection, result, control, confounds, sourceIDs })) }
}

function checkReferences(items: Array<{ sourceIDs: string[] }>, sources: z.infer<typeof KnowledgeSourceSchema>[]) {
  const ids = new Set(sources.map((s) => s.sourceID))
  for (const item of items) for (const id of item.sourceIDs) if (!ids.has(id)) throw new Error(`Unknown source: ${id}`)
}

function batches(chunks: readonly DocumentChunk[], limit: number) {
  const result: DocumentChunk[][] = []
  for (const chunk of chunks) {
    if (JSON.stringify(chunk).length > limit) throw new IncompleteAnalysis(`chunk_exceeds_context:${chunk.chunkID}`)
    const last = result.at(-1)
    if (!last || JSON.stringify([...last, chunk]).length > limit) result.push([chunk])
    else last.push(chunk)
  }
  return result
}

export async function extractPaperPrinciples(input: {
  document: NormalizedDocument; chunks: readonly DocumentChunk[]; model: PrincipleModel
  verifier?: PrincipleModel; runID: string; signal?: AbortSignal
  options?: { maxCalls?: number; batchCharacters?: number; maxContextCharacters?: number }
}): Promise<PrincipleExtraction> {
  const options = { maxCalls: 80, batchCharacters: 24000, maxContextCharacters: 180000, ...input.options }
  for (const [key, value] of Object.entries(options)) if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${key}`)
  const { document, chunks, model } = input
  const verifier = input.verifier ?? model
  const context = { paperID: document.paperID, documentID: document.documentID, documentSha256: document.sourceSha256, chunks }
  const result: PrincipleExtraction = {
    schemaVersion: "paper_principle_run_v1", runID: input.runID, paperID: document.paperID,
    cacheKey: knowledgeV2CacheKey({ documentSha256: document.sourceSha256, extractorModel: model.modelIdentifier,
      verifierModel: verifier.modelIdentifier, options: { ...options, chunks: chunks.map((c) => [c.chunkID, c.textSha256]), parser: document.parser } }),
    status: "partial", stagedMaterials: [], plans: [], candidates: [], finalCandidates: [], cards: [], dispositions: [], reviews: [], rejected: [], unformed: [], errors: [], calls: [],
  }
  async function call<T>(stage: PrincipleStage, schema: z.ZodType<T>, payload: Record<string, unknown>, check?: (value: T) => void, wire?: { schema: z.ZodType; decode: (value: unknown) => unknown }): Promise<T> {
    let repair: Record<string, unknown> = {}
    for (let attempt = 0; attempt < 2; attempt++) {
      input.signal?.throwIfAborted()
      if (result.calls.length >= options.maxCalls) throw new IncompleteAnalysis("call_budget_exhausted")
      const request = { ...payload, ...repair, outputSchema: payload.outputSchema ?? principleOutputSchema(wire?.schema ?? schema) }
      if (JSON.stringify(request).length > options.maxContextCharacters) throw new IncompleteAnalysis(`context_budget_exceeded:${stage}`)
      const record: PrincipleCall = { stage, attempt, inputHash: digest(request), inputCharacters: JSON.stringify(request).length, elapsedMs: 0 }
      result.calls.push(record)
      const start = Date.now()
      let response: string | undefined
      try {
        const output = await (stage === "verify" ? verifier : model).request(stage, request)
        input.signal?.throwIfAborted()
        response = output.text
        record.response = response
        record.usage = output.usage
        record.outputHash = digest(response)
        const raw = JSON.parse(response.replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, ""))
        const value = schema.parse(wire ? wire.decode(wire.schema.parse(raw)) : raw)
        check?.(value)
        return value
      } catch (error) {
        input.signal?.throwIfAborted()
        record.error = String(error)
        // Transport failures are not JSON repair requests.
        if (response === undefined || attempt === 1) throw error
        repair = { repair: { previousResponse: response, error: String(error), instruction: "Correct structural/reference errors using only supplied sources. This is not an acceptance verdict." } }
      } finally { record.elapsedMs = Date.now() - start }
    }
    throw new IncompleteAnalysis("repair_exhausted")
  }
  try {
    const chunkIDs = new Set<string>()
    for (const chunk of chunks) {
      if (chunkIDs.has(chunk.chunkID) || chunk.paperID !== document.paperID || chunk.documentID !== document.documentID
        || createHash("sha256").update(chunk.text).digest("hex") !== chunk.textSha256) throw new Error(`Invalid document chunk: ${chunk.chunkID}`)
      chunkIDs.add(chunk.chunkID)
    }
    if (!chunks.length) throw new IncompleteAnalysis("source_unavailable:no_chunks")
    const groups = batches(chunks, options.batchCharacters)
    const overview = chunks.filter((c) => ["abstract", "introduction", "conclusion"].includes(c.sectionKind))
    const outlineChunks = batches(overview.length ? overview : groups[0], options.batchCharacters)[0]
    const identity = { paperID: document.paperID, documentID: document.documentID, documentSha256: document.sourceSha256 }
    const registry = buildSourceRegistry(document, chunks)
    const outlineSources = registry.filter((s) => outlineChunks.some((c) => c.chunkID === s.chunkID))
    const outline = await call("outline", OutlineSchema, {
      paperID: document.paperID, sourceCatalog: projectSources(outlineSources), sections: document.sections,
      itemSchema: principleOutputSchema(PaperAnalysisSchema.shape.contributions.element),
      outputSchema: principleOutputSchema(OutlineOutputSchema),
    })
    const analysis: PaperAnalysis = {
      ...identity, problem: outline.problem, contributions: [], methodOutline: [], unresolved: [...outline.unresolved],
      schemaVersion: "paper_analysis_v1", materials: [], sources: registry, materialGaps: [],
      coverage: { reviewedChunkIDs: [], remainingChunkIDs: chunks.map((c) => c.chunkID) }, status: "partial",
    }
    result.analysis = analysis
    const stageGap = (stage: "outline" | "collect", raw: unknown, reason: string, group: readonly DocumentChunk[]) => {
      const rawIndexes = raw && typeof raw === "object" && "contributionIndexes" in raw ? raw.contributionIndexes : undefined
      const indexes = Array.isArray(rawIndexes) && rawIndexes.length && rawIndexes.every((i) => Number.isInteger(i) && i >= 0 && i < analysis.contributions.length) ? rawIndexes as number[] : []
      const gapID = `gap_${result.stagedMaterials.length}`
      analysis.materialGaps!.push({ gapID, stage, reason, contributionIndexes: indexes, affectsAllContributions: !indexes.length, chunkIDs: group.map((c) => c.chunkID) })
      analysis.unresolved.push(`${gapID}: ${reason}`)
      result.stagedMaterials.push({ gapID, raw, reason })
    }
    for (const key of ["contributions", "methodOutline"] as const) {
      for (const [ordinal, raw] of outline[key].entries()) {
        try {
          const parsed = OutlineItemSchema.parse(raw)
          const { contributionIndex, ...item } = parsed
          if (contributionIndex !== undefined && contributionIndex !== ordinal) throw new Error("Outline index disagrees with array position")
          checkReferences([item], outlineSources)
          analysis[key].push(item)
        } catch (error) { stageGap("outline", raw, String(error), outlineChunks) }
      }
    }
    const indexedContributions = analysis.contributions.map((item, contributionIndex) => ({ ...item, contributionIndex }))
    for (const [index, group] of groups.entries()) {
      const available = registry.filter((s) => group.some((c) => c.chunkID === s.chunkID))
      const material = await call("collect", MaterialSchema, {
        paperID: document.paperID,
        outline: { problem: analysis.problem, contributions: indexedContributions, methodOutline: analysis.methodOutline },
        sourceCatalog: projectSources(available), itemSchema: principleOutputSchema(AnalysisMaterialSchema),
        outputSchema: principleOutputSchema(MaterialSchema.extend({ materials: z.array(AnalysisMaterialSchema) })),
      })
      const invalid: Array<{ itemIndex: number; raw: unknown; error: string }> = []
      const acceptMaterial = (raw: unknown, ordinal: number) => {
        const item = AnalysisMaterialSchema.parse(raw)
        checkReferences([item], registry)
        if (item.contributionIndexes.some((i) => i >= analysis.contributions.length)) throw new Error("Unknown contribution index")
        analysis.materials.push({ ...item, materialID: `material_${index}_${ordinal}` })
      }
      for (const [ordinal, raw] of material.materials.entries()) {
        try { acceptMaterial(raw, ordinal) }
        catch (error) { invalid.push({ itemIndex: ordinal, raw, error: String(error) }) }
      }
      if (invalid.length) {
        let repairs: z.infer<typeof MaterialRepairSchema> = { repairs: [] }
        let repairError = ""
        try {
          repairs = await call("repair_materials", MaterialRepairSchema, {
            invalidItems: invalid, sourceCatalog: projectSources(registry), itemSchema: principleOutputSchema(AnalysisMaterialSchema),
            contributions: indexedContributions,
          })
        } catch (error) {
          input.signal?.throwIfAborted()
          if (error instanceof IncompleteAnalysis) throw error
          repairError = String(error)
        }
        for (const failure of invalid) {
          const matches = repairs.repairs.filter((r) => r.itemIndex === failure.itemIndex)
          const repair = matches.length === 1 ? matches[0] : undefined
          try {
            if (!repair?.material) throw new Error(repair?.reason ?? (repairError || "Missing or duplicate material repair"))
            const old = failure.raw as { contributionIndexes?: unknown }
            const replacement = repair.material as { contributionIndexes?: unknown }
            if (JSON.stringify(old?.contributionIndexes) !== JSON.stringify(replacement?.contributionIndexes)) throw new Error("Material repair changed contribution scope")
            acceptMaterial(repair.material, failure.itemIndex)
          } catch (error) { stageGap("collect", failure.raw, `${failure.error}; repair: ${String(error)}`, group) }
        }
      }
      analysis.unresolved.push(...material.unresolved)
      analysis.coverage.reviewedChunkIDs.push(...group.map((c) => c.chunkID))
      const reviewed = new Set(analysis.coverage.reviewedChunkIDs)
      analysis.coverage.remainingChunkIDs = chunks.filter((c) => !reviewed.has(c.chunkID)).map((c) => c.chunkID)
    }
    analysis.status = analysis.materialGaps!.length ? "partial" : "complete"
    PaperAnalysisSchema.parse(analysis)
    const modelAnalysis = { ...analysis, contributions: indexedContributions, sources: projectSources(analysis.sources) }
    const projectCandidate = (candidate: KnowledgeCandidateV2) => ({ ...candidate, sources: candidate.sources.map((s) => s.sourceID) })
    const wire = (schema: z.ZodType) => ({ schema, decode: (value: unknown) => {
      const hydrated = hydrateCandidateSources(value, registry) as { candidates?: Array<Omit<KnowledgeCandidateV2, "principle">>; candidate?: Omit<KnowledgeCandidateV2, "principle"> | null }
      const complete = (candidate: Omit<KnowledgeCandidateV2, "principle">) => {
        const assertion = candidate.assertions.find((a) => a.assertionID === candidate.principleAssertionID && a.kind === "principle")
        if (!assertion) throw new Error("Missing primary principle assertion")
        return { ...candidate, principle: assertion.statement }
      }
      return { ...hydrated,
        ...(hydrated.candidates ? { candidates: hydrated.candidates.map(complete) } : {}),
        ...(hydrated.candidate ? { candidate: complete(hydrated.candidate) } : {}),
      }
    } })
    let generationIncomplete = false
    const completedStatus = () => analysis.materialGaps!.length || generationIncomplete ? "partial" as const : "completed" as const
    function checkCandidates(candidates: KnowledgeCandidateV2[], allowBindingRepair = false) {
      if (new Set(candidates.map((c) => c.candidateID)).size !== candidates.length) throw new Error("Duplicate candidate ID")
      const principles = candidates.map((c) => c.principle.toLowerCase().replace(/\s+/g, " ").trim())
      if (new Set(principles).size !== principles.length) throw new Error("duplicate_principle:identical_statement")
      const sources = new Map(analysis.sources.map((s) => [s.sourceID, s]))
      for (const candidate of candidates) {
        if (!candidate.contributionIndexes?.length || candidate.contributionIndexes.some((i) => i >= analysis.contributions.length)) throw new Error("Candidate must reference valid contribution indexes")
        const errors = validateKnowledgeCandidate(candidate, context)
        if (errors.length && !(allowBindingRepair && errors.every((e) => e.startsWith("unsupported_assertion:") || e.startsWith("assertion_mismatch:scope:") || e.startsWith("unbound_experiment:")))) throw new Error(errors.join(";"))
        for (const source of candidate.sources) if (JSON.stringify(KnowledgeSourceSchema.parse(sources.get(source.sourceID))) !== JSON.stringify(source)) throw new Error(`Candidate changed analysis source: ${source.sourceID}`)
      }
    }
    async function repairBindings(candidate: KnowledgeCandidateV2) {
      const errors = validateKnowledgeCandidate(candidate, context)
      if (!errors.length) return candidate
      let repaired = candidate
      await call("repair_bindings", BindingRepairSchema, { candidate: projectCandidate(candidate), errors, analysis: modelAnalysis }, (patch) => {
        const next = structuredClone(candidate)
        for (const [index, binding] of (patch.sourceBindings ?? []).entries()) {
          if (binding.assertionIDs.some((id) => !next.assertions.some((a) => a.assertionID === id))) throw new Error("Source binding references unknown assertion")
          if (binding.experimentID && !next.experiments.some((e) => e.experimentID === binding.experimentID)) throw new Error("Source binding references unknown experiment")
          // New graph edges select immutable original sources, never new observations.
          const evidenceID = `binding_${digest([candidate.candidateID, index, binding]).slice(0, 20)}`
          next.support.push({ ...binding, evidenceID })
        }
        for (const link of patch.links) {
          const evidence = next.support.find((e) => e.evidenceID === link.evidenceID)
          if (!evidence || link.assertionIDs.some((id) => !next.assertions.some((a) => a.assertionID === id))) throw new Error("Binding patch references unknown evidence/assertion")
          evidence.assertionIDs = [...new Set([...evidence.assertionIDs, ...link.assertionIDs])]
        }
        for (const binding of patch.experimentBindings ?? []) {
          const evidence = next.support.find((e) => e.evidenceID === binding.evidenceID)
          const experiment = next.experiments.find((e) => e.experimentID === binding.experimentID)
          if (!evidence || evidence.kind !== "experiment" || !experiment) throw new Error("Experiment patch references unknown experiment/evidence or non-experimental evidence")
          if (binding.sourceIDs.some((id) => !experiment.sourceIDs.includes(id))) throw new Error("Experiment patch sources must belong to the existing experiment")
          evidence.experimentID = experiment.experimentID
          evidence.sourceIDs = [...new Set([...evidence.sourceIDs, ...binding.sourceIDs])]
        }
        if (patch.scopeReplacements.length) {
          const invalid = next.observedScope.filter((s) => next.assertions.find((a) => a.assertionID === s.assertionID)?.kind !== "scope")
          if (!invalid.length) throw new Error("No invalid scope binding to replace")
          next.observedScope = next.observedScope.filter((s) => !invalid.includes(s))
          for (const [index, scope] of patch.scopeReplacements.entries()) {
            const assertionID = `scope_${digest([candidate.candidateID, index, scope.statement, scope.sourceIDs]).slice(0, 20)}`
            if (next.assertions.some((a) => a.assertionID === assertionID)) throw new Error("Scope repair identity collision")
            next.assertions.push({ assertionID, kind: "scope", statement: scope.statement })
            next.observedScope.push({ assertionID, sourceIDs: scope.sourceIDs })
          }
        }
        next.unknowns.push(...patch.unresolved)
        repaired = KnowledgeCandidateSchema.parse(hydrateCandidateSources(projectCandidate(next), registry))
        checkCandidates([repaired])
      })
      return repaired
    }
    const plan = await call("plan", PlanSchema, { analysis: modelAnalysis }, (value) => {
      if (new Set(value.plans.map((p) => p.planID)).size !== value.plans.length) throw new Error("Duplicate principle plan ID")
      if (value.plans.some((p) => p.contributionIndexes.some((i) => i >= analysis.contributions.length))) throw new Error("Unknown planned contribution")
    })
    result.plans = plan.plans
    result.unformed.push(...plan.unformed)
    const synthesized = { candidates: [] as KnowledgeCandidateV2[] }
    for (const focus of plan.plans) {
      try {
        const item = await call("synthesize", SynthesisSchema, { analysis: modelAnalysis, focus }, (value) => {
        for (const candidate of value.candidates) candidate.candidateID = focus.planID
        checkCandidates(value.candidates, true)
        if (value.candidates.some((c) => JSON.stringify(c.contributionIndexes) !== JSON.stringify(focus.contributionIndexes))) throw new Error("Candidate changed planned contribution scope")
      }, wire(SynthesisWireSchema))
        for (const candidate of item.candidates) synthesized.candidates.push(await repairBindings(candidate))
        result.unformed.push(...item.unformed)
      } catch (error) {
        input.signal?.throwIfAborted()
        if (error instanceof IncompleteAnalysis) throw error
        generationIncomplete = true
        result.rejected.push({ candidateID: focus.planID, reasons: ["candidate_generation_failed", String(error)] })
        result.dispositions.push({ originalCandidateID: focus.planID, finalCandidateIDs: [], action: "rejected", rationale: String(error) })
      }
    }
    checkCandidates(synthesized.candidates)
    result.candidates = synthesized.candidates
    if (!synthesized.candidates.length) { result.status = completedStatus(); return result }
    const availableSourceIDs = analysis.sources.map((s) => s.sourceID)
    const reviewIDs = new Set(analysis.sources.map((s) => s.chunkID))
    const reviewChunks = chunks.filter((c) => reviewIDs.has(c.chunkID)
      || ["limitations", "results", "ablation", "experiment_setup"].includes(c.sectionKind))
    // Original text occurs once. Source spans resolve by offsets into originalChunks;
    // no summary-based filtering can hide adverse or uncited experimental material.
    const reviewAnalysis = { ...analysis, contributions: indexedContributions, sources: analysis.sources.map(({ sourceID, chunkID, spanStart, spanEnd }) => ({ sourceID, chunkID, spanStart, spanEnd })) }
    const verify = async (candidate: KnowledgeCandidateV2, siblings: KnowledgeCandidateV2[], phase: "initial" | "final") => {
      const candidateHash = knowledgeCandidateHash(candidate)
      const related = [...new Map([...siblings, ...synthesized.candidates]
        .map((c) => [knowledgeCandidateHash(c), c])).entries()].filter(([hash]) => hash !== candidateHash)
      const review = await call("verify", PrincipleReviewSchema, {
        phase, candidate: projectCandidate(candidate), candidateHash, analysis: reviewAnalysis, originalChunks: reviewChunks,
        relatedCandidates: related.map(([hash, c]) => ({ candidateHash: hash, candidate: projectRelatedPrinciple(c) })),
        siblingCandidateHashes: siblings.filter((c) => c.candidateID !== candidate.candidateID).map(knowledgeCandidateHash),
        originalCandidateHashes: synthesized.candidates.map(knowledgeCandidateHash),
      }, (value) => {
        if (value.candidateID !== candidate.candidateID || value.candidateHash !== knowledgeCandidateHash(candidate)) throw new Error("Review identity mismatch")
        const errors = validatePrincipleReviewEnvelope(candidate, value, availableSourceIDs)
        if (errors.length) throw new Error(`Review response incomplete or inconsistent: ${errors.join(";")}. Re-read the supplied sources and return a complete, internally consistent review; acceptance is not required.`)
      })
      result.reviews.push(review)
      return review
    }
    const eligible: KnowledgeCandidateV2[] = []
    for (const candidate of synthesized.candidates) {
      const blocked = analysis.materialGaps!.filter((gap) => gap.affectsAllContributions
        || gap.contributionIndexes.some((i) => candidate.contributionIndexes!.includes(i)))
      if (blocked.length) {
        result.rejected.push({ candidateID: candidate.candidateID, reasons: ["material_evidence_gap", ...blocked.map((g) => g.gapID)] })
        result.dispositions.push({ originalCandidateID: candidate.candidateID, finalCandidateIDs: [], action: "rejected", rationale: "Unresolved analysis material affects this contribution" })
        continue
      }
      const review = await verify(candidate, synthesized.candidates, "initial")
      if (review.verdict === "needs_revision") {
        try {
          const revised = await call("revise", RevisionSchema, { candidate: projectCandidate(candidate), review,
            revisionTargets: review.assertionReviews.filter((a) => !isSourceSupportedAssertion(a)),
            analysis: reviewAnalysis, originalChunks: reviewChunks }, (value) => {
            if (!value.candidate) return
            if (value.candidate.candidateID !== candidate.candidateID) throw new Error("Revision must preserve candidate identity")
            if (JSON.stringify(value.candidate.contributionIndexes) !== JSON.stringify(candidate.contributionIndexes)) throw new Error("Revision changed contribution scope")
            checkCandidates([value.candidate], true)
          }, wire(RevisionWireSchema))
          if (revised.candidate) { eligible.push(await repairBindings(revised.candidate)); continue }
          result.rejected.push({ candidateID: candidate.candidateID, reasons: [...review.reasons, revised.reason] })
        } catch (error) {
          input.signal?.throwIfAborted()
          if (error instanceof IncompleteAnalysis || result.calls.at(-1)?.response === undefined) throw error
          generationIncomplete = true
          result.rejected.push({ candidateID: candidate.candidateID, reasons: ["candidate_revision_failed", String(error)] })
        }
      } else {
        const errors = validatePrincipleReview(candidate, review, availableSourceIDs)
        if (!errors.length) { eligible.push(candidate); continue }
        result.rejected.push({ candidateID: candidate.candidateID, reasons: [...errors, ...review.reasons] })
      }
      result.dispositions.push({ originalCandidateID: candidate.candidateID, finalCandidateIDs: [], action: "rejected", rationale: review.explanation })
    }
    if (!eligible.length) { result.status = completedStatus(); return result }
    const grouping = await call("consolidate", ConsolidationWireSchema, { analysis: modelAnalysis, candidates: eligible.map(projectCandidate) }, (value) => {
      const ids = value.groups.flatMap((g) => g.candidateIDs)
      if (ids.length !== eligible.length || new Set(ids).size !== ids.length || ids.some((id) => !eligible.some((c) => c.candidateID === id))) throw new Error("Missing, duplicate or unknown disposition candidate")
      if (value.groups.some((g) => g.action === "retain" && g.candidateIDs.length !== 1)) throw new Error("Retain group must have one candidate")
    })
    const consolidated = { candidates: [] as KnowledgeCandidateV2[] }
    for (const group of grouping.groups) {
      const originals = eligible.filter((c) => group.candidateIDs.includes(c.candidateID))
      let final: KnowledgeCandidateV2 | null = group.action === "retain" ? originals[0] : null
      if (group.action === "merge") {
        const merged = await call("merge", RevisionSchema, { analysis: modelAnalysis, originals: originals.map(projectCandidate), rationale: group.rationale }, (value) => {
          if (!value.candidate) return
          checkCandidates([value.candidate])
          const candidate = value.candidate
          const expected = [...new Set(originals.flatMap((c) => c.contributionIndexes!))].sort()
          if (JSON.stringify([...new Set(candidate.contributionIndexes!)].sort()) !== JSON.stringify(expected)) throw new Error("Merge changed contribution scope")
        }, wire(RevisionWireSchema))
        final = merged.candidate
      }
      if (final) consolidated.candidates.push(final)
      result.dispositions.push(...originals.map((original) => ({
        originalCandidateID: original.candidateID, finalCandidateIDs: final ? [final.candidateID] : [],
        action: final ? group.action === "retain" ? "retained" as const : "merged" as const : "rejected" as const,
        rationale: group.rationale,
      })))
    }
    checkCandidates(consolidated.candidates)
    result.finalCandidates = consolidated.candidates
    // All source chunks behind the analysis, including adverse material, reach the
    // independent verifier. Never silently truncate them to fit the call budget.
    for (const candidate of consolidated.candidates) {
      const gaps = analysis.materialGaps!.filter((gap) => gap.affectsAllContributions || gap.contributionIndexes.some((i) => candidate.contributionIndexes!.includes(i)))
      if (gaps.length) {
        result.rejected.push({ candidateID: candidate.candidateID, reasons: ["material_evidence_gap", ...gaps.map((g) => g.gapID)] })
        continue
      }
      const review = await verify(candidate, consolidated.candidates, "final")
      const errors = validatePrincipleReview(candidate, review, availableSourceIDs)
      if (errors.length) { result.rejected.push({ candidateID: candidate.candidateID, reasons: [...errors, ...review.reasons] }); continue }
      result.cards.push(finalizeKnowledgeCandidate({ candidate, review, context, availableSourceIDs, provenance: {
        documentSha256: document.sourceSha256, analysisHash: digest(analysis), extractionRunID: input.runID,
        extractorModel: model.modelIdentifier, verifierModel: verifier.modelIdentifier,
        synthesisVersion: KNOWLEDGE_V2_VERSIONS.synthesis, verifierVersion: KNOWLEDGE_V2_VERSIONS.verifier,
        createdAt: new Date().toISOString(),
      } }))
    }
    result.status = completedStatus()
  } catch (error) {
    input.signal?.throwIfAborted()
    result.errors.push(String(error))
    // Partial results are audit-only; publication is atomic at paper granularity.
    result.cards = []
  }
  return result
}
