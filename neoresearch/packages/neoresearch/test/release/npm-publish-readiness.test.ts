import { describe, expect, test } from "bun:test"
import path from "path"

const packageDir = path.resolve(import.meta.dir, "../..")
const workspaceRoot = path.resolve(packageDir, "../..")

async function readPackageJSON(file: string) {
  return (await Bun.file(file).json()) as Record<string, any>
}

describe("NeoResearch npm publish readiness", () => {
  test("declares the alpha package and CLI identity", async () => {
    const rootPkg = await readPackageJSON(path.join(workspaceRoot, "package.json"))
    const cliPkg = await readPackageJSON(path.join(packageDir, "package.json"))

    expect(rootPkg.name).toBe("neo-research-workspace")
    expect(rootPkg.repository.url).toContain("neo-research")
    expect(cliPkg.name).toBe("neo-research")
    expect(cliPkg.description).toContain("Research OS")
    expect(cliPkg.private).not.toBe(true)
    expect(cliPkg.bin).toEqual({ "neo-research": "bin/neo-research" })
    expect(cliPkg.publishConfig).toMatchObject({ access: "public", tag: "alpha" })
    expect(cliPkg.repository.url).toContain("neo-research")
  })

  test("ships a NeoResearch wrapper and release README", async () => {
    const wrapper = await Bun.file(path.join(packageDir, "bin", "neo-research")).text()
    const readme = await Bun.file(path.join(packageDir, "README.md")).text()

    expect(wrapper).toContain("NEO_RESEARCH_BIN_PATH")
    expect(wrapper).toContain("neo-research-")
    expect(wrapper).toContain("NEO_RESEARCH_PACKAGE_ROOT")
    expect(readme).toContain("NeoResearch")
    expect(readme).toContain("neo-research research")
    expect(readme).toContain("Neo-Cast")
  })
})
