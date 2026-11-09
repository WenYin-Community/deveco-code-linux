import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { HdcHap } from "../../src/hdc/hap"

// ─── Minimal zip builder ─────────────────────────────────────
// Hand-rolled STORE/DEFLATE zips so the reader is tested against
// the real on-disk format without fixture binaries. CRCs are
// zeroed: the reader intentionally does not verify them.

interface TestEntry {
  name: string
  data: Buffer
  deflate?: boolean
}

function buildZip(entries: TestEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8")
    const method = entry.deflate ? 8 : 0
    const payload = entry.deflate ? zlib.deflateRawSync(entry.data) : entry.data
    locals.push(buildLocalHeader(method, nameBuf, entry.data.length, payload), nameBuf, payload)
    centrals.push(buildCentralHeader(method, nameBuf, entry.data.length, payload, offset), nameBuf)
    offset += 30 + nameBuf.length + payload.length
  }

  const centralBuf = Buffer.concat(centrals)
  return Buffer.concat([...locals, centralBuf, buildEndOfCentralDirectory(entries.length, centralBuf.length, offset)])
}

function buildLocalHeader(method: number, nameBuf: Buffer, rawLength: number, payload: Buffer): Buffer {
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(method, 8)
  local.writeUInt16LE(0, 10)
  local.writeUInt16LE(0, 12)
  local.writeUInt32LE(0, 14)
  local.writeUInt32LE(payload.length, 18)
  local.writeUInt32LE(rawLength, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)
  return local
}

function buildCentralHeader(method: number, nameBuf: Buffer, rawLength: number, payload: Buffer, offset: number): Buffer {
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(method, 10)
  central.writeUInt16LE(0, 12)
  central.writeUInt16LE(0, 14)
  central.writeUInt32LE(0, 16)
  central.writeUInt32LE(payload.length, 20)
  central.writeUInt32LE(rawLength, 24)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt32LE(0, 36)
  central.writeUInt32LE(0, 40)
  central.writeUInt32LE(offset, 42)
  return central
}

function buildEndOfCentralDirectory(count: number, centralLength: number, offset: number): Buffer {
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(count, 8)
  eocd.writeUInt16LE(count, 10)
  eocd.writeUInt32LE(centralLength, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return eocd
}

const MODULE_JSON = Buffer.from(JSON.stringify({ app: { bundleName: "com.example.app" }, module: { name: "entry" } }))
const PACK_INFO = Buffer.from(
  JSON.stringify({
    summary: {
      app: { bundleName: "com.example.packinfo" },
      modules: [{ name: "entry", moduleType: "entry" }],
    },
  }),
)

async function withTempPackage(bytes: Buffer, run: (file: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hdc-hap-"))
  const file = path.join(dir, "package.hap")
  await fs.writeFile(file, bytes)
  try {
    await run(file)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe("hdc hap bundle identity reader", () => {
  test("reads app.bundleName from a STORE module.json", async () => {
    await withTempPackage(buildZip([{ name: "module.json", data: MODULE_JSON }, { name: "pack.info", data: PACK_INFO }]), async (file) => {
      expect(await HdcHap.readHapBundleName(file)).toBe("com.example.app")
    })
  })

  test("reads app.bundleName from a DEFLATE module.json", async () => {
    await withTempPackage(buildZip([{ name: "module.json", data: MODULE_JSON, deflate: true }]), async (file) => {
      expect(await HdcHap.readHapBundleName(file)).toBe("com.example.app")
    })
  })

  test("falls back to pack.info when module.json is missing", async () => {
    await withTempPackage(buildZip([{ name: "pack.info", data: PACK_INFO }]), async (file) => {
      expect(await HdcHap.readHapBundleName(file)).toBe("com.example.packinfo")
    })
  })

  test("falls back to pack.info when module.json has no app.bundleName", async () => {
    const broken = Buffer.from(JSON.stringify({ app: {}, module: {} }))
    await withTempPackage(buildZip([{ name: "module.json", data: broken }, { name: "pack.info", data: PACK_INFO }]), async (file) => {
      expect(await HdcHap.readHapBundleName(file)).toBe("com.example.packinfo")
    })
  })

  test("matches nested module.json entries (app packages)", async () => {
    await withTempPackage(buildZip([{ name: "packs/entry/module.json", data: MODULE_JSON }]), async (file) => {
      expect(await HdcHap.readHapBundleName(file)).toBe("com.example.app")
    })
  })

  test("returns undefined for missing files", async () => {
    expect(await HdcHap.readHapBundleName(path.join(os.tmpdir(), "hdc-hap-does-not-exist.hap"))).toBeUndefined()
  })

  test("returns undefined for non-zip bytes (fail closed)", async () => {
    await withTempPackage(Buffer.from("this is not a zip archive, just plain text"), async (file) => {
      expect(await HdcHap.readHapBundleName(file)).toBeUndefined()
    })
  })

  test("returns undefined when neither module.json nor pack.info is present", async () => {
    await withTempPackage(buildZip([{ name: "ets/index.abc", data: Buffer.from([1, 2, 3]) }]), async (file) => {
      expect(await HdcHap.readHapBundleName(file)).toBeUndefined()
    })
  })

  test("returns undefined for corrupt central directories (fail closed)", async () => {
    const zip = buildZip([{ name: "module.json", data: MODULE_JSON }])
    // Clobber the central directory signature.
    const eocd = zip.length - 22
    const centralOffset = zip.readUInt32LE(eocd + 16)
    const corrupt = Buffer.from(zip)
    corrupt.writeUInt32LE(0xdeadbeef, centralOffset)
    await withTempPackage(corrupt, async (file) => {
      expect(await HdcHap.readHapBundleName(file)).toBeUndefined()
    })
  })

  test("returns undefined for non-string or empty bundleName values", async () => {
    const numberBundle = Buffer.from(JSON.stringify({ app: { bundleName: 123 } }))
    await withTempPackage(buildZip([{ name: "module.json", data: numberBundle }]), async (file) => {
      expect(await HdcHap.readHapBundleName(file)).toBeUndefined()
    })
    const emptyBundle = Buffer.from(JSON.stringify({ app: { bundleName: "" } }))
    await withTempPackage(buildZip([{ name: "module.json", data: emptyBundle }]), async (file) => {
      expect(await HdcHap.readHapBundleName(file)).toBeUndefined()
    })
  })
})
