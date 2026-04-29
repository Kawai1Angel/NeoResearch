# NeoResearch 本地源码安装与调试修正策略

## 结论

当前 NeoResearch 可以本地源码安装和调试，但需要分别准备两个子项目环境：

- `neo-research/opencode`
- `neo-research/neo_cast`

这对研发期可以接受，但对长期使用、换机器、交给别人试用或准备 npm alpha 都会比较麻烦。

修正策略不是把两个目录硬合并，而是在 `neo-research/` 根目录增加统一的本地开发入口，把两个子项目的准备、检查、启动、测试流程封装起来。

推荐方向：

> 保留双目录架构，增加一键 bootstrap、doctor、test、dev 脚本，并补 runner discovery。

## 当前麻烦在哪里

现在本地调试大致需要手动执行两组命令。

### OpenCode / NeoResearch OS 侧

```bash
cd neo-research/opencode
bun install
bun run --cwd packages/opencode --conditions=browser src/index.ts research --help
```

### Neo-Cast runner 侧

```bash
cd neo-research/neo_cast
python3 -m unittest py.tests.test_train_execution
bash scripts/neo_research_tsf_e2e.sh --dry-run --stage smoke --candidate py/schemas/recipe.example.json
```

中间还需要用户自己确认：

- Bun 是否安装；
- Node/npm 是否可用；
- Python 是否可用；
- PyTorch / numpy 等 Python 依赖是否可用；
- `opencode` 侧能否找到 `neo_cast`；
- `--neo-cast-root` 是否设置正确；
- `research worker-once` 执行时 cwd 是否正确；
- `.neo-research/runtime` 是否存在；
- `.neo-cast/artifacts` 是否存在；
- CLI / Web / TUI 是否都读到同一套 research task 数据。

这说明当前系统逻辑已经能连通，但开发者体验还没有产品化。

## 推荐修正策略

推荐分三层修正：

1. Local Dev Bootstrap；
2. Runner Discovery；
3. Makefile / Script 统一入口。

## 第一阶段：Local Dev Bootstrap

目标是让本地源码调试变成：

```bash
cd neo-research
./scripts/bootstrap_local_dev.sh
./scripts/doctor.sh
./scripts/dev_cli.sh research --help
```

### 建议新增脚本

```text
neo-research/
  scripts/
    bootstrap_local_dev.sh
    doctor.sh
    test_all.sh
    dev_cli.sh
    dev_web.sh
    smoke_tsf.sh
```

### bootstrap_local_dev.sh

职责：

- 检查 Bun；
- 检查 Node；
- 检查 npm；
- 检查 Python；
- 安装或提示安装 `opencode` workspace 依赖；
- 检查 Python 依赖；
- 生成 `.env.local`；
- 写入默认 `NEO_CAST_ROOT`；
- 初始化 `.neo-research/runtime`；
- 初始化 `.neo-cast/artifacts`；
- 跑最小 smoke check；
- 输出下一步启动命令。

示例目标体验：

```bash
./scripts/bootstrap_local_dev.sh
```

输出类似：

```text
Bun: OK
Node: OK
npm: OK
Python: OK
OpenCode workspace dependencies: OK
Neo-Cast Python dependencies: OK
NEO_CAST_ROOT: /path/to/neo-research/neo_cast
Research runtime root: .neo-research/runtime
Smoke dry-run: OK

Next:
  ./scripts/dev_cli.sh research --help
  ./scripts/dev_web.sh
  ./scripts/test_all.sh
```

### doctor.sh

职责：

- 不修改环境；
- 只检查当前环境是否完整；
- 给出明确错误和修复建议。

检查项：

- Bun；
- Node；
- npm；
- Python；
- torch；
- numpy；
- Neo-Cast root；
- recipe schema；
- OpenCode Research CLI；
- worker runtime；
- smoke dry-run。

示例：

```bash
./scripts/doctor.sh
```

输出类似：

```text
Bun: OK
Node: OK
Python: OK
PyTorch: OK
Neo-Cast root: OK
Recipe schema: OK
OpenCode Research CLI: OK
Worker runtime: OK
Smoke dry-run: OK
```

### test_all.sh

职责：

- 统一运行 OpenCode 侧和 Neo-Cast 侧测试；
- 不要求用户分别进入两个目录。

包含：

- Research service tests；
- CLI research tests；
- TUI cockpit data/render tests；
- Web dashboard helper tests；
- OpenCode typecheck；
- App typecheck；
- Neo-Cast Python tests；
- E2E dry-run。

### dev_cli.sh

职责：

- 从根目录启动当前源码版 CLI；
- 自动注入 `NEO_CAST_ROOT`；
- 避免用户手动 `cd opencode/packages/opencode`。

目标体验：

```bash
./scripts/dev_cli.sh research --help
./scripts/dev_cli.sh research create --mode review
./scripts/dev_cli.sh research worker-once
```

### dev_web.sh

职责：

- 从根目录启动 Web Dashboard；
- 自动进入 `opencode/packages/app`；
- 自动读取 `.env.local`；
- 输出本地 URL。

目标体验：

```bash
./scripts/dev_web.sh
```

### smoke_tsf.sh

职责：

- 跑最小 TSF dry-run；
- 验证 Neo-Cast runner 可被当前环境调用。

目标体验：

```bash
./scripts/smoke_tsf.sh
```

## 第二阶段：Runner Discovery

当前 `opencode` 侧需要更稳定地找到 `neo_cast`。

推荐 discovery 优先级：

1. CLI 参数；
2. 环境变量；
3. `.env.local`；
4. 默认 sibling path；
5. npm 内置路径；
6. domain registry。

### 1. CLI 参数

最高优先级：

```bash
neo-research research create --neo-cast-root /path/to/neo_cast
```

适合临时指定 runner。

### 2. 环境变量

```bash
NEO_CAST_ROOT=/path/to/neo_cast neo-research research worker-once
```

适合本地开发和 CI。

### 3. `.env.local`

根目录生成：

```env
NEO_CAST_ROOT=/path/to/neo-research/neo_cast
NEO_RESEARCH_RUNTIME_ROOT=/path/to/neo-research/.neo-research/runtime
```

适合本地源码调试。

### 4. 默认 sibling path

当从源码目录运行时，默认查找：

```text
neo-research/neo_cast
```

这对当前双目录结构最友好。

### 5. npm 内置路径

未来 npm alpha 可以支持：

```text
<installed-package>/runners/neo_cast
```

### 6. domain registry

长期可以支持：

```bash
neo-research domain list
neo-research domain doctor tsf
neo-research domain install tsf
```

## 第三阶段：Makefile / 统一命令

可以在根目录增加 `Makefile`，让常用命令更短。

建议命令：

```bash
make setup
make doctor
make test
make dev-cli
make dev-web
make smoke
```

对应关系：

```text
make setup    -> ./scripts/bootstrap_local_dev.sh
make doctor   -> ./scripts/doctor.sh
make test     -> ./scripts/test_all.sh
make dev-cli  -> ./scripts/dev_cli.sh
make dev-web  -> ./scripts/dev_web.sh
make smoke    -> ./scripts/smoke_tsf.sh
```

这样用户不需要记两个子项目的路径和命令。

## 不建议的修正方式

不建议现在把 `opencode` 和 `neo_cast` 合并成一个目录。

原因：

- 会削弱 Research OS 和 domain runner 的边界；
- 不利于未来多 domain plugin；
- 会让 TSF 实现和通用 Research OS 耦合过深；
- npm 发布时会更难拆分 Node 和 Python 依赖；
- 后续接入其他 domain 会更困难。

真正该修的是开发入口和 runner discovery，不是目录结构。

## 推荐实施顺序

### Step 1：新增根目录 scripts

先补：

- `scripts/bootstrap_local_dev.sh`
- `scripts/doctor.sh`
- `scripts/test_all.sh`
- `scripts/dev_cli.sh`
- `scripts/dev_web.sh`
- `scripts/smoke_tsf.sh`

### Step 2：补 `.env.local` 支持

让本地脚本和 OpenCode-side runner discovery 都能读取：

```env
NEO_CAST_ROOT=...
NEO_RESEARCH_RUNTIME_ROOT=...
```

### Step 3：补 runner discovery helper

在 `opencode` 侧集中实现：

```text
resolveNeoCastRoot(...)
```

避免各处手写路径逻辑。

### Step 4：补 doctor 输出

让 `doctor.sh` 输出清楚：

- 当前检查项；
- OK / FAIL；
- 失败原因；
- 修复命令。

### Step 5：补文档

更新：

- README；
- system architecture；
- npm publish readiness；
- local dev guide。

## 判断标准

当以下命令能在干净机器或干净 shell 中工作时，就说明本地源码调试体验合格：

```bash
cd neo-research
./scripts/bootstrap_local_dev.sh
./scripts/doctor.sh
./scripts/dev_cli.sh research --help
./scripts/smoke_tsf.sh
./scripts/test_all.sh
```

如果未来加 Makefile，则应该支持：

```bash
make setup
make doctor
make smoke
make test
```

## 一句话总结

当前两子项目分别准备环境确实会麻烦，但不需要大改架构。保留 `opencode` 和 `neo_cast` 的清晰边界，在根目录增加 bootstrap / doctor / test / dev 脚本，并补 runner discovery，就能把双目录复杂度包装成接近一键的本地源码开发体验。
