#!/usr/bin/env bun

if (process.env.NEO_RESEARCH_ALLOW_SOURCE_PUBLISH === "1") {
  console.warn("NEO_RESEARCH_ALLOW_SOURCE_PUBLISH=1 set; allowing source package publish.")
  process.exit(0)
}

console.error(
  [
    "Refusing to publish the NeoResearch source package directly.",
    "",
    "Use the generated dist publisher instead:",
    "  bun run build:all",
    "  bun run script/publish.ts",
    "",
    "For a local dry run:",
    "  bun run build",
    "  NEO_RESEARCH_PUBLISH_DRY_RUN=1 bun run script/publish.ts",
    "",
    "This guard prevents publishing package.json with workspace: or catalog: dependencies.",
    "Override with NEO_RESEARCH_ALLOW_SOURCE_PUBLISH=1 only for intentional local experiments.",
  ].join("\n"),
)
console.error("Canonical publisher: packages/neoresearch/script/publish.ts")
process.exit(1)
