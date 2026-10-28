# Dataset Interpretation

## 1. Dataset Overview

The `dataset/` directory currently contains one file:

- `load.csv`

Its fields and value distributions indicate **hourly load forecasting data**:

- Primary target: `LOAD`
- Timestamp: `TIMESTAMP`
- 25 exogenous features: `w1 ~ w25`
- `ZONEID` has one value: `1`

The dataset is therefore best described as:

**A single-zone, single-target hourly time series with 25 auxiliary features.**

## 2. Table Structure

`load.csv` has 28 columns:

1. `ZONEID`
2. `TIMESTAMP`
3. `LOAD`
4. `w1`
5. `w2`
6. `...`
7. `w25`

The fields have these roles:

- `ZONEID`: zone identifier
- `TIMESTAMP`: timestamp
- `LOAD`: prediction target
- `w1 ~ w25`: exogenous covariates

## 3. Dataset Size

Basic statistics:

- Rows: `15456`
- Columns: `28`
- Zones: `1`
- Missing values: `0`

After correct timestamp parsing, this is a **complete, contiguous hourly sequence**:

- Start: `2008-12-22 01:00`
- End: `2010-09-27 00:00`
- Hours: `15456`

This is a **raw time-series table**, rather than prewindowed supervised examples.

## 4. Timestamp Parsing Needs Particular Care

Original timestamps look like:

- `12222008 1:00`
- `1102009 0:00`
- `112009 0:00`

The issues are:

- Months and days are **not consistently zero-padded**.
- Standard `%m%d%Y %H:%M` parsing is therefore ambiguous.

For example:

- `1102009` appears intended to mean `1/10/2009`.
- Many standard parsers may read it as `11/02/2009` or another ambiguous form.

A more reliable approach is:

- Year: final four digits.
- Month/day: preceding two to four digits.
- Allow one or two digits for both month and day.
- Resolve ambiguity using temporal continuity.

Perform **timestamp normalization** before modeling.

## 5. Interpreting LOAD

`LOAD` appears to be the zone's load at each hour, represented by continuous real values.

Basic statistics:

- Minimum: `64.4`
- Maximum: `315.6`
- Mean: `155.54`

The series has clear temporal structure:

- Daily trough around `04:00`.
- Daily peak around `19:00`.
- Highest monthly mean in August.
- Lowest monthly mean in April.

This suggests:

- Clear **daily periodicity**.
- Clear **seasonality**.
- Some trend, holiday, or weather-driven variation.

## 6. Interpreting w1 through w25

The local directory contains no additional metadata, so repository evidence **cannot establish the exact meanings** of these 25 columns.

Names and ranges resemble exogenous observations, possibly:

- Multiple weather-station observations.
- Related sensor readings.
- Synchronous environmental measurements.

The evidence does establish:

- There are `25` exogenous features.
- Values are mostly integers or near integers.
- Approximate range: `4 ~ 102`.
- They are recorded hourly alongside `LOAD`.

Without further documentation, the defensible description is:

**w1 through w25 are synchronous exogenous covariates whose physical meanings are unknown.**

## 7. Suitable Tasks

Direct applications include:

- **Univariate forecasting**
  Predict future load from LOAD history.

- **Multivariate forecasting**
  Predict load from LOAD plus w1 through w25.

- **Short-term load forecasting**
  For example, one, 24, or 48 hours ahead.

- **Time-series modeling with exogenous variables**
  For example, Transformer, PatchTST, DLinear, TimesNet, or iTransformer models.

## 8. Less Suitable Tasks

Limitations include:

- **Cross-zone modeling**
  Only one ZONEID is present.

- **Strict multi-entity panel modeling**
  There are no multiple users, zones, or stations.

- **Causal analysis requiring strong semantic interpretation**
  The meanings of w1 through w25 are unclear.

## 9. Recommended Preprocessing

Before experiments:

1. Normalize TIMESTAMP to standard datetime values.
2. Check and fix the sampling frequency to `1H`.
3. Split train/validation/test chronologically, without shuffling.
4. Establish whether w1 through w25 are available in the future.
5. Normalize LOAD and the covariates separately as required by the model.

Future availability is particularly significant:

- Covariates unavailable at prediction time must not be treated as known future inputs.
- Historically observed covariates can be encoder inputs.

## 10. Assessment

This dataset is:

**Single-zone hourly load forecasting with LOAD as the target and 25 exogenous covariates.**

Strengths:

- Complete data.
- Temporal continuity.
- Clear periodicity.
- Well suited to time-series forecasting baselines.

Main caveats:

- Nonstandard TIMESTAMP encoding.
- No local metadata establishing the meanings of w1 through w25.

Before further experiments, produce a separate cleaned version with normalized timestamps.
