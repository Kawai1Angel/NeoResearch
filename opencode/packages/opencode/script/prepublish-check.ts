#!/usr/bin/env bun

import { $ } from "bun"

const checks = [
  {
    name: "release boundary tests",
    command: "bun test test/release-boundary.test.ts",
    run: () => $`bun test test/release-boundary.test.ts`,
  },
  {
    name: "research service tests",
    command: "bun test test/research/service.test.ts --timeout 30000",
    run: () => $`bun test test/research/service.test.ts --timeout 30000`,
  },
  {
    name: "typecheck",
    command: "bun run typecheck",
    run: () => $`bun run typecheck`,
  },
  {
    name: "current platform build",
    command: "bun run build",
    run: () => $`bun run build`,
  },
  {
    name: "dist package dry-run",
    command: "NEO_RESEARCH_PUBLISH_DRY_RUN=1 bun run script/publish.ts",
    run: () =>
      $`bun run script/publish.ts`.env({
        ...process.env,
        NEO_RESEARCH_PUBLISH_DRY_RUN: "1",
      }),
  },
]

for (const check of checks) {
  console.log(`\n=== ${check.name}: ${check.command} ===`)
  await check.run()
}
