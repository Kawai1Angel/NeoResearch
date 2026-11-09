import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { spawnSync } from "child_process"
import path from "path"
import { TSFCandidateRecipe, TSFTaskSpec, toNeoCastRecipePayload } from "../../src/research/domains/tsf"
import { camelizeKnown, pruneCandidateSpec } from "../../src/research/llm-proposal"

const root = path.resolve(import.meta.dir, "../../../../../neo_cast")
const venv = path.join(root, ".neo-cast/runtime/.venv/bin/python")
const python = process.env.NEO_CAST_PYTHON ?? (existsSync(venv) ? venv : "python3")

test("Mamba auto/strict/reference execution and CUDA state limits agree across frontends", () => {
  const task = TSFTaskSpec.parse({ contextLength: 32, predictionLengths: [4], dataset: { loaderID: "fixture", targetCols: ["a"] } })
  const source = JSON.parse(readFileSync(path.join(root, "py/schemas/recipe_mamba_auto.example.json"), "utf8"))
  delete source.constraints
  delete source.post_processing
  const spec = camelizeKnown(source) as any
  const cases = [
    { backend: "auto", dState: 16, ok: true },
    { backend: "torch_reference", dState: 512, ok: true },
    { backend: "auto", dState: 512, ok: true },
    { backend: "cuda_optimized", dState: 256, ok: true },
    { backend: "cuda_optimized", dState: 512, ok: false },
    { backend: "unknown", dState: 16, ok: false },
  ]
  const payloads = cases.map(item => {
    const candidate = { ...spec, backbone: { ...spec.backbone, backend: item.backend, dState: item.dState } }
    expect(TSFCandidateRecipe.safeParse(candidate).success).toBe(item.ok)
    return toNeoCastRecipePayload(task, candidate as any)
  })
  const result = spawnSync(python, ["-c", "import json,sys;from validate import validate_recipe_object;print(json.dumps([not validate_recipe_object(r,input_len=32) for r in json.load(sys.stdin)]))"], {
    input: JSON.stringify(payloads), encoding: "utf8", env: { ...process.env, PYTHONPATH: path.join(root, "py") }, timeout: 60000,
  })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(cases.map(item => item.ok))
  const secondary = { embedding: spec.embedding, representation: spec.representation,
    backbone: { ...spec.backbone, backend: "cuda_optimized", dState: 512 } }
  expect(TSFCandidateRecipe.safeParse({ ...spec, fusion: { type: "temporal", channelMode: "independent" },
    composition: { type: "parallel_two_branch", merge: "sum", secondary } }).success).toBe(false)
})

test("three typed encoders serialize to Python-valid v3 recipes and canonical identities", () => {
  const task = TSFTaskSpec.parse({ contextLength: 32, predictionLengths: [4], dataset: { loaderID: "fixture", targetCols: ["a", "b"] } })
  const payloads = (["diagonal_ssm", "timesblock_encoder", "mamba"] as const).map((name) => {
    const source = JSON.parse(readFileSync(path.join(root, `py/schemas/recipe_${name}.example.json`), "utf8"))
    delete source.constraints
    delete source.post_processing
    const candidate = TSFCandidateRecipe.parse(pruneCandidateSpec(camelizeKnown(source)))
    expect(candidate.recipeVersion).toBe("recipe_schema_v3")
    const payload = toNeoCastRecipePayload(task, candidate)
    expect(payload.representation).toEqual({ layout: "sequence_latent", readout: "mean", latent_dim: 16 })
    expect(payload.backbone.type).toBe(name)
    return payload
  })
  const result = spawnSync(python, ["-c", "import json,sys; from validate import validate_recipe_object; from recipe_identity import recipe_identity; rows=json.load(sys.stdin); print(json.dumps([{'errors':validate_recipe_object(r,input_len=32),'identity':recipe_identity(r,input_spec={'input_len':32,'channels':2,'horizon':4})['architecture_id']} for r in rows]))"], {
    input: JSON.stringify(payloads), encoding: "utf8", env: { ...process.env, PYTHONPATH: path.join(root, "py") }, timeout: 60000,
  })
  expect(result.status, result.stderr).toBe(0)
  const rows = JSON.parse(result.stdout)
  expect(rows.every((row: any) => row.errors.length === 0)).toBe(true)
  expect(new Set(rows.map((row: any) => row.identity)).size).toBe(3)
}, 70000)

test("v3 rejects stale fields and cannot downgrade typed encoders into v2", () => {
  const source = JSON.parse(readFileSync(path.join(root, "py/schemas/recipe_mamba.example.json"), "utf8"))
  delete source.constraints
  delete source.post_processing
  const spec = camelizeKnown(source) as any
  expect(() => pruneCandidateSpec({ ...spec, backbone: { ...spec.backbone, stateDim: 8 } })).toThrow()
  expect(TSFCandidateRecipe.safeParse({ ...spec, recipeVersion: "recipe_schema_v2" }).success).toBe(false)
  expect(TSFCandidateRecipe.safeParse({ ...spec, representation: { ...spec.representation, readout: "none" } }).success).toBe(false)
})


test("a valid v3 candidate rejects the removed direct head", () => {
  const source = JSON.parse(readFileSync(path.join(root, "py/schemas/recipe_mamba.example.json"), "utf8"))
  delete source.constraints
  delete source.post_processing
  const spec = camelizeKnown(source) as any
  expect(TSFCandidateRecipe.safeParse(spec).success).toBe(true)
  spec.predictionHead = { type: "direct_multi_horizon", outputDistribution: "point" }
  const result = TSFCandidateRecipe.safeParse(spec)
  expect(result.success).toBe(false)
  if (!result.success) expect(result.error.issues.some((issue) => issue.path[0] === "predictionHead")).toBe(true)
  expect(() => pruneCandidateSpec(spec)).toThrow()
})

test("Patch TCN and state-space examples cross the NeoResearch/Python boundary with their exact axis contracts", () => {
  const task = TSFTaskSpec.parse({ contextLength: 32, predictionLengths: [4], dataset: { loaderID: "fixture", targetCols: ["a", "b"] }, runtime: { bridgeOnly: false } })
  const rows = ["patch_tcn", "multiscale_tcn", "patch_mamba", "patch_diagonal_ssm"].map(name => {
    const source = JSON.parse(readFileSync(path.join(root, `py/schemas/recipe_${name}.example.json`), "utf8"))
    delete source.constraints; delete source.post_processing
    const candidate = TSFCandidateRecipe.parse(pruneCandidateSpec(camelizeKnown(source)))
    const payload = toNeoCastRecipePayload(task, candidate)
    expect(payload.embedding.type).toBe(source.embedding.type)
    if (name.includes("mamba") || name.includes("ssm")) expect(payload.representation).toMatchObject({ layout: "channel_sequence", readout: "flatten" })
    return payload
  })
  const result = spawnSync(python, ["-c", "import json,sys;from validate import validate_recipe_object;print(json.dumps([validate_recipe_object(r,input_len=32) for r in json.load(sys.stdin)]))"], {
    input: JSON.stringify(rows), encoding: "utf8", env: { ...process.env, PYTHONPATH: path.join(root, "py") }, timeout: 60000,
  })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual([[], [], [], []])
}, 70000)

test("Patch sequence validation rejects incompatible axes, fusion, widths and history-gate token grids", () => {
  const source = JSON.parse(readFileSync(path.join(root, "py/schemas/recipe_patch_mamba.example.json"), "utf8"))
  delete source.constraints; delete source.post_processing
  const spec = camelizeKnown(source) as any
  for (const patch of [
    { embedding: { type: "multiscale_patch", scales: [{ patchLen: 8, stride: 4 }], dModel: 16 } },
    { embedding: { ...spec.embedding, dModel: 8 } },
    { representation: { ...spec.representation, layout: "sequence_latent" } },
    { representation: { ...spec.representation, readout: "mean" } },
    { fusion: { type: "feature_mlp" } },
  ]) expect(TSFCandidateRecipe.safeParse({ ...spec, ...patch }).success).toBe(false)
  const secondary = { backbone: spec.backbone, embedding: spec.embedding, representation: spec.representation }
  const valid = { ...spec, composition: { type: "parallel_two_branch", merge: "history_time_gate", secondary } }
  expect(TSFCandidateRecipe.safeParse(valid).success).toBe(true)
  expect(TSFCandidateRecipe.safeParse({ ...valid, composition: { ...valid.composition, secondary: { ...secondary,
    embedding: { ...secondary.embedding, patchLen: 9 } } } }).success).toBe(false)
  const raw = { ...spec, embedding: { type: "none" } }
  expect(TSFCandidateRecipe.safeParse(raw).success).toBe(false)
})
