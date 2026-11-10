import type { MessageV2 } from "../session/message-v2"
import { LiteratureReceiptSchema, type LiteraturePhase } from "./literature-phase-executor"

/** No natural-language completion is needed. Invalid receipts always fail closed. */
export async function recoverLiteratureReceipt(phase: Pick<LiteraturePhase, "validate" | "started" | "reconcile">, parts: readonly MessageV2.Part[]) {
  const completed = parts.filter((part) => part.type === "tool" && part.tool === "literature_run" && part.state.status === "completed")
  for (const part of completed) {
    if (part.type !== "tool" || part.state.status !== "completed") continue
    await phase.validate(LiteratureReceiptSchema.parse(JSON.parse(part.state.output)))
  }
  if (!completed.length && !phase.started) return undefined
  const pending = phase.reconcile()
  if (!pending) throw new Error("Literature receipt has no bound execution")
  const receipt = await pending
  await phase.validate(receipt)
  return receipt
}
