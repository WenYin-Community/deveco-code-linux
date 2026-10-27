import { runDevecoCliProxy } from "./router"

// devecocli shim 的专用重入入口（见 tool/lib/deveco-cli.ts 的 resolveDevecoCodeProxyLauncher）。
// shim 以 `<executable> run --conditions=browser <本文件> __devecocli-proxy -- <用户命令...>` 的形式
// 重入，本文件只做一件事：把参数交给代理，由它写出 CLI 事件并转发给真正的内置 CLI。
//
// 为什么不复用 src/index.ts：`bun run` 用 $cwd/tsconfig.json 解析 JSX，而 index.ts 会拉入 TUI 的
// .tsx 组件，只有在 packages/opencode 目录下才加载得动；而 shim 的调用方 cwd 是用户的工程目录
// （devecocli create 成功后还会自动切过去）。本文件不依赖任何 .tsx，因此从任意 cwd 都能运行。
const args = process.argv.slice(2)

// hdc shim 的重入入口（见 hdc/shim-env.ts 写出的 hdc shim 与 index.ts 的 __hdc-shim 路由）。
// 与 __devecocli-proxy 同理：hdc/shim.ts 不依赖任何 .tsx，从任意 cwd 都能运行，
// 而 src/index.ts 只有在 packages/opencode 目录下才加载得动。
if (args[0] === "__hdc-shim") {
  const hdcArgs = args[1] === "--" ? args.slice(2) : args.slice(1)
  const { runHdcShim } = await import("../hdc/shim")
  process.exit(await runHdcShim(hdcArgs))
}

const proxyArgs = args[0] === "__devecocli-proxy" && args[1] === "--" ? args.slice(2) : args
process.exit(await runDevecoCliProxy(proxyArgs, process.cwd()))
