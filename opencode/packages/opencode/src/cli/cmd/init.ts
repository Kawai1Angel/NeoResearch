import { existsSync } from "fs"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { cmd } from "./cmd"

async function writeJsonIfMissing(file: string, value: unknown) {
  if (existsSync(file)) return false
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  return true
}

export const InitCommand = cmd({
  command: "init",
  describe: "initialize local NeoResearch workspace files",
  builder: (yargs) =>
    yargs.option("neo-cast-root", {
      describe: "local Neo-Cast runner root to record in .neo-research/config.json",
      type: "string",
    }),
  handler: async (args) => {
    const root = path.resolve(".neo-research")
    const directories = [
      root,
      path.join(root, "runtime"),
      path.join(root, "artifacts"),
      path.join(root, "run-plans"),
      path.join(root, "runner-executions"),
    ]
    for (const directory of directories) {
      await mkdir(directory, { recursive: true })
    }

    const neoCastRoot = args.neoCastRoot ?? process.env.NEO_RESEARCH_NEO_CAST_ROOT ?? process.env.NEO_CAST_ROOT
    const configCreated = await writeJsonIfMissing(path.join(root, "config.json"), {
      schemaVersion: "neo-research.config.v1",
      ...(neoCastRoot === undefined ? {} : { neoCastRoot: path.resolve(String(neoCastRoot)) }),
    })

    console.log(`initialized=${root}`)
    console.log(`config=${configCreated ? "created" : "exists"}`)
    console.log("next=neo-research doctor")
  },
})
