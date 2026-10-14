import path from "node:path"
import { Effect, Semaphore } from "effect"
import type { DomainRunPlan } from "./domain"
import { RESEARCH_MAX_PARALLEL_EXPERIMENTS } from "./defaults"

export function experimentParallelLimit(budget: Readonly<Record<string, unknown>>) {
  const value = budget.maxParallel
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), RESEARCH_MAX_PARALLEL_EXPERIMENTS)
    : RESEARCH_MAX_PARALLEL_EXPERIMENTS
}

export class ExperimentScheduler {
  private readonly slots = Semaphore.makeUnsafe(RESEARCH_MAX_PARALLEL_EXPERIMENTS)
  private readonly tasks = new Map<string, Semaphore.Semaphore>()
  private readonly workspaces = new Map<string, Semaphore.Semaphore>()
  private readonly admissions = new Map<string, Semaphore.Semaphore>()
  private readonly evaluations = new Map<string, Semaphore.Semaphore>()

  admit<A, E, R>(taskID: string, effect: Effect.Effect<A, E, R>) {
    const gate = this.admissions.get(taskID) ?? Semaphore.makeUnsafe(1)
    this.admissions.set(taskID, gate)
    return gate.withPermits(1)(effect)
  }

  evaluate<A, E, R>(taskID: string, effect: Effect.Effect<A, E, R>) {
    const gate = this.evaluations.get(taskID) ?? Semaphore.makeUnsafe(1)
    this.evaluations.set(taskID, gate)
    return gate.withPermits(1)(effect)
  }

  execute<A, E, R>(taskID: string, limit: number, workspace: string, effect: Effect.Effect<A, E, R>) {
    if (!Number.isInteger(limit) || limit < 1 || limit > RESEARCH_MAX_PARALLEL_EXPERIMENTS) {
      throw new Error("Experiment concurrency must be between 1 and 4")
    }
    const key = `${taskID}:${limit}`
    const task = this.tasks.get(key) ?? Semaphore.makeUnsafe(limit)
    const writer = this.workspaces.get(workspace) ?? Semaphore.makeUnsafe(1)
    this.tasks.set(key, task)
    this.workspaces.set(workspace, writer)
    // Waiting for a shared workspace must not consume a global execution slot.
    return writer.withPermits(1)(task.withPermits(1)(this.slots.withPermits(1)(effect)))
  }
}

const schedulers = new Map<string, ExperimentScheduler>()
export function experimentScheduler(projectRoot: string) {
  const key = path.resolve(projectRoot)
  const scheduler = schedulers.get(key) ?? new ExperimentScheduler()
  schedulers.set(key, scheduler)
  return scheduler
}

export function isolateExperimentPlan(plan: DomainRunPlan, taskRoot: string, runID: string, referenceWorkspace?: string): DomainRunPlan {
  if (!/^[a-zA-Z0-9_-]+$/.test(runID)) throw new Error("Invalid experiment workspace ID")
  const reference = plan.stage === "ref_test" || plan.stage === "blind_test"
  // Older reference runs retain their original task workspace and artifacts.
  if (reference && referenceWorkspace === undefined) return plan
  const cwd = reference ? path.resolve(referenceWorkspace!) : path.join(taskRoot, "experiments", runID)
  const relative = path.relative(taskRoot, cwd)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Experiment workspace must stay inside its task workspace")
  }
  const relocate = (value: string) => {
    if (!path.isAbsolute(value)) return value
    const relative = path.relative(taskRoot, value)
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      ? value : path.join(cwd, relative)
  }
  return {
    ...plan,
    writes: plan.writes.map((write) => ({ ...write, path: relocate(write.path) })),
    command: {
      ...plan.command,
      cwd,
      args: plan.command.args.map(relocate),
      env: {
        ...plan.command.env,
        NEO_CAST_PROJECT_ROOT: cwd,
        NEO_TSF_DATA_ROOT: plan.command.env?.NEO_TSF_DATA_ROOT ?? path.join(taskRoot, ".neo-cast", "dataset"),
        NEO_CAST_EXPERIMENT_STORE: plan.command.env?.NEO_CAST_EXPERIMENT_STORE ?? path.join(taskRoot, ".neo-cast", "artifacts", "experiment_identity.sqlite"),
        ...(plan.command.env?.NEO_CAST_CONTRACT_CANDIDATE
          ? { NEO_CAST_CONTRACT_CANDIDATE: relocate(plan.command.env.NEO_CAST_CONTRACT_CANDIDATE) } : {}),
      },
    },
  }
}
