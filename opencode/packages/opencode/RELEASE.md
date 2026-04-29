# NeoResearch npm Release Checklist

Use this checklist for `neo-research@0.1.0-alpha.*` releases. The npm release contains the CLI wrapper and platform binary packages only; the Python Neo-Cast runner remains an external local project.

## 1. Verify npm Access

```bash
npm whoami
npm view neo-research version
npm view neo-research-darwin-arm64 version
```

If the package name is unavailable, publish under the agreed scoped name before changing `package.json`.

## 2. Run Local Gates

```bash
bun run prepublish:check
```

This runs release-boundary tests, Research OS service tests, typecheck, current-platform build, and a source package dry-run.

## 3. Build Release Packages

```bash
NEO_RESEARCH_VERSION=0.1.0-alpha.0 NEO_RESEARCH_CHANNEL=alpha bun run build:all
NEO_RESEARCH_VERSION=0.1.0-alpha.0 NEO_RESEARCH_CHANNEL=alpha NEO_RESEARCH_PUBLISH_DRY_RUN=1 bun script/publish.ts
```

Confirm that `dist/` contains platform packages such as `neo-research-darwin-arm64` plus the generated `neo-research` main package.

## 4. Test Local Tarballs

Install the generated main package and the matching platform package into a temporary npm prefix, then run:

```bash
neo-research --version
neo-research doctor --format json
neo-research init
```

When testing the TSF runner, set `NEO_CAST_ROOT` to the local Neo-Cast checkout before running `doctor`.

## 5. Publish

Use the `publish-npm` GitHub Actions workflow with `version=0.1.0-alpha.0` and `dry_run=false`, or run the package publisher with an authenticated npm session:

```bash
NEO_RESEARCH_VERSION=0.1.0-alpha.0 NEO_RESEARCH_CHANNEL=alpha bun script/publish.ts
```

Do not install Python, torch, datasets, or Neo-Cast from npm `postinstall`.
