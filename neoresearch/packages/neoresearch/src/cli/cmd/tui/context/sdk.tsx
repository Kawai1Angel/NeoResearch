import { createNeoResearchClient } from "@neoresearch-ai/sdk/v2"
import type { GlobalEvent } from "@neoresearch-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { Flag } from "@neoresearch-ai/core/flag/flag"
import { batch, onCleanup, onMount } from "solid-js"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined
    let unsubscribe: (() => void) | undefined

    function createSDK() {
      return createNeoResearchClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: props.fetch,
        headers: props.headers,
      })
    }

    let sdk = createSDK()

    const emitter = createGlobalEmitter<{
      event: GlobalEvent
    }>()

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000

    const flush = () => {
      if (abort.signal.aborted) return
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          if (abort.signal.aborted) break
          emitter.emit("event", event)
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      if (abort.signal.aborted) return
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        let attempt = 0
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break

          const events = await sdk.global.event({
            signal: ctrl.signal,
            sseMaxRetryAttempts: 0,
          })

          if (Flag.NEORESEARCH_EXPERIMENTAL_WORKSPACES) {
            // Start syncing workspaces, it's important to do this after
            // we've started listening to events
            await sdk.sync.start().catch(() => {})
          }

          for await (const event of events.stream) {
            if (ctrl.signal.aborted) break
            handleEvent(event)
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          attempt += 1
          if (abort.signal.aborted || ctrl.signal.aborted) break

          // Exponential backoff
          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      })().catch(() => {})
    }

    onMount(() => {
      if (props.events) {
        void props.events
          .subscribe(handleEvent)
          .then(async (unsub) => {
            // Register cleanup synchronously below: onCleanup after await has no
            // Solid owner, and a late subscription can otherwise outlive the UI.
            if (abort.signal.aborted) {
              unsub()
              return
            }
            unsubscribe = unsub
            if (Flag.NEORESEARCH_EXPERIMENTAL_WORKSPACES) await sdk.sync.start().catch(() => {})
          })
          .catch(() => {})
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      unsubscribe?.()
      unsubscribe = undefined
      queue = []
      if (timer) clearTimeout(timer)
    })

    return {
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      fetch: props.fetch ?? fetch,
      url: props.url,
    }
  },
})
