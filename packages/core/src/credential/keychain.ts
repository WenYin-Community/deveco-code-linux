import { spawn } from "child_process"
import { createHash, randomBytes } from "crypto"
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs"
import path from "path"
import { Effect } from "effect"
import { Flag } from "../flag/flag"
import type { Key } from "./crypto"

const KEY_LENGTH = 32
const SERVICE = "deveco-credential"
const TIMEOUT_MS = 10_000

// Runs a keychain CLI, resolving undefined on any failure (missing binary,
// absent item, timeout) so callers can fall back to the on-disk key file.
function run(command: string, args: string[], input?: string) {
  return Effect.promise(
    () =>
      new Promise<string | undefined>((resolve) => {
        const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
        const timer = setTimeout(() => {
          child.kill()
          resolve(undefined)
        }, TIMEOUT_MS)
        let out = ""
        child.stdout.on("data", (chunk) => (out += chunk))
        child.on("error", () => {
          clearTimeout(timer)
          resolve(undefined)
        })
        child.on("close", (code) => {
          clearTimeout(timer)
          resolve(code === 0 ? out.trim() : undefined)
        })
        if (input !== undefined) child.stdin.write(input)
        child.stdin.end()
      }),
  )
}

function decode(text: string | undefined): Key | undefined {
  if (!text) return
  const key = Buffer.from(text.trim(), "base64")
  return key.length === KEY_LENGTH ? new Uint8Array(key) : undefined
}

function writePlain(file: string, key: Key) {
  writeFileSync(file, Buffer.from(key).toString("base64"), { mode: 0o600 })
  // umask may have stripped the creation mode, enforce it explicitly
  chmodSync(file, 0o600)
}

// A corrupt key can never decrypt existing rows, so fail loudly instead of
// regenerating and silently orphaning stored credentials.
const loadPlain = Effect.fn("CredentialKeychain.loadPlain")(function* (file: string) {
  if (existsSync(file)) {
    const key = decode(readFileSync(file, "utf8"))
    if (!key) throw new Error(`Invalid credential key in ${file}`)
    return key
  }
  const key = randomBytes(KEY_LENGTH)
  writePlain(file, key)
  return key as Key
})

// Windows: DPAPI (CurrentUser scope) protects the key blob inside the same
// .key file, so its content is only unprotectable by this Windows user.
const DPAPI_PROTECT =
  "Add-Type -AssemblyName System.Security; " +
  "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
  "[Console]::Out.Write([Convert]::ToBase64String(" +
  "[System.Security.Cryptography.ProtectedData]::Protect($b,$null," +
  "[System.Security.Cryptography.DataProtectionScope]::CurrentUser)))"
const DPAPI_UNPROTECT =
  "Add-Type -AssemblyName System.Security; " +
  "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
  "[Console]::Out.Write([Convert]::ToBase64String(" +
  "[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null," +
  "[System.Security.Cryptography.DataProtectionScope]::CurrentUser)))"

function dpapi(script: string, input: string) {
  return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], input)
}

const loadDpapi = Effect.fn("CredentialKeychain.loadDpapi")(function* (file: string) {
  const protect = (key: Key) => dpapi(DPAPI_PROTECT, Buffer.from(key).toString("base64"))
  if (!existsSync(file)) {
    const key = randomBytes(KEY_LENGTH)
    const blob = yield* protect(key)
    if (blob) {
      writeFileSync(file, blob, { mode: 0o600 })
      chmodSync(file, 0o600)
    } else writePlain(file, key)
    return key as Key
  }
  const content = readFileSync(file, "utf8").trim()
  const unprotected = decode(yield* dpapi(DPAPI_UNPROTECT, content))
  if (unprotected) return unprotected
  // Legacy plaintext key file: migrate under DPAPI protection.
  const legacy = decode(content)
  if (!legacy) throw new Error(`Invalid credential key in ${file}`)
  const blob = yield* protect(legacy)
  if (blob) writeFileSync(file, blob, { mode: 0o600 })
  return legacy
})

// macOS `security` CLI / Linux `secret-tool` (libsecret). The account name is
// derived from the database path so channels and test databases never share
// a keychain item.
interface Provider {
  readonly read: (account: string) => Effect.Effect<string | undefined>
  readonly write: (account: string, base64: string) => Effect.Effect<boolean>
}

const securityCli: Provider = {
  read: (account) => run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"]),
  write: (account, base64) =>
    Effect.map(
      run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", base64]),
      (out) => out !== undefined,
    ),
}

const secretTool: Provider = {
  read: (account) => run("secret-tool", ["lookup", "service", SERVICE, "account", account]),
  write: (account, base64) =>
    Effect.map(
      run("secret-tool", ["store", "--label=DevEco Credential Key", "service", SERVICE, "account", account], base64),
      (out) => out !== undefined,
    ),
}

const loadWithProvider = Effect.fn("CredentialKeychain.loadWithProvider")(function* (
  file: string,
  account: string,
  provider: Provider,
) {
  const stored = decode(yield* provider.read(account))
  if (stored) return stored
  if (existsSync(file)) {
    // Legacy plaintext key file: migrate into the keychain, keep it as
    // fallback when the keychain write fails.
    const legacy = decode(readFileSync(file, "utf8"))
    if (!legacy) throw new Error(`Invalid credential key in ${file}`)
    if (yield* provider.write(account, Buffer.from(legacy).toString("base64"))) rmSync(file)
    return legacy
  }
  const key = randomBytes(KEY_LENGTH)
  if (!(yield* provider.write(account, Buffer.from(key).toString("base64")))) writePlain(file, key)
  return key as Key
})

// The data key is guarded by the OS keychain where available: a DPAPI-
// protected key file on Windows, the login keychain on macOS, libsecret on
// Linux. Without a usable keychain the raw key file (0o600) next to the
// database remains the fallback. This defends against backups, sync folders,
// SQL dumps and log captures leaking secrets; the OS user account remains
// the boundary against same-user processes.
export const loadKey = Effect.fn("CredentialKeychain.loadKey")(function* (filename: string) {
  if (filename === ":memory:") return randomBytes(KEY_LENGTH) as Key
  const file = filename + ".key"
  if (!Flag.DEVECO_DISABLE_CREDENTIAL_KEYCHAIN) {
    if (process.platform === "win32") return yield* loadDpapi(file)
    const provider =
      process.platform === "darwin" ? securityCli : process.platform === "linux" ? secretTool : undefined
    if (provider) {
      const account =
        path.basename(filename) + "-" + createHash("sha256").update(filename).digest("hex").slice(0, 12)
      return yield* loadWithProvider(file, account, provider)
    }
  }
  return yield* loadPlain(file)
})
