import { afterEach, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Agent } from "../../src/agent/agent"
import * as Truncate from "../../src/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LiteratureRunTool, LiteratureListIntentsTool, LiteratureSearchTool, LiteratureReadPaperTool, LiteratureGetResultsTool, literatureOutput } from "../../src/tool/research-literature"
import { createLiteraturePhase, bindLiteratureSession, literatureDigest, literatureSession } from "../../src/research/literature-phase-executor"
import { recoverLiteratureReceipt } from "../../src/research/literature-session-receipt"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { RetrieveAgent } from "../../src/research/retrieve"
import { provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { resetDatabase } from "../fixture/db"
import { report } from "./retrieve/fixtures"

afterEach(resetDatabase)
const it = testEffect(CrossSpawnSpawner.defaultLayer)
const layer = Layer.mergeAll(Agent.defaultLayer, Truncate.defaultLayer)

test("literature receipt digest matches the result after JSON persistence", () => {
  const result = { entries: [{ cardID: "kc_example", paperTitle: undefined, problem: undefined }],
    literatureResults: [{ paperID: "paper_example", error: undefined }] }
  expect(literatureDigest(result)).toBe(literatureDigest(JSON.parse(JSON.stringify(result))))
  expect(literatureDigest({ entries: [{ cardID: "kc_other" }] })).not.toBe(literatureDigest(result))
})

it.live("bound literature tools enforce access, budgets, cancellation and read-only exploration before a deduplicated run", () =>
  provideTmpdirInstance((directory) => Effect.gen(function* () {
    const phase = yield* Effect.promise(() => createLiteraturePhase({ neoCastRoot: directory, workspaceRoot: directory,
      taskID: report().taskID, run: { quantitativeReport: report() } }))
    const ctx = { sessionID: SessionID.make("ses_literature"), messageID: MessageID.make("msg_literature"),
      agent: "research-literature", abort: AbortSignal.any([]), messages: [], metadata: () => Effect.void, ask: () => Effect.void }
    const run = yield* (yield* LiteratureRunTool).init()
    const list = yield* (yield* LiteratureListIntentsTool).init()
    const search = yield* (yield* LiteratureSearchTool).init()
    const read = yield* (yield* LiteratureReadPaperTool).init()
    const results = yield* (yield* LiteratureGetResultsTool).init()
    const fails = <A>(effect: Effect.Effect<A>) => Effect.exit(effect).pipe(Effect.map((exit) => expect(exit._tag).toBe("Failure")))
    yield* fails(run.execute({}, ctx))
    const release = bindLiteratureSession(ctx.sessionID, phase)
    yield* Effect.gen(function* () {
      yield* fails(run.execute({}, { ...ctx, agent: "build" }))
      yield* fails(run.execute({}, { ...ctx, sessionID: SessionID.make("ses_other") }))
      yield* fails(run.execute({}, { ...ctx, abort: AbortSignal.abort() }))
      expect(phase.started).toBe(false)
      yield* fails(run.execute({ force: true } as never, ctx))
      yield* fails(run.execute({ taskID: "other" } as never, ctx))
      yield* fails(list.execute({ limit: 21 }, ctx))
      yield* fails(list.execute({ offset: -1 }, ctx))
      yield* fails(search.execute({ intentID: "bad" }, ctx))
      yield* fails(read.execute({ paperID: "/etc/passwd" }, ctx))
      yield* fails(results.execute({}, ctx))
      const intents = JSON.parse((yield* list.execute({}, ctx)).output)
      expect(intents.intents.length).toBeGreaterThan(0)
      yield* fails(search.execute({ intentID: intents.intents[0].intentID, topK: 1000 }, ctx))
      expect(JSON.parse((yield* search.execute({ intentID: intents.intents[0].intentID }, ctx)).output).candidates).toEqual([])
      expect(phase.started).toBe(false)
      const runs = yield* Effect.all([run.execute({}, ctx), run.execute({}, ctx)], { concurrency: 2 })
      expect(runs[0].output).toEqual(runs[1].output)
      const receipt = JSON.parse(runs[0].output)
      const direct = new RetrieveAgent({ neoCastRoot: directory, workspaceRoot: directory })
      const comparison = yield* Effect.promise(() => direct.run({ quantitativeReport: report() }).finally(() => direct.close()))
      expect(yield* Effect.promise(() => phase.validate(receipt))).toEqual(comparison)
      expect(JSON.parse((yield* results.execute({}, ctx)).output).readiness).toBe("ready_data_only")
      yield* fails(results.execute({ retrieveRunID: "retrieve_other" }, ctx))
      const part = { type: "tool", tool: "literature_run", state: { status: "completed", output: runs[0].output } } as MessageV2.Part
      expect(yield* Effect.promise(() => recoverLiteratureReceipt(phase, [part]))).toEqual(receipt)
      // Final reply and even tool-part persistence can fail after execution: reconcile once.
      expect(yield* Effect.promise(() => recoverLiteratureReceipt(phase, []))).toEqual(receipt)
      const bad = { ...part, state: { status: "completed", output: JSON.stringify({ ...receipt, taskID: "wrong" }) } } as MessageV2.Part
      yield* fails(Effect.promise(() => recoverLiteratureReceipt(phase, [bad])))
      const root = path.join(directory, ".neo-cast/literature-retrieval/runs", receipt.retrieveRunID)
      yield* Effect.promise(() => writeFile(path.join(root, "task_evidence_bundle.json"), JSON.stringify({ ...comparison.taskEvidence, taskID: "wrong" })))
      yield* fails(Effect.promise(() => phase.validate(receipt)))
    }).pipe(Effect.ensuring(Effect.sync(release)))
    expect(() => literatureSession(ctx.sessionID, ctx.agent)).toThrow()
  }).pipe(Effect.provide(layer)), { git: true, config: { formatter: false, lsp: false } }), 30_000)

test("snapshot refresh observes catalog changes before execution and never starts on a text-only reply", async () => {
  await using tmp = await tmpdir()
  const phase = await createLiteraturePhase({ neoCastRoot: tmp.path, workspaceRoot: tmp.path, taskID: report().taskID, run: { quantitativeReport: report() } })
  expect(await recoverLiteratureReceipt(phase, [])).toBeUndefined()
  const before = phase.snapshot.retrieveRunID
  const catalog = path.join(tmp.path, ".neo-cast/literature-source/catalog")
  await mkdir(catalog, { recursive: true })
  await writeFile(path.join(catalog, "papers.jsonl"), JSON.stringify({ paper_id: "paper-new", title: "Frequency-domain forecasting multiple seasonalities", publication_status: "preprint", download: { status: "no_public_pdf", path: null } }) + "\n")
  await phase.refreshSnapshot()
  expect(phase.snapshot.retrieveRunID).not.toBe(before)
  expect(phase.snapshot.candidates.some((item) => item.paperID === "paper-new")).toBe(true)
  const receipt = await phase.execute()
  expect(receipt.retrieveRunID).toBe(phase.snapshot.retrieveRunID)
  const data = await phase.validate(receipt)
  expect(data.summary.missingPDFCount).toBeGreaterThan(0)
  expect(data.taskEvidence.readiness).toBe("ready_data_only")
})

test("tool display redacts secrets and internal paths and bounds long strings", () => {
  const output = literatureOutput({ text: "sk-abcdefghijklmnopqrstuvwxyz /home/user/private/document.pdf " + "x".repeat(5000) })
  expect(output).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
  expect(output).not.toContain("/home/user")
  expect(output.length).toBeLessThan(1600)
})

test("cancellation and timeout keep the same failed execution instead of restarting writes", async () => {
  await using tmp = await tmpdir()
  const cancel = new AbortController()
  const phase = await createLiteraturePhase({ neoCastRoot: tmp.path, workspaceRoot: tmp.path, taskID: report().taskID,
    run: { quantitativeReport: report() }, onProgress: async (progress) => {
      if (progress.step === "search") cancel.abort()
    } })
  const pending = phase.execute(cancel.signal)
  await expect(pending).rejects.toThrow()
  expect(phase.execute()).toBe(pending)
  expect(phase.reconcile()).toBe(pending)
  await expect(phase.execute()).rejects.toThrow()
  const timed = await createLiteraturePhase({ neoCastRoot: tmp.path, workspaceRoot: tmp.path, taskID: report().taskID,
    run: { quantitativeReport: report() } })
  await expect(timed.execute(AbortSignal.timeout(1))).rejects.toThrow()
  expect(timed.started).toBe(true)
})
