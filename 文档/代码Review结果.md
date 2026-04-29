# NeoResearch 代码 Review 结果

生成时间：2026-04-29

Review 范围：`neo-research/neo_cast` 当前实现，包括 Node CLI、Python TSF runner、测试与 npm 发布配置。`参考源码/opencode` 体量较大，本次只作为系统边界参考，未逐文件审查。

## Findings

### P1. `npm test` 当前不可作为干净环境回归测试

位置：

- `neo_cast/test/e2e.test.js:46`
- `neo_cast/test/e2e.test.js:69`
- `neo_cast/test/e2e.test.js:113`
- `neo_cast/test/e2e.test.js:115`

现象：

```text
npm test
tests 6
pass 4
fail 2

失败 1:
design mock mode runs one candidate and updates results
Runtime not initialized. Run: neo-cast init-runtime

失败 2:
runner ref-test evaluates the best artifact and updates metadata
runner state must exist before ref-test
```

原因是 e2e 测试直接使用源码根目录的 `.neo-cast/results.tsv`、`.neo-cast/runtime/.venv/bin/python` 和 `.neo-cast/runner_state.json`，而不是在临时目录里完整 bootstrap runtime、dataset、runner state 和 best artifact。这样测试依赖人工预先执行过的本地状态，也会污染或读取开发者本机的状态。

影响：

- CI 或新机器 checkout 后会失败。
- 测试结果受本地 `.neo-cast` 残留状态影响，不可复现。
- ref-test 测试不是自包含测试，不能证明 ref-test 链路本身可用。

建议：

- e2e 测试统一使用 `fs.mkdtempSync()` 创建 project fixture。
- 在 fixture 中显式执行 `init-runtime --skip-install` 或注入 `NEO_CAST_PYTHON`。
- ref-test 用测试内生成的 artifact 和 runner state，不依赖仓库根目录已有 best run。
- 将会修改工作区状态的测试与只读单元测试拆开，避免 `npm test` 默认破坏本地实验目录。

### P1. npm 全局安装后的项目根目录语义不一致

位置：

- `neo_cast/README.md:95`
- `neo_cast/src/python-bridge.js:35`
- `neo_cast/src/python-bridge.js:36`
- `neo_cast/src/python-bridge.js:48`
- `neo_cast/src/python-bridge.js:49`
- `neo_cast/src/cli.js:202`
- `neo_cast/src/cli.js:204`
- `neo_cast/py/runner.py:30`
- `neo_cast/py/runner.py:31`
- `neo_cast/py/runner.py:32`
- `neo_cast/py/validate.py:23`
- `neo_cast/py/validate.py:24`
- `neo_cast/py/validate.py:26`
- `neo_cast/py/dataset_contract.py:11`
- `neo_cast/py/dataset_contract.py:12`

README 明确写了全局 npm 安装后可以把 `node ./bin/neo-cast.js` 替换成 `neo-cast`。但当前代码对“项目根目录”的定义不一致：

- Node CLI 的 `projectRoot` 来自 `process.cwd()`。
- `src/python-bridge.js` 用 `path.join(projectRoot, "py", scriptName)` 查找 Python 脚本，要求用户当前目录也有一份 `py/runner.py`。
- `src/cli.js` 的部分命令用 `__dirname/../py/*.py` 调包内脚本。
- Python 脚本内部又用 `Path(__file__).resolve().parent.parent` 作为 `PROJECT_ROOT`，默认把 npm 包所在目录当状态目录，而不是用户执行 `neo-cast` 的目录。

影响：

- 从源码根目录运行时看起来正常；全局安装后在任意项目目录运行会出现两类相反问题：有些命令找不到 `cwd/py/*.py`，有些命令会把 `.neo-cast` 状态写到 npm 包安装目录。
- `neo-cast design`、`neo-cast runner`、`neo-cast validate smoke`、`neo-cast prepare-data` 的状态路径和脚本路径可能不一致。
- 这会直接阻断“作为 npm CLI 发布并在外部项目使用”的目标。

建议：

- 明确拆分 `packageRoot` 与 `projectRoot`。
- 所有 Python 脚本路径从 `packageRoot` 解析，所有 state/data/artifact 路径从 `projectRoot` 传参进入 Python。
- 给 Python 入口增加 `--project-root` 或环境变量，例如 `NEO_CAST_PROJECT_ROOT`，禁止脚本内部默认把 `__file__` 父目录当用户项目根。
- 增加一个从临时目录调用已打包 CLI 的安装后 smoke test。

### P1. runtime 初始化没有强制 Python >= 3.10

位置：

- `neo_cast/src/runtime.js:47`
- `neo_cast/src/runtime.js:52`
- `neo_cast/src/doctor.js:40`
- `neo_cast/src/doctor.js:44`
- `neo_cast/src/doctor.js:47`
- `neo_cast/src/doctor.js:53`

现象：

```text
node bin/neo-cast.js doctor
[FAIL] python3: Python 3.9.6 [system python3]
  neo-cast requires python3 >= 3.10.
[FAIL] runtime: Project runtime is not initialized.
```

`doctor` 能检查 Python >= 3.10，但 `initRuntime()` 只是执行 `uv venv <venvDir>`，没有指定 `--python 3.10+`，也没有在 venv 创建后校验版本。当前机器默认 `python3` 是 3.9.6，存在创建出不满足项目要求 runtime 的风险。

影响：

- 用户按提示运行 `neo-cast init-runtime` 后仍可能得到不兼容 venv。
- 依赖安装、类型语法、训练脚本运行可能在后续阶段才失败，错误定位不直接。

建议：

- `uv venv` 显式传入 `--python >=3.10` 或固定支持版本，例如 3.11/3.12。
- runtime 创建完成后复用 `doctor.checkPython()` 校验 venv Python，而不是只判断 `bin/python` 文件存在。
- `doctor` 的修复建议应区分“系统 Python 不达标”和“runtime 未创建”，避免让用户以为 init-runtime 一定能自动解决版本问题。

### P2. Node CLI 暴露的 runner 子命令与 Python runner 不一致

位置：

- `neo_cast/src/cli.js:238`
- `neo_cast/src/cli.js:257`
- `neo_cast/py/runner.py:493`
- `neo_cast/py/runner.py:499`
- `neo_cast/py/runner.py:527`
- `neo_cast/py/runner.py:528`
- `neo_cast/py/runner.py:529`

现象：

```text
node bin/neo-cast.js runner blind-test
Usage: neo-cast runner <init|run|ref-test|status> [flags]
```

Python runner 已实现 `blind-test` parser 和 main 分支，但 Node CLI 的 `handleRunner()` 只允许 `init|run|ref-test|status`，导致用户无法通过正式 CLI 触达 blind-test sidecar。

影响：

- `docs/blind_test_sidecar.md` 描述的 blind-test 能力不能通过 npm CLI 使用。
- OpenCode 或外部编排如果只调用 `neo-cast runner ...`，会在 blind-test 阶段被 CLI 拦截。

建议：

- 在 Node CLI 中补齐 `blind-test` 子命令和 `--run-id` 透传。
- 帮助文本、README、测试一起更新。
- 增加 `node bin/neo-cast.js runner blind-test --run-id ...` 的命令解析测试。

### P2. npm 发布包边界未收敛，且 publish dry-run 报 package 元数据修正

位置：

- `neo_cast/package.json:1`
- `neo_cast/package.json:5`
- `neo_cast/package.json:6`
- `neo_cast/.gitignore:8`
- `neo_cast/.gitignore:14`

现象：

```text
npm pack --dry-run --json
npm warn gitignore-fallback No .npmignore file found, using .gitignore for file exclusion.
entryCount: 83
unpackedSize: 2465688
```

打包清单包含 `.vscode/launch.json`、`py/tests/*`、多份架构/工作流 Markdown、`load_dataset/load.csv`、`uv.lock` 等非 CLI 运行最小集文件。

同时：

```text
npm publish --dry-run --json
npm warn publish npm auto-corrected some errors in your package.json when publishing.
npm warn publish "bin[neo-cast]" script name bin/neo-cast.js was invalid and removed
```

影响：

- 包内容混入开发资料、测试文件和样例数据，安装体积与发布边界不可控。
- publish dry-run 已经提示 `bin` 元数据被修正，需要先确认真实发布后 CLI shim 是否仍会按预期生成。
- 当前发布结果不适合作为稳定 npm 包对外分发。

建议：

- 在 `package.json` 增加 `files` 白名单，只包含 `bin/`、`src/`、`py/` 运行必要文件、schemas、README、LICENSE、package metadata。
- 或增加 `.npmignore` 明确排除 `.vscode/`、`test/`、`py/tests/`、本地数据、架构草稿、工作计划文档。
- 执行 `npm pkg fix` 并检查修正前后的 `package.json` diff。
- 用 `npm pack` 产物做一次本地安装 smoke test，验证 `neo-cast --version`、`doctor`、`runner init` 的 bin shim 与状态目录行为。

## 当前可用性判断

当前代码更接近“源码目录内可运行的 MVP 原型”，还不是“可稳定测试、可全局安装、可 npm 发布的 CLI 产品”。

已具备的部分：

- Node CLI 主命令结构已经存在。
- Python TSF runner、recipe factory、训练、导出、ref-test/blind-test sidecar 的核心模块已经比较完整。
- Python 单元测试可以通过。
- `npm pack --dry-run` 和 `npm publish --dry-run` 能跑通到 dry-run 输出阶段。

主要阻断点：

- 默认测试套件失败。
- 安装后 projectRoot/packageRoot 边界没有打通。
- runtime Python 版本选择不可靠。
- blind-test CLI 暴露缺口。
- npm 包内容和元数据还未收敛。

## Review 中执行过的验证命令

```bash
npm test
node bin/neo-cast.js doctor
node bin/neo-cast.js runner blind-test
npm pack --dry-run --json
npm publish --dry-run --json
```

结果摘要：

- `npm test`：失败，6 个测试中 4 pass / 2 fail。
- `doctor`：失败，Python 3.9.6、API key 缺失、runtime 未初始化。
- `runner blind-test`：失败，Node CLI usage 拒绝该子命令。
- `npm pack --dry-run --json`：成功，但包内容过宽，有 `.npmignore` fallback warning。
- `npm publish --dry-run --json`：成功到 dry-run 输出，但有 package auto-correct 与 `bin[neo-cast]` warning。

