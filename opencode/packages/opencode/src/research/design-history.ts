import { comparisonRecipe } from "./comparison-run"
import { Database, and, desc, eq, inArray } from "@/storage"
import { ResearchArtifactTable, ResearchCandidateTable, ResearchRunTable, ResearchTaskTable } from "./research.sql"
import type { ResearchTaskID, ResearchRunID, ResearchCandidateID } from "./schema"
import { HistoryRequest } from "./design-feedback"
import { buildExperimentResultEvidence, recoverRunnerFailure, reflectionExecutionEvidence } from "./runner-evidence"

/** Task-scoped factual history, shared by native tools and direct LLM transport. */
export async function readDesignHistory(taskID: ResearchTaskID, args: HistoryRequest = {}, options: { forReflection?: boolean } = {}) {
  const request = HistoryRequest.parse(args)
  const limit = request.limit ?? 5
  const offset = request.offset ?? 0
  const hypothesisCandidates = args.hypothesisID
    ? Database.use((d) =>
        d
          .select({ id: ResearchCandidateTable.id })
          .from(ResearchCandidateTable)
          .where(
            and(
              eq(ResearchCandidateTable.task_id, taskID),
              eq(ResearchCandidateTable.hypothesis_id, args.hypothesisID!),
            ),
          )
          .all(),
      ).map((c) => c.id)
    : undefined

  const taskRow = Database.use((d) =>
    d
      .select({ objective: ResearchTaskTable.objective })
      .from(ResearchTaskTable)
      .where(eq(ResearchTaskTable.id, taskID))
      .get(),
  )
  const objective = taskRow?.objective as Record<string, unknown> | null | undefined
  const primaryMetric = typeof objective?.primaryMetric === "string" ? objective.primaryMetric : "val_avg_mse"

  const runs = Database.use((d) =>
    d
      .select()
      .from(ResearchRunTable)
      .where(
        and(
          eq(ResearchRunTable.task_id, taskID),
          args.runID ? eq(ResearchRunTable.id, args.runID as ResearchRunID) : undefined,
          args.candidateID ? eq(ResearchRunTable.candidate_id, args.candidateID as ResearchCandidateID) : undefined,
          hypothesisCandidates ? inArray(ResearchRunTable.candidate_id, hypothesisCandidates) : undefined,
          inArray(ResearchRunTable.status, ["succeeded", "failed", "invalid", "rejected"]),
        ),
      )
      .orderBy(desc(ResearchRunTable.time_updated))
      .limit(limit)
      .offset(offset)
      .all(),
  )

  const candidateIds = [...new Set(runs.map((r) => r.candidate_id).filter((id): id is ResearchCandidateID => !!id))]
  const candidateRows =
    candidateIds.length > 0
      ? Database.use((d) =>
          d
            .select({
              id: ResearchCandidateTable.id,
              candidate_spec: ResearchCandidateTable.candidate_spec,
              hypothesis_id: ResearchCandidateTable.hypothesis_id,
            })
            .from(ResearchCandidateTable)
            .where(inArray(ResearchCandidateTable.id, candidateIds))
            .all(),
        )
      : []
  const hypoIDByCandidate = new Map<string, string>()
  for (const c of candidateRows) {
    if (c.hypothesis_id) hypoIDByCandidate.set(c.id, c.hypothesis_id)
  }

  const candidateSpecByID = new Map(candidateRows.map((c) => [c.id, c.candidate_spec]))
  const results = await Promise.all(
    runs.map(async (r) => {
      const metrics = r.metrics as Record<string, unknown> | null | undefined
      const metricVal = metrics?.[primaryMetric]
      const hasMetric = typeof metricVal === "number" && Number.isFinite(metricVal)
      const stored = {
        status: r.status, error: r.error, metrics: metrics ?? {}, resourceUsage: r.resource_usage,
      }
      const evidence = options.forReflection ? reflectionExecutionEvidence(stored, primaryMetric) : stored
      const execution =
        (evidence.status !== "succeeded" || !hasMetric) && r.resource_usage.independentEvidence !== false
          ? Database.use((d) =>
              d
                .select({ uri: ResearchArtifactTable.uri })
                .from(ResearchArtifactTable)
                .where(
                  and(
                    eq(ResearchArtifactTable.task_id, taskID),
                    eq(ResearchArtifactTable.run_id, r.id),
                    eq(ResearchArtifactTable.kind, "runner_execution_log_json"),
                  ),
                )
                .get(),
            )
          : undefined
      const error = execution
        ? await recoverRunnerFailure(execution.uri.replace(/^file:\/\//, ""), evidence.error ?? undefined)
        : evidence.error
      const hypoID = r.candidate_id ? hypoIDByCandidate.get(r.candidate_id) : undefined
      const contract = r.resource_usage.executionContract as { manifest?: { actual?: unknown } } | undefined
      return {
        ...buildExperimentResultEvidence({
          executionVerified: (r.resource_usage.executionContract as { status?: string } | undefined)?.status === "verified",
          hypothesisSnapshot: r.resource_usage.hypothesisSnapshot as Record<string, unknown> | undefined,
          trainingTrial: r.resource_usage.trainingTrial as Record<string, unknown> | undefined,
          comparisonSpec: comparisonRecipe(taskID, ((r.resource_usage.trainingTrial as any)?.contract ?? (r.resource_usage.hypothesisSnapshot as any)?.experimentContract)?.comparisonRunID),
          evaluationEvidence: r.resource_usage.evaluationEvidence,
          runID: r.id,
          stage: r.stage,
          status: evidence.status,
          primaryMetric,
          metrics: metrics ?? {},
          error,
          hypothesisID: hypoID,
          independentEvidence: r.resource_usage.independentEvidence === false ? false : undefined,
          candidateSpec: r.candidate_id ? candidateSpecByID.get(r.candidate_id) : undefined,
        }),
        candidateID: r.candidate_id,
        metrics: hasMetric && evidence.status === "succeeded" && r.resource_usage.independentEvidence !== false ? metrics : {},
        designNotes: r.candidate_id ? candidateSpecByID.get(r.candidate_id)?.notes : undefined,
        executedModel: contract?.manifest?.actual,
      }
    }),
  )

  return { primaryMetric, runs: results, nextOffset: runs.length === limit ? offset + runs.length : null }
}
