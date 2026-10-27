import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { HdcRegistry, invalidateRegistryCache } from "../../src/hdc/registry"
import { isSupportedVersion } from "@opencode-ai/core/hdc"

const isUnix = process.platform !== "win32"

let fakeHome: string | undefined
const ORIGINAL_DEVECO_HOME = process.env.DEVECO_HOME

beforeAll(async () => {
  if (!isUnix) return
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "deveco-registry-"))
  await fs.mkdir(path.join(fakeHome, "tools", "node", "bin"), { recursive: true })
  await fs.writeFile(path.join(fakeHome, "tools", "node", "bin", "node"), "")
  await fs.writeFile(path.join(fakeHome, "product-info.json"), JSON.stringify({ version: "6.0.0" }))
  const toolchains = path.join(fakeHome, "sdk", "default", "openharmony", "toolchains")
  await fs.mkdir(toolchains, { recursive: true })
  await fs.writeFile(
    path.join(toolchains, "hdc"),
    [
      "#!/usr/bin/env bun",
      "const args = process.argv.slice(2)",
      "if (args[0] === 'version') { console.log('Ver: 3.2.0d'); process.exit(0) }",
      "console.log(JSON.stringify(args))",
    ].join("\n"),
  )
  await fs.chmod(path.join(toolchains, "hdc"), 0o755)
})

afterAll(async () => {
  if (fakeHome) await fs.rm(fakeHome, { recursive: true, force: true })
  if (ORIGINAL_DEVECO_HOME === undefined) delete process.env.DEVECO_HOME
  else process.env.DEVECO_HOME = ORIGINAL_DEVECO_HOME
})

describe("hdc registry (SEC1 AR-006)", () => {
  test("version floor gates discovery (>= 3.2.0c)", () => {
    for (const v of ["3.2.0c", "3.2.0d", "3.2.0f", "5.0.0", "5.0.1", "6.0.0"]) expect(isSupportedVersion(v)).toBe(true)
    expect(isSupportedVersion("3.2.0b")).toBe(false)
    expect(isSupportedVersion("2.0.0")).toBe(false)
  })

  test.skipIf(!isUnix)("discovers and version-verifies the real hdc from DEVECO_HOME", async () => {
    if (!fakeHome) throw new Error("fake home was not created")
    process.env.DEVECO_HOME = fakeHome
    invalidateRegistryCache()
    const descriptor = await HdcRegistry.tryDiscoverTrustedHdc()
    expect(descriptor).not.toBeUndefined()
    expect(descriptor!.version).toBe("3.2.0d")
    expect(descriptor!.path).toContain("toolchains")
  })

  test.skipIf(!isUnix)("unknown DevEco home yields undefined (non-fatal)", async () => {
    const orphan = await fs.mkdtemp(path.join(os.tmpdir(), "deveco-orphan-"))
    process.env.DEVECO_HOME = orphan
    invalidateRegistryCache()
    try {
      const descriptor = await HdcRegistry.tryDiscoverTrustedHdc()
      expect(descriptor).toBeUndefined()
    } finally {
      await fs.rm(orphan, { recursive: true, force: true })
    }
  })

  // Windows-only integration check against a real shipped hdc.exe:
  // its Authenticode signer must carry the trusted Huawei CN. Skips
  // on machines without a DevEco install (CI), on mac, and on linux.
  test.skipIf(process.platform !== "win32")("real hdc.exe passes Authenticode signer verification", async () => {
    const candidates = [
      "C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe",
      "D:\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe",
    ]
    let realHdc: string | undefined
    for (const p of candidates) {
      const ok = await fs.access(p).then(() => true, () => false)
      if (ok) {
        realHdc = p
        break
      }
    }
    if (!realHdc) return
    expect(await HdcRegistry.verifySignature(realHdc)).toBe(true)
  })
})
