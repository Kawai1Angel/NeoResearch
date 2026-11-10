/**
 * Live multi-round integration test for the ModelDesigner LLM call.
 *
 * Runs only when a real API key + endpoint is resolvable; skips in CI without keys.
 * Each round calls proposeLLMCandidate with a realistic context, then validates
 * the returned candidateSpec against the TSF domain schema — the same path that
 * produced "invalid: expected number / unrecognized key" errors in production.
 *
 * Run manually:
 *   cd neoresearch/packages/neoresearch
 *   bun test test/research/llm-proposal-live.test.ts --timeout 120000
 */

import { expect, test } from "bun:test"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import {
  apiKeyFor,
  proposeLLMCandidate,
  resolveNeoCastLLMConfig,
} from "../../src/research/llm-proposal"
import { DomainRegistry } from "../../src/research/domain-registry"
import type { DomainProposalContext } from "../../src/research/domain"
import type { ResearchTask } from "../../src/research/schema"

const ROUNDS = 5

// bridgeOnly: false so we test schema coverage across all backbone types
// without mixing in bridge-mode domain constraints (separate concern).
function makeTask(): ResearchTask {
  return {
    id: "rtsk_live_test",
    projectID: "proj_live_test",
    title: "ETTh1 live LLM test",
    domainID: "tsf",
    mode: "autonomous",
    status: "searching",
    taskSpec: {
      taskType: "forecasting",
      forecastMode: "point",
      seriesType: "multivariate",
      contextLength: 512,
      predictionLengths: [96, 192, 336, 720],
      dataset: { loaderID: "etth1" },
      runtime: { bridgeOnly: false },
    },
    objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
    budget: { maxRuns: 20 },
    time: { created: Date.now(), updated: Date.now() },
  } as unknown as ResearchTask
}

const baseProposalContext: DomainProposalContext = {
  taskSpec: { runtime: { bridgeOnly: false } },
  taskFingerprint: {
    searchBiases: ["seasonal", "bridge_safe"],
    datasetProfile: {
      source: "etth1",
      rowCount: 17420,
      targetCount: 7,
      numericColumnCount: 7,
      missingRate: 0,
      trendStrength: 0.31,
      seasonalityStrength: 0.55,
      crossVarCorrelation: 0.42,
      distributionShift: 0.18,
      acfMainPeriod: 24,
    },
  },
  candidates: [],
  runs: [],
  memory: [],
}

// Schema errors are Zod-level type/field errors (missing numbers, unrecognized keys, wrong types).
// Domain errors are higher-level checks (bridge mode, phase constraints) — separate concern.
function classifyIssues(messages: string[]): { schemaErrors: string[]; domainErrors: string[] } {
  const schemaErrors: string[] = []
  const domainErrors: string[] = []
  for (const msg of messages) {
    // format is "path: message" — match on the message part
    const msgPart = msg.includes(": ") ? msg.slice(msg.indexOf(": ") + 2) : msg
    if (
      msgPart.startsWith("Invalid input") ||
      msgPart.startsWith("Unrecognized key") ||
      msgPart.startsWith("Invalid option") ||
      msgPart.startsWith("Too small") ||
      msgPart.startsWith("Too big")
    ) {
      schemaErrors.push(msg)
    } else {
      domainErrors.push(msg)
    }
  }
  return { schemaErrors, domainErrors }
}

test(
  `ModelDesigner LLM: ${ROUNDS} live rounds — no schema validation errors`,
  async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "neo-llm-live-"))
    const config = await resolveNeoCastLLMConfig({ workspaceRoot })
    const apiKey = apiKeyFor(config)

    if (!apiKey) {
      console.log(
        `[SKIP] No API key found (NEO_CAST_LLM_API_KEY / OPENAI_API_KEY / AIGCBEST_API_KEY). Set one to run live rounds.`,
      )
      return
    }

    console.log(`\nLive LLM config: provider=${config.provider} model=${config.model}`)

    type RoundResult = {
      round: number
      llmStatus: string
      schemaErrors: string[]
      domainErrors: string[]
      recipeID?: string
      backboneType?: string
    }
    const results: RoundResult[] = []

    for (let round = 1; round <= ROUNDS; round++) {
      const result = await proposeLLMCandidate({
        task: makeTask(),
        proposalContext: baseProposalContext,
        workspaceRoot,
      })

      const llmStatus =
        typeof result.metadata.llmStatus === "string" ? result.metadata.llmStatus : "unknown"

      let schemaErrors: string[] = []
      let domainErrors: string[] = []
      let recipeID: string | undefined
      let backboneType: string | undefined

      if (result.proposal) {
        const spec = result.proposal.candidateSpec
        recipeID = typeof spec.recipeID === "string" ? spec.recipeID : undefined
        const backbone =
          spec.backbone && typeof spec.backbone === "object"
            ? (spec.backbone as Record<string, unknown>)
            : {}
        backboneType = typeof backbone.type === "string" ? backbone.type : undefined

        const validation = DomainRegistry.validateCandidate("tsf", {
          taskSpec: makeTask().taskSpec,
          candidateSpec: spec,
        })
        if (!validation.ok) {
          const classified = classifyIssues(validation.issues.map((i) => `${i.path}: ${i.message}`))
          schemaErrors = classified.schemaErrors
          domainErrors = classified.domainErrors
        }
      } else {
        const llmError = typeof result.metadata.llmError === "string" ? result.metadata.llmError : ""
        schemaErrors = [llmError || `llmStatus=${llmStatus}`]
      }

      results.push({ round, llmStatus, schemaErrors, domainErrors, recipeID, backboneType })

      const statusLine = [
        `round ${round}/${ROUNDS}`,
        `llmStatus=${llmStatus}`,
        backboneType ? `backbone=${backboneType}` : "",
        recipeID ? `recipeID=${recipeID}` : "",
        schemaErrors.length > 0
          ? `✗ SCHEMA: ${schemaErrors.join("; ")}`
          : domainErrors.length > 0
            ? `⚠ domain: ${domainErrors.join("; ")}`
            : "✓ valid",
      ]
        .filter(Boolean)
        .join("  ")
      console.log(statusLine)
    }

    const schemaFailures = results.filter((r) => r.schemaErrors.length > 0)
    const domainFailures = results.filter((r) => r.domainErrors.length > 0)
    const llmFailures = results.filter((r) => r.llmStatus === "failed")
    console.log(
      `\nSummary: ${ROUNDS} rounds — ${results.filter((r) => r.schemaErrors.length === 0 && r.domainErrors.length === 0).length} clean, ` +
        `${schemaFailures.length} schema errors, ${domainFailures.length} domain constraint errors, ${llmFailures.length} LLM failures`,
    )

    if (domainFailures.length > 0) {
      console.warn(
        `Domain constraint errors (not asserted — separate concern):\n` +
          domainFailures.map((r) => `  round ${r.round}: ${r.domainErrors.join("; ")}`).join("\n"),
      )
    }

    expect(
      schemaFailures,
      `Schema (Zod) validation failures:\n` +
        schemaFailures.map((r) => `  round ${r.round}: ${r.schemaErrors.join("; ")}`).join("\n"),
    ).toHaveLength(0)
  },
  { timeout: 120_000 },
)

test(
  `ModelDesigner LLM: varied backbone types across ${ROUNDS} rounds`,
  async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "neo-llm-live-varied-"))
    const config = await resolveNeoCastLLMConfig({ workspaceRoot })
    const apiKey = apiKeyFor(config)

    if (!apiKey) {
      console.log("[SKIP] No API key found.")
      return
    }

    const searchBiasVariants = [
      ["seasonal", "prefer_backbone:timesnet_lite"],
      ["trend", "prefer_backbone:transformer"],
      ["cross_var_correlated", "prefer_backbone:mlp"],
      ["distribution_shift", "prefer_backbone:dlinear"],
      ["probabilistic", "prefer_backbone:linear"],
    ]

    const backbonesSeen = new Set<string>()
    const schemaFailures: string[] = []

    for (let round = 0; round < ROUNDS; round++) {
      const searchBiases = searchBiasVariants[round % searchBiasVariants.length]!
      const context: DomainProposalContext = {
        ...baseProposalContext,
        taskFingerprint: {
          ...baseProposalContext.taskFingerprint,
          searchBiases,
        },
      }

      const result = await proposeLLMCandidate({
        task: makeTask(),
        proposalContext: context,
        workspaceRoot,
      })

      if (!result.proposal) {
        console.log(`round ${round + 1}: no proposal (llmStatus=${result.metadata.llmStatus})`)
        continue
      }

      const spec = result.proposal.candidateSpec
      const backbone =
        spec.backbone && typeof spec.backbone === "object"
          ? (spec.backbone as Record<string, unknown>)
          : {}
      const backboneType = typeof backbone.type === "string" ? backbone.type : "unknown"
      backbonesSeen.add(backboneType)

      const validation = DomainRegistry.validateCandidate("tsf", {
        taskSpec: makeTask().taskSpec,
        candidateSpec: spec,
      })

      if (!validation.ok) {
        const { schemaErrors, domainErrors } = classifyIssues(
          validation.issues.map((i) => `${i.path}: ${i.message}`),
        )
        if (schemaErrors.length > 0) {
          const msg = `round ${round + 1} backbone=${backboneType}: ${schemaErrors.join("; ")}`
          schemaFailures.push(msg)
          console.error(`✗ SCHEMA ${msg}`)
        }
        if (domainErrors.length > 0) {
          console.warn(
            `⚠ domain round ${round + 1} backbone=${backboneType}: ${domainErrors.join("; ")}`,
          )
        }
      } else {
        console.log(`round ${round + 1}: backbone=${backboneType} biases=${searchBiases.join(",")} ✓`)
      }
    }

    console.log(`\nBackbones seen: ${[...backbonesSeen].join(", ")}`)
    expect(schemaFailures, schemaFailures.join("\n")).toHaveLength(0)
  },
  { timeout: 120_000 },
)
