import { Database, and, eq } from "@/storage"
import { Instance } from "@/project/instance"
import { Bus } from "@/bus"
import { Event } from "./event"
import { ResearchMemoryWriteTable, ResearchTaskTable } from "./research.sql"
import { ExperienceDraftSchema, type ExperienceDraft } from "./experience"
import { ExperienceLibrary, experienceLibraryPath } from "./experience-library"
import { prepareExperience } from "./experience-store"
import { digest } from "./digest"
import type { ExperienceWriteBinding } from "./experience-binding"
import type { ResearchTaskID } from "./schema"

function assertTask(taskID: ResearchTaskID) {
  const task = Database.use((db) =>
    db
      .select()
      .from(ResearchTaskTable)
      .where(and(eq(ResearchTaskTable.id, taskID), eq(ResearchTaskTable.project_id, Instance.project.id)))
      .get(),
  )
  if (!task) throw new Error("Memory outbox task does not belong to this project")
}
export function experienceWriteIDs(
  taskID: ResearchTaskID,
  binding: ExperienceWriteBinding,
  drafts: readonly ExperienceDraft[],
) {
  return drafts.map((_, index) => `memory_${digest({ taskID, binding, index })}`)
}

/** Called in the same research DB transaction as the accepted reflection result. */
export function enqueueExperienceWrites(
  taskID: ResearchTaskID,
  binding: ExperienceWriteBinding,
  drafts: readonly ExperienceDraft[],
) {
  assertTask(taskID)
  const ids = experienceWriteIDs(taskID, binding, drafts)
  Database.use((db) => {
    drafts.forEach((input, index) => {
      const draft = ExperienceDraftSchema.parse(input)
      const request_digest = digest({ taskID, binding, draft })
      const previous = db
        .select()
        .from(ResearchMemoryWriteTable)
        .where(eq(ResearchMemoryWriteTable.id, ids[index]!))
        .get()
      if (previous) {
        if (previous.request_digest !== request_digest)
          throw new Error("Memory proposal id was reused with different content")
        return
      }
      db.insert(ResearchMemoryWriteTable)
        .values({
          id: ids[index]!,
          task_id: taskID,
          binding,
          draft,
          request_digest,
          library_path: experienceLibraryPath(Instance.directory),
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
    })
  })
  return ids
}

export function listExperienceWrites(taskID: ResearchTaskID) {
  assertTask(taskID)
  return Database.use((db) =>
    db.select().from(ResearchMemoryWriteTable).where(eq(ResearchMemoryWriteTable.task_id, taskID)).all(),
  ).map(({ payload, draft, library_path, ...receipt }) => receipt)
}

/** Retry transport/storage failures; reject invalid evidence without replaying the model or training. */
export async function flushExperienceWrites(taskID: ResearchTaskID) {
  assertTask(taskID)
  const pending = Database.use((db) =>
    db.select().from(ResearchMemoryWriteTable).where(eq(ResearchMemoryWriteTable.task_id, taskID)).all(),
  ).filter((entry) => entry.status === "pending" || entry.status === "prepared")
  for (const entry of pending) {
    let payload = entry.payload
    if (!payload) {
      try {
        const prepared = await prepareExperience(taskID, entry.draft, entry.binding, {
          libraryPath: entry.library_path,
        })
        payload = Database.transaction((db) => {
          const current = db
            .select()
            .from(ResearchMemoryWriteTable)
            .where(eq(ResearchMemoryWriteTable.id, entry.id))
            .get()!
          if (current.payload) return current.payload
          db.update(ResearchMemoryWriteTable)
            .set({ payload: prepared, status: "prepared", error: null, time_updated: Date.now() })
            .where(eq(ResearchMemoryWriteTable.id, entry.id))
            .run()
          return prepared
        })
      } catch (error) {
        const code = String((error as { code?: string })?.code ?? "")
        const transient = /SQLITE|ENOENT|EACCES|EPERM|EBUSY|ENOSPC|EIO/.test(code)
        Database.use((db) =>
          db
            .update(ResearchMemoryWriteTable)
            .set({ status: transient ? "pending" : "rejected", error: String(error), time_updated: Date.now() })
            .where(eq(ResearchMemoryWriteTable.id, entry.id))
            .run(),
        )
        continue
      }
    }
    let library: ExperienceLibrary | undefined
    try {
      library = new ExperienceLibrary(entry.library_path)
      const result = library.save(payload.memory, {
        ...payload.source,
        writeKey: entry.id,
        writeDigest: entry.request_digest,
      })
      Database.use((db) =>
        db
          .update(ResearchMemoryWriteTable)
          .set({
            status: "applied",
            error: null,
            result: {
              sourceEntryID: result.sourceEntryID,
              canonicalExperienceID: result.canonicalExperienceID,
              revision: result.revision,
            },
            time_updated: Date.now(),
          })
          .where(eq(ResearchMemoryWriteTable.id, entry.id))
          .run(),
      )
      if (result.created) await Bus.publish(Event.MemoryCreated, { memory: result.memory })
    } catch (error) {
      const permanent =
        /idempotency|different input|memory purpose|parent purpose|canonical parent|validated structured experience/i.test(
          String(error),
        )
      Database.use((db) =>
        db
          .update(ResearchMemoryWriteTable)
          .set({ ...(permanent ? { status: "rejected" } : {}), error: String(error), time_updated: Date.now() })
          .where(eq(ResearchMemoryWriteTable.id, entry.id))
          .run(),
      )
    } finally {
      library?.close()
    }
  }
  return listExperienceWrites(taskID)
}
