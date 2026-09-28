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

Evidence validation v2 resolves section headings through the parsed document's
section table (or a numbered subsection heading present in the supporting chunk).
Extraction requests use the canonical `sectionID`. Whitespace-only quote drift
may be repaired by copying the literal substring from the source; the persisted
`exact_span` is that recovered substring, never the modified quote. Original
candidates and canonical locations remain in the run artifacts for comparison.
Wrong pages, unresolvable headings, changed words, and fabricated numbers still
fail validation. `--allow-normalized-evidence` additionally permits the existing
Unicode-normalized matching path; such evidence remains `normalized_span`.

The configured verifier retries a malformed response once with schema-error
feedback. It accepts an unused `correctedClaim: null` as an omitted optional
field, but never converts invalid directness values into semantic verdicts.
Persistent failures are recorded as `verification_error` and make the run
`partial`. Review reports distinguish quality rejections, verification errors,
and duplicate merges. Extraction/verification prompt versions and the evidence
validation version invalidate affected caches. Unknown sections permit all
requested card types so experimental settings can be classified as protocols.

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

### Mechanism quality and budgets (v3)

New mechanism candidates must carry `problem` and `mechanism` (`mechanismID`, `name`, `principle`, nonempty `components`). The semantic verifier must confirm correct card type, a supported complete operation, and the paper's own method. A quotation of an experimental setting or another paper's model cannot satisfy this gate. Normalization retains these fields. Legacy v1 cards remain readable; the task-evidence bridge requires complete fields and the v3 verifier for mechanism use. Re-extract from source to upgrade; never fill missing mechanisms from general knowledge.

Candidate arrays are validated item by item with one feedback repair. `extraction_attempts.jsonl` preserves raw attempts, `candidate_claims.jsonl` preserves all parsed candidates, and `card_validation.jsonl` records accepted card revisions and the validation rule. Adjacent chunks supply context; the current chunk must also support each candidate. Verification and deduplication precede the storage budget, which favors mechanisms while reserving diversity of card types and source pages. `selection_budget` is counted separately from quality rejection and verifier failure. Exact structured operations can merge; merely sharing a mechanism name does not justify merging.

Retrieval uses cached local PDF first-page previews (first two pages, up to 24,000 characters), with failures visible in screening reasons. Previews support recall only and cannot back knowledge-card evidence. Scientific phrase matching is complete, with explicit concept aliases; reading quotas follow scientific re-ranking and round-robin allocation across intents. Conformal/interval methods remain auxiliary for point objectives. This is deterministic screening, not an LLM semantic review. Task-evidence coverage for mechanism questions requires `supports_mechanism`; warnings and definitions may be useful entries without closing those gaps.

The live ETTh1 rerun exposed array-valued enum outputs copied from the verifier's contract examples. `evidence_verifier_v4` describes `verdict` and `evidenceDirectness` as scalar strings; invalid arrays are still rejected, never coerced into support. v3 and v4 share the same semantic quality rule, and both remain eligible after successful validation. A separate second review found that complete mechanism cards can still duplicate a parent operation or misclassify definitions/ablation variants. Card count must not be reported as the number of independent mechanisms; paper-level consolidation and hierarchy remain an open quality gap.
