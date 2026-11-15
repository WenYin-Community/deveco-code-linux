<p align="center">
  <h1 align="center">DevEco Code</h1>
</p>
<p align="center">An AI Agent tool for HarmonyOS application development.</p>
<p align="center">
  <a href="README.md">简体中文</a> · English
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

## Quick Start

> This repository provides the **Linux x64** build only. For Windows and macOS, use the upstream repository:
> [https://atomgit.com/openharmony-sig/deveco-code](https://atomgit.com/openharmony-sig/deveco-code)

### 1. Install the Command Line Tools manually

The Linux build uses the official HarmonyOS Command Line Tools (CLT) and **does not require DevEco Studio**. Download and extract the CLT from Huawei's developer site:

[https://developer.huawei.com/consumer/cn/download/command-line-tools-for-hmos](https://developer.huawei.com/consumer/cn/download/command-line-tools-for-hmos)

Extract it to `~/command-line-tools` or `/opt/harmony-clt`; DevEco Code probes both automatically. For other locations, set:

```bash
export DEVECO_CLI_CLT_PATH=/path/to/command-line-tools
```

Verify the CLT:

```bash
"$DEVECO_CLI_CLT_PATH/sdk/default/openharmony/toolchains/hdc" -v
```

### 2. Install and launch

Download the latest Linux x64 archive from [Releases](https://github.com/WenYin-Community/deveco-code-linux/releases), extract it, and run the installer:

```bash
tar -xzf deveco-linux-x64-<date>.tar.gz -C deveco-linux-x64
cd deveco-linux-x64
./install.sh
deveco
```

The installer never downloads anything; it uses the extracted `bin/` and `vendor/` in the current directory.

### 3. Start a conversation

Describe your HarmonyOS development task directly in the terminal, for example:

- Explain the architecture of this codebase
- Refactor the login_check function
- Check and fix syntax errors

> The Linux build does not provide the Previewer and does not enable the OS-level command sandbox.

## Overview

DevEco Code is an AI Agent tool for HarmonyOS development. It supports code writing, project building, device deployment, documentation lookup, runtime debugging, and ArkTS issue fixing.

DevEco Code extends the open-source project [OpenCode](https://opencode.ai), keeping its terminal UI, configuration system, and Provider / MCP / Skill / Plugin capabilities, and adds HarmonyOS-focused integrations for the Command Line Tools, Hvigor, HDC, Skills, the HarmonyOS knowledge base, ArkTS checking, and device debugging.

## Supported Platforms

| Platform | Architecture | Notes |
| --- | --- | --- |
| Linux | x64 | Official Command Line Tools (no IDE required) |

> For Windows and macOS, use the upstream repository: [https://atomgit.com/openharmony-sig/deveco-code](https://atomgit.com/openharmony-sig/deveco-code)

> The Linux build is distributed as a standalone project and is not part of the npm install matrix. It uses the official HarmonyOS Command Line Tools (CLT) for builds and device debugging, so no DevEco Studio installation is required. DevEco Code probes `~/command-line-tools` and `/opt/harmony-clt` automatically, and `DEVECO_CLI_CLT_PATH` can point at the CLT root. On Fedora/RHEL, a compatible `libbz2.so.1.0` symlink is created automatically when the Emulator needs it. The Linux build does not provide the Previewer and does not enable the OS-level command sandbox.

## Recommended Configuration

**Operating system**

- **Linux x64**: Fedora, Ubuntu, and other mainstream distributions

**Hardware**

- **Everyday use** (short sessions, single-module edits, chat and code editing): 8 GB RAM or more
- **Heavy use** (large projects, long sessions, frequent builds and emulator/device debugging): 16 GB RAM or more; reserve at least 20 GB free disk space for the SDK, emulators, and build caches

**Runtime and toolchain**

- [Node.js](https://nodejs.org) **22 or newer** (runs the bundled devecocli)
- [Bun](https://bun.sh) **1.4.2 or newer** (only needed to build from source)
- [HarmonyOS Command Line Tools](https://developer.huawei.com/consumer/cn/download/command-line-tools-for-hmos) **26.0.0 or newer** (manual install)

**Terminal shell**

- Zsh or Bash

**Network**

- Stable internet connection (Huawei account sign-in, model API calls, HarmonyOS knowledge search, etc.)

## Prerequisites

The Linux build requires:

1. A manual installation of the [HarmonyOS Command Line Tools](https://developer.huawei.com/consumer/cn/download/command-line-tools-for-hmos), **26.0.0 or newer recommended**
2. [Node.js](https://nodejs.org) **22 or newer**
3. [Bun](https://bun.sh) **1.4.2 or newer** when building from source

Extract the CLT to `~/command-line-tools` or `/opt/harmony-clt`; for other locations set `DEVECO_CLI_CLT_PATH`:

```bash
export DEVECO_CLI_CLT_PATH=/path/to/command-line-tools
```

Verify the environment:

```bash
node -v
"$DEVECO_CLI_CLT_PATH/sdk/default/openharmony/toolchains/hdc" -v
```

## Install & Update

### Install

1. Download `deveco-linux-x64-<date>.tar.gz` and `.sha256` from [Releases](https://github.com/WenYin-Community/deveco-code-linux/releases). If GitHub is slow to reach, download manually and copy the files to the target machine.
2. Verify and extract:

```bash
sha256sum -c deveco-linux-x64-<date>.tar.gz.sha256
tar -xzf deveco-linux-x64-<date>.tar.gz -C deveco-linux-x64
cd deveco-linux-x64
```

3. Install:

```bash
./install.sh
```

The installation lives in `~/.local/share/deveco`, with the command linked to `~/.local/bin/deveco`. If `~/.local/bin` is not on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

`install.sh` never downloads anything. It looks for the extracted `bin/` and `vendor/` in the script directory, the current directory, or `packages/opencode/dist/deveco-linux-x64`. You can also pass a directory or `.tar.gz` explicitly:

```bash
./install.sh /path/to/deveco-linux-x64
./install.sh /path/to/deveco-linux-x64-2026-11-15.tar.gz
```

Installing the same version is skipped; use `--force` to reinstall.

### Update

Download and extract the new version, then run from the new directory:

```bash
./update.sh
```

The update keeps only the current version; configuration and login state are preserved. The same version is skipped.

### Uninstall

```bash
./uninstall.sh
```

A copy of the uninstaller is kept at `~/.local/share/deveco/uninstall.sh`.

`--purge` also removes `~/.config/deveco` and `~/.local/state/deveco` (configuration and login credentials):

```bash
./uninstall.sh --purge
```

### Build from source (optional)

```bash
git clone https://github.com/WenYin-Community/deveco-code-linux.git
cd deveco-code-linux
bun install
cd packages/opencode
bun run script/build.ts --target=linux-x64 --skip-install
cd ../..
./install.sh
```

Building requires [Bun](https://bun.sh) **1.4.2 or newer**.

## Login & Logout

DevEco Code requires signing in with a Huawei account. The first time you run `deveco`, the terminal guides you through sign-in; you can also run:

```bash
deveco auth login
```

Logging out clears the local sign-in state for the current Huawei account; you will need to sign in again on the next launch:

```bash
deveco auth logout
```

## Model Configuration

After signing in, you can use the free model channels provided by DevEco Code.

Type `/models` in DevEco Code to open the model configuration UI. The `GLM-5.1` model is currently available for free, with a default limit of 50 requests per minute per account. Type `/connect` to open the Provider selection UI and configure supported third-party models.

The built-in free model channel is available automatically after signing in and requires no manual configuration. To connect another model service, configure a third-party Provider in `deveco.jsonc` (all fields below are placeholders — replace them with your provider's details):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    // Provider ID, any custom name; reference the model elsewhere as "<provider-id>/<model-id>"
    "myprovider": {
      // Optional, defaults to openai-compatible; only needed for providers that are not OpenAI-compatible
      "npm": "@ai-sdk/openai-compatible",
      // Display name, customizable
      "name": "My Provider",
      "models": {
        // Replace with the model ID provided by your provider
        "<your-model-id>": {
          "tool_call": true,
          "limit": {
            "context": 200000,
            "output": 8192
          }
        }
      },
      "options": {
        // Replace with your provider's API endpoint
        "baseURL": "https://<your-endpoint>/v1",
        // Replace with your API key
        "apiKey": "<your-api-key>"
      }
    }
  }
}
```

**UI Verification Configuration**

UI verification is an optional capability during the feature verification phase, used to verify whether the interface matches requirement descriptions.

This feature requires a multimodal model (used only for UI verification, not as the main chat model): when logged in, it defaults to using the built-in Qwen3.5 model; when not logged in, UI verification is skipped.

To configure a third-party multimodal model (Qwen series only), specify it in the `agent` section of `deveco.jsonc`. Example using qwen3-vl-plus:

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
      "model": "myprovider/qwen3-vl-plus", // Format: <provider-id>/<model-id>
      "hidden": true,
    },
  },
}
```

Configuration file lookup priority:

1. `.deveco/deveco.jsonc` in the project directory
2. `deveco.jsonc` in the project directory
3. `.config/deveco/deveco.jsonc` in the user home directory

## Agent Configuration

DevEco Code provides the following Agent modes for HarmonyOS development (press `Tab` to switch):

- `Build`: Default mode for project scaffolding, code generation, configuration fixes, test execution, deployment, and release
- `Plan`: Requirement breakdown, technical design, release planning, test planning, and documentation
- `Goal`: End-to-end feature delivery using the SDD five-phase flow from requirements through implementation and build verification

## HarmonyOS Capabilities

DevEco Code integrates common HarmonyOS development tools:

| Tool | Description |
| --- | --- |
| `build_project` | Build the project and export build artifacts |
| `start_app` | Run the application on an emulator or physical device |
| `hdc_log` | Collect/clear device logs; list connected emulators |
| `verify_ui` | Execute UI operations to verify features |
| `switch_cwd` | Switch the build project path |

Common scenarios include creating a HarmonyOS project from scratch, incremental page development, fixing build errors, and on-device debugging.

### UX Designs to ArkTS Code

The built-in `hmos-design-to-arkts` Skill turns Figma, Pixso or MasterGo UX designs into pages in an existing ArkTS project. Based on a bar-phone design it generates one set of ArkTS code with responsive layout and multi-device adaptation, running on bar phones, dual-fold, tri-fold, and wide-fold devices.

Configure the MCP server for your design source before use (restart DevEco Code afterwards):

| Source | Setup |
| --- | --- |
| Figma | [Anchor MCP](https://gitcode.com/OpenHarmonyToolkitsPlaza/anchor-d2c-mcp): set the `FIGMA_ACCESS_TOKEN` environment variable first, then run `deveco mcp add` with name `anchor-d2c-mcp`, type `Local`, command `npx -y anchor-d2c-mcp@latest stdio` |
| Pixso | [Pixso MCP](https://pixso.cn/developer/zh/mcp/remote-mcp.html): the remote form needs no client — run `deveco mcp add pixso-mcp --url https://pixso.cn/mcp`, then `deveco mcp auth pixso-mcp` to authorize; a [local MCP](https://pixso.cn/developer/zh/mcp/local-mcp.html) service also works |
| MasterGo | [Magic MCP](https://mastergo.com/help/ai-features/magic-mcp.html) (team plan + the `MG_MCP_TOKEN` environment variable) or [Vibe MCP](https://mastergo.com/help/ai-features/vibe-mcp.html) (desktop client with MCP enabled); if neither applies, use the [community plugin](https://github.com/burnice-cn/mastergo-mcp-server) (plugin channel, needs local pairing) |

Note: if the MCP setup is missing, the Skill provides the setup guidance and stops rather than starting with a missing dependency.

After starting DevEco Code in the target project directory, give the design link and a short description of the requirements; the Agent detects them and loads the `hmos-design-to-arkts` Skill to generate the page code (anything missing is clarified first):

```text
Convert this Figma design into an ArkTS page: https://www.figma.com/design/xxxx/OrderList?node-id=1-2 (order list board), tapping a list item opens the detail page
```

Two workflows are available: Fast generates the page right away; Full is recommended — it adds component-tree confirmation plus iterative visual calibration against the design (needs an emulator or device). `Goal` mode defaults to Full and `Build` mode defaults to Fast; either can also be requested explicitly. `Plan` is not supported.

## Extensions

DevEco Code is compatible with OpenCode's Skill, MCP, and Plugin extension mechanisms.

> After adding or changing Skill, MCP, or Plugin configuration, exit and run `deveco` again for changes to take effect.

### Skills

```bash
npx skills add vercel-labs/agent-skills
```

You can also place Skills in `~/.config/deveco/skills`.

### MCP

Configure MCP in `~/.config/deveco/deveco.jsonc`:

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

Then configure the plugin entry in `deveco.jsonc`:

```jsonc
{
  "plugin": [
    "node_modules/oh-my-opencode/dist/index.js"
  ]
}
```

## Migrating from OpenCode

To migrate from OpenCode to DevEco Code, move your configuration files to the DevEco Code directory:

```bash
cp {source_path}/opencode.jsonc ~/.config/deveco/deveco.jsonc
```

Skills, Agents, and Plugins can also be migrated to the corresponding directories under `~/.config/deveco`; MCP configuration entries can be moved into `deveco.jsonc`.

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a Pull Request.

## Help & Support

- For the full documentation, see the [DevEco Code User Guide](docs/deveco-code-docs.html) (download to open locally), or read the [OpenCode TUI documentation](https://opencode.ai/docs/tui/) online
- For frequently asked questions, see the [FAQ document](https://gitcode.com/openharmony-sig/deveco-code/wiki/FAQ.md)
- Feedback & Discussion [GitCode Issue](https://gitcode.com/openharmony-sig/deveco-code/issues)

## License

[MIT License](LICENSE)

## Built on OpenCode

This project extends the open-source project [OpenCode](https://opencode.ai). DevEco Code is **not** produced by the OpenCode team and is not affiliated with or associated with the OpenCode team in any way. For DevEco Code–related issues, please use [GitCode Issues](https://gitcode.com/openharmony-sig/deveco-code/issues) rather than contacting the OpenCode community.
