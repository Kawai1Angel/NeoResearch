import { Database, and, eq, desc } from "@/storage"
import { Schema } from "effect"
import { Instance } from "@/project/instance"
import {
  ResearchDesignTable,
  ResearchTaskTable,
  ResearchRunTable,
  ResearchCandidateTable,
  ResearchArtifactTable,
} from "./research.sql"
import {
  TrainingReflection,
  ArchitectureReflection,
  buildTrainingReflection,
  buildDesignSummary,
} from "./agents/scoped-reflection"
import {
  ResearchRun,
  ResearchCandidate,
  type ResearchTaskID,
  type ResearchRunID,
  type ResearchCandidateID,
} from "./schema"
import { designTrials } from "./design-store"
import { mapTask } from "./task-mapper"
import { cycleDigest } from "./cycle"
import { currentCycle } from "./design-store"
import { extractTrainingCurve } from "./runner-evidence"
import type { ExperienceOrigin } from "./experience-purpose"

export type ExperienceWriteBinding = { designID: string; reflectionKey: string }
export function experienceWriteOrigin(taskID: ResearchTaskID, binding: ExperienceWriteBinding): ExperienceOrigin {
  const design = Database.use((db) =>
    db
      .select()
      .from(ResearchDesignTable)
      .where(and(eq(ResearchDesignTable.id, binding.designID), eq(ResearchDesignTable.task_id, taskID)))
      .get(),
  )
  const saved = design?.phase_receipts[binding.reflectionKey]
  if (!saved || !binding.reflectionKey.endsWith(".result"))
    throw new Error("Memory writes require a committed same-task reflection result")
  const reflection =
    saved.reflectionScope === "training" ? TrainingReflection.parse(saved) : ArchitectureReflection.parse(saved)
  if (reflection.taskID !== taskID || reflection.designID !== binding.designID)
    throw new Error("Memory reflection identity changed")
  return {
    ...binding,
    inputDigest: reflection.inputDigest,
    purpose: reflection.memoryPurpose,
    sourceRunIDs: reflection.evidenceRunIDs,
    ...(reflection.reflectionScope === "training" ? { trialID: reflection.trialID } : {}),
  }
}

/** Refuse to distill a changed source into a previously accepted interpretation. */
export async function verifyExperienceBinding(taskID: ResearchTaskID, binding: ExperienceWriteBinding) {
  const origin = experienceWriteOrigin(taskID, binding)
  const taskRow = Database.use((db) =>
    db
      .select()
      .from(ResearchTaskTable)
      .where(and(eq(ResearchTaskTable.id, taskID), eq(ResearchTaskTable.project_id, Instance.project.id)))
      .get(),
  )
  if (!taskRow) throw new Error("Memory source task does not belong to this project")
  const task = mapTask(taskRow)
  const design = Database.use(
    (db) => db.select().from(ResearchDesignTable).where(eq(ResearchDesignTable.id, binding.designID)).get()!,
  )
  if (currentCycle(design.cycle_id).input_digest !== cycleDigest(task))
    throw new Error("Memory source data or protocol changed after reflection")
  const trials = designTrials(design.id)
  const trial = origin.trialID ? trials.find((trial) => trial.id === origin.trialID) : undefined
  if (origin.trialID && !trial) throw new Error("Memory source trial is unavailable")
  const selected = trial ? [trial] : trials
  const ids = [
    ...new Set(
      selected
        .flatMap((item) => [
          item.full_run_id ?? item.smoke_run_id,
          ...(trial ? [item.contract?.comparisonRunID, item.repair_run_id] : []),
        ])
        .concat(trial ? [] : [design.outer_contract?.comparisonRunID])
        .filter((id): id is ResearchRunID => Boolean(id)),
    ),
  ]
  const runs = ids.map((id) => {
    const row = Database.use((db) =>
      db
        .select()
        .from(ResearchRunTable)
        .where(and(eq(ResearchRunTable.id, id), eq(ResearchRunTable.task_id, taskID)))
        .get(),
    )
    if (!row) throw new Error("Memory source run is unavailable")
    return Schema.decodeUnknownSync(ResearchRun)({
      id: row.id,
      taskID: row.task_id,
      candidateID: row.candidate_id ?? undefined,
      stage: row.stage,
      status: row.status,
      metrics: row.metrics,
      resourceUsage: row.resource_usage,
      artifactRefs: row.artifact_refs,
      error: row.error ?? undefined,
      time: { created: row.time_created, updated: row.time_updated },
      timeStarted: row.time_started ?? undefined,
      timeFinished: row.time_finished ?? undefined,
    })
  })
  const candidates = [...new Set(runs.flatMap((run) => (run.candidateID ? [run.candidateID] : [])))].map(
    (id: ResearchCandidateID) => {
      const row = Database.use((db) =>
        db
          .select()
          .from(ResearchCandidateTable)
          .where(and(eq(ResearchCandidateTable.id, id), eq(ResearchCandidateTable.task_id, taskID)))
          .get(),
      )
      if (!row) throw new Error("Memory source candidate is unavailable")
      return Schema.decodeUnknownSync(ResearchCandidate)({
        id: row.id,
        taskID: row.task_id,
        domainID: row.domain_id,
        hypothesisID: row.hypothesis_id ?? undefined,
        parentCandidateID: row.parent_candidate_id ?? undefined,
        candidateSpec: row.candidate_spec,
        rationale: row.rationale,
        riskLevel: row.risk_level,
        approvalStatus: row.approval_status,
        generatedBy: row.generated_by,
        time: { created: row.time_created, updated: row.time_updated },
      })
    },
  )
  const evidence = { task, design, trials, runs, candidates }
  let inputDigest: string
  if (trial) {
    const progress = Database.use((db) =>
      db
        .select()
        .from(ResearchArtifactTable)
        .where(
          and(
            eq(ResearchArtifactTable.run_id, (trial.full_run_id ?? trial.smoke_run_id)!),
            eq(ResearchArtifactTable.kind, "runner_progress_jsonl"),
          ),
        )
        .orderBy(desc(ResearchArtifactTable.time_updated))
        .get(),
    )
    const points = progress?.uri.startsWith("file://") ? await extractTrainingCurve(progress.uri.slice(7)) : []
    inputDigest = buildTrainingReflection(evidence, trial, points).inputDigest
  } else inputDigest = buildDesignSummary(evidence).inputDigest
  if (inputDigest !== origin.inputDigest)
    throw new Error("Memory source evidence changed after its reflection was committed")
  return origin
}
