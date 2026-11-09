import fs from "node:fs"
import { inflateRawSync } from "node:zlib"

// ─── HAP/App bundle identity reader (SR1 v3.0 §2.2 / AR-SEC2-002 §2) ──
// Reads the application bundleName out of a HarmonyOS package
// (`.hap`/`.app`) zip: `module.json` `app.bundleName` first,
// `pack.info` as fallback. Pure TS + node zlib — no shell-outs.
// Every structural failure returns undefined so callers fail closed
// (bundle_not_allowed); nothing here ever guesses a bundle name.

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localOffset: number
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_EOCD_SEARCH = 65_557 // 22-byte EOCD + max 64KiB comment
const MAX_ENTRIES = 100_000

// Locate the End Of Central Directory record; undefined for
// truncated files, zip64 archives, or corrupt signatures.
function findEocd(buf: Buffer): number | undefined {
  const start = Math.max(0, buf.length - MAX_EOCD_SEARCH)
  for (let p = buf.length - 22; p >= start; p--) {
    if (buf.readUInt32LE(p) !== EOCD_SIGNATURE) continue
    const commentLen = buf.readUInt16LE(p + 20)
    if (p + 22 + commentLen !== buf.length) continue
    return p
  }
  return undefined
}

function readCentralDirectory(buf: Buffer): ZipEntry[] | undefined {
  const eocd = findEocd(buf)
  if (eocd === undefined) return undefined
  const count = buf.readUInt16LE(eocd + 10)
  const offset = buf.readUInt32LE(eocd + 16)
  // 0xFFFF/0xFFFFFFFF markers mean zip64; not supported, fail closed.
  if (count === 0xffff || offset === 0xffffffff || count > MAX_ENTRIES) return undefined

  const entries: ZipEntry[] = []
  let p = offset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIGNATURE) return undefined
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    entries.push({
      name: buf.toString("utf8", p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      localOffset: buf.readUInt32LE(p + 42),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

// Exact root-level match first, then any nested path with the
// same basename (app packages nest haps).
function findEntry(entries: ZipEntry[], filename: string): ZipEntry | undefined {
  return (
    entries.find((entry) => entry.name === filename) ??
    entries.find((entry) => entry.name.endsWith("/" + filename))
  )
}

function readEntryData(buf: Buffer, entry: ZipEntry): Buffer | undefined {
  const p = entry.localOffset
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL_SIGNATURE) return undefined
  // Sizes come from the central directory: the local header may
  // zero them when a data descriptor flag is set.
  const dataStart = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28)
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > buf.length) return undefined
  const raw = buf.subarray(dataStart, dataEnd)
  if (entry.method === 0) return raw
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw)
    } catch {
      return undefined
    }
  }
  return undefined
}

function parseJson(data: Buffer | undefined): unknown {
  if (!data) return undefined
  try {
    return JSON.parse(data.toString("utf8"))
  } catch {
    return undefined
  }
}

function bundleNameFromModuleJson(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined
  const app = (parsed as Record<string, unknown>).app
  if (!app || typeof app !== "object") return undefined
  const bundleName = (app as Record<string, unknown>).bundleName
  return typeof bundleName === "string" && bundleName.length > 0 ? bundleName : undefined
}

// pack.info shape has drifted between toolchain versions; take
// the first string `bundleName` found under a small depth bound.
function bundleNameFromPackInfo(parsed: unknown, depth: number): string | undefined {
  if (depth > 8 || !parsed || typeof parsed !== "object") return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.bundleName === "string" && record.bundleName.length > 0) return record.bundleName
  for (const child of Object.values(record)) {
    const found = bundleNameFromPackInfo(child, depth + 1)
    if (found) return found
  }
  return undefined
}

// The application bundleName inside the package, or undefined
// when it cannot be reliably determined (fail closed).
export function readHapBundleName(hapPath: string): string | undefined {
  const buf = readHapFile(hapPath)
  if (!buf) return undefined
  const entries = readCentralDirectory(buf)
  if (!entries) return undefined
  return bundleNameFromModuleEntry(buf, entries) ?? bundleNameFromPackEntry(buf, entries)
}

function readHapFile(hapPath: string): Buffer | undefined {
  try {
    return fs.readFileSync(hapPath)
  } catch {
    return undefined
  }
}

function bundleNameFromModuleEntry(buf: Buffer, entries: ZipEntry[]): string | undefined {
  const moduleJson = findEntry(entries, "module.json")
  if (!moduleJson) return undefined
  return bundleNameFromModuleJson(parseJson(readEntryData(buf, moduleJson)))
}

function bundleNameFromPackEntry(buf: Buffer, entries: ZipEntry[]): string | undefined {
  const packInfo = findEntry(entries, "pack.info")
  if (!packInfo) return undefined
  return bundleNameFromPackInfo(parseJson(readEntryData(buf, packInfo)), 0)
}
