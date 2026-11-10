import { createHash } from "node:crypto"

// Shared by execution and design contracts. Object order is irrelevant; array order is not.
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
      .join(",")}}`
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite contract number")
  return JSON.stringify(value)
}

export function digest(value: unknown) {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex")
}
