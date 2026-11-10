# NeoResearch Runtime

This directory contains the NeoResearch-derived runtime used by NeoResearch:

- `packages/neoresearch`: NeoResearch CLI, server, session, event, TUI, and Research OS APIs.
- `packages/app`: Web Dashboard shell and research dashboard helpers.
- `packages/core`, `packages/ui`, `packages/sdk/js`, `packages/plugin`, `packages/script`: runtime support packages still required by the CLI, TUI, and Web Dashboard.

Original NeoResearch product surfaces that are not part of NeoResearch, such as desktop apps, hosted console, marketing docs, cloud infra, Slack integration, Storybook, and VS Code extension packaging, have been removed from this fork.

Run the repository-level verification from the project root:

```bash
./scripts/test_all.sh --quick
```
