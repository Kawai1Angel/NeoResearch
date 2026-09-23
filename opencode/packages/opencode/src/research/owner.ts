import { readFileSync } from "node:fs"
import os from "node:os"

// Linux start ticks + boot ID distinguish a live owner from a reused PID. On
// other hosts we deliberately return unknown instead of authorizing a retry.
function identity(pid: number) {
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
  return `${boot}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`
}
export function executionOwner(nonce: string, pid = process.pid) {
  try {
    return JSON.stringify({ host: os.hostname(), pid, identity: identity(pid), nonce })
  } catch {
    return JSON.stringify({ host: os.hostname(), nonce })
  }
}
export function ownerExited(owner: string): boolean {
  try {
    const value = JSON.parse(owner)
    if (value.host !== os.hostname() || !value.pid || !value.identity) return false
    try {
      return identity(value.pid) !== value.identity
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
    }
  } catch {
    return false
  }
}

export function runnerGroupExited(owner: string): boolean {
  if (process.platform !== "linux") return false
  try {
    const value = JSON.parse(owner)
    if (value.host !== os.hostname() || !value.pid || !value.identity) return false
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    if (!value.identity.startsWith(`${boot}:`)) return true
    // Even if the leader has exited, its descendants can still own the GPU and
    // inherited output files. ESRCH for the entire group is required.
    try {
      process.kill(-value.pid, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH"
    }
  } catch {
    return false
  }
}
