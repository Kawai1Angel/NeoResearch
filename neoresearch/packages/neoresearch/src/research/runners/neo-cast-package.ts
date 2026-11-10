import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

export function resolveNpmNeoCastRoot(projectRoot = process.cwd()) {
  for (const directory of [projectRoot, process.env.NEO_RESEARCH_PACKAGE_ROOT]) {
    if (!directory) continue
    try {
      const require = createRequire(path.resolve(directory, "package.json"))
      const root = path.dirname(require.resolve("neo-cast/package.json"))
      if (existsSync(path.join(root, "runner-manifest.json")) && existsSync(path.join(root, "py", "runner.py"))) {
        return root
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error
    }
  }
}
