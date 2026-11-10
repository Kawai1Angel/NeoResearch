import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@neoresearch-ai/core/cross-spawn-spawner"
import { Research } from "../../src/research"
import { formatResearchCockpitIntentCheckpointReason } from "../../src/cli/cmd/tui/routes/research-cockpit-data"
import { resetDatabase } from "../fixture/db"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Research.defaultLayer, CrossSpawnSpawner.defaultLayer))
afterEach(resetDatabase)

it.live("the service accepts TUI confirmation of the exact split and rejects it after a split edit", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const service = yield* Research.Service
      const task = yield* service.createTask({
        title: "ETTh1 96 to 96",
        domainID: "tsf",
        mode: "autonomous",
        interactionMode: "socratic",
        taskSpec: {
          contextLength: 96,
          predictionLengths: [96],
          dataset: { loaderID: "local_csv", path: "/data/ETTh1.csv", targetCols: ["OT"], split: { method: "ratio", ratios: [6, 2, 2] } },
        },
        objective: { primaryMetric: "cv_avg_mse", direction: "minimize" },
        budget: { maxRuns: 200, loop: { maxIterations: 25, maxNoImprove: 25 } },
      })
      const approval = yield* service.createApproval({
        taskID: task.id, kind: "protocol", reason: formatResearchCockpitIntentCheckpointReason(task),
      })
      expect((yield* service.replyApproval({ approvalID: approval.id, status: "approved" })).status).toBe("approved")
      const updated = yield* service.updateTaskSpec({
        taskID: task.id,
        taskSpec: { ...task.taskSpec, dataset: { ...(task.taskSpec.dataset as object), split: { method: "ratio", ratios: [7, 1, 2] } } },
      })
      const stale = yield* service.replyApproval({ approvalID: approval.id, status: "approved" }).pipe(Effect.exit)
      expect(stale._tag).toBe("Failure")
      const fresh = yield* service.createApproval({
        taskID: task.id, kind: "protocol", reason: formatResearchCockpitIntentCheckpointReason(updated),
      })
      expect((yield* service.replyApproval({ approvalID: fresh.id, status: "approved" })).status).toBe("approved")
    }),
  ),
)
