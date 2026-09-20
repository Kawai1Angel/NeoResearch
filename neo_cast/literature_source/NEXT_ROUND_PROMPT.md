# NeoResearch 文献检索源：下一轮执行 Prompt

请继续完善 NeoResearch 的框架级文献检索源。

## 工作位置与约束

工作目录：

```text
/mnt/d/kawai10726/work/codes/kawai1/neoresearch
```

开始前请完整阅读：

- 根目录 `AGENTS.md`
- `neo_cast/AGENTS.md`
- `neo_cast/literature_source/README.md`
- `neo_cast/literature_source/source_policy.json`
- `neo_cast/py/literature_source.py`

执行时遵守以下约束：

- 当前工作树可能包含用户未提交的修改，不要覆盖、回退或整理无关改动。
- 使用 `apply_patch` 修改文件。
- 检索源属于框架，不由 Literal/Literature Agent 在运行时建立。
- 只下载公开、合法可访问的 PDF，不绕过付费墙。
- 主会、Workshop、预印本必须分开，不能把 Workshop 自动识别为主会。
- 社区清单只能用于发现候选，不能作为最终会议归属依据。
- 不要从头重建现有设计，应在当前实现上继续。

## 当前基线

已有框架组件：

- 构建器：`neo_cast/py/literature_source.py`
- 收集策略：`neo_cast/literature_source/source_policy.json`
- 论文记录 Schema：`neo_cast/literature_source/paper_record.schema.json`
- 测试：`neo_cast/py/tests/test_literature_source.py`
- 本地生成目录：`neo_cast/.neo-cast/literature-source/`

当前目录统计：

| 指标 | 数量 |
|---|---:|
| 论文总数 | 200 |
| `core` | 184 |
| `adjacent` | 16 |
| Tier A | 182 |
| Tier B | 18 |
| 已下载 PDF | 183 |
| PDF 总大小 | 约 636.6 MiB |
| `no_public_pdf` | 9 |
| `failed` | 8 |
| 官方 proceedings 核验 | 79（39.5%） |
| OpenAlex ID | 145 |
| DOI | 128 |
| arXiv ID | 157 |
| 代码链接 | 134 |

年份分布：

| 年份 | 数量 |
|---|---:|
| 2023 | 6 |
| 2024 | 47 |
| 2025 | 91 |
| 2026 | 56 |

会议分布：

| 会议 | 数量 |
|---|---:|
| ICML | 56 |
| NeurIPS | 37 |
| ICLR | 33 |
| AAAI | 25 |
| KDD | 22 |
| IJCAI | 9 |
| WWW | 9 |
| ICDE | 5 |
| VLDB | 3 |
| WSDM | 1 |

现有官方适配：

- ICLR 2024–2026
- ICML/PMLR 2023–2025
- NeurIPS 2023–2024
- 两条 NeurIPS 2025 官方覆盖项

现有发现源：

- TSCenter `awesome-time-series-papers`：191 条
- qhliu `awesome-time-series-analysis`：23 条
- 两者重叠 14 条
- 当前来源明显过度依赖 TSCenter

## 本轮核心目标

把当前“社区清单驱动的论文集合”提升为“官方目录驱动、覆盖率可以量化的检索源”。

优先目标：

1. 将官方核验率从 39.5% 提升到尽可能接近 90%。
2. 补齐明显不足的 2023 年论文，目前只有 6 篇。
3. 为 AAAI、IJCAI、KDD、WWW、WSDM、VLDB、ICDE 增加官方或权威出版目录适配。
4. 正式接入更多独立发现源，降低 TSCenter 单来源偏差。
5. 生成可审计的 coverage report，明确哪些会议和年份已经扫描，哪些仍未覆盖。
6. 保持构建过程可重复、增量、版本固定和可审计。

## Phase 1：官方会议扫描器

优先实现：

- AAAI：AAAI OJS proceedings，2023–2026
- IJCAI：官方 proceedings，2023–2026
- VLDB：PVLDB 官方卷期
- NeurIPS：补齐 2025，能获取时补 2026
- ICML：补齐正式发布的 2026 PMLR volume
- KDD、WWW、WSDM：ACM 官方元数据；PDF 不公开时只收元数据
- ICDE：官方程序、DBLP、Crossref 或 IEEE 元数据

采用以下流程：

```text
官方会议全部论文
    ↓
标题和摘要粗筛
    ↓
时序相关性分类
    ↓
规则复核
    ↓
加入候选目录
```

不要只搜索标题中的 `forecasting`，还要覆盖：

- time series
- temporal prediction
- sequence prediction
- spatio-temporal
- probabilistic forecasting
- normalization
- non-stationarity
- distribution shift
- concept drift
- frequency domain
- decomposition
- foundation model
- state-space model
- exogenous variables
- uncertainty / calibration

每条官方匹配应保留：

- official source id
- venue
- year
- track
- official title
- landing URL
- PDF URL
- title similarity
- proceedings snapshot checksum
- verification status

## Phase 2：增加独立发现源

将以下来源从“仅参考”升级为正式 discovery source：

- `TongjiFinLab/awesome-time-series-forecasting`
- `THUML/Time-Series-Library`

继续保留固定 commit revision、README checksum、来源栏目和原始 URL。

解析时检查以下当前可能漏收的重要工作：

- DLinear
- Koopa
- FreTS
- One Fits All
- TimesFM
- Moirai
- Time-MoE
- Chronos
- TiDE
- TSMixer

不要无条件将它们加入顶会主会池。必须根据正式出版情况分别放入：

- `accepted_core`
- `accepted_adjacent`
- `influential_external`
- `watchlist`

如果本轮修改池结构，需要同步修改：

- policy
- JSON Schema
- README
- 测试
- 生成统计

## Phase 3：引用网络补充

在官方扫描和社区清单接入完成后，再使用 OpenAlex 做一跳引用扩展。

建议种子：

- PatchTST
- DLinear
- TimesNet
- iTransformer
- TimeMixer
- TimesFM
- Moirai
- Chronos
- Time-MoE

候选过滤条件：

- 年份不早于当前策略边界。
- 属于目标会议，或进入 `influential_external` / `watchlist`。
- 与预测机制、评测或数据现象有关。
- 不因为出现 `time` 或 `temporal` 就自动收录。

## Coverage Report

构建完成后生成机器可读和人类可读的报告，例如：

```text
.neo-cast/literature-source/coverage.json
.neo-cast/literature-source/COVERAGE.md
```

至少统计：

- 按会议、年份的候选数
- 官方目录扫描状态
- 官方核验数和核验率
- `curated_venue_claim` 数量
- 未匹配候选
- 新增、删除、变更记录
- PDF `downloaded` / `failed` / `no_public_pdf`
- DOI、OpenAlex、arXiv、代码链接覆盖率
- 各 discovery source 的独有贡献和重叠
- Workshop、预印本、主会的数量
- 已知漏收或需要人工复核的条目

不要用“收集了多少篇”代替覆盖率。

## PDF 策略

下载优先级：

1. 官方 proceedings PDF
2. arXiv
3. PMLR、NeurIPS 等公开存档
4. 作者或机构公开仓库
5. 其他合法 OA 地址

对于 ACM/IEEE 付费页面：

- 保留 DOI、landing page 和出版信息。
- 尝试寻找合法公开作者版本。
- 找不到时标记 `no_public_pdf`。
- 不绕过访问限制。

当前 17 条未成功下载的记录应进入独立重试队列，但不能因为没有 PDF 而从目录中删除。

## 质量要求

- 论文 ID 必须稳定。
- 构建必须支持缓存和增量重跑。
- 网络请求需要有限重试、退避和失败记录。
- 去重不能只依赖标题完全一致；需要结合标准化标题和 DOI/OpenAlex/arXiv。
- 模糊匹配必须设置阈值并保留匹配分数。
- 不得把 Workshop 自动提升为主会。
- curated claim 与 official verification 必须显式区分。
- 不要把 Literal Agent 的 claim/mechanism extraction 混入本轮工作。
- 生成物继续放在 `.neo-cast` 下，不提交 PDF 和缓存。
- framework 配置、Schema、README、测试需要进入 npm package。

## 验证要求

至少运行：

```bash
cd neo_cast
python3 -m unittest py.tests.test_literature_source -v
python3 -m py_compile py/literature_source.py
python3 -m json.tool literature_source/source_policy.json
python3 -m json.tool literature_source/paper_record.schema.json
npm pack --dry-run --cache .artifacts/npm-cache
git diff --check
```

重新构建完整检索源后，还要检查：

- catalog 记录数与 manifest 一致
- `paper_id` 和标准化标题无重复
- downloaded PDF 文件数量与目录一致
- 所有 PDF 以 `%PDF` 开头
- 文件大小和 SHA-256 与记录一致
- 没有未被 catalog 引用的孤儿 PDF

仓库级 `npm run test:python` 当前存在一个与本任务无关的已知失败：

```text
test_research_trace.ResearchTraceTest
期望 verification_plan 包含 val_avg_mse
```

不要为了本任务修改这个无关测试；但最终报告中要区分新增测试结果与该已有失败。

## 最终交付

完成后报告：

1. 修改了哪些文件。
2. 新增了哪些官方会议适配器。
3. 新增论文数及去重后总数。
4. 官方核验率从多少提升到多少。
5. 各年份、会议、池的统计。
6. PDF 成功、失败、无公开版本数量。
7. 新发现的重要漏收论文。
8. 尚未解决的会议和年份覆盖缺口。
9. 所有测试和完整性检查结果。
10. 下一轮是否已经适合进入 claim/mechanism extraction。

请实际执行检索、代码修改、下载和验证，不要只给设计建议。
