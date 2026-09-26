# Runtime v2 同预算 sanity comparison

2026-09-23，本地 ETTh1，CPU 单线程，seed=42。这是机制验收，不是完整数据集 benchmark、论文复现或模型优劣结论。

复现命令（从 `neo_cast/` 运行）：

```bash
OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 PYTHONPATH=py \
  .neo-cast/runtime/.venv/bin/python py/recipe_sanity.py ../dataset.zip --steps 30
```

也可传入单独的 ETTh1.csv。脚本只读取 archive 中的 `dataset/ETTh1.csv`，不解压其他文件、不修改 active dataset、不访问 ref-test、不晋升 champion。

- CSV SHA256：`aaf53becad03ad8a7e93cf96452244f423480df960d769e12d66d4a5c570ddb0`
- 从官方 train 区间取 `[0,7000)` 拟合 scaler 和训练，`[7000,8640)` 为此次 sanity 的留出段。
- 七变量，T=96、H=24，batch=16，Adam lr=0.001，30 次更新，完全相同的采样窗口。
- 统一 raw embedding、无动态 preprocessing、独立 temporal fusion、真实 linear head。
- 同预算指相同更新数和数据量，不是相同参数量；参数量和实测训练+评估耗时如下。

| Backbone | 参数量 | 首批 train MSE | 末批 train MSE | 留出 MSE | 留出 MAE | 秒 |
|---|---:|---:|---:|---:|---:|---:|
| linear | 7,768 | 0.986675 | 0.505391 | 0.542701 | 0.494317 | 0.191 |
| gated_depthwise_conv | 2,360 | 0.935951 | 0.608670 | 0.988015 | 0.627812 | 0.195 |
| timesnet_lite | 8,481 | 0.854451 | 0.511015 | 0.868469 | 0.574005 | 0.377 |

三条路径均有有限 loss、非零训练更新和不同参数图。首末批不是同一批次，loss 下降仅作运行检查，不代表收敛。TimesNet-lite 标记 `paper_derived`；门控深度卷积不标记为 SSM。不同硬件的耗时可变，脚本同时输出实际 module manifest 与参数图 digest 供核对。
