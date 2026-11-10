import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@neoresearch-ai/core/global"
import { InstallationChannel } from "@neoresearch-ai/core/installation/version"
import { Database } from "../../src/storage"

describe("Database.Path", () => {
  test("returns database path for the current channel", () => {
    const expected = ["latest", "beta"].includes(InstallationChannel)
      ? path.join(Global.Path.data, "neoresearch.db")
      : path.join(Global.Path.data, `neoresearch-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
    expect(Database.getChannelPath()).toBe(expected)
  })
})
