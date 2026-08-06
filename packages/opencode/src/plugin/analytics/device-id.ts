import { createHash } from "crypto"
import os from "os"
import { getOrCreateDeviceId } from "./storage"

function isValidMac(mac: string | undefined): mac is string {
  if (!mac) return false
  const normalized = mac.toLowerCase().replace(/[:-]/g, "")
  if (!/^[0-9a-f]{12}$/.test(normalized)) return false
  if (normalized === "000000000000" || normalized === "ffffffffffff") return false
  return (parseInt(normalized.substring(0, 2), 16) & 1) === 0
}

type NetworkInterfaces = ReturnType<typeof os.networkInterfaces>

function collectValidMacs(reader: () => NetworkInterfaces): string[] {
  let interfaces: NetworkInterfaces
  try {
    interfaces = reader()
  } catch {
    return []
  }
  return Object.entries(interfaces)
    .filter(([name]) => !name.toLowerCase().includes("loopback"))
    .flatMap(([, infos]) => infos ?? [])
    .filter((info) => !info.internal)
    .map((info) => info.mac)
    .filter(isValidMac)
    .map((mac) => mac.toLowerCase().replace(/[:-]/g, ""))
}

function normalizeFallback(rawId: string): string {
  const normalized = rawId.trim().toLowerCase().replace(/-/g, "")
  if (/^[0-9a-f]{32}$/.test(normalized)) return normalized
  return createHash("sha256").update(rawId).digest("hex").slice(0, 32)
}

export async function getAnalyticsDeviceId(
  readInterfaces: () => NetworkInterfaces = () => os.networkInterfaces(),
  getFallbackId: () => Promise<string> = getOrCreateDeviceId,
): Promise<string> {
  const macs = [...new Set(collectValidMacs(readInterfaces))].sort()
  if (!macs.length) return normalizeFallback(await getFallbackId())
  const hash = createHash("sha256").update(macs[0]).digest("hex")
  return hash.slice(0, 32)
}
