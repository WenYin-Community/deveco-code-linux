import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { withLanhuClient } from "./lanhu-connection.mjs"
import { execute, resolveRunDir, parseReference } from "./lanhu-source.mjs"
import { runtimeDependency, isMain } from "./lanhu-runtime.mjs"
import { runCommand } from "./lanhu-setup.mjs"
import { safeManagedPath } from "./lanhu-private.mjs"

const READ_TOOLS = new Set([
  "lanhu_get_designs",
  "lanhu_get_design_overview",
  "lanhu_inspect_design_region",
  "lanhu_export_design_assets",
])

export async function prepareLanhuCapture(input, directory) {
  if (
    !input ||
    typeof input.server !== "string" ||
    !input.server.trim() ||
    !["tools", "designs", "overview", "inspect", "export", "install"].includes(input.operation)
  )
    throw new Error("Choose a Lanhu server and tools/designs/overview/inspect/export/install operation")
  if (input.operation === "tools") {
    return undefined
  }
  if (typeof input.runDir !== "string" || !input.runDir || input.runDir.includes("\0"))
    throw new Error("Choose a Lanhu run directory")
  const runDir = await resolveRunDir(directory, input.runDir)
  const state = JSON.parse((await fs.readFile(path.join(runDir, "workflow-state.json"), "utf8")).replace(/^\uFEFF/, ""))
  if (
    state.designSource !== "lanhu" ||
    state.status !== "running" ||
    state.currentStage !== (["export", "install"].includes(input.operation) ? 2 : 1)
  )
    throw new Error("Read Lanhu design inputs in stage 1; export or install selected resources in running stage 2")
  if (["designs", "overview"].includes(input.operation)) {
    if (input.operation === "overview") parseReference(input.url, input.designId)
    const url = new URL(input.url)
    if (
      url.protocol !== "https:" ||
      !["lanhuapp.com", "www.lanhuapp.com"].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw new Error("Use an https://lanhuapp.com design URL")
  }
  for (const name of ["snapshotId", "bundleId", "designId", "versionId", "python"]) {
    if (
      input[name] !== undefined &&
      (typeof input[name] !== "string" || !input[name].trim() || /[\r\n\0]/.test(input[name]))
    )
      throw new Error(`Invalid Lanhu ${name}`)
  }
  if (["inspect", "export", "install"].includes(input.operation) && !/^[a-f0-9]{32}$/.test(input.snapshotId ?? ""))
    throw new Error("Choose the locked Lanhu snapshot ID")
  if (
    input.operation === "install" &&
    (!/^[a-f0-9]{32}$/.test(input.bundleId ?? "") || typeof input.python !== "string" || !path.isAbsolute(input.python))
  )
    throw new Error("Choose the exported bundle and trusted installer Python path")
  if (
    input.operation === "inspect" &&
    ((input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0)) ||
      (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 60)))
  )
    throw new Error("Use a nonnegative offset and a limit from 1 to 60")
  if (
    input.operation === "export" &&
    (!Array.isArray(input.assetIds) ||
      input.assetIds.some((id) => typeof id !== "string" || !id.trim()) ||
      ![undefined, "original", "prefer_svg", "raster"].includes(input.formatPreference))
  )
    throw new Error("Select asset IDs and an original/prefer_svg/raster format")
  if (
    input.nodeIds !== undefined &&
    (!Array.isArray(input.nodeIds) ||
      !input.nodeIds.length ||
      input.nodeIds.length > 200 ||
      input.nodeIds.some((id) => typeof id !== "string" || !id.trim()))
  )
    throw new Error("Use up to 200 node IDs for a detail query")
  await safeManagedPath(path.join(runDir, "source", "lanhu"))
  return runDir
}

export async function captureLanhu(client, input, directory, runtime, signal) {
  const runDir = await prepareLanhuCapture(input, directory)
  if (input.operation === "tools") {
    const tools = await availableTools(client, signal)
    if ([...READ_TOOLS].some((name) => !tools.some((tool) => tool.name === name)))
      throw new Error("The selected Lanhu MCP lacks the pinned design-reading tools")
    return { status: "available", server: input.server, tools }
  }
  const lock = path.join(runDir, ".lanhu-capture-lock")
  await fs.mkdir(lock).catch(() => {
    throw new Error("Another Lanhu capture is using this run; inspect the existing command before retrying")
  })
  const source = path.join(runDir, "source", "lanhu")
  const transport = {
    call: async (name, args) => {
      if (!READ_TOOLS.has(name)) throw new Error("Only the audited Lanhu design-reading tools are supported")
      const request = { server: input.server, tool: name, arguments: args }
      const id = hash(JSON.stringify(request)).slice(0, 32)
      await saveRaw(source, `${id}-request.json`, request)
      const response = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 })
      await saveRaw(source, `${id}-response-${hash(JSON.stringify(response)).slice(0, 16)}.json`, response)
      return response
    },
    read: (uri) => client.readResource({ uri }, { signal, timeout: 120_000 }),
    decodeImage: async (bytes) => {
      const { PNG } = await runtimeDependency(runtime, "pngjs")
      PNG.sync.read(bytes, { checkCRC: true })
    },
    install: async (python, bundle, destination) => {
      const parent = path.dirname(destination)
      await fs.mkdir(parent, { recursive: true, mode: 0o700 })
      await runCommand(python, ["-I", "-m", "lanhu_design.install", "--bundle", bundle, "--output", destination], {
        cwd: runDir,
        signal,
        timeout: 90_000,
        label: "Lanhu resource installation",
      })
    },
  }
  try {
    signal?.throwIfAborted()
    if (input.operation === "designs") {
      const result = await transport.call("lanhu_get_designs", { url: input.url })
      if (result.isError === true) throw new Error("Lanhu project listing failed; check file access and authentication")
      return { status: "captured", server: input.server, rawDirectory: path.join(source, "raw") }
    }
    const result = await execute(input, directory, transport)
    signal?.throwIfAborted()
    return result
  } finally {
    await fs.rmdir(lock)
  }
}

async function availableTools(client, signal) {
  const tools = []
  const cursors = new Set()
  let cursor
  for (let index = 0; index < 1000; index++) {
    const result = await client.listTools(cursor === undefined ? {} : { cursor }, { signal, timeout: 30_000 })
    tools.push(...result.tools.filter((tool) => READ_TOOLS.has(tool.name)))
    if (result.nextCursor === undefined) return tools
    if (cursors.has(result.nextCursor)) throw new Error("Lanhu tools pagination returned a repeated cursor")
    cursors.add(result.nextCursor)
    cursor = result.nextCursor
  }
  throw new Error("Lanhu tools pagination exceeded 1000 pages")
}

async function saveRaw(root, name, value) {
  const bytes = JSON.stringify(value, null, 2) + "\n"
  if (Buffer.byteLength(bytes) > 10 * 1024 * 1024)
    throw new Error("Lanhu JSON response exceeds 10 MiB; narrow the request")
  const directory = path.join(root, "raw")
  // execute() applies the same source-path checks before other evidence writes.
  for (const current of [root, directory]) {
    const info = await fs.lstat(current).catch((error) => {
      if (error.code !== "ENOENT") throw error
    })
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error("Lanhu raw evidence paths must be directories without symlinks")
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, name)
  const temporary = path.join(directory, `.lanhu-${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
    await fs.link(temporary, file).catch(async (error) => {
      if (error.code !== "EEXIST") throw error
      const info = await fs.lstat(file)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== Buffer.byteLength(bytes) ||
        (await fs.readFile(file, "utf8")) !== bytes
      )
        throw new Error("Lanhu raw evidence changed; start a new run")
    })
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex")
}

async function main() {
  const flags = process.argv.slice(2)
  if (flags.length !== 6 || flags[0] !== "--config" || flags[2] !== "--connection" || flags[4] !== "--runtime")
    throw new Error(
      "Usage: node lanhu-capture.mjs --config <capture.json> --connection <connection.json> --runtime <node-runtime>",
    )
  const input = JSON.parse((await fs.readFile(path.resolve(flags[1]), "utf8")).replace(/^\uFEFF/, ""))
  await prepareLanhuCapture(input, process.cwd())
  const connection = JSON.parse((await fs.readFile(path.resolve(flags[3]), "utf8")).replace(/^\uFEFF/, ""))
  if (!input.server || connection.server !== input.server)
    throw new Error("Choose the same server in capture and connection configuration")
  const abort = new AbortController()
  const stop = () => abort.abort()
  // The overall deadline must cover the chained per-request budgets: overview and
  // export follow a 120s tool call with a 120s resource read plus the 30s connect.
  const deadline = setTimeout(
    stop,
    ["overview", "export", "install"].includes(input.operation) ? 300_000 : 180_000,
  )
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    const result = await withLanhuClient(connection, flags[5], input.server, process.cwd(), abort.signal, (client) =>
      captureLanhu(client, input, process.cwd(), flags[5], abort.signal),
    )
    process.stdout.write(JSON.stringify(result) + "\n")
  } finally {
    clearTimeout(deadline)
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
  }
}

if (isMain(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`lanhu-capture: ${error.message}\n`)
    process.exitCode = 1
  }
}
