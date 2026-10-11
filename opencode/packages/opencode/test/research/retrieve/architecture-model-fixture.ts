import type { PrincipleModel, PrincipleStage } from "../../../src/research/literature/principle-model"

export const eligibilityRecipe = {
  recipeVersion: "recipe_schema_v3", hypothesis: "Synthetic supported prediction rule", recipeID: "fixture_admission",
  representation: { layout: "channel_latent", readout: "none", latentDim: 64 }, composition: { type: "single" },
  preprocessing: { actions: [{ type: "none" }] }, embedding: { type: "none" },
  backbone: { type: "linear", shared: true, bias: true }, fusion: { type: "temporal", channelMode: "independent" },
  predictionHead: { type: "linear", outputDistribution: "point" }, trainingStrategy: {
    loss: { base: "mse", horizonWeighting: "uniform" }, optimizer: { type: "adam", lr: 0.001, weightDecay: 0 },
    scheduler: { type: "none", warmupSteps: 0 }, regularization: { gradClip: 1 },
    budget: { maxEpochs: 10, timeBudgetS: 1200, batchSize: 32, patience: 3, seed: 42 },
  },
}

export function fixtureModel(keepCardID?: string) {
  const calls: PrincipleStage[] = []
  const model: PrincipleModel = { modelIdentifier: "fixture:architecture:16384", async request(stage, payload) {
    calls.push(stage)
    const cards = payload.cards as any[]
    const decisions = payload.decisions as any[]
    if (stage === "architecture_recall") return { text: JSON.stringify({ selected: cards.map((c) => c.cardID), excluded: [] }) }
    if (stage === "architecture_extract") return { text: JSON.stringify({ decisions: cards.map((c, i) => {
      const refs = [{ cardID: c.cardID, sourceIDs: [c.sources[0].sourceID] }]
      return { decisionID: `d${i}`, dataCondition: "Numerical univariate prediction", prefer: "Use an ordered temporal encoder",
        avoid: "Discarding input order", mechanism: "Preserve order for prediction", observedEffect: "Synthetic scoped accuracy observation",
        evidenceLevel: "mixed", limitations: ["Synthetic fixture, not scientific evidence"], taskFit: "supported", taskReason: "The report contains a numerical target",
        citations: { condition: refs, choice: refs, mechanism: refs, effect: refs } }
    }), unused: [] }) }
    if (stage === "architecture_review") return { text: JSON.stringify({ reviews: decisions.map((d) => ({
      decisionID: d.decisionID, verdict: "accepted", reason: "Synthetic source supports a scoped relationship",
      reviewedSources: d.citations.condition,
      eligibility: {
        implementation: "family_supported", implementationReason: "Synthetic valid linear family", familyMappings: [{ family: "affine_temporal", role: "prefer", rationale: "Synthetic linear-family rationale", transferBoundaries: ["Latent-to-head implementation, not original paper operator"] }], recipe: eligibilityRecipe, requiredMechanisms: [],
        target: "matched", targetReason: "The supplied dataset has a numerical target", conditions: [{
          condition: "Numerical target is available", path: "$.quantitativeReport.dataset.targetColumns",
          value: (payload.task as any)?.quantitativeReport?.dataset?.targetColumns ?? ["load"], status: "matched", scope: "forecast_targets",
        }], conditionLogic: [{ alternatives: [0], sourceRationale: "Synthetic numerical-target prerequisite", sourceRefs: d.citations.condition }],
        objective: "prediction", predictionReason: "Synthetic accuracy evidence",
        requiredData: { knownFutureCovariates: false, staticCovariates: false },
      },
      revisionAdvice: { action: "none", reason: "No repair needed for this synthetic fixture" },
      checks: { dataCondition: true, nonCircular: true, structuralChoice: true, sourceFaithful: true, counterevidencePreserved: true, taskFitCorrect: true,
        conditionLogicPreserved: true, inputOutputDistinguished: true, familyAbstraction: true, noLocalReplication: true },
    })) }) }
    if (stage === "architecture_revise") return { text: JSON.stringify({ decision: payload.previousDecision, reason: "Synthetic revision fixture" }) }
    if (stage === "architecture_curate") {
      const accepted = keepCardID ? decisions.filter((d) => d.citations.condition.some((r: any) => r.cardID === keepCardID)) : decisions.slice(0, 1)
      return { text: JSON.stringify({ selectedDecisionIDs: accepted.map((d) => d.decisionID), excluded: decisions.filter((d) => !accepted.includes(d))
        .map((d) => ({ decisionID: d.decisionID, reason: "Duplicate or not useful for a structural decision" })) }) }
    }
    throw new Error(`Unexpected stage ${stage}`)
  } }
  return { model, calls }
}
