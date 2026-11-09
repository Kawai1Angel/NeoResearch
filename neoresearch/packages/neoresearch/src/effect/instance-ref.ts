import { Context } from "effect"
import type { InstanceContext } from "@/project/instance"
import type { WorkspaceID } from "@/control-plane/schema"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~neoresearch/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceID | undefined>("~neoresearch/WorkspaceRef", {
  defaultValue: () => undefined,
})
