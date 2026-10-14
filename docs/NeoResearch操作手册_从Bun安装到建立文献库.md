# NeoResearch 操作手册：从 Bun 安装到建立文献库

核对日期：2026-10-13。适用于本仓库当前源码版本，命令以 Linux / WSL 的 Bash 为例；macOS 可跳过 `apt` 步骤。Windows 用户请在 WSL 中执行本手册。

完成后应获得：可启动的 NeoResearch、论文目录与 PDF、经过原文证据审核的 v2 知识库，以及供研究流程使用的本地检索索引。文献提取需要可用的 LLM 接口；仅建立论文目录和解析 PDF 不需要 LLM。

## 1. 安装工具并确定项目目录

如果系统缺少基础工具，在 Ubuntu / Debian / WSL 中执行：

```bash
sudo apt update
sudo apt install -y curl unzip ca-certificates git make python3 python3-venv
```

另需安装 Node.js 和 npm，建议使用 Node.js 22。确认命令存在：

```bash
node --version
npm --version
python3 --version
```

仓库 `opencode/package.json` 指定 Bun **1.3.13**。首次安装使用该版本，避免同时引入运行时版本差异：

```bash
curl -fsSL https://bun.sh/install | bash -s -- bun-v1.3.13
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

版本安装与 PATH 处理参考 [Bun 官方安装文档](https://bun.sh/docs/installation)。

Neo-Cast 用 `uv` 创建 Python 环境，安装方法如下：

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
uv --version
```

参考 [uv 官方安装文档](https://docs.astral.sh/uv/getting-started/installation/)。安装器修改 PATH 后，新终端通常也能找到命令。

进入已经下载或克隆的仓库。其他机器请替换第一行的路径：

```bash
export NEO_RESEARCH_REPO='/mnt/d/kawai10726/work/temp/NeoResearch'
export NEO_CAST_ROOT="$NEO_RESEARCH_REPO/neo_cast"
export NEO_CAST_PYTHON="$NEO_CAST_ROOT/.neo-cast/runtime/.venv/bin/python"
cd "$NEO_RESEARCH_REPO"
ls
```

应能看到 `opencode/`、`neo_cast/`、`scripts/` 和 `Makefile`。后续步骤使用这三个环境变量；新开终端时需要重新设置。

## 2. 安装 Bun workspace 依赖

在 `opencode/` 安装整个 workspace，包含源码运行需要的开发依赖：

```bash
cd "$NEO_RESEARCH_REPO/opencode"
bun install
```

不要只在 `packages/opencode/` 单独安装，也不要添加 `--production`。该项目使用 workspace 与 catalog 依赖，根安装会同时执行项目的 `postinstall`，处理终端 PTY 依赖。Bun 安装行为参考 [官方说明](https://bun.sh/docs/pm/cli/install)。

如果安装失败，先解决输出中的网络、依赖或安装脚本错误，再继续启动。检查关键依赖是否可解析：

```bash
cd "$NEO_RESEARCH_REPO/opencode/packages/opencode"
bun --eval 'console.log(import.meta.resolve("@opentui/solid/preload"))'
```

输出应为已安装模块路径。

## 3. 安装 Neo-Cast 依赖和 Python runtime

```bash
cd "$NEO_CAST_ROOT"
npm install
node ./bin/neo-cast.js init-runtime
```

`init-runtime` 使用 `uv` 创建 Python >= 3.10 的环境，并安装 `pyproject.toml` 中的依赖，包括 `jsonschema`、`PyMuPDF`、`numpy`、`pandas`、`scikit-learn` 和 `torch`。首次安装会下载依赖。

确认使用的是项目环境，而非另一个系统 Python：

```bash
"$NEO_CAST_PYTHON" --version
"$NEO_CAST_PYTHON" -c 'import sys, numpy, torch, pymupdf, jsonschema; print(sys.executable); print("Python dependencies OK")'
export PATH="$NEO_CAST_ROOT/.neo-cast/runtime/.venv/bin:$PATH"
```

文献解析本身不需要 GPU；PyMuPDF 和 jsonschema 是 PDF 解析与契约校验所需依赖。这里安装完整 runtime，是为了后续直接使用研究和训练流程。

## 4. 初始化本地开发环境并启动

先检查初始化脚本将执行的操作：

```bash
cd "$NEO_RESEARCH_REPO"
./scripts/bootstrap_local_dev.sh --dry-run
```

首次使用、仓库根尚无 `.env.local` 时执行：

```bash
cd "$NEO_RESEARCH_REPO"
if [ ! -f .env.local ]; then
  ./scripts/bootstrap_local_dev.sh --skip-install
else
  echo '.env.local 已存在；保留现有文件，检查其中的 runner 和 XDG 路径。'
fi
./scripts/doctor.sh --quick
./scripts/dev_cli.sh doctor
```

此处跳过 Bun 安装，因为第 2 步已经完成。脚本会建立本地运行目录，默认包括：

```text
NeoResearch/
├── .env.local
├── .neo-research/runtime/xdg/{data,config,cache,state}/
└── neo_cast/.neo-cast/artifacts/
```

**重跑 bootstrap 会覆盖 `.env.local`。** 已有自定义配置时先保留原文件，检查 `NEO_CAST_ROOT`、`NEO_RESEARCH_RUNTIME_ROOT` 及 XDG 路径是否仍指向当前仓库。不要把 API key 写进需要提交的文件。

使用仓库提供的启动脚本，并显式指定研究工作区：

```bash
cd "$NEO_RESEARCH_REPO"
./scripts/dev_cli.sh cockpit "$NEO_RESEARCH_REPO"
```

如需先进入主页选择配置入口：

```bash
./scripts/dev_cli.sh "$NEO_RESEARCH_REPO"
```

`dev_cli.sh` 会先切换到 `opencode/packages/opencode/`，因此传入绝对工作区路径很重要。不要把 `./scripts/dev_cli.sh init` 当成“初始化仓库根”；不带项目路径时，它的当前目录是包目录。

以下文献命令是独立命令，执行时不需要保持 TUI 开启。

## 5. 配置文献提取使用的模型

文献提取读取 Neo-Cast LLM 配置。仅在 TUI 中选择模型，不足以确认此配置已生效。

以 OpenAI-compatible 接口为例，替换服务地址和模型名称，再输入密钥：

```bash
export NEO_CAST_LLM_PROVIDER='openai-compatible'
export NEO_CAST_LLM_BASE_URL='https://YOUR-ENDPOINT/v1'
export NEO_CAST_LLM_MODEL='YOUR-MODEL'
read -rsp 'LLM API key: ' NEO_CAST_LLM_API_KEY
printf '\n'
export NEO_CAST_LLM_API_KEY
```

`YOUR-ENDPOINT` 和 `YOUR-MODEL` 是占位符，必须替换。服务地址填 API 根地址，例如带 `/v1` 的地址，不要填写完整的 `/chat/completions` 路径。模型需要支持较长论文上下文和 JSON 输出；当前 principle 提取代码请求的输出上限为 16,384 tokens，需接口支持。

原生 Anthropic 接口改用：

```bash
export NEO_CAST_LLM_PROVIDER='anthropic'
export NEO_CAST_LLM_MODEL='YOUR-ANTHROPIC-MODEL'
unset NEO_CAST_LLM_BASE_URL
read -rsp 'Anthropic API key: ' ANTHROPIC_API_KEY
printf '\n'
export ANTHROPIC_API_KEY
```

选择其中一种配置。若设置过 `ANTHROPIC_BASE_URL` 或 `OPENAI_BASE_URL`，需核对它们是否仍指向期望的服务。

当前文献提取的配置优先级为：

```text
默认值 < 环境变量 < 用户 ~/.config/neo-cast/config.json
       < 当前工作目录 .neo-cast/config.json
       < neo_cast/.neo-cast/config.json
```

因此，已有 JSON 文件可能覆盖刚刚 export 的模型配置。为明确固定本次配置，可执行以下命令：它保留已有其他字段，只更新模型设置，不写入 API key。

```bash
node - <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(process.env.NEO_CAST_ROOT, '.neo-cast', 'config.json');
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (!process.env.NEO_CAST_LLM_PROVIDER || !process.env.NEO_CAST_LLM_MODEL) {
  throw new Error('先设置 NEO_CAST_LLM_PROVIDER 和 NEO_CAST_LLM_MODEL');
}
config.llm = {
  ...config.llm,
  provider: process.env.NEO_CAST_LLM_PROVIDER,
  model: process.env.NEO_CAST_LLM_MODEL,
  base_url: process.env.NEO_CAST_LLM_BASE_URL || null,
  temperature: 0.2,
};
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
console.log('已更新模型配置；API key 仍由环境变量提供。');
JS
cd "$NEO_CAST_ROOT"
node ./bin/neo-cast.js config show
node ./bin/neo-cast.js doctor
```

修改 provider 后，请再次执行这段配置更新，并核对 `config show` 的 provider、model 和 base URL。密钥每个终端会话重新提供；本手册不要求保存密钥文件。

## 6. 建立论文目录并下载 PDF

论文源构建和 LLM 提取是两个阶段。第一阶段采集论文元数据、核验来源、下载公开 PDF，不生成知识卡。

如需 OpenAlex 标识符补全和引用扩展，设置单独的 OpenAlex key：

```bash
read -rsp 'OpenAlex API key: ' OPENALEX_API_KEY
printf '\n'
export OPENALEX_API_KEY
```

这个 key 与 LLM key 无关。获取方法参考 [OpenAlex 官方认证说明](https://help.openalex.org/api/authentication/)。本仓库构建器在缺少 key 时会记录 `blocked_missing_api_key` 并复用已有缓存；若只想先跑通，可跳过此配置并使用后面的精简命令。

首次建议限制下载目标，先建立一个小规模 PDF 样本：

```bash
cd "$NEO_CAST_ROOT"
"$NEO_CAST_PYTHON" py/literature_source.py --max-downloads 5
```

没有 OpenAlex key 时，可明确跳过补全和引用扩展：

```bash
"$NEO_CAST_PYTHON" py/literature_source.py \
  --skip-openalex --skip-citations --max-downloads 5
```

`--max-downloads 5` 是对本次处理的下载目标列表取前 5 条，**不保证下载成功 5 篇，也不保证新增 5 篇**；已下载记录也可能在列表内。目录发现和官方核验仍可能访问多个网络来源。

全量增量构建时，取消下载限制：

```bash
"$NEO_CAST_PYTHON" py/literature_source.py
```

默认输出：

```text
neo_cast/.neo-cast/literature-source/
├── source_manifest.json
├── coverage.json
├── COVERAGE.md
├── retry_queue.jsonl
├── citation_expansion.json
├── catalog/papers.jsonl
├── pdfs/*.pdf
└── cache/
```

当前默认策略包括 2023 年起的主要 TSF 文献池，以及单独维护的历史基础文献池。目录里的论文不一定都有可下载 PDF，具体看每条记录的 `download.status`，以及 `COVERAGE.md` 的覆盖说明。

列出已经下载、可进入提取阶段的论文：

```bash
"$NEO_CAST_PYTHON" - <<'PY'
import json
import os
from pathlib import Path
source = Path(os.environ['NEO_CAST_ROOT']) / '.neo-cast/literature-source'
papers = [json.loads(line) for line in (source / 'catalog/papers.jsonl').read_text().splitlines() if line.strip()]
print(f'目录论文数：{len(papers)}')
downloaded = [paper for paper in papers if paper.get('download', {}).get('status') == 'downloaded']
print(f'已下载记录数：{len(downloaded)}')
for paper in downloaded[:20]:
    print(paper['paper_id'], paper['title'], sep='\t')
PY
```

复制其中一个 `paper_id`。目录字段是 `paper_id`，后面的 CLI 参数名称是 `--paper-id`。

## 7. 先解析一篇论文，确认 PDF 可读

```bash
export PAPER_ID='替换为上一步列出的paper_id'
cd "$NEO_RESEARCH_REPO/opencode/packages/opencode"
bun run src/research/literature/dev-cli.ts parse \
  --neo-cast-root "$NEO_CAST_ROOT" \
  --python "$NEO_CAST_PYTHON" \
  --paper-id "$PAPER_ID"
```

成功时返回 `paperID`、`documentID`、`documentPath`、`chunksPath`、`chunkCount` 等信息。确认 `status` 为 `parsed` 且 `chunkCount > 0`。若为 `ocr_required`，当前解析器不会自动 OCR；换用可提取文本的 PDF，或先自行完成 OCR。

也可以直接解析本地 PDF；两种来源二选一：

```bash
bun run src/research/literature/dev-cli.ts parse \
  --neo-cast-root "$NEO_CAST_ROOT" \
  --python "$NEO_CAST_PYTHON" \
  --pdf '/absolute/path/paper.pdf' \
  --title 'Paper title' \
  --publication-status unknown
```

只有确认正式发表时才使用 `peer_reviewed`；预印本使用 `preprint`。不要同时传 `--paper-id` 和 `--pdf`。

## 8. 提取、审核并发布 v2 知识卡

保持第 5 步的模型配置和密钥环境变量可用，执行：

```bash
cd "$NEO_RESEARCH_REPO/opencode/packages/opencode"
bun run src/research/literature/dev-cli.ts build-principles \
  --neo-cast-root "$NEO_CAST_ROOT" \
  --python "$NEO_CAST_PYTHON" \
  --paper-id "$PAPER_ID" \
  --max-calls 80 \
  --max-context-characters 180000
```

流程包括解析、材料收集、原则综合和独立原文审核；通过审核的卡片发布到当前 active v2 知识库。输出包含 `runID`、`runPath`、`status`、`acceptedCount`、`rejectedCount` 和 `errors`。

`--max-calls` 限制模型调用次数，`--max-context-characters` 限制上下文字符数；它们不是金额预算，也不是实验 `maxIterations`。过小的额度可能导致 `partial`。首次先跑一篇、检查结果，再批量处理。

本地 PDF 的提取方式：

```bash
bun run src/research/literature/dev-cli.ts build-principles \
  --neo-cast-root "$NEO_CAST_ROOT" \
  --python "$NEO_CAST_PYTHON" \
  --pdf '/absolute/path/paper.pdf' \
  --title 'Paper title' \
  --publication-status unknown \
  --max-calls 80
```

`completed` 不保证一定有卡片：原文无法支持可迁移原则时，零卡片是允许的。`partial` 也不一定意味着零卡片，应查看运行结果和审核报告。

## 9. 验收知识库并建立本地检索索引

先校验并导出：

```bash
bun run src/research/literature/dev-cli.ts validate \
  --neo-cast-root "$NEO_CAST_ROOT"
bun run src/research/literature/dev-cli.ts export \
  --neo-cast-root "$NEO_CAST_ROOT"
```

校验应返回类似：

```json
{"status":"valid","schemaVersion":"knowledge_card_v2","cardCount":3}
```

**空库同样可能返回 `valid`。** 建立可用知识库至少还需 `cardCount > 0`，并抽查卡片来源和审核报告；上面的数字只是示例。

知识库结构如下：

```text
neo_cast/.neo-cast/literature-knowledge/
├── knowledge.db
├── documents/<paperID>/
│   ├── *.document.json
│   └── *.chunks.jsonl
├── principle-runs/<runID>/
│   ├── result.json
│   ├── review.md
│   └── knowledge_cards_v2.jsonl
└── exports/knowledge_cards_v2.jsonl
```

查看第 8 步的运行记录：

```bash
export LITERATURE_RUN_ID='替换为第8步输出的runID'
bun run src/research/literature/dev-cli.ts show-run "$LITERATURE_RUN_ID" \
  --neo-cast-root "$NEO_CAST_ROOT"
```

当前没有独立命名的“建索引”CLI。下面直接调用已有模块，建立本地索引，不请求 LLM：

```bash
cd "$NEO_RESEARCH_REPO/opencode/packages/opencode"
bun --eval '
import { buildLocalIndex } from "./src/research/retrieve/local-index-builder.ts";
const index = await buildLocalIndex({ neoCastRoot: process.env.NEO_CAST_ROOT });
console.log(JSON.stringify({ databasePath: index.databasePath, ...index.manifest }, null, 2));
'
```

应生成 `.neo-cast/literature-retrieval/index/retrieval.db`、`index_manifest.json` 和 `document_fingerprints.jsonl`，且 `documentCount > 0`。索引论文数包含仅有元数据的论文，不等于 PDF 数或知识卡数。

后续研究流程在 `DataAnalysis → Literature → HypoPlanner` 阶段自动读取同一个 `neo_cast` 根目录下的目录、文档和 active v2 卡片，并更新索引。无需额外安装向量数据库。启动研究时确保 runner 仍指向本手册的 `NEO_CAST_ROOT`。

## 10. 批量建立知识库

先确认单篇提取和第 9 步验收通过，再生成已下载论文清单：

```bash
export PAPER_LIST="$NEO_CAST_ROOT/.neo-cast/literature-source/downloaded-paper-ids.txt"
"$NEO_CAST_PYTHON" - <<'PY'
import json
import os
from pathlib import Path
source = Path(os.environ['NEO_CAST_ROOT']) / '.neo-cast/literature-source/catalog/papers.jsonl'
papers = [json.loads(line) for line in source.read_text().splitlines() if line.strip()]
ids = [paper['paper_id'] for paper in papers if paper.get('download', {}).get('status') == 'downloaded']
Path(os.environ['PAPER_LIST']).write_text(''.join(paper_id + '\n' for paper_id in ids))
print(f'已写入 {len(ids)} 篇论文；执行前可编辑清单，保留本次需要处理的论文。')
PY
```

确认清单规模符合本次模型调用预算后，顺序提取。不要同时开启多个进程写同一个知识库：

```bash
cd "$NEO_RESEARCH_REPO/opencode/packages/opencode"
export BATCH_LOG_ROOT="$NEO_CAST_ROOT/.neo-cast/literature-knowledge/batch-logs"
mkdir -p "$BATCH_LOG_ROOT"
while IFS= read -r paper_id; do
  [ -n "$paper_id" ] || continue
  printf '提取 %s\n' "$paper_id"
  if bun run src/research/literature/dev-cli.ts build-principles \
    --neo-cast-root "$NEO_CAST_ROOT" \
    --python "$NEO_CAST_PYTHON" \
    --paper-id "$paper_id" \
    --max-calls 80 \
    --max-context-characters 180000 \
    > "$BATCH_LOG_ROOT/$paper_id.log" 2>&1; then
    printf '完成：%s\n' "$paper_id"
  else
    printf '未完成：%s，请查看对应日志和运行结果\n' "$paper_id"
  fi
done < "$PAPER_LIST"
```

80 次是**每篇**的调用上限，不是整个批次的额度。批次结束后重新执行第 9 步的 `validate`、`export` 和索引构建。

## 11. 增量更新、重跑与迁移

论文源构建默认复用缓存和已有有效 PDF，普通更新直接重跑：

```bash
cd "$NEO_CAST_ROOT"
"$NEO_CAST_PYTHON" py/literature_source.py
```

需要刷新特定网络快照时，按需选择以下命令：

```bash
"$NEO_CAST_PYTHON" py/literature_source.py --refresh-discovery --skip-download
"$NEO_CAST_PYTHON" py/literature_source.py --refresh-official --skip-download
"$NEO_CAST_PYTHON" py/literature_source.py --refresh-citations --skip-download
```

最后一条的引用扩展需配置 OpenAlex key。查看 `retry_queue.jsonl` 判断下载失败、无公开 PDF 等原因；不要将 `no_public_pdf` 当成必须绕过的下载错误。

知识提取会复用符合当前版本、源内容、模型和预算身份的完成缓存。需要强制重新提取某篇时，使用已接入 `force` 的 `build` 命令：

```bash
cd "$NEO_RESEARCH_REPO/opencode/packages/opencode"
bun run src/research/literature/dev-cli.ts build \
  --neo-cast-root "$NEO_CAST_ROOT" \
  --python "$NEO_CAST_PYTHON" \
  --paper-id "$PAPER_ID" \
  --force
```

当前 `build-principles` 没有接入 `--force`，也不要假设 `build` 支持相同的 `--max-calls` 参数。强制提取会调用模型，并可能替换该论文的 active 卡片集合。

迁移时，先停止写入进程，再备份完整的 `literature-source/` 和 `literature-knowledge/`。只复制 `knowledge.db` 或导出的 JSONL 不足以保留原文证据与运行审计；SQLite 的 WAL 等伴随文件也需一致保存。检索索引可在目标机器重新建立。

这些目录及密钥属于本地状态，不提交到 Git。

## 12. 常见问题

| 现象 | 检查与处理 |
|---|---|
| `bun: command not found` | 确认 `~/.bun/bin` 在 PATH 中，重新打开终端或执行第 1 步的 export。 |
| `preload not found "@opentui/solid/preload"` | 回到 `opencode/` 重跑完整 `bun install`；查看安装是否失败或只安装了生产依赖。不要通过删掉 preload 配置掩盖问题。 |
| 缺少 `torch`、`pymupdf` 或 `jsonschema` | 重跑 `init-runtime`，确认 CLI 的 `--python` 指向项目 runtime；检查对应 Python 的 import。 |
| PDF 不存在 / `PDF_UNAVAILABLE` | 确认 catalog 记录的 `download.status` 为 `downloaded`，且文件确实存在；否则补下载或改用 `--pdf`。 |
| `ocr_required` / `chunkCount=0` | PDF 没有足够可提取文本；换文本版 PDF 或先做 OCR。 |
| `No configured principle extraction model` | 检查 provider、model、服务地址和对应 key，特别注意 JSON 配置对环境变量的覆盖。 |
| 401 / 403 / 模型不存在 | 核对密钥所属服务、base URL、模型名称和服务权限。 |
| 上下文或输出 token 上限错误 | 模型接口需支持当前请求规模；先减少上下文字符额度，若输出上限不支持则换合适模型或调整实现。 |
| `partial` / 调用预算耗尽 | 查 `errors`、`result.json` 和 `review.md`；需要时调整预算重跑，不能将 partial 当成完整阅读。 |
| `valid` 但 `cardCount=0` | 校验只说明当前卡片合法，空库也合法；检查提取是否完成、是否没有可支持的原则、或卡片全部被拒绝。 |
| `build --no-llm` 报错 | 当前实现的 v2 build 必须有模型；只解析请用 `parse`。 |
| 新任务没有使用已有知识 | 检查是否指向同一个 Neo-Cast 根目录、是否生成 active v2 卡片、是否重新 export；任务条件不匹配也可能不选用卡片。 |

## 13. 完成标准与核对依据

建库完成至少满足：

- Bun 依赖可加载，项目 Python 能导入解析依赖。
- `catalog/papers.jsonl` 存在，至少一篇有效本地 PDF 可解析为非空 chunks。
- 至少一篇提取运行产生经审核的 active v2 卡片，`validate` 的 `cardCount > 0`。
- 导出文件存在，抽查卡片的引用来源和 `review.md`。
- 本地检索索引建立成功，后续研究使用相同的 Neo-Cast 根目录。

本文档依据当前代码核对，未通过本文档执行全量安装、联网抓取或付费模型提取。关键实现入口：

- [workspace 与 Bun 版本](../opencode/package.json)
- [本地初始化脚本](../scripts/bootstrap_local_dev.sh)
- [源码启动脚本](../scripts/dev_cli.sh)
- [Python runtime 初始化](../neo_cast/src/runtime.js)
- [论文源构建说明](../neo_cast/literature_source/README.md)
- [文献 CLI 的实际参数](../opencode/packages/opencode/src/research/literature/dev-cli.ts)
- [模型配置与密钥解析](../opencode/packages/opencode/src/research/llm-proposal.ts)
- [文献提取和校验实现](../opencode/packages/opencode/src/research/literature/literature-agent.ts)
- [本地检索索引实现](../opencode/packages/opencode/src/research/retrieve/local-index-builder.ts)

相关背景可继续阅读 [本地源码安装测试教程](NeoResearch本地源码安装测试教程.md)。若旧说明与上述代码存在差异，以当前实现为准。
