# Agent 执行手册：数据集任务、Intent 澄清、监控与修复续跑

核对日期：2026-10-15。面向操作 NeoResearch 的执行 agent，适用于当前仓库的源码版本。数据集位于研究项目根目录的 `dataset/`，用户预先准备的两阶段回复位于 `response/1/` 和 `response/2/`。标准实验和 NeoResearch-zero 消融实验全程使用 DeepSeek API，请求模型名固定为 `deepseek-v4-flash`。

## 1. 任务与执行约定

你的任务是启动 NeoResearch，为指定数据集建立一个研究任务，在 Intent 阶段依次提交对应的 `response/1/<数据集名>.txt` 和 `response/2/<数据集名>.txt`，确认两次修改已落库后 approve 最新 Intent checkpoint，然后持续运行到模型、评估结果和最终报告全部生成。

进入数据分析后，每 **20 分钟**做一次完整状态巡检。发现异常时自行诊断、修复、验证并续跑同一个任务。完成修复或发出阶段报告后仍要继续执行，直到达到本文的完成标准。不要只提供建议，也不要只启动一个采样脚本后退出。

`response/` 中的文本是用户已提供的回复与修改要求，直接读取并提交，不再要求用户重新回答，也不替用户编造内容。`response/2/` 中明确修改的字段覆盖初始任务设置及第一阶段对应字段；未修改的字段保留。Intent 确认后，后续已有要求范围内的普通 checkpoint、依赖修复和代码缺陷修复由你处理，不需要反复请求用户确认。保留最终确认的数据集、目标列、切分、评估协议和搜索预算，不通过放宽规则或伪造状态来完成任务。

本手册描述需要执行的工作，不表示这些步骤已经运行成功。

## 2. 执行前确定参数并保存状态

执行前记录这些参数。用户未指定数据集文件时，列出 `dataset/` 中的文件让用户选定；不要默认把另一个 CSV 当成指定数据集。

| 参数 | 含义 | 示例，需按本次任务替换 |
|---|---|---|
| `PROJECT_ROOT` | 包含 `dataset/` 的研究项目绝对路径 | 当前仓库根目录 |
| `SOURCE_ROOT` | 含 `opencode/`、`neo_cast/` 的源码根目录 | 通常与 `PROJECT_ROOT` 相同 |
| `DATASET_FILE` | 指定 CSV 的绝对路径 | `$PROJECT_ROOT/dataset/ETTh1.csv` |
| `RESPONSE_1` | 第一阶段回复文件 | `$PROJECT_ROOT/response/1/ETTh1.txt` |
| `RESPONSE_2` | checkpoint 阶段修改文件 | `$PROJECT_ROOT/response/2/ETTh1.txt` |
| 目标列、时间列 | 从用户要求与 CSV 表头确认 | `OT`、`date` |
| context / horizon | 输入窗口 / 预测长度，以文件修改后的值为准 | ETTh1 context 96；NP/PJM context 168、horizon 24 |
| 切分、主指标 | 用户最终确认的评估协议 | ETTh1 时间顺序 `6:2:2`；主指标沿用已确认值 |
| 搜索轮数 | NAS 迭代上限，以第二阶段文本为准 | 当前四组第二阶段回复均指定 `25` 轮 |
| 两阶段内容 | 用户已准备的回复与修改 | 读取两个同名 txt 的完整内容 |
| 研究变体 | `standard` 或 `zero`，创建时显式设置 | zero 消融设为 `zero` |
| 模型与运行环境 | 全阶段固定 API 模型、实际 Neo-Cast runtime | `deepseek/deepseek-v4-flash` |

初始化变量。以下示例假定当前目录就是源码及研究项目根目录：

```bash
export PROJECT_ROOT="$(pwd -P)"
export SOURCE_ROOT="$PROJECT_ROOT"
export DATASET_FILE="$PROJECT_ROOT/dataset/ETTh1.csv"
export DATASET_NAME="$(basename "$DATASET_FILE" .csv)"
export RESPONSE_1="$PROJECT_ROOT/response/1/$DATASET_NAME.txt"
export RESPONSE_2="$PROJECT_ROOT/response/2/$DATASET_NAME.txt"
export NEO_CAST_ROOT="$SOURCE_ROOT/neo_cast"
export NEO_CAST_PYTHON="$NEO_CAST_ROOT/.neo-cast/runtime/.venv/bin/python"
export RESEARCH_API='http://127.0.0.1:4096'
export RESEARCH_VARIANT=zero # 标准对照组改为 standard
export CONTROL_DIR="$PROJECT_ROOT/.neo-research/agent-control/$RESEARCH_VARIANT/$DATASET_NAME"
mkdir -p "$CONTROL_DIR"
test -f "$DATASET_FILE"
test -s "$RESPONSE_1"
test -s "$RESPONSE_2"
```

`ETTh1.csv` 是示例，执行 agent 必须替换为本次指定文件。项目与源码分开时分别设置两条根路径。

按 CSV 文件去掉 `.csv` 后的名称匹配两个 txt，大小写和拼写保持一致。当前目录的对应关系如下，实际执行仍以文件内容为准：

| 数据集 | 第一阶段回复 | 第二阶段修改 | 第二阶段明确设置 |
|---|---|---|---|
| `dataset/ETTh1.csv` | `response/1/ETTh1.txt` | `response/2/ETTh1.txt` | context 96、时间顺序切分 6:2:2、25 轮 |
| `dataset/NP.csv` | `response/1/NP.txt` | `response/2/NP.txt` | context 168、horizon 24、25 轮 |
| `dataset/PJM.csv` | `response/1/PJM.txt` | `response/2/PJM.txt` | context 168、horizon 24、25 轮 |
| `dataset/mopex.csv` | `response/1/mopex.txt` | `response/2/mopex.txt` | context 96、25 轮 |

`mopex` 使用三处同名文件匹配。文件缺失或为空时，记录明确阻塞并补齐对应文件，不能借用另一个数据集的回复。

在 `CONTROL_DIR` 中保存 `execution-state.json` 和 `monitor.md`，至少包含：数据集和两个回复文件的绝对路径与 SHA-256、两份原文、每阶段提交时间/状态、实际启动属于哪条 Intent 分支、最终目标列/context/horizon/切分/指标/预算、研究变体、API base URL、请求模型名、任务的 `metadata.sessionModel`、实际 runtime、taskID、rootSessionID、cycleID、operationID、最新 checkpoint ID、启动方式、事件游标、上次及下次完整巡检时间，以及修复记录。不要保存密钥。

taskID 确定后始终使用同一个完整 ID。任务重启、连接恢复、进程重启都不意味着创建新任务。

标准组与 zero 组各创建独立任务，分别保存 taskID、控制目录和产物；同一组的失败修复继续使用原 taskID。不能把标准组已有候选、baseline、champion 或运行记录导入 zero 任务充当初始结果。

## 3. 检查环境，从 `bun run dev` 启动

先阅读本仓库 `AGENTS.md` 及涉及子项目的规则。依赖未准备好时，按 [安装到建立文献库手册](NeoResearch操作手册_从Bun安装到建立文献库.md) 完成安装和模型配置。本文主流程从可运行的源码环境开始。

### 3.1 全阶段统一使用 DeepSeek API

Intent、数据分析中的 LLM 调用、文献选择/提取/架构提炼/审核/修订、HypoPlanner、模型设计、反思和报告中的 LLM 调用，均使用 `deepseek-v4-flash`。模型训练和评估仍由本地 Neo-Cast Python runtime 执行。标准组与 zero 组采用相同 API 配置，不混用其他模型，也不在失败时切换模型。

密钥可通过进程环境 `DEEPSEEK_API_KEY` 提供，或保存在 `$PROJECT_ROOT/.env` 中：

```text
DEEPSEEK-API-KEY=你的实际DeepSeek密钥
```

已有文件也可使用 `DEEPSEEK_API_KEY`。若仅有旧字段 `LLM-API-KEY`，先确认它属于 DeepSeek，再迁移为上述专用字段；不要把其他 provider 的密钥用于本实验。带连字符的字段不能直接用 Bash 的 `source .env` 加载；`load_env_local` 只加载 `.env.local`。密钥只进入进程环境，不打印、不写入日志、报告或版本控制。

必须同时配置三条调用路径：

| 调用路径 | 固定配置 |
|---|---|
| 原生研究 agent / TUI 会话 | provider `deepseek`，model `deepseek-v4-flash`，任务 `metadata.sessionModel` 显式绑定同一组合 |
| Neo-Cast 兼容接口与模型设计 | provider `openai-compatible`，model `deepseek-v4-flash`，base URL `https://api.deepseek.com/v1` |
| 独立文献接口 | 同一 base URL、同一模型和 DeepSeek 密钥，不能保留旧模型覆盖项 |

按 [DeepSeek 官方接口说明](https://api-docs.deepseek.com/)，`deepseek-v4-flash` 目前仍可请求，但属于旧别名，服务端实际由 DeepSeek-V4.1-Flash 承接。本实验按要求保留请求名 `deepseek-v4-flash`；记录调用日期及可取得的响应 `model`，不要将别名当成固定历史权重版本。

在持久 PTY / tmux 中，先加载本地环境，再设置本实验配置，避免 `.env.local` 覆盖模型或密钥。以下代码中的密钥输出由命令替换捕获，不能单独执行密钥读取段，也不能打开 shell tracing：

```bash
cd "$SOURCE_ROOT"
source ./scripts/common.sh
load_env_local "$SOURCE_ROOT"
export_local_dev_environment "$SOURCE_ROOT"
ensure_local_dev_dirs
set +x
if ! DEEPSEEK_API_KEY="$(python3 - <<'PY'
import os
from pathlib import Path

key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
source = Path(os.environ["PROJECT_ROOT"]) / ".env"
if not key and source.is_file():
    for line in source.read_text(encoding="utf-8-sig").splitlines():
        name, sep, value = line.strip().removeprefix("export ").partition("=")
        if sep and name.strip() in ("DEEPSEEK-API-KEY", "DEEPSEEK_API_KEY"):
            key = value.strip().strip("\"'")
            if key:
                break
if not key:
    raise SystemExit("缺少 DeepSeek API Key；先配置后再启动")
print(key)
PY
)"; then
  exit 1
fi
export DEEPSEEK_API_KEY
export NEO_CAST_LLM_API_KEY="$DEEPSEEK_API_KEY"
export NEO_RESEARCH_LITERATURE_LLM_API_KEY="$DEEPSEEK_API_KEY"
unset ANTHROPIC_BASE_URL OPENAI_BASE_URL
export NEO_CAST_LLM_PROVIDER=openai-compatible
export NEO_CAST_LLM_MODEL=deepseek-v4-flash
export NEO_CAST_LLM_BASE_URL=https://api.deepseek.com/v1
export NEO_CAST_LLM_MAX_TOKENS=32768
export NEO_RESEARCH_LITERATURE_LLM_PROVIDER=openai-compatible
export NEO_RESEARCH_LITERATURE_LLM_MODEL=deepseek-v4-flash
export NEO_RESEARCH_LITERATURE_LLM_BASE_URL=https://api.deepseek.com/v1
export NEO_RESEARCH_LITERATURE_LLM_MAX_TOKENS=32768
export NEO_RESEARCH_LITERATURE_LLM_THINKING=disabled
export NEO_RESEARCH_LITERATURE_PAPER_MODE=reuse_only
export NEO_CAST_CV_MAX_PARALLEL_FOLDS=4
```

`ANTHROPIC_BASE_URL` 和 `OPENAI_BASE_URL` 会覆盖通用 LLM 的 base URL，因此在本实验进程中清除。`.env` 的密钥值应独占一行，不添加行尾注释。

环境变量不足以覆盖已有 JSON 配置。通用配置优先级由低到高为：默认值、环境变量、`~/.config/neo-cast/config.json`、`$PROJECT_ROOT/.neo-cast/config.json`、任务 runtime 所指 runner 的 `.neo-cast/config.json`。在实际 runner 配置中合并以下 `llm` 字段，保留其他配置、不写入密钥；若 task 未配置 runner，也要在项目配置中合并：

```json
{
  "llm": {
    "provider": "openai-compatible",
    "model": "deepseek-v4-flash",
    "base_url": "https://api.deepseek.com/v1",
    "max_tokens": 32768
  }
}
```

在研究项目的 `opencode.json` / `opencode.jsonc` 中合并以下设置，固定原生会话与标题等辅助调用；保留已有其他配置。已有 agent 的独立 `model` 覆盖项也需统一检查并改为同一模型：

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "small_model": "deepseek/deepseek-v4-flash",
  "provider": {
    "deepseek": {
      "options": {
        "baseURL": "https://api.deepseek.com/v1",
        "apiKey": "{env:DEEPSEEK_API_KEY}"
      }
    }
  }
}
```

`{env:DEEPSEEK_API_KEY}` 是配置引用，不是密钥明文。启动后核对 provider 注册表中存在精确的 `deepseek/deepseek-v4-flash`；若本地目录未收录该模型，按实际 API 能力补充 `provider.deepseek.models` 注册，不能用另一个模型名顶替。TUI 切换模型只影响默认选择，已有任务可能仍绑定旧 `metadata.sessionModel`，必须回读核对。本手册创建的新实验任务在第 4.2 节显式绑定模型；混用过模型的历史任务不能作为本次“全程同模型”的实验结果。

本次实验并发设为 `budget.maxParallel=1`，四折 CV 并发为 `4`，四个数据集依次运行。更新预算时提交完整原预算，只修改目标字段，保留 25 轮及其他约束。用户要求暂停时，配置修改完成后保持暂停，等待续跑指令。

### 3.2 文献策略与证据读取

`reuse_only` 跳过新论文 PDF 预览、读取、原理提取和建库，只复用已有验证知识卡；保留卡片匹配、引用校验、架构提炼与审核，主库和可核验的历史卡仍按现有规则筛选。没有可用证据时如实记录缺口，不伪造审核结论。文献审核使用上述独立配置，模型仍为 `deepseek-v4-flash`，关闭思考模式并使用 JSON 输出；`NEO_RESEARCH_LITERATURE_LLM_THINKING=disabled` 时不发送 `reasoning_effort`。模型、输出选项和复用策略参与缓存标识，结果 manifest 记录 `paperMode`，不能混用旧的完整提取缓存。缺少文献密钥时直接报错，不借用其他 provider 的凭据。

审核保留格式及上下文校验合格的逐条结果，包括合格的否决意见，仅重试失败或缺失条目。单条审核发送该条相关卡片的完整证据与反证；其他无关卡片不重复拼接。同模型配置下也不能跨不匹配的证据版本复用审核收据。

缺省 `NEO_RESEARCH_LITERATURE_PAPER_MODE=extract_missing` 保留原来的补充提取流程；本次任务采用 `reuse_only`，四个数据集仍保持 25 轮搜索上限。配置修改不等于续跑，已暂停任务应保留暂停状态，等待用户明确恢复。

规划与模型设计默认接收已审核并准入的架构结论、适用条件及 AND/OR 关系、限制、可实现建模类别与迁移边界，以及卡片 ID、版本和可引用角色。完整卡片、原文引用、作者实验和审核历史保存在已有证据 artifact 中，不在每轮默认重复发送。需要核对具体原文时，使用 `read_task_evidence` 指定 `cardID`、`cardRevision` 和 `section=knowledge|sources|review`，可用 `sourceIDs` 选择来源；每次默认读取 4000 字符、最多 12000 字符，按 `nextOffset` 翻页。这只读已有证据，不启动新论文读取或建库。摘要超过 120000 字符会在调用模型前报错，不能静默删掉条件或放宽引用准入。

反思同样从当前架构审核准入集合读取知识，默认仅返回本轮假设引用及其准入结论所需的互补来源；旧的检索审计条目不能用于增加知识卡置信度。`experiment_results()` 默认读取本轮尝试及预先声明的对照；没有声明对照时，champion 只能作为观察性参照。其他运行按 `runID`、`candidateID`、`hypothesisID` 或显式分页查询。上一轮反思默认仅发结构化结果，`full=true` 才读取原文。反思阶段的 `read_experiences` 默认读取本任务最多 3 条摘要，使用 `experienceID` 和 `includeFacts=true` 按需查询完整事实。`read_knowledge_cards` 返回断言、条件、边界、版本和置信度摘要；原文仍通过 `read_task_evidence` 分页只读，不默认拼接完整卡片和所有历史实验。置信度确认继续校验当前运行、准入来源版本、可归因事实与重复调用，不因压缩而放宽。

### 3.3 检查并启动同一个服务

快速检查：

```bash
bun --version
node --version
test -x "$NEO_CAST_PYTHON"
"$NEO_CAST_PYTHON" -c 'import numpy, pandas, torch, pymupdf, jsonschema; print("runtime ready")'
```

检查 CSV 表头、少量样本和行数，确认目标列、时间列实际存在。允许查看数据概况；Intent 确认前不要手工启动训练或完整数据分析来绕过 checkpoint。

在完成第 3.1 节的同一个 shell 中启动，固定 TUI 选中的模型。不要在加载上述配置后再次执行 `load_env_local`：

```bash
export PATH="$NEO_CAST_ROOT/.neo-cast/runtime/.venv/bin:$PATH"
cd "$SOURCE_ROOT/opencode"
bun run dev "$PROJECT_ROOT" --model deepseek/deepseek-v4-flash --hostname 127.0.0.1 --port 4096
```

加载 `.env.local` 后核对 `NEO_CAST_ROOT` 是否指向本次 runner；若采用其他 runner，同步更新 `NEO_CAST_PYTHON`。不要覆盖或打印现有密钥。

显式项目路径确保 TUI 和 worker 使用包含 `dataset/` 的研究目录；显式端口使同一个 TUI worker 提供可查询的 HTTP API。未指定端口时默认可能使用内部 RPC，不能直接访问 `127.0.0.1:4096`。

保留 PTY 会话或 tmux 会话标识。不要让长时执行工具因为默认超时而终止 TUI。后续监控连接这个服务，**不要另起一个 `serve` 进程执行同一个任务**。

如果端口已被本次任务占用，先识别现有服务并连接；如果属于其他任务，使用一个空闲端口并更新 `RESEARCH_API`。

## 4. 创建标准或 zero 研究任务

### 4.1 标准组的 TUI 创建方式

本小节适用于标准组；zero 消融使用第 4.2 节的显式创建方式。进入 NeoResearch 主页，确认当前模型为 `deepseek/deepseek-v4-flash`。提交研究目标时使用独立的**绝对 CSV 路径 token**，不要只说“使用 dataset”。

下面是 ETTh1 初始任务示例。将路径替换为 `DATASET_FILE` 的真实值，按本次数据集选择目标列；例如 mopex 的目标列按 CSV 与 `response/1/mopex.txt` 核对，不能直接套用 OT。此时不要把两份回复提前合并进初始消息，必须保留第 5 节的两次独立交互：

```text
请使用 /ABS/PROJECT/dataset/ETTh1.csv 开展时间序列预测研究，target=OT context=336 horizon=96，初始按时间顺序采用训练/验证/测试 7:1:2 划分，主指标 cv_avg_mse，辅助指标 cv_std_mse 和 val_avg_mse，连续 7 轮无提升按现有停止策略处理。无硬推理延迟限制，模型参数不超过 2000 万，指标相近时优先简单模型，最终仅在本地生成模型和研究报告。使用苏格拉底模式，在 Intent 阶段等待回复或任务信息修改；我将依次发送两条消息，其中第二条可以修改窗口、划分和搜索预算。两次消息处理完成前不要批准 Intent checkpoint，也不要进入数据分析；最终确认后自主完成数据分析、文献检索、搜索、评估与导出。
```

在交互模式弹窗选择 **苏格拉底 / Socratic**。该模式适合前期澄清、后续自主执行；Companion 会额外产生多个人工 checkpoint。

初始 context、horizon 和切分仅为本示例的初始值，最终以两份回复处理后的 taskSpec 为准。当前 TUI 的 CSV 文本解析器直接解析 `target/context/horizon/runs/time` 等字段，但不直接解析迭代数。**第二阶段文本中的搜索轮数必须由 IntentAgent 写入 `budget.loop.maxIterations`；当前四份第二阶段文件均要求 25 轮。** 不要使用 `runs=25` 表示 25 轮。

创建成功后获取完整 taskID、rootSessionID 和实际 dataset path，立即写入执行状态文件。可用第 7 节的小工具列出任务，结合标题、时间、数据集路径和 TUI 选中项匹配；不能直接取历史任务列表第一条而不核对。

### 4.2 NeoResearch-zero 消融：显式设置变体与模型

zero 的唯一变体开关是 `taskSpec.metadata.researchVariant="zero"`，默认或省略时为 `standard`。它取消预置 baseline 候选、baseline 选择及初始化运行；HypoPlanner 从第一轮提出自主假设、选择一个进入模型设计，再执行实验。第一轮是 `exploratory`；后续可将本任务已验证的自主模型作为明确声明的对照。文献、数据分析、模型实现、评估和导出流程仍保留。

在 TUI 自然语言消息中写“zero”不等于设置开关；`--mode zero` 也无效。CLI 支持 `research create --research-variant zero` 和 `research vibe --research-variant zero`，但本手册需要保留两次 Intent 回复，采用下面的 API 创建流程，避免直接进入自动搜索。

为保证消融条件一致，推荐标准组也使用此流程，仅将第 2 节的 `RESEARCH_VARIANT` 设为 `standard`，并使用独立 `CONTROL_DIR`。同一数据集两组的初始 taskSpec、两份回复、最终切分/窗口/指标、25 轮预算、训练配置及随机种子、文献卡库快照、`reuse_only` 策略、API 模型和并发设置均保持一致。两组任务各自运行并产出模型，不共享候选或运行结果；分别报告实际训练次数与 API 用量，25 轮上限不表示两组计算量完全相等。

以下在另一个已设置第 2 节变量的控制终端执行，连接第 3 节启动的同一个服务。`TARGET_COLS` 按本次 CSV 与第一阶段回复核对；示例初始值与第 4.1 节一致，之后仍必须独立处理两份回复：

```bash
export TARGET_COLS=OT # mopex 等数据集须替换为真实目标列，多列用逗号分隔
python3 - <<'PY'
import json
import os
from pathlib import Path

variant = os.environ["RESEARCH_VARIANT"]
assert variant in ("standard", "zero")
dataset = str(Path(os.environ["DATASET_FILE"]).resolve())
targets = [v.strip() for v in os.environ["TARGET_COLS"].split(",") if v.strip()]
assert targets, "必须指定目标列"
goal = (f"请使用 {dataset} 开展时间序列预测研究，目标列为 {','.join(targets)}。"
        "初始 context=336 horizon=96，时间顺序训练/验证/测试 7:1:2，"
        "主指标 cv_avg_mse，辅助指标 cv_std_mse 和 val_avg_mse。"
        "连续 7 轮无提升按现有停止策略处理，模型参数不超过 2000 万，无硬推理延迟限制，"
        "指标相近时优先简单模型，仅在本地生成模型和报告。"
        "Intent 阶段等待我依次发送两条回复，第二条可修改窗口、划分和搜索预算；"
        "两条均处理完成前不要批准 Intent checkpoint 或进入数据分析。")
payload = {
    "title": f"{Path(dataset).stem} {variant} ablation",
    "domainID": "tsf", "mode": "autonomous", "interactionMode": "socratic",
    "taskSpec": {
        "contextLength": 336, "predictionLengths": [96],
        "dataset": {"loaderID": "etth1_tslib_v1", "path": dataset, "targetCols": targets,
                    "knownFutureCovariates": [], "observedPastCovariates": [], "staticCovariates": []},
        "metadata": {"researchVariant": variant, "interactionMode": "socratic", "userPrompt": goal,
                     "businessContext": goal,
                     "interpretability": "prefer simple explainable candidates when metrics are close",
                     "deploymentTarget": "local research runtime",
                     "sessionModel": {"providerID": "deepseek", "modelID": "deepseek-v4-flash"}},
        "runtime": {"bridgeOnly": False, "neoCastProjectRoot": os.environ["NEO_CAST_ROOT"]},
    },
    "objective": {"primaryMetric": "cv_avg_mse", "secondaryMetrics": ["cv_std_mse", "val_avg_mse"],
                  "direction": "minimize"},
    "budget": {"maxRuns": 200, "maxParallel": 1,
               "latencyBudget": "offline batch scoring; no hard latency limit",
               "parameterBudget": "under 20M parameters; prefer simple models when metrics are close",
               "loop": {"maxIterations": 25, "maxNoImprove": 7}},
}
control = Path(os.environ["CONTROL_DIR"])
control.mkdir(parents=True, exist_ok=True)
(control / "create-task.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
PY
```

`loaderID=etth1_tslib_v1` 是当前 TSF CLI 的默认 loader，实际 CSV 由 `dataset.path` 指定；有专用 loader 的任务应按既定数据契约替换，两组保持一致。先将第 7 节工具保存为 `$CONTROL_DIR/research_control.py`，再创建一次：

```bash
python3 "$CONTROL_DIR/research_control.py" create
export TASK_ID="$(python3 -c 'import json, os; from pathlib import Path; print(json.loads((Path(os.environ["CONTROL_DIR"]) / "created-task.json").read_text())["id"])')"
python3 "$CONTROL_DIR/research_control.py" snapshot
# 核对 metadata.researchVariant、metadata.sessionModel、dataset.path 与 runtime 后启动 Intent。
python3 "$CONTROL_DIR/research_control.py" start-intent
```

创建请求为 `POST /research/tasks`，正文来自 `create-task.json`；`start-intent` 调用 `POST /research/tasks/<taskID>/intent/start`，只启动 Intent。创建超时或响应丢失时，先按标题、时间、数据集和变体查询任务，找回 taskID 与收据，不能重复创建。同一服务的 TUI 中选择这个已创建任务，或继续用 API 操作；不要再提交创建目标。

之后两组均进入第 5 节，完整执行 `response/1 → response/2 → 最新 checkpoint → approve → resume`。每次 Intent 修改后回读，确认 `researchVariant` 和 `sessionModel` 未被覆盖。

zero 首轮设计的验收依据：

- `taskSpec.metadata.researchVariant=zero`，且不存在 `referenceBaseline`、`referenceBaselineSource`、`referenceBaselineRationale`。
- HypoPlanner 计划中 `baselineStrategy=autonomous_from_scratch`，没有 `referenceBaseline`；首轮选择自主假设进入模型设计，实验契约为 `exploratory`。
- 不存在预置 baseline 候选及 `stage=baseline` 的运行；`pick_baseline` / `load_baseline` 不应被调用。候选来自 LLM 自主设计，不能手工注入模板或启用规则回退。
- 首个成功的完整实验是本任务的初始观测；NAS 汇总用 `+initial` 标识，不能将其写成“相对 baseline 的提升”。后续比较说明真实对照来源。

已经产生假设、候选或运行的任务不能切换变体；从标准组建立 zero 消融必须创建独立新任务。zero 自身发生设计、训练或导出失败时，按第 9 节修复并续跑原任务，不补建 baseline。没有通过完整验证的自主模型时，如实报告失败，不将 smoke 成功视为有效实验或冠军。

## 5. Intent：按启动状态选择分支，依次提交两份回复

读取对应 txt 的完整 UTF-8 文本，保留全部语句与换行，不摘要、不拼接其他指令、不与另一份文件合并发送。第一份用于回复或第一次修改，第二份用于 checkpoint 阶段修改任务信息。两份文件都必须经同一个 task 的原 Intent 子会话处理。

### 5.1 分支 A：IntentAgent 先提问

1. 等待 IntentAgent 实际提出澄清问题，确认当前是 Intent 回复入口。
2. 将 `response/1/<数据集名>.txt` 的全文作为一条消息提交。
3. 等待该次 Intent 处理结束，核对第一阶段内容已进入 taskSpec，并等待出现 `[checkpoint:intent_confirmed]`。
4. **不要批准这个 checkpoint。** 在 checkpoint 的需求修改入口提交 `response/2/<数据集名>.txt` 全文。
5. 等待第二次修改结束，再读取 taskSpec 和最新 checkpoint，核对全部最终要求后进入第 6 节。

流程：`提问 → response/1 → checkpoint（暂不批准）→ response/2 修改 → 最新 checkpoint → approve`。

### 5.2 分支 B：启动后直接进入 checkpoint

1. 确认 `[checkpoint:intent_confirmed]` 已出现；**不要立即批准**，也不要求 IntentAgent 为了形式再提问。
2. 在该 task 的需求修改入口提交 `response/1/<数据集名>.txt` 全文。
3. 等待第一阶段修改完成，核对 taskSpec 和更新后的 checkpoint。
4. 再独立提交 `response/2/<数据集名>.txt` 全文。
5. 等待第二阶段修改完成，核对最新 taskSpec 与最新 checkpoint，之后才进入第 6 节。

流程：`初始 checkpoint（暂不批准）→ response/1 修改 → 等待落库 → response/2 修改 → 最新 checkpoint → approve`。

### 5.3 提交方式、落库检查与重复提交处理

可把完整文本作为普通消息输入 TUI，不使用 `/reply`。多行文本需要确保一次整体提交；若终端粘贴可能逐行触发 Enter，优先用第 7 节的 `intent-file` 命令，它将文件全文编码为一个请求：

```bash
python3 "$CONTROL_DIR/research_control.py" intent-file 1
# 等待第一阶段完成；分支 A 还需等到 checkpoint，分支 B 核对更新后的 checkpoint。
python3 "$CONTROL_DIR/research_control.py" intent-file 2
# 等待第二阶段落库和最新 checkpoint，之后才能 approve。
```

两次提交使用同一个接口；无论正在回答提问还是修改 checkpoint，都向原 Intent 会话发送：

```text
POST /research/tasks/<taskID>/intent/modify
{"message":"当前阶段对应txt文件的完整原文"}
```

第二阶段常见字段映射如下。自然语言文件保持原文，由 IntentAgent 转成合法 slot，不把 `context_length` 当成工具的字段名直接传入：

| txt 要求 | Intent slot | 最终任务字段 |
|---|---|---|
| `context_length` | `lookback_window` | `taskSpec.contextLength` |
| `horizon` | `prediction_horizon` | `taskSpec.predictionLengths` |
| 时间顺序比例切分 | `data_split_method=ratio`、`data_split_ratios` | `taskSpec.dataset.split` |
| 实验搜索预算 N 轮 | `max_iterations` | `budget.loop.maxIterations=N` |

切分比例可能被归一化，`6:2:2` 与 `[0.6,0.2,0.2]` 等价。第二份文件没提到的 horizon、切分等字段保留已有设置，不擅自从另一个数据集的文件补充。

每次修改可能使旧 checkpoint 失效并创建新 approval。不要缓存第一阶段的 approvalID 后直接批准；第二阶段完成后重新读取 pending approval 的 ID、签名和摘要。被标为 `Superseded by updated research intent` 的旧 checkpoint 是历史记录，不能重新批准。

请求超时后先检查 taskSpec、Intent 历史与提交日志，判断消息是否已保存、是否仍在处理；不要盲目重复发送。只有确认未生效后才重试该阶段；已经完成第一阶段时不能从头把两份文件再发一遍。

若 Intent 重复追问，先检查是否已读取并保存文件中的对应要求。由已提供文件和既定参数能回答的内容自行落实；真实缺失的信息不能编造，记录明确缺项后再处理。两份文件完成前严禁 `/approve`、`/loop` 或 `resume` 启动数据分析。

## 6. 检查并 approve Intent checkpoint，进入数据分析

批准前核对 checkpoint 摘要及已保存 task：

- CSV 是本次指定文件，目标列、时间粒度、窗口和预测长度正确。
- 两份同名 txt 的全文均已提交并处理完成，第一阶段语义和第二阶段修改均已进入对应 Intent slot。
- 切分、指标、资源要求与用户要求一致。
- `task.mode=autonomous`，交互模式是 `socratic`。
- 变体与本组一致，`metadata.sessionModel={"providerID":"deepseek","modelID":"deepseek-v4-flash"}`；通用与文献接口也使用该模型和 DeepSeek API。
- zero 任务没有 reference baseline 元数据、预置候选或 baseline 运行，后续按第 4.2 节检查首轮自主设计。
- context、horizon、切分和搜索预算符合对应 `response/2/` 文件；当前四组文件均要求 `budget.loop.maxIterations=25`，ETTh1 还需核对 context 96、切分 6:2:2。
- 缺失必填 slot 已清空，最新 checkpoint 摘要与最新 taskSpec 一致，待批准的是第二阶段处理后的有效 approval。

确认当前 pending approval 的 reason 是 `[checkpoint:intent_confirmed]`，再在 TUI 输入：

```text
/approve
```

**`/approve` 只登记审批，不保证启动下一阶段。** 立即查询恢复状态；如果已经运行则等待，不再重复启动。如果无活动 operation 且状态为 `resumable`，优先使用第 7 节的 `resume`，保留可追踪的持久操作收据。

也可以在已确认没有后台执行时使用 TUI：

```text
/loop
```

Socratic 的 `/loop` 调用完整 pipeline。两种启动方式二选一；不要同时发 `/loop`、`pipeline` 和 `resume`。API `resume` 不另传 `maxIterations`，从已确认预算与已保存阶段继续。

等待出现 DataAnalysis 启动事件，或 task 状态进入 `analyzing` / `data_analysis` 等实际分析阶段。记录进入数据分析的时间 `T0`，先做一次完整快照，下一次完整巡检安排在 `T0 + 20 分钟`。

## 7. API 查询与操作工具

所有请求携带同一个项目目录：`x-opencode-directory`；路径中的中文等字符用 URL 编码。以下 Python 标准库工具可由执行 agent 保存到 `$CONTROL_DIR/research_control.py`。它提供快照和操作入口，**不替代 agent 的诊断、审批判断或完成验收**。

```python
import base64
import datetime as dt
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

root = os.environ["PROJECT_ROOT"]
api = os.environ.get("RESEARCH_API", "http://127.0.0.1:4096").rstrip("/")
control = Path(os.environ["CONTROL_DIR"])
control.mkdir(parents=True, exist_ok=True)
action = sys.argv[1]
task_id = os.environ.get("TASK_ID", "")
headers = {"x-opencode-directory": urllib.parse.quote(root, safe="")}
password = os.environ.get("OPENCODE_SERVER_PASSWORD")
if password:
    user = os.environ.get("OPENCODE_SERVER_USERNAME", "opencode")
    token = base64.b64encode(f"{user}:{password}".encode()).decode()
    headers["Authorization"] = "Basic " + token

def request(method, route, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    h = {**headers, **({"Content-Type": "application/json"} if body is not None else {})}
    req = urllib.request.Request(api + route, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        text = error.read().decode(errors="replace")
        try:
            value = json.loads(text)
        except ValueError:
            value = {"message": text}
        return error.code, value

def get(route):
    code, value = request("GET", route)
    if code != 200:
        raise RuntimeError(json.dumps({"httpStatus": code, "response": value}, ensure_ascii=False))
    return value

if action == "create":
    receipt = control / "created-task.json"
    if receipt.exists():
        raise RuntimeError("已有创建收据；读取原 taskID，不重复创建")
    payload = json.loads((control / "create-task.json").read_text(encoding="utf-8"))
    metadata = payload["taskSpec"]["metadata"]
    if metadata.get("researchVariant") != os.environ["RESEARCH_VARIANT"]:
        raise RuntimeError("创建正文与控制目录所属变体不一致")
    if metadata.get("sessionModel") != {"providerID": "deepseek", "modelID": "deepseek-v4-flash"}:
        raise RuntimeError("必须显式绑定本实验模型")
    code, output = request("POST", "/research/tasks", payload)
    if code != 200 or not output.get("id"):
        raise RuntimeError(json.dumps({"httpStatus": code, "response": output}, ensure_ascii=False))
    receipt.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
elif action == "list":
    output = get("/research/tasks?limit=20")
else:
    if not task_id:
        raise RuntimeError("先设置 TASK_ID 为本次任务完整 ID")
    prefix = "/research/tasks/" + urllib.parse.quote(task_id, safe="")
    cursor_file = control / f"{task_id}-cursor.json"
    resume_file = control / f"{task_id}-resume-request.json"
    state = get(prefix + "/resume-state")
    if action == "snapshot":
        cursor = json.loads(cursor_file.read_text()) if cursor_file.exists() else 0
        events = get(prefix + f"/events?after={cursor}")
        output = {"observedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "state": state,
                  "task": get(prefix), "runs": get(prefix + "/runs"),
                  "artifacts": get(prefix + "/artifacts"),
                  "approvals": get(prefix + "/approvals"),
                  "champion": get(prefix + "/champion"), "events": events}
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        (control / f"{task_id}-{stamp}.json").write_text(json.dumps(output, ensure_ascii=False, indent=2))
        cursor_file.write_text(json.dumps(max([cursor] + [event["sequence"] for event in events])))
    elif action == "start-intent":
        if state["currentPhase"] not in ("created", "idle") or state["activeOperation"] or state["pendingApproval"]:
            raise RuntimeError("只对未启动 Intent 的新任务执行一次；已有会话按第5节继续")
        code, response = request("POST", prefix + "/intent/start")
        output = {"httpStatus": code, "response": response}
    elif action == "intent-file":
        phase = sys.argv[2] if len(sys.argv) > 2 else ""
        if phase not in ("1", "2"):
            raise RuntimeError("使用 intent-file 1 或 intent-file 2")
        if state["currentPhase"] not in ("created", "idle", "intent_gathering", "paused"):
            raise RuntimeError("当前不是 Intent 可编辑阶段；不要修改已执行的协议")
        if phase == "2" and (not state["pendingApproval"] or
                              "[checkpoint:intent_confirmed]" not in state["pendingApproval"]["reason"]):
            raise RuntimeError("第二阶段必须等待 Intent checkpoint 后再提交")
        task = get(prefix)
        completed = task.get("taskSpec", {}).get("metadata", {}).get("workflow", {}).get("completedPhases", [])
        if state["cycleID"] or any(name in completed for name in ("data_analysis", "literature", "searching", "publishing")):
            raise RuntimeError("研究已越过 Intent 阶段；先诊断流程，不直接修改已执行协议")
        dataset = Path(os.environ["DATASET_FILE"])
        source = Path(root) / "response" / phase / (dataset.stem + ".txt")
        raw = source.read_bytes()
        message = raw.decode("utf-8-sig")
        if not message.strip():
            raise RuntimeError(f"回复文件为空：{source}")
        record_file = control / f"{task_id}-response-{phase}-submission.json"
        record = {"taskID": task_id, "dataset": str(dataset), "phase": phase,
                  "source": str(source), "sha256": hashlib.sha256(raw).hexdigest(),
                  "message": message, "submittedAt": dt.datetime.now(dt.timezone.utc).isoformat()}
        record_file.write_text(json.dumps(record, ensure_ascii=False, indent=2))
        code, response = request("POST", prefix + "/intent/modify", {"message": message})
        record.update({"httpStatus": code, "response": response})
        record_file.write_text(json.dumps(record, ensure_ascii=False, indent=2))
        output = {"httpStatus": code, "response": response, "submissionRecord": str(record_file)}
        # HTTP 200 之后仍需核对 taskSpec/checkpoint，不能仅据此标记阶段已生效。
    elif action in ("resume", "retry-resume"):
        if action == "resume":
            if state["activeOperation"] and not state["activeOperation"].get("recoveryRequired"):
                raise RuntimeError("存在活动 operation；连接原执行，不重复续跑")
            if state["recoveryState"] not in ("resumable", "needs_reconciliation"):
                raise RuntimeError("当前状态不能续跑，请先完成审批或异常诊断")
            # needs_reconciliation 仅在 agent 已确认原 owner/runner 状态后使用。
            payload = {"expectedRevision": state["revision"], "requestKey": "agent-" + str(uuid.uuid4())}
            resume_file.write_text(json.dumps(payload))
        else:
            payload = json.loads(resume_file.read_text())
        code, response = request("POST", prefix + "/resume", payload)
        output = {"httpStatus": code, "response": response}
    elif action in ("approve", "reject"):
        pending = state["pendingApproval"]
        if not pending:
            raise RuntimeError("当前没有 pending approval")
        # 调用前由 agent 核对 reason、phase、预算和既定要求，不能无条件 approve。
        route = "/research/approvals/" + urllib.parse.quote(pending["id"], safe="") + "/reply"
        code, response = request("POST", route, {
            "status": "approved" if action == "approve" else "rejected",
            "replyMessage": sys.argv[2] if len(sys.argv) > 2 else "按已确认任务要求处理",
        })
        output = {"httpStatus": code, "response": response}
    elif action == "cancel":
        operation = state["activeOperation"]
        if not operation:
            raise RuntimeError("没有可取消的 active operation")
        route = prefix + "/operations/" + urllib.parse.quote(operation["id"], safe="") + "/cancel"
        code, response = request("POST", route, {})
        output = {"httpStatus": code, "response": response}
    else:
        raise RuntimeError("支持 create / list / snapshot / start-intent / intent-file / resume / retry-resume / approve / reject / cancel")
print(json.dumps(output, ensure_ascii=False, indent=2))
```

基本调用：

```bash
python3 "$CONTROL_DIR/research_control.py" list
export TASK_ID='替换为本次任务完整ID'
python3 "$CONTROL_DIR/research_control.py" snapshot
python3 "$CONTROL_DIR/research_control.py" resume
```

`resume` 请求严格只含 `expectedRevision` 和 `requestKey`。返回 **202** 表示操作已启动或已有操作可连接，不表示研究完成。记录返回 operationID，后续可读取：

```text
GET /research/tasks/<taskID>/operations/<operationID>
```

连接超时、响应丢失时，先查询状态。需要重试同一次不确定请求时用 `retry-resume`，复用保存的原 body 和幂等键；不要为了得到响应直接生成另一项执行。

**409 必须重新解释状态**：版本冲突先刷新快照；`ResearchReconciled` 表示对账已完成的一次过渡，刷新 revision 后再用新的 `resume` 请求。脚本成功打印 JSON 不代表 HTTP 202，应检查 `httpStatus`。

## 8. 每 20 分钟完整监控一次

以进入数据分析的 `T0` 为起点，按 `T0、T0+20min、T0+40min…` 记录巡检。修复期间及时处理错误，不必等到下一个 20 分钟节点；修复结束追加快照，同时保留原巡检时间表。

每次检查：

1. API 快照：task status、`recoveryState`、currentPhase、active operation、pending approval、blockers、事件游标。
2. runs：新增运行、状态变化、失败原因、最新指标与 candidate / champion 的变化；标准组检查 baseline，zero 组确认没有预置 baseline 或 baseline 阶段运行。
3. 实际进展：runner 是否存活、进度日志是否更新、是否仍在训练、验证或导出。
4. 资源和服务：TUI/worker 存活、Python 子进程、必要时 GPU 使用及磁盘空间。
5. 产物：阶段输出是否存在、日志或文件是否持续更新。
6. 模型与变体：检查实际调用记录、session 消息与设计/文献元数据，确认请求模型为 `deepseek-v4-flash`、服务为 DeepSeek API；zero 的计划和运行符合第 4.2 节。配置文件相同不能代替实际调用检查。

相关路径位于实际任务执行根目录，通常为研究项目目录；有任务隔离路径时以 task/runPlan 中记录的根目录为准：

```text
.neo-research/logs/<taskID>/events.jsonl
.neo-research/runner-progress/<taskID>/<runID>.jsonl
.neo-research/runner-executions/<taskID>/<runID>.json
.neo-research/run-plans/<taskID>/<runID>.json
```

每次在 `monitor.md` 写一条：时间、阶段、operation/run ID、相对上次的变化、审批/异常、采取的动作和下次巡检时间。没有必要每轮重复读取整个日志；通过 API event cursor 取增量，再查看相关日志尾部。

**一次 20 分钟没有新事件不代表卡死。** full 实验可能执行多折训练，服务自身也允许长时运行。结合日志时间戳、CPU/GPU、子进程存活和 runPlan 的实际 timeout 判断；不要用巡检间隔充当训练超时。

执行 agent 的控制循环：

```text
while 尚未满足全部完成标准:
    到达完整巡检时间 -> 保存 snapshot，检查进程/进度/产物，记录 monitor.md
    若收到明确错误或审批等待 -> 立即按状态处理
    running -> 观察原操作，不启动第二个执行
    waiting_input -> 按第9节处理审批或真实缺失信息
    resumable -> 确认修复和审批已完成，resume 原 task
    needs_reconciliation / blocked -> 诊断、修复、对账，再判断能否 resume
    completed -> 执行第10节完整产物验收；通过才退出
    等待下一次巡检，保持执行 agent 和任务控制会话可恢复
```

用可用的定时/等待能力维持控制循环。若工具单次等待有上限，采用较短等待累计至下一次巡检，不要一次阻塞 20 分钟。若运行平台要求跨会话恢复，保存全部执行状态和下一次巡检时间，并配置实际可执行的调度；仅写“20 分钟后检查”或启动只采样不处理的脚本不算持续监控。

## 9. 异常自动修复、审批与续跑

### 9.1 审批等待

先读完整 pending approval reason，确认对应 task 和 phase。普通的阶段确认在既定要求内可自行批准；两份回复文件尚未提交并确认落库时不能提前批准 Intent。

- `intent_confirmed`：`response/1/` 与 `response/2/` 对应文本均已生效，重新读取第二阶段处理后的最新 checkpoint，摘要核对后 approve。
- `search_space_confirmed`、`final_model_selection`、`report_release`：仅在数据、预算和结果符合既定要求时 approve。本手册的发布范围是本地报告和模型包。
- `reflection_review`：先分析建议和证据；可自行解决的实现问题先修复验证，再批准继续。
- 执行契约异常：先核实 candidate、代码、源摘要和模型一致性；实现错误修复后再 approve，设计本身不合法时 reject 并交给原流程重新设计。
- `experiment_budget_extended`：以 `response/2/` 最终确认的迭代上限为准（当前四组均为 25 轮），**reject 扩展，接受当前结果继续后续阶段**；approve 会增加 5 轮。
- 普通 `budget` 用尽：先判断失败/重复运行消耗原因，不自动增加轮数、运行次数或新建 cycle。

示例操作，执行前必须已核对 reason：

```bash
python3 "$CONTROL_DIR/research_control.py" approve '已核对符合既定需求，继续本地研究流程'
python3 "$CONTROL_DIR/research_control.py" snapshot
```

若审批后没有活动执行且恢复状态为 `resumable`，再 `resume`。不要用统一“approve all”跳过检查。已有明确 rejection 不能无条件改为批准。

### 9.2 运行失败或进展异常

先保存快照和原始错误，定位失败阶段、run、命令、退出码及最近 traceback。将修复与错误关联，而不是连续重新启动试运气。

| 问题 | 自动处理方式 |
|---|---|
| Bun 依赖或 preload 缺失 | 在 `SOURCE_ROOT/opencode` 完成 `bun install`，复查模块；不要删 preload 掩盖缺依赖。 |
| Python 模块缺失 / 解释器错误 | 修复 Neo-Cast runtime 与实际 `NEO_CAST_PYTHON`，复查 import；保持同一 runner 根目录。 |
| 数据集路径错误 | 修复路径解析或任务引用，确认是用户指定的原文件；不要换 CSV 或改数据内容。 |
| 模型调用临时失败 | 查服务状态、响应码、精确模型名及三条调用路径配置，按错误退避后恢复；认证缺失不能伪造 key，也不能切换模型或 API 服务凑结果。 |
| zero 出现 baseline 或模板回退 | 检查创建收据、变体字段、HypoPlanner 计划与候选来源，修复实现或错误路由；已混入 baseline 的任务不能计入 zero 消融结果。不能通过删除历史记录伪装成 zero。 |
| OOM / 设备错误 | 检查残留进程和资源；在既定训练策略允许范围内调整执行资源。会改变候选或评估契约时走合法候选更新流程并记录，不能直接改已执行证据。 |
| 代码、schema、导出异常 | 修复对应实现，运行能覆盖该故障的检查或测试，然后恢复同一 task；不要只改数据库状态。 |
| 文献 PDF 暂缺或阅读不完整 | 查文献阶段记录及 readiness；按真实 gap 处理，不生成假知识卡、不把 `ready_data_only` 伪装为文献支持。 |
| 日志不更新但训练仍有资源活动 | 继续观察；先确认阶段 timeout 和实际训练行为，再判断是否卡死。 |

修复循环应包含：发现证据 → 定位原因 → 最小必要修改 → 相关验证 → 状态对账 → resume → 确认原失败阶段已经通过。按子项目规则运行测试；不要在 opencode 根运行 `npm test`。

同一种错误再次出现时，复查诊断或扩大到相关实现，不把失败次数上限或连续崩溃门限简单提高来掩盖问题。搜索轮数已经耗尽而无有效模型属于真实失败结果，不能偷偷开新周期凑成功。

### 9.3 取消、服务重启与恢复对账

只有诊断确认需要中断当前异常操作时，才取消它：

```bash
python3 "$CONTROL_DIR/research_control.py" cancel
```

等待 operation 转为 canceled/failed，并确认 Python 子进程和进程组退出。接口返回“取消已请求”不等于训练已经停止。保留所有相关输出。

需要加载修复后的代码时，停止**本次**服务并确认所属 runner 状态，再按第 3 节同一环境、同一项目、同一端口重启。恢复原会话/历史 task；不要重发创建任务目标，也不要清空 `.neo-research` 或 `.neo-cast`。

`needs_reconciliation` 的操作顺序：

1. 查原 owner、runner 和已有产物，确认旧执行究竟已退出、仍运行还是结果已写完。
2. 若旧 owner 已退出且符合接口的自动恢复条件，发送一次 `resume` 触发对账。
3. 收到 `409 ResearchReconciled` 后重新获取状态和 revision，再发送新的 `resume`。
4. 若仍有活动 owner/runner，连接并观察原执行，不能重复启动。

当前接口不能自动解决所有中断：publishing 中断、没有对应 operation 的孤立运行、无法证实结束的旧执行等可能仍保持阻塞。此时继续检查实际导出文件、原操作和恢复实现；需要时修复恢复逻辑并验证。**不要删锁、直接改状态或新建 cycle 来绕过对账。**

遇到只有用户/外部系统才能解决的真实阻塞，例如缺少有效密钥，清楚报告已做的诊断、保存任务状态和明确所需输入；不能声称完成，也不能无限重复同一个无效请求。

## 10. “全部完成”的验收

同时满足以下条件才结束监控：

1. 原 task 的 `status=completed`，恢复视图为 `completed`，workflow 已完成 `publishing`，没有未处理的 operation 或审批。
2. 存在真实 champion，其对应的有效 `full` 和发布所需 `ref_test` 运行成功；报告中的指标能追溯到这些 run。
3. 存在 `model_export_package` artifact，其 URI 指向可读取的本地发布目录。
4. `manifest.json` 的 `schemaVersion=neo_research_model_export_package.v1`，`integrity.status=complete`。
5. 报告、结果和模型文件可读取，模型权重与推理入口实际存在；不能只凭 manifest 完整标志判定可推理。
6. 用户确认的原数据集、评估协议和预算得到保留，修复和异常均有记录。
7. 请求模型全程为 `deepseek-v4-flash`，实际调用走 DeepSeek API，三条调用路径均有配置与调用记录可核对。记录服务端返回的模型信息及实验日期；历史混用模型的任务单独标记，不计为本协议结果。
8. zero 组满足第 4.2 节的变体、首轮自主设计及无预置 baseline 条件；模型设计失败没有被规则候选或 smoke 结果替代。

默认发布目录通常是任务执行根目录下 `.neo-research/artifacts/<taskID>/`，以 artifact URI 和 manifest 的真实路径为准。重点检查：

```text
manifest.json
reports/final_report.md
artifacts/release_package.md
model/model.py
model/model.pt
model/inference.py
results/runs.json
results/candidates.json
results/champion.json
results/artifacts.json
```

模型文件可能由不同导出分支提供，按 manifest 和所选模型的实际契约核对名称和来源；无法提供权重/推理入口时不能宣称模型可用。

同时检查 `configs/best_model_config.yaml`、`experiments/leaderboard.md` 和 `ref_test/ref_test_metrics.json`，确保最佳配置、排行榜、最终评估与 champion 一致。

单次 operation 的 `completed`、NAS 到达轮数上限、TUI 不再滚动、或“报告生成开始”都不等于整个任务完成。默认 full pipeline 会处理冠军 `ref_test`，不会自动包含 `blind_test`；除非本次用户另有要求，不把 blind test 加为必需步骤。

若状态已标 completed 但产物不完整，作为导出/完成判定异常处理，修复并合法重建产物后再次验收，不仅改状态字段。

消融汇总按数据集并列列出 `standard` 与 `zero` 的 taskID、请求/响应模型、最终评估协议、实际搜索轮数、停止原因、有效 full 运行数、最佳指标、训练耗时、API token/费用（可取得时）、随机种子及产物路径。用同一最终评估口径比较两组，不能用 zero 首次训练前不存在的 baseline 计算提升，也不能把“取消 baseline”和改变文献/模型/预算混成一次消融。未执行的组标记为未执行，不补造对照值。

最终向用户报告：数据集、研究变体、API 模型、taskID、实际搜索轮数与停止原因、最佳模型及指标、模型包与报告路径、修复摘要、完整性验证结果；执行两组时附上述消融汇总。保留 `execution-state.json`、`monitor.md` 和所有巡检快照供复查。

## 11. 当前实现依据

- [Bun dev 启动入口](../opencode/package.json)
- [TUI 项目目录与 HTTP 端口](../opencode/packages/opencode/src/cli/cmd/tui/thread.ts)
- [TUI 数据集目标解析](../opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit-data.ts)
- [Intent 回复、approve 与 loop](../opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit.tsx)
- [Intent 工具与提问规则](../opencode/packages/opencode/src/agent/prompt/research-intent-agent.txt)
- [审批、恢复、事件及操作 API](../opencode/packages/opencode/src/server/routes/instance/research.ts)
- [恢复视图及请求契约](../opencode/packages/opencode/src/research/recovery.ts)
- [恢复状态字段](../opencode/packages/opencode/src/research/recovery-schema.ts)
- [研究流水线与本地发布](../opencode/packages/opencode/src/research/service.ts)
- [zero 变体开关与 baseline 禁用校验](../opencode/packages/opencode/src/research/research-variant.ts)
- [zero HypoPlanner 提示词](../opencode/packages/opencode/src/agent/prompt/research-hypo-planner-zero.txt)
- [CLI 变体参数](../opencode/packages/opencode/src/cli/cmd/research.ts)
- [通用模型配置优先级](../opencode/packages/opencode/src/research/llm-proposal.ts)
- [原生会话模型解析](../opencode/packages/opencode/src/research/session-model.ts)
- [独立文献模型配置](../opencode/packages/opencode/src/research/literature/model-config.ts)

本手册的命令、参数与状态流程已按源码核对；文档编写过程中未启动真实研究任务，也未代替用户执行 Intent 回答或审批。
