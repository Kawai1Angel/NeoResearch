import { afterAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { cleanupPythonVersions, installPythonVersion } from "../../fixture/python-version"
import { tmpdir } from "../../fixture/fixture"
import { neoCastRuntimePython } from "../../../src/research/runners/runtime-python"

test("project venv detection launches a native Python version probe on this platform", async () => {
  await using tmp = await tmpdir()
  const executable = await installPythonVersion(tmp.path)
  expect(neoCastRuntimePython(tmp.path)).toBe(executable)
  const result = spawnSync(executable, ["--version"], { encoding: "utf8" })
  expect({ error: result.error?.message, status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual(
    { error: undefined, status: 0, stdout: "Python 3.12.0\n", stderr: "" },
  )
})

test("an existing POSIX layout remains readable when no native Windows interpreter is present", async () => {
  await using tmp = await tmpdir()
  const executable = path.join(tmp.path, ".neo-cast", "runtime", ".venv", "bin", "python")
  await mkdir(path.dirname(executable), { recursive: true })
  await writeFile(executable, "placeholder")
  expect(neoCastRuntimePython(tmp.path)).toBe(executable)
})

afterAll(cleanupPythonVersions)
