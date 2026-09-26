# ModelRecipe v3 实施说明

日期：2026-09-23。高层版本为 `model_recipe.v2`，执行版本为 `recipe_schema_v3`，运行时 revision 为 3。旧 v1/v2 输入和旧 revision 2 checkpoint 不作静默升级。

## 模型与组合

- `diagonal_ssm`：稳定负对角状态矩阵、可学习时间步长、ZOH 离散化及显式状态递推，不是卷积代理。
- `mamba`：Mamba-1 的因果 depthwise convolution、输入相关 Δ/B/C、selective scan、D skip 和 SiLU gate。实现提供完整、分块和逐步计算；窗口默认重置状态。
- `timesblock_encoder`：FFT 非 DC 频率选择、周期二维重排、多核二维卷积、幅值加权和残差。使用逐样本周期选择，避免同批其他样本改变预测；不是完整 TimesNet。
- 新编码器要求 `embedding.type=none`，`representation.layout` 为 `sequence_latent` 或 `channel_sequence`，`readout` 显式选择 `mean`/`last`，`latent_dim` 显式配置。旧编码器使用 `channel_latent` / `none`。
- `parallel_two_branch` 支持 `latent_gate`、`history_time_gate`、`forecast_step_gate`；`decomposition_two_branch` 将历史拆成主支 trend、次支 residual 后分别预测求和。禁止嵌套组合及重复 decomposition。
- history gate 要求相同序列轴、宽度及表示；forecast gate 与 decomposition 当前只支持 point 输出。两支参数独立，但共享 head 配置类型，暂不支持每支任意不同 head 配置。
- 每个 H 独立模型、优化器和 checkpoint；本轮没有跨 H 共享。

三个可执行样例位于 `py/schemas/recipe_{diagonal_ssm,timesblock_encoder,mamba}.example.json`，高层样例为 `py/schemas/model_recipe_v2.example.json`。组合的 `secondary` 显式给出 `embedding`、`backbone`、`representation`；其余配置继承主支。

## 搜索身份与复用

`py/recipe_identity.py` 是权威身份实现。architecture identity 排除说明文字和训练配置；experiment identity 纳入数据内容、时间切分、训练配置、随机种子、精度、后端及运行时代码摘要。仅归一已知等价配置，不把行为相似当作数学等价。

完整训练和 CV 在训练前检查 SQLite 记录，以事务占位、租约心跳及 owner token 防止并发重复执行与过期写入。完成记录须通过 artifact 哈希和当前执行契约校验才复用；失败、过期或损坏产物允许重试。重复结果不作为新独立证据，不新增 runner 结果行、不推进 plateau；Node/OpenCode 连续三次重复后停止并报告 `no_new_candidate`。

Smoke 不复用，v3 smoke 另存 `behavior_probe.json`，包含固定输入的输出/输入梯度摘要、权重摘要及设备精度。此诊断不参与结果缓存或自动等价合并。

```bash
PYTHONPATH=py .neo-cast/runtime/.venv/bin/python py/recipe_identity.py identity py/schemas/recipe_mamba.example.json --input-len 96 --channels 7 --horizon 24
PYTHONPATH=py .neo-cast/runtime/.venv/bin/python py/recipe_identity.py migrate py/schemas/recipe_native.example.json --input-len 96
```

迁移输出新配置及 provenance，要求重新训练；保留旧 latent 宽度和旧 decomposition wrapper，不将已有 checkpoint 转换成新模型。未实现任意表达式的语义等价检测。

## 验证与边界

覆盖状态递推、分块/逐步一致性、因果性、梯度、长序列稳定性、TimesBlock 批次独立性、mask/过去协变量、概率头、组合参数有效性、资源限制、迁移、缓存及三个新模型的独立进程导出回载。Mamba 数值和梯度对照独立公式参考，不宣称官方 CUDA kernel parity。

Mamba 当前可用后端为 `torch_reference`；请求 `cuda_optimized` 会显式报 `UNSUPPORTED_BACKEND`，没有静默替换。资源预算包含参数数目及激活元素上限，但后者不是完整峰值显存预测。自动 mutation 对新编码器目前仅作有界 depth / learning-rate 变动，未实现广泛组合拓扑搜索。

小样本三种子训练结果见 [v3 sanity](recipe_runtime_v3_sanity.md)。新模型机制成立不等于预测效果更好；当前短预算结果没有显示其优于线性基线。没有原生 TimesNet、跨 H 共享或论文指标复现。

参考来源和固定版本见 `py/factory/encoders/PROVENANCE.md`。

## 本轮回归记录

- `neo_cast/npm test`：通过（71 项 Node 测试及完整 Python unittest wrapper）。后续新增 CLI 去重测试与自主循环测试的定向运行共 16 项全部通过。
- `tests.test_recipe_v3`：16 项通过，包含三种独立导出回载、参考公式对照及并发占位。`tests.test_training_identity_v3` 验证同配置不再训练、换种子重新训练、跨 H 参数独立。
- OpenCode `bun run typecheck`：通过。
- OpenCode `bun test test/research`：328 通过、2 失败；与修改前已有失败相同：`hypothesis-evidence-tools` 缺少测试 fixture `quantitative.json`；`service` 的默认 plateau 测试预期 25、实际 7。未将这两项记作通过。另增缓存结果不成为独立指标证据的 service 定向测试通过。
- `git diff --check`：通过。CUDA 后端、论文 benchmark、组合拓扑搜索不在上述通过结论内。
