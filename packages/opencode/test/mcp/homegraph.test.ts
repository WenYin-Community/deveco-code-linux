import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homegraph-wiring-"))
const fakeEntry = path.join(tmpRoot, "dist", "bin", "homegraph.js")
fs.mkdirSync(path.dirname(fakeEntry), { recursive: true })
fs.writeFileSync(fakeEntry, "#!/usr/bin/env node\nconsole.log('fake')\n")

const completeVendorRoot = path.join(tmpRoot, "complete-vendor")
fs.mkdirSync(path.join(completeVendorRoot, "dist", "bin"), { recursive: true })
fs.mkdirSync(path.join(completeVendorRoot, "node_modules", "web-tree-sitter"), { recursive: true })
fs.writeFileSync(path.join(completeVendorRoot, "dist", "bin", "homegraph.js"), "ok\n")
fs.writeFileSync(path.join(completeVendorRoot, "node_modules", "web-tree-sitter", "package.json"), "{}\n")

const incompleteVendorRoot = path.join(tmpRoot, "incomplete-vendor")
fs.mkdirSync(path.join(incompleteVendorRoot, "dist", "bin"), { recursive: true })
fs.writeFileSync(path.join(incompleteVendorRoot, "dist", "bin", "homegraph.js"), "ok\n")

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

afterEach(async () => {
  delete process.env.HOMEGRAPH_AUTO_INIT
  delete process.env.HOMEGRAPH_WATCH_FIXED_WINDOW_MS
  const { resetHomegraphInjectState } = await import("../../src/mcp/homegraph")
  resetHomegraphInjectState()
})

describe("homegraph wiring", () => {
  test("resolveHomegraphEntry does not use HOMEGRAPH_ENTRY/HOMEGRAPH_HOME", async () => {
    process.env.HOMEGRAPH_ENTRY = fakeEntry
    process.env.HOMEGRAPH_HOME = tmpRoot
    const { resolveHomegraphEntry } = await import("../../src/mcp/homegraph")
    const resolved = resolveHomegraphEntry()
    // Env overrides are ignored — must not equal the fake env path unless npm/marker coincides.
    if (resolved) {
      expect(resolved).not.toBe(path.resolve(fakeEntry))
    }
    delete process.env.HOMEGRAPH_ENTRY
    delete process.env.HOMEGRAPH_HOME
  })

  test("completeVendorEntry requires entry + web-tree-sitter", async () => {
    const { completeVendorEntry } = await import("../../src/mcp/homegraph")
    expect(completeVendorEntry(completeVendorRoot)).toBe(
      path.resolve(completeVendorRoot, "dist", "bin", "homegraph.js"),
    )
    expect(completeVendorEntry(incompleteVendorRoot)).toBeUndefined()
  })

  test("resolveInstalledHomegraphEntry prefers marker over vendor", async () => {
    const { resolveInstalledHomegraphEntry } = await import("../../src/mcp/homegraph")
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hg-marker-prefer-"))
    const marked = path.join(installRoot, "marked-entry.js")
    fs.writeFileSync(marked, "ok\n")
    fs.mkdirSync(path.join(installRoot, "vendor"), { recursive: true })
    fs.writeFileSync(path.join(installRoot, "vendor", ".homegraph-entry"), `${marked}\n`)
    fs.cpSync(completeVendorRoot, path.join(installRoot, "vendor", "homegraph"), { recursive: true })
    expect(resolveInstalledHomegraphEntry(installRoot)).toBe(path.resolve(marked))
    fs.rmSync(installRoot, { recursive: true, force: true })
  })

  test("resolveInstalledHomegraphEntry falls back to vendor when marker path is missing", async () => {
    const { resolveInstalledHomegraphEntry } = await import("../../src/mcp/homegraph")
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hg-marker-miss-"))
    fs.mkdirSync(path.join(installRoot, "vendor"), { recursive: true })
    fs.writeFileSync(path.join(installRoot, "vendor", ".homegraph-entry"), `${path.join(installRoot, "missing.js")}\n`)
    fs.cpSync(completeVendorRoot, path.join(installRoot, "vendor", "homegraph"), { recursive: true })
    expect(resolveInstalledHomegraphEntry(installRoot)).toBe(
      path.resolve(installRoot, "vendor", "homegraph", "dist", "bin", "homegraph.js"),
    )
    fs.rmSync(installRoot, { recursive: true, force: true })
  })

  test("isHomegraphOptOut detects enabled:false", async () => {
    const { isHomegraphOptOut } = await import("../../src/mcp/homegraph")
    expect(isHomegraphOptOut({ enabled: false })).toBe(true)
    expect(isHomegraphOptOut({ enabled: true, type: "local", command: ["node"] })).toBe(false)
    expect(isHomegraphOptOut(undefined)).toBe(false)
  })

  test("withBuiltInHomegraph opt-out keeps typed disabled stub", async () => {
    const { withBuiltInHomegraph, getHomegraphInjectSource } = await import("../../src/mcp/homegraph")
    const result = await withBuiltInHomegraph({ homegraph: { enabled: false } })
    expect(result.injected).toBeUndefined()
    expect(result.source).toBeUndefined()
    expect(getHomegraphInjectSource()).toBeUndefined()
    expect(result.config.homegraph).toMatchObject({ type: "local", enabled: false })
  })

  test("withBuiltInHomegraph preserves user mcp.homegraph as source=user", async () => {
    const { withBuiltInHomegraph, getHomegraphInjectSource } = await import("../../src/mcp/homegraph")
    const user = { type: "local" as const, command: ["node", "/custom/homegraph.js", "serve", "mcp"], enabled: true }
    const warn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "))
    }
    try {
      const result = await withBuiltInHomegraph({ homegraph: user })
      expect(result.preservedUser).toBe(true)
      expect(result.source).toBe("user")
      expect(getHomegraphInjectSource()).toBe("user")
      expect(result.injected).toEqual(user)
      expect(warnings.some((w) => w.includes("Keeping user mcp.homegraph"))).toBe(true)
    } finally {
      console.warn = warn
    }
  })

  test("withBuiltInHomegraph injects product entry for fake vendor entry", async () => {
    const {
      withBuiltInHomegraph,
      setHomegraphEntryOverrideForTest,
      resolveHomegraphNodeBinary,
      probeNodeMajor,
      HOMEGRAPH_MIN_NODE_MAJOR,
      HOMEGRAPH_DISABLED_STUB_MARKER,
      isProductDisabledHomegraphStub,
      disabledHomegraphMcp,
    } = await import("../../src/mcp/homegraph")
    expect(HOMEGRAPH_MIN_NODE_MAJOR).toBe(22)
    const stub = disabledHomegraphMcp()
    expect(isProductDisabledHomegraphStub(stub)).toBe(true)
    expect(stub.command.some((c) => String(c).includes(HOMEGRAPH_DISABLED_STUB_MARKER))).toBe(true)

    const bin = await resolveHomegraphNodeBinary()
    const major = probeNodeMajor(bin)
    if (major === undefined || major < 22) {
      // CI without usable Node ≥22 — skip inject assertion
      return
    }
    setHomegraphEntryOverrideForTest(fakeEntry)
    const result = await withBuiltInHomegraph({})
    expect(result.source).toBe("product")
    expect(result.injected?.type).toBe("local")
    if (result.injected?.type === "local") {
      expect(result.injected.command[0]).toBe(bin)
      expect(result.injected.command).toContain(fakeEntry)
      expect(result.injected.command).toContain("--auto-init")
      expect(result.injected.timeout).toBeUndefined()
      expect(result.injected.enabled).toBe(true)
    }
  })

  test("builtInHomegraphMcp auto-inits with watch window and no mcp.timeout override", async () => {
    delete process.env.HOMEGRAPH_AUTO_INIT
    const { builtInHomegraphMcp } = await import("../../src/mcp/homegraph")
    const mcp = builtInHomegraphMcp(fakeEntry, "node")
    expect(mcp.command).toEqual(["node", fakeEntry, "serve", "mcp", "--path", ".", "--auto-init"])
    expect(mcp.environment?.HOMEGRAPH_AUTO_INIT).toBe("1")
    expect(mcp.environment?.HOMEGRAPH_WATCH_FIXED_WINDOW_MS).toBe("300000")
    expect(mcp.environment?.HOMEGRAPH_MCP_TOOLS).toBeUndefined()
    expect(mcp.timeout).toBeUndefined()
  })

  test("builtInHomegraphMcp opts out of auto-init when HOMEGRAPH_AUTO_INIT=0", async () => {
    process.env.HOMEGRAPH_AUTO_INIT = "0"
    const { builtInHomegraphMcp } = await import("../../src/mcp/homegraph")
    const mcp = builtInHomegraphMcp(fakeEntry, "/studio/node")
    expect(mcp.command).toEqual([
      "/studio/node",
      fakeEntry,
      "serve",
      "mcp",
      "--path",
      ".",
      "--no-watch",
    ])
  })

  test("applyBuiltInHomegraph registers disabled stub on opt-out", async () => {
    const { applyBuiltInHomegraph, HOMEGRAPH_MCP_NAME } = await import("../../src/mcp/homegraph")
    const registry: Record<string, { enabled?: boolean; type?: string }> = {}
    const config = await applyBuiltInHomegraph({ homegraph: { enabled: false } }, registry as never)
    expect(config.homegraph).toMatchObject({ enabled: false, type: "local" })
    expect(registry[HOMEGRAPH_MCP_NAME]).toMatchObject({ enabled: false, type: "local" })
  })

  test("slim prompt part only teaches explore + project", async () => {
    const hgPart = await Bun.file(
      new URL("../../src/agent/prompt-parts/codebase-understanding-homegraph.txt", import.meta.url),
    ).text()
    expect(hgPart).toContain("homegraph_explore")
    expect(hgPart).toContain("homegraph_project")
    expect(hgPart).toContain("Never commit or edit `.homegraph/`.")
    expect(hgPart).not.toContain("homegraph_callers")
    expect(hgPart).not.toContain("homegraph_node")
    expect(hgPart).not.toContain("violation")
  })
})

describe("homegraph ready", () => {
  // Cold-import of homegraph-ready pulls MCP.Service; allow >5s on slow CI hosts.
  test(
    "evaluateHomegraphReady covers disabled / missing / no-project / ready",
    async () => {
      const { evaluateHomegraphReady, READY_TOOL } = await import("../../src/mcp/homegraph-ready")
      expect(evaluateHomegraphReady(undefined, [], "product")).toEqual({ ready: false, source: "product" })
      expect(evaluateHomegraphReady({ status: "disabled" }, [READY_TOOL])).toEqual({ ready: false, source: undefined })
      expect(evaluateHomegraphReady({ status: "failed", error: "x" }, [READY_TOOL])).toEqual({
        ready: false,
        source: undefined,
      })
      expect(evaluateHomegraphReady({ status: "connected" }, ["homegraph_explore"])).toEqual({
        ready: false,
        source: undefined,
      })
      expect(evaluateHomegraphReady({ status: "connected" }, [READY_TOOL, "homegraph_explore"], "product")).toEqual({
        ready: true,
        source: "product",
      })
    },
    { timeout: 30_000 },
  )
})

describe("AgentPromptParts.forAgent", () => {
  test("injects HG part only for build/goal; user source softens auto-index claim", async () => {
    const { forAgent, agentNeedsHomegraphPrompt, CODEBASE_AGENTS } = await import("../../src/agent/prompt-parts")
    expect([...CODEBASE_AGENTS].sort()).toEqual(["ask", "build", "goal"])
    expect(agentNeedsHomegraphPrompt("debug")).toBe(false)

    const agent = (name: string) => ({ name }) as never
    const product = forAgent(agent("build"), { homegraphReady: true, homegraphSource: "product" })
    expect(product[0]).toContain("homegraph_explore")
    expect(product[0]).toContain("may lag a few minutes")

    const user = forAgent(agent("build"), { homegraphReady: true, homegraphSource: "user" })
    expect(user[0]).toContain("homegraph_explore")
    expect(user[0]).not.toContain("may lag a few minutes")
    expect(user[0]).toContain("may not auto-init")
    // Line-based: neighboring guidance sentences stay intact.
    expect(user[0]).toContain("Never commit or edit `.homegraph/`.")

    expect(forAgent(agent("build"), { homegraphReady: false })[0]).not.toContain("homegraph")
    expect(forAgent(agent("title"), { homegraphReady: true })).toEqual([])
  })
})
