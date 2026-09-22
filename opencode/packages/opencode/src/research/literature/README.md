# Standalone LiteratureAgent

This module is intentionally not registered in the NeoResearch service or main
CLI. It consumes only an explicit catalog `paperID` or local PDF and writes to
Neo-Cast's independent `.neo-cast/literature-knowledge/` directory.

From `opencode/packages/opencode`:

```bash
bun run src/research/literature/dev-cli.ts parse \
  --neo-cast-root ../../../../neo_cast --paper-id <paper-id>

bun run src/research/literature/dev-cli.ts build \
  --neo-cast-root ../../../../neo_cast --pdf /absolute/paper.pdf \
  --title "Paper title" --publication-status unknown

bun run src/research/literature/dev-cli.ts validate \
  --neo-cast-root ../../../../neo_cast

bun run src/research/literature/dev-cli.ts export \
  --neo-cast-root ../../../../neo_cast --status paper_backed

bun run src/research/literature/dev-cli.ts show-run <run-id> \
  --neo-cast-root ../../../../neo_cast
```

`build` uses the existing Neo-Cast LLM configuration when an API key is
available. Without a configured model it still parses and caches the document,
then records a `partial` run with `llm_not_configured`; it never fabricates
cards. Pass `--no-llm` to request that parse-only partial behavior explicitly.
Tests use `FixtureExtractionModel` for deterministic extraction.

PDF text is untrusted. Extraction and verification prompts forbid executing
paper instructions, and deterministic validation requires every evidence span,
page, section, chunk, and reported number to resolve back to normalized source.
