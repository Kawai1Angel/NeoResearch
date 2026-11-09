import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "../../src/storage"
import { ResearchTaskTable } from "../../src/research/research.sql"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  await resetDatabase()
})

describe("research sql schema", () => {
  test("research_task table is available after migrations", () => {
    const rows = Database.use((db) => db.select().from(ResearchTaskTable).all())
    expect(rows).toEqual([])
  })
})
