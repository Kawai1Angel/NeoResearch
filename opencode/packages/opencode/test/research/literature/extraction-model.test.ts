import { expect, test } from "bun:test"
import { requestEvidenceVerification } from "../../../src/research/literature/extraction-model"
import type { EvidenceVerification } from "../../../src/research/literature/contract"
import { candidate, chunk } from "./fixtures"

const supported: EvidenceVerification = { cardTypeVerdict: "correct", mechanismVerdict: "not_applicable", contributionVerdict: "not_applicable", verdict: "supported", supportedScope: "ETTh1", unsupportedParts: [], evidenceDirectness: "direct", confidence: 0.9 }
const input = { candidate: candidate(), chunks: [chunk()] }

test("nullable unused correction is omitted without changing the verifier verdict", async () => {
  const result = await requestEvidenceVerification(input, async () => JSON.stringify({ ...supported, correctedClaim: null }))
  expect(result).toEqual(supported)
})

test("invalid enum gets one repair request with validation feedback, not an inferred directness", async () => {
  const calls: Record<string, unknown>[] = []
  const result = await requestEvidenceVerification(input, async (payload) => {
    calls.push(payload)
    return JSON.stringify(calls.length === 1 ? { ...supported, evidenceDirectness: 0.9 } : { ...supported, verdict: "unsupported", unsupportedParts: ["No supporting experiment"], evidenceDirectness: "indirect" })
  })
  expect(calls).toHaveLength(2)
  expect(JSON.stringify(calls[1]!.repair)).toContain("evidenceDirectness")
  expect(result.verdict).toBe("unsupported")
  expect(result.evidenceDirectness).toBe("indirect")
})

test("persistent schema failures stop after two calls and remain errors", async () => {
  let count = 0
  await expect(requestEvidenceVerification(input, async () => {
    count++
    return JSON.stringify({ ...supported, evidenceDirectness: "high" })
  })).rejects.toThrow()
  expect(count).toBe(2)
})

test("a v3 verifier cannot silently omit typed quality checks", async () => {
  let calls = 0
  await expect(requestEvidenceVerification(input, async () => {
    calls++
    const { cardTypeVerdict, mechanismVerdict, contributionVerdict, ...legacy } = supported
    return JSON.stringify(legacy)
  })).rejects.toThrow("v3 verifier")
  expect(calls).toBe(2)
})


test("scalar enum contracts do not teach the model to echo arrays", async () => {
  await requestEvidenceVerification(input, async (payload) => {
    const contract = payload.outputContract as Record<string, unknown>
    expect(typeof contract.verdict).toBe("string")
    expect(typeof contract.evidenceDirectness).toBe("string")
    expect(contract.evidenceDirectness).toContain("never an array")
    return JSON.stringify(supported)
  })
})
