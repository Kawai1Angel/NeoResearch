# V3 小样本训练验证

2026-09-23，ETTh1，原始文件 SHA256 `aaf53becad03ad8a7e93cf96452244f423480df960d769e12d66d4a5c570ddb0`。

训练行 `[0,7000)`，独立留出行 `[7000,8640)`，T=96，H=24，batch=16；CPU 单线程，Adam lr=0.001，30 次更新，种子 42/43/44。相同采样窗口和更新次数，参数量没有配平。全部使用 revision 3；不访问 ref_test。

| 模型/组合 | 参数数 | 留出 MSE 均值 ± 标准差 |
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

标准差为三个种子的总体标准差。本次仅确认训练机制和评估流程可运行；新模型没有超过线性基线，不能据此宣称预测收益，也不能作为充分收敛后的模型排名。未进行超参搜索、参数预算配平、长预算或论文复现。

复现入口：`PYTHONPATH=py .neo-cast/runtime/.venv/bin/python py/recipe_sanity.py --help`，默认种子为 42、43、44，结果 JSON 包含每个种子的指标、参数图和耗时。`process_peak_rss_kib` 是整个进程累计高水位，不可当作每个模型独立峰值内存。
