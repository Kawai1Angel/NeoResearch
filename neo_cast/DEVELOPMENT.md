# neo-cast 安装与调试指南

> 本文档面向源码开发者。如果你只是使用 neo-cast，直接 `npm install -g neo-cast` 即可。

---

## 环境要求

| 依赖 | 最低版本 | 说明 |
|---|---|---|
| Node.js | >= 20 | 使用 `node --version` 检查 |
| Python | >= 3.10 | 由 `init-runtime` 自动安装到项目 venv |
| uv | 最新稳定 | Python 包管理，`curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| macOS / Linux | macOS 12+ / Ubuntu 22.04+ | 暂不支持 Windows |

---

## 一次性环境初始化

```bash
# 1. 克隆仓库
git clone <repo-url> neo-cast
cd neo-cast

# 2. 安装 Node.js 依赖
npm install

# 3. 配置 API key
cp .env.example .env
# 用编辑器打开 .env，填入 ANTHROPIC_API_KEY
# 如果使用 OpenAI 兼容接口（如 AIGCBEST）见下方"多 LLM 接入"

# 4. 初始化 Python 运行时（在项目目录内 .neo-cast/runtime/.venv）
node bin/neo-cast.js init-runtime

# 5. 准备数据（需要 ETTh1.csv）
# 下载：https://github.com/thuml/Time-Series-Library（dataset/ETT-small/ETTh1.csv）
node bin/neo-cast.js prepare-data --source /path/to/ETTh1.csv

# 6. 验证环境
node bin/neo-cast.js doctor
# 预期输出：
# [OK] python3: Python 3.12.x [runtime venv]
# [OK] uv: ...
# [OK] anthropic_api_key: ANTHROPIC_API_KEY is set.
# [OK] config: Resolved config is valid.
# [OK] runtime: Project runtime is ready at ...
```

---

## 安装方式

### 方式一：直接用 node 运行（最轻量，推荐开发时用）

不需要安装，改源码后立即生效：

```bash
node bin/neo-cast.js <command> [flags]

# 等价于 neo-cast doctor
node bin/neo-cast.js doctor

# mock 模式跑一次 design
node bin/neo-cast.js design \
  --requirement "small nlinear baseline" \
  --mode companion \
  --max-candidates 2 \
  --mock-llm
```

### 方式二：npm link（本地全局命令）

在本机注册 `neo-cast` 命令，源码改动立即生效，无需重装：

```bash
npm link            # 注册全局命令（需要 sudo 或 npm 全局目录在 PATH 里）

neo-cast doctor
neo-cast design --requirement "..." --mock-llm

npm run unlink      # 撤销（或 npm unlink -g neo-cast）
```

> **注意**：`npm link` 创建的是符号链接，修改 `src/` 下的源码后**不需要**重新 link，直接运行即生效。

### 方式三：npm publish 发布到 npmjs.com

```bash
# 确认版本号（package.json 的 version 字段）
npm version patch   # 自动 bump 补丁版本

# 登录 npmjs.com（需要有账号和 token）
npm login

# 发布
npm publish

# 用户安装
npm install -g neo-cast
```

---

## npm scripts 速查

```bash
npm run doctor          # 检查环境，等价于 node bin/neo-cast.js doctor
npm run design:mock     # companion 模式 mock 设计，快速冒烟
npm test                # 跑 CLI e2e + Python unit tests
npm run test:watch      # 监听模式跑完整测试入口
npm run dev             # 等价于 node bin/neo-cast.js（需要自己追加子命令）
npm run dev:debug       # 开启 Node.js inspector，等待调试器连接
```

---

## VS Code 调试

仓库已包含 `.vscode/launch.json`，在 VS Code 中按 **F5** 选择配置直接启动：

| 配置名 | 用途 |
|---|---|
| `design (mock, companion)` | 最常用，无需 API key，companion 模式 2 轮 mock 训练 |
| `design (mock, socratic)` | 无需 API key，苏格拉底模式 |
| `design (Claude API, companion)` | 读 `.env` 里的 key，真实 LLM 调用 |
| `doctor` | 快速检查环境 |
| `runner status` | 查看当前实验状态 |
| `e2e tests` | 调试 e2e 测试（可打断点） |

**真实 LLM 调试步骤：**

1. 确保 `.env` 里有 `ANTHROPIC_API_KEY=sk-ant-...`
2. 在 VS Code 左侧 Run & Debug 面板选 `design (Claude API, companion)`
3. 在 `src/llm.js` 或 `src/cli.js` 设断点
4. 按 **F5** 启动

**Node.js inspector 调试（不用 VS Code）：**

```bash
npm run dev:debug -- design --requirement "test" --mock-llm
# 然后用 Chrome 打开 chrome://inspect 连接
```

---

## 常用命令参考

```bash
# 检查环境
neo-cast doctor

# 苏格拉底模式（先问清需求再自动跑）
neo-cast design \
  --requirement "需要一个参数量小、长 horizon 表现好的预测模型" \
  --mode socratic \
  --max-candidates 5

# 认知伴随模式（边训练边解释，可随时输入 stop）
neo-cast design \
  --requirement "transformer based model for ETTh1" \
  --mode companion \
  --max-candidates 5

# mock 模式（不调用 LLM，用启发式规则生成候选）
neo-cast design \
  --requirement "patch mlp model" \
  --mode companion \
  --max-candidates 3 \
  --mock-llm

# 跳过 smoke run（加速开发调试）
neo-cast design --requirement "..." --mock-llm --skip-smoke

# 查看当前最优结果
neo-cast runner status

# 手动触发 ref-test 评估
neo-cast runner ref-test

# 查看 artifact
ls .neo-cast/artifacts/
```

---

## 多 LLM 接入

### Anthropic（默认）

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

用户级配置（`~/.config/neo-cast/config.json`）：

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "temperature": 0.3
  }
}
```

### OpenAI 兼容接口（如 AIGCBEST、本地 vLLM 等）

```bash
export NEO_CAST_LLM_API_KEY="your-key"
```

用户级配置：

```json
{
  "llm": {
    "provider": "openai-compatible",
    "base_url": "https://api.aigcbest.top/v1",
    "model": "gpt-4o-mini",
    "max_tokens": 1024,
    "temperature": 0.3
  }
}
```

`neo-cast config init` 会在 `~/.config/neo-cast/config.json` 生成默认配置文件，编辑后 `neo-cast config show` 可验证生效。

---

## 项目结构速查

```
neo-cast/
  bin/neo-cast.js          ← CLI 入口
  src/
    cli.js                 ← 命令解析与 design 主流程
    config.js              ← 配置加载（env / 用户级 / 项目级）
    doctor.js              ← 环境检查
    llm.js                 ← Claude API / OpenAI 兼容调用 + 启发式 fallback
    python-bridge.js       ← spawn Python 子进程
    runtime.js             ← Python venv 管理
    session.js             ← results.tsv 读取
    output.js              ← 机器可读输出格式（key=value）
    modes/
      socratic.js          ← 苏格拉底模式交互收集需求
      companion.js         ← 认知伴随模式叙述输出 + stop 监听
  test/
    e2e.test.js            ← 端到端测试（node --test）
    python-unit.test.js    ← Python unittest 包装入口
  py/                      ← Python 后端（训练 / 验证 / 导出）
    train.py               ← 训练入口，dispatch 到 families/
    runner.py              ← keep/discard 状态机
    renderer.py            ← candidate JSON → 训练配置
    validate.py            ← schema 校验 + smoke run
    export.py              ← artifact 10 文件导出
    families/              ← 模型族：nlinear / tiny_transformer / patch_mlp
    schemas/               ← candidate_schema.json / metadata_schema.json
  .vscode/launch.json      ← VS Code 调试配置（6 个预设）
  .env.example             ← 环境变量模板
```

---

## 故障排查

| 现象 | 排查步骤 |
|---|---|
| `python3: not available` | 运行 `neo-cast init-runtime` 初始化 venv |
| `ANTHROPIC_API_KEY is not set` | 设置环境变量或 `--mock-llm` 测试 |
| `data not found` | 运行 `neo-cast prepare-data --source /path/to/ETTh1.csv` |
| 训练 crash / shape mismatch | 查看 `.neo-cast/results.tsv`，status=crash 行有描述 |
| `npm link` 后命令找不到 | 检查 npm 全局 bin 目录是否在 `$PATH`：`npm bin -g` |
| LLM 生成的 candidate 被 validator 拒绝 | 检查 `py/schemas/candidate_schema.json` 约束，或用 `--mock-llm` 绕过 |
