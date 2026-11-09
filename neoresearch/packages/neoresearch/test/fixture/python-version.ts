import { chmod, copyFile, link, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "./fixture"

let compiled: Promise<{ executable: string; dispose: () => Promise<void> }> | undefined
const installed = new Set<string>()

async function removeProbeFile(filename: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(filename, { force: true })
      return
    } catch (error) {
      // Windows can hold an exited executable briefly (including virus scans).
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== "win32" || attempt >= 5 || !["EBUSY", "EPERM", "EACCES"].includes(code ?? ""))
        throw error
      await Bun.sleep((attempt + 1) * 50)
    }
  }
}

// Windows cannot execute a #!/bin/sh file via spawnSync. Compile one native
// version probe, then hard-link it into each fixture's venv. No Python install
// or shell is required, and each fixture can report its own version.
function windowsProbe() {
  return (compiled ??= (async () => {
    const tmp = await tmpdir()
    const entry = path.join(tmp.path, "version.ts")
    const executable = path.join(tmp.path, "python.exe")
    await writeFile(
      entry,
      'import { readFileSync } from "node:fs"; import path from "node:path"; process.stdout.write(readFileSync(path.join(path.dirname(process.execPath), "python-version.txt"), "utf8"))',
    )
    const child = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        "--no-compile-autoload-bunfig",
        "--no-compile-autoload-dotenv",
        entry,
        "--outfile",
        executable,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    const error = await new Response(child.stderr).text()
    if ((await child.exited) !== 0) {
      await tmp[Symbol.asyncDispose]()
      throw new Error(`Cannot build Python version fixture: ${error}`)
    }
    return { executable, dispose: () => tmp[Symbol.asyncDispose]() }
  })())
}

export async function installPythonVersion(root: string, version = "Python 3.12.0") {
  const directory = path.join(root, ".neo-cast", "runtime", ".venv", process.platform === "win32" ? "Scripts" : "bin")
  await mkdir(directory, { recursive: true })
  const executable = path.join(directory, process.platform === "win32" ? "python.exe" : "python")
  if (process.platform === "win32") {
    const probe = await windowsProbe()
    await removeProbeFile(executable)
    await link(probe.executable, executable).catch(() => copyFile(probe.executable, executable))
    const config = path.join(directory, "python-version.txt")
    await writeFile(config, `${version}\n`)
    installed.add(config)
  } else {
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`)
    await chmod(executable, 0o755)
  }
  installed.add(executable)
  return executable
}

export async function cleanupPythonVersions() {
  for (const filename of installed) await removeProbeFile(filename)
  const probe = await compiled
  await probe?.dispose()
  compiled = undefined
  installed.clear()
}
