#!/usr/bin/env bun
import path from "path"
import { LiteratureAgent } from "./literature-agent"
import type { LiteratureAgentInput } from "./contract"
import { ConfiguredPrincipleModel } from "./principle-model"

function parseArgs(argv: string[]) {
  const command = argv[0]
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith("--")) { positional.push(token); continue }
    const next = argv[index + 1]
    if (next && !next.startsWith("--")) { flags.set(token.slice(2), next); index += 1 }
    else flags.set(token.slice(2), true)
  }
  return { command, positional, flags }
}

function flag(flags: Map<string, string | true>, name: string) {
  const value = flags.get(name)
  return typeof value === "string" ? value : undefined
}

function sourceFromFlags(flags: Map<string, string | true>): LiteratureAgentInput["sources"][number] {
  const paperID = flag(flags, "paper-id")
  const pdf = flag(flags, "pdf")
  if (paperID && pdf) throw new Error("Use either --paper-id or --pdf, not both")
  if (paperID) return { kind: "catalog_paper", paperID }
  if (!pdf) throw new Error("--paper-id or --pdf is required")
  const title = flag(flags, "title")
  if (!title) throw new Error("--title is required with --pdf")
  const yearText = flag(flags, "year")
  const year = yearText === undefined ? undefined : Number(yearText)
  if (year !== undefined && (!Number.isInteger(year) || year < 1900)) throw new Error("--year must be an integer >= 1900")
  const publicationStatus = flag(flags, "publication-status") ?? "unknown"
  if (!["peer_reviewed", "preprint", "unknown"].includes(publicationStatus)) throw new Error("Invalid --publication-status")
  return {
    kind: "local_pdf", path: path.resolve(pdf),
    metadata: {
      title,
      ...(year !== undefined ? { year } : {}),
      ...(flag(flags, "venue") ? { venue: flag(flags, "venue") } : {}),
      ...(flag(flags, "doi") ? { doi: flag(flags, "doi") } : {}),
      publicationStatus: publicationStatus as "peer_reviewed" | "preprint" | "unknown",
    },
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.command) throw new Error("Expected build, build-principles, parse, validate, export, or show-run")
  const neoCastRoot = path.resolve(flag(args.flags, "neo-cast-root") ?? path.join(import.meta.dir, "../../../../../../neo_cast"))
  const knowledgeRoot = flag(args.flags, "output-root") ? path.resolve(flag(args.flags, "output-root")!) : undefined
  const configured = args.command === "build" && !args.flags.has("no-llm")
    ? await ConfiguredPrincipleModel.create({ workspaceRoot: process.cwd(), neoCastRoot })
    : undefined
  const agent = new LiteratureAgent({
    neoCastRoot, workspaceRoot: process.cwd(), knowledgeRoot,
    principleModel: configured,
    ...(flag(args.flags, "python") ? { pythonExecutable: flag(args.flags, "python") } : {}),
  })
  try {
    if (args.command === "build-principles") {
      if (args.flags.has("no-llm")) throw new Error("build-principles requires a configured model; use parse for parse-only runs")
      const model = await ConfiguredPrincipleModel.create({ workspaceRoot: process.cwd(), neoCastRoot })
      if (!model) throw new Error("No configured principle extraction model")
      const result = await agent.runPrinciples({ source: sourceFromFlags(args.flags), model, publish: true,
        options: {
          ...(flag(args.flags, "max-calls") ? { maxCalls: Number(flag(args.flags, "max-calls")) } : {}),
          ...(flag(args.flags, "max-context-characters") ? { maxContextCharacters: Number(flag(args.flags, "max-context-characters")) } : {}),
        } })
      console.log(JSON.stringify({ runID: result.runID, runPath: result.runPath, status: result.status,
        acceptedCount: result.cards.length, rejectedCount: result.rejected.length, errors: result.errors, publication: "active_v2" }))
      return result.status === "completed" ? 0 : 1
    }
    if (args.command === "build") {
      const result = await agent.run({
        sources: [sourceFromFlags(args.flags)],
        options: {
          force: args.flags.has("force"),
          ...(flag(args.flags, "max-cards") ? { maxCardsPerPaper: Number(flag(args.flags, "max-cards")) } : {}),
          includeAgentInference: !args.flags.has("no-agent-inference"),
          requireExactEvidenceSpan: !args.flags.has("allow-normalized-evidence"),
        },
      })
      console.log(JSON.stringify(result))
      return result.summary.failedCount ? 1 : 0
    }
    if (args.command === "parse") {
      console.log(JSON.stringify(await agent.parseOnly(sourceFromFlags(args.flags))))
      return 0
    }
    if (args.command === "validate") {
      console.log(JSON.stringify(agent.validate()))
      return 0
    }
    if (args.command === "export") {
      console.log(JSON.stringify(await agent.export(flag(args.flags, "status"))))
      return 0
    }
    if (args.command === "show-run") {
      const runID = args.positional[0]
      if (!runID) throw new Error("show-run requires a run ID")
      console.log(JSON.stringify(await agent.showRun(runID)))
      return 0
    }
    throw new Error(`Unknown command: ${args.command}`)
  } finally {
    agent.close()
  }
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  console.log(JSON.stringify({ status: "failed", error: { code: "literature_cli_error", message: String(error) } }))
  process.exitCode = 1
})
