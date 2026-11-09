/// <reference path="../env.d.ts" />
import { tool } from "@neoresearch-ai/plugin"

function owners(team: string) {
  return (process.env[`TRIAGE_${team}_OWNERS`] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}

const TEAM = {
  desktop: owners("DESKTOP"),
  zen: owners("ZEN"),
  opentui: owners("OPENTUI"),
  core: owners("CORE"),
  docs: owners("DOCS"),
  windows: owners("WINDOWS"),
  nix: owners("NIX"),
} as const

function pick<T>(items: readonly T[]) {
  return items[Math.floor(Math.random() * items.length)]
}

function getIssueNumber(): number {
  const issue = parseInt(process.env.ISSUE_NUMBER ?? "", 10)
  if (!issue) throw new Error("ISSUE_NUMBER env var not set")
  return issue
}

async function githubFetch(endpoint: string, options: RequestInit = {}) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(options.headers instanceof Headers ? Object.fromEntries(options.headers.entries()) : options.headers),
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

export default tool({
  description: `Use this tool to assign and/or label a GitHub issue.

Choose labels and assignee using the current triage policy and ownership rules.
Pick the most fitting labels for the issue and assign one owner.

If unsure, choose the team/section with the most overlap with the issue and assign a member from that team at random.`,
  args: {
    assignee: tool.schema.string().describe("A repository maintainer configured for this deployment").optional(),
    labels: tool.schema
      .array(tool.schema.enum(["nix", "opentui", "perf", "web", "desktop", "zen", "docs", "windows", "core"]))
      .describe("The labels(s) to add to the issue")
      .default([]),
  },
  async execute(args) {
    const issue = getIssueNumber()
    const [owner, repo, extra] = (process.env.GITHUB_REPOSITORY ?? "").split("/")
    if (!owner || !repo || extra) throw new Error("GITHUB_REPOSITORY must be configured as owner/repository")

    const results: string[] = []
    let labels = [...new Set(args.labels.map((x) => (x === "desktop" ? "web" : x)))]
    const web = labels.includes("web")
    const text = `${process.env.ISSUE_TITLE ?? ""}\n${process.env.ISSUE_BODY ?? ""}`.toLowerCase()
    const zen = /\bzen\b/.test(text) || text.includes("opencode black")
    const nix = /\bnix(os)?\b/.test(text)

    if (labels.includes("nix") && !nix) {
      labels = labels.filter((x) => x !== "nix")
      results.push("Dropped label: nix (issue does not mention nix)")
    }

    const assignee =
      (nix ? pick(TEAM.nix) : web ? pick(TEAM.desktop) : undefined) ??
      args.assignee ??
      process.env.TRIAGE_DEFAULT_ASSIGNEE ??
      pick(TEAM.core)
    if (!assignee) throw new Error("Configure a triage owner or provide an explicit assignee")

    if (labels.includes("zen") && !zen) {
      throw new Error("Only add the zen label when issue title/body contains 'zen'")
    }

    if (web && !nix && TEAM.desktop.length > 0 && !TEAM.desktop.includes(assignee)) {
      throw new Error("Web issues must be assigned to a configured desktop owner")
    }

    if (TEAM.zen.includes(assignee) && !labels.includes("zen")) {
      throw new Error("Only zen issues should be assigned to a configured zen owner")
    }

    if (TEAM.windows.includes(assignee) && !labels.includes("windows")) {
      throw new Error("Only windows issues should be assigned to a configured windows owner")
    }

    if (TEAM.docs.includes(assignee) && !labels.includes("docs")) {
      throw new Error("Only docs issues should be assigned to a configured docs owner")
    }

    if (TEAM.opentui.includes(assignee) && !labels.includes("opentui")) {
      throw new Error("Only opentui issues should be assigned to a configured opentui owner")
    }

    await githubFetch(`/repos/${owner}/${repo}/issues/${issue}/assignees`, {
      method: "POST",
      body: JSON.stringify({ assignees: [assignee] }),
    })
    results.push(`Assigned @${assignee} to issue #${issue}`)

    if (labels.length > 0) {
      await githubFetch(`/repos/${owner}/${repo}/issues/${issue}/labels`, {
        method: "POST",
        body: JSON.stringify({ labels }),
      })
      results.push(`Added labels: ${labels.join(", ")}`)
    }

    return results.join("\n")
  },
})
