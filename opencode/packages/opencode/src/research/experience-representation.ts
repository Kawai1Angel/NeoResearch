import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { assessAttribution } from "./attribution"
import { ExperimentConstraints, recipeFields } from "./experiment-constraints"
import { reflectionExecutionEvidence } from "./runner-evidence"
import type { ExperimentFact, ResearchExperience } from "./experience"

export const EXPERIENCE_REPRESENTATION_VERSION = "experience_evidence.v2"

/** A deterministic view, never a rewrite or scientific promotion of the source record. */
export function experienceRepresentation(experience: ResearchExperience) {
  const facts = [...new Map(experience.facts.map(fact => [fact.runID, fact])).values()]
  const observations = facts.map(fact => {
    const execution = reflectionExecutionEvidence({ status: fact.status, error: fact.error, metrics: fact.metrics,
      resourceUsage: { executionContract: { status: fact.executionVerified ? "verified" : "unverified" },
        independentEvidence: fact.independentEvidence, verification: { status: fact.evaluationDecision?.verificationStatus } },
    }, fact.primaryMetric)
    return { runID: fact.runID, taskID: fact.taskID, stage: fact.stage,
      recordedStatus: fact.status, executionStatus: execution.status,
      ...(fact.status !== execution.status ? { historicalEvaluationError: fact.error } : {}),
      error: execution.error, primaryMetric: fact.primaryMetric, primaryValue: fact.primaryValue,
      direction: fact.direction, executionVerified: fact.executionVerified, independentEvidence: fact.independentEvidence }
  })
  const configurations = facts.map(fact => ({ runID: fact.runID,
    status: fact.executionVerified && fact.executedModel ? "execution_verified" : "proposed_only",
    // Recipe fields exclude hypothesis, notes and IDs: these often describe untested plans.
    recipe: fact.proposedModel ? recipeFields(fact.proposedModel) : undefined,
    actual: fact.executedModel,
  }))
  const interventions = facts.flatMap(fact => {
    const parsed = ExperimentConstraints.safeParse(fact.hypothesisSnapshot?.experimentContract)
    if (!parsed.success || parsed.data.mode !== "controlled") return []
    const comparison = facts.find(other => other.runID === parsed.data.comparisonRunID)
    const attribution = assessAttribution(fact, comparison)
    const sameProtocol = comparison && comparison.taskID === fact.taskID &&
      comparison.dataset.identity === fact.dataset.identity &&
      isDeepStrictEqual(comparison.evaluation, fact.evaluation) &&
      comparison.primaryMetric === fact.primaryMetric && comparison.direction === fact.direction
    const eligible = attribution.status === "eligible" && Boolean(sameProtocol)
    const observed = eligible && fact.stage === "full" && comparison?.stage === "full" &&
      observations.find(x => x.runID === fact.runID)?.executionStatus === "succeeded" &&
      observations.find(x => x.runID === comparison?.runID)?.executionStatus === "succeeded" &&
      fact.executionVerified && comparison?.executionVerified && fact.independentEvidence && comparison?.independentEvidence &&
      fact.primaryValue !== undefined && comparison?.primaryValue !== undefined
    const delta = observed ? fact.primaryValue! - comparison!.primaryValue! : undefined
    return [{ runID: fact.runID, comparisonRunID: parsed.data.comparisonRunID!,
      status: eligible ? "verified_changes" : "declared_changes_only",
      attributionScope: parsed.data.changes.length === 1 ? "single_declared_field" : "joint_declared_changes",
      changes: parsed.data.changes, changedPaths: attribution.changedPaths,
      attributionReasons: eligible ? [] : [...attribution.reasons, ...(!sameProtocol ? ["Matched dataset/evaluation evidence unavailable."] : [])],
      ...(delta !== undefined ? { contrast: { primaryMetric: fact.primaryMetric, control: comparison!.primaryValue!,
        trial: fact.primaryValue!, delta, relativeDelta: comparison!.primaryValue === 0 ? undefined : delta / Math.abs(comparison!.primaryValue!),
        measuredDirection: delta === 0 ? "unchanged" : (fact.direction === "minimize" ? delta < 0 : delta > 0) ? "improved" : "worsened",
        uncertainty: "Statistical significance and transferability are not established by this numerical direction.",
      } } : {}),
    }]
  })
  const scope = facts.map(fact => ({ runID: fact.runID, dataset: fact.dataset, evaluation: fact.evaluation,
    taskFingerprint: fact.taskFingerprint,
    seed: ((fact.proposedModel?.trainingStrategy as Record<string, unknown> | undefined)?.budget as Record<string, unknown> | undefined)?.seed,
    runtime: fact.runtimeContext ?? { status: "historical_runtime_provenance_incomplete" },
    runtimeSemanticsRevision: fact.executedModel?.runtime_semantics_revision,
    parameterGraphDigest: fact.executedModel?.parameter_graph_digest,
  }))
  const summary = observations.map(observation => {
    const changes = interventions.find(change => change.runID === observation.runID)
    const config = configurations.find(config => config.runID === observation.runID)!
    const actual = config.actual ?? {}
    return `${observation.runID}: ${observation.stage}/${observation.executionStatus}; ` +
      `${actual.backbone ?? "backbone unverified"}; ${changes?.status === "verified_changes" ? JSON.stringify(changes.changes) : "no verified controlled changes"}; ` +
      `${observation.primaryMetric}=${observation.primaryValue ?? "unavailable"}` +
      (observation.error ? `; observed error: ${observation.error.slice(0, 1500)}` : "")
  }).join("\n")
  const evidenceKey = createHash("sha256").update(JSON.stringify(facts.map(fact =>
    [fact.runID, fact.dataset.identity, fact.primaryMetric]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest("hex")
  return { version: EXPERIENCE_REPRESENTATION_VERSION, summary, observations, interventions, configurations,
    scope, evidenceKey,
    evidenceScope: { distinctRuns: facts.length,
      independentRunIDs: facts.filter(fact => fact.independentEvidence).map(fact => fact.runID),
      datasetContentHashes: [...new Set(facts.flatMap(fact => fact.dataset.contentHash ? [fact.dataset.contentHash] : []))],
      seeds: [...new Set(scope.flatMap(item => item.seed === undefined ? [] : [item.seed]))],
      replicationStatus: "Run/seed counts describe coverage; they do not certify independent replication or significance.",
    },
    // A failed run plus a suggested repair is not evidence that the repair worked.
    executionLesson: { status: observations.some(observation => observation.error) ? "failure_observed" : "no_failure_observed",
      diagnosis: "unverified", repair: "not_established" },
    interpretation: { status: "unverified_interpretation", ...(experience.unverifiedInterpretation ?? experience.draft) },
    limitations: ["Observed conditions are source scope, not verified transfer rules.",
      "Numerical direction is not a significance test or a mechanism explanation.",
      "Historical evaluation rejection is preserved separately from observed runtime errors.",
      "No semantic truth certification of model-authored prose is implied by schema/evidence validation."],
  }
}
