import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

async function start(directory: string, mode: string) {
  return Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../fixture/research-restart-process.ts"), mode], {
    env: {
      ...process.env,
      OPENCODE_DB: path.join(directory, "recovery.db"),
      RESEARCH_CALLS: path.join(directory, "calls"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
}

test("completed receipts survive a real process/database reopen", async () => {
  await using tmp = await tmpdir()
  const first = await start(tmp.path, "completed")
  const firstOutput = await new Response(first.stdout).text()
  expect(await first.exited).toBe(0)
  const second = await start(tmp.path, "reopen")
  const output = await new Response(second.stdout).text()
  expect(await second.exited).toBe(0)
  expect(JSON.parse(output.trim()).id).toBe(JSON.parse(firstOutput.trim()).id)
  expect(JSON.parse(output.trim()).result).toEqual({ report: "saved" })
  expect(await Bun.file(path.join(tmp.path, "calls")).text()).toBe("called\n")
}, 30000)

test("SIGKILL preserves the lock until the previous owner is proven dead and reconciled", async () => {
  await using tmp = await tmpdir()
  const first = await start(tmp.path, "running")
  const reader = first.stdout.getReader()
  try {
    const ready = await reader.read()
    expect(new TextDecoder().decode(ready.value)).toContain('"running"')
    first.kill("SIGKILL")
    await first.exited
    const second = await start(tmp.path, "reconcile")
    const output = JSON.parse((await new Response(second.stdout).text()).trim())
    expect(await second.exited).toBe(0)
    expect(output.recoveryRequired).toBe(true)
    expect(output.reconciled).toBe(process.platform === "linux")
    expect(await Bun.file(path.join(tmp.path, "calls")).text()).toBe("called\n")
  } finally {
    first.kill()
    reader.releaseLock()
  }
}, 30000)

test("additive migration preserves a legacy task and session-less results", async () => {
  const { Database: SQLite } = await import("bun:sqlite")
  const { readdir, readFile } = await import("node:fs/promises")
  await using tmp = await tmpdir()
  const db = new SQLite(path.join(tmp.path, "legacy.db"))
  try {
    const directory = path.resolve(import.meta.dir, "../../migration")
    const names = (await readdir(directory)).filter((name) => /^\d{14}_/.test(name)).sort()
    for (const name of names.filter((name) => name < "20260922000000"))
      db.exec(await readFile(path.join(directory, name, "migration.sql"), "utf8"))
    db.exec(
      "INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES('legacy','/tmp/legacy',1,1,'[]')",
    )
    db.exec(
      "INSERT INTO research_task(id,project_id,title,domain_id,mode,status,task_spec,objective,budget,time_created,time_updated) VALUES('rtsk_legacy','legacy','Retained research','tsf','autonomous','completed','{}','{}','{}',1,1)",
    )
    db.exec(await readFile(path.join(directory, "20260922000000_research_history/migration.sql"), "utf8"))
    expect(db.query("SELECT title,status,cockpit_chat_session_id,state_revision FROM research_task").get()).toEqual({
      title: "Retained research",
      status: "completed",
      cockpit_chat_session_id: null,
      state_revision: 0,
    })
    db.exec("UPDATE research_task SET status='paused' WHERE id='rtsk_legacy'")
    expect(db.query("SELECT state_revision FROM research_task").get()).toEqual({ state_revision: 1 })
    expect(db.query("SELECT count(*) AS count FROM research_event").get()).toEqual({ count: 1 })
  } finally {
    db.close()
  }
})
