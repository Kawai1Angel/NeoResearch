import type { ResearchOperation } from "@/research/operation"

export function isResearchOperation(path: string, method?: string) {
  return (
    method === "POST" &&
    /^\/research\/tasks\/[^/]+\/(resume|pipeline|autonomous\/(loop|iterate)|profile|prepare-dataset|intent\/(answer|modify)|export|baselines|candidates\/[^/]+\/(execute-run|seed-sweep|prepare-run))$/.test(
      path,
    )
  )
}

export async function waitForResearchOperation<T>(input: {
  operation: ResearchOperation
  url: URL
  fetch: (url: URL, init: RequestInit) => Promise<Response>
  headers: Headers
  signal?: AbortSignal | null
  pollMs?: number
}): Promise<T> {
  const url = new URL(input.url)
  url.pathname = `/research/tasks/${encodeURIComponent(input.operation.taskID)}/operations/${encodeURIComponent(input.operation.id)}`
  const headers = new Headers(input.headers)
  headers.delete("prefer")
  headers.delete("content-type")
  if (input.operation.recoveryRequired) throw new Error("原执行状态需要核对，不能启动重复训练。")
  let operation = input.operation
  let canceled = false
  let failures = 0
  while (operation.status === "running" || operation.status === "canceling") {
    if (operation.recoveryRequired) throw Object.assign(new Error("Research owner changed; refresh recovery state before continuing"), { name: "ResearchOperationUnknown" })
    if (input.signal?.aborted && input.signal.reason === "detached") throw new DOMException("Research client detached", "AbortError")
    try {
      if (input.signal?.aborted && !canceled) {
        const cancelURL = new URL(url)
        cancelURL.pathname += "/cancel"
        const response = await input.fetch(cancelURL, { method: "POST", headers, signal: AbortSignal.timeout(15_000) })
        if (!response.ok) throw new Error(await response.text())
        canceled = true
      }
      // Individual status requests have deadlines; the research operation does not.
      const response = await input.fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
      if (response.status === 404)
        throw new Error("Research operation no longer exists. Refresh task state before restarting.")
      if (!response.ok) throw new Error(await response.text())
      operation = (await response.json()) as ResearchOperation
      failures = 0
    } catch (error) {
      if (++failures >= 3) {
        throw Object.assign(
          new Error(
            `Unable to confirm research operation ${operation.id}. It may still be running; reconnect and resume the same command. ${error}`,
          ),
          { name: "ResearchOperationUnknown" },
        )
      }
    }
    if (operation.status === "running" || operation.status === "canceling") {
      await new Promise((resolve) => setTimeout(resolve, input.pollMs ?? 500))
    }
  }
  if (operation.status === "canceled") throw new DOMException("Research operation canceled", "AbortError")
  if (operation.status === "failed" || operation.status === "interrupted" || operation.status === "waiting_input") throw new Error(JSON.stringify(operation.error))
  return operation.result as T
}

/** A question may be visible before the prior session turn has released its task lock.
 * Wait passively: canceling this queued answer must never cancel that prior operation.
 */
export async function deferBusyIntentReply(input: {
  response: Response
  url: URL
  headers: Headers
  fetch: (url: URL, init: RequestInit) => Promise<Response>
  retry: () => Promise<Response>
  signal?: AbortSignal | null
  pollMs?: number
  onQueued?: () => void
}): Promise<Response> {
  const match = input.url.pathname.match(/^\/research\/tasks\/([^/]+)\/intent\/(?:modify|answer)$/)
  if (!match) return input.response
  const taskID = decodeURIComponent(match[1])
  let response = input.response
  let notified = false
  while (response.status === 409) {
    const busy = await response.clone().json().catch(() => undefined)
    const operation = busy?.operation as ResearchOperation | undefined
    if (busy?.name !== "ResearchOperationBusy" || !operation || operation.taskID !== taskID || operation.recoveryRequired ||
      !["ResearchRoutes.tasks.pipeline", "ResearchRoutes.tasks.modifyIntent", "ResearchRoutes.tasks.answerIntent"].includes(operation.action)) return response
    if (!notified) { input.onQueued?.(); notified = true }
    const statusURL = new URL(input.url)
    statusURL.pathname = `/research/tasks/${encodeURIComponent(taskID)}/operations/${encodeURIComponent(operation.id)}`
    const headers = new Headers(input.headers)
    headers.delete("prefer")
    headers.delete("content-type")
    headers.delete("idempotency-key")
    let current = operation
    let failures = 0
    while (current.status === "running" || current.status === "canceling") {
      if (input.signal?.aborted) throw new DOMException("Queued intent reply canceled", "AbortError")
      try {
        const signal = input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
        const polled = await input.fetch(statusURL, { headers, signal })
        if (!polled.ok) throw new Error(`Unable to read previous Intent operation: ${polled.status}`)
        const received = await polled.json() as ResearchOperation
        if (received.taskID !== taskID || received.id !== operation.id || received.recoveryRequired) {
          throw new Error("Previous Intent operation needs reconciliation")
        }
        current = received
        failures = 0
      } catch (error) {
        if (input.signal?.aborted) throw new DOMException("Queued intent reply canceled", "AbortError")
        if (++failures >= 3) throw Object.assign(new Error(`Unable to confirm previous Intent operation: ${error}`), { name: "ResearchOperationUnknown" })
      }
      if (current.status === "running" || current.status === "canceling") await new Promise((resolve) => setTimeout(resolve, input.pollMs ?? 500))
    }
    const checkpoint = current.status === "failed" && current.error?.name === "ResearchPipelineBlockedError" &&
      ["human_checkpoint_required", "intent_incomplete", "intent_clarification_required"].includes((current.error.data as { reason?: string } | undefined)?.reason ?? "")
    if (current.status !== "completed" && current.status !== "waiting_input" && !checkpoint) {
      throw new Error(current.error?.message ?? `Previous Intent operation ${current.status}; check task state before replying`)
    }
    if (input.signal?.aborted) throw new DOMException("Queued intent reply canceled", "AbortError")
    // Keep the original body and idempotency key; only the per-request deadline is renewed.
    try { response = await input.retry() } catch (error) {
      throw Object.assign(new Error(`Unable to confirm queued Intent reply submission: ${error}`), { name: "ResearchOperationUnknown" })
    }
    if (response.status === 409) await new Promise((resolve) => setTimeout(resolve, input.pollMs ?? 500))
  }
  return response
}
