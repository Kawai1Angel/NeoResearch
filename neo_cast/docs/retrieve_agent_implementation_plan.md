# RetrieveAgent Implementation Program (BM25 Local Retrieval)

## 1. Objective

This program adds a first edition of `RetrieveAgent` to NeoResearch. It's receiving.
The quantitative analysis produced by `DataAnalysisAgent` translates data evidence from layer to layer into scientific concepts, methodological concepts and the language used in the papers.
Then use local BM25 to retrieve the papers and hand over high-profile candidates to existing `LiteratureAgent` for full text analysis, claim extraction and
Evidence validation.

The first edition closed with:

```text
Current Dataset
      ↓
DataAnalysisAgent
      ↓
Quantitative Analysis Report
      ↓
RetrieveAgent
  ├─ Dataset Evidence Reader
  ├─ Scientific Concept Mapper
  ├─ Method Concept Mapper
  ├─ Paper-language Translator
  └─ Local BM25 Retriever
      ↓
Ranked Candidate Papers
      ↓
LiteratureAgent
  ├─ PDF parsing
  ├─ claim extraction
  ├─ evidence verification
  └─ KnowledgeCard generation
      ↓
Retrieve Result + KnowledgeCards
```

This version ends with the completion of the `RetrieveAgent → LiteratureAgent` bridge without access to `HypoPlannerAgent`.

## 2. First edition scope

### 2.1 Achieved during the period

- DataAnalysis output machine readable quantitative analysis reports;
- Dataset Evidence from quantitative reports;
- Completed `Dataset Evidence → Scientific Concepts → Method Concepts → Paper Language` conversion;
- Each Retrieval Intent generates only one paper language query;
- Using local BM25 for a recall;
- Deduplicate BM25 results, assess evidence levels, and apply simple screening.
- `LiteratureAgent` will deliver local PDF high priority papers;
- Collect KnowledgeCard and failure statuses returned by `LiteratureAgent`.
- Saves complete input, conversion, query, candidate and bridge tracks.

### 2.2 Not achieved during the period

- No academic and other dissertation search API;
- Multiple Query Exchange that does not achieve the same incent;
- Unrealizing Recipal Rank Fusion (RRF);
- Unrealized vector search or embedding rerank;
- Do not implement repeated Search → Learn → Search cycles.
- Unrealized citation/reference export;
- The data set used for the non-automatic downloading of papers is reprogrammed;
- Do not connect to HypoPlanner or ModelDesigner bridges;
- RetrieveAgent is not allowed to directly generate model assumptions or modify model codes.

If a data set forms more than one Retrieval Enter, each Intent can execute BM25 at once, but the result is saved separately by Intent.
This is not a "recall for multiple inquiries with the same intent" nor does it integrate cross-examination RRF.

## 3. Component duties

### 3.1 DataAnalysisAgent

Responsible for producing objective analyses from raw numerical data, such as:

- (a) The intensity of trends;
- Periodicity;
- ACF/PACF;
- Spectrum peaks;
- ADF/KPSS;
- distribution shift;
- change point;
- missing/outlier/irregular interval;
- Cross-variate and cross-lag relations;
- Observed-past, known-future and status covariate roles.

DataAnalysisAgent is not responsible for generating paper search words.

### 3.2 RetrieveAgent

Responsible for:

- Access to quantitative reports;
- To determine which data evidence is sufficient to form scientific concepts;
- (a) Mapping of methodological concepts that may be relevant for scientific concepts;
- Translation of internal concepts into the English language expression common to the title, summary and methodology sections of the paper;
- Construct a BM25 query;
- Retrieving and screening local papers;
- Decide which papers will be given to LiteratureAgent.

RetrieveAgent produces "research relevance", not thesis fact.

### 3.3 LiteratureAgent

The current `LiteratureAgent` continues to be responsible for:

- Parsing local PDF;
- Thesis is divided into sections and chunk;
- Candidate claire;
- Verify whether the original paper supports the claim.
- Generate KnowledgeCard;
- Save environment span, page number, section and policy;
- Dealing with duplicate card and conflict relationships.

Only LiteratureAgent claim can be marked as `paper_backed`.

## 4. DataAnalysis quantitative reporting compact

### 4.1 Double Product

DataAnalysis should be generated from the same memory object:

1. `dataset_quantitative_analysis_markdown`: Readable;
2. `dataset_quantitative_analysis_json`: For RetrieveAgent reading.

RetrieveAgent does not extract values from the Markdown table using regular values. JSON is the authoritative source of machine contact, Marktown just its readable view.

### Example 4.2 JSON

```json
{
  "schemaVersion": "dataset_quantitative_analysis_v1",
  "taskID": "researchTask_xxx",
  "domain": "electricity_load",
  "dataset": {
    "samplingFrequency": "hourly",
    "targetColumns": ["load"],
    "observedPastCovariates": ["temperature"],
    "knownFutureCovariates": ["temperature", "holiday"],
    "staticCovariates": []
  },
  "forecast": {
    "contextLength": 168,
    "predictionLengths": [24, 168],
    "horizonContextRatio": 1.0
  },
  "profile": {
    "rowCount": 20000,
    "missingRate": 0.0,
    "trendStrength": 0.63,
    "seasonalityStrength": 0.91,
    "crossVarCorrelation": 0.52,
    "distributionShift": 0.44,
    "outlierRate": 0.02,
    "irregularIntervalRatio": 0.0
  },
  "statistics": {
    "stationarity": {
      "adfStatistic": -2.31,
      "adfStationary": false,
      "kpssStatistic": 0.71,
      "kpssStationary": false
    },
    "acf": {
      "topLag": 24,
      "topCorrelation": 0.88,
      "pacfTopLag": 24,
      "pacfTopCorrelation": 0.62
    },
    "decomposition": {
      "period": 24,
      "trendVarianceShare": 0.28,
      "seasonalVarianceShare": 0.57,
      "residualVarianceShare": 0.15
    },
    "frequency": {
      "dominantPeriod": 24,
      "dominantPowerShare": 0.49,
      "spectralPeaks": [
        {"period": 24, "powerShare": 0.49, "significant": true},
        {"period": 168, "powerShare": 0.21, "significant": true}
      ]
    },
    "changepoint": {
      "index": 12600,
      "score": 0.68,
      "severity": "medium"
    },
    "crossLag": {
      "source": "temperature",
      "target": "load",
      "lag": 2,
      "correlation": 0.58
    }
  },
  "warnings": [],
  "sourceArtifactIDs": ["researchArtifact_xxx"]
}
```

### 4.3 Required Supplement

The current analysis achieves only one dominant freedom. In order to identify multiplications, add
`spectralPeaks`, at least record period, power share, signature and optional languages.

If there is only one significant spectrum peak, RetrieveAgent can only be converted to `seasonality` and not to
`multiple_seasonalities`.

calendar/holiday effect Only if the corresponding field does exist in the desk and DataAnalysis has done group analysis
Dataset Evidence. Otherwise keep `unknown`.

## 5. Multi-layer scientific conceptual transformation

### 5.1 Conversion Model

RetrieveAgent does not spell values directly into Query, but constructs four layers to indicate:

```text
Dataset Evidence
      ↓
Scientific Concepts
      ↓
Method Concepts
      ↓
Paper Language
      ↓
BM25 Query
```

Various meanings:

- `Dataset Evidence`: DataAnalysis actually calculates or is clearly given by the name of DataAnalysis
- `Scientific Concepts`: Academies refer to such data phenomena or problems;
- `Method Concepts`: a possible methodological mechanism for this issue, which is a search assumption and does not mean that it has been decided to use;
- `Paper Language`: More likely English terminology or phrases in the title, summary and methodology sections of the paper.

### 5.2 conversion contract

```ts
type ConceptTransformation = {
  transformationID: string
  datasetEvidence: Array<{
    path: string
    metric: string
    value: unknown
    interpretation: string
  }>
  scientificConcepts: Array<{
    conceptID: string
    label: string
    paperTerms: string[]
    confidence: number
    basis: "deterministic_rule" | "llm_supported"
  }>
  modelingChallenges: string[]
  methodConcepts: Array<{
    conceptID: string
    label: string
    paperTerms: string[]
    rationale: string
    status: "retrieval_hypothesis"
  }>
  paperLanguage: {
    taskTerms: string[]
    phenomenonTerms: string[]
    methodTerms: string[]
    domainTerms: string[]
    queryText: string
  }
}
```

Method Concept must be marked with `retrieval_hypothesis`. For example, if you find a strong cycle, you can search it.
Freegency-domain modeling, but it cannot be claimed that fregacy-domain method must fit the current data before searching.

### Example of 5.3 conversion

#### Example I: Multiple cycles

```text
Dataset Evidence
- spectral peak at 24, power share 0.49
- spectral peak at 168, power share 0.21

Scientific Concepts
- multiple seasonalities
- multi-periodicity
- heterogeneous periodic patterns

Method Concepts
- frequency-domain modeling
- multi-scale temporal modeling
- seasonal decomposition

Paper Language
- multiple seasonalities in time series forecasting
- multi-periodic temporal patterns
- frequency-domain forecasting
- multi-scale seasonal modeling
```

#### Example II: Trends and non-stableness

```text
Dataset Evidence
- trendStrength = 0.63
- ADF stationary = false
- KPSS stationary = false
- distributionShift = 0.44

Scientific Concepts
- non-stationary time series
- temporal distribution shift
- evolving trend dynamics

Method Concepts
- trend-seasonal decomposition
- adaptive normalization
- distribution-shift-aware forecasting

Paper Language
- non-stationary time series forecasting
- temporal distribution shift forecasting
- adaptive normalization for forecasting
- trend decomposition forecasting
```

Only if `trendStrength` is high, but steady and Shift does not support it should remain as
`trend dynamics`, cannot be upgraded to `non-stationarity`.

#### Example III: Change points

```text
Dataset Evidence
- changePointScore = 0.68
- severity = medium

Scientific Concepts
- potential structural break
- regime transition
- temporal regime shift

Method Concepts
- change-point-aware forecasting
- regime-adaptive modeling
- mixture-of-experts routing

Paper Language
- forecasting under structural breaks
- regime shift time series forecasting
- change-point-aware forecasting model
- regime-adaptive temporal modeling
```

`potential structural break` is used by concept instead of asserting the existence of certainty because change-point detector can also be misreported
structural break.

#### Example IV: Future Accompaniments

```text
Dataset Evidence
- knownFutureCovariates = [temperature, holiday]

Scientific Concepts
- exogenous variable dependence
- covariate-conditioned forecasting
- future-known information

Method Concepts
- covariate fusion
- exogenous attention
- static/dynamic variable selection

Paper Language
- time series forecasting with known future covariates
- exogenous variable forecasting model
- covariate-conditioned probabilistic forecasting
- future covariate fusion
```

#### Example five: Cross-variant dependency

```text
Dataset Evidence
- crossVarCorrelation = 0.72
- cross-lag temperature → load, lag = 2, correlation = 0.58

Scientific Concepts
- cross-series dependency
- inter-variable correlation
- lead-lag relationship

Method Concepts
- channel mixing
- cross-variable attention
- lag-aware feature fusion

Paper Language
- multivariate time series forecasting with cross-variable dependencies
- channel mixing forecasting model
- lead-lag dependency modeling
- cross-variable attention for forecasting
```

### 5.4 recommended conversion table

| Dataset evidence | Scientific concepts | Method concepts | Paper-language terms |
| --- | --- | --- | --- |
| Strong seasonality supported by ACF/frequency evidence | seasonality, recurrent temporal patterns | seasonal decomposition, periodic encoding | seasonal time series forecasting, periodic dependency modeling |
| Two or more significant spectrum peaks. | multiple seasonalities, multi-periodicity | frequency modeling, multi-scale modeling | multiple seasonalities forecasting, multi-periodic forecasting |
| high trend strength | trend dynamics, long-term evolution | detrending, trend decomposition | trend-aware forecasting, trend decomposition forecasting |
| ADF/KPSS/shift Joint Support | non-stationarity, temporal distribution shift | adaptive normalization, shift-aware learning | non-stationary forecasting, distribution shift forecasting |
| high change-point score | potential structural break, regime transition | change-point-aware modeling, regime adaptation | forecasting under structural breaks, regime shift forecasting |
| known-future covariates | covariate-conditioned forecasting, exogenous dependence | covariate fusion, exogenous attention | forecasting with known future covariates, exogenous variable forecasting |
| high cross-variate correlation | cross-series dependency | channel mixing, cross-variable attention | cross-variable dependency forecasting, channel mixing model |
| significant cross-lag | lead-lag relationship, delayed effect | lag-aware fusion, temporal cross-attention | lead-lag forecasting, lagged covariate modeling |
| high outlier rate | contaminated observations, heavy-tailed noise | robust loss, robust normalization | robust time series forecasting, outlier-resistant forecasting |
| high missing rate | incomplete observations | masked modeling, missingness-aware encoder | missing-aware forecasting, masked time series modeling |
| irregular intervals | irregularly sampled time series | continuous-time modeling, time-gap encoding | irregular time series forecasting, irregular sampling model |
| high horizon/context ratio | long-horizon dependency | multi-scale context, efficient long-range modeling | long-term time series forecasting, long-horizon forecasting |
| There is empirical support for the grouping effect. | calendar effect, special-day effect | calendar embedding, event-aware gating | holiday load forecasting, calendar-aware forecasting |
| variance changes over time | heteroscedasticity, time-varying uncertainty | probabilistic head, scale modeling | heteroscedastic forecasting, probabilistic time series forecasting |

### 5.5 Determination Rules and LLM Division of Labour

The certainty rule is responsible for:

- (a) To determine, on the basis of the report fields and values, which Scientific Concepts are allowed to appear;
- Unsuppleted consept;
- Load Method Concepts and paper terms from a version of the glossary;
- Saves source path and condition for each concept.

LLM is responsible only for:

- Select a more natural presentation within the permitted concepts;
- Organize terminology into a simple English search string;
- Delete repetition, oralization or numerical expression.

LLM does not allow:

- Modify the DataAnalysis value;
- Add a scientific Concept that is not supported by evidence in the report;
- Writing Method Concept as an established methodological conclusion;
- Directly use `seasonalityStrength=0.91` such internal field names as key words for the paper;
- Automatically modifys the official taxonony.

LLM output must be Zod Schema strict and check that every `datasetEvidence.path` can be parsed in the report.

## 6. Retrieval Intent & Paper Language Query

### 6.1 Intent Structure

```json
{
  "intentID": "intent_multi_periodicity",
  "question": "How can forecasting models represent multiple periodic structures?",
  "transformationID": "transform_multi_periodicity",
  "priority": 0.94,
  "mustCover": true,
  "paperLanguageQuery": {
    "taskTerms": ["time series forecasting"],
    "phenomenonTerms": ["multiple seasonalities", "multi-periodic patterns"],
    "methodTerms": ["frequency-domain modeling", "multi-scale temporal modeling"],
    "domainTerms": ["electricity load"],
    "queryText": "time series forecasting multiple seasonalities multi-periodic frequency-domain multi-scale"
  }
}
```

### 6.2 Single Query Constraint

Only one `queryText` is generated for each incent:

- Do not generate queries for phenomenon, method and domain;
- Do not generate multiple queries for synonyms;
- Do not execute query paraphrase;
- Do not use RRF merge results;
- No second round query response.

Synonyms can be used as terms in the same BM25 query, but only for one search.

### 6.3 Thesis Language Conversion Rule

Inquiries should give priority to possible expressions of the papers:

| Internal expression | Direct search not recommended | Language of recommended thesis |
| --- | --- | --- |
| `seasonalityStrength=0.91` | strong seasonality 0.91 | seasonal patterns, periodic dependencies |
| `spectralPeaks=[24,168]` | period 24 period 168 | multiple seasonalities, multi-periodic patterns |
| `distributionShift=0.7` | strong distribution shift 0.7 | temporal distribution shift, non-stationary forecasting |
| `changePointScore=0.68` | change point score 0.68 | structural breaks, regime transitions |
| `knownFutureCovariates` | future variables available | known future covariates, exogenous variables |
| `crossVarCorrelation=0.72` | variables highly correlated | cross-variable dependencies, inter-series correlation |

Numbers are kept only in provenance and interpretation of results, not on the first edition of BM25 Query;`24-hour`, `weekly` etc. with clear scientific meanings
The periodic description may be exceptional, but must be determined jointly by sampling freqency and period.

## 7. Local BM25 Retrieval

### 7.1 Local Language Source

| Evidence level | Source | Supportable uses |
| --- | --- | --- |
| `metadata_only` | catalog title,year,venue,publication status | Initial recall |
| `document_available` | abstract,introduction,method,results chunks | Relevance judgement and full-text examination |
| `paper_backed` | Authenticated KnowledgeCard and evidence span | Thesis's facts and institutional evidence |

The current `paper_record` schema does not have abstract fields. So only the catalog, which does not analyze PDF papers, can participate in BM25 with a title.
This must not be labeled as supported by the full text.

### 7.2 Index Directory

```text
neo_cast/.neo-cast/literature-retrieval/
├── index/
│   ├── retrieval.db
│   ├── index_manifest.json
│   └── document_fingerprints.jsonl
└── runs/<retrieve-run-id>/
```

`retrieval.db` for SQLite/FTS5:

- `paper`: paperID, title, year, vene, public status, PDF state;
- `paper_text`: polymerized text for each section;
- `paper_fts`:title,abstract,introduction,method,results,limitations;
- `card_projection`: claim, mechanism, applicability;
- `index_source`: Source file digest, parser version, taxony version.

The first version does not create a status graph, nor does it create vector indexes.

### 7.3 field weight

BM25 Suggested field weights:

```text
title             = 4.0
abstract          = 3.0
knowledge_card    = 3.0
method            = 2.0
introduction      = 1.5
results/ablation  = 1.5
limitations       = 1.0
```

If the FTS5 field weight interface does not stabilize to meet demand, medium-notation calculations of field score can be achieved by testing a fixed BM25 in cells;
Single queries, single stages BM25 are still maintained without adding a second recaller.

### 7.4 Retrieval process

The search process for each incent is fixed to:

```text
paper-language query
      ↓
normalize terms
      ↓
one BM25 search
      ↓
top K results
      ↓
deduplicate by paperID / DOI / arXiv ID
      ↓
attach matched fields and evidence level
      ↓
select papers for LiteratureAgent
```

The first version retains the original BM25 rank and interprets hit information without supersing complex composite formulae.

### 7.5 Candidate Structure

```json
{
  "schemaVersion": "retrieval_candidate_v1",
  "candidateID": "rc_xxx",
  "paperID": "tsf-2024-xxxxxxxxxxxx",
  "intentID": "intent_multi_periodicity",
  "queryText": "time series forecasting multiple seasonalities multi-periodic frequency-domain multi-scale",
  "bm25": {
    "rank": 1,
    "score": 12.84,
    "matchedFields": ["title", "abstract", "method"],
    "matchedTerms": ["multiple seasonalities", "frequency-domain"]
  },
  "evidenceLevel": "document_available",
  "localPDF": true,
  "decision": "send_to_literature_agent",
  "decisionReasons": [
    "top BM25 result for intent_multi_periodicity",
    "local PDF and method section are available"
  ]
}
```

### 7.6 Simple Filter Rule

- BM25 top 20 for each Intent default;
- Each incent sends a maximum of top 5 to LiteratureAgent;
- The same paper was only analysed once in multiple Intent hits, but all `intentID` is retained;
- No local PDF paper is kept in the result at `skipped_pdf_unavailable`;
- `references` section does not include text matching in the hit;
- Only domain term hit and no candidate for scientific/method term downgraded to `domain_only`;
- watchlist/preprint does not delete but maintains the public status;
- The BM25 score cannot be converted to "credibility of conclusions".

## 8. RetrieveAgent and LiteratureAgent Bridge

### 8.1 Bridge Principles

RetrieveAgent only sends locally deciphered papers to LiteratureAgent:

```text
BM25 Candidate
  ├─ local PDF exists
  │      ↓
  │  LiteratureAgent.run(catalog_paper)
  │      ↓
  │  completed / partial / failed
  │      ↓
  │  KnowledgeCard IDs
  │
  └─ no local PDF
         ↓
     skipped_pdf_unavailable
```

### 8.2 Bridge input

```ts
type RetrieveLiteratureBridgeInput = {
  retrieveRunID: string
  candidates: Array<{
    paperID: string
    intentIDs: string[]
    bm25Rank: number
    bm25Score: number
  }>
  literatureOptions: {
    includeAgentInference: false
    requireExactEvidenceSpan: true
    maxCardsPerPaper: number
  }
}
```

Integration mode default:

```json
{
  "includeAgentInference": false,
  "requireExactEvidenceSpan": true,
  "maxCardsPerPaper": 30
}
```

### 8.3 Bridge Output

```ts
type RetrieveLiteratureBridgeResult = {
  retrieveRunID: string
  papers: Array<{
    paperID: string
    intentIDs: string[]
    status:
      | "completed"
      | "partial"
      | "failed"
      | "skipped_pdf_unavailable"
    literatureRunID?: string
    acceptedCardIDs: string[]
    rejectedCandidateCount: number
    warningCount: number
    reviewPath?: string
    error?: string
  }>
}
```

### 8.4 Association

RetrieveAgent requires additional saving:

```text
Dataset Evidence
→ Concept Transformation
→ Retrieval Intent
→ BM25 Candidate
→ LiteratureAgent Run
→ KnowledgeCard
```

KnowledgeCard itself maintains a cross-task and cross-research run canonical knowledge that does not write to BM25 score.
BM25 score, incent and DataAnalysis sources are stored in the running records of RetrieveAgent.

### 8.5 et al. and failed processing

- The results of the same PDF digest, parser version, prompt version are used when re-used LiteratureAgent run;
- A single dissertation failed to stop the whole RetrieveAgent run;
- `ocr_required` is recorded as partial;
- No PDF is not an error, recorded as sskiped;
- All failed to keep paperID, intentID and reasons;
- RetrieveAgent final state allowed to be `completed_with_warnings`.

## 9. First issue status machine

The first edition is a single rotational water line, with no autonomous circulation:

```text
READ_REPORT
    ↓
EXTRACT_DATASET_EVIDENCE
    ↓
MAP_SCIENTIFIC_CONCEPTS
    ↓
MAP_METHOD_CONCEPTS
    ↓
TRANSLATE_TO_PAPER_LANGUAGE
    ↓
BM25_RECALL
    ↓
SELECT_LOCAL_PAPERS
    ↓
RUN_LITERATURE_AGENT
    ↓
COLLECT_KNOWLEDGE_CARDS
    ↓
FINISH
```

The status machine does not have `SEARCH_AGAIN`, `EXPAND_CITATIONS` or `UPDATE_QUERY` action.

Default budget:

```json
{
  "maxIntents": 6,
  "maxCandidatesPerIntent": 20,
  "maxLiteraturePapersPerIntent": 5,
  "maxLiteraturePapersTotal": 12
}
```

## 10. RetrieveAgent final product

### 10.1 Run Directory

```text
.neo-cast/literature-retrieval/runs/<retrieve-run-id>/
├── input.json
├── dataset_evidence.json
├── concept_transformations.json
├── retrieval_intents.json
├── bm25_results.jsonl
├── selected_candidates.jsonl
├── literature_bridge_results.json
├── retrieve_result.json
├── report.md
└── run_manifest.json
```

### 10.2 Retrieve Result

```json
{
  "schemaVersion": "retrieve_result_v1",
  "retrieveRunID": "retrieve_xxx",
  "taskID": "researchTask_xxx",
  "quantitativeReportArtifactID": "researchArtifact_xxx",
  "transformations": [],
  "intents": [],
  "candidates": [],
  "literatureResults": [
    {
      "paperID": "tsf-2024-xxxxxxxxxxxx",
      "intentIDs": ["intent_multi_periodicity"],
      "status": "completed",
      "acceptedCardIDs": ["kc_xxx", "kc_yyy"],
      "reviewPath": ".neo-cast/literature-knowledge/runs/lerun_xxx/review.md"
    }
  ],
  "summary": {
    "intentCount": 3,
    "bm25CandidateCount": 44,
    "literaturePaperCount": 8,
    "paperBackedCardCount": 15,
    "missingPDFCount": 2,
    "failedPaperCount": 0
  }
}
```

This product was first used for manual inspection and subsequent module development, not consumed by HypoPlanner during the period.

## 11. Code Organization

It is proposed to add:

```text
neoresearch/packages/neoresearch/src/research/retrieve/
├── contract.ts
├── retrieve-agent.ts
├── quantitative-report-reader.ts
├── dataset-evidence.ts
├── scientific-concept-mapper.ts
├── method-concept-mapper.ts
├── paper-language-translator.ts
├── retrieval-intent.ts
├── local-index-builder.ts
├── bm25-search.ts
├── candidate-selector.ts
├── literature-bridge.ts
├── retrieve-store.ts
├── report-renderer.ts
└── config/
    ├── tsf-scientific-concepts.v1.json
    ├── tsf-method-concepts.v1.json
    └── tsf-paper-language.v1.json
```

Suggest new schema:

```text
neo_cast/literature_knowledge/
├── dataset_quantitative_analysis.schema.json
├── concept_transformation.schema.json
├── retrieval_intent.schema.json
├── retrieval_candidate.schema.json
├── retrieve_literature_bridge_result.schema.json
└── retrieve_result.schema.json
```

Existing `neoresearch/.../research/literature/` is maintained as thesis understanding and KnowledgeCard module. RetrieveAgent pass.
`literature-bridge.ts` calls it and does not copy its resolution, validation or storage logic.

## 12. Index and Run Recoverability

`index_manifest.json` at least recorded:

- catalog SHA-256;
- SHA-256 for each normalized document/chunk file;
- KnowledgeCard export digest;
- tokenizer version;
- BM25 parameters;
- taxonomy version;
- Create time.

`run_manifest.json` at least recorded:

- quantitative report digest;
- index digest;
- scientific concept mapping version;
- method concept mapping version;
- paper-language mapping version;
- LLM model/prompt version (if used);
- queryText for each incent;
- Top K and LiteratureAgent budgets;
- LiteratureAgent run IDs;
- Status, Warnings and Errors.

The same report data, index data and the default configuration version to reuse RetrieveAgent results unless visible `force` is specified.

## 13. Test programme

### 13.1 DataAnalysis contract

- JSON and Markdown are from the same subject;
- JSON schema strictly rejects unknown fields;
- All the evidence path can be analyzed;
- Spectral Peaks do not produce spacetime
- Cannot create calendar effect without the holidday field.

### 13.2 Concept conversion

- Strong periodic conversion to security;
- Two significant spectrum peaks are converted to multiplicates;
- Single-spectral peaks cannot be converted to mmultiple seasonalities;
- No direct assertion of non-state;
- Know-future covariates converted to convariate-conditions;
- Method consepts with all `retrieval_hypothesis`;
- LLM cannot add a scientific concept outside of an allowlist;
- Internal indicator names and values will not enter query as they are.

### 13.3 Paper-language translation

- Each incent happens to produce a queryText;
- Qurey uses English academic terminology;
- Query contains task terms and at least one scientific term;
- query does not generate paraphrase lists;
- Query does not produce a second round;
- The same input and configuration have stable results.

### 13.4 BM25

Create fixed fixtures:

- A paper on multiple-seasonality/frequency;
- A non-statearity paper;
- (a) A paper that is only the same as domain but not related to mechanisms;
- A paper with only Title and no PDF;
- A paper that already has KnowledgeCard.

Authentication:

- Thesis for scientific/method terms is at the top;
- Pure domain matching will not be wrongly marked as full-text evidence;
- Title-only results result level metadata_only;
- Accesss section does not participate in text matching;
- BM25 rank and monitored fields can be reproduced;
- No RRF or vector fraction exists.

### 13.5 LiteratureAgent bridge

- A local PDF candidate can call LiteratureAgent;
- The same paper was analyzed only once in multiple Intent hits;
- Completed run can be reused;
- No PDF returns sskiped instead of failed;
- A single failure does not suspend other papers;
- acceptedCardIDs can be traced back to paperID, candidateID, intentID and DataAnalysis evidence;
- Integraded mode forbids entry-inference card.

### 13.6 End-to-end test

```text
quantitative report JSON
→ dataset evidence
→ scientific concepts
→ method concepts
→ paper language
→ one BM25 retrieval per intent
→ candidate selection
→ LiteratureAgent
→ KnowledgeCards
→ retrieve_result.json
```

## 14. Phased implementation

### Phase 1: quantitative reporting and conceptual transformation

- Add `dataset_quantitative_analysis_json`;
- Strictly defined schema;
- Add `spectralPeaks`;
- Achieve Dataset Evidence extraction;
- Achievement of the third floors of Scientific Concept, Method Concept and Paper Language
- Completes the regular, inverse and unsupported test.

Receiving and Inspection: Each thesis language term can be traced backwards to Dataset Employment.

### Phase 2: Local BM25

- Build catalog/chunk/card FTS5 index;
- Query BM25 per intent single;
- (a) Accomplishing the monitored field/term interpretation;
- Candidate heavy, video level and PDF aviality;
- Generates BM25 search reports.

Receiving and inspection: No more query extensions, RRFs, vector search or online API calls.

### Phase 3: LiteratureAgent Bridge

- Candidate LiteratureAgent input conversion;
- Realization of the mobilization budget and reprioritization;
- Receive completed/partial/failed/skipped status;
- Associated acceptedCardIDs;
- Generate `retrieve_result.json` and `report.md`.

Acceptance: Complete chain from quantitative report to paper-backed KnowledgeCard.

### Phase 4: stability and recoverability

- Add index/run climate;
- (b) Add digest thallium etc. reuse;
- (a) Increasing the number of failures to recover;
- Add fixture e2e;
- Registered in Research Service RetrieveAgent for started/completed/failed events.

Acceptance: The failure of a paper does not affect the remaining results, and repeated running does not repeat the same PDF.

## 15. We'll consider it later.

The following capabilities were explicitly retained after the completion of the first edition:

- Extension of multiple queries with Intent;
- BM25 + vector hybrid retrieval;
- RRF or lost reranker;
- "Search," "Learn", "Search" and "Search".
- citation/reference expansion;
- Online API programmer;
- Publicly published data sets
- Retrieve Research connects to HypoPlanner;
- Retrieval intent adjusted in reverse on the basis of experimental results.

## 16. MVP Completion Standard

The first edition is considered complete if:

1. API can also run without the configuration of external papers;
2. RetrieveAgent Structured quantitative analysis of direct consumption;
3. Complete Dataset Evidence → Scientific Concepts → Method Concepts → Paper Language.
4. All Scientific Concepts have a value or a dataline;
5. Method Concepts is clearly marked as retrievable hypothesis;
6. Each Intent executes BM25 only once;
7. There is no multi-search integration, RRF, vector recall and multiple search rounds;
8. Local PDF candidates are able to get LiteratureAgent on the right bridge;
9. No PDF candidate maintains metadata-only/skipped and does not generate paper-backed claim;
10. KnowledgeCard can be traced back to paper, incent, concept transport and DataAnalysis experience;
11. The result of RetrieveAgent is left on its own and does not depend on HypoPlanner;
12. All intermediates and version information are auditable and re-available.
