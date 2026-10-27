export * as HdcHap from "./hap"

import { readHapBundleName as coreReadHapBundleName } from "@opencode-ai/core/hdc"

// ─── HAP/App bundle identity reader (SR1 v3.0 §2.2) ──────────
// Forwarding wrapper over the core reader (sync fs read) kept for
// the async API shape; the authoritative SEC2 validation path is
// core's validators.ts, which reads the bundle directly.

export async function readHapBundleName(hapPath: string): Promise<string | undefined> {
  return coreReadHapBundleName(hapPath)
}
