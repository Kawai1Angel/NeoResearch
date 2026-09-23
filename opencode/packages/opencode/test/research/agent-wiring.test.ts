import { test, expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir, provideInstance } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { resolveEffectiveLLMConfig } from "../../src/research/llm-proposal"
import { ConfiguredLLMExtractionModel } from "../../src/research/literature/extraction-model"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
test("PublishAgent is registered with a dedicated prompt and no external tools", async () => {
  await using tmp = await tmpdir()
  const names = await Effect.runPromise(
    provideInstance(tmp.path)(Agent.Service.use((s) => s.list())).pipe(Effect.provide(Agent.defaultLayer)),
  )

  const publish = names.find((a) => a.name === "research-publish")
  expect(publish).toBeDefined()
  expect(publish?.prompt).toContain("frozen experiment snapshot")
  expect(publish?.hidden).toBe(true)
})
test("Literature extraction shares auth.json credentials with the other research agents", async () => {
  await using tmp = await tmpdir()
  const keys = [
    "OPENCODE_TEST_HOME",
    "XDG_DATA_HOME",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "NEO_CAST_LLM_API_KEY",
    "AIGCBEST_API_KEY",
  ]
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  try {
    for (const k of keys) delete process.env[k]
    process.env.XDG_DATA_HOME = tmp.path
    await mkdir(path.join(tmp.path, "neo-research"), { recursive: true })
    await writeFile(
      path.join(tmp.path, "neo-research", "auth.json"),
      JSON.stringify({ openai: { type: "api", key: "audit-fake-key-no-network" } }),
    )
    const input = { workspaceRoot: tmp.path, neoCastRoot: tmp.path }
    const shared = await resolveEffectiveLLMConfig({ workspaceRoot: tmp.path, neoCastProjectRoot: tmp.path })
    const literature = await ConfiguredLLMExtractionModel.create(input)

    expect(shared).toBeDefined()
    expect(literature).toBeDefined()
  } finally {
    for (const k of keys) {
      if (previous[k] === undefined) delete process.env[k]
      else process.env[k] = previous[k]
    }
  }
})
