import { rm } from "fs/promises"
import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage"
import path from "node:path"

export async function resetDatabase() {
  await Instance.disposeAll().catch(() => undefined)
  Database.close()
  await rm(Database.Path, { force: true }).catch(() => undefined)
  await rm(`${Database.Path}-wal`, { force: true }).catch(() => undefined)
  await rm(`${Database.Path}-shm`, { force: true }).catch(() => undefined)
  // Only remove the library created by test/preload.ts, never a caller's shared library.
  const testHome = process.env.NEORESEARCH_TEST_HOME
  const library = process.env.NEO_RESEARCH_EXPERIENCE_DB
  if (testHome && library === path.join(path.dirname(testHome), "experience.db")) {
    for (const suffix of ["", "-wal", "-shm"])
      await rm(`${library}${suffix}`, { force: true }).catch(() => undefined)
  }
}
