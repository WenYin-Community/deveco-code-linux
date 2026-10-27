/** @jsxImportSource @opentui/solid */
// NFR-ACC-001 — HDC 审批界面可访问性（Inspection + Demonstration）
// 三条验收子项，每项都有对应的代码断言：
//   1. 键盘可操作：Prompt 注册 left/h/right/l（选项切换）、return（确认）、
//      escape（拒绝），本测试用真实按键模拟（demonstration）验证。
//   2. 屏幕阅读器可读：命令、目标对象、目标设备、风险信息、选项全部以 text 节点渲染，
//      不是图形/纯色块；本测试断言渲染帧中文本完整可见。
//   3. 风险不只依赖颜色：风险描述是独立文案（permission.hdc_risk_*），
//      与 △ 警告字形、黄色边框叠加，去掉颜色后信息仍完整。
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { I18nProvider, changeLanguage } from "../../../src/i18n"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncContext, useSync } from "../../../src/context/sync"
import { ProjectProvider } from "../../../src/context/project"
import { PathFormatterProvider } from "../../../src/context/path-format"
import { PermissionPrompt } from "../../../src/routes/session/permission"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"

interface Reply {
  reply: string
  requestID: string
}

async function mount(request: PermissionRequest, language = "en") {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ language }))
  const replies: Reply[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const pathname = new URL(request.url).pathname
    if (request.method === "POST" && pathname.startsWith("/permission/") && pathname.endsWith("/reply")) {
      const body = (await request.json().catch(() => ({}))) as { reply?: string }
      const requestID = pathname.slice("/permission/".length, -"/reply".length)
      replies.push({ reply: body.reply ?? "", requestID })
    }
    return Response.json({})
  }) as typeof fetch
  const sync = {
    data: { session: [], part: {} },
  } as unknown as ReturnType<typeof useSync>

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <I18nProvider>
                <ThemeProvider mode="dark">
                  <SDKProvider url="http://127.0.0.1:9" fetch={fetcher} events={{ subscribe: async () => () => {} }}>
                    <ProjectProvider>
                      <SyncContext.Provider value={sync}>
                        <PathFormatterProvider path="/workspace">
                          <PermissionPrompt request={request} directory="/workspace" />
                        </PathFormatterProvider>
                      </SyncContext.Provider>
                    </ProjectProvider>
                  </SDKProvider>
                </ThemeProvider>
              </I18nProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const setup = await testRender(() => <Harness />, { width: 100, height: 36, kittyKeyboard: true })
  return {
    setup,
    replies,
    async frame(text: string, timeout = 2000) {
      for (let i = 0; i < timeout / 10; i++) {
        await Bun.sleep(10)
        await setup.renderOnce()
        const frame = setup.captureCharFrame()
        if (frame.includes(text)) return frame
      }
      throw new Error(setup.captureCharFrame())
    },
    async waitForReplies(count: number, timeout = 2000) {
      const start = Date.now()
      while (replies.length < count) {
        if (Date.now() - start > timeout) throw new Error(`expected ${count} replies, got ${replies.length}`)
        await Bun.sleep(10)
      }
    },
    async close() {
      setup.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

function hdcRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "req-hdc-1",
    sessionID: "session-1",
    // Namespaced guard action (mapToPermissionAction), not a plain "hdc".
    permission: "hdc:install",
    patterns: ["device:127.0.0.1:5555/package:app.hap"],
    metadata: {
      operationType: "install",
      targetAppOrPath: "app.hap",
      targetDevice: "127.0.0.1:5555",
      risk: "Install or start an app; modifies device app state",
      reason: "Install app package onto device",
      command: "hdc install app.hap",
      productDefault: "ask",
      productCeiling: "allow",
    },
    // canAlwaysAllow=true → non-empty always list (ceiling=allow operations).
    always: ["device:127.0.0.1:5555/package:app.hap"],
    ...overrides,
  }
}

test("hdc prompt renders command, target, device, and risk as text (screen-reader readable, not color-only)", async () => {
  const ui = await mount(hdcRequest())
  try {
    const frame = await ui.frame("Run HDC device command")
    // 操作类型、命令原文、目标对象、目标设备、风险文案全部是文本节点 —— 屏幕阅读器可读。
    expect(frame).toContain("$ hdc install app.hap")
    expect(frame).toContain("Target: app.hap")
    expect(frame).toContain("Device: 127.0.0.1:5555")
    // 风险由独立文案表达（operationType=install → permission.hdc_risk_install），
    // 不只依赖颜色；△ 字形叠加。
    expect(frame).toContain("Installs this app package onto the device")
    expect(frame).toContain("△")
    // 上限为 allow 的操作提供 Always allow（FR-APPROVAL-101）。
    expect(frame).toContain("Allow once")
    expect(frame).toContain("Allow always")
    expect(frame).toContain("Reject")
  } finally {
    await ui.close()
  }
})

test("hdc prompt conveys each risk class as its own text line", async () => {
  const ui = await mount(
    hdcRequest({
      permission: "hdc:file:send",
      patterns: ["device:127.0.0.1:5555/path:/data/local/tmp/x.txt"],
      metadata: {
        operationType: "file send",
        targetAppOrPath: "hello.txt → /data/local/tmp/x.txt",
        targetDevice: "127.0.0.1:5555",
        risk: "File transfer; modifies device or local files",
        reason: "Send file to device",
        command: "hdc file send hello.txt /data/local/tmp/x.txt",
        productDefault: "ask",
        productCeiling: "allow",
      },
      always: ["device:127.0.0.1:5555/path:/data/local/tmp/x.txt"],
    }),
  )
  try {
    const frame = await ui.frame("Writes the local file to a path on the device")
    expect(frame).toContain("$ hdc file send hello.txt /data/local/tmp/x.txt")
    expect(frame).toContain("Target: hello.txt → /data/local/tmp/x.txt")
  } finally {
    await ui.close()
  }
})

test("hdc prompt hides Always allow for ask-ceiling operations (canAlwaysAllow=false)", async () => {
  const ui = await mount(
    hdcRequest({
      permission: "hdc:uninstall",
      patterns: ["device:127.0.0.1:5555/bundle:com.example.app"],
      metadata: {
        operationType: "uninstall",
        targetAppOrPath: "com.example.app",
        targetDevice: "127.0.0.1:5555",
        risk: "App lifecycle operation; modifies device app state",
        reason: "Uninstall device app",
        command: "hdc uninstall com.example.app",
        productDefault: "ask",
        productCeiling: "ask",
      },
      always: [],
    }),
  )
  try {
    const frame = await ui.frame("Run HDC device command")
    expect(frame).toContain("$ hdc uninstall com.example.app")
    expect(frame).toContain("Allow once")
    expect(frame).toContain("Reject")
    // 上限为 ask 的操作不提供 Always allow（test-guide §1.10 / TC-27）。
    expect(frame).not.toContain("Allow always")
  } finally {
    await ui.close()
  }
})

test("hdc prompt is fully keyboard-operable: enter confirms once, arrows move, escape rejects", async () => {
  const ui = await mount(hdcRequest({ always: [] }))
  try {
    await ui.frame("Allow once")
    // 默认选中 Allow once，直接回车 = once。
    ui.setup.mockInput.pressEnter()
    await ui.waitForReplies(1)
    expect(ui.replies[0]).toEqual({ reply: "once", requestID: "req-hdc-1" })

    // 右箭头切到 Reject，回车 = reject。
    ui.setup.mockInput.pressArrow("right")
    ui.setup.mockInput.pressEnter()
    await ui.waitForReplies(2)
    expect(ui.replies[1]).toEqual({ reply: "reject", requestID: "req-hdc-1" })

    // Esc = 拒绝（escapeKey="reject"）。
    ui.setup.mockInput.pressEscape()
    await ui.waitForReplies(3)
    expect(ui.replies[2]).toEqual({ reply: "reject", requestID: "req-hdc-1" })

    // 左箭头回到 Allow once（循环导航）。
    ui.setup.mockInput.pressArrow("left")
    ui.setup.mockInput.pressEnter()
    await ui.waitForReplies(4)
    expect(ui.replies[3]).toEqual({ reply: "once", requestID: "req-hdc-1" })
  } finally {
    await ui.close()
  }
})

test("hdc prompt risk stays textual in the zh locale", async () => {
  const ui = await mount(hdcRequest(), "zh")
  try {
    const frame = await ui.frame("运行 HDC 设备命令")
    expect(frame).toContain("$ hdc install app.hap")
    expect(frame).toContain("目标对象：app.hap")
    expect(frame).toContain("目标设备：127.0.0.1:5555")
    expect(frame).toContain("将应用安装包安装到设备")
    expect(frame).toContain("△")
  } finally {
    await ui.close()
    await changeLanguage("en")
  }
})
