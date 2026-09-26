import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"
import { Research } from "../../src/research"
import { TSFCandidateRecipe, TSFTaskSpec, toNeoCastRecipePayload } from "../../src/research/domains/tsf"
import { pruneCandidateSpec } from "../../src/research/llm-proposal"

const schema = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../../../../neo_cast/py/schemas/recipe_schema_v3.json"), "utf8"))

test("current action sets agree with the Python v3 schema", () => {
  const registry = Research.DomainRegistry.getInfo("tsf").actionRegistry
  for (const [kind, definition] of Object.entries({ preprocessing: "preprocessingAction", embedding: "embeddingAction", backbone: "backboneAction", fusion: "fusionAction", head: "predictionHead" })) {
    expect(Object.keys(registry[kind]).sort()).toEqual(schema.$defs[definition].oneOf.map((item: any) => item.properties.type.const).sort())
  }
})

test("legacy mechanism fields survive v3 proposal normalization and serialization", () => {
  const task = TSFTaskSpec.parse({ contextLength: 32, predictionLengths: [4], dataset: { loaderID: "fixture", targetCols: ["a", "b"] } })
  const baseline = Research.DomainRegistry.buildBaselines("tsf", task as unknown as Research.JsonRecord)[0]!.candidateSpec
  const recipe = TSFCandidateRecipe.parse(pruneCandidateSpec({
    ...baseline,
    preprocessing: { actions: [{ type: "last_value_centering" }] },
    embedding: { type: "none" },
    backbone: { type: "gated_depthwise_conv", hiddenDim: 8, depth: 2, kernelSize: 5, attention: "lightweight", dropout: 0.2 },
    fusion: { type: "graph", adjacencySource: "static", topologyArtifact: "graph.json", sparsity: 0.2 },
  }))
  const payload = toNeoCastRecipePayload(task, recipe)
  expect(payload.recipe_version).toBe("recipe_schema_v3")
  expect(payload.backbone).toMatchObject({ kernel_size: 5, attention: "lightweight", hidden_dim: 8 })
  expect(payload.fusion).toHaveProperty("topology_artifact", "graph.json")
  for (const key of ["crossAttention", "variateToken", "horizonSpecific", "shareAcrossHorizons", "baseHead", "fillPolicy"]) {
    expect(() => pruneCandidateSpec({ ...baseline, predictionHead: { type: "linear", [key]: true } })).toThrow("Removed recipe v2 field")
  }
})
