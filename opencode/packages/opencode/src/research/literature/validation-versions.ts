// Extraction and task-evidence handoff must agree on the verifier that produced a card.
export const CURRENT_EVIDENCE_VERIFIER_VERSION = "evidence_verifier_v6"
const TASK_EVIDENCE_VERIFIER_VERSIONS: ReadonlySet<string> = new Set([
  "evidence_verifier_v3",
  "evidence_verifier_v4",
  "evidence_verifier_v5",
  CURRENT_EVIDENCE_VERIFIER_VERSION,
])

export function isTaskEvidenceVerifierVersion(version: string | undefined) {
  return version !== undefined && TASK_EVIDENCE_VERIFIER_VERSIONS.has(version)
}
