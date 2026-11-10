import z from "zod"
import { ExperienceDraftSchema } from "./experience"
import { digest } from "./digest"

/** After the bounded correction attempt, reject invalid optional proposals without changing the diagnosis. */
export function rejectInvalidReflectionDrafts<T>(schema: z.ZodType<T>, value: unknown) {
  const original = schema.safeParse(value)
  if (original.success) return { analysis: original.data, rejectedDrafts: [] }
  if (!original.error.issues.every((issue) => issue.path[0] === "experienceDrafts")) throw original.error
  if (!value || typeof value !== "object" || Array.isArray(value)) throw original.error
  const input = value as Record<string, unknown>
  if (!Array.isArray(input.experienceDrafts)) throw original.error
  // Revalidate the entire core, including scope boundaries, before considering any proposal separately.
  schema.parse({ ...input, experienceDrafts: [] })
  const accepted: z.infer<typeof ExperienceDraftSchema>[] = []
  const rejectedDrafts: Array<{
    index: number
    draftDigest: string
    issues: Array<{ path: Array<string | number>; message: string }>
  }> = []
  for (const [index, draft] of input.experienceDrafts.entries()) {
    const parsed = ExperienceDraftSchema.safeParse(draft)
    if (parsed.success) {
      accepted.push(parsed.data)
      continue
    }
    rejectedDrafts.push({
      index,
      draftDigest: digest(draft),
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map((part) => typeof part === "number" ? part : String(part)),
        message: issue.message,
      })),
    })
  }
  // Do not conceal array-level violations such as an excess of otherwise valid proposals.
  if (!rejectedDrafts.length) throw original.error
  return { analysis: schema.parse({ ...input, experienceDrafts: accepted }), rejectedDrafts }
}
