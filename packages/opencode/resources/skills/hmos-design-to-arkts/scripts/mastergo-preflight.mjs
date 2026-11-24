import { readFileSync, realpathSync } from "node:fs"
import { connect } from "node:net"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

// The desktop client may move its local service when the default port is taken.
export const DEFAULT_ENDPOINT = "http://127.0.0.1:30678"

// Only the local service port proves the client is running: the Vibe adapter answers
// tools/list and get_version on its own, so an MCP session succeeds with the client
// closed. Real design reads stay in stage 1, where the target document is known.
export function probeMasterGoClient(endpoint = DEFAULT_ENDPOINT, timeout = 2_000) {
  // An explicit port is required: a scheme-default port (80/443) would probe some other
  // local service and can report a false available.
  const url = /^https?:\/\//i.test(endpoint) ? new URL(endpoint) : undefined
  if (!url?.port)
    throw new Error("Use an http:// client service address with an explicit port, such as http://127.0.0.1:30678")
  const port = Number(url.port)
  return new Promise((done) => {
    let settled = false
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port, timeout })
    const finish = (result) => {
      if (settled) return
      settled = true
      socket.destroy()
      done(result)
    }
    socket.once("connect", () => finish({ status: "available", endpoint }))
    socket.once("timeout", () => finish({ status: "unavailable", endpoint, reason: "timeout" }))
    socket.once("error", (error) => finish({ status: "unavailable", endpoint, reason: error.code ?? "error" }))
  })
}

// A remote service (community bridge, private deployment) is not a client signal, and a
// local stdio server may point at the cloud (Magic). Only a loopback --url with an explicit
// port identifies the desktop client's own service; everything else falls back to the
// default address, so a portless or unparsable loopback URL is not probed on port 80.
export function clientEndpoint(connection) {
  if (!connection) return DEFAULT_ENDPOINT
  if (connection.type !== "local") return DEFAULT_ENDPOINT
  const command = Array.isArray(connection.command) ? connection.command : []
  const flag = command.findIndex((part) => part === "--url" || part.startsWith("--url="))
  if (flag < 0) return DEFAULT_ENDPOINT
  const value = command[flag].startsWith("--url=") ? command[flag].slice("--url=".length) : command[flag + 1]
  if (!value) return DEFAULT_ENDPOINT
  // A malformed --url is a configuration default, not a usage error.
  try {
    const url = new URL(value)
    if (!url.port || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return DEFAULT_ENDPOINT
    return url.origin
  } catch {
    return DEFAULT_ENDPOINT
  }
}

async function main() {
  const flags = process.argv.slice(2)
  if (
    flags.length % 2 ||
    flags.some((flag, index) => index % 2 === 0 && !["--connection", "--endpoint"].includes(flag))
  )
    throw new Error(
      "Usage: node mastergo-preflight.mjs [--connection <connection.json> | --endpoint <client-service-url>]",
    )
  const args = Object.fromEntries(
    Array.from({ length: flags.length / 2 }, (_, index) => [flags[index * 2], flags[index * 2 + 1]]),
  )
  if (args["--connection"] && args["--endpoint"]) throw new Error("Choose --connection or --endpoint, not both")
  const connection = args["--connection"]
    ? JSON.parse(readFileSync(resolve(args["--connection"]), "utf8").replace(/^\uFEFF/, ""))
    : undefined
  const endpoint = args["--endpoint"] ?? clientEndpoint(connection)
  // A disabled connection is a status result, not a usage error: the caller still gets one
  // JSON line and exit code 0.
  const result =
    connection?.enabled === false
      ? { status: "unavailable", endpoint, reason: "disabled" }
      : await probeMasterGoClient(endpoint)
  process.stdout.write(JSON.stringify(result) + "\n")
}

// Compare real paths so invoking the script through a file or directory symlink still runs it.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`mastergo-preflight: ${error.message}\n`)
    process.exitCode = 1
  })
}
