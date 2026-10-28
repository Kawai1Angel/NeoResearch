# NeoResearch TSF structure alignment gap analysis

Generating date: 2026-04-28

## Contrast Object

- Latest design draft: `/path/to/design-documents/NeoResearch-TSF-v2.md`
- Current architecture draft: `/path/to/NeoResearch/neo_cast/neo_research_tsf_architecture.md`

## Overall judgement

The current `neo_research_tsf_architecture.md`, which is broadly consistent with the direction of `NeoResearch-TSF-v2.md`, already covers Time-Series Profiler, Modular Action Space, CandidateRecipe, Experimental closed loops, research memory, binding implementation and phase road maps.

The current architecture document, however, is more focused on **engineering analysis / autoresearch-style MVP**, while the most recent reflection paper places greater emphasis on **Action-Space-Based Auto Model Construction for Time-Series Forecasting**.

The problem with the current document is therefore not " wrong direction " , but rather several core research ideas have not been elevated to first-class modules:

1. The formalization of user research intentions is inadequate.
2. Action projectory does not form the core data structure.
3. Model Compiler's role is not prominent enough.
4. The meta-architecture innovation line is not clear enough.
5. Research baseline, oracle and Research Quality evaluation are incomplete.
6. Ultimately, research artific/report is not a core product interface.

A rough judgement can be made: the current structure is in line with recent thinking about **70%,** and the remaining 30% focuses mainly on "discussions" and "expression of research contributions".

---

## 1. Missing Requirement Formalizer/ ResearchIntent Layer

### The idea in the latest thinking.

The system input for the latest thought is not just a data set, but a complete database:

```yaml
dataset:
  path: ./data/electricity.csv
  target_cols: all

task:
  forecasting_type: multivariate
  lookback_length: 336
  horizon: 96
  metric:
    primary: MSE
    secondary: MAE

user_intent:
  objective: high accuracy with moderate latency
  preference:
    - lightweight model
    - interpretable variable interaction
    - robust long-horizon forecasting

constraints:
  max_experiments: 30
  max_params: 5M
  max_training_time_per_model: 30min
  max_latency: 20ms
```

The overall process also explicitly includes:

```text
User Intent + Dataset
        ↓
Requirement Formalizer
        ↓
Time-Series Profiler
```

### Status in the current architecture

The current structure starts with `TaskSpec`, `EvalSpec`, `BudgetSpec`, and `SearchSpaceSpec`, emphasizing protocol, budget, split and rating security. This is the correct project, but it does not model `user_intent`, natural language preferences, soft objects and search projects as separate layers.

The current human role consists of "setting research goals and an iterative direction", but mainly falls on `program.md`, which has not yet formed a structured `ResearchIntent`.

### Impact

Without Requirement Formalizer, the system would be more like an "Autonomous Experimental System for Fixed Tasks" rather than a AutoResearch agent capable of building models based on user research preferences.

It weakens the following sales points:

- Conversion of natural language research objectives to implementable search targets.
- The separation of hard subjects/soft objects/search priorities.
- The effect of user preferences on action space cropping and reward weights.

### Suggested addition

Add a new section to the current structure:

```text
Research Intent Layer
```

Recommended data structure:

```python
@dataclass
class ResearchIntent:
    raw_text: str
    objective: str
    hard_constraints: dict
    soft_preferences: list[str]
    search_priors: list[str]
    report_preferences: list[str]
```

And add in `TaskSpec`:

```python
research_intent: ResearchIntent
```

The output of Requirement Formalizer should include at least:

- `hard_constraints`: Arguments, delay, number of experiments, training time, visibility.
- `soft_objectives`: Lightweight, interpretable, stable, long horizon rod.
- `search_priors`:patch,invert embedding,feature fusion,decomposition,router,distillation.
- `reward_weights`: the weight of accuracy, latency, params, robustness, simplity.

---

## 2. Action Trackory does not become a first-class data structure

### The idea in the latest thinking.

The latest reflection clearly emphasizes that:

```text
Architecture A = a_1 ∘ a_2 ∘ ... ∘ a_T
```

Angent's output is not a model name, and it's not just a final recipe, but a control projectory:

```text
AddPreprocess(RevIN)
AddPreprocess(SeriesDecomposition)
SetEmbedding(PatchEmbedding)
SetBackbone(MLP)
SetFusion(TemporalFusion)
AddBranch(InvertEmbedding + Transformer)
AddFusion(GatedFusion)
SetHead(LinearHead)
SetLoss(HorizonWeightedMSE)
```

This is one of the core contributions of v2: transforming the format of V2 into a typed mobile action space-based regional regulation protocol.

### Status in the current architecture

The current structure already has `CandidateRecipe` and an action response, but mainly expresses the final state:

```text
preprocessing -> embedding -> backbone -> fusion -> head -> training_strategy
```

It has no prominent record of:

- Every step of action is what it is.
- What is an action's parent state?
- Why is action being raised?
- Action through compiler / Validat.
- What action has contributed to the final structure.

So it's more like "recide search" than "action-space control."

### Impact

The absence of an action projectory affects three things:

1. The paper was not very cutting-edge: it was difficult to stress the importance of the topic.
2. Rethinking that the closed circle is not sufficiently detailed: it is impossible to analyse which step action leads to gain or failure.
3. Report is not strong enough: cannot output complete action projectory and structure evolution.

### Suggested addition

Add data structure:

```python
@dataclass
class ArchitectureAction:
    action_id: str
    action_type: Literal[
        "add_module",
        "remove_module",
        "replace_module",
        "split_branch",
        "merge_branch",
        "change_fusion",
        "change_head",
        "change_loss",
        "change_training_protocol"
    ]
    target_path: str
    params: dict
    rationale: str
    expected_effect: str
    constraints_checked: list[str]

@dataclass
class ActionTrajectory:
    trajectory_id: str
    parent_recipe_id: str
    actions: list[ArchitectureAction]
    resulting_recipe_id: str
    hypothesis: str
```

And get `Proposal` from:

```python
candidate_recipe: CandidateRecipe
```

Expand to:

```python
action_trajectory: ActionTrajectory
candidate_recipe: CandidateRecipe
```

---

## 3. Model Compiler's role is not prominent enough

### The idea in the latest thinking.

v2 Place Model Compiler at its core:

```text
Model Recipe DSL
        ↓
Model Compiler
        ↓
Training / Evaluation Engine
```

Compiler is not just `build_model`, but also responsible for:

```text
1. Checks whether an action security is valid
2. Checks whether tensor Shape matches
3. Automatically adjust idden dimension
4. Automatically connect lanch input/output
5. Automatically process normalization/post-processing pairs
6. Auto Generate PyTorch Model
7. Automatically generating script
8. Autorecord
```

### Status in the current architecture

The current structure is as follows:

- `Search Space Registry`
- `build_model(candidate_recipe)`
- `Static Validator`
- `Patch Generator`
- `ModelSpec`

These modules are close to the components of the compiler, but they are not uniformly named and organized as **Executable Model Recipe Company**.

The current expression is more like:

```text
recipe - > runtime assembly PyTorch model
```

Instead of:

```text
typed action sequence -> recipe graph -> shape-checked architecture graph -> executable model
```

### Impact

Ifcompiler is not prominent enough, the system can easily be understood as "AutoML DSL with registry", rather than a research system that can codify an individual actions into a legitimate architecture.

Contribution 3:

```text
Executable Model Recipe Compiler
```

### Suggested addition

Add a new section:

```text
Model Compiler Layer
```

Suggested interface:

```python
def compile_actions(
    task_spec: TaskSpec,
    base_recipe: CandidateRecipe,
    trajectory: ActionTrajectory,
) -> CompiledRecipeGraph:
    ...

def validate_recipe_graph(
    graph: CompiledRecipeGraph,
    registry: ActionRegistry,
    budget: BudgetSpec,
) -> ValidationResult:
    ...

def emit_model_spec(
    graph: CompiledRecipeGraph,
) -> ModelSpec:
    ...
```

Recommended data structure:

```python
@dataclass
class CompiledRecipeGraph:
    graph_id: str
    nodes: list[dict]
    edges: list[dict]
    input_contract: dict
    output_contract: dict
    shape_trace: list[dict]
    estimated_params: int
    estimated_flops: float | None
    estimated_latency_ms: float | None
```

Compiler should clearly assume the following responsibilities:

- action sequence legality check
- branch graph construction
- tensor shape propagation
- module compatibility validation
- preprocessing/postprocessing pairing
- architecture graph logging
- PyTorch model generation

---

## 4. Meta-Architecture / Hybrid Construction does not feature prominently enough

### The idea in the latest thinking.

V2 views Level 6 Meta-Architecture Actions as a gap with TimeRecipe:

```text
A6.1  SplitTrendSeasonalBranches
A6.2  AddResidualBranch
A6.3  AddDualEmbeddingBranches
A6.4  AddProfileConditionedRouter
A6.5  AddExpertForTrend
A6.6  AddExpertForSeasonality
A6.7  AddExpertForFeatureDependency
A6.8  AddMixtureOfExperts
A6.9  AddEnsembleHead
A6.10 PruneBranch
```

And the third stage of personal innovation is proposed:

```text
Profile-Conditioned Forecasting Router
```

It gives different variables, windows or time-series modes a different route.

```text
router(z) -> {
  trend_expert,
  seasonal_expert,
  feature_dependency_expert,
  frequency_expert,
  residual_expert
}
```

### Status in the current architecture

There are some relevant elements in the current architecture:

- `gated_hybrid`
- `temporal_then_feature`
- `feature_then_temporal`
- `residual_correction`
- Research directional tips for multiscale Branch

However, these are currently fragmented accelerations or tips that do not create clear milestones for innovation.

In the current road map, Milestone 2 is still primarily a TimeRecipe-style modular combination search; It is only in the case of militone 6 that we are downplayed about template catch, distillation and multitasking. Profile-condited moder did not appear as a clear stage target.

### Impact

The current document indicates that " the system can combine modules " , but it is not sufficient to state that " the system can construct new structures beyond the existing model library and TimeRecipe fixed combinations.

Contribution 5:

```text
Hybrid Forecasting Architectures
```

### Suggested addition

Add the following to the Search Space Layer:

```text
Meta-Architecture Action Space
```

Initial action:

```text
split_trend_seasonal_branches
add_residual_branch
add_dual_embedding_branches
add_gated_fusion
add_grouped_feature_fusion
add_profile_conditioned_router
add_expert_branch
prune_branch
```

New phase route:

```text
Milestone 3: Hybrid Architecture Construction
```

Objectives:

- Supports the dual-branch atchitecure.
- Supports the transfer/seasonal/dependency input.
- Supported gad fusion.
- Support for lanch pruning.

Add:

```text
Milestone 4: Profile-Conditioned Forecasting Router
```

Objectives:

- Calculates the variable vector for a variable or window.
- Select an example according to the profile router.
- Compared with adjusted vs profile-conditions.
- Validates whether router enhances cross-variant, cross-horizon and cross-data.

---

## 5. Research Baseline / Oracle Evaluation is incomplete

### The idea in the latest thinking.

v2 expressly requests comparison:

```text
1. Random search over same action space
2. Bayesian optimization over same action space
3. TIMERECIPE training-free selector
4. LLM-only planner without reflection
5. AutoTS-Research with reflection
6. Exhaustive search as oracle upper bound
```

The experimental design also includes:

- Existing Models
- AutoML / Search Baselines
- Agent Baselines
- Oracle

### Status in the current architecture

The current structure consists of baseline builder, champion/challenger, success indicators and Time-Series-Library alignment notes.

But the baseline is mainly a model:

- Statistical baseline
- NLinear CI
- MLP
- iTransformer / PatchTST

Lack of research system-level baseline:

- random over same action space
- BO over same action space
- TimeRecipe selector
- LLM planner without profile
- LLM planner without reflection
- LLM planner without compiler
- exhaustive oracle

### Impact

Without these baselines, the dissertation questions will come from:

```text
AutoTS -Research builder architecture?
```

Degraded to:

```text
Did the system finally find a good TSF model?
```

This will change the research and weaken the core contribution of AutoResearch.

### Suggested addition

Add:

```text
Research Evaluation Protocol
```

Baseline Group:

```text
Existing Model Baselines:
- DLinear
- PatchTST
- iTransformer
- Autoformer
- Informer
- FITS
- TimesNet
- N-HiTS
- TSMixer

Search Baselines:
- Random search over same action space
- Bayesian optimization over same action space
- Evolutionary search
- TimeRecipe training-free selector

Agent Baselines:
- LLM planner without data profile
- LLM planner without reflection
- LLM planner without compiler
- AutoTS-Research full system

Oracle:
- Exhaustive search over bounded action space
```

The core conclusion of the experiment should read

```text
Under a fixed experimental budget, AutoTS-Research is more effective in building forecasting inventory than model regulation, Randall search, BO, TimeRecipe selferator and LLM-only anent.
```

---

## 6. Research Quality / Architecture Quality indicators are incomplete

### The idea in the latest thinking.

V2 Evaluation indicators go beyond MSE to include:

```text
Forecasting Accuracy:
- MSE
- MAE
- SMAPE
- MASE
- OWA

Efficiency:
- number of experiments
- GPU hours
- training time
- inference latency
- parameter count
- FLOPs
- memory usage

Search Quality:
- best metric under fixed budget
- time-to-best
- improvement per round
- distance to exhaustive-search oracle
- valid architecture rate

Research Quality:
- hypothesis correctness
- whether reflection improves next-round model
- whether generated ablations are meaningful
- human evaluation of report quality

Architecture Quality:
- novelty of constructed recipe
- simplicity / parsimony
- robustness across horizons
- robustness across seeds
- robustness across datasets
```

### Status in the current architecture

The current structure has:

- val_avg_mse
- Multiple horizon average
- Arguments
- latency
- GPU hours
- Recurring pass rate
- crash / OOM
- Blinder test leaks
- Heuristic Number
- A similar mission migration success rate

But there is no:

- FLOPs
- memory usage
- distance to exhaustive oracle
- valid architecture rate
- hypothesis correctness
- reflection usefulness
- ablation meaningfulness
- human report quality
- architecture novelty
- cross-dataset robustness

### Impact

Current indicators can assess the reliability of system engineering, but they are not sufficient to demonstrate that "it is a research intelligence" or to support paper contributions.

### Suggested addition

Expand the success indicators into five groups:

```text
Forecasting Accuracy
Efficiency
Search Quality
Research Quality
Architecture Quality
```

In particular, it is proposed to add:

```text
reflection_gain = next_round_improvement_after_reflection
valid_architecture_rate = valid_compiled_architectures / proposed_architectures
oracle_gap = best_agent_metric - best_exhaustive_metric
trajectory_novelty = distance(candidate_trajectory, known_model_templates)
```

---

## 7. Research Artifact / Report Generator does not become the core interface

### The idea in the latest thinking.

v2 clearly output is not a model name, but complete

```text
1. Bust model automatically
2. Runable PyTorch model code
3. Training Configuration
4. Experiment Highlights
5. Each round action projectory
6. Analysis of assumptions and failures per round
7. per-horizon / per-variable error analysis
8. Absorption experiments
9. Ultimately, research report
10. Recommendations for the next study
```

### Status in the current architecture

The current structure refers to reports only in research products, Milestone 5 and `AnalysisReport`.

Current `AnalysisReport` light:

```python
@dataclass
class AnalysisReport:
    summary: str
    metric_breakdown: dict
    failure_analysis: dict
    next_suggestions: list[str]
```

It's not enough to carry the whole story.

### Impact

If the report is only a final subsidiary, the system will be more like an automated experimental platform than AutoResearch.

The research value of AutoResearch needs to be reflected in the report:

- Why do you design it like this?
- What's every hypothesis?
- Which action works?
- What failed?
- How does the structure evolve?
- Did you do it?
- What's the difference with baseline and oracle?
- What's the next course of study?

### Suggested addition

Add:

```text
Research Artifact Layer
```

Recommended data structure:

```python
@dataclass
class ResearchArtifact:
    task_id: str
    best_recipe: CandidateRecipe
    best_model_spec: ModelSpec
    action_trajectory: ActionTrajectory
    training_config: dict
    leaderboard: list[ExperimentRecord]
    hypothesis_log: list[dict]
    failure_analysis: list[dict]
    error_analysis: dict
    ablation_plan: list[dict]
    ablation_results: list[ExperimentRecord]
    baseline_comparison: dict
    oracle_comparison: dict | None
    next_research_suggestions: list[str]
```

Extension:

```python
def generate_research_artifact(
    task: TaskRecord,
    champion: ChampionRecord,
    trajectory: ActionTrajectory,
    experiments: list[ExperimentRecord],
    memories: list[MemoryItem],
    baselines: list[ExperimentRecord],
    oracle: ExperimentRecord | None,
) -> ResearchArtifact:
    ...
```

---

## Suggested Document Rewrite Priority

### P0: Must be completed

1. `Research Intent Layer`
2. `ActionTrajectory`
3. `Model Compiler Layer`
4. `Research Evaluation Protocol`

These determine whether the current document is really aligned with the v2 core proposition.

### P1: Strong proposal to supplement

1. `Meta-Architecture Action Space`
2. `Profile-Conditioned Forecasting Router`
3. `ResearchArtifact / Report Generator`
4. `Research Quality / Architecture Quality Metrics`

These determine whether the programme has a sense of paper contribution.

### P2: Follow-up expansion

1. Full literature/benchmark prior library.
2. Training surrogate predictor.
3. Multiple dataset program-condiving validation.
4. Automatically generate digestion experiments.

---

## Suggests a new directory structure for the current architecture document

You can adjust the current `neo_research_tsf_architecture.md` to:

```text
1. System positioning and core propositions
2. Research Intent Layer
3. Time-Series Profiler Layer
4. Modular Action Space Layer
5. Architecture Action Trajectory
6. Model Recipe DSL
7. Executable Model Compiler Layer
8. Agent Orchestration Layer
9. Reflection-Based Research Loop
10. Evaluation / Reward / Promotion Protocol
11. Research Memory Layer
12. Research Artifact / Report Layer
13. Execution Governance Layer
14. MVP Implementation Plan
15. Research Evaluation Protocol
16. Milestones
17. Expected Contributions
```

This will bring the document closer to v2 "Research Program + System Design + Paper Contribution" from the Project Structure Description.

---

## Summary of the sentence

Currently, `neo_research_tsf_architecture.md` has a closed project loop to land, but it needs to be completed with six modules **Requirement Formalizer, Action Trackory, Exportable Compiler, Hybrid/Router Construction, Research Evaluation, Research Artifact** in order to fully align the "Action-Space-Based Auto Model Control for Time-Series Forecasting" in `NeoResearch-TSF-v2.md`.
