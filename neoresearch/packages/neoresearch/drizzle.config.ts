import { defineConfig } from "drizzle-kit"
import { homedir } from "node:os"
import path from "node:path"

const dataDirectory = process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share")
const database = process.env.NEORESEARCH_DB ?? "neoresearch.db"

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/**/*.sql.ts",
  out: "./migration",
  dbCredentials: {
    url:
      database === ":memory:" || path.isAbsolute(database) ? database : path.join(dataDirectory, "neoresearch", database),
  },
})
