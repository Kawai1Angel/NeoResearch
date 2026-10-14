import { chromium } from "@playwright/test"
import { mkdir, writeFile } from "fs/promises"
import path from "path"

const now = 1_765_000_000_000
const directory = "/tmp/neo-cast-research"
const taskID = "task_neo_cast_01"
const candidateID = "cand_phase2_01"
const runID = "run_smoke_01"

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  }
}

async function verifyLocator(locator: ReturnType<import("@playwright/test").Page["locator"]>, label: string) {
  await locator
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch((error) => {
      throw new Error(`missing visible Web Dashboard element: ${label}\n${error}`)
    })
}

async function verifyViewport(input: {
  artifactDir: string
  baseURL: string
  name: "desktop" | "mobile"
  viewport: { width: number; height: number }
}) {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: input.viewport,
    deviceScaleFactor: input.name === "mobile" ? 2 : 1,
    isMobile: input.name === "mobile",
  })
  const page = await context.newPage()
  const jsErrors: string[] = []
  const apiRequests: string[] = []

  page.on("pageerror", (error) => jsErrors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") jsErrors.push(message.text())
  })

  const isBackendRequest = (url: URL) =>
    /^http:\/\/(127\.0\.0\.1|localhost):4096\//.test(url.href) ||
    (url.origin === new URL(input.baseURL).origin &&
      /^\/(global|project|provider|path|research)(\/|$)/.test(url.pathname))
  await page.route(isBackendRequest, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const routePath = url.pathname

    if (routePath === "/global/health") {
      await route.fulfill(json({ healthy: true, version: "0.1.0-alpha.0" }))
      return
    }

    if (routePath === "/global/event") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: ": neo-research dashboard verification\n\n",
      })
      return
    }

    if (routePath === "/global/config") {
      await route.fulfill(json({}))
      return
    }

    if (routePath === "/provider") {
      await route.fulfill(json({ all: [], connected: [], default: {} }))
      return
    }

    if (routePath === "/path") {
      await route.fulfill(
        json({
          state: "/tmp/opencode-state",
          config: "/tmp/opencode-config",
          worktree: directory,
          directory,
          home: "/tmp",
        }),
      )
      return
    }

    if (routePath === "/project") {
      await route.fulfill(
        json([
          {
            id: "project_neo_cast",
            worktree: directory,
            vcs: "git",
            time: { created: now - 60_000, updated: now },
          },
        ]),
      )
      return
    }

    if (routePath === "/research/tasks") {
      await route.fulfill(
        json([
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
              runtime: {
                bridgeOnly: false,
                neoCastProjectRoot: "/tmp/neo-cast",
              },
            },
            objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
            budget: { maxRuns: 12, maxParallel: 1 },
            time: { created: now - 60_000, updated: now },
          },
        ]),
      )
      return
    }

    if (routePath === `/research/tasks/${taskID}/candidates`) {
      await route.fulfill(
        json([
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
      return
    }

    if (routePath === `/research/tasks/${taskID}/runs`) {
      await route.fulfill(
        json([
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
      return
    }

    if (routePath === `/research/tasks/${taskID}/approvals`) {
      await route.fulfill(
        json([
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
      return
    }

    if (routePath === `/research/tasks/${taskID}/artifacts`) {
      await route.fulfill(
        json([
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
      return
    }

    if (routePath === `/research/tasks/${taskID}/champion`) {
      await route.fulfill(
        json({
          taskID,
          candidateID,
          runID,
          primaryMetric: 0.1234,
          utility: 0.88,
          acceptedAt: now - 6_000,
          time: { created: now - 6_000, updated: now - 6_000 },
        }),
      )
      return
    }

    if (routePath === `/research/tasks/${taskID}/memory`) {
      await route.fulfill(
        json([
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
      return
    }

    if (routePath === `/research/tasks/${taskID}/fingerprint`) {
      await route.fulfill(
        json({
          contextLength: 96,
          horizon: "24",
          targetCount: 1,
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
      return
    }

    if (
      routePath === `/research/tasks/${taskID}/candidates/${candidateID}/prepare-run` &&
      request.method() === "POST"
    ) {
      apiRequests.push(`${input.name}:prepare-run`)
      await route.fulfill(
        json({
          run: {
            id: "run_prepared_01",
            taskID,
            candidateID,
            stage: "smoke",
            status: "queued",
            metrics: {},
            resourceUsage: {},
            artifactRefs: [],
            time: { created: now, updated: now },
          },
        }),
      )
      return
    }

    if (
      routePath === `/research/tasks/${taskID}/candidates/${candidateID}/execute-run` &&
      request.method() === "POST"
    ) {
      apiRequests.push(`${input.name}:execute-run`)
      await route.fulfill(
        json({
          run: {
            id: "run_executed_01",
            taskID,
            candidateID,
            stage: "smoke",
            status: "succeeded",
            metrics: { val_avg_mse: 0.119 },
            resourceUsage: { wallClockSec: 5 },
            artifactRefs: [],
            time: { created: now, updated: now },
          },
        }),
      )
      return
    }

    await route.fulfill(json([]))
  })

  try {
    // The first Vite request compiles the dashboard and its workspace dependencies.
    await page.goto(input.baseURL, { waitUntil: "domcontentloaded", timeout: 120_000 })

    await verifyLocator(page.getByText("NeoResearch", { exact: true }), "NeoResearch header")
    await verifyLocator(page.getByText("Dashboard", { exact: true }), "Dashboard header")
    await verifyLocator(page.getByText("Research Tasks", { exact: true }), "Research task list")
    await verifyLocator(page.getByText("Candidates", { exact: true }), "candidate list")
    await verifyLocator(page.getByText("Neo-Cast Autonomous TSF").first(), "research task row")
    await verifyLocator(page.getByText("phase2_frequency_rnn_quantile"), "candidate recipe")
    await verifyLocator(page.getByRole("button", { name: "Smoke Prep" }), "Prepare button")
    await verifyLocator(page.getByRole("button", { name: "Smoke Exec" }), "Execute button")
    await verifyLocator(page.getByRole("button", { name: "Blind Prep" }), "blind Prepare button")
    await verifyLocator(page.getByRole("button", { name: "Blind Exec" }), "blind Execute button")
    await verifyLocator(page.getByText("Artifacts", { exact: true }), "artifact section")
    await verifyLocator(page.getByText("ranker=tsf_profile_learned_memory_ranker_v1"), "artifact metadata")
    await verifyLocator(page.getByText("Memory", { exact: true }), "memory section")
    await verifyLocator(page.getByText("Frequency preprocessing helped the smoke objective."), "memory lesson")
    await verifyLocator(page.getByText("Profile", { exact: true }), "profile section")
    await verifyLocator(page.getByText("rows=1024").first(), "profile data")

    await page.getByRole("button", { name: "Smoke Prep" }).click()
    await verifyLocator(page.getByText("run_prep smoke queued"), "prepare status update")
    await page.getByRole("button", { name: "Smoke Exec" }).click()
    await verifyLocator(page.getByText("run_exec smoke succeeded"), "execute status update")

    if (!apiRequests.includes(`${input.name}:prepare-run`))
      throw new Error("Smoke Prep did not issue prepare-run API request")
    if (!apiRequests.includes(`${input.name}:execute-run`))
      throw new Error("Smoke Exec did not issue execute-run API request")
    if (jsErrors.length > 0) throw new Error(`JavaScript errors in ${input.name}: ${jsErrors.join(" | ")}`)

    const screenshotPath = path.join(input.artifactDir, `web-dashboard-${input.name}.png`)
    const screenshot = await page.screenshot({ fullPage: true, path: screenshotPath })
    if (screenshot.length < 20_000)
      throw new Error(`${input.name} screenshot appears blank: ${screenshot.length} bytes`)

    return {
      name: input.name,
      screenshot: screenshotPath,
      screenshotBytes: screenshot.length,
      apiRequests,
      jsErrors,
    }
  } finally {
    await browser.close()
  }
}

async function main() {
  const baseURL = process.argv[2]
  const artifactDir = process.argv[3]
  if (!baseURL || !artifactDir) throw new Error("usage: verify-web-dashboard.ts <base-url> <artifact-dir>")

  await mkdir(artifactDir, { recursive: true })
  const results = [
    await verifyViewport({ artifactDir, baseURL, name: "desktop", viewport: { width: 1440, height: 1000 } }),
    await verifyViewport({ artifactDir, baseURL, name: "mobile", viewport: { width: 390, height: 844 } }),
  ]

  await writeFile(
    path.join(artifactDir, "web-dashboard.json"),
    `${JSON.stringify({ ok: true, baseURL, results }, null, 2)}\n`,
  )
}

await main()
