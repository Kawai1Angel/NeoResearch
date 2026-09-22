# LiteratureAgent

The Research service runs this module inside the single `literature` phase between
DataAnalysis and HypoPlanner. Retrieve(pre), Literature(core), and Retrieve(post)
share the existing validation rules and persisted evidence bundle. The standalone
CLI below remains available for explicit catalog IDs and local PDFs. Knowledge is
stored in Neo-Cast's `.neo-cast/literature-knowledge/` directory.

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

## Session tools and Cockpit

The initial rollout keeps `direct` execution as the default. Enable the child
session path on a research task by setting:

```json
{ "runtime": { "literatureSessionTools": true } }
```

This is a field within the existing taskSpec runtime object; preserve the task's
other runtime settings. A configured LLM that maps to an OpenCode provider is
required for `session_tool`. Missing credentials, an unavailable provider/session,
or a session that ends before executing the tool fall back to `direct`. Once the
write operation starts, the service reconciles that same operation and validates
persisted results; it never silently reruns an uncertain tool operation. A bad
receipt, corrupt schema/cache/store or mismatched provenance fails the phase.

The hidden `research-literature` agent can use only:

- `literature_list_intents`: fixed report/index/budget snapshot, paginated.
- `literature_search`: existing intent ID and topK within server limits.
- `literature_read_paper`: approved paper ID and bounded chunk/page excerpts.
- `literature_run`: the only evidence-writing entry point; no task/path/force overrides.
- `literature_get_results`: validated current-run summaries, paginated.

All tools require an active service binding to the child session. Exploration
refreshes a changed index before execution; it cannot admit papers independently
of the selector. Repeated and concurrent calls share an execution promise; writers
sharing a KnowledgeStore are serialized within the server process. After a server
restart, workflow recovery validates persisted results instead of resuming an old
LLM conversation. Cancellation/timeout signals stop work at the next progress boundary;
an already pending extraction request may finish before cancellation is observed.
A cancelled operation remains failed for that binding, so retries cannot start a
second write operation. Do not run multiple server processes against the same store.

Cockpit displays DataAnalysis → LiteratureAgent → HypoPlanner, bounded progress,
cache hits and tool status/duration. Completion includes counts, gaps, readiness
and `session_tool`/`direct`. `ready_data_only` is a successful phase with no paper
support. Completion summaries are written to the existing stream log and recovered
from artifact metadata when reopening Cockpit. `/literature-session` opens the
child session during execution or after its result has been registered; it is also a child of the root
research session. No PDF body or raw tool JSON is copied into the root session.

The `research.agent.literature.started/completed/failed` events use the existing
Research stage envelope (`taskID`, `agent`, `stage`, `status`, `metadata`). Completed
metadata includes run/artifact IDs, readiness, counts, callPath and child sessionID.
`research.agent.literature.progress` carries `runID`, `step`, optional `paperID`,
status, counts and cache status. `.stream.delta` and `.part.updated` use the existing
Research streaming envelopes. Legacy RetrieveAgent events remain available.

Internal extraction/verification LLM calls remain inside `literature_run`; they
are represented by progress, not separate OpenCode tool parts. Optional
`literature_process_papers` and `literature_finalize` are intentionally deferred.
No database migration or artifact schema version change is required.
