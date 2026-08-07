import { createHash, timingSafeEqual } from 'node:crypto'

export function safeEqual(a: string, b: string): boolean {
  // SHA-256 normalizes both inputs to a fixed 32-byte length,
  // eliminating the length-short-circuit timing side-channel.
  // Matches the pattern used in packages/server/src/auth.ts timingSafeStringEqual.
  const hashA = createHash('sha256').update(a).digest()
  const hashB = createHash('sha256').update(b).digest()
  return timingSafeEqual(hashA, hashB)
}
