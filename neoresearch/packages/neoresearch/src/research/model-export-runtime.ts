import { cp, readFile, stat } from "node:fs/promises"
import path from "node:path"

/** Preserve the private Python runtime imported by the exported model builder. */
export async function copyModelExportRuntime(sourceDirectory: string, targetDirectory: string) {
  const implementation = await readFile(path.join(sourceDirectory, "model_impl.py"), "utf8")
  const packages = new Set(Array.from(
    implementation.matchAll(/\b(?:from|import)\s+(_neocast_runtime_[A-Za-z0-9_]+)(?=[.\s])/g),
    (match) => match[1]!,
  ))
  const copied: Record<string, string> = {}
  for (const name of packages) {
    const source = path.join(sourceDirectory, name)
    if (!(await stat(source).catch(() => undefined))?.isDirectory())
      throw new Error(`Model export is missing its required Python runtime: ${name}`)
    await cp(source, path.join(targetDirectory, name), { recursive: true, force: true })
    copied[`runtime/${name}`] = `model/${name}`
  }
  return copied
}
