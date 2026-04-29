# Benchmark Protocol

This document defines the benchmark metadata and result-table contract for the time-series forecasting presets currently supported by `neo_cast.py.dataset_contract`.

It is a protocol template only. It intentionally contains no measured benchmark numbers.

## Supported Datasets

| dataset_id | display_name | preset | split_policy | default_context | default_horizons | primary_metric | reference_metrics | requires_external_data_file | expected_data_files |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| etth1 | ETTh1 | etth1 | fixed_rows | 512 | 96, 192, 336, 720 | mse | mse, mae | true | ETTh1.csv |
| ettm1 | ETTm1 | ettm1 | fixed_rows | 512 | 96, 192, 336, 720 | mse | mse, mae | true | ETTm1.csv |
| weather | Weather | weather | tsl_custom_70_10_20 | 512 | 96, 192, 336, 720 | mse | mse, mae | true | weather.csv |
| traffic | Traffic | traffic | tsl_custom_70_10_20 | 512 | 96, 192, 336, 720 | mse | mse, mae | true | traffic.csv |

## Split Policy

- `fixed_rows`: Uses row ranges encoded in the dataset preset. For ETTh1 this is the hourly ETT split; for ETTm1 this is the 15-minute ETT split.
- `tsl_custom_70_10_20`: Uses contiguous row ranges with 70% train, 10% validation, and 20% reference test. Numeric feature columns are inferred from the provided CSV after excluding the timestamp column.

All presets use standard normalization fitted on the train split. The reference test split must remain held out from model selection.

## Data Inputs

External dataset files are required and are not downloaded by this repository. The benchmark runner or operator should provide the expected CSV file listed in the manifest and materialize it with the matching dataset preset.

Required CSV properties:

- Timestamp column: `date`
- ETTh1/ETTm1 feature columns: `HUFL`, `HULL`, `MUFL`, `MULL`, `LUFL`, `LULL`, `OT`
- Weather/Traffic feature columns: inferred numeric columns, excluding `date`
- Missing-value handling: `forward_fill`
- Time frequency: `auto`

## Result Table Template

Benchmark reports should use one row per dataset, horizon, model, and run.

Expected columns:

| column | required | description |
| --- | --- | --- |
| dataset_id | yes | One of `etth1`, `ettm1`, `weather`, `traffic`. |
| horizon | yes | Forecast horizon evaluated, usually one of `96`, `192`, `336`, `720`. |
| model_id | yes | Stable model or recipe identifier. |
| run_id | yes | Stable run identifier for reproducibility. |
| primary_metric | yes | Primary metric name, currently `mse`. |
| mse | yes | Mean squared error on the reference test split. Leave empty until measured. |
| mae | yes | Mean absolute error on the reference test split. Leave empty until measured. |
| trained_at | yes | ISO-8601 timestamp for the run. |
| data_file | yes | Source CSV basename or checksum-qualified path. |
| git_commit | recommended | Commit SHA used for the run. |
| notes | optional | Protocol deviations, data checksum notes, or known caveats. |

Empty result table:

| dataset_id | horizon | model_id | run_id | primary_metric | mse | mae | trained_at | data_file | git_commit | notes |
| --- | ---: | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |
|  |  |  |  | mse |  |  |  |  |  |  |

## Manifest

The machine-readable manifest template lives at `neo_cast/benchmarks/tsf_benchmark_manifest.json`. The Python source of truth is `dataset_contract.benchmark_manifest()`.

## Local Validation

Use `py/benchmark_report.py` to create a result-table template before running a benchmark:

```bash
python3 py/benchmark_report.py template --output .neo-cast/benchmarks/results.csv
```

After measured rows are filled in, validate the contract and write a champion summary:

```bash
python3 py/benchmark_report.py validate \
  --results .neo-cast/benchmarks/results.csv \
  --summary-json .neo-cast/benchmarks/summary.json
```

The validator checks dataset ids, supported horizons, required numeric metrics, duplicate run keys, and the current primary metric. `summary.json` records the lowest-MSE champion per dataset and horizon. It is a report artifact derived from measured rows; it does not create benchmark numbers.
