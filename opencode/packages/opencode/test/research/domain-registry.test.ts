import { describe, expect, test } from "bun:test"
import { Research } from "../../src/research"

describe("research domain registry", () => {
  test("exposes TSF domain capability metadata from getInfo and list", () => {
    const info = Research.DomainRegistry.getInfo("tsf")

    expect(info.capability).toEqual({
      taskSpecKind: "neo-research.tsf.task_spec.v1",
      candidateSpecKind: "neo-cast.recipe_schema_v2",
      evaluatorKind: "domain-run-evaluator",
      artifactExporterKind: "domain-artifact-exporter",
      supportsAutonomous: true,
      supportsPrivilegedEvaluation: true,
    })

    expect(Research.DomainRegistry.list().find((domain) => domain.id === "tsf")?.capability).toEqual(info.capability)
  })
})
