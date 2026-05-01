# NeoResearch Alpha 使用说明

NeoResearch 当前已经可以使用，但仍处于 **alpha 可用状态**。该版本适合内部试用、早期反馈和本地 TSF 实验验证，不建议作为稳定版对外宣传。

## 安装与启动

在当前 macOS arm64 环境中，可以通过 npm 安装 alpha 版本：

```bash
npm install -g neo-research@alpha
neo-research --version
neo-research doctor
neo-research init
neo-research cockpit
```

`neo-research --version` 应输出 `0.1.0-alpha.0`。`neo-research doctor` 用于检查本机环境、Python 可用性、关键 Python 包导入状态，以及 Neo-Cast runner 是否可执行。

## 配置本地 Neo-Cast

如果要让 NeoResearch 调用本地 `neo_cast` runner，需要先配置 `NEO_CAST_ROOT`：

```bash
export NEO_CAST_ROOT=/Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo-research/neo_cast
neo-research doctor
```

配置成功后，`doctor` 应显示 `NEO_CAST_ROOT`、`python`、`python-imports` 和 `smoke-runner` 均为可用状态。

## 当前限制

- 已发布并验证的是 `macOS arm64` 版本，本机可用。
- Linux、Windows、macOS x64 尚未发布对应平台二进制包。
- 当前版本号为 `0.1.0-alpha.0`，仍属于早期版本。
- 建议安装时显式使用 `neo-research@alpha`，避免误认为是稳定版。

## 安全提醒

此前使用过的 npm token 已经在对话中暴露，应立即在 npm 网站的 Access Tokens 页面撤销，并为后续 CI/CD 重新生成新的 token。
