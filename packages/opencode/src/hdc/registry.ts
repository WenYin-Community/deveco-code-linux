export * as HdcRegistry from "./registry"

import { MIN_HDC_VERSION, isSupportedVersion } from "@opencode-ai/core/hdc"
import type { SupportedHdcVersion } from "@opencode-ai/core/hdc"
import { HdcDenial } from "./reason"
import { findDevEcoHome, hdcPath } from "@/tool/lib/env"

// ─── HDC registry (SEC1 AR-006) ──────────────────────────────
// Discovers the real hdc binary, parses its version from `hdc
// version` output (`Ver: x.y.z`), and verifies it meets the
// SR1 §1.4 minimum (>= 3.2.0c, not a frozen allow-list). Produces
// the TrustedHdcDescriptor that fills `HdcGuardRequest.hdcVersion` —
// a value the registry itself verified, never a shim-declared one.
//
// Platform identity verification (AR-006 §2): on Windows the binary
// must carry an Authenticode signature whose signer CN matches the
// trusted publisher; on macOS a codesign Team ID must match. Any
// other platform (linux CI) skips signature verification — there is
// no platform-native executable signing mechanism there. A failure
// in verification fails closed: no descriptor, no HDC.

export interface TrustedHdcDescriptor {
  readonly path: string
  readonly version: SupportedHdcVersion
}

// Trusted signer CN for Windows Authenticode (verified against the
// shipping hdc.exe: CN="Huawei Technologies Co., Ltd."). macOS Team
// ID is a product constant; pin it here once confirmed. An empty
// constant still requires a TeamIdentifier to be present, but does
// not reject an unrecognized one — set the value to enforce strict
// fail-closed matching.
const WINDOWS_TRUSTED_SIGNER_CN = "Huawei Technologies Co., Ltd."
const MACOS_TRUSTED_TEAM_ID = ""

// The DevEco home does not change during a process lifetime; cache
// the descriptor keyed by home so the version probe runs once.
const descriptorCache = new Map<string, TrustedHdcDescriptor>()

export function invalidateRegistryCache(): void {
  descriptorCache.clear()
}

async function parseHdcVersion(bin: string): Promise<string | undefined> {
  const proc = Bun.spawn([bin, "version"], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) return undefined
  const match = `${stdout}\n${stderr}`.match(/Ver:\s*([0-9]+\.[0-9]+\.[0-9]+[a-z]?)/i)
  return match?.[1] ?? undefined
}

// ─── Platform identity verification ──────────────────────────
// Windows: PowerShell Get-AuthenticodeSignature; the signer subject
// must contain the trusted CN. macOS: `codesign -dv`; TeamIdentifier
// must match the product constant. Anything unexpected → undefined
// (fail closed).

async function verifyWindowsSignature(bin: string): Promise<boolean> {
  const escaped = bin.replace(/'/g, "''")
  const command = `$s = Get-AuthenticodeSignature -LiteralPath '${escaped}'; $s.SignerCertificate.Subject`
  // Prefer PowerShell 7 (pwsh): its Microsoft.PowerShell.Security
  // module autoloads cleanly, unlike Windows PowerShell 5.1 where
  // autoload can fail in a non-interactive context. Fall back to
  // powershell 5.1 only if pwsh is absent.
  for (const exe of ["pwsh", "powershell"]) {
    let ps
    try {
      ps = Bun.spawn([exe, "-NoProfile", "-NonInteractive", "-Command", command], { stdout: "pipe", stderr: "pipe" })
    } catch {
      // Executable not found in PATH — try the next fallback
      continue
    }
    const [code, stdout] = await Promise.all([ps.exited, new Response(ps.stdout).text()])
    if (code !== 0) continue
    const subject = stdout.trim()
    if (!subject) continue
    // Signer subject is a DN like CN="Huawei Technologies Co., Ltd.", ...
    // Match the CN component whether or not it is quoted.
    const cnMatch = subject.match(/CN=(?:"([^"]+)"|([^,]+))/i)
    const cn = cnMatch ? (cnMatch[1] ?? cnMatch[2]) : undefined
    return cn === WINDOWS_TRUSTED_SIGNER_CN
  }
  return false
}

async function verifyMacSignature(bin: string): Promise<boolean> {
  const codesign = Bun.spawn(["codesign", "-dv", "--verbose=4", bin], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([codesign.exited, new Response(codesign.stdout).text(), new Response(codesign.stderr).text()])
  if (code !== 0) return false
  const output = `${stdout}\n${stderr}`
  const teamMatch = output.match(/TeamIdentifier=([0-9A-Z]+)/i)
  if (!teamMatch) return false
  // Once the product Team ID is pinned, unknown signers fail closed.
  if (MACOS_TRUSTED_TEAM_ID && teamMatch[1] !== MACOS_TRUSTED_TEAM_ID) return false
  return true
}

export async function verifySignature(bin: string): Promise<boolean> {
  if (process.platform === "win32") return verifyWindowsSignature(bin)
  if (process.platform === "darwin") return verifyMacSignature(bin)
  return true
}

async function discoverTrustedHdc(home: string): Promise<TrustedHdcDescriptor | undefined> {
  const cached = descriptorCache.get(home)
  if (cached) return cached

  const bin = hdcPath(home)
  if (!(await Bun.file(bin).exists())) return undefined

  const version = await parseHdcVersion(bin)
  if (!version || !isSupportedVersion(version)) return undefined

  if (!(await verifySignature(bin))) return undefined

  const descriptor: TrustedHdcDescriptor = { path: bin, version }
  descriptorCache.set(home, descriptor)
  return descriptor
}

/** Non-fatal discovery used by the coordinator to fill hdcVersion. */
export async function tryDiscoverTrustedHdc(): Promise<TrustedHdcDescriptor | undefined> {
  const home = await findDevEcoHome()
  if (!home) return undefined
  return discoverTrustedHdc(home)
}

/**
 * Fail-closed discovery for the SEC2-era coordinator. Discovery
 * failure (no DevEco home, no hdc, or a version below the SR1 §1.4
 * minimum) maps to the SEC1-produced `hdc_unavailable`; the version
 * mismatch inside `HdcGuardService.decide` is `runtime_incompatible`.
 */
export async function requireTrustedHdc(): Promise<TrustedHdcDescriptor> {
  const home = await findDevEcoHome()
  if (!home) {
    throw new HdcDenial("hdc_unavailable", "DevEco Studio installation not found; cannot locate the real hdc")
  }
  const descriptor = await discoverTrustedHdc(home)
  if (!descriptor) {
    const bin = hdcPath(home)
    const found = await Bun.file(bin).exists()
    throw new HdcDenial(
      "hdc_unavailable",
      found
        ? `hdc at ${bin} did not report a supported version (minimum: ${MIN_HDC_VERSION})`
        : `real hdc not found at ${bin} (fail closed)`,
    )
  }
  return descriptor
}
