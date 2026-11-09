import { expect, test } from "@playwright/test"

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

test("renders the NeoResearch dashboard and executes a per-candidate smoke prepare action", async ({ page }, info) => {
  await page.route(/^http:\/\/(127\.0\.0\.1|localhost):4096\//, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname

    if (path === "/global/event") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: ": neo-research dashboard smoke\n\n",
      })
      return
    }

    if (path === "/global/config") {
      await route.fulfill(json({}))
      return
    }

    if (path === "/provider") {
      await route.fulfill(json({ all: [], connected: [], default: {} }))
      return
    }

    if (path === "/path") {
      await route.fulfill(
        json({
          state: "/tmp/neoresearch-state",
          config: "/tmp/neoresearch-config",
          worktree: directory,
          directory,
          home: "/tmp",
        }),
      )
      return
    }

    if (path === "/project") {
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

    if (path === "/research/tasks") {
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

    if (path === `/research/tasks/${taskID}/candidates`) {
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

    if (path === `/research/tasks/${taskID}/runs`) {
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

    if (path === `/research/tasks/${taskID}/approvals`) {
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
        ]),
      )
      return
    }

    if (path === `/research/tasks/${taskID}/artifacts`) {
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

    if (path === `/research/tasks/${taskID}/champion`) {
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

    if (path === `/research/tasks/${taskID}/memory`) {
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

    if (path === `/research/tasks/${taskID}/fingerprint`) {
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

    if (path === `/research/tasks/${taskID}/candidates/${candidateID}/prepare-run` && request.method() === "POST") {
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

    if (path === `/research/tasks/${taskID}/candidates/${candidateID}/seed-sweep` && request.method() === "POST") {
      await route.fulfill(
        json({
          candidateID,
          seeds: [3, 5],
          runs: [
            {
              run: {
                id: "run_seed_03",
                taskID,
                candidateID,
                stage: "smoke",
                status: "succeeded",
                metrics: { val_avg_mse: 0.121 },
                resourceUsage: { seed: 3 },
                artifactRefs: [],
                time: { created: now, updated: now },
              },
            },
            {
              run: {
                id: "run_seed_05",
                taskID,
                candidateID,
                stage: "smoke",
                status: "succeeded",
                metrics: { val_avg_mse: 0.125 },
                resourceUsage: { seed: 5 },
                artifactRefs: [],
                time: { created: now, updated: now },
              },
            },
          ],
        }),
      )
      return
    }

    await route.fulfill(json([]))
  })

  await page.goto("/")

  await expect(page.getByText("NeoResearch", { exact: true })).toBeVisible()
  await expect(page.getByText("Dashboard", { exact: true })).toBeVisible()
  await expect(page.getByText("Neo-Cast Autonomous TSF").first()).toBeVisible()
  await expect(page.getByText("phase2_frequency_rnn_quantile")).toBeVisible()
  await expect(page.getByText("frequency_filter+instance_norm / patch / rnn / feature_fusion / quantile / adamw")).toBeVisible()
  await expect(page.getByText("ranker=tsf_profile_learned_memory_ranker_v1")).toBeVisible()
  await expect(page.getByText("task_memory=2")).toBeVisible()
  await expect(page.getByText("domain_memory=5")).toBeVisible()
  await expect(page.getByRole("button", { name: "Blind Gate" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Blind Prep" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Blind Exec" })).toBeVisible()

  await page.getByRole("button", { name: "Smoke Prep" }).click()
  await expect(page.getByText("run_prep smoke queued")).toBeVisible()

  await page.getByRole("button", { name: "Seed Sweep" }).click()
  await expect(page.getByText("seed sweep: 2 runs, 2 succeeded, seeds 3, 5")).toBeVisible()

  const screenshot = await page.screenshot({
    fullPage: true,
    path: info.outputPath("research-dashboard-smoke.png"),
  })
  expect(screenshot.length).toBeGreaterThan(50_000)
})
