# IntentAgent - TUI Fluid Rendering Scheme

> Status: Proposal / Not achieved. This document only describes the design, and the code has not been changed.
>
> Pre-dependent: [intent-agent-tool-refactor.md](./intent-agent-tool-refactor.md) -
> IntentAgent is now running in a real, recoverable open session
> (`service.ts` functions `runIntentAgentTurn` / `runIntentAgent` /
> `continueIntentAgentSession`, call
> `read_taskspec`/`update_taskspec`/`ask_user`/`check_taskspec`
> Four tools. This document and
> [hypo-planner-tui-streaming.md](./hypo-planner-tui-streaming.md)
> It's the same infrastructure (`ResearchAgentPartUpdated` event + cockpit)
> `pushHypoPartLines()` General Renderer) , the latter**has been achieved and is in use**
> (DataAnalysis / HypoPlanner / Reflection three delegates are on board)
> This proposal is to make IntentAgent the fourth.

## 1. Objective

1. Every tool call in IntentAgent session (`read_taskspec`/
   Text of `update_taskspec`/ `ask_user`/ `check_taskspec` and model
   Reply, all scroll to streamLine in real time like HypoPlanner.
2. No more 15s at the start of `intent_gathering`/ waiting for user response
   The full checklist of the slot -- this information is now used as an observation tool
   Call log (especially `read_taskspec` output, `ask_user` input)
   It's natural. No need for Tui to draw another one of his own.

## 2. Status Inventory

### 2.1 Existing General Infrastructure (HypoPlanner validated available)

- `research/event.ts` already has `ResearchAgentPartUpdated` schema and
  `HypoPlannerAgentPartUpdated` / `DataAnalysisAgentPartUpdated` /
  `ReflectionAgentPartUpdated` Three Events
- `research-cockpit.tsx`:
  - Each agent has a pair of signals `xxxPartMap`/`xxxPartOrder`
    (e. g. `hypoPartMap`/ `hypoPartOrder`, approximately 1208-1209 row)
  - Universal Rendering Function `pushHypoPartLines()` (4134-4176 Line) - Namebelt
    "Hypo," but it's completely universal, receiving.
    `(lines, order, map, streamID, done)`,DataAnalysis/Reflection
    4219, 4320 and IntentAgent can also be used directly.
    No new rendering function needed to be written
  - Event subscription switch (approximately 1617-1758 row): Received
    On `*.started`, clear `xxxPartMap`/`xxxPartOrder` and mark the stream
    `done:false`; Write part of the photo when `*.part.updated` is received
    map+order; on `*.completed`/`*.failed`, set `done:true`

### 2.2 IntentAgent, what's missing on this side?

- `service.ts`'s `runIntentAgentTurn` (lines 6548-6581) **directly constructs
  `sessionPrompt.prompt()`**, not go
  `requestViaSession()`.
  `requestViaSession` does not support capacity. So it's not.
  `requestViaSession`, the set of `onDelta`/`onPartUpdated`
  `Effect.scoped` + `bus.subscribe(MessageV2.Event.PartUpdated)`
  Logic of subscriptions - this part needs to be reproduced inside `runIntentAgentTurn`
  (Logical copy of `requestViaSession` in hypo-planner document)
  Section 2)
- `event.ts` not yet `IntentAgentPartUpdated`
  `IntentAgentStarted`/`Completed`/`Failed`/`AwaitingUser`)
- `runIntentAgent()` (6622 row) is currently being `runFullPipeline()`
  Calles are subject to a "satisfaction and skipping session" judgment.
  intent-agent-tool-refactor.md achieves record) -** Only
  `!alreadySatisfied` will run real only when `runIntentAgentTurn`** is satisfied
  There won't be any part incident in this situation. It's an expected act.
  I'm gonna show you an empty stream once and for all.
- `continueIntentAgentSession()` (6694 row starting to receive each user response/
  Free Text Change** No Started/PartUpdated/ currently published at all
  Completed Event** — This is the most critical part of this proposal because after the user answers
  Every round of questioning, it's the moment that TUI needs to see what the model is doing.
- `clarification.active` in cockpit.tsx is the rendering branch of real time
  (4378-4396 Line) This is the whole paragraph of slot checklist + "Next question";
  That's the part of this proposal that needs to be replaced.

## 3. Programme

### 3.1 `event.ts`: Add `IntentAgentPartUpdated`

Re-enact existing `ResearchAgentPartUpdated` schema, copy
`HypoPlannerAgentPartUpdated` definition:

```ts
IntentAgentPartUpdated: BusEvent.define("research.agent.intent.part.updated", ResearchAgentPartUpdated),
```

Text reply normal without adding a separate `IntentAgentStreamDelta` - IntentAgent
Short. Tool call is the main amount of information, with part events.
Just go. There's no need to add another text. Delta.
Its text response is itself one of the main outputs; IntentAgent is not. If there's any follow-up,
The word-flow effect also needs to be supplemented with `IntentAgentStreamDelta`, which is not in this range.

### 3.2 `service.ts`: `runIntentAgentTurn` Inline Subscription + Callback

In `runIntentAgentTurn` (row of 6548) Riga `onPartUpdated` echo parameters,
`requestViaSession` (3172-3234 Line)
`Effect.scoped` + `bus.subscribe(MessageV2.Event.PartUpdated)`:

```ts
const runIntentAgentTurn = Effect.fn("Research.runIntentAgentTurn")(function* (input: {
  readonly task: ResearchTask
  readonly userMessage: string
  readonly modelRef: NeoResearchModelRef | undefined
  readonly onPartUpdated?: (part: MessageV2.Part) => Effect.Effect<void>
}) {
  if (!input.task.sessionID || !input.modelRef) return undefined
  const existingSessionID = yield* findIntentAgentSessionID(input.task)
  const sessionID = existingSessionID ?? (yield* session.create({ ... })).id
  const promptEffect = sessionPrompt.prompt({ sessionID, agent: "research-intent-agent", model: ..., parts: [...] })
  const result = input.onPartUpdated
    ? yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            bus.subscribe(MessageV2.Event.PartUpdated).pipe(
              Stream.filter((e) => e.properties.sessionID === sessionID),
              Stream.runForEach((e) => input.onPartUpdated!(e.properties.part as MessageV2.Part)),
            ),
          )
          return yield* promptEffect
        }),
      )
    : yield* promptEffect.pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  // The rest of the checkOk extractions remain the same.
})
```

> Note: Failed to use existing code for `promptEffect`
> `.pipe(Effect.catchCause(() => Effect.succeed(undefined)))` underground;
> `Effect.scoped` and then this catch needs to wrap the entire scoped block instead of
> Only pack `promptEffect` yourself, or error during subscription will be thrown out by scoped,
> It's not going to be caught on this level -- it's written by `requestViaSession`, actually.
> How to deal with this layer (it unites `.pipe(Effect.catchCause(...))` at the outermost level).
> It's not a separate package. Just copy it.

### 3.3 `service.ts`: Location of release event - boundary by "wholly session"

> Decision making (confirmed with user): `started` / `completed` particle size as a whole**
> The session** count, not "every turn". It's the same intent of the task
> Gathering from the first `runIntentAgent()` run to the end
> Until `check_taskspec` is successful, TUI is**the same log that continues to accumulate**,
> Every time an intermediate user submits a reply, triggers a new `runIntentAgentTurn`,
> Continue to be added after the same paragraph of the log, which is unclear and does not reopen.

Specific to code:

- `IntentAgentStarted` will be distributed only once in `runIntentAgent()`** (already available)
  The logical change -- the moment the entire intent_gathering phase begins.
- `continueIntentAgentSession()` (user triggers per answer)**not issued**
  `IntentAgentStarted`, send only `onPartUpdated` to return the part of the new round
  Events continue to add the same `intentPartMap`/`intentPartOrder`
- `IntentAgentCompleted` only takes place when it's really "intent gathering the whole."
  that is, where `runFullPipeline()` checks `missingFields.length === 0`
  `runIntentAgent`/`continueIntentAgentSession`
  The moment `check_taskspec` finally made it work, not every time.
  `runIntentAgentTurn` calls and sends. In the middle, if the model is just transferred...
  `ask_user` pauses the user,**does not send** `Completed` nor does `Failed` --
  These two incidents now only mean "end of whole period" (normal end/abnormal end), not
  "This is the end of the round."
- cockpit.tsx only empty once on receipt of `IntentAgentStarted`
  `intentPartMap`/`intentPartOrder`
  Intent gathering process, for example, the same mission may be reset by subsequent rejection.
  Triggers a completely new round of intent_gathering, before it needs to be emptied; Copy that.
  `part.updated` only adds and is not clear; Copy that. `Completed`/`Failed`.
  `done` to `true` so that the streamLine Renderer knows "no more loads will be shown
  The ellipsis is omitted."

### 3.4 cockpit.tsx: signal + subscription + rendering

Follow the HypoPlanner implementation exactly (section 4 of hypo-planner-tui-streaming.md
Section), prefix replaced by `intent`:

```ts
const [intentStream, setIntentStream] = createSignal<{ id: number; taskID?: string; done: boolean } | undefined>()
const [intentPartMap, setIntentPartMap] = createSignal<Map<string, HypoPartEntry>>(new Map())
const [intentPartOrder, setIntentPartOrder] = createSignal<string[]>([])
```

Event switch Riga 3 case(`research.agent.intent.started`/
`research.agent.intent.part.updated` / `research.agent.intent.completed`
and `...failed`), reuse `pushHypoPartLines()` on rendering, no new writing required
Rendering component.

### Rendering branch of 3.5 replacement

4378-4396 Line (`clarification.active & ) in `streamLines` memo
clarification.reviewMode ' branch) is currently:

```
Soctic identification: slots: <missing slot id list>
Next question:
15 checklist
```

was replaced by:

```ts
} else if (clarification.active && !clarification.reviewMode) {
  // Do not show the whole slot checklist;Show IntentAgent session real time
  // Tool Call / Text Stream (same as HypoPlanner), user from ask_user
  // The tool calls to see specific issues in the log.
  const istream = intentStream()
  if (istream && (!task || !istream.taskID || istream.taskID === task.id)) {
    persistentLines.push({ id: `intent-stream-${istream.id}-header`, text: "[IntentAgent]", tone: "muted" })
    pushHypoPartLines(persistentLines, intentPartOrder(), intentPartMap(), istream.id, istream.done)
  }
  // Keep a line "Current problem" as an explicit reminder, with the data source unchanged (ask_user library)
  // Accursed by buildSocraticClarificationState
  if (clarification.nextQuestion) {
    persistentLines.push({
      id: "socratic-next-question",
      text: `Next question: ${clarification.nextQuestion}`,
      tone: "primary",
    })
  }
}
```

**Retain the line "Next question"**: even with a complete tool to call the log, users
And you need a hint of what to answer now that you can see without going up the log.
data source (`socraticClarification()` → `buildSocraticClarificationState`
`ask_user` approximation)
No more slot checkslist.

**No movement** (as described by the user this time, the range is only for "to show the whole at first display")
This point of slots is not covered by the following two, which are discussed separately if necessary:

- `clarification.reviewMode` Branch (4365-4377 Line, incent after rejected
  Manually modified interface) - This is a case-by-case view of the user's voluntary request to check/modify and present complete
  Checklist is the centerpiece of this scene. It's not supposed to go away.
- `idle`, no running onboarding hint (line 4415-4431) - this is the task still
  No real access to intent_gathering, no user's guidance when it starts answering.
  This proposal does not concern "a different state of affairs" when asked.

### Whether 3.6 should be particularly highlighted in part logs for `ask_user`

`pushHypoPartLines()` Now render all tools equally.
`[icon] toolName → input ← output`. The input of the `ask_user` tool is
`{questions: [...]}` as part of the log will be cut off by JSON
(`JSON.stringify(...).slice(0, 120)`), readability general. Recommendations:

- Not in `pushHypoPartLines()` Riga `ask_user` Special (maintain this function)
  Universal, shared with the other three parties)
- Continue to rely on the line "Next question" reserved for 3.5 -- it's from
  The full problem text from the original is not affected by the 120 character cut-off.
  It's already solved the problem of "discovery in the log."

## 4. Order of implementation

| Steps | Documentation | Workload |
|---|---|---|
| 1. `event.ts` Add `IntentAgentPartUpdated` | `research/event.ts` | Small |
| 2. `runIntentAgentTurn` plus `onPartUpdated` Parameters + coded subscription | `research/service.ts` | Small |
| 3. `runIntentAgent()` transfer callback, forward to Bus | `research/service.ts` | Small |
| 4. `continueIntentAgentSession()` Into `onPartUpdated` Echo (do not send Started/Completed, follow the same log) | `research/service.ts` | Small |
| 5. cockpit.tsx plus `intentStream`/ `intentPartMap`/ `intentPartOrder` signal + event subscription case | `research-cockpit.tsx` | Small |
| 6. cockpit.tsx Replaces the 4378-4396 line rendering branch | `research-cockpit.tsx` | Small |
| 7. Test: mock `IntentAgentPartUpdated` event sequence, confirming streamLines output; Returns examples of `research-cockpit-data.test.ts` associated with `buildSocraticClarificationState` (data layer unchanged and should not be affected) | `test/` | Small |

## 5. Issues of openness

- ~ `done` Press turn or press session ~ Confirmed: press whole session (see
  Section 3.3.

- ** Add (session-only exposure problem): TUI signal is a pure frontend memory
  Status, does not last.** Short life cycle for individual logs, user
  It's not too much to lose if you cut in the middle of it. Replace by press the session cumulative, once
  Intent gathering may take several rounds and last long.
  If the user cuts to another task during this period, then cuts back or refreshs/reopens
  Cockpit, `intentPartMap`/`intentPartOrder` will be reset to
  Empty. I can't see a few rounds of phone calls before, just the next time.
  `part.updated` has something new, and it's like, "Put the session on a cumulative basis."
  The original intent was contradictory.
  - Requires a decision: Active if the cockpit **mount/ switch to a task**
    Rebuild `intentPartMap`/
    `intentPartOrder` (with `session.messages({sessionID})` to complete)
    History, find out where tool parts replay) instead of relying on "real time."
    Incident flow."This part is currently not done by three parties.
    Every call is very short, without the problem) IntentAgent Introduction to Press Session
    After "accumulation" is a unique new demand for this proposal, which requires a separate assessment of the cost of realization.
  - If there is no historical reconstruction for the time being, at least this limitation should be accepted at the document/product level:
    After refreshing/toggle the question, you can only see what's coming next. You can't see.
    That's what you need to know.
