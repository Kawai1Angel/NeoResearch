import { expect, test } from "bun:test"
import { recoverSourceQuote } from "../../../src/research/literature/source-quote"
test("recover exact raw PDF substring after whitespace and line-wrap dehyphenation", () => {
  const raw = "A fore-\ncasting model\nuses shared  weights."
  expect(recoverSourceQuote(raw, "A forecasting model uses shared weights.")).toBe(raw)
})
test("never repair numbers, words, case or semantic punctuation", () => {
  for (const quote of ["Improves by 3%.", "degrades by 2%.", "improves by 2%.", "Improves by 2!"]) {
    expect(recoverSourceQuote("Improves by 2%.", quote)).toBeUndefined()
  }
  expect(recoverSourceQuote("cross-period", "crossperiod")).toBeUndefined()
  expect(recoverSourceQuote("abc", " ")).toBeUndefined()
})
