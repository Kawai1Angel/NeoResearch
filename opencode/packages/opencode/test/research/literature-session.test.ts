import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Research } from "../../src/research"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Bus } from "../../src/bus"
import { literatureSession } from "../../src/research/literature-phase-executor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { report } from "./retrieve/fixtures"

afterEach(resetDatabase)
const it = testEffect(CrossSpawnSpawner.defaultLayer)

for (const scenario of ["tool_only", "reply_failed", "not_started", "bad_receipt"] as const) {
  it.live(`Literature service session: ${scenario}`, () => provideTmpdirInstance((directory) => Effect.gen(function* () {
    const previousKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "fixture-key-no-network"
    const promptLayer = Layer.effect(SessionPrompt.Service, Effect.gen(function* () {
      const sessions = yield* Session.Service
      return {
        cancel: () => Effect.void,
        loop: () => Effect.die("unused"), shell: () => Effect.die("unused"), command: () => Effect.die("unused"),
        resolvePromptParts: () => Effect.succeed([]),
        prompt: (input: SessionPrompt.PromptInput) => Effect.gen(function* () {
          expect(input.agent).toBe("research-literature")
          if (scenario === "not_started") return yield* Effect.die("provider unavailable")
          const phase = literatureSession(input.sessionID, input.agent!)
          const receipt = yield* Effect.promise(() => phase.execute())
          if (scenario === "reply_failed") return yield* Effect.die("reply failed after tool execution")
          const info = yield* sessions.updateMessage({
            id: MessageID.ascending(), sessionID: input.sessionID, role: "assistant", time: { created: Date.now() },
            parentID: MessageID.ascending(), modelID: ModelID.make("fixture"), providerID: ProviderID.make("anthropic"),
            mode: "research-literature", agent: "research-literature", path: { cwd: directory, root: directory }, cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          const part = yield* sessions.updatePart({ id: PartID.ascending(), messageID: info.id, sessionID: input.sessionID,
            type: "tool", tool: "literature_run", callID: "fixture-call", state: { status: "completed", input: {},
              output: JSON.stringify(scenario === "bad_receipt" ? { ...receipt, taskID: "other-task" } : receipt),
              title: "Literature done", metadata: {}, time: { start: 0, end: 1 } } })
          return { info, parts: [part] }
        }),
      }
    }))
    const layer = Research.layer.pipe(Layer.provideMerge(promptLayer), Layer.provideMerge(Session.defaultLayer), Layer.provideMerge(Bus.layer))
    yield* Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await mkdir(path.join(directory, ".neo-cast"), { recursive: true })
        await writeFile(path.join(directory, ".neo-cast/config.json"), JSON.stringify({ llm: { provider: "anthropic", model: "fixture", base_url: "" } }))
      })
      const svc = yield* Research.Service
      const bus = yield* Bus.Service
      const sessions = yield* Session.Service
      const task = yield* svc.createTask({ title: "Literature session fixture", domainID: "tsf", mode: "review",
        taskSpec: { contextLength: 96, predictionLengths: [24], dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] }, runtime: { neoCastProjectRoot: directory, literatureSessionTools: true } },
        objective: { primaryMetric: "val_avg_mse", direction: "minimize" }, budget: { maxRuns: 1 } })
      const reportPath = path.join(directory, "report.json")
      yield* Effect.promise(() => writeFile(reportPath, JSON.stringify({ ...report(), taskID: task.id })))
      yield* svc.createArtifact({ taskID: task.id, kind: "dataset_quantitative_analysis_json", uri: `file://${reportPath}`, metadata: {} })
      const events: string[] = []
      let pathUsed: unknown
      let terminalResolve!: () => void
      const terminal = new Promise<void>((resolve) => { terminalResolve = resolve })
      const subscriptions = [
        yield* bus.subscribeCallback(Research.Event.LiteratureAgentStarted, () => { events.push("started") }),
        yield* bus.subscribeCallback(Research.Event.LiteratureAgentCompleted, (event) => { events.push("completed"); pathUsed = event.properties.metadata?.callPath; terminalResolve() }),
        yield* bus.subscribeCallback(Research.Event.LiteratureAgentFailed, () => { events.push("failed"); terminalResolve() }),
      ]
      yield* Effect.gen(function* () {
        const exit = yield* Effect.exit(svc.runRetrieveAgent({ taskID: task.id }))
        yield* Effect.promise(() => terminal)
        const artifacts = yield* svc.listArtifacts(task.id)
        if (scenario === "bad_receipt") {
          expect(exit._tag).toBe("Failure")
          expect(events).toEqual(["started", "failed"])
          expect(artifacts.filter((a) => a.kind === "task_evidence_bundle_json")).toHaveLength(0)
          return
        }
        expect(exit._tag).toBe("Success")
        expect(events).toEqual(["started", "completed"])
        expect(pathUsed).toBe(scenario === "not_started" ? "direct" : "session_tool")
        const artifact = artifacts.find((a) => a.kind === "task_evidence_bundle_json")!
        expect(artifact.metadata.readiness).toBe("ready_data_only")
        const children = yield* sessions.children(SessionID.make(task.sessionID!))
        expect(children).toHaveLength(1)
        expect(children[0].title).toContain("Literature")
        expect(() => literatureSession(children[0].id, "research-literature")).toThrow()
        expect(artifacts.filter((a) => a.kind === "literature_retrieve_result_json")).toHaveLength(1)
      }).pipe(Effect.ensuring(Effect.sync(() => subscriptions.forEach((unsubscribe) => unsubscribe()))))
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => {
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousKey
    })))
  }), { git: true, config: { formatter: false, lsp: false } }), 30_000)
}
