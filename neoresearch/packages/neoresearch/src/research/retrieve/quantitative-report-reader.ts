import { readFile } from "fs/promises"
import { DatasetQuantitativeAnalysisSchema, type DatasetQuantitativeAnalysis } from "./contract"

export function readQuantitativeReportValue(value: unknown): DatasetQuantitativeAnalysis {
  return DatasetQuantitativeAnalysisSchema.parse(value)
}

export async function readQuantitativeReport(file: string): Promise<DatasetQuantitativeAnalysis> {
  return readQuantitativeReportValue(JSON.parse(await readFile(file, "utf8")))
}

export function resolveEvidencePath(report: DatasetQuantitativeAnalysis, evidencePath: string, allowMissing = false): unknown {
  if (!evidencePath.startsWith("$.")) throw new Error(`Evidence path must start with $.: ${evidencePath}`)
  let value: unknown = report
  for (const component of evidencePath.slice(2).split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !(component in value)) {
      if (allowMissing) return undefined
      throw new Error(`Evidence path does not resolve: ${evidencePath}`)
    }
    value = (value as Record<string, unknown>)[component]
  }
  return value
}
