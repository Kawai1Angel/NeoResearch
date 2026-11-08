import { existsSync } from "node:fs"
import path from "node:path"

/** Use the native venv layout, retaining existing POSIX runner layouts on Windows. */
export function neoCastRuntimePython(root: string) {
  const venv = path.join(root, ".neo-cast", "runtime", ".venv")
  const posix = path.join(venv, "bin", "python")
  if (process.platform !== "win32") return posix
  const windows = path.join(venv, "Scripts", "python.exe")
  return existsSync(windows) || !existsSync(posix) ? windows : posix
}
