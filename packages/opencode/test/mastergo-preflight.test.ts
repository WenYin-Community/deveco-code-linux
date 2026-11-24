import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  clientEndpoint,
  DEFAULT_ENDPOINT,
  probeMasterGoClient,
} from "../resources/skills/hmos-design-to-arkts/scripts/mastergo-preflight.mjs"
import { tmpdir } from "./fixture/fixture"

const script = fileURLToPath(
  new URL("../resources/skills/hmos-design-to-arkts/scripts/mastergo-preflight.mjs", import.meta.url),
)

async function listening() {
  const server = net.createServer((socket) => socket.destroy())
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address")
  return { server, endpoint: `http://127.0.0.1:${address.port}` }
}

async function close(server: net.Server) {
  await new Promise<void>((done) => server.close(() => done()))
}

async function run(args: string[], entry = script) {
  const child = Bun.spawn([process.execPath, entry, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe("probeMasterGoClient", () => {
  test("reports a running client service as available", async () => {
    const running = await listening()
    try {
      expect(await probeMasterGoClient(running.endpoint)).toEqual({ status: "available", endpoint: running.endpoint })
    } finally {
      await close(running.server)
    }
  })

  test("reports a refused connection as unavailable", async () => {
    const closed = await listening()
    await close(closed.server)
    expect(await probeMasterGoClient(closed.endpoint)).toEqual({
      status: "unavailable",
      endpoint: closed.endpoint,
      reason: expect.any(String),
    })
  })

  test("rejects an address without an http scheme", () => {
    expect(() => probeMasterGoClient("127.0.0.1:30678")).toThrow("http://")
    expect(() => probeMasterGoClient("localhost:30678")).toThrow("http://")
  })

  test("rejects an address without an explicit port", () => {
    expect(() => probeMasterGoClient("http://localhost")).toThrow("explicit port")
    expect(() => probeMasterGoClient("http://127.0.0.1")).toThrow("explicit port")
  })
})

describe("clientEndpoint", () => {
  test("uses a loopback address with an explicit port declared by a local connection", () => {
    expect(
      clientEndpoint({
        server: "mastergo-vibe",
        type: "local",
        command: ["node", "vibe.js", "--url=http://localhost:30679"],
      }),
    ).toBe("http://localhost:30679")
    expect(
      clientEndpoint({
        server: "mastergo-vibe",
        type: "local",
        command: ["node", "vibe.js", "--url", "http://localhost:30680"],
      }),
    ).toBe("http://localhost:30680")
  })

  test("falls back to the default address for cloud, portless, malformed, remote and stdio connections", () => {
    expect(
      clientEndpoint({
        server: "mastergo-magic",
        type: "local",
        command: ["node", "magic.js", "--url=https://mastergo.com"],
      }),
    ).toBe(DEFAULT_ENDPOINT)
    expect(
      clientEndpoint({
        server: "mastergo-vibe",
        type: "local",
        command: ["node", "vibe.js", "--url=http://localhost"],
      }),
    ).toBe(DEFAULT_ENDPOINT)
    expect(
      clientEndpoint({
        server: "mastergo-vibe",
        type: "local",
        command: ["node", "vibe.js", "--url=127.0.0.1:30678"],
      }),
    ).toBe(DEFAULT_ENDPOINT)
    expect(clientEndpoint({ server: "mastergo-magic", type: "local", command: ["node", "magic.js"] })).toBe(
      DEFAULT_ENDPOINT,
    )
    expect(clientEndpoint({ server: "mastergo-community", type: "remote", url: "http://127.0.0.1:3000/mcp" })).toBe(
      DEFAULT_ENDPOINT,
    )
    expect(clientEndpoint(undefined)).toBe(DEFAULT_ENDPOINT)
  })
})

describe("mastergo-preflight command", () => {
  test("probes the loopback address a connection file declares and prints one JSON line", async () => {
    await using tmp = await tmpdir()
    const running = await listening()
    const connection = path.join(tmp.path, "connection.json")
    await Bun.write(
      connection,
      JSON.stringify({
        server: "mastergo-vibe",
        type: "local",
        command: ["node", "vibe.js", `--url=${running.endpoint}`],
        enabled: true,
      }),
    )
    try {
      const result = await run(["--connection", connection])
      expect(result.exitCode).toBe(0)
      const lines = result.stdout.trim().split("\n")
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toEqual({ status: "available", endpoint: running.endpoint })
    } finally {
      await close(running.server)
    }
  })

  test("reports a disabled connection as unavailable without leaving the status query contract", async () => {
    await using tmp = await tmpdir()
    const connection = path.join(tmp.path, "connection.json")
    await Bun.write(
      connection,
      JSON.stringify({
        server: "mastergo-vibe",
        type: "local",
        command: ["node", "vibe.js", "--url=http://127.0.0.1:30679"],
        enabled: false,
      }),
    )
    const result = await run(["--connection", connection])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual({
      status: "unavailable",
      endpoint: "http://127.0.0.1:30679",
      reason: "disabled",
    })
  })

  test("queries the default endpoint when no argument is given", async () => {
    const result = await run([])
    expect(result.exitCode).toBe(0)
    const lines = result.stdout.trim().split("\n")
    expect(lines).toHaveLength(1)
    const status = JSON.parse(lines[0])
    expect(Object.keys(status).every((key) => ["endpoint", "reason", "status"].includes(key))).toBe(true)
    expect(status.endpoint).toBe(DEFAULT_ENDPOINT)
    expect(["available", "unavailable"]).toContain(status.status)
  })

  test("exits non-zero for argument errors", async () => {
    const unknown = await run(["--client", "http://127.0.0.1:30678"])
    expect(unknown.exitCode).toBe(1)
    expect(unknown.stdout).toBe("")
    expect(unknown.stderr).toContain("Usage:")

    const noScheme = await run(["--endpoint", "127.0.0.1:30678"])
    expect(noScheme.exitCode).toBe(1)
    expect(noScheme.stdout).toBe("")
    expect(noScheme.stderr).toContain("http://")
  })

  test("exits non-zero when --endpoint omits the port", async () => {
    const result = await run(["--endpoint", "http://localhost"])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("explicit port")
  })

  test.skipIf(process.platform === "win32")("runs through a symlinked script path", async () => {
    await using tmp = await tmpdir()
    const linked = path.join(tmp.path, "mastergo-preflight.mjs")
    await fs.symlink(script, linked)
    const running = await listening()
    try {
      const result = await run(["--endpoint", running.endpoint], linked)
      expect(result.exitCode).toBe(0)
      const lines = result.stdout.trim().split("\n")
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toEqual({ status: "available", endpoint: running.endpoint })
    } finally {
      await close(running.server)
    }
  })
})
