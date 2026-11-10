/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { SDKProvider, useSDK, type EventSource } from "../../../src/cli/cmd/tui/context/sdk"
import type { GlobalEvent } from "@neoresearch-ai/sdk/v2"

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20))
const event = {
  directory: "/tmp",
  payload: { type: "vcs.branch.updated", properties: { branch: "main" } },
} as GlobalEvent

function Probe(props: { seen: () => void }) {
  const sdk = useSDK()
  onCleanup(sdk.event.on("event", props.seen))
  return <text>SDK lifecycle</text>
}

test("disposing an SDK provider unsubscribes its event source and rejects queued events", async () => {
  let handler: ((event: GlobalEvent) => void) | undefined
  let unsubscribed = 0,
    seen = 0
  const source: EventSource = {
    subscribe: async (callback) => {
      handler = callback
      return () => {
        unsubscribed++
      }
    },
  }
  const app = await testRender(
    () => (
      <SDKProvider url="http://mock.local" events={source}>
        <Probe
          seen={() => {
            seen++
          }}
        />
      </SDKProvider>
    ),
    { width: 40, height: 5 },
  )
  await tick()
  handler!(event)
  expect(seen).toBe(1)
  // Queue a second event in the batching window and dispose before it flushes.
  handler!(event)
  const before = seen
  app.renderer.destroy()
  handler!(event)
  await tick()
  expect(unsubscribed).toBe(1)
  expect(seen).toBe(before)
})

test("a subscription that resolves after disposal is immediately released", async () => {
  let release!: (unsubscribe: () => void) => void
  let handler: ((event: GlobalEvent) => void) | undefined
  let unsubscribed = 0,
    seen = 0
  const source: EventSource = {
    subscribe: (callback) => {
      handler = callback
      return new Promise((resolve) => {
        release = resolve
      })
    },
  }
  const app = await testRender(
    () => (
      <SDKProvider url="http://mock.local" events={source}>
        <Probe
          seen={() => {
            seen++
          }}
        />
      </SDKProvider>
    ),
    { width: 40, height: 5 },
  )
  await tick()
  app.renderer.destroy()
  release(() => {
    unsubscribed++
  })
  await tick()
  handler!(event)
  await tick()
  expect(unsubscribed).toBe(1)
  expect(seen).toBe(0)
})
