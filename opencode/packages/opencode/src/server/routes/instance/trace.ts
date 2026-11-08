import { resumeState } from "@/research/recovery"
import { createHash, randomUUID } from "node:crypto"
import type { Context } from "hono"
import { Effect } from "effect"
import { Instance } from "@/project/instance"
import { Research } from "@/research"
import { ResearchOperations } from "@/research/operation"
import { AppRuntime } from "@/effect/app-runtime"
import { researchErrorStatus } from "../../error"

type AppEnv = Parameters<typeof AppRuntime.runPromise>[0] extends Effect.Effect<any, any, infer R> ? R : never

// Build the base span attributes for an HTTP handler: method, path, and every
// matched route param. Names follow OTel attribute-naming guidance:
// domain-first (`session.id`, `message.id`, …) so they match the existing
// OTel `session.id` semantic convention and the bare `message.id` we
// already emit from Tool.execute. Non-standard route params fall back to
// `opencode.<name>` since those are internal implementation details
// (per https://opentelemetry.io/blog/2025/how-to-name-your-span-attributes/).
export interface RequestLike {
  readonly req: {
    readonly method: string
    readonly url: string
    param(): Record<string, string>
  }
}

// Normalize a Hono route param key (e.g. `sessionID`, `messageID`, `name`)
// to an OTel attribute key. `fooID` → `foo.id` for ID-shaped params; any
// other param is namespaced under `opencode.` to avoid colliding with
// standard conventions.
export function paramToAttributeKey(key: string): string {
  const m = key.match(/^(.+)ID$/)
  if (m) return `${m[1].toLowerCase()}.id`
  return `opencode.${key}`
}

export function requestAttributes(c: RequestLike): Record<string, string> {
  const attributes: Record<string, string> = {
    "http.method": c.req.method,
    "http.path": new URL(c.req.url).pathname,
  }
  for (const [key, value] of Object.entries(c.req.param())) {
    attributes[paramToAttributeKey(key)] = value
  }
  return attributes
}

export function runRequest<A, E>(name: string, c: Context, effect: Effect.Effect<A, E, AppEnv>, signal?: AbortSignal) {
  return AppRuntime.runPromise(effect.pipe(Effect.withSpan(name, { attributes: requestAttributes(c) })), { signal })
}

const researchWork = new Set([
  "ResearchRoutes.tasks.pipeline",
  "ResearchRoutes.tasks.autonomousLoop",
  "ResearchRoutes.tasks.autonomousIterate",
  "ResearchRoutes.tasks.loopControl",
  "ResearchRoutes.tasks.profile",
  "ResearchRoutes.tasks.prepareDataset",
  "ResearchRoutes.tasks.answerIntent",
  "ResearchRoutes.tasks.modifyIntent",
  "ResearchRoutes.tasks.export",
  "ResearchRoutes.tasks.seedBaselines",
  "ResearchRoutes.candidates.executeRun",
  "ResearchRoutes.candidates.seedSweep",
  "ResearchRoutes.candidates.prepareRun",
])

export function runRequestDeferred<A, E>(
  name: string,
  c: Context,
  effect: Effect.Effect<A, E, AppEnv>,
  onError?: (error: unknown) => void,
) {
  setTimeout(() => {
    void runRequest(name, c, effect).catch((error) => {
      onError?.(error)
    })
  }, 0)
}

export async function jsonRequest<C extends Context, A, E>(
  name: string,
  c: C,
  effect: (c: C) => Effect.gen.Return<A, E, AppEnv>,
  expectedRevision?: number,
) {
  const taskID = c.req.param("taskID")
  if (taskID && researchWork.has(name)) {
    const scope = Instance.project.id
    // Validate ownership before exposing/starting an operation.
    await runRequest(
      name,
      c,
      Research.Service.use((svc) => svc.getTask(taskID as Research.ResearchTaskID)),
    )
    const work = Effect.gen(() => effect(c)).pipe(
      Effect.onInterrupt(() =>
        Research.Service.use((svc) =>
          Effect.gen(function* () {
            const runs = yield* svc.listRuns(taskID as Research.ResearchTaskID)
            for (const run of runs.filter((run) => run.status === "running" || run.status === "queued")) {
              yield* svc.updateRunStatus({
                runID: run.id,
                status: "failed",
                error: "Research operation canceled by user",
              })
            }
            yield* svc.updateTaskStatus({ taskID: taskID as Research.ResearchTaskID, status: "paused" })
          }),
        ),
      ),
    )
    const requestDigest = createHash("sha256")
      .update(JSON.stringify([new URL(c.req.url).pathname, await c.req.json().catch(() => null)]))
      .digest("hex")
    const requestKey = c.req.header("idempotency-key") ?? randomUUID()
    const previous = ResearchOperations.request(scope, taskID, requestKey)
    const state = resumeState(scope, taskID as Research.ResearchTaskID)
    if (!previous && state?.recoveryState === "needs_reconciliation")
      return c.json({ name: "ResearchReconciliationRequired", state }, 409)
    if (
      !previous &&
      [
        "ResearchRoutes.tasks.pipeline",
        "ResearchRoutes.tasks.autonomousLoop",
        "ResearchRoutes.tasks.autonomousIterate",
        "ResearchRoutes.tasks.loopControl",
      ].includes(name) &&
      (state?.recoveryState === "blocked" || state?.recoveryState === "completed")
    )
      return c.json({ name: "ResearchResumeBlocked", state }, 409)
    const started = ResearchOperations.start(
      scope,
      taskID,
      name,
      (signal) => runRequest(name, c, work, signal),
      requestKey,
      requestDigest,
      expectedRevision,
    )
    if (started.resumed && c.req.header("prefer") === "respond-async") return c.json(started.operation, 202)
    if (!started.started && !started.resumed)
      return c.json({ name: "ResearchOperationBusy", operation: started.operation }, 409)
    if (c.req.header("prefer") === "respond-async") return c.json(started.operation, 202)
    {
      const operation = await ResearchOperations.wait(scope, taskID, started.operation.id)
      if (operation?.status === "completed") return c.json(operation.result)
      if (operation?.error) return c.json(operation.error, researchErrorStatus(operation.error.name))
      return c.json({ name: "ResearchOperationCanceled", message: "Research operation canceled" }, 409)
    }
  }
  return c.json(
    await runRequest(
      name,
      c,
      Effect.gen(() => effect(c)),
    ),
  )
}
