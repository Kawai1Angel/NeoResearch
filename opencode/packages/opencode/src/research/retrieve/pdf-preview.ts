import { createHash } from "crypto"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"

export const PDF_PREVIEW_VERSION = "pdf_preview_v1"
export type PDFPreview = { text: string; sha256: string; error?: string }

export function parsePreviewOutput(stdout: string) {
  const results = new Map<string, { text: string; error?: string }>()
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("NEO_PREVIEW\t")) continue
    try {
      const value = JSON.parse(line.slice("NEO_PREVIEW\t".length))
      if (typeof value.paperID === "string" && typeof value.text === "string") results.set(value.paperID, value)
    } catch { /* Only this record is missing; retain every other successful preview. */ }
  }
  return results
}

// Batched local extraction; no LLM, network request or full-document parsing.
export async function readPDFPreviews(neoCastRoot: string, sources: readonly { paperID: string; path: string }[]) {
  const output = new Map<string, PDFPreview>()
  const pending: Array<{ paperID: string; path: string; sha256: string; cache: string }> = []
  const root = path.join(neoCastRoot, ".neo-cast", "literature-retrieval", "preview-cache")
  await mkdir(root, { recursive: true })
  for (const source of sources) {
    try {
      const sha256 = createHash("sha256").update(await readFile(source.path)).digest("hex")
      const cache = path.join(root, `${PDF_PREVIEW_VERSION}-${sha256}.json`)
      try {
        const value = JSON.parse(await readFile(cache, "utf8")) as PDFPreview
        if (value.sha256 === sha256 && typeof value.text === "string" && !value.error) {
          output.set(source.paperID, value)
          continue
        }
      } catch { /* A missing/corrupt preview is rebuilt. */ }
      pending.push({ ...source, sha256, cache })
    } catch (error) {
      output.set(source.paperID, { text: "", sha256: "", error: String(error) })
    }
  }
  if (!pending.length) return output
  const runtime = path.join(neoCastRoot, ".neo-cast", "runtime", ".venv", "bin", "python")
  const python = process.env.NEO_CAST_PYTHON ?? (await Bun.file(runtime).exists() ? runtime : "python3")
  const script = `import json,sys
import fitz
fitz.TOOLS.mupdf_display_errors(False)
fitz.TOOLS.mupdf_display_warnings(False)
for item in json.load(sys.stdin):
 try:
  with fitz.open(item['path']) as doc:
   text='\\n'.join(doc[i].get_text() for i in range(min(2,len(doc))))[:24000]
  print('NEO_PREVIEW\\t'+json.dumps({'paperID':item['paperID'],'text':text}))
 except Exception as error:
  print('NEO_PREVIEW\\t'+json.dumps({'paperID':item['paperID'],'text':'','error':str(error)}))`
  try {
    const process = Bun.spawn([python, "-c", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    process.stdin.write(JSON.stringify(pending))
    process.stdin.end()
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
    if (code !== 0) throw new Error(`PDF preview failed: ${stderr}`)
    const results = parsePreviewOutput(stdout)
    for (const item of pending) {
      const result = results.get(item.paperID)
      const value: PDFPreview = { text: result?.text ?? "", sha256: item.sha256, ...(result?.error ? { error: result.error } : !result ? { error: "missing preview result" } : {}) }
      output.set(item.paperID, value)
      if (!value.error) await writeFile(item.cache, JSON.stringify(value))
    }
  } catch (error) {
    for (const item of pending) output.set(item.paperID, { text: "", sha256: item.sha256, error: String(error) })
  }
  return output
}
