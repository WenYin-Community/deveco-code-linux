<p align="center">
  <h1 align="center">DevEco Code</h1>
</p>
<p align="center">面向 HarmonyOS 开发场景的 AI Agent 工具。</p>
<p align="center">
  <a href="README.en.md">English</a> · 简体中文
</p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20x64-blue.svg" />
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-%3E%3D22-green.svg" />
  <img alt="Command Line Tools" src="https://img.shields.io/badge/Command%20Line%20Tools-%3E%3D26.0.0-orange.svg" />
  <a href="https://github.com/WenYin-Community/deveco-code-linux/blob/develop/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green.svg" /></a>
</p>

<p align="center">
  <img src="https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/assets/readme/readme-screenshot.png" alt="DevEco Code" width="600">
</p>

***

## 快速开始

> 本仓库只提供 **Linux x64** 版本。Windows 与 macOS 版本请前往上游仓库：
> [https://atomgit.com/openharmony-sig/deveco-code](https://atomgit.com/openharmony-sig/deveco-code)

### 1. 手动安装 Command Line Tools

Linux 版使用官方 HarmonyOS Command Line Tools（CLT），**不需要安装 DevEco Studio**。请从华为开发者网站手动下载并解压：

[https://developer.huawei.com/consumer/cn/download/command-line-tools-for-hmos](https://developer.huawei.com/consumer/cn/download/command-line-tools-for-hmos)

推荐解压到 `~/command-line-tools` 或 `/opt/harmony-clt`，DevEco Code 会自动探测这两个位置。放在其他路径时，设置：

```bash
export DEVECO_CLI_CLT_PATH=/path/to/command-line-tools
```

验证 CLT：

```bash
"$DEVECO_CLI_CLT_PATH/sdk/default/openharmony/toolchains/hdc" -v
```

### 2. 构建并启动

```bash
git clone https://github.com/WenYin-Community/deveco-code-linux.git
cd deveco-code-linux
bun install
cd packages/opencode
bun run script/build.ts --target=linux-x64 --skip-install
./dist/deveco-linux-x64/bin/deveco
```

构建需要 [Bun](https://bun.sh) **1.4.2 及以上**。

### 3. 开始对话

在终端中直接描述你的 HarmonyOS 开发需求，例如：

- 解释一下代码库的架构
- 帮我重构 login_check 这个函数
- 帮我检查并修复语法错误

> Linux 版本不提供 Previewer，也不启用系统级命令沙箱。

## 简介

DevEco Code 是一款面向 HarmonyOS 开发场景的 AI Agent 工具，支持代码编写、编译构建、设备运行、文档查阅、运行时调试及 ArkTS 问题修复等能力。

DevEco Code 基于开源项目 OpenCode 扩展开发，保留了 OpenCode 的终端交互、配置体系、 Provider / MCP / Skill / Plugin 等能力，并针对 HarmonyOS 工程增加了 Command Line Tools、Hvigor、HDC、Skill、HarmonyOS 知识库、ArkTS 检查和设备调试相关集成。

## 支持平台

| 平台 | 架构 | 说明 |
| --- | --- | --- |
| Linux | x64 | 官方 Command Line Tools（无需 IDE） |

> Windows 与 macOS 版本请前往上游仓库：[https://atomgit.com/openharmony-sig/deveco-code](https://atomgit.com/openharmony-sig/deveco-code)

> Linux 版本以独立项目分发，不进入 npm 安装矩阵。它使用官方 HarmonyOS Command Line Tools（CLT）完成构建与设备调试，不需要安装 DevEco Studio。DevEco Code 会自动探测 `~/command-line-tools`、`/opt/harmony-clt`，也可通过 `DEVECO_CLI_CLT_PATH` 指定 CLT 根目录。Fedora/RHEL 上如遇 Emulator 缺少 `libbz2.so.1.0`，运行时会自动创建兼容符号链接。Linux 版本不提供 Previewer，也不启用系统级命令沙箱。

## 推荐配置

**操作系统**

- **Linux x64**：Fedora、Ubuntu 等主流发行版

**硬件**

- **日常使用**（短会话、单模块改动、以对话与代码编辑为主）：8 GB 及以上内存
- **重度使用**（大工程、长会话、频繁编译构建与模拟器/真机调试）：16 GB 及以上内存；建议为 SDK、模拟器与构建缓存预留 20 GB 及以上可用磁盘空间

**运行时与工具链**

- [Node.js](https://nodejs.org) **22 及以上**（运行内置 devecocli）
- [Bun](https://bun.sh) **1.4.2 及以上**（仅从源码构建时需要）
- [HarmonyOS Command Line Tools](https://developer.huawei.com/consumer/cn/download/command-line-tools-for-hmos) **26.0.0 及以上**（需手动安装）

**终端 Shell**

- Zsh 或 Bash

**网络**

- 需要稳定的互联网连接（华为账号登录、模型调用、HarmonyOS 知识库检索等）

## 安装前置

Linux 版需要以下环境：

1. 手动下载并安装 [HarmonyOS Command Line Tools](https://developer.huawei.com/consumer/cn/download/command-line-tools-for-hmos)，**推荐 26.0.0 及以上**
2. 安装 [Node.js](https://nodejs.org)，**推荐 22 及以上**
3. 如从源码构建，安装 [Bun](https://bun.sh) **1.4.2 及以上**

CLT 推荐解压到 `~/command-line-tools` 或 `/opt/harmony-clt`；其他路径请设置 `DEVECO_CLI_CLT_PATH`：

```bash
export DEVECO_CLI_CLT_PATH=/path/to/command-line-tools
```

验证环境：

```bash
node -v
"$DEVECO_CLI_CLT_PATH/sdk/default/openharmony/toolchains/hdc" -v
```

## 安装与卸载

从源码构建后，产物位于 `packages/opencode/dist/deveco-linux-x64/bin/deveco`。可创建软链接方便调用：

```bash
sudo ln -sf "$PWD/packages/opencode/dist/deveco-linux-x64/bin/deveco" /usr/local/bin/deveco
deveco --version
```

更新：拉取最新代码后重新构建。

卸载：删除软链接与构建产物即可。

```bash
sudo rm -f /usr/local/bin/deveco
rm -rf packages/opencode/dist
```

## 登录与登出

使用 DevEco Code 需先通过华为账号登录。首次执行 `deveco` 时会在终端内引导完成登录；也可单独执行登录命令：

```bash
deveco auth login
```

登出会清除当前华为账号的本地登录状态，下次启动需重新登录。执行：

```bash
deveco auth logout
```

## 模型配置

登录后可使用 DevEco Code 提供的免费模型通道。

在 DevEco Code 中输入 `/models` 可进入模型配置界面。当前免费提供 `GLM-5.1` 模型，单账号默认每分钟 50 次请求。也可以通过 `/connect` 进入 Provider 选择界面，配置支持的第三方模型。

内置免费模型通道在登录后自动可用，无需在配置文件中手动配置。如需接入其他模型服务，可以通过 `deveco.jsonc` 配置第三方 Provider（以下字段均为占位符，请替换为你的服务商信息）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    // Provider ID，自定义命名即可，其他配置中通过 "<provider-id>/<model-id>" 引用模型
    "myprovider": {
      // 可选，缺省即为 openai-compatible；非 OpenAI 兼容的服务商才需要指定
      "npm": "@ai-sdk/openai-compatible",
      // 显示名称，可自定义
      "name": "My Provider",
      "models": {
        // 替换为服务商提供的模型 ID
        "<your-model-id>": {
          "tool_call": true,
          "limit": {
            "context": 200000,
            "output": 8192
          }
        }
      },
      "options": {
        // 替换为服务商的 API 地址
        "baseURL": "https://<your-endpoint>/v1",
        // 替换为你的 API Key
        "apiKey": "<your-api-key>"
      }
    }
  }
}
```

**UI 检查配置**

UI 检查是功能验证阶段的可选能力，用于验证界面是否符合需求描述。

该功能需调用多模态模型（仅用于 UI 检查，不作为主对话模型）：已登录账号时默认使用内置 Qwen3.5 模型，未登录时则跳过 UI 检查。

如需配置第三方多模态模型（仅支持 Qwen 系列），可在 `deveco.jsonc` 的 `agent` 中指定，以 qwen3-vl-plus 为例：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "myprovider": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "alibaba",
      "options": {
        "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "apiKey": "<your-api-key>",
      },
      "models": {
        "qwen3-vl-plus": {
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"],
          },
        },
      },
    },
  },
  "agent": {
    "ui_verification": {
      "mode": "subagent",
      "model": "myprovider/qwen3-vl-plus", // 格式为 <provider-id>/<model-id>
      "hidden": true,
    },
  },
}
```

配置文件读取优先级：

1. 项目目录下 `.deveco/deveco.jsonc`
2. 项目目录下 `deveco.jsonc`
3. 用户目录下 `.config/deveco/deveco.jsonc`

## Agent 配置

DevEco Code 面向 HarmonyOS 开发提供以下 Agent 配置（按 `Tab` 键切换）：

- `Build`：默认模式，适合工程生成、代码生成、配置修正、测试执行、推包运行和发布执行
- `Plan`：适合需求拆解、技术方案、发布规划、测试规划和文档生成
- `Goal`：适合 SDD 五阶段从需求到实现与构建验证的端到端特性交付

## HarmonyOS 场景能力

DevEco Code 集成了常用 HarmonyOS 开发工具能力：

| 工具                       | 说明                   |
| ------------------------ | -------------------- |
| `build_project`          | 执行编译构建并导出构建产物        |
| `start_app`              | 在模拟器或真机上运行应用         |
| `hdc_log`                | 收集/清理设备日志/查看连接模拟器    |
| `verify_ui`              | 执行 UI 操作验证功能是否正确        |
| `switch_cwd`             | 切换构建项目路径             |

常见场景包括：从零到一创建 HarmonyOS 工程、增量开发页面、修复编译报错、真机调试。

### UX 设计稿生成 ArkTS 代码

内置 `hmos-design-to-arkts` Skill 可把 Figma / Pixso / MasterGo 的 UX 设计稿转换成现有 ArkTS 工程中的页面。支持基于直板机设计稿生成一套 ArkTS 代码，同时具备响应式布局与多设备适配能力，可在直板机、双折叠、三折叠、阔折叠等设备上正常运行。

使用前需按设计稿来源配置对应 MCP（配置后需重启 DevEco Code 生效）：

| 来源 | 配置 |
| --- | --- |
| Figma | [Anchor MCP](https://gitcode.com/OpenHarmonyToolkitsPlaza/anchor-d2c-mcp)：先设置 `FIGMA_ACCESS_TOKEN` 环境变量，再执行 `deveco mcp add`，名称 `anchor-d2c-mcp`、类型 `Local`、命令 `npx -y anchor-d2c-mcp@latest stdio` |
| Pixso | [Pixso MCP](https://pixso.cn/developer/zh/mcp/remote-mcp.html)：远程形态免开客户端，执行 `deveco mcp add pixso-mcp --url https://pixso.cn/mcp` 后再执行 `deveco mcp auth pixso-mcp` 完成授权；也可以使用[本地 MCP](https://pixso.cn/developer/zh/mcp/local-mcp.html) 服务 |
| MasterGo | [Magic MCP](https://mastergo.com/help/ai-features/magic-mcp.html)（需团队版账号与 `MG_MCP_TOKEN` 环境变量）或 [Vibe MCP](https://mastergo.com/help/ai-features/vibe-mcp.html)（需已开启 MCP 的桌面客户端）；两者都不适用时可用[社区插件](https://github.com/burnice-cn/mastergo-mcp-server)（插件通道，需本机配对） |

说明：MCP 未就绪时，Skill 会先给出配置引导并停下，不会带着缺失依赖开始。

在目标工程目录下启动 DevEco Code 后，给出设计稿链接和需求说明即可；Agent 会自动识别需求并加载 `hmos-design-to-arkts` Skill 生成页面代码（信息不全时会先澄清再开始）：

```text
把这个 Figma 设计稿转成 ArkTS 页面：https://www.figma.com/design/xxxx/OrderList?node-id=1-2（订单列表画板），点击列表项进入详情页
```

提供 Fast 与 Full 两种工作流：Fast 直接快速出页面，推荐使用 Full，它额外包含组件树人工确认与按还原度评分迭代的视觉校准（需模拟器或真机）。`Goal` 模式默认 Full，`Build` 模式默认 Fast；也可在需求中直接说明使用哪一种。`Plan` 模式不支持该 Skill。

## 扩展能力

DevEco Code 兼容 OpenCode 的 Skill、MCP 和 Plugin 扩展方式。

> 新增或修改 Skill、MCP、Plugin 配置后，需退出并重新执行 `deveco` 启动后才会生效。

### Skills

```bash
npx skills add vercel-labs/agent-skills
```

也可以把 Skill 放到 `~/.config/deveco/skills` 目录。

### MCP

可在 `~/.config/deveco/deveco.jsonc` 中配置 MCP：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "@playwright/mcp@latest"],
      "enabled": true
    }
  }
}
```

### Plugins

```bash
npm install -g oh-my-opencode
```

然后在 `deveco.jsonc` 中配置插件入口：

```jsonc
{
  "plugin": [
    "node_modules/oh-my-opencode/dist/index.js"
  ]
}
```

## 从 OpenCode 迁移

如果需要从 OpenCode 迁移到 DevEco Code，请将配置文件迁移到 DevEco Code 目录：

```bash
cp {源路径}/opencode.jsonc ~/.config/deveco/deveco.jsonc
```

Skills、Agents、Plugins 也可以迁移到 `~/.config/deveco` 下的对应目录；MCP 配置项可迁移到 `deveco.jsonc` 中。

## 参与贡献

欢迎贡献！请在提交 Pull Request 前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 帮助与支持

- 完整文档请参阅 [DevEco Code 使用文档](docs/deveco-code-docs.html)（需下载到本地后打开），也可在线阅读 [OpenCode TUI 文档](https://opencode.ai/docs/zh-cn/tui/)
- 常见问题请参阅 [FAQ 文档](https://gitcode.com/openharmony-sig/deveco-code/wiki/FAQ.md)
- 反馈与交流 [GitCode Issue](https://gitcode.com/openharmony-sig/deveco-code/issues)

## 开源许可

[MIT License](LICENSE)

## 基于 OpenCode 构建的声明

本项目基于开源项目 [OpenCode](https://opencode.ai) 扩展开发。DevEco Code **并非** OpenCode 团队出品，也与 OpenCode 团队无任何附属或关联关系。如有与 DevEco Code 相关的问题，请通过 [GitCode Issue](https://gitcode.com/openharmony-sig/deveco-code/issues) 反馈，而非联系 OpenCode 社区。
