# V3 Small-sample Training Validation

2026-09-23, ETTh1, source SHA256 `aaf53becad03ad8a7e93cf96452244f423480df960d769e12d66d4a5c570ddb0`.

Train rows `[0,7000)`, independent holdout `[7000,8640)`, T=96, H=24, batch=16; single-threaded CPU, Adam lr=0.001, 30 updates, seeds 42/43/44. Sampled windows and update counts match; parameter counts are not balanced. All use revision 3 and never access ref_test.

| Model/composition | Parameters | Holdout MSE mean +/- standard deviation |
| --- | ---: | ---: |
| linear | 7768 | 0.5656 ± 0.0243 |
| gated_depthwise_conv | 2360 | 0.9491 ± 0.0278 |
| timesnet_lite | 8481 | 0.9489 ± 0.1762 |
| diagonal_ssm | 1152 | 1.4682 ± 0.0278 |
| timesblock_encoder | 3408 | 1.4569 ± 0.0568 |
| mamba | 1712 | 1.4520 ± 0.0634 |
| decomposition: linear + diagonal_ssm | 8920 | 0.8159 ± 0.0275 |
| decomposition: linear + timesblock_encoder | 11176 | 0.8314 ± 0.0314 |
| decomposition: linear + mamba | 9480 | 0.8222 ± 0.0175 |
| diagonal_ssm + mamba, latent gate | 2784 | 1.4461 ± 0.0256 |
| diagonal_ssm + mamba, history gate | 2161 | 1.4610 ± 0.0277 |

Standard deviation is the population standard deviation across three seeds. This checks execution of training and evaluation only. New models did not beat the linear baseline; these results establish neither forecasting gains nor rankings after adequate convergence. No hyperparameter search, parameter balancing, long training, or paper reproduction was performed.

Reproduce with `PYTHONPATH=py .neo-cast/runtime/.venv/bin/python py/recipe_sanity.py --help`. Default seeds are 42, 43, 44; result JSON includes each seed's metrics, parameter graph, and timing. `process_peak_rss_kib` is the process-wide cumulative high-water mark, not each model's independent peak memory.
