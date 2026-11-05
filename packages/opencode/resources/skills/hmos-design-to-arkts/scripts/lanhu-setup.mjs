import fs from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { RUNTIME, runtimeDependency, isMain } from "./lanhu-runtime.mjs"
import { safeManagedPath, protectPrivatePath } from "./lanhu-private.mjs"

export const COMMIT = "6ded5bd906992b0acdd504ce9358e0608a750de1"
const ARCHIVE = {
  url: `https://codeload.github.com/dsphper/lanhu-mcp/zip/${COMMIT}`,
  sha256: "61a834a3821b5c1176e79dbacfd22c407a5151488e44cc00c95f1583140948c0",
}
const PATCH = JSON.parse(await fs.readFile(new URL("./lanhu-mastergo.patch.json", import.meta.url), "utf8"))

export function paths(root) {
  const config = path.resolve(
    root ??
      path.join(
        process.platform === "win32"
          ? process.env.APPDATA || path.join(homedir(), "AppData", "Roaming")
          : process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
        "deveco",
        "lanhu",
      ),
  )
  const managed = path.join(config, "runtime", `${COMMIT}-${PATCH.id}`)
  return {
    config,
    root: managed,
    source: path.join(managed, "source"),
    python: path.join(managed, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
    receipt: path.join(managed, "installation.json"),
    credential: path.join(config, "credentials.env"),
    profile: path.join(config, "browser-profile"),
    connection: path.join(config, "connection.json"),
    data: path.join(config, "data"),
  }
}

export async function ready(target) {
  await safeManagedPath(target.receipt)
  const receipt = await fs
    .readFile(target.receipt, "utf8")
    .then(JSON.parse)
    .catch(() => undefined)
  if (receipt?.commit !== COMMIT || receipt?.patch !== PATCH.id) return false
  if (!(await interpreterReady(target.python))) return false
  return fs
    .readFile(path.join(target.source, PATCH.file))
    .then((source) => sha256(source) === PATCH.patchedSha256)
    .catch(() => false)
}

// uv links venv/bin/python to its managed interpreter, so only that one file may be a
// symlink: the venv directory and the interpreter's real location stay locked down.
export async function interpreterReady(python) {
  const target = path.resolve(python)
  try {
    await safeManagedPath(path.dirname(target))
    const info = await fs.lstat(target).catch((error) => {
      if (error.code !== "ENOENT") throw error
    })
    if (!info) return false
    if (!info.isFile() && !info.isSymbolicLink()) return false
    const real = info.isSymbolicLink() ? await fs.realpath(target) : target
    if (!(await fs.stat(real)).isFile()) return false
    if (info.isSymbolicLink() && !(await interpreterAllowed(real))) return false
    return fs
      .access(real, fs.constants.X_OK)
      .then(() => true)
      .catch(() => false)
  } catch {
    // ready() gates status, login and reinstall; a rejected interpreter has to read as
    // missing so install can repair it, instead of aborting every command with a throw.
    return false
  }
}

async function interpreterAllowed(real) {
  // Resolve the allowlist root as well: a symlinked XDG_DATA_HOME or
  // UV_PYTHON_INSTALL_DIR still has to match the resolved interpreter path.
  const root = await fs.realpath(uvPythonRoot())
  const relative = path.relative(root, real)
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return false
  await safeManagedPath(real)
  if (process.platform === "win32") return true
  const info = await fs.lstat(root)
  return info.uid === process.getuid() && (info.mode & 0o022) === 0
}

function uvPythonRoot() {
  if (process.env.UV_PYTHON_INSTALL_DIR) return path.resolve(process.env.UV_PYTHON_INSTALL_DIR)
  if (process.platform === "win32")
    return path.resolve(process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"), "uv", "data", "python")
  return path.resolve(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "uv", "python")
}

export function patch(source) {
  if (sha256(Buffer.from(source)) === PATCH.patchedSha256) return source
  if (sha256(Buffer.from(source)) !== PATCH.originalSha256) throw new Error("Lanhu patch source hash mismatch")
  const updated = PATCH.changes.reduce(
    (value, change) =>
      change.all ? value.replaceAll(change.before, change.after) : value.replace(change.before, change.after),
    source,
  )
  if (sha256(Buffer.from(updated)) !== PATCH.patchedSha256) throw new Error("Lanhu patch integrity failed")
  return updated
}

export async function install(target, runtime, signal) {
  await protectPrivatePath(target.config, true)
  await protectPrivatePath(target.root, true)
  // A failed or interrupted installer leaves no receipt; reuse only a verified installation.
  if (await ready(target)) return
  const platform = RUNTIME.platforms[`${process.platform}-${process.arch}`]
  if (!platform) throw new Error("Unsupported Lanhu runtime platform")
  const { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } = await runtimeDependency(runtime, "@zip.js/zip.js")
  async function entries(archive) {
    const reader = new ZipReader(new Uint8ArrayReader(Uint8Array.from(archive)), { useWebWorkers: false })
    try {
      const result = await reader.getEntries()
      if (result.length > 1000 || result.reduce((size, entry) => size + entry.uncompressedSize, 0) > 180 * 1024 * 1024)
        throw new Error("Lanhu archive exceeds extraction limits")
      return result
    } finally {
      await reader.close()
    }
  }
  const uv = path.join(target.root, process.platform === "win32" ? "uv.exe" : "uv")
  const wheel = await entries(await download(platform.url, platform.sha256, signal))
  const executable = wheel.find(
    (entry) =>
      entry.filename === `uv-${RUNTIME.uvVersion}.data/scripts/${process.platform === "win32" ? "uv.exe" : "uv"}`,
  )
  if (!executable || !executable.getData) throw new Error("Invalid uv archive")
  await safeManagedPath(uv)
  await fs.writeFile(uv, await executable.getData(new Uint8ArrayWriter()), { mode: 0o700 })
  await fs.chmod(uv, 0o700)
  await protectPrivatePath(target.source, true)
  for (const entry of await entries(await download(ARCHIVE.url, ARCHIVE.sha256, signal))) {
    const name = entry.filename.split("/").slice(1).join("/")
    if (!name || entry.directory) continue
    const output = path.resolve(target.source, name)
    const rel = path.relative(target.source, output)
    if (
      rel === ".." ||
      rel.startsWith(".." + path.sep) ||
      path.isAbsolute(name) ||
      name.includes("\\") ||
      !entry.getData ||
      entry.uncompressedSize > 10 * 1024 * 1024 ||
      ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
    )
      throw new Error("Unsafe Lanhu source archive entry")
    await safeManagedPath(output)
    await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
    await fs.writeFile(output, await entry.getData(new Uint8ArrayWriter()), { mode: 0o600 })
  }
  const file = path.join(target.source, PATCH.file)
  await fs.writeFile(file, patch(await fs.readFile(file, "utf8")))
  await runCommand(
    uv,
    [
      "venv",
      "--allow-existing",
      "--python",
      RUNTIME.pythonVersion,
      "--managed-python",
      path.dirname(path.dirname(target.python)),
    ],
    {
      cwd: target.root,
      signal,
      timeout: 600_000,
      label: "Python installation",
      // Pin the same interpreter root that ready() accepts.
      env: { ...process.env, UV_PYTHON_INSTALL_DIR: uvPythonRoot() },
    },
  )
  await runCommand(
    uv,
    ["pip", "install", "--python", target.python, "--editable", target.source, "fastmcp==3.4.8", "playwright==1.64.0"],
    { cwd: target.root, signal, timeout: 600_000, label: "Lanhu dependencies" },
  )
  await runCommand(target.python, ["-m", "playwright", "install", "chromium"], {
    cwd: target.root,
    signal,
    timeout: 1_800_000,
    label: "Chromium installation",
  })
  await runCommand(
    target.python,
    [
      "-I",
      "-c",
      "from lanhu_design.normalize import normalize_design; import playwright, fastmcp; assert normalize_design({'meta':{'host':{'name':'master'}},'artboard':{'x':0,'y':0,'width':1,'height':1}})['source_type'] == 'mastergo'",
    ],
    { cwd: target.root, signal, timeout: 30_000, label: "Lanhu runtime validation" },
  )
  await protectPrivatePath(target.data, true)
  await safeManagedPath(target.credential)
  const credential = await fs.open(target.credential, "a", 0o600)
  await credential.close()
  await protectPrivatePath(target.credential)
  await writePrivateJson(target.connection, configuration(target))
  await writePrivateJson(target.receipt, {
    schemaVersion: 1,
    commit: COMMIT,
    patch: PATCH.id,
    sourceSha256: PATCH.patchedSha256,
    installedAt: new Date().toISOString(),
  })
}

export function configuration(target) {
  return {
    server: "lanhu",
    type: "local",
    command: [target.python, "-m", "lanhu_mcp_server", "--transport", "stdio"],
    environment: { LANHU_ENV_FILE: target.credential, LANHU_USER_ROLE: "Developer", DATA_DIR: target.data },
    enabled: true,
  }
}

export async function runCommand(command, args, options = {}) {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const chunks = []
    let size = 0
    let stopped
    let killTimer
    const stop = (reason) => {
      if (stopped) return
      stopped = reason
      child.kill()
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000)
    }
    const abort = () => stop(`${options.label ?? "Lanhu command"} cancelled`)
    const deadline = setTimeout(() => stop(`${options.label ?? "Lanhu command"} timed out`), options.timeout ?? 30_000)
    options.signal?.addEventListener("abort", abort, { once: true })
    child.stdout.on("data", (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        stop("Lanhu command output exceeded the limit")
        return
      }
      chunks.push(chunk)
    })
    // Dependency and server diagnostics can include credentials; never forward them.
    child.stderr.resume()
    child.once("error", () => stop(`${options.label ?? "Lanhu command"} could not start`))
    child.once("close", (code) => {
      clearTimeout(deadline)
      clearTimeout(killTimer)
      options.signal?.removeEventListener("abort", abort)
      if (stopped) {
        reject(new Error(stopped))
        return
      }
      resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") })
    })
  }).then((result) => {
    if (result.code !== 0 && options.requireSuccess !== false)
      throw new Error(`${options.label ?? "Lanhu command"} failed; check network access and runtime installation`)
    return result
  })
}

async function download(url, expected, signal) {
  const response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(120_000), signal].filter(Boolean)) })
  if (!response.ok || !response.body) throw new Error("Lanhu dependency download failed")
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > 64 * 1024 * 1024) throw new Error("Lanhu dependency download exceeds the limit")
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const bytes = Buffer.concat(chunks)
  if (sha256(bytes) !== expected) throw new Error("Lanhu dependency download hash mismatch")
  return bytes
}

async function writePrivateJson(file, value) {
  await safeManagedPath(file)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    await fs.rename(temporary, file)
    await protectPrivatePath(file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

async function main() {
  const flags = process.argv.slice(2)
  const args = Object.fromEntries(
    Array.from({ length: flags.length / 2 }, (_, index) => [flags[index * 2], flags[index * 2 + 1]]),
  )
  if (
    flags.length % 2 ||
    !["status", "install", "login"].includes(args["--action"]) ||
    flags.some((flag, index) => index % 2 === 0 && !["--action", "--runtime", "--root"].includes(flag))
  )
    throw new Error(
      "Usage: node lanhu-setup.mjs --action status|install|login [--runtime <node-runtime>] [--root <private-root>]",
    )
  const target = paths(args["--root"])
  const abort = new AbortController()
  const stop = () => abort.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    if (args["--action"] === "install") {
      if (!args["--runtime"]) throw new Error("Choose the independent Node runtime directory")
      const lock = path.join(target.config, ".setup-lock")
      await protectPrivatePath(target.config, true)
      await fs.mkdir(lock).catch(() => {
        throw new Error("Lanhu setup is already running; inspect the existing command before retrying")
      })
      try {
        await install(target, args["--runtime"], abort.signal)
      } finally {
        await fs.rmdir(lock)
      }
      process.stdout.write(
        JSON.stringify({ status: "installed", python: target.python, connection: target.connection }) + "\n",
      )
      return
    }
    if (!(await ready(target))) {
      process.stdout.write(JSON.stringify({ status: "setup_required", nextAction: "install" }) + "\n")
      return
    }
    await protectPrivatePath(target.config, true)
    if (args["--action"] === "login") await protectPrivatePath(target.profile, true)
    await protectPrivatePath(target.credential)
    const script = new URL("./lanhu_login.py", import.meta.url)
    const { fileURLToPath } = await import("node:url")
    const command = [
      fileURLToPath(script),
      "--env-file",
      target.credential,
      "--profile-dir",
      target.profile,
      ...(args["--action"] === "status" ? ["--check"] : ["--timeout", "600"]),
    ]
    const result = await runCommand(target.python, command, {
      cwd: target.root,
      signal: abort.signal,
      timeout: args["--action"] === "status" ? 25_000 : 660_000,
      requireSuccess: false,
      label: "Lanhu authentication",
    })
    const status = JSON.parse(result.stdout.trim().split("\n").at(-1) || "{}")
    process.stdout.write(JSON.stringify({ ...status, python: target.python, connection: target.connection }) + "\n")
    if (result.code !== 0) process.exitCode = 1
  } finally {
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
  }
}

if (isMain(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`lanhu-setup: ${error.message}\n`)
    process.exitCode = 1
  }
}
