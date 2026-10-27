export * as HdcHostEnforcement from "./host-enforcement"

import { findDevEcoHome, findDevEcoHomes, hdcPath } from "@/tool/lib/env"
import type { AccessMode, ResolvedProfile } from "@opencode-ai/core/config/sandbox"
import { toNativePrepareRequest, fromNativePreparedCommand } from "@opencode-ai/core/sandbox"
import type { PreparedCommand, SandboxPrepareRequest } from "@bitfun-ai/sandbox"

// ─── macOS host anti-bypass (FR-HOST-101 / AR-HDC-SEC1-007) ─
// Discovers the real hdc binaries and injects into every macOS
// sandboxed profile:
//   1. filesystem `deny` on each real hdc absolute path — blocks
//      direct read and in-tree copies (a copy needs a read);
//   2. `process.deny_exec` on the same paths — blocks direct
//      exec of the original even if a pre-protection copy or
//      hardlink exists elsewhere;
//   3. filesystem `write` on the guard UDS socket path — the
//      minimal trusted-path allowance (AR-SEC1-007 §2). The
//      guard itself spawns the real hdc OUTSIDE the sandbox.
//
// Before any protected command starts, four canaries verify the
// protection (AR-SEC1-007 §3): direct_read_deny, direct_exec_deny,
// shim_allow, trusted_exec. Any canary failure fails closed — the
// command must not start and must not degrade by dropping
// protection. Passed canary sets are cached per policy; failures
// are negatively cached for a short window so transient breakage
// self-heals while every command still fails closed.
//
// Boundaries (hdc_guard_sr2.md §1.3, fr-host-101-gap.md):
//   - macOS only; Windows does not claim host enforcement;
//   - full-access profiles skip the sandbox entirely (user
//     opt-out) and are not host-enforced;
//   - copies made BEFORE protection (outside the controlled
//     tree) are out of scope (SR2 §1.3.4);
//   - a ruleset that forces interactive approval on the
//     trusted-exec probe operation will fail that canary.

// ─── Protected binary discovery (I2) ────────────────────────

const DISCOVERY_TTL_MS = 60_000
let discoveryCache: { at: number; bins: string[] } | undefined

export async function hdcBinariesFromHomes(homes: readonly string[]): Promise<string[]> {
  const bins: string[] = []
  for (const home of homes) {
    const bin = hdcPath(home)
    if (await Bun.file(bin).exists()) bins.push(bin)
  }
  return bins
}

export async function protectedHdcBinaries(): Promise<string[]> {
  if (discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) return discoveryCache.bins
  const homes = new Set<string>()
  const primary = await findDevEcoHome()
  if (primary) homes.add(primary)
  for (const home of await findDevEcoHomes()) homes.add(home)
  const bins = await hdcBinariesFromHomes([...homes])
  discoveryCache = { at: Date.now(), bins }
  return bins
}

// ─── Profile injection (I1/I3/I6) ───────────────────────────

export function injectHostEnforcement(
  profile: ResolvedProfile,
  bins: readonly string[],
  guardEndpoint: string | undefined,
): ResolvedProfile {
  const filesystem: Record<string, AccessMode> = { ...profile.filesystem }
  for (const bin of bins) filesystem[bin] = "deny"
  if (guardEndpoint) filesystem[guardEndpoint] = "write"
  const denyExec = [...new Set([...(profile.process?.deny_exec ?? []), ...bins])]
  return { ...profile, filesystem, process: { deny_exec: denyExec } }
}

// ─── Canaries (AR-HDC-SEC1-007 §3) ──────────────────────────

export type CanaryName = "direct_read_deny" | "direct_exec_deny" | "shim_allow" | "trusted_exec"
export type CanaryStatus = "passed" | "failed" | "skipped"

export interface CanaryResult {
  name: CanaryName
  status: CanaryStatus
  detail: string
  durationMs: number
}

export interface CanaryRun {
  results: CanaryResult[]
  cached: boolean
}

export class HostEnforcementCanaryError extends Error {
  readonly results: CanaryResult[]

  constructor(results: CanaryResult[], cached: boolean) {
    const failed = results.filter((result) => result.status === "failed")
    super(
      `hdc host-enforcement canary${cached ? " (cached failure)" : ""} failed (fail closed): ` +
        failed.map((result) => `${result.name} (${result.detail})`).join("; "),
    )
    this.name = "HostEnforcementCanaryError"
    this.results = results
  }
}

export interface CanaryDeps {
  // Prepares a probe command under the SAME injected profile via
  // the native runtime (sandbox-exec wrapped).
  prepare: (request: SandboxPrepareRequest) => Promise<PreparedCommand>
  // Spawns a prepared probe and captures its outcome. Defaults to
  // Bun.spawn with a hard timeout.
  spawn?: (prepared: PreparedCommandLike, timeoutMs: number) => Promise<ProbeOutcome>
}

export interface PreparedCommandLike {
  executable: string
  args: readonly string[]
  cwd: string
  env: Record<string, string>
}

export interface CanaryOptions {
  profile: ResolvedProfile
  bins: readonly string[]
  env: Record<string, string>
  cwd: string
  armed: boolean
  // Short negative cache for failed canary sets (fail closed but
  // avoid re-running a broken set on every command).
  failureTtlMs?: number
}

export interface ProbeOutcome {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const PROBE_TIMEOUT_MS = 20_000
const TRUSTED_EXEC_TIMEOUT_MS = 30_000
const FAILURE_TTL_MS = 10_000
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024

// Airtight read probe: head either reads one byte or it does not.
const READ_DENY_SCRIPT = 'if head -c 1 "$1" >/dev/null 2>&1; then echo CANARY_READ_LEAKED; else echo CANARY_READ_DENIED; fi'
// Exec probe: a denied exec surfaces as EPERM/ENOENT → the shell
// reports 126/127. Any other code means the binary executed.
const EXEC_DENY_SCRIPT = '"$1" >/dev/null 2>&1; ec=$?; if [ "$ec" -eq 126 ] || [ "$ec" -eq 127 ]; then echo CANARY_EXEC_DENIED; else echo CANARY_EXEC_RAN_$ec; fi'
const SHIM_ALLOW_SCRIPT = 'if command -v hdc >/dev/null 2>&1; then echo CANARY_SHIM_PRESENT; else echo CANARY_SHIM_MISSING; fi'
// device_readonly op, productDefault allow — non-interactive under
// the default ruleset.
const TRUSTED_EXEC_SCRIPT = "hdc list targets"

const passCache = new Set<string>()
const failCache = new Map<string, { expiry: number; results: CanaryResult[] }>()

function canaryCacheKey(options: CanaryOptions): string {
  return JSON.stringify([
    options.profile.profile_id,
    options.profile.filesystem,
    options.profile.network_enabled,
    options.profile.workspace_roots,
    options.profile.process ?? null,
    [...options.bins].sort(),
    options.armed,
  ])
}

async function spawnProbe(
  prepared: PreparedCommandLike,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const proc = Bun.spawn([prepared.executable, ...prepared.args], {
    cwd: prepared.cwd,
    env: prepared.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)

  const collect = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return ""
    let bytes = 0
    let text = ""
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes <= MAX_PROBE_OUTPUT_BYTES) text += Buffer.from(value).toString("utf8")
    }
    return text
  }

  try {
    const [stdout, stderr] = await Promise.all([collect(proc.stdout), collect(proc.stderr)])
    const code = await proc.exited
    return { code: timedOut ? null : code, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

async function runProbe(
  options: CanaryOptions,
  deps: CanaryDeps,
  script: string,
  scriptArg: string | undefined,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const args = scriptArg === undefined ? ["-c", script] : ["-c", script, "canary", scriptArg]
  const request = toNativePrepareRequest(options.profile, {
    executable: "/bin/sh",
    args,
    cwd: options.cwd,
    env: options.env,
  })
  const prepared = fromNativePreparedCommand(await deps.prepare(request))
  const spawn = deps.spawn ?? spawnProbe
  return spawn(prepared, timeoutMs)
}

async function runCanaries(options: CanaryOptions, deps: CanaryDeps): Promise<CanaryResult[]> {
  const results: CanaryResult[] = []
  const push = (name: CanaryName, status: CanaryStatus, detail: string, startedAt: number) => {
    results.push({ name, status, detail, durationMs: Date.now() - startedAt })
  }

  for (const bin of options.bins) {
    const startedAt = Date.now()
    const outcome = await runProbe(options, deps, READ_DENY_SCRIPT, bin, PROBE_TIMEOUT_MS)
    const leaked = outcome.stdout.includes("CANARY_READ_LEAKED")
    const denied = outcome.stdout.includes("CANARY_READ_DENIED")
    push(
      "direct_read_deny",
      !leaked && denied && !outcome.timedOut ? "passed" : "failed",
      leaked
        ? `read of ${bin} succeeded inside the sandbox`
        : outcome.timedOut
          ? `read probe of ${bin} timed out`
          : denied
            ? `read of ${bin} denied`
            : `read probe of ${bin} produced no verdict (exit ${outcome.code})`,
      startedAt,
    )
  }

  for (const bin of options.bins) {
    const startedAt = Date.now()
    const outcome = await runProbe(options, deps, EXEC_DENY_SCRIPT, bin, PROBE_TIMEOUT_MS)
    const denied = outcome.stdout.includes("CANARY_EXEC_DENIED")
    const ran = outcome.stdout.includes("CANARY_EXEC_RAN_")
    push(
      "direct_exec_deny",
      denied && !ran && !outcome.timedOut ? "passed" : "failed",
      ran
        ? `exec of ${bin} ran inside the sandbox (${outcome.stdout.trim()})`
        : outcome.timedOut
          ? `exec probe of ${bin} timed out`
          : denied
            ? `exec of ${bin} denied`
            : `exec probe of ${bin} produced no verdict (exit ${outcome.code}, stderr: ${outcome.stderr.trim().slice(0, 200)})`,
      startedAt,
    )
  }

  if (!options.armed) {
    // No guard env in this shell (CON-05): the shim/UDS chain is
    // not armed, so its canaries have nothing to verify. The deny
    // canaries above still guard the profile.
    push("shim_allow", "skipped", "guard env not armed", 0)
    push("trusted_exec", "skipped", "guard env not armed", 0)
    return results
  }

  {
    const startedAt = Date.now()
    const outcome = await runProbe(options, deps, SHIM_ALLOW_SCRIPT, undefined, PROBE_TIMEOUT_MS)
    const present = outcome.stdout.includes("CANARY_SHIM_PRESENT")
    push(
      "shim_allow",
      present && !outcome.timedOut ? "passed" : "failed",
      outcome.timedOut ? "shim probe timed out" : present ? "hdc shim resolvable on PATH" : `hdc shim not resolvable on PATH (exit ${outcome.code})`,
      startedAt,
    )
  }

  if (!options.profile.network_enabled) {
    // Network-off profiles deny network-outbound, which on macOS also
    // covers unix-socket connects: the guard UDS is unreachable from
    // inside such a sandbox until the sandbox contract gains a
    // unix-socket allowance. The deny canaries above still enforce the
    // anti-bypass core, and in-sandbox shim calls stay fail-closed via
    // guard_unavailable.
    push("trusted_exec", "skipped", "guard UDS unreachable under network-off profile (unix-socket allowance pending upstream sandbox support)", 0)
    return results
  }

  {
    const startedAt = Date.now()
    const outcome = await runProbe(options, deps, TRUSTED_EXEC_SCRIPT, undefined, TRUSTED_EXEC_TIMEOUT_MS)
    const guardResponded = outcome.stderr.includes("[hdc-guard] reason_code=") && !outcome.stderr.includes("reason_code=guard_unavailable")
    const approved = outcome.code === 0 && !outcome.timedOut
    push(
      "trusted_exec",
      approved || guardResponded ? "passed" : "failed",
      outcome.timedOut
        ? "trusted exec probe timed out (guard unreachable or approval pending)"
        : approved
          ? "hdc list targets completed via guard"
          : guardResponded
            ? "guard responded (policy denial; trusted pipe verified)"
            : `guard did not respond to hdc list targets (exit ${outcome.code}, stderr: ${outcome.stderr.trim().slice(0, 200)})`,
      startedAt,
    )
  }

  return results
}

export async function runHostEnforcementCanaries(options: CanaryOptions, deps: CanaryDeps): Promise<CanaryRun> {
  const key = canaryCacheKey(options)
  if (passCache.has(key)) return { results: [], cached: true }

  const cachedFailure = failCache.get(key)
  if (cachedFailure && Date.now() < cachedFailure.expiry) {
    throw new HostEnforcementCanaryError(cachedFailure.results, true)
  }

  const results = await runCanaries(options, deps)
  if (results.some((result) => result.status === "failed")) {
    const ttl = options.failureTtlMs ?? FAILURE_TTL_MS
    failCache.set(key, { expiry: Date.now() + ttl, results })
    throw new HostEnforcementCanaryError(results, false)
  }

  failCache.delete(key)
  passCache.add(key)
  if (passCache.size > 200) passCache.delete(passCache.keys().next().value as string)
  return { results, cached: false }
}

// Test/ops helper: clear discovery and canary caches.
export function resetHostEnforcementCaches(): void {
  discoveryCache = undefined
  passCache.clear()
  failCache.clear()
}
