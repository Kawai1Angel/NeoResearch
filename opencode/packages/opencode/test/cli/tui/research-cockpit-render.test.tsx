/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Global } from "@opencode-ai/core/global"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { CommandProvider, useCommandDialog } from "../../../src/cli/cmd/tui/component/dialog-command"
import { KeybindProvider } from "../../../src/cli/cmd/tui/context/keybind"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { SDKProvider } from "../../../src/cli/cmd/tui/context/sdk"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { ResearchCockpit } from "../../../src/cli/cmd/tui/routes/research-cockpit"
import { DialogProvider } from "../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "../../../src/cli/cmd/tui/ui/toast"

const now = 1_765_000_000_000
const taskID = "task_neo_cast_01"
const candidateID = "cand_phase2_01"
const runID = "run_smoke_01"

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function mockResearchFetch(input: RequestInfo | URL, _init?: RequestInit) {
  const url = new URL(input.toString())
  const path = url.pathname

  if (path === "/research/tasks") {
    return Promise.resolve(
      response([
        {
          id: taskID,
          projectID: "project_neo_cast",
          title: "Neo-Cast Autonomous TSF",
          domainID: "tsf",
          mode: "autonomous",
          status: "researching",
          taskSpec: {
            contextLength: 96,
            predictionLengths: [24],
            runtime: { bridgeOnly: false, neoCastProjectRoot: "/tmp/neo-cast" },
          },
          objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
          budget: { maxRuns: 12, maxParallel: 1 },
          time: { created: now - 60_000, updated: now },
        },
      ]),
    )
  }

  if (path === `/research/tasks/${taskID}/candidates`) {
    return Promise.resolve(
      response([
        {
          id: candidateID,
          taskID,
          domainID: "tsf",
          candidateSpec: {
            recipeID: "phase2_frequency_rnn_quantile",
            preprocessing: { actions: [{ type: "frequency_filter" }, { type: "instance_norm" }] },
            embedding: { type: "patch" },
            backbone: { type: "rnn" },
            fusion: { type: "feature_fusion" },
            predictionHead: { type: "quantile" },
            trainingStrategy: { optimizer: { type: "adamw" } },
          },
          rationale: "Exercise phase-two modular candidate rendering.",
          riskLevel: "medium",
          approvalStatus: "approved",
          generatedBy: "heuristic",
          time: { created: now - 30_000, updated: now - 20_000 },
        },
      ]),
    )
  }

  if (path === `/research/tasks/${taskID}/runs`) {
    return Promise.resolve(
      response([
        {
          id: runID,
          taskID,
          candidateID,
          stage: "smoke",
          status: "succeeded",
          metrics: { val_avg_mse: 0.1234 },
          resourceUsage: { wallClockSec: 4 },
          artifactRefs: [],
          time: { created: now - 12_000, updated: now - 8_000 },
        },
      ]),
    )
  }

  if (path === `/research/tasks/${taskID}/artifacts`) {
    return Promise.resolve(
      response([
        {
          id: "artifact_selection_01",
          taskID,
          kind: "research_candidate_selection_json",
          uri: "file:///tmp/selection.json",
          metadata: {
            rankPredictorVersion: "tsf_profile_learned_memory_ranker_v1",
            rankingCount: 4,
            topScore: 0.91,
            historyTaskMemoryCount: 2,
            historyDomainMemoryCount: 5,
          },
          time: { created: now - 7_000, updated: now - 7_000 },
        },
      ]),
    )
  }

  if (path === `/research/tasks/${taskID}/memory`) {
    return Promise.resolve(
      response([
        {
          id: "mem_01",
          taskID,
          domainID: "tsf",
          fingerprintSummary: { horizon: "24", targetCount: 1 },
          candidateSummary: { backbone: "rnn", head: "quantile" },
          outcome: "accepted",
          lesson: "Frequency preprocessing helped the smoke objective.",
          time: { created: now - 5_000, updated: now - 5_000 },
        },
      ]),
    )
  }

  if (path === `/research/tasks/${taskID}/fingerprint`) {
    return Promise.resolve(
      response({
        contextLength: 96,
        horizon: "24",
        targetCount: 1,
        bridgeOnly: false,
        datasetProfile: {
          rowCount: 1024,
          targetCount: 1,
          missingRate: 0.01,
          trendStrength: 0.42,
          seasonalityStrength: 0.77,
          crossVarCorrelation: 0.34,
          distributionShift: 0.08,
        },
      }),
    )
  }

  if (path === `/research/tasks/${taskID}/approvals`) {
    return Promise.resolve(
      response([
        {
          id: "approval_ref_01",
          taskID,
          candidateID,
          kind: "ref_test",
          status: "approved",
          reason: "Allow ref-test promotion for the champion candidate.",
          time: { created: now - 20_000, updated: now - 19_000 },
          timeReplied: now - 19_000,
        },
      ]),
    )
  }

  if (path === `/research/tasks/${taskID}/champion`) {
    return Promise.resolve(
      response({
        taskID,
        candidateID,
        runID,
        primaryMetric: 0.1234,
        utility: 0.88,
        acceptedAt: now - 6_000,
        time: { created: now - 6_000, updated: now - 6_000 },
      }),
    )
  }

  return Promise.resolve(response([]))
}

const researchFetch = mockResearchFetch as typeof fetch

type CommandDialog = ReturnType<typeof useCommandDialog>

function CommandProbe(props: { onReady: (command: CommandDialog) => void }) {
  props.onReady(useCommandDialog())
  return null
}

function ResearchCockpitHarness(props: { fetch?: typeof fetch; onCommand?: (command: CommandDialog) => void } = {}) {
  return (
    <KVProvider>
      <ToastProvider>
        <TuiConfigProvider config={{ theme: "opencode" }}>
          <SDKProvider
            url="http://mock.local"
            directory="/tmp/neo-cast-research"
            fetch={props.fetch ?? researchFetch}
            events={{ subscribe: async () => () => {} }}
          >
            <ProjectProvider>
              <ThemeProvider mode="dark">
                <KeybindProvider>
                  <DialogProvider>
                    <CommandProvider>
                      <ResearchCockpit />
                      {props.onCommand ? <CommandProbe onReady={props.onCommand} /> : null}
                    </CommandProvider>
                  </DialogProvider>
                </KeybindProvider>
              </ThemeProvider>
            </ProjectProvider>
          </SDKProvider>
        </TuiConfigProvider>
      </ToastProvider>
    </KVProvider>
  )
}

async function waitForFrame(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  let lastFrame = ""
  for (let attempt = 0; attempt < 80; attempt++) {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    lastFrame = frame
    if (frame.includes(text)) return frame
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for frame to include ${text}\n\n${lastFrame}`)
}

describe("ResearchCockpit render", () => {
  test("renders task, candidate actions, and memory-backed rank metadata", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const app = await testRender(() => <ResearchCockpitHarness />, { width: 160, height: 48 })

    try {
      const frame = await waitForFrame(app, "phase2_frequency_rnn_quantile")

      expect(frame).toContain("NeoResearch Cockpit")
      expect(frame).toContain("Neo-Cast Autonomous TSF")
      expect(frame).toContain("Smoke Prep")
      expect(frame).toContain("Smoke Exec")
      expect(frame).toContain("Ref Prep")
      expect(frame).toContain("Blind Prep")
      expect(frame).toContain("ranker=tsf_profile_learned_memory_ranker_v1")
      expect(frame).toContain("task_memory=2")
      expect(frame).toContain("domain_memory=5")
      expect(frame).toContain("rows=1024")
      expect(frame).toContain("Memory")
    } finally {
      app.renderer.destroy()
    }
  })

  test("command palette can create full-recipe TSF tasks", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const bodies: unknown[] = []
    const fetchWithCreate = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === "/research/tasks" && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)))
        return Promise.resolve(
          response({
            id: "task_full_recipe",
            title: "TSF Autonomous Research",
            domainID: "tsf",
            mode: "autonomous",
            status: "created",
            taskSpec: {},
            objective: {},
            budget: {},
            time: { created: now, updated: now },
          }),
        )
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={fetchWithCreate} onCommand={(value) => (command = value)} />,
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "phase2_frequency_rnn_quantile")
      command?.trigger("research.create.autonomous.full")

      for (let attempt = 0; attempt < 40 && bodies.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toMatchObject({
        mode: "autonomous",
        taskSpec: {
          runtime: {
            bridgeOnly: false,
            neoCastProjectRoot: "/tmp/neo-cast-research",
          },
        },
      })
    } finally {
      app.renderer.destroy()
    }
  })
})
