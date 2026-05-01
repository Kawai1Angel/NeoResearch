#!/usr/bin/env bun

import { $ } from "bun"

const packageJson = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
  version: string
  publishConfig?: {
    tag?: string
  }
}

const releaseEnv = {
  ...process.env,
  NEO_RESEARCH_VERSION: process.env.NEO_RESEARCH_VERSION ?? packageJson.version,
  NEO_RESEARCH_CHANNEL: process.env.NEO_RESEARCH_CHANNEL ?? packageJson.publishConfig?.tag ?? "alpha",
}

const checks = [
  {
    name: "release boundary tests",
    command: "bun test test/release-boundary.test.ts",
    run: () => $`bun test test/release-boundary.test.ts`.env(releaseEnv),
  },
  {
    name: "TSF domain tests",
    command: "bun test test/research/tsf-domain.test.ts",
    run: () => $`bun test test/research/tsf-domain.test.ts`.env(releaseEnv),
  },
  {
    name: "Neo-Cast runner client tests",
    command: "bun test test/research/neo-cast-runner-client.test.ts",
    run: () => $`bun test test/research/neo-cast-runner-client.test.ts`.env(releaseEnv),
  },
  {
    name: "research CLI tests",
    command: "bun test test/cli/research-command.test.ts --timeout 30000",
    run: () => $`bun test test/cli/research-command.test.ts --timeout 30000`.env(releaseEnv),
  },
  {
    name: "doctor command tests",
    command: "bun test test/cli/doctor.test.ts",
    run: () => $`bun test test/cli/doctor.test.ts`.env(releaseEnv),
  },
  {
    name: "research Cockpit tests",
    command:
      "bun test test/cli/tui/research-cockpit-data.test.ts test/cli/tui/research-cockpit-render.test.tsx test/cli/tui/research-home-render.test.tsx test/cli/tui/research-slash-menu.test.tsx",
    run: () =>
      $`bun test test/cli/tui/research-cockpit-data.test.ts test/cli/tui/research-cockpit-render.test.tsx test/cli/tui/research-home-render.test.tsx test/cli/tui/research-slash-menu.test.tsx`.env(
        releaseEnv,
      ),
  },
  {
    name: "research service tests",
    command: "bun test test/research/service.test.ts --timeout 30000",
    run: () => $`bun test test/research/service.test.ts --timeout 30000`.env(releaseEnv),
  },
  {
    name: "typecheck",
    command: "bun run typecheck",
    run: () => $`bun run typecheck`.env(releaseEnv),
  },
  {
    name: "current platform build",
    command: "bun run build",
    run: () => $`bun run build`.env(releaseEnv),
  },
  {
    name: "dist package dry-run",
    command: "NEO_RESEARCH_PUBLISH_DRY_RUN=1 bun run script/publish.ts",
    run: () =>
      $`bun run script/publish.ts`.env({
        ...releaseEnv,
        NEO_RESEARCH_PUBLISH_DRY_RUN: "1",
      }),
  },
]

console.log(`NeoResearch release check version=${releaseEnv.NEO_RESEARCH_VERSION} channel=${releaseEnv.NEO_RESEARCH_CHANNEL}`)

for (const check of checks) {
  console.log(`\n=== ${check.name}: ${check.command} ===`)
  await check.run()
}
