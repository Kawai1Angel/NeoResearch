# IntentAgent Tool Reconfiguration Scheme

> Status: Proposal / Not achieved. This document only describes the design, and the code has not been changed.

## 1. Background

`IntentAgent` is currently a full**pure function batch** without going through the Agent/Session/Tool frame:

- `src/research/agents/intent-agent.ts` Export
  `analyzeIntentTask` / `analyzeIntentTaskWithLLM` /
  `parseSlotInputsWithLLM` / `interpretSlotModificationWithLLM`
  Four functions, all normal TS (sync or based on `requestNeoCastLLM()` directly)
  HTTP) does not use `Effect.gen`, does not create session and has no tool definition.
- Call points in `service.ts`:
  - `runIntentAgent()` (approximately service.ts:6503-6534): Job entry
    Run `analyzeIntentTaskWithLLM()` once while `intent_gathering` is in status.
    `clarifyingQuestions` is written as a `kind: "protocol"`
    `ResearchApproval` (reason Reese `"- question1\n- question2..."`)
    text list).
  - `answerIntentQuestion()` (approximately 6555-6645): Submitted by user
    After `{ slots: {...} }`, call `parseSlotInputsWithLLM()` to put the original text
    Coarse particle size converted to a type value, then called `updateTaskSpec()`, and then
    `analyzeIntentTask()` recalculates the missing field and decides whether to ask again.
  - `interpretAndApplySlotModification()` (approximately 6650-6680): Free Text
    `interpretSlotModificationWithLLM()`.
    `updateTaskSpec()`.
- TUI(`research-cockpit.tsx`/ `research-cockpit-data.ts`) pass
  `buildSocraticClarificationState()` Inverse Resolution from Approval Text**
  Problem list and slot map (`slotFromSocraticQuestion()`), fragile
  - The problem has changed, and the TUI analysis could be lost.
- Control group: `research-hypo-planner`/ `research-reflection`/
  `research-data-analysis` runs through `Agent.Service`+session
  True, ant, can rotate in one session with tools.
  (`requestViaSession()`, service.ts about 6844-6912).

**Question**
1. IntentAgent is not a "read, ask, hear, read, read, judge" loop.
   `analyzeIntentTask` reruns the whole section every time a user answers.
   LLM does not have the opportunity to continuously operate taskSpec in one session and ask questions.
2. LLM does not see the dataset analysis source (current slot extraction only)
   `task.taskSpec`/ `objective`/ `budget`, not read
   `analyzeDataset()` output profile) so it is not possible to use "first analyze datasets"
   Driving intent collection.
3. TUI gets the list of questions by decrypting an application text, it's a hidden protocol.
   There should be a more structured way of presenting "questions to ask".
4. There's no obvious "information enough to get to the Checkpoint" point -- right now.
   `missingFields.length === 0` this hard-coding rule, not LLM self-judgment.

## 1.1 Scope Statement

This proposal** covers only the toolization of phase `intent_gathering`**. Companion Mode
The remaining stages listed in `humanCheckpointPhases`
(`data_analysis_done` / `search_space_confirmed` /
`experiment_budget_extended` / `final_model_selection` /
`report_release`, intent-agent.ts:85-91 is not within the scope of this change.
Continue to operate in accordance with existing mechanisms and without prejudice.

## 2. Objective

Change IntentAgent to a **real session-based anent**, running on
Within the framework of Agent/Tool, circular execution:

```
1. LLM analysis of uploaded datasets (images following AnalyzeDatasetTool output)
2. LLM call ReadTaskspec to read the current taskSpec/ collected slots
3. LLM judge which slots are missing and generate clarification questions (can be asked more than one time)
4. Tools/runtimes to present problems to users and block waiting for user input
5. After the user answered, LLM made an understanding and called UpdateTaskspec to write back taskSpec
6. LLM calling ReadTaskspec again to confirm status.
7. Go back to 3 until LLM judges it's enough
8. LLM Call CheckTaskspec to Checkpoint
```

It's a multi-wheel human-in-the-loop cycle** with the participation of people.
`research-hypo-planner`, "More tools until output."
The difference is that:**the middle must really suspend waiting for user input**, not once
The session turn fake continues. This is the largest engineering difficulty of this programme (see section 7).

## 3. Inventory of existing infrastructure

| Capacity | Status | Is it enough? |
|---|---|---|
| Tool Definition Mode | `Tool.define(id, Effect.gen(...))`, see
  `tool/research-hypothesis.ts` / `tool/research-context.ts` | ✓ Reuse directly |
| Session Multiwheeling Tool Call | `requestViaSession()`(service.ts ~6844-6912):
  Create child session, `sessionPrompt.prompt()`, subscription
  `MessageV2.Event.PartUpdated` Fluid Tool Execution | Yeah, but it's right now.
  **There's no timeout for users.** |
| Agent Definition + Permissions | `agent.ts` `Agent.Info`, click angent name configuration
  `permission` allowlist determines visible tools | ✓ Reuse directly |
| taskSpec Read/Write | `updateTaskSpec()` (service.ts 3378-3402, go
  `UpdateTaskSpecInput`);slot extract
  `collectedIntentSlots()` (intent-agent.ts:173) | ✓ Reusable; requires
  Pack a layer tool |
| Dataset portrait | `AnalyzeDatasetTool`(`tool/research-data-analysis.ts`)
  Read `analyzeDataset()` project description | IntentAgent.
  Could not initialise Bonobo |
| Ask the user + wait to answer | Approval mechanism (`ResearchApproval`,
  Kind: "protocol" + TUI text resolution | It's written now.
  Text, TUI Insoluble. Need to be structured. |
| "Checkpoint" concept | `humanCheckpointPhases` List +
  `ResearchCheckpointAutoApproved` Event +`ResearchApproval` Status Machine
  (pending/approved/rejected) | ✓ Concept already exists; the CheckTaskspec tool
  It's just a visible trigger. |

## 4. Four new tool designs

New file `src/tool/research-taskspec.ts`, follow
Writing for `tool/research-hypothesis.ts` (`Tool.define`+ share store)
module, avoid loop dependence. Except for `ReadTaskspec`/ `UpdateTaskspec`
/ `CheckTaskspec`, add a new `AskUser` (see 7.1 section for decision-making) to be used as visible
"Pause waiting for user input" signal.

### 4.1 `ReadTaskspec`

- Parameter: None (or optional `{ includeRawTaskSpec?: boolean }`)
- Conduct:
  - Get `taskID` through `resolveTaskIDBySessionID(ctx.sessionID)`.
  - Call the existing `collectedIntentSlots(task)` logic (need to be from
    intent-agent.ts Export, currently a private function in the module)
  - **New**: consolidation of image summaries of uploaded data sets (if they exist) to allow LLM in the first round
    Inspect schema, column names, and missingness to help infer
    `target_columns`/ `time_grain`/ `data_source` et al. slot
- Return:
  ```ts
  {
    taskID, interactionMode,
    slots: Record<SlotID, { value: unknown; missing: boolean; required: boolean }>,
    missingRequiredSlots: SlotID[],
    datasetProfileSummary?: string,  // If you've run past AnalyzeDatasetTool
  }
  ```
- Read only, no incidents.

### 4.2 `UpdateTaskspec`

- Parameter: `{ updates: Partial<Record<SlotID, unknown>> }`
  (Keyname follows 16 and snake_case slot id, reuses existing
  `normalizeIntentSlotKeys` for aliases)
- Conduct:
  - Map `updates` back to the true path of taskSpec (`metadata.intentSlots.xxx`)
    `data_source`/ `target_columns` extra double-written `dataset.path`/
    `dataset.targetCols`, see Amended Conclusion of 7.3), achieved as new
    `applySlotUpdates(taskID, updates)` auxiliary function
  - Recheck merged with `DomainRegistry.createTaskSpec()` before writing
    taskSpec (domain schema is `.strict()`, as detailed in section 7.3), verification failed
    Returns an error text to LLM without breaking the entire session
  - **don't** do "free text understanding" -- this step should be done by LLM itself before the tool is called.
    (i.e. LLM directly constructs a structured `updates` call tool after reading the user's answer,
    Instead of passing the original text on to the tool and running it again. That means...
    `parseSlotInputsWithLLM` / `interpretSlotModificationWithLLM`
    The functions of these two "sneaking LLM" inside the tool can **be retired as a whole** because of the outer layer
    The session itself is LLM, and the ability to understand is already in the prompt cycle.
- Return: Updated `slots` snapshot (same as `ReadTaskspec` field)
  LLM does not need to be followed by `ReadTaskspec` (but prompt should still guide)
  LLM calls `ReadTaskspec` for independent confirmation according to the user's original requirements.

### 4.3 `CheckTaskspec`

- Parameter: `{ confidence: number; rationale: string }`
  (LLM self-assessment information completeness + short justification for audit/dissemination)
- Conduct:
  - Verify whether `missingRequiredSlots` is really empty (preventing LLM miscalculation)
    Enter checkpoint -**service-end double verification, not fully trusted LLM self-reporting**)
  - If verified: **Directly reuse existing trigger logic**, no new status machine - call
    `runFullPipeline({ taskID })` (service.ts:6631-6638 current call)
    Method) with internal `ensureIntentCheckpoint()` (service.ts:3877)
    Take the path already in place: create/ parse `ResearchApproval(kind: "protocol")`,
    If `pending` is still the task state is set to `"paused"` and
    `throw PipelineBlockedError` (service.ts:7845-7863, this behaviour is correct
    Socratic / Companion is the same, both of which require manual confirmation before entering.
    `data_analysis`); If it's approved, follow the current logic.
    `"intent_gathering"` write to `completedPhases`, advance to
    `data_analysis`(service.ts:7865-7872).`CheckTaskspec` tool
    It does not introduce new events or state transformations, it simply puts "slots sufficient" to judge.
    Hand it over to LLM, and then the current status quo will be fully applied after the trigger.
  - If validation is not possible: return error + list of fields still missing,**no** call
    `runFullPipeline()`, lead LLM back to `ReadTaskspec` and keep asking questions
- Return: `{ ok: boolean; missingRequiredSlots: SlotID[]; checkpointID?: string }`

### 4.4 `AskUser`

- Parameter: `{ questions: string[] }`
- Behaviour: Do not call LLM, do not read and write taskSpec; Original text of the question (repeated)
  `ResearchApproval(kind: "protocol")`, list of direct questions)
  and publish `IntentAgentAwaitingUser` events
- Return: `{ acknowledged: true }` (only one end for the model's tool call)
- This is the only legitimate signal of this cycle to suspend, as detailed in section 7.1

### 4.5 Share Implementation Details

Reuse `hypothesis-store.ts` mode, add
`src/research/taskspec-store.ts`:

| Functions | Annotations |
|---|---|
| `resolveTaskIDBySessionID` | Exists in `hypothesis-store.ts`. Directly reused, no need to duplicate |
| `readTaskspecSlots(taskID)` | Packaging `collectedIntentSlots`+ image consolidation of data sets |
| `applySlotUpdates(taskID, updates)` | Mapping the slot taskSpec path, calling `updateTaskSpec()` |
| `checkTaskspecReadiness(taskID)` | Service Validation + Trigger checkpoint |

## 5. Agent / Session Adaptation

### 5.1 New agent: `research-intent-agent`

Add in `agent.ts` to the template of `research-hypo-planner`:

```ts
"research-intent-agent": {
  mode: "subagent",
  prompt: PROMPT_RESEARCH_INTENT_AGENT,  // New file prompt/research-intent-agent.txt
  permission: {
    "read_taskspec": "allow",
    "update_taskspec": "allow",
    "check_taskspec": "allow",
    "ask_user": "allow",
    "analyze_dataset": "allow",   // Reuse a ready-made dataset analysis tool
    "*": "deny",
  },
}
```

### 5.2 Session Execution Must Change

`requestViaSession()` status quo is " Feed a prompt, the model runs itself till it's no longer called."
So far as the tool is concerned, get the final text" — this suits hypo-planner (without user intervention).
IntentAgent needs a multi-round, interrupable dialogue:

- Option A (recommended):** Map a user question and answer into a new session
  Turn "**, session itself remains alive between multiple HTTP requests (already)
  Session concept supports cross-request reuse, cf. `answerIntentQuestion` current
  It is also requested to cross HTTP. Namely:
  1. First time into `intent_gathering`: open a session,
     `sessionPrompt.prompt()` Run to model call `ReadTaskspec`
     Call `AskUser({ questions: [...] })` after the status quo.
  2. service.ts observed in part-update echoes that `AskUser` has been called.
     Considers the current round "Hand up" and shows `questions` to users (see decision in 7.1 section)
  3. Add a user to service.ts for the same session**
     Message ("User Answer:..."), again `sessionPrompt.prompt()`
  4. Model this rotation with `UpdateTaskspec`, `ReadTaskspec` to produce a new batch
     Problem or Call `CheckTaskspec`
  5. Repeat 3-4 until model calls `CheckTaskspec` are successful

  This is different from the nature of the status quo: each user's answer is a completely new call to no state.
  Pure function** (`analyzeIntentTask`), new scheme is **same session continuing
  History of cumulative dialogue**, models can remember what they asked and why.

- Option B (not recommended): open a new session every time, put "collected slots +"
  History Questions and Answers "plug the whole section into prompt to start over. I could work, but lost the model myself.
  "to decide on the continuity of the questioning strategy" and token is more expensive to re-establish the context for each round.
  "LLM with user demand, confirm again with ReadTaskspec" design.
  Externalize in the taskspec, read with tools instead of talking history) more closely --
  **In fact, option B might be more in line with the user's description of "Each round is confirmed by ReadTaskspec"**,
  Because if the session itself remembers everything, "Read it again."
  The meaning of this move is reduced to "dual confirmation" rather than "restoration".

  Recommendation:**Together** — the same session continues to exist (reserve continuity of dialogue,
  But the prompt forced "every time it is decided to ask a question or stop, and every time it's done, it's not possible to explain the background again."
  We have to call ReadTaskspec to re-establish the state of the art without relying on the memory of the conversation.
  slot value (because `UpdateTaskspec` may be another channel - e. g. user in TUI
  Directly edits - the conversation memory will expire by bypassing current session changes.

### 5.3: How does "more questions at a time" appear?

- By the new `AskUser({ questions: string[] })` tool (see 4.4)
  Section, section 7.1) with multiple questions on one call up to the prompt layer
  Binding.
- service.ts Drops `questions` in `AskUser.execute()` (reused)
  Existing `ResearchApproval` structure, reason field directly saving original JSON/
  Text List) no longer need TUI to "Reverse Resolution slotFromSocraticQuestion"
  - one-time match of this weak string.
- TUI Change: `buildSocraticClarificationState()` Simplified to Show
  Original list of questions for `AskUser` library ", whole paragraph entered by user as new user
  Message return session, slot id no longer required front-end guess.

## 6. Prompt Design Elements (`research-intent-agent.txt`)

- Write clearly the 8 step cycle of section 2 of this program
- Emphasis: "Don't pretend slot values; Unable to draw images from the data set or existing
  taskSpec extrapolated fields must be accessed by asking questions."
- Emphasis: "Each question/judgement must be called before it is sufficient
  ReadTaskspec, do not rely on the old state of your memory."
- Gives problem-number captips for both modes (repeat existing)
  `maxQuestionsPerTurn` as a hard-barrel case in the prompt.
  It's not the code layer that forces a break -- it's the cut-off logic in `buildResult()` now.
  What level to move to in the future will need to be decided, see 7.4 opening question)
- Specify CheckTaskspec call premise: "Only when ReadTaskspec returns
  missingRequiredSlots is available only when you're empty."

## 7. Main risks and openness issues

### 7.1 "Suspend waiting for user input" - A new visible `AskUser` tool has been decided

> Decision-making (recognised with users): adoption of visible tool programmes, not "no tools call" considered
> Question's hidden signal.

Add a fourth tool, `AskUser`, as part of this programme toolkit:

- Parameter: `{ questions: string[] }` (more than one question can be asked at a time, the maximum number is given)
  protocol layer, cf. section 6)
- Behaviour: **Do not call LLM, do not read and write taskSpec**, only put `questions` in library
  (Repeat existing `ResearchApproval(kind: "protocol")` or similar structures,
  Reason directly saves the original text, no more TUI inverse resolution) and releases one
  Events (e. g. `IntentAgentAwaitingUser`)
- Keypoint: service.ts in Part-update of `requestViaSession()`
  In,** as soon as `AskUser` is observed,** this round will be determined immediately.
  Hang up without waiting for the final text of the model output -- it can be implemented after `AskUser`
  explicitly end this prompt turn (or let the model finish after calling `AskUser`,
  service.ts only marks, both of which tend to end with a simple sentence.
  Do not force break models to turn)
- So the pause becomes a visible "move to AskUser" suspension, waiting for the next time.
  HTTP requests to add the user's answer as a new message.
  Calling ReadTaskspec leads to miscalculation's ambiguity - as long as AskUser is not called,
  No matter how many other tools the model calls or says, it will not be treated as "waiting user".
- The prompt layer needs to be clearly stated:** The only person who can get a user to see the question, pause for an answer
  By calling AskUser**; If it's just the text that says, "I have a few questions,"
  Call the tool, questions will not be shown to users, session will continue to run down (possibly)
  The model was forced to call ReadTaskspec/UpdateTaskspec without an answer.
  It needs to be stressed over and over again in the prompt, so we don't need a model.
  The tool's common LLM error.
- Each agent toolkit has been transformed into four accordingly: `ReadTaskspec`/ `UpdateTaskspec`
  / `CheckTaskspec`/ `AskUser`, description of 4, 5.3, 9
  It needs to be updated simultaneously (see revision below).

### Aligning 7.2 Session Life Cycle with Existing Task Status Machine

- Researched and confirmed (`session/session.ts`, `session/session.sql.ts`):
  The session lasted in SQLite (`SessionTable` / `MessageTable` / `PartTable`).
  (a) Not only live in the memory of the process, but re-launch it without loss;`ResearchTask` already exists
  `session_id` column (`research.sql.ts`), `taskID → task.sessionID`
  A stable map exists (`getTask()`, service.ts:3272-3283).** Infrastructure
  Support for the "cross HTTP request to continue with a session"**.
- **This usage is currently without precedent in code**: current `requestViaSession()`
  (service.ts:3172-3234) Every call is "Building a whole new rootSessionID"
  Child session, protocol once and for all. There's never been an "retribution,"
  Add new user message, reprompt() this path without any test coverage
  it. `Session.Service` exposes `get`/`messages`/`updateMessage` plus
  `sessionPrompt.prompt({ sessionID, ... })` theoretically spell this process,
  But for the first time in this warehouse, it needs to be written as a new feature** at the stage of realization.
  Validation, not as a "direct call for ready-made capability".
- Details of confirmation/decisions still to be achieved:
  - How do you handle a session when the user fails to answer for a long time (overtime? Retention?)
  - Multiple simultaneous requests made to the same session (e.g. two times in a row "submit an answer")
    How to line up and avoid race condition writing dirty taskSpec

### The positive map of 7.3 `UpdateTaskspec` is more difficult to maintain than the reverse map - cleared, concluded: can be constricted into a single normative path

**Valided consumer range** (grep + code read, not guess):

- These scattered fields (`taskSpec.dataset.*`/ `contextLength`/
  `predictionLengths` / `taskSpec.intent.slots.*` /
  `taskSpec.metadata.intentSlots.*` et al.)** Almost only IntentAgent
  I'm writing for myself.`objective`/ `budget` was created as
  Two standalone penthouse columns (`research.sql.ts:34-35`) as they are for `ResearchTask`
  Written after only IntentAgent through `updateTaskSpec()`
  (service.ts:6624) Rewrite these paths.
- Read only 3 and read only a small part of each, without overlapping:
  - `data-analysis-agent.ts` (174-180 Row): Read
    `taskSpec.dataset`/ `taskSpec.runtime` for data set programing
    - This part is**real operations configuration**, not "copy of intent slots."
  - `hypo-planner-agent.ts` (180, 184 rows): Read
    `taskSpec.metadata` / `taskSpec.datasetProfile`(profiling
    Output, not intent slot)
  - `reflection-agent.ts` (267-268 Row): Read
    `taskSpec.profile`/`taskSpec.datasetProfile` (ibid.)
- `neo_cast/py/` Training Level Confirm**Do not read** `taskSpec` any path, read only
  Independent `current_candidate.json`/
  `resolved_candidate.json`, completely delinked from `taskSpec`.

**Conclusion**: Fragmentation is not "a real conflict caused by multiple system components and writing"
IntentAgent has changed its name style at different times in history (early proximity)
`neo_cast` candidate JSON field camelCase
`intent.slots.*` added an almost synonymous `metadata.intentSlots.*`.
`collectedIntentSlots()`'s long list of candidates is essentially for compatible databases.
Existing historical mission records are not compatible with the multiple actives of "now writing on an ongoing basis"
Write the party.

**So it can and should **preserve a single norm JSON naming space -** but at the realization stage found
A hard constraint not originally considered in this section, to take the target path from `taskSpec.intent.slots.*`.
Changed to `taskSpec.metadata.intentSlots.*`**:

> Amendment (realization phase found): domain taskSpec schemea (if
> `TSFTaskSpec` in `domains/tsf.ts`) is
> `z.object({...}).strict()`, only `metadata` on the top floor.
> Free Extension Field (`metadata: JsonObject.default({})`), add any other
> `.strict()` rejects top-level key (e.g. `intent`) which is not the only source of information that can be found in this video.
> `DomainRegistry.createTaskSpec()` throws ZodError directly. Which means...
> "A new top-level naming space" is not a viable option in itself -- Legacy code was selected that year.
> `metadata.intentSlots` is not a random name for history, but the only one that can escape.**
> The location of the `.strict()` verification. The conclusions were amended to read:

- `UpdateTaskspec` Tool only write `taskSpec.metadata.intentSlots.<slot_id>`
  (16 slots united away from other candidate paths) - That happens.
  Legacy Code is already in use, but now it's the only ** written target instead of
  One of the many candidates.
- Exception: `data_source` / `target_columns` both slots have a "double identity"
  — `data-analysis-agent.ts` really reads `taskSpec.dataset.path`/
  `taskSpec.dataset.targetCols` as actual input for profiling, therefore
  `UpdateTaskspec` needs to write both slots**and** sync to
  `taskSpec.dataset.path` / `taskSpec.dataset.targetCols`,
  And not just `metadata.intentSlots.*`.
- `ReadTaskspec` Read only `metadata.intentSlots.*` for new jobs (+ the two above)
  The `dataset.*` sync value of the slot is checked for consistency;`collectedIntentSlots()`
  The long list of old candidate chains (`taskSpec.forecastObject`/
  `taskSpec.contextLength` flat field) down to **only for historical tasks**
  Fallback, to be deleted as a whole after the inventory task has been cleared
- Steps for relocation:
  1. When `applySlotUpdates()` is achieved, write only the norm path (+) according to the above rule
     `data_source`/ `target_columns`
  2. `readTaskspecSlots()` gives priority to the standard path, which is not read until it falls back.
     `firstKnown()` candidate chain (ensure stock assignments are not misreported/data is not lost)
  3. No extra "data migration script" is required - the old mission continues to be readable by a fallback chain.
     New task/ Any time written by `UpdateTaskspec` is converted to a regular path

### 7.4 Whether to Retain Question-count Truncation and Confidence Calculation

`confidenceFor()`/ `maxQuestionsPerTurn` from `buildResult()`
Interception is the rule of certainty, and if LLM decides for itself whether "information is sufficient"
The role of this rule becomes that of a user's demand for "LLM to judge whether the information is sufficient"
What? Recommendations:
- `confidenceFor()` such hard coding** retained as `CheckTaskspec`**
  One of the grounds for the service's secondary verification (i.e. "not fully trusted LLM self-reporting" referred to in 7.# section) is that it is not possible to verify this information.
  To prevent LLM from judging "Enough" prematurely or wrongly.
- `maxQuestionsPerTurn` cut-off moved from the code layer to the prompt layer (i.e. section 6),
  Because now the problem is no longer "Uniform Walking buildResult Function Generation" but a model.
  Free to generate text, code layers are no longer good at cutting off "N" before we take it.

### Old 7.5 path (`runIntentAgent`/ `answerIntentQuestion`/
Whether `interpretAndApplySlotModification` is to be retained as fallback

Reference to `hypothesis-pool-tools.md` precedent (full replacement path reserved)
FALLback) recommends that:
- **Not recommended for long-term twin tracks**: because the core value of IntentAgent is "continuing dialogue"
  + Tool-driven state. Two tracks will lead to TUI having two sets of protocols at once.
  (approval text insolves vs session stream), complexity enhancement is not cost-effective
- It is suggested to switch directly, but retain one feature flag (similar to existing)
  `NEO_RESEARCH_INTENT_LLM` environment variable mode) used for rollback, after grey period
  Delete old function (`parseSlotInputsWithLLM`/ `interpretSlotModificationWithLLM`)
  / Pure function call in old `runIntentAgent`)

### 7.6 Test Impact

- The currently exported 4 functions of `intent-agent.ts` have direct single-detection overlay
  (required grep to confirm specific test files, preliminarily `test/research/`
  Corresponding documents need to be located and rewritten at the stage of achievement)
- Add:
  - `test/tool/research-taskspec.test.ts` (execute behavior of four tools)
  - `test/research/taskspec-store.test.ts` (positive map/ service-end verification)
  - Session Integration Test: Simulation Ask Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Questions Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Question Q Question Question Question Question Q Q Q Q Q Q Q Q Q Q Q Q Q Q Q Q Q          Q Q Q Q Q Q Q Q    Q Q  Q Q Q          Q Q Q     Q    Q                                       Q           Q Q Q Q Q Q Q Q                                     Q Q                                                Q                 Q Q   Q            Q Q Q Q Q Q Q Q
    CheckTaskspec trigger checkpoint 'full multi-wheel process (mock may be required)
    `sessionPrompt.prompt()` or already in `service.test.ts`
    hypo-planer session)
- TUI Test: `research-cockpit-data.test.ts`
  `buildSocraticClarificationState`-related examples need to follow a new protocol (original)
  Show instead of inverse) rewrite

## 8. Order of implementation of recommendations

1. ~ Confirming the open question of 7.1 ~ Confirmed: using a visible `AskUser` tool scheme
2. `src/research/taskspec-store.ts`:`readTaskspecSlots` /
   `applySlotUpdates` (inclusive of positive map)/`checkTaskspecReadiness`
3. Wait from `collectedIntentSlots`/ `slotDefinitions`
   `intent-agent.ts` Export (or whole migration into `taskspec-store.ts`)
   Reuse tools to avoid duplication
4. `src/tool/research-taskspec.ts`: 4 `Tool.define(...)`
   (`ReadTaskspec` / `UpdateTaskspec` / `CheckTaskspec` / `AskUser`)
5. New tool for `tool/registry.ts` registration
6. `agent.ts` Add `research-intent-agent`, Configure Mission
7. `src/agent/prompt/research-intent-agent.txt`
8. `service.ts`:
   - Change `runIntentAgent()`. Go `requestViaSession()`.
   - Add "Recovering Session and Add User Answers" to replace
     `answerIntentQuestion()` / `interpretAndApplySlotModification()`
   - Processing session suspension/restoration protracted
9. TUI: Simplify `buildSocraticClarificationState()`, remove reverse resolution
10. Test (Section 7.6)
11. Greyscale: Keep old path + feature flag for a period of time and remove after validation
    `parseSlotInputsWithLLM` / `interpretSlotModificationWithLLM`

## 9. Correlation to the original user description

| User Description | This programme corresponds to |
|---|---|
| LLM parsing uploaded data sets | Resume `AnalyzeDatasetTool`, authorize to `research-intent-agent` |
| View task information using ReadTaskspec | 4.1 Section |
| Confirm slots missing, multiple questions at a time | 4.1 section `missingRequiredSlots` + 4.4 section `AskUser` tool + 6 section prompt ratio |
| LLM is meant to understand and call UpdateTaskspec | Section 4.2; Also retired from `parseSlotInputsWithLLM`/`interpretSlotModificationWithLLM`, the old function of "remixing LLM within these two tools" |
| Confirm new information with ReadTaskspec | Prompt constraint for 5.2 section "compulsory readback per round" |
| LLM assesses completeness → CheckTaskspec → Checkpoint | Section 4.3: server-side revalidation and existing `ResearchApproval`/checkpoint events |
