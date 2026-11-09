import { isDeepStrictEqual } from "node:util"
import { ArchitectureReflectionAnalysis } from "./agents/scoped-reflection"

/** Recover only the observed complete response with one premature root close.
 * No fields, values, missing delimiters or truncated responses are synthesized.
 */
export function repairArchitectureReflectionJSON(text: string) {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) throw new SyntaxError("No complete architecture reflection object")
  const payload = text.slice(start, end + 1)
  let depth = 0
  let quoted = false
  let escaped = false
  let close = -1
  for (let index = 0; index < payload.length; index++) {
    const char = payload[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === "{") depth++
    else if (char === "}" && --depth === 0) { close = index; break }
  }
  if (close < 0 || !/^\s*,\s*"trainingConfounders"\s*:/.test(payload.slice(close + 1)))
    throw new SyntaxError("Architecture reflection requires a complete unambiguous JSON object")
  const prefix = JSON.parse(payload.slice(0, close + 1))
  if (Object.keys(prefix).sort().join(",") !== "designAssessment,hypothesisAssessment")
    throw new SyntaxError("Unrecognized architecture reflection JSON boundary")
  const analysis = ArchitectureReflectionAnalysis.parse(JSON.parse(payload.slice(0, close) + payload.slice(close + 1)))
  if (analysis.designAssessment !== prefix.designAssessment || !isDeepStrictEqual(analysis.hypothesisAssessment, prefix.hypothesisAssessment))
    throw new SyntaxError("Ambiguous architecture reflection fields")
  return {
    analysis,
    repair: { kind: "surplus_root_closing_brace" as const, removedOffset: start + close },
  }
}
