// Recover a literal PDF substring after whitespace or line-wrap dehyphenation.
// Preserve case, punctuation, numbers and words; never use fuzzy semantic matching.
export function recoverSourceQuote(text: string, quote: string): string | undefined {
  if (text.includes(quote) && quote.trim()) return quote
  const normalize = (value: string) => {
    let normalized = ""
    const offsets: number[] = []
    for (let i = 0; i < value.length; i++) {
      if (value[i] === "-" && /[\p{L}]/u.test(value[i - 1] ?? "")) {
        const wrap = value.slice(i).match(/^-\s*\n\s*(?=\p{L})/u)
        if (wrap) { i += wrap[0].length - 1; continue }
      }
      if (/\s/.test(value[i])) {
        if (!normalized.endsWith(" ")) { normalized += " "; offsets.push(i) }
      } else { normalized += value[i]; offsets.push(i) }
    }
    return { normalized, offsets }
  }
  const source = normalize(text)
  const target = normalize(quote).normalized.trim()
  if (!target) return undefined
  const start = source.normalized.indexOf(target)
  if (start < 0 || source.normalized.indexOf(target, start + 1) >= 0) return undefined
  return text.slice(source.offsets[start], source.offsets[start + target.length - 1] + 1)
}
