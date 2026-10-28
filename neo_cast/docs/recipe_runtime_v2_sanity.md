# Runtime v2 Equal-budget Sanity Comparison

2026-09-23, local ETTh1, single-threaded CPU, seed=42. This validates mechanisms rather than a full dataset benchmark, paper reproduction, or model ranking.

Reproduce from `neo_cast/`:

```bash
OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 PYTHONPATH=py \
  .neo-cast/runtime/.venv/bin/python py/recipe_sanity.py ../dataset.zip --steps 30
```

An individual ETTh1.csv is also accepted. The script reads only `dataset/ETTh1.csv` from the archive, leaves other files packed, does not change the active dataset, access ref-test, or promote a champion.

- CSV SHA256:`aaf53becad03ad8a7e93cf96452244f423480df960d769e12d66d4a5c570ddb0`
- Fit the scaler and train on `[0,7000)` within the official training interval; `[7000,8640)` is this sanity check's holdout.
- Seven variables, T=96, H=24, batch=16, Adam lr=0.001, 30 updates, identical sampled windows.
- All models use raw embedding, no dynamic preprocessing, independent temporal fusion, and a true linear head.
- Equal budget means equal updates and data volume, not equal parameter counts. Parameters and measured training/evaluation times follow.

| Backbone | Parameters | First-batch train MSE | Last-batch train MSE | Holdout MSE | Holdout MAE | Seconds |
|---|---:|---:|---:|---:|---:|---:|
| linear | 7,768 | 0.986675 | 0.505391 | 0.542701 | 0.494317 | 0.191 |
| gated_depthwise_conv | 2,360 | 0.935951 | 0.608670 | 0.988015 | 0.627812 | 0.195 |
| timesnet_lite | 8,481 | 0.854451 | 0.511015 | 0.868469 | 0.574005 | 0.377 |

All three paths have finite losses, nonzero updates, and distinct parameter graphs. The first and last batches differ; decreasing loss only checks execution and does not establish convergence. TimesNet-lite is marked `paper_derived`; gated depthwise convolution is not labeled SSM. Timing varies by hardware; the script emits actual module manifests and parameter-graph digests.
