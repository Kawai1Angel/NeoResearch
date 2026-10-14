import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { copyModelExportRuntime } from "../../src/research/model-export-runtime"

test("model exports carry their private Python runtime and remain importable outside the runner", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "source")
  const target = path.join(tmp.path, "release")
  const name = "_neocast_runtime_fixture"
  await mkdir(path.join(source, name, "factory"), { recursive: true })
  await writeFile(path.join(source, "model_impl.py"), `from ${name}.factory.build_model import build_model\n`)
  await writeFile(path.join(source, name, "__init__.py"), "")
  await writeFile(path.join(source, name, "factory", "__init__.py"), "")
  await writeFile(path.join(source, name, "factory", "build_model.py"), "def build_model():\n    return 42\n")
  const copied = await copyModelExportRuntime(source, target)
  await writeFile(path.join(target, "model_impl.py"), await readFile(path.join(source, "model_impl.py")))
  expect(copied).toEqual({ [`runtime/${name}`]: `model/${name}` })
  const result = Bun.spawnSync(["python3", "-I", "-c", "import sys; sys.path.insert(0, sys.argv[1]); from model_impl import build_model; assert build_model() == 42", target])
  expect(result.exitCode).toBe(0)
})

test("a missing required runtime fails the release instead of silently marking it complete", async () => {
  await using tmp = await tmpdir()
  await writeFile(path.join(tmp.path, "model_impl.py"), "from _neocast_runtime_missing.factory.build_model import build_model\n")
  await expect(copyModelExportRuntime(tmp.path, path.join(tmp.path, "release"))).rejects.toThrow("missing its required Python runtime")
})

test("self-contained legacy model builders require no private runtime directory", async () => {
  await using tmp = await tmpdir()
  await writeFile(path.join(tmp.path, "model_impl.py"), "def build_model():\n    return None\n")
  expect(await copyModelExportRuntime(tmp.path, path.join(tmp.path, "release"))).toEqual({})
})
