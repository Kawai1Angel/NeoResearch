import { expect, test } from "bun:test"
import { parsePreviewOutput } from "../../../src/research/retrieve/pdf-preview"

test("PDF library warnings or one corrupt record do not discard successful previews", () => {
  const result = parsePreviewOutput('MuPDF warning: invalid font\nNEO_PREVIEW\t{"paperID":"good","text":"lagged correlations"}\nNEO_PREVIEW\t{bad json}\nNEO_PREVIEW\t{"paperID":"failed","text":"","error":"invalid pdf"}\n')
  expect(result.get("good")!.text).toBe("lagged correlations")
  expect(result.get("failed")!.error).toBe("invalid pdf")
  expect(result.size).toBe(2)
})
