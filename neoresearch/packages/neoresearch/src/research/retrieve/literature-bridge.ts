import {
  RetrieveLiteratureBridgeInputSchema,
  RetrieveLiteratureBridgeResultSchema,
  type RetrieveLiteratureBridgeInput,
  type RetrieveLiteratureBridgeResult,
} from "./contract"
import type { LiteratureAgentInput, LiteratureAgentResult } from "../literature/contract"

export type LiteratureAgentBridgeTarget = {
  run(input: LiteratureAgentInput): Promise<LiteratureAgentResult>
}

export async function runLiteratureBridge(
  target: LiteratureAgentBridgeTarget,
  rawInput: RetrieveLiteratureBridgeInput,
): Promise<RetrieveLiteratureBridgeResult> {
  const input = RetrieveLiteratureBridgeInputSchema.parse(rawInput)
  if (input.candidates.length === 0) return { retrieveRunID: input.retrieveRunID, papers: [] }
  // Per-paper failures are returned in processed[]. An exception from the bridge
  // itself (including a corrupt contract/store) is a hard failure, not a gap.
  const result = await target.run({
    sources: input.candidates.map((candidate) => ({ kind: "catalog_paper" as const, paperID: candidate.paperID })),
    options: input.literatureOptions,
  })
  let successfulRunIndex = 0
  const byPaper = new Map(result.processed.map((paper) => [paper.paperID, paper]))
  if (byPaper.size !== result.processed.length) throw new Error("LiteratureAgent returned duplicate paper results")
  const runByPaper = new Map(result.processed.map((paper) => [paper.paperID,
    paper.status === "failed" ? undefined : result.runIDs[successfulRunIndex++],
  ]))
  const papers = input.candidates.map((candidate) => {
    const processed = byPaper.get(candidate.paperID)
    if (!processed) {
      return {
        paperID: candidate.paperID,
        intentIDs: candidate.intentIDs,
        candidateIDs: candidate.candidateIDs,
        status: "failed" as const,
        acceptedCardIDs: [],
        rejectedCandidateCount: 0,
        warningCount: 0,
        error: "LiteratureAgent did not return a result for the paper",
      }
    }
    const literatureRunID = runByPaper.get(candidate.paperID)
    return {
      paperID: candidate.paperID,
      intentIDs: candidate.intentIDs,
      candidateIDs: candidate.candidateIDs,
      status: processed.status,
      ...(literatureRunID === undefined ? {} : { literatureRunID }),
      acceptedCardIDs: processed.acceptedCardIDs,
      rejectedCandidateCount: processed.rejectedCandidateCount,
      warningCount: processed.warningCount,
      ...(processed.reviewPath ? { reviewPath: processed.reviewPath } : {}),
      ...(processed.status === "failed" ? { error: processed.error ?? "LiteratureAgent failed to process the paper" } : {}),
    }
  })
  return RetrieveLiteratureBridgeResultSchema.parse({ retrieveRunID: input.retrieveRunID, papers })
}
