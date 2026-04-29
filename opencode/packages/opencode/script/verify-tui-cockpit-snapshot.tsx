/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { Global } from "@opencode-ai/core/global"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { CommandProvider } from "../src/cli/cmd/tui/component/dialog-command"
import { KeybindProvider } from "../src/cli/cmd/tui/context/keybind"
import { KVProvider } from "../src/cli/cmd/tui/context/kv"
import { ProjectProvider } from "../src/cli/cmd/tui/context/project"
import { RouteProvider } from "../src/cli/cmd/tui/context/route"
import { SDKProvider } from "../src/cli/cmd/tui/context/sdk"
import { ThemeProvider } from "../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../src/cli/cmd/tui/context/tui-config"
import { ResearchCockpit } from "../src/cli/cmd/tui/routes/research-cockpit"
import { DialogProvider } from "../src/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "../src/cli/cmd/tui/ui/toast"

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

function mockResearchFetch(input: RequestInfo | URL) {
  const url = new URL(input.toString())
  const routePath = url.pathname

  if (routePath === "/research/tasks") {
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

  if (routePath === `/research/tasks/${taskID}/candidates`) {
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

  if (routePath === `/research/tasks/${taskID}/runs`) {
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

  if (routePath === `/research/tasks/${taskID}/artifacts`) {
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

  if (routePath === `/research/tasks/${taskID}/memory`) {
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

  if (routePath === `/research/tasks/${taskID}/fingerprint`) {
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

  if (routePath === `/research/tasks/${taskID}/approvals`) {
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
        {
          id: "approval_blind_01",
          taskID,
          candidateID,
          kind: "blind_test",
          status: "approved",
          reason: "Allow blind sidecar validation for the champion candidate.",
          time: { created: now - 18_000, updated: now - 17_000 },
          timeReplied: now - 17_000,
        },
      ]),
    )
  }

  if (routePath === `/research/tasks/${taskID}/champion`) {
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

function ResearchCockpitHarness() {
  return (
    <KVProvider>
      <ToastProvider>
        <RouteProvider initialRoute={{ type: "cockpit" }}>
          <TuiConfigProvider config={{ theme: "opencode" }}>
            <SDKProvider
              url="http://mock.local"
              directory="/tmp/neo-cast-research"
              fetch={mockResearchFetch as typeof fetch}
              events={{ subscribe: async () => () => {} }}
            >
              <ProjectProvider>
                <ThemeProvider mode="dark">
                  <KeybindProvider>
                    <DialogProvider>
                      <CommandProvider>
                        <ResearchCockpit />
                      </CommandProvider>
                    </DialogProvider>
                  </KeybindProvider>
                </ThemeProvider>
              </ProjectProvider>
            </SDKProvider>
          </TuiConfigProvider>
        </RouteProvider>
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

function assertFrame(frame: string, text: string) {
  if (!frame.includes(text)) throw new Error(`TUI cockpit snapshot missing: ${text}`)
}

async function main() {
  const snapshotPath = process.argv[2]
  const jsonPath = process.argv[3]
  if (!snapshotPath || !jsonPath) {
    throw new Error("usage: verify-tui-cockpit-snapshot.tsx <snapshot-path> <json-path>")
  }

  await mkdir(path.dirname(snapshotPath), { recursive: true })
  await mkdir(Global.Path.state, { recursive: true })
  await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

  const app = await testRender(() => <ResearchCockpitHarness />, { width: 160, height: 52 })

  try {
    const frame = await waitForFrame(app, "phase2_frequency_rnn_quantile")
    const required = [
      "NeoResearch Workspace",
      "Neo-Cast Autonomous TSF",
      "State",
      "Next Action",
      "Forecaster",
      "Champion",
      "Progress",
      "Context",
      "Smoke Prep",
      "Smoke Exec",
      "Ref Gate",
      "Ref Prep",
      "Ref Exec",
      "Blind Gate",
      "Blind Prep",
      "Blind Exec",
      "metric=0.1234",
      "utility=0.88",
      "Memory",
      "Artifacts",
      "ranker=tsf_profile_learned_memory_ranker_v1",
      "task_memory=2",
      "domain_memory=5",
      "rows=1024",
      "Frequency preprocessing helped the smoke objective.",
    ]

    required.forEach((text) => assertFrame(frame, text))
    await writeFile(snapshotPath, frame)
    await writeFile(
      jsonPath,
      `${JSON.stringify(
        {
          ok: true,
          snapshot: snapshotPath,
          bytes: Buffer.byteLength(frame),
          checks: required,
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    app.renderer.destroy()
  }
}

await main()
