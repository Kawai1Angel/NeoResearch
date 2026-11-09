import path from "path"

const defaultWorkspaceRoot = path.resolve(import.meta.dirname, "../../../..")
const workspaceRoot = process.env.NEO_RESEARCH_DEBUG_CWD ?? defaultWorkspaceRoot

process.chdir(path.resolve(workspaceRoot))

await import("../src/index")
