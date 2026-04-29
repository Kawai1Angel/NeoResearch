#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"
import fs from "fs/promises"
import path from "path"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
const dryRun = process.env.NEO_RESEARCH_PUBLISH_DRY_RUN === "1"
const npmEnv = {
  ...process.env,
  npm_config_cache: path.join(dir, ".artifacts/npm-cache"),
}

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.env(npmEnv).nothrow()).exitCode === 0
}

async function publish(dir: string, name: string, version: string) {
  // GitHub artifact downloads can drop the executable bit, and Docker uses the
  // unpacked dist binaries directly rather than the published tarball.
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  for (const file of new Bun.Glob("*.tgz").scanSync({ cwd: dir })) {
    await fs.rm(path.join(dir, file), { force: true })
  }
  await $`bun pm pack`.cwd(dir)
  const tarballs = Array.from(new Bun.Glob("*.tgz").scanSync({ cwd: dir }))
  if (tarballs.length !== 1) {
    throw new Error(`Expected exactly one packed tarball in ${dir}, found ${tarballs.length}`)
  }
  if (dryRun) {
    console.log(`packed ${name}@${version}`)
    return
  }
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`npm publish ${tarballs[0]} --access public --tag ${Script.channel}`.env(npmEnv).cwd(dir)
}

const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  const pkg = await Bun.file(`./dist/${filepath}`).json()
  binaries[pkg.name] = pkg.version
}
console.log("binaries", binaries)
const version = Object.values(binaries)[0]
if (!version) {
  throw new Error("No platform binary packages found in dist/. Run `bun run build:all` before publishing.")
}

await $`mkdir -p ./dist/${pkg.name}`
await $`mkdir -p ./dist/${pkg.name}/bin`
await $`cp ./bin/${pkg.name} ./dist/${pkg.name}/bin/${pkg.name}`
await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("./LICENSE").text())
await Bun.file(`./dist/${pkg.name}/README.md`).write(await Bun.file("./README.md").text())

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name,
      description: pkg.description,
      type: pkg.type,
      bin: {
        [pkg.name]: `./bin/${pkg.name}`,
      },
      version: version,
      license: pkg.license,
      repository: pkg.repository,
      bugs: pkg.bugs,
      homepage: pkg.homepage,
      publishConfig: pkg.publishConfig,
      binaryPackageBase: pkg.name,
      optionalDependencies: binaries,
      files: ["bin/", "README.md", "LICENSE", "package.json"],
    },
    null,
    2,
  ),
)

const tasks = Object.entries(binaries).map(async ([name]) => {
  await publish(`./dist/${name}`, name, binaries[name])
})
await Promise.all(tasks)
await publish(`./dist/${pkg.name}`, pkg.name, version)

// Native package managers are intentionally opt-in for the NeoResearch alpha; npm is the release target.
if (!Script.preview && process.env.NEO_RESEARCH_PUBLISH_NATIVE_INSTALLERS === "1") {
  throw new Error("NeoResearch alpha only publishes npm packages; native installers are not configured.")
}
