# NeoResearch npm 发布可行性评估

## 结论

当前 NeoResearch 代码还不建议直接发布到 npm。

当前版本的功能验证已经比较扎实，可以作为本地开发版或 internal alpha 使用；但发布工程还没有完成，直接 `npm publish` 会遇到包身份、命令名、workspace 依赖、Neo-Cast runner 分发等问题。

## 当前状态

NeoResearch 当前代码主体位于：

- `neo-research/opencode`
- `neo-research/neo_cast`

其中 `neo-research/opencode` 是基于 OpenCode fork 后改造出来的 Research OS 主体，`neo-research/neo_cast` 是 TSF/Neo-Cast domain runner。

目前已经完成了较多本地闭环能力：

- Research task / candidate / run / champion / artifact / memory / approval 数据模型；
- Web Dashboard 和 TUI Cockpit 的研究任务操作入口；
- TimeRecipe 风格 candidate schema；
- Neo-Cast Python runner 的 phase2/native action 执行能力；
- `prepareRun` 生成 runner plan 并入队；
- `research worker-once` 和 `research worker-loop` 本地 worker 执行路径；
- worker 结果回写 Research DB；
- runner execution log artifact、metrics、artifact、champion、memory 回写。

但这些还不等于 npm release 已经 ready。

## 主要阻塞项

### 1. package 身份仍是 OpenCode

当前 `package.json` 仍保留大量 OpenCode 身份：

- root package name: `opencode`
- CLI package name: `opencode`
- bin name: `opencode`
- workspace 包名仍是 `@opencode-ai/*`
- repository 仍指向 `https://github.com/anomalyco/opencode`

如果发布 NeoResearch，需要先决定新的包名和命令名，例如：

- `neoresearch`
- `neo-research`
- `@neo-research/cli`
- 或短期先保留 `opencode research ...` 作为内部 alpha 命令。

### 2. 关键 package 仍是 private

`neo-research/opencode/packages/opencode/package.json` 当前仍然包含：

```json
{
  "private": true
}
```

这意味着直接 `npm publish` 会被拒绝。发布前必须明确哪些包要公开发布，哪些仍保持 private。

### 3. Neo-Cast Python runner 不在 npm 发布链路里

NeoResearch 的 TSF 实验能力依赖 `neo-research/neo_cast`。

如果只发布 `opencode/packages/opencode` 这个 npm 包，用户并不会自动获得 Neo-Cast Python runner。

需要先决定分发策略：

- 将 Neo-Cast runner 打进 npm 包；
- npm 安装后通过初始化命令下载或生成 Neo-Cast runtime；
- 要求用户手动指定 `--neo-cast-root`；
- 将 TSF runner 作为独立 domain plugin 分发。

### 4. workspace 依赖还没有发布策略

CLI package 当前依赖多个 workspace 包，例如：

- `@opencode-ai/core`
- `@opencode-ai/sdk`
- `@opencode-ai/plugin`
- `@opencode-ai/script`
- `@opencode-ai/ui`

发布前需要决定：

- 这些包是否一起改名并发布；
- 是否继续沿用 `@opencode-ai/*` 作为 fork 内部依赖；
- 是否通过 build bundle 把依赖打进去；
- 是否只发布一个整合后的 CLI tarball。

### 5. 品牌、命令和文档还没有 release 化

当前代码中仍有大量 OpenCode 文案、配置路径、命令提示和文档引用。

发布前至少需要处理：

- CLI script name；
- bin 名称；
- help 文案；
- README；
- npm description；
- repository；
- issue URL；
- license / attribution；
- 默认配置目录是否仍使用 `.opencode`；
- 是否保留 OpenCode 通用 coding agent 入口。

### 6. 还没有做 npm pack 安装烟测

发布前不能只依赖 unit test 和 typecheck。

还需要至少完成：

```bash
npm pack --dry-run
npm pack
npm install -g ./<generated-tarball>.tgz
neo-research --help
neo-research research --help
neo-research research create --mode review
neo-research research prepare <taskID> <candidateID>
neo-research research worker-once
```

如果最终命令仍叫 `opencode`，也需要在全新目录做同等烟测。

## 建议发布路线

### 阶段 1：internal alpha

目标：只面向本机或小范围内部使用。

建议：

- 保持当前 monorepo 结构；
- 不发布 npm；
- 通过 git clone 或本地脚本运行；
- 文档中明确这是 OpenCode fork；
- 继续验证 Research OS + Neo-Cast 的端到端实验闭环。

### 阶段 2：npm alpha

目标：发布 `0.1.0-alpha.0`，允许外部安装和试用。

发布前需要完成：

- 确定 npm 包名；
- 确定 CLI bin 名；
- 去掉目标包的 `private: true`；
- 处理 workspace 依赖发布或 bundle；
- 明确 Neo-Cast runner 分发方式；
- 完成 README / license / attribution；
- 跑 `npm pack --dry-run`；
- 在干净目录做全新安装烟测。

### 阶段 3：插件化 / 多 domain 发布

目标：从 Neo-Cast TSF 扩展到通用 Research OS。

建议抽象：

- `ResearchDomain`
- `TaskSpec`
- `CandidateSpec`
- `Evaluator`
- `ArtifactExporter`
- `Runner`
- `MemoryStore`
- `GovernancePolicy`

TSF/Neo-Cast 作为第一个内置 domain plugin。

## 发布前 Checklist

- [ ] 决定 npm 包名。
- [ ] 决定 CLI 命令名。
- [ ] 修改 root/package package metadata。
- [ ] 去掉待发布 package 的 `private: true`。
- [ ] 明确 workspace 依赖发布策略。
- [ ] 明确 Neo-Cast runner 分发策略。
- [ ] 更新 README。
- [ ] 更新 npm description。
- [ ] 更新 repository / bugs / homepage。
- [ ] 检查 OpenCode attribution 和 license。
- [ ] 检查是否仍有不应公开的 OpenCode branding。
- [ ] 跑 OpenCode/NeoResearch TypeScript typecheck。
- [ ] 跑 Research service / CLI / TUI / Web helper 测试。
- [ ] 跑 Neo-Cast Python 测试。
- [ ] 跑 `npm pack --dry-run`。
- [ ] 在干净目录安装 tarball 并做 CLI 烟测。
- [ ] 确认 npm token 和发布权限。
- [ ] 先发 `0.1.0-alpha.0`，不要直接发 stable。

## 当前判断

当前版本不适合直接 npm 正式发布。

更准确的状态是：

> NeoResearch 当前已经接近可用的本地 internal alpha，但还没有完成 npm release hardening。

下一步应该开一个 release-hardening 分支，专门处理包身份、命令名、依赖分发、Neo-Cast runner 打包和 npm 安装烟测。
