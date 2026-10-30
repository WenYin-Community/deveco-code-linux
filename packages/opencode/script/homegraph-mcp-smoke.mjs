#!/usr/bin/env node
/**
 * One-shot MCP tools/list smoke against a vendored homegraph entry.
 * Usage: node script/homegraph-mcp-smoke.mjs <homegraph.js> <projectDir>
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const entry = process.argv[2]
const project = process.argv[3]
if (!entry || !project) {
  console.error("usage: homegraph-mcp-smoke.mjs <homegraph.js> <projectDir>")
  process.exit(2)
}
if (!fs.existsSync(entry)) {
  console.error(`missing entry: ${entry}`)
  process.exit(1)
}
fs.mkdirSync(project, { recursive: true })
fs.writeFileSync(path.join(project, "smoke.ts"), "export const ok = 1\n")

const child = spawn(
  "node",
  [entry, "serve", "mcp", "--path", project],
  {
    env: {
      ...process.env,
      HOMEGRAPH_WASM_RELAUNCHED: "1",
      HOMEGRAPH_AUTO_INIT: "0",
      HOMEGRAPH_WATCH_FIXED_WINDOW_MS: "1000",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  },
)

let buf = ""
let id = 0
const pending = new Map()
const send = (method, params) => {
  id += 1
  pending.set(id, method)
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
}
const done = (code) => {
  try {
    child.kill()
  } catch {
    // ignore
  }
  process.exit(code)
}

setTimeout(() => {
  console.error("homegraph smoke TIMEOUT")
  done(2)
}, 30000)

child.stdout.on("data", (d) => {
  buf += d.toString("utf8")
  for (;;) {
    const i = buf.indexOf("\n")
    if (i < 0) break
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id == null || !pending.has(msg.id)) continue
    const method = pending.get(msg.id)
    pending.delete(msg.id)
    if (method === "initialize") {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      send("tools/list", {})
      continue
    }
    if (method === "tools/list") {
      const names = (msg.result?.tools || []).map((t) => t.name)
      const ok = names.includes("homegraph_explore") && names.includes("homegraph_project")
      console.log("homegraph smoke tools", names.join(","))
      done(ok ? 0 : 1)
    }
  }
})

child.on("error", (err) => {
  console.error(err)
  done(1)
})

send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "hg-smoke", version: "0" },
})
