import { expect, test } from "bun:test"
import { includesPhrase, type BM25SearchResult } from "../../../src/research/retrieve/bm25-search"
import { buildRetrievalCandidates, paperScope, selectBridgeCandidates } from "../../../src/research/retrieve/candidate-selector"
import { fixture } from "./fixtures"
import { CLASSIC_PAPERS, classicPaperName } from "../../../src/research/retrieve/classic-library"
import { unsupportedModelRecipeMechanisms } from "../../../src/research/retrieve/model-recipe-screen"
import { TSFDomain } from "../../../src/research/domains/tsf"

function result(title: string, rank: number, introduction = ""): BM25SearchResult {
  return { rank, score: 100 - rank, matchedFields: ["title"], matchedTerms: ["structural breaks"],
    paper: { paperID: `paper-${rank}`, title, localPDF: true, publicationStatus: "unknown", evidenceLevel: "metadata_only",
      fields: { title, abstract: "", introduction, method: "", results: "", limitations: "", knowledgeCard: "" } } }
}

test("reused paper-intent pairs leave per-intent and global quotas for new papers", () => {
  const intent = fixture().intents.find((item) => item.intentID.includes("structural_break"))!
  const results = [1, 2, 3, 4].map((rank) => result("Time Series Forecasting under Structural Breaks", rank))
  const covered = new Set([1, 2].map((rank) => `paper-${rank}\0${intent.intentID}`))
  const candidates = buildRetrievalCandidates(intent, results, 2, false, [], covered)
  expect(candidates.filter((c) => c.decision === "reuse_knowledge")).toHaveLength(2)
  expect(selectBridgeCandidates(candidates, { maxLiteraturePapersTotal: 2 }).map((p) => p.paperID)).toEqual(["paper-3", "paper-4"])
  const onlyReusedClassic = results.map((item, index) => ({ ...item, recallRoute: index === 0 ? "classic_library" as const : "source_catalog" as const }))
  expect(selectBridgeCandidates(buildRetrievalCandidates(intent, onlyReusedClassic, 2, false, [], covered),
    { maxLiteraturePapersTotal: 2 }).map((p) => p.paperID)).toEqual(["paper-3", "paper-4"])
  // Force supplies an empty reuse set and still refreshes the original best-ranked papers.
  expect(selectBridgeCandidates(buildRetrievalCandidates(intent, results, 2), { maxLiteraturePapersTotal: 2 }).map((p) => p.paperID)).toEqual(["paper-1", "paper-2"])
})

test("partial structural match cannot pass the scientific screen", () => {
  expect(includesPhrase("Patch-wise Structural Loss", "structural breaks")).toBe(false)
  const intent = fixture().intents.find((item) => item.intentID.includes("structural_break"))!
  const candidates = buildRetrievalCandidates(intent, [result("Patch-wise Structural Loss", 1)], 5)
  expect(candidates[0]!.decision).toBe("domain_only")
})

test("fine screening defers vertical papers when a general forecasting paper covers the intent", () => {
  const intent = fixture().intents.find((item) => item.intentID.includes("structural_break"))!
  const vertical = result("Job Skill Demand Forecasting under Structural Breaks", 1)
  const general = result("Time Series Forecasting under Structural Breaks", 2)
  const candidates = buildRetrievalCandidates(intent, [vertical, general], 2)
  expect(candidates.find((item) => item.paperID === "paper-1")).toMatchObject({
    paperScope: "domain_specific", decision: "domain_specific",
  })
  expect(candidates.find((item) => item.paperID === "paper-2")).toMatchObject({
    paperScope: "general", decision: "send_to_literature_agent",
  })
  expect(selectBridgeCandidates(candidates, { maxLiteraturePapersTotal: 2 }).map((item) => item.paperID)).toEqual(["paper-2"])
  expect(buildRetrievalCandidates(intent, [vertical], 2)[0]!.decision).toBe("send_to_literature_agent")
  expect(paperScope("Are Transformers Effective for Time Series Forecasting?")).toBe("general")
  expect(paperScope("Stock Trend Prediction Based on Improved GRU")).toBe("domain_specific")
})

test("global reading budget uses general papers before vertical fallback", () => {
  const intents = fixture().intents.slice(0, 2)
  const vertical = buildRetrievalCandidates(intents[0]!, [result("Traffic Forecasting under Structural Breaks", 1)], 1)
  const general = buildRetrievalCandidates(intents[1]!, [result("General Time Series Forecasting", 2,
    intents[1]!.paperLanguageQuery.phenomenonTerms.join(" "))], 1)
  const selected = selectBridgeCandidates([...vertical, ...general], { maxLiteraturePapersTotal: 1 })
  expect(selected[0]?.paperID).toBe("paper-2")
})

test("supported feature fusion outranks background mentions while correlation attention is screened", () => {
  const intent = { ...fixture().intents[0]!, intentID: "intent_lead_lag_relationship_fixture", paperLanguageQuery: {
    taskTerms: ["forecasting"], phenomenonTerms: ["lead-lag relationship"], methodTerms: ["lag-aware feature fusion"], domainTerms: [], queryText: "lead lag correlation forecasting",
  } }
  const papers = Array.from({ length: 5 }, (_, i) => result("Forecasting overview", i + 1, "Prior work models lead lag dependencies."))
  const values = buildRetrievalCandidates(intent, [...papers,
    result("Variable Correlation Transformer with Inherent Lagged Correlation", 10),
    result("Lead-lag Relationship Feature Fusion for Forecasting", 11)], 1)
  expect(values.find((item) => item.paperID === "paper-10")!.decision).toBe("send_to_literature_agent")
  expect(selectBridgeCandidates(values, { maxLiteraturePapersTotal: 1 })[0]!.paperID).toBe("paper-10")
})

test("conformal change-point work is auxiliary for point forecasting", () => {
  const intent = fixture().intents.find((item) => item.intentID.includes("structural_break"))!
  const paper = result("Conformal Prediction with Change Points", 1)
  expect(buildRetrievalCandidates(intent, [paper], 5, false)[0]!.decision).toBe("retain_candidate")
  expect(buildRetrievalCandidates(intent, [paper], 5, true)[0]!.decision).toBe("send_to_literature_agent")
})

test("known unavailable paper operator is recorded without vetoing transferable family discovery", () => {
  const intent = fixture().intents[0]!
  const original = result("TimeXer: Empowering Transformers for Time Series Forecasting with Exogenous Variables", 1)
  const paper = { ...original, paper: { ...original.paper, paperID: "timexer" } }
  const candidates = buildRetrievalCandidates(intent, [{ ...paper, recallRoute: "classic_library" }], 5)
  expect(candidates[0]!.decision).toBe("send_to_literature_agent")
  expect(candidates[0]!.recallRoute).toBe("classic_library")
  expect(candidates[0]!.decisionReasons.join(" ")).toContain("exogenous_cross_attention")
  expect(selectBridgeCandidates(candidates, { maxLiteraturePapersTotal: 5 })).toHaveLength(1)
  expect(unsupportedModelRecipeMechanisms(result("PatchTST: patch forecasting", 2).paper)).toHaveLength(0)
})

test("source-hash-bound compatibility review retains transferable knowledge without claiming exact implementation", () => {
  const intent = { ...fixture().intents[0]!, paperLanguageQuery: {
    taskTerms: ["forecasting"], phenomenonTerms: ["lagged correlation"], methodTerms: [], domainTerms: [], queryText: "lagged correlation forecasting",
  } }
  const original = result("VCformer: Variable Correlation Transformer with Inherent Lagged Correlation for Multivariate Time Series Forecasting", 1)
  const paper = { ...original, paper: { ...original.paper, sourceSha256: "paper-sha" } }
  const review = { paperID: paper.paper.paperID, sourceSha256: "paper-sha", verdict: "adaptable" as const,
    reason: "Lagged variable interactions can inform existing variate fusion." }
  expect(buildRetrievalCandidates(intent, [paper], 2)[0]!.decision).toBe("send_to_literature_agent")
  expect(buildRetrievalCandidates(intent, [paper], 2, false, [{ ...review, sourceSha256: "stale-sha" }])[0]!.decision)
    .toBe("send_to_literature_agent")
  const reviewed = buildRetrievalCandidates(intent, [paper], 2, false, [review])[0]!
  expect(reviewed.decision).toBe("send_to_literature_agent")
  expect(reviewed.decisionReasons.join(" ")).toContain("exact lagged_correlation_attention remains unavailable")
  expect(reviewed.decisionReasons.join(" ")).toContain("source-hash-bound compatibility review adaptable")
  const negative = buildRetrievalCandidates(intent, [paper], 2, false, [{ ...review, verdict: "research_only" }])[0]!
  expect(negative.decision).toBe("unsupported_model_recipe")
  expect(negative.decisionReasons.join(" ")).toContain("no transferable ModelRecipe mechanism")
})

test("background mentions do not turn an implemented paper into an unsupported mechanism", () => {
  const paper = result("Patch forecasting", 1).paper
  expect(unsupportedModelRecipeMechanisms({ ...paper, fields: { ...paper.fields,
    abstract: "Prior work uses wavelets. We propose patch embedding for forecasting." } })).toHaveLength(0)
  expect(unsupportedModelRecipeMechanisms({ ...paper, fields: { ...paper.fields,
    abstract: "We propose wavelet decomposition for forecasting." } }).map((item) => item.mechanism)).toContain("wavelet_decomposition")
  expect(unsupportedModelRecipeMechanisms({ ...paper, fields: { ...paper.fields,
    introduction: "Previous work uses patches. Our model uses Koopman dynamics for long-range forecasts." } }).map((item) => item.mechanism)).toContain("koopman_dynamics")
  expect(unsupportedModelRecipeMechanisms({ ...paper, fields: { ...paper.fields,
    abstract: "We compare our patch model with Informer." } })).toHaveLength(0)
})

test("expanded classics with missing core operations remain in the library but fail screening", () => {
  const dcrnn = result("Diffusion Convolutional Recurrent Neural Network: Data-Driven Traffic Forecasting", 1)
  expect(unsupportedModelRecipeMechanisms(dcrnn.paper).map((item) => item.mechanism)).toEqual(["diffusion_graph_convolution"])
  expect(unsupportedModelRecipeMechanisms(result("DeepAR: Probabilistic Forecasting with Autoregressive Recurrent Networks", 2).paper)
    .map((item) => item.mechanism)).toContain("autoregressive_recurrent_decoder")
  expect(unsupportedModelRecipeMechanisms(result("TSMixer: Lightweight MLP-Mixer Model for Multivariate Time Series Forecasting", 3).paper)).toHaveLength(0)
  expect(unsupportedModelRecipeMechanisms(result("Frequency-domain MLPs are More Effective Learners in Time Series Forecasting", 4).paper)).toHaveLength(0)
})

test("ETTh1 source papers with unimplemented core operations fail screening", () => {
  const cases = [
    ["Rethinking Channel Dependence for Multivariate Time Series Forecasting: Learning from Leading Indicators", "adaptive_leading_indicator_plugin"],
    ["RSAP-DFM: Regime-Shifting Adaptive Posterior Dynamic Factor Model for Stock Returns Prediction", "regime_switching_posterior_factor"],
    ["TimePro: Efficient Multivariate Long-term Time Series Forecasting with Variable- and Time-Aware Hyper-state", "variable_time_hyperstate"],
    ["CRAFT: Time Series Forecasting with Cross-Future Behavior Awareness", "cross_future_behavior"],
    ["ST-MTM: Masked Time Series Modeling with Seasonal-Trend Decomposition for Time Series Forecasting", "seasonal_trend_masked_pretraining"],
    ["iTrendRNN: An Interpretable Trend-Aware RNN for Meteorological Spatiotemporal Prediction", "spatiotemporal_flow_trend"],
    ["Improving Time Series Forecasting via Instance-aware Post-hoc Revision", "instance_aware_posthoc_revision"],
    ["From Text to Forecasts: Bridging Modality Gap with Temporal Evolution Semantic Space", "text_forecast_modal_alignment"],
    ["CometNet: Contextual Motif-guided Long-term Time Series Forecasting", "contextual_motif_retrieval"],
  ] as const
  for (const [title, mechanism] of cases) {
    expect(unsupportedModelRecipeMechanisms(result(title, 1).paper).map((item) => item.mechanism)).toContain(mechanism)
  }
})

test("classic library matches stable identifiers and reserves both recall routes", () => {
  expect(CLASSIC_PAPERS).toHaveLength(29)
  expect(CLASSIC_PAPERS.map((item) => item.name)).toEqual(expect.arrayContaining(["PatchTST", "DLinear", "iTransformer", "TimeXer"]))
  expect(new Set(CLASSIC_PAPERS.map((item) => item.name)).size).toBe(CLASSIC_PAPERS.length)
  expect(new Set(CLASSIC_PAPERS.map((item) => item.title)).size).toBe(CLASSIC_PAPERS.length)
  for (const paper of CLASSIC_PAPERS) {
    expect(paper.recipeComponents.length).toBeGreaterThan(0)
    for (const component of paper.recipeComponents) {
      const [kind, action] = component.split(".")
      expect(TSFDomain.info.actionRegistry[kind!]?.[action!]).toBeDefined()
    }
  }
  const patch = CLASSIC_PAPERS.find((item) => item.name === "PatchTST")!
  expect(classicPaperName({ title: "renamed title", arxivID: patch.arxivID })).toBe("PatchTST")
  expect(classicPaperName({ title: patch.title })).toBe("PatchTST")
  expect(classicPaperName({ title: "TSMixer: Lightweight MLP-Mixer Model for Multivariate Time Series Forecasting" })).toBe("TSMixer")
  expect(classicPaperName({ title: "TSMixer: An All-MLP Architecture for Time Series Forecasting" })).toBe("TSMixer (All-MLP)")
  expect(classicPaperName({ title: "Unrelated forecasting paper" })).toBeUndefined()
  const intent = { ...fixture().intents[0]!, paperLanguageQuery: {
    taskTerms: ["forecasting"], phenomenonTerms: ["seasonality"], methodTerms: ["patch"], domainTerms: [], queryText: "patch seasonality forecasting",
  } }
  const papers = [
    { ...result("Patch seasonality forecasting", 1), recallRoute: "source_catalog" as const },
    { ...result("Patch seasonality forecasting", 2), recallRoute: "source_catalog" as const },
    { ...result("Patch seasonality forecasting", 3), recallRoute: "classic_library" as const },
  ]
  const candidates = buildRetrievalCandidates(intent, papers, 2)
  expect(candidates.filter((item) => item.decision === "send_to_literature_agent").map((item) => item.recallRoute)).toEqual(["source_catalog", "classic_library"])
})

test("classic component matching retrieves papers whose titles omit the task phrase", () => {
  const intents = fixture().intents
  const long = intents.find((item) => item.intentID.includes("long_horizon"))!
  const breakIntent = intents.find((item) => item.intentID.includes("structural_break"))!
  const dlinear = buildRetrievalCandidates(long, [
    { ...result("Are Transformers Effective for Time Series Forecasting?", 1), recallRoute: "classic_library" },
  ], 2)
  const revin = buildRetrievalCandidates(breakIntent, [
    { ...result("Reversible Instance Normalization for Accurate Time-Series Forecasting against Distribution Shift", 1), recallRoute: "classic_library" },
  ], 2)
  expect(dlinear[0]!.decision).toBe("send_to_literature_agent")
  expect(dlinear[0]!.decisionReasons.join(" ")).toContain("backbone.dlinear")
  expect(revin[0]!.decision).toBe("send_to_literature_agent")
  expect(revin[0]!.decisionReasons.join(" ")).toContain("preprocessing.instance_norm")
})

test("a catalog PDF with another paper's first page is excluded before reading", () => {
  const intent = fixture().intents.find((item) => item.intentID.includes("structural_break"))!
  const paper = result("Reversible Instance Normalization for Accurate Time-Series Forecasting against Distribution Shift", 1,
    "On Hamilton-Jacobi PDEs and image denoising models with certain non-additive noise. ".repeat(12))
  const candidates = buildRetrievalCandidates(intent, [{ ...paper, recallRoute: "classic_library" }], 2)
  expect(candidates[0]!.decision).toBe("skipped_pdf_unavailable")
  expect(candidates[0]!.decisionReasons.join(" ")).toContain("PDF identity mismatch")
  expect(selectBridgeCandidates(candidates, { maxLiteraturePapersTotal: 2 })).toHaveLength(0)
})

test("total reading budget retains a classic when source candidates span many intents", () => {
  const intents = fixture().intents.slice(0, 3).map((intent) => ({ ...intent, paperLanguageQuery: {
    taskTerms: ["forecasting"], phenomenonTerms: ["seasonality"], methodTerms: ["patch"], domainTerms: [], queryText: "patch seasonality forecasting",
  } }))
  const candidates = intents.flatMap((intent, index) => buildRetrievalCandidates(intent, [
    { ...result("Patch seasonality forecasting", index + 1), recallRoute: "source_catalog" as const },
    { ...result("Patch seasonality forecasting", 10), recallRoute: "classic_library" as const },
  ], 2))
  const selected = selectBridgeCandidates(candidates, { maxLiteraturePapersTotal: 2 })
  expect(selected).toHaveLength(2)
  expect(selected.some((item) => item.paperID === "paper-10")).toBe(true)
})
