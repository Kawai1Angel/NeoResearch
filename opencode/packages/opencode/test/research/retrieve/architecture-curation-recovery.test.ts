import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { principleFixture } from "../literature/principle-fixtures"
import { fixtureModel } from "./architecture-model-fixture"
import { report } from "./fixtures"
import { distillArchitectureKnowledge, validateArchitectureCuration } from "../../../src/research/retrieve/architecture-distiller"
import type { PrincipleModel } from "../../../src/research/literature/principle-model"

test("curation reports the exact missing, duplicate and unknown decision IDs", () => {
  const ids = Array.from({ length: 17 }, (_, i) => `architecture_${i}`)
  expect(() => validateArchitectureCuration({ selectedDecisionIDs: ids.slice(0, 16), excluded: [] }, ids, 20))
    .toThrow('"missingDecisionIDs":["architecture_16"]')
  expect(() => validateArchitectureCuration({ selectedDecisionIDs: [...ids, ids[0]!, "invented"], excluded: [] }, ids, 20))
    .toThrow('"duplicateDecisionIDs":["architecture_0"]')
  expect(() => validateArchitectureCuration({ selectedDecisionIDs: [...ids, "invented"], excluded: [] }, ids, 20))
    .toThrow('"unknownDecisionIDs":["invented"]')
  expect(() => validateArchitectureCuration({ selectedDecisionIDs: [], excluded: ids.map(decisionID => ({ decisionID, reason: "Not useful in this task" })) }, ids, 1)).not.toThrow()
})

test("an omitted decision is repaired with exact feedback and failed cached curation is retried without repeating source review", async () => {
  await using tmp = await tmpdir()
  const cards = [principleFixture().card, principleFixture(card => { card.candidateID = "second"; card.transferableInsight = "Distinct second relationship" }).card]
  const fixture = fixtureModel()
  let broken = true
  const requests: Record<string, any>[] = []
  const model: PrincipleModel = { modelIdentifier: "curation-recovery", async request(stage, payload) {
    if (stage === "architecture_curate") {
      requests.push(structuredClone(payload))
      const value = JSON.parse((await fixture.model.request(stage, payload)).text)
      if (broken) value.excluded = []
      return { text: JSON.stringify(value) }
    }
    return fixture.model.request(stage, payload)
  } }
  const input = { corpus: { cards, historicalCardIDs: [], digest: "curation-recovery", warnings: [] }, model,
    task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") }
  await expect(distillArchitectureKnowledge(input)).rejects.toThrow("cannot become ready_data_only")
  expect(requests).toHaveLength(2)
  expect(requests[1]!.repairError).toContain('"missingDecisionIDs":["architecture_0_1"]')
  const recovery = JSON.parse(await readFile(path.join(input.auditRoot, "curation-recovery.json"), "utf8"))
  expect(recovery.reviewedDecisionIDs).toEqual(["architecture_0_0", "architecture_0_1"])
  const sourceCalls = fixture.calls.filter(stage => stage !== "architecture_curate")
  broken = false
  const recovered = await distillArchitectureKnowledge(input)
  expect(recovered.status).toBe("completed")
  expect(recovered.decisions).toHaveLength(1)
  expect(recovered.sourceCards).toHaveLength(1)
  expect(requests).toHaveLength(3)
  expect(fixture.calls.filter(stage => stage !== "architecture_curate")).toEqual(sourceCalls)
})

test("valid zero-decision curation remains distinct from an incomplete partition", async () => {
  await using tmp = await tmpdir()
  const cards = [principleFixture().card]
  const fixture = fixtureModel()
  const model: PrincipleModel = { modelIdentifier: "valid-zero-curation", async request(stage, payload) {
    if (stage === "architecture_curate") return { text: JSON.stringify({ selectedDecisionIDs: [],
      excluded: (payload.decisions as { decisionID: string }[]).map(item => ({ decisionID: item.decisionID, reason: "No useful nonredundant rule for this task" })) }) }
    return fixture.model.request(stage, payload)
  } }
  const result = await distillArchitectureKnowledge({ corpus: { cards, historicalCardIDs: [], digest: "zero", warnings: [] },
    model, task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
  expect(result.status).toBe("completed")
  expect(result.decisions).toEqual([])
})
