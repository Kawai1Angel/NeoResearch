#!/usr/bin/env bun

import { $ } from "bun"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

console.log("=== publishing NeoResearch npm package ===\n")
await $`bun ./packages/opencode/script/publish.ts`
