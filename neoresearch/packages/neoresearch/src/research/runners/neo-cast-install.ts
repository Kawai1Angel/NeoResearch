import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@neoresearch-ai/core/global"
import { Flock } from "@neoresearch-ai/core/util/flock"
import * as Process from "@/util/process"
import { neoCastRuntimePython } from "./runtime-python"

const uvVersion = "0.11.16"
const pythonVersion = "3.12"
// Checksums from the immutable Astral uv release.
const uvArchives: Readonly<Record<string, readonly [string, string]>> = {
  "darwin-arm64": ["aarch64-apple-darwin", "2b25be1af546be330b340b0a76b99f989daa6d92678fdffb87438e661e9d88fb"],
  "darwin-x64": ["x86_64-apple-darwin", "6b91ae3de155f51bd1f5b74814821c79f016a176561f252cd9ddfb976939af2e"],
  "linux-arm64": ["aarch64-unknown-linux-gnu", "8c9d0f0ee98166ae6ab198747519ba6f25db29d185bd2ae5960ecebc91a5c22a"],
  "linux-x64": ["x86_64-unknown-linux-gnu", "74947fe2c03315cf07e82ab3acc703eddef01aba4d5232a98e4c6825ec116131"],
  "win32-arm64": ["aarch64-pc-windows-msvc", "e4f8e70eb21f0f4efd2eeb159ab289f9a16057d59881a4475758be4ce39bc8c5"],
  "win32-x64": ["x86_64-pc-windows-msvc", "dd9d6d6554bfab265bfa98aa8e8a406c5c3a7b97582f93de1f4d48d9154a0395"],
}

function installedStateRoot(root: string) {
  if (path.basename(root) !== "neo-cast" || path.basename(path.dirname(root)) !== "node_modules") return
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16)
  return path.join(Global.Path.data, "neo-cast", key)
}

export function neoCastStateDirectory(root: string) {
  return path.join(installedStateRoot(root) ?? root, ".neo-cast")
}

export function npmNeoCastRuntime(root: string) {
  const state = installedStateRoot(root)
  if (!state) return
  const lock = path.join(root, "uv.lock")
  if (!existsSync(lock)) return
  const key = createHash("sha256").update(`${pythonVersion}\n`).update(readFileSync(lock)).digest("hex").slice(0, 16)
  const directory = path.join(state, "runtimes", key)
  const python = neoCastRuntimePython(directory)
  const marker = path.join(directory, ".ready")
  return { directory, python, marker, ready: existsSync(marker) && existsSync(python) }
}

async function findUv(signal?: AbortSignal) {
  const installed = Bun.which("uv")
  if (installed) return installed
  const asset = uvArchives[`${process.platform}-${process.arch}`]
  if (!asset) throw new Error(`Automatic uv installation is unavailable on ${process.platform}/${process.arch}. Install uv and retry.`)

  const [target, checksum] = asset
  const windows = process.platform === "win32"
  const executable = windows ? "uv.exe" : "uv"
  const directory = path.join(Global.Path.bin, `uv-${uvVersion}`)
  const output = path.join(directory, executable)
  if (existsSync(output)) return output

  return Flock.withLock(`neo-cast-uv:${output}`, async () => {
    if (existsSync(output)) return output
    await mkdir(directory, { recursive: true })
    const temp = await mkdtemp(path.join(directory, "download-"))
    try {
      const name = `uv-${target}.${windows ? "zip" : "tar.gz"}`
      const timeout = AbortSignal.timeout(120_000)
      const response = await fetch(`https://releases.astral.sh/github/uv/releases/download/${uvVersion}/${name}`, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (!response.ok) throw new Error(`Could not download uv (${response.status})`)
      const data = Buffer.from(await response.arrayBuffer())
      if (createHash("sha256").update(data).digest("hex") !== checksum) throw new Error("uv archive checksum mismatch")
      const archive = path.join(temp, name)
      await writeFile(archive, data)
      await Process.run(["tar", "-xf", archive, "-C", temp], { abort: signal, timeout: 60_000 })
      const direct = path.join(temp, executable)
      await rename(existsSync(direct) ? direct : path.join(temp, `uv-${target}`, executable), output)
      return output
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }, { signal })
}

export async function ensureNpmNeoCastPython(root: string, signal?: AbortSignal) {
  const runtime = npmNeoCastRuntime(root)
  if (!runtime || runtime.ready) return runtime?.python

  return Flock.withLock(`neo-cast-python:${runtime.directory}`, async () => {
    if (existsSync(runtime.marker) && existsSync(runtime.python)) return runtime.python
    try {
      await mkdir(runtime.directory, { recursive: true })
      await rm(runtime.marker, { force: true })
      const uv = await findUv(signal)
      const result = await Process.run([
        uv, "sync", "--project", root, "--frozen", "--no-dev", "--no-install-project", "--python", pythonVersion,
      ], {
        env: { ...process.env, UV_PROJECT_ENVIRONMENT: path.dirname(path.dirname(runtime.python)) },
        abort: signal,
        tree: true,
        nothrow: true,
        timeout: 30 * 60_000,
      })
      signal?.throwIfAborted()
      if (result.code !== 0 || !existsSync(runtime.python)) {
        throw new Error(result.stderr.toString().trim() || `uv sync exited with code ${result.code}`)
      }
      await writeFile(runtime.marker, "ready\n")
      return runtime.python
    } catch (error) {
      signal?.throwIfAborted()
      throw new Error(`Could not initialize the Neo-Cast Python environment: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }, { signal, timeoutMs: 30 * 60_000 })
}

export async function ensureRunnerPython(command: { executable: string; env?: Record<string, string> }, signal?: AbortSignal) {
  const root = command.env?.NEO_CAST_PACKAGE_ROOT
  if (root && npmNeoCastRuntime(root)?.python === command.executable) await ensureNpmNeoCastPython(root, signal)
}
