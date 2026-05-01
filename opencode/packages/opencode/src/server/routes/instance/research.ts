import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Research } from "@/research"
import { lazy } from "@/util/lazy"
import { errors } from "../../error"
import { jsonRequest } from "./trace"

const taskParam = z.object({
  taskID: Research.ResearchTaskID.zod,
})

const taskCandidateParam = z.object({
  taskID: Research.ResearchTaskID.zod,
  candidateID: Research.ResearchCandidateID.zod,
})

const runParam = z.object({
  runID: Research.ResearchRunID.zod,
})

const approvalParam = z.object({
  approvalID: Research.ResearchApprovalID.zod,
})

const domainParam = z.object({
  domainID: z.string(),
})

const researchManagerTraceSchema = z
  .object({
    role: z.enum(["diagnostic", "design", "coder", "runner", "analyst", "librarian"]),
    status: z.enum(["completed", "skipped", "blocked"]),
    summary: z.string(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .array()

export const ResearchRoutes = lazy(() =>
  new Hono()
    .get(
      "/domains",
      describeRoute({
        summary: "List research domains",
        description: "List built-in NeoResearch domain plugins and their action registries.",
        operationId: "research.domains.list",
        responses: {
          200: {
            description: "List of research domains",
            content: {
              "application/json": {
                schema: resolver(Research.DomainInfo.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ResearchRoutes.domains.list", c, function* () {
          return Research.DomainRegistry.list()
        }),
    )
    .get(
      "/domains/:domainID",
      describeRoute({
        summary: "Get research domain",
        description: "Get a built-in NeoResearch domain plugin by ID.",
        operationId: "research.domains.get",
        responses: {
          200: {
            description: "Research domain",
            content: {
              "application/json": {
                schema: resolver(Research.DomainInfo),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", domainParam),
      async (c) =>
        jsonRequest("ResearchRoutes.domains.get", c, function* () {
          return Research.DomainRegistry.getInfo(c.req.valid("param").domainID)
        }),
    )
    .post(
      "/domains/:domainID/baselines",
      describeRoute({
        summary: "Build domain baselines",
        description: "Build baseline candidate proposals for a domain task spec.",
        operationId: "research.domains.baselines",
        responses: {
          200: {
            description: "Baseline candidate proposals",
            content: {
              "application/json": {
                schema: resolver(Research.DomainCandidateProposal.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", domainParam),
      validator("json", z.object({ taskSpec: Research.JsonRecord.zod })),
      async (c) =>
        jsonRequest("ResearchRoutes.domains.baselines", c, function* () {
          return Research.DomainRegistry.buildBaselines(c.req.valid("param").domainID, c.req.valid("json").taskSpec)
        }),
    )
    .post(
      "/domains/:domainID/validate-candidate",
      describeRoute({
        summary: "Validate domain candidate",
        description: "Validate a candidate spec against a domain task spec and action registry.",
        operationId: "research.domains.validateCandidate",
        responses: {
          200: {
            description: "Candidate validation result",
            content: {
              "application/json": {
                schema: resolver(Research.DomainValidationResult),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", domainParam),
      validator(
        "json",
        z.object({
          taskSpec: Research.JsonRecord.zod,
          candidateSpec: Research.JsonRecord.zod,
        }),
      ),
      async (c) =>
        jsonRequest("ResearchRoutes.domains.validateCandidate", c, function* () {
          return Research.DomainRegistry.validateCandidate(c.req.valid("param").domainID, c.req.valid("json"))
        }),
    )
    .post(
      "/domains/:domainID/run-plan",
      describeRoute({
        summary: "Create domain run plan",
        description: "Render a validated domain candidate into a runner payload and subprocess command plan.",
        operationId: "research.domains.runPlan",
        responses: {
          200: {
            description: "Domain run plan",
            content: {
              "application/json": {
                schema: resolver(Research.DomainRunPlan),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", domainParam),
      validator(
        "json",
        z.object({
          taskSpec: Research.JsonRecord.zod,
          candidateSpec: Research.JsonRecord.zod,
          stage: Research.DomainRunStage.optional(),
          description: z.string().optional(),
        }),
      ),
      async (c) =>
        jsonRequest("ResearchRoutes.domains.runPlan", c, function* () {
          return Research.DomainRegistry.createRunPlan(c.req.valid("param").domainID, c.req.valid("json"))
        }),
    )
    .get(
      "/tasks",
      describeRoute({
        summary: "List research tasks",
        description: "List research tasks for the current OpenCode project.",
        operationId: "research.tasks.list",
        responses: {
          200: {
            description: "List of research tasks",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchTask.zod.array()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          domainID: z.string().optional(),
          status: Research.ResearchTaskStatus.zod.optional(),
          limit: z.coerce.number().optional(),
        }),
      ),
      async (c) =>
        jsonRequest("ResearchRoutes.tasks.list", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.listTasks(c.req.valid("query"))
        }),
    )
    .post(
      "/tasks",
      describeRoute({
        summary: "Create research task",
        description: "Create a research task for the current OpenCode project.",
        operationId: "research.tasks.create",
        responses: {
          200: {
            description: "Research task created",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchTask.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Research.CreateTaskInput.zod),
      async (c) =>
        jsonRequest("ResearchRoutes.tasks.create", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.createTask(c.req.valid("json"))
        }),
    )
    .get(
      "/tasks/:taskID",
      describeRoute({
        summary: "Get research task",
        description: "Get a research task by ID.",
        operationId: "research.tasks.get",
        responses: {
          200: {
            description: "Research task",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchTask.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      async (c) =>
        jsonRequest("ResearchRoutes.tasks.get", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.getTask(c.req.valid("param").taskID)
        }),
    )
    .get(
      "/tasks/:taskID/fingerprint",
      describeRoute({
        summary: "Summarize research task fingerprint",
        description: "Return the domain-specific task fingerprint used for proposal priors and research memory.",
        operationId: "research.tasks.fingerprint",
        responses: {
          200: {
            description: "Domain task fingerprint",
            content: {
              "application/json": {
                schema: resolver(Research.JsonRecord.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      async (c) =>
        jsonRequest("ResearchRoutes.tasks.fingerprint", c, function* () {
          const svc = yield* Research.Service
          const task = yield* svc.getTask(c.req.valid("param").taskID)
          return Research.DomainRegistry.summarizeTask(task.domainID, task.taskSpec)
        }),
    )
    .post(
      "/tasks/:taskID/profile",
      describeRoute({
        summary: "Profile research task",
        description: "Run the domain task profiler and persist a diagnostic profile artifact.",
        operationId: "research.tasks.profile",
        responses: {
          200: {
            description: "Task profile artifact and fingerprint",
            content: {
              "application/json": {
                schema: resolver(Research.ProfileTaskResult.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      validator("json", z.object({ outputDir: z.string().optional() }).default({})),
      async (c) =>
        jsonRequest("ResearchRoutes.tasks.profile", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.profileTask({
            taskID: c.req.valid("param").taskID,
            ...c.req.valid("json"),
          })
        }),
    )
    .post(
      "/tasks/:taskID/prepare-dataset",
      describeRoute({
        summary: "Prepare research task dataset",
        description: "Materialize the task dataset into the configured Neo-Cast dataset contract.",
        operationId: "research.tasks.prepareDataset",
        responses: {
          200: {
            description: "Prepared dataset contract artifact",
            content: {
              "application/json": {
                schema: resolver(Research.PrepareTaskDatasetResult.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      validator("json", z.object({ force: z.boolean().optional(), outputDir: z.string().optional() }).default({})),
      async (c) =>
        jsonRequest("ResearchRoutes.tasks.prepareDataset", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.prepareTaskDataset({
            taskID: c.req.valid("param").taskID,
            ...c.req.valid("json"),
          })
        }),
    )
    .patch(
      "/tasks/:taskID/spec",
      describeRoute({
        summary: "Update research task spec",
        description: "Replace and validate the task spec for a research task.",
        operationId: "research.tasks.updateSpec",
        responses: {
          200: {
            description: "Updated research task",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchTask.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      validator("json", z.object({ taskSpec: Research.JsonRecord.zod })),
      async (c) =>
        jsonRequest("ResearchRoutes.tasks.updateSpec", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.updateTaskSpec({
            taskID: c.req.valid("param").taskID,
            taskSpec: c.req.valid("json").taskSpec,
          })
        }),
    )
    .patch(
      "/tasks/:taskID/status",
      describeRoute({
        summary: "Update research task status",
        description: "Update the status of a research task.",
        operationId: "research.tasks.updateStatus",
        responses: {
          200: {
            description: "Updated research task",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchTask.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      validator("json", z.object({ status: Research.ResearchTaskStatus.zod })),
      async (c) =>
        jsonRequest("ResearchRoutes.tasks.updateStatus", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.updateTaskStatus({
            taskID: c.req.valid("param").taskID,
            status: c.req.valid("json").status,
          })
        }),
    )
    .post(
      "/tasks/:taskID/baselines",
      describeRoute({
        summary: "Seed task baselines",
        description: "Persist domain baseline candidates for a research task and create approval requests when needed.",
        operationId: "research.tasks.seedBaselines",
        responses: {
          200: {
            description: "Seeded baseline candidates and approval requests",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    candidates: Research.ResearchCandidate.zod.array(),
                    approvals: Research.ResearchApproval.zod.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      async (c) =>
        jsonRequest("ResearchRoutes.tasks.seedBaselines", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.seedBaselines({ taskID: c.req.valid("param").taskID })
        }),
    )
    .post(
      "/tasks/:taskID/export",
      describeRoute({
        summary: "Export research task artifact",
        description: "Export a research task summary report and persist it as a research artifact.",
        operationId: "research.tasks.export",
        responses: {
          200: {
            description: "Exported research artifact",
            content: {
              "application/json": {
                schema: resolver(Research.ExportTaskArtifactResult.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      validator(
        "json",
        z.object({
          kind: Research.ExportArtifactKind.zod.optional(),
          outputDir: z.string().optional(),
        }),
      ),
      async (c) =>
        jsonRequest("ResearchRoutes.tasks.export", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.exportTaskArtifact({
            taskID: c.req.valid("param").taskID,
            ...c.req.valid("json"),
          })
        }),
    )
    .post(
      "/tasks/:taskID/pipeline",
      describeRoute({
        summary: "Run multi-agent research pipeline",
        description: "Run intent, data analysis, NAS, and publish agents for an autonomous research task.",
        operationId: "research.tasks.pipeline",
        responses: {
          200: {
            description: "Multi-agent pipeline result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    task: Research.ResearchTask.zod,
                    intent: z.object({ taskID: Research.ResearchTaskID.zod }).passthrough(),
                    dataAnalysis: z.object({ artifact: Research.ResearchArtifact.zod }).passthrough(),
                    nas: z.object({ loop: z.object({ artifact: Research.ResearchArtifact.zod }).passthrough() }).passthrough(),
                    publish: z.object({ artifact: Research.ResearchArtifact.zod, path: z.string() }).passthrough(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      validator(
        "json",
        z.object({
          stage: Research.ExecutableRunStage.zod.optional(),
          description: z.string().optional(),
          maxIterations: z.number().int().min(1).max(50).optional(),
          targetMetricValue: z.number().optional(),
          minRelativeImprovement: z.number().min(0).optional(),
          maxNoImprove: z.number().int().min(0).optional(),
          timeBudgetSeconds: z.number().positive().optional(),
          maxCrashStreak: z.number().int().min(0).optional(),
          outputDir: z.string().optional(),
          forceDatasetPreparation: z.boolean().optional(),
        }),
      ),
      async (c) =>
        jsonRequest("ResearchRoutes.tasks.pipeline", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.runFullPipeline({
            taskID: c.req.valid("param").taskID,
            ...c.req.valid("json"),
          })
        }),
    )
    .post(
      "/tasks/:taskID/autonomous/iterate",
      describeRoute({
        summary: "Run autonomous iteration",
        description: "Run one autonomous research iteration for a task within the current approval and budget policy.",
        operationId: "research.tasks.autonomousIterate",
        responses: {
          200: {
            description: "Autonomous iteration result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    candidate: Research.ResearchCandidate.zod,
                    seededCandidates: Research.ResearchCandidate.zod.array(),
                    approvals: Research.ResearchApproval.zod.array(),
                    run: Research.ResearchRun.zod,
                    runPlan: Research.DomainRunPlan,
                    managerTrace: researchManagerTraceSchema,
                    selectionArtifact: Research.ResearchArtifact.zod,
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      validator(
        "json",
        z.object({
          stage: Research.ExecutableRunStage.zod.optional(),
          description: z.string().optional(),
          seed: z.number().int().min(0).optional(),
        }),
      ),
      async (c) =>
        jsonRequest("ResearchRoutes.tasks.autonomousIterate", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.runAutonomousIteration({
            taskID: c.req.valid("param").taskID,
            ...c.req.valid("json"),
          })
        }),
    )
    .post(
      "/tasks/:taskID/autonomous/loop",
      describeRoute({
        summary: "Run autonomous loop",
        description:
          "Run multiple autonomous research iterations for a task within the current approval and budget policy.",
        operationId: "research.tasks.autonomousLoop",
        responses: {
          200: {
            description: "Autonomous loop result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    iterations: z
                      .object({
                        candidate: Research.ResearchCandidate.zod,
                        seededCandidates: Research.ResearchCandidate.zod.array(),
                        approvals: Research.ResearchApproval.zod.array(),
                        run: Research.ResearchRun.zod,
                        runPlan: Research.DomainRunPlan,
                        managerTrace: researchManagerTraceSchema,
                        selectionArtifact: Research.ResearchArtifact.zod,
                      })
                      .array(),
                    stoppedReason: z.enum([
                      "max_iterations",
                      "budget_exhausted",
                      "approval_required",
                      "seed_failed",
                      "target_reached",
                      "plateau",
                      "time_budget_exhausted",
                      "crash_streak_exceeded",
                    ]),
                    artifact: Research.ResearchArtifact.zod,
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      validator(
        "json",
        z.object({
          stage: Research.ExecutableRunStage.zod.optional(),
          description: z.string().optional(),
          maxIterations: z.number().int().min(1).max(50).optional(),
          targetMetricValue: z.number().optional(),
          minRelativeImprovement: z.number().min(0).optional(),
          maxNoImprove: z.number().int().min(0).optional(),
          timeBudgetSeconds: z.number().positive().optional(),
          maxCrashStreak: z.number().int().min(0).optional(),
        }),
      ),
      async (c) =>
        jsonRequest("ResearchRoutes.tasks.autonomousLoop", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.runAutonomousLoop({
            taskID: c.req.valid("param").taskID,
            ...c.req.valid("json"),
          })
        }),
    )
    .post(
      "/tasks/:taskID/candidates/:candidateID/prepare-run",
      describeRoute({
        summary: "Prepare candidate run",
        description: "Create a queued run and domain runner plan for an approved research candidate.",
        operationId: "research.candidates.prepareRun",
        responses: {
          200: {
            description: "Prepared research run and runner plan",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    run: Research.ResearchRun.zod,
                    runPlan: Research.DomainRunPlan,
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskCandidateParam),
      validator(
        "json",
        z.object({
          stage: Research.ExecutableRunStage.zod.optional(),
          description: z.string().optional(),
          seed: z.number().int().min(0).optional(),
        }),
      ),
      async (c) =>
        jsonRequest("ResearchRoutes.candidates.prepareRun", c, function* () {
          const svc = yield* Research.Service
          const params = c.req.valid("param")
          return yield* svc.prepareRun({
            taskID: params.taskID,
            candidateID: params.candidateID,
            ...c.req.valid("json"),
          })
        }),
    )
    .post(
      "/tasks/:taskID/candidates/:candidateID/execute-run",
      describeRoute({
        summary: "Execute candidate run",
        description: "Create and execute a run using the domain runner plan for an approved research candidate.",
        operationId: "research.candidates.executeRun",
        responses: {
          200: {
            description: "Executed research run and runner plan",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    run: Research.ResearchRun.zod,
                    runPlan: Research.DomainRunPlan,
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskCandidateParam),
      validator(
        "json",
        z.object({
          stage: Research.ExecutableRunStage.zod.optional(),
          description: z.string().optional(),
        }),
      ),
      async (c) =>
        jsonRequest("ResearchRoutes.candidates.executeRun", c, function* () {
          const svc = yield* Research.Service
          const params = c.req.valid("param")
          return yield* svc.executeRun({
            taskID: params.taskID,
            candidateID: params.candidateID,
            ...c.req.valid("json"),
          })
        }),
    )
    .post(
      "/tasks/:taskID/candidates/:candidateID/seed-sweep",
      describeRoute({
        summary: "Execute candidate seed sweep",
        description:
          "Execute a candidate once per seed, defaulting to the task evaluation seeds, and persist each run.",
        operationId: "research.candidates.seedSweep",
        responses: {
          200: {
            description: "Executed seed sweep runs",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    seeds: z.number().array(),
                    runs: z
                      .object({
                        run: Research.ResearchRun.zod,
                        runPlan: Research.DomainRunPlan,
                      })
                      .array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskCandidateParam),
      validator(
        "json",
        z.object({
          stage: Research.ExecutableRunStage.zod.optional(),
          description: z.string().optional(),
          seeds: z.number().int().min(0).array().optional(),
        }),
      ),
      async (c) =>
        jsonRequest("ResearchRoutes.candidates.seedSweep", c, function* () {
          const svc = yield* Research.Service
          const params = c.req.valid("param")
          return yield* svc.executeSeedSweep({
            taskID: params.taskID,
            candidateID: params.candidateID,
            ...c.req.valid("json"),
          })
        }),
    )
    .post(
      "/candidates",
      describeRoute({
        summary: "Create research candidate",
        description: "Create a candidate for a research task.",
        operationId: "research.candidates.create",
        responses: {
          200: {
            description: "Research candidate created",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchCandidate.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("json", Research.CreateCandidateInput.zod),
      async (c) =>
        jsonRequest("ResearchRoutes.candidates.create", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.createCandidate(c.req.valid("json"))
        }),
    )
    .get(
      "/tasks/:taskID/candidates",
      describeRoute({
        summary: "List research candidates",
        description: "List candidates for a research task.",
        operationId: "research.candidates.list",
        responses: {
          200: {
            description: "List of research candidates",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchCandidate.zod.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      async (c) =>
        jsonRequest("ResearchRoutes.candidates.list", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.listCandidates(c.req.valid("param").taskID)
        }),
    )
    .post(
      "/approvals",
      describeRoute({
        summary: "Create research approval",
        description: "Create a research approval request for Review Mode or gated autonomous actions.",
        operationId: "research.approvals.create",
        responses: {
          200: {
            description: "Research approval created",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchApproval.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("json", Research.CreateApprovalInput.zod),
      async (c) =>
        jsonRequest("ResearchRoutes.approvals.create", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.createApproval(c.req.valid("json"))
        }),
    )
    .get(
      "/tasks/:taskID/approvals",
      describeRoute({
        summary: "List research approvals",
        description: "List approval requests for a research task.",
        operationId: "research.approvals.list",
        responses: {
          200: {
            description: "List of research approvals",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchApproval.zod.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      validator(
        "query",
        z.object({
          status: Research.ApprovalStatus.zod.optional(),
          limit: z.coerce.number().optional(),
        }),
      ),
      async (c) =>
        jsonRequest("ResearchRoutes.approvals.list", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.listApprovals({
            taskID: c.req.valid("param").taskID,
            ...c.req.valid("query"),
          })
        }),
    )
    .post(
      "/approvals/:approvalID/reply",
      describeRoute({
        summary: "Reply to research approval",
        description: "Approve or reject a research approval request.",
        operationId: "research.approvals.reply",
        responses: {
          200: {
            description: "Updated research approval",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchApproval.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", approvalParam),
      validator(
        "json",
        z.object({
          status: Research.ApprovalReplyStatus.zod,
          replyMessage: z.string().optional(),
        }),
      ),
      async (c) =>
        jsonRequest("ResearchRoutes.approvals.reply", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.replyApproval({
            approvalID: c.req.valid("param").approvalID,
            ...c.req.valid("json"),
          })
        }),
    )
    .post(
      "/runs",
      describeRoute({
        summary: "Create research run",
        description: "Create a run for a research candidate.",
        operationId: "research.runs.create",
        responses: {
          200: {
            description: "Research run created",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchRun.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("json", Research.CreateRunInput.zod),
      async (c) =>
        jsonRequest("ResearchRoutes.runs.create", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.createRun(c.req.valid("json"))
        }),
    )
    .patch(
      "/runs/:runID/status",
      describeRoute({
        summary: "Update research run status",
        description: "Update the status and optional outputs of a research run.",
        operationId: "research.runs.updateStatus",
        responses: {
          200: {
            description: "Updated research run",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchRun.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", runParam),
      validator(
        "json",
        z.object({
          status: Research.ResearchRunStatus.zod,
          metrics: Research.JsonRecord.zod.optional(),
          resourceUsage: Research.JsonRecord.zod.optional(),
          artifactRefs: Research.ResearchArtifactID.zod.array().optional(),
          error: z.string().optional(),
        }),
      ),
      async (c) =>
        jsonRequest("ResearchRoutes.runs.updateStatus", c, function* () {
          const svc = yield* Research.Service
          const body = c.req.valid("json")
          return yield* svc.updateRunStatus({
            runID: c.req.valid("param").runID,
            status: body.status,
            metrics: body.metrics,
            resourceUsage: body.resourceUsage,
            artifactRefs: body.artifactRefs,
            error: body.error,
          })
        }),
    )
    .get(
      "/tasks/:taskID/runs",
      describeRoute({
        summary: "List research runs",
        description: "List runs for a research task.",
        operationId: "research.runs.list",
        responses: {
          200: {
            description: "List of research runs",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchRun.zod.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      async (c) =>
        jsonRequest("ResearchRoutes.runs.list", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.listRuns(c.req.valid("param").taskID)
        }),
    )
    .post(
      "/artifacts",
      describeRoute({
        summary: "Create research artifact",
        description: "Create an artifact record for a research task.",
        operationId: "research.artifacts.create",
        responses: {
          200: {
            description: "Research artifact created",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchArtifact.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("json", Research.CreateArtifactInput.zod),
      async (c) =>
        jsonRequest("ResearchRoutes.artifacts.create", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.createArtifact(c.req.valid("json"))
        }),
    )
    .get(
      "/tasks/:taskID/artifacts",
      describeRoute({
        summary: "List research artifacts",
        description: "List artifacts for a research task.",
        operationId: "research.artifacts.list",
        responses: {
          200: {
            description: "List of research artifacts",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchArtifact.zod.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      async (c) =>
        jsonRequest("ResearchRoutes.artifacts.list", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.listArtifacts(c.req.valid("param").taskID)
        }),
    )
    .post(
      "/memory",
      describeRoute({
        summary: "Create research memory",
        description: "Create a memory record for a research task.",
        operationId: "research.memory.create",
        responses: {
          200: {
            description: "Research memory created",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchMemory.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("json", Research.CreateMemoryInput.zod),
      async (c) =>
        jsonRequest("ResearchRoutes.memory.create", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.createMemory(c.req.valid("json"))
        }),
    )
    .get(
      "/tasks/:taskID/memory",
      describeRoute({
        summary: "List research memory",
        description: "List memory records for a research task.",
        operationId: "research.memory.list",
        responses: {
          200: {
            description: "List of research memory records",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchMemory.zod.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      async (c) =>
        jsonRequest("ResearchRoutes.memory.list", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.listMemory(c.req.valid("param").taskID)
        }),
    )
    .post(
      "/champions",
      describeRoute({
        summary: "Set research champion",
        description: "Set or replace the champion candidate for a research task.",
        operationId: "research.champions.set",
        responses: {
          200: {
            description: "Research champion",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchChampion.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("json", Research.SetChampionInput.zod),
      async (c) =>
        jsonRequest("ResearchRoutes.champions.set", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.setChampion(c.req.valid("json"))
        }),
    )
    .get(
      "/tasks/:taskID/champion",
      describeRoute({
        summary: "Get research champion",
        description: "Get the champion candidate for a research task.",
        operationId: "research.champions.get",
        responses: {
          200: {
            description: "Research champion or null",
            content: {
              "application/json": {
                schema: resolver(Research.ResearchChampion.zod.nullable()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", taskParam),
      async (c) =>
        jsonRequest("ResearchRoutes.champions.get", c, function* () {
          const svc = yield* Research.Service
          return (yield* svc.getChampion(c.req.valid("param").taskID)) ?? null
        }),
    ),
)
