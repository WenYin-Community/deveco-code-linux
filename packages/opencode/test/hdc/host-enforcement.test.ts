import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ResolvedProfile } from "@opencode-ai/core/config/sandbox"
import {
  hdcBinariesFromHomes,
  injectHostEnforcement,
  runHostEnforcementCanaries,
  resetHostEnforcementCaches,
  type CanaryDeps,
  type CanaryResult,
  type ProbeOutcome,
} from "../../src/hdc/host-enforcement"

const HDC_BIN = "/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc"
const GUARD_ENDPOINT = "/var/folders/xy/deveco-hdc-test.sock"

function profileFixture(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    profile_id: "read-only",
    filesystem: { ":root": "read" },
    network_enabled: true,
    workspace_roots: ["/tmp/project"],
    is_implicit: false,
    source_layer: "project",
    ...overrides,
  }
}

function allPassOutcome(script: string): ProbeOutcome {
  if (script.includes("CANARY_READ")) return { code: 0, stdout: "CANARY_READ_DENIED\n", stderr: "", timedOut: false }
  if (script.includes("CANARY_EXEC")) return { code: 0, stdout: "CANARY_EXEC_DENIED\n", stderr: "", timedOut: false }
  if (script.includes("CANARY_SHIM")) return { code: 0, stdout: "CANARY_SHIM_PRESENT\n", stderr: "", timedOut: false }
  // trusted_exec: `hdc list targets` completes via the guard.
  return { code: 0, stdout: "[Empty]\n", stderr: "", timedOut: false }
}

function fakeDeps(scripted: (script: string, bin: string | undefined) => ProbeOutcome) {
  let prepareCalls = 0
  const deps: CanaryDeps = {
    prepare: async (request) => {
      prepareCalls++
      return {
        executable: request.command.executable,
        args: [...request.command.args],
        cwd: request.command.cwd,
        env: request.command.env,
      }
    },
    spawn: async (prepared) => {
      const script = prepared.args[1] ?? ""
      return scripted(script, prepared.args[3])
    },
  }
  return { deps, prepareCalls: () => prepareCalls }
}

function armedOptions(overrides: Record<string, unknown> = {}) {
  return {
    profile: injectHostEnforcement(profileFixture(), [HDC_BIN], GUARD_ENDPOINT),
    bins: [HDC_BIN],
    env: { PATH: "/usr/bin:/bin", DEVECO_CODE_HDC_ENDPOINT: GUARD_ENDPOINT, DEVECO_CODE_HDC_TOKEN: "t", DEVECO_CODE_HDC_SESSION: "s" },
    cwd: "/tmp/project",
    armed: true,
    ...overrides,
  }
}

describe("hdc host enforcement", () => {
  test("injectHostEnforcement denies read/exec on every bin and allows the guard UDS", () => {
    const profile = profileFixture()
    const injected = injectHostEnforcement(profile, [HDC_BIN], GUARD_ENDPOINT)

    expect(injected.filesystem[HDC_BIN]).toBe("deny")
    expect(injected.filesystem[GUARD_ENDPOINT]).toBe("write")
    expect(injected.process?.deny_exec).toEqual([HDC_BIN])
    // read-only base entries preserved
    expect(injected.filesystem[":root"]).toBe("read")
    // input profile untouched
    expect(profile.filesystem[HDC_BIN]).toBeUndefined()
    expect(profile.process).toBeUndefined()
  })

  test("injectHostEnforcement unions existing deny_exec and dedupes bins", () => {
    const profile = profileFixture({ process: { deny_exec: ["/usr/local/bin/other"] } })
    const injected = injectHostEnforcement(profile, [HDC_BIN, HDC_BIN], undefined)
    expect(injected.process?.deny_exec).toEqual(["/usr/local/bin/other", HDC_BIN])
    expect(injected.filesystem[GUARD_ENDPOINT]).toBeUndefined()
  })

  test("hdcBinariesFromHomes only returns existing hdc binaries", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "host-enforcement-home-"))
    try {
      const toolchains = path.join(home, "sdk", "default", "openharmony", "toolchains")
      await fs.mkdir(toolchains, { recursive: true })
      const hdcName = process.platform === "win32" ? "hdc.exe" : "hdc"
      await fs.writeFile(path.join(toolchains, hdcName), "")
      const bins = await hdcBinariesFromHomes([home, path.join(home, "missing")])
      expect(bins).toEqual([path.join(toolchains, hdcName)])
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("all four canaries pass when armed", async () => {
    resetHostEnforcementCaches()
    const { deps, prepareCalls } = fakeDeps((script) => allPassOutcome(script))
    const run = await runHostEnforcementCanaries(armedOptions(), deps)
    expect(run.cached).toBe(false)
    expect(run.results.filter((result) => result.status === "passed").map((result) => result.name)).toEqual([
      "direct_read_deny",
      "direct_exec_deny",
      "shim_allow",
      "trusted_exec",
    ])
    // second run with the same policy hits the pass cache
    const cached = await runHostEnforcementCanaries(armedOptions(), deps)
    expect(cached.cached).toBe(true)
    expect(cached.results).toEqual([])
    expect(prepareCalls()).toBe(4)
  })

  test("direct_read_deny fails closed when the sandbox leaks a read", async () => {
    resetHostEnforcementCaches()
    const { deps } = fakeDeps((script) =>
      script.includes("CANARY_READ") ? { code: 0, stdout: "CANARY_READ_LEAKED\n", stderr: "", timedOut: false } : allPassOutcome(script),
    )
    let error: unknown
    try {
      await runHostEnforcementCanaries(armedOptions(), deps)
    } catch (err) {
      error = err
    }
    expect(String(error)).toContain("direct_read_deny")
    expect(String(error)).toContain("read of")
    const results = (error as { results: CanaryResult[] }).results
    expect(results.find((result) => result.name === "direct_read_deny")?.status).toBe("failed")
  })

  test("direct_exec_deny fails closed when the sandbox executes the binary", async () => {
    resetHostEnforcementCaches()
    const { deps } = fakeDeps((script) =>
      script.includes("CANARY_EXEC") ? { code: 0, stdout: "CANARY_EXEC_RAN_1\n", stderr: "", timedOut: false } : allPassOutcome(script),
    )
    await expect(runHostEnforcementCanaries(armedOptions(), deps)).rejects.toThrow("direct_exec_deny")
  })

  test("shim_allow fails closed when the shim is unresolvable", async () => {
    resetHostEnforcementCaches()
    const { deps } = fakeDeps((script) =>
      script.includes("CANARY_SHIM") ? { code: 1, stdout: "CANARY_SHIM_MISSING\n", stderr: "", timedOut: false } : allPassOutcome(script),
    )
    await expect(runHostEnforcementCanaries(armedOptions(), deps)).rejects.toThrow("shim_allow")
  })

  test("trusted_exec fails closed when the guard is unreachable from the sandbox", async () => {
    resetHostEnforcementCaches()
    const { deps } = fakeDeps((script) =>
      script.includes("hdc list targets")
        ? { code: 1, stdout: "", stderr: "[hdc-guard] reason_code=guard_unavailable message=unable to reach hdc guard\n", timedOut: false }
        : allPassOutcome(script),
    )
    await expect(runHostEnforcementCanaries(armedOptions(), deps)).rejects.toThrow("trusted_exec")
  })

  test("trusted_exec passes on a guard policy denial (trusted pipe verified)", async () => {
    resetHostEnforcementCaches()
    const { deps } = fakeDeps((script) =>
      script.includes("hdc list targets")
        ? { code: 1, stdout: "", stderr: "[hdc-guard] reason_code=product_default_deny message=denied by ruleset\n", timedOut: false }
        : allPassOutcome(script),
    )
    const run = await runHostEnforcementCanaries(armedOptions(), deps)
    expect(run.results.find((result) => result.name === "trusted_exec")?.status).toBe("passed")
  })

  test("trusted_exec is skipped under network-off profiles (guard UDS unreachable in sandbox)", async () => {
    resetHostEnforcementCaches()
    const { deps, prepareCalls } = fakeDeps((script) => allPassOutcome(script))
    const options = armedOptions({
      profile: injectHostEnforcement(profileFixture({ network_enabled: false }), [HDC_BIN], GUARD_ENDPOINT),
    })
    const run = await runHostEnforcementCanaries(options, deps)
    const byName = new Map(run.results.map((result) => [result.name, result.status]))
    expect(byName.get("direct_read_deny")).toBe("passed")
    expect(byName.get("direct_exec_deny")).toBe("passed")
    expect(byName.get("shim_allow")).toBe("passed")
    expect(byName.get("trusted_exec")).toBe("skipped")
    expect(prepareCalls()).toBe(3)
    // second run with the same network-off policy hits the pass cache
    const cached = await runHostEnforcementCanaries(options, deps)
    expect(cached.cached).toBe(true)
    expect(cached.results).toEqual([])
  })

  test("unarmed shells skip the shim/trusted canaries but keep the deny canaries", async () => {
    resetHostEnforcementCaches()
    const { deps, prepareCalls } = fakeDeps((script) => allPassOutcome(script))
    const run = await runHostEnforcementCanaries(armedOptions({ armed: false }), deps)
    const byName = new Map(run.results.map((result) => [result.name, result.status]))
    expect(byName.get("direct_read_deny")).toBe("passed")
    expect(byName.get("direct_exec_deny")).toBe("passed")
    expect(byName.get("shim_allow")).toBe("skipped")
    expect(byName.get("trusted_exec")).toBe("skipped")
    expect(prepareCalls()).toBe(2)
  })

  test("failed canary sets are negatively cached (no probe storm) and re-run after the TTL", async () => {
    resetHostEnforcementCaches()
    let leakRead = true
    const { deps, prepareCalls } = fakeDeps((script) =>
      script.includes("CANARY_READ") && leakRead ? { code: 0, stdout: "CANARY_READ_LEAKED\n", stderr: "", timedOut: false } : allPassOutcome(script),
    )
    const options = armedOptions({ failureTtlMs: 25 })
    await expect(runHostEnforcementCanaries(options, deps)).rejects.toThrow("direct_read_deny")
    const afterFirstFailure = prepareCalls()
    // immediate retry: served from the negative cache without new probes
    await expect(runHostEnforcementCanaries(options, deps)).rejects.toThrow("cached failure")
    expect(prepareCalls()).toBe(afterFirstFailure)
    // after the TTL the set re-runs and now passes (self-heal; fail closed until then)
    await new Promise((resolve) => setTimeout(resolve, 60))
    leakRead = false
    const run = await runHostEnforcementCanaries(options, deps)
    expect(run.results.find((result) => result.name === "direct_read_deny")?.status).toBe("passed")
  })

  test("probe timeouts fail closed", async () => {
    resetHostEnforcementCaches()
    const { deps } = fakeDeps((script) =>
      script.includes("CANARY_READ") ? { code: null, stdout: "", stderr: "", timedOut: true } : allPassOutcome(script),
    )
    await expect(runHostEnforcementCanaries(armedOptions(), deps)).rejects.toThrow("timed out")
  })
})
