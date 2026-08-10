export * as SyncTicket from "./sync-ticket"

import crypto from "node:crypto"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"

// HMAC-SHA256 bearer token that binds a sync mutation request to a single
// workspace. The control-plane mints one per warp target (sessionWarp); the
// /sync/replay and /sync/steal SyncGuardMiddleware verifies it so a caller
// cannot pivot sessions across workspaces by setting ?workspace= alone. Basic
// auth is a shared credential with no workspace identity, so without this
// ticket any holder could replay events into or steal sessions from another
// workspace.
//
// The key is DEVECO_SYNC_TICKET_KEY when set, otherwise a per-process random
// secret. Single-process deployments and the local-warp path (which never
// calls these HTTP endpoints) are covered by the random key; multi-instance
// remote warp requires DEVECO_SYNC_TICKET_KEY to be configured identically on
// every instance that serves /sync/*.
const KEY = process.env.DEVECO_SYNC_TICKET_KEY
  ? Buffer.from(process.env.DEVECO_SYNC_TICKET_KEY, "utf8")
  : crypto.randomBytes(32)

const TTL_SECONDS = 300

// Callers pass the token via this query param, matching the pty-ticket convention.
export const QUERY = "ticket"

function sign(message: string) {
  return crypto.createHmac("sha256", KEY).update(message, "utf8").digest()
}

export function mint(workspaceID: WorkspaceV2.ID, ttlSeconds = TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const payload = `${workspaceID}.${exp}`
  const message = Buffer.from(payload, "utf8").toString("base64url")
  const mac = sign(message).toString("base64url")
  return `${message}.${mac}`
}

export function verify(token: string | undefined | null, expectedWorkspaceID: string | undefined) {
  if (!token || !expectedWorkspaceID) return false
  const [message, mac] = token.split(".")
  if (!message || !mac) return false
  const expected = sign(message)
  const provided = Buffer.from(mac, "base64url")
  // Length check before timingSafeEqual: it throws on differing lengths, and a
  // malformed mac must not leak whether the prefix matched.
  if (expected.length !== provided.length || expected.length === 0) return false
  if (!crypto.timingSafeEqual(expected, provided)) return false
  const payload = Buffer.from(message, "base64url").toString("utf8")
  const separator = payload.lastIndexOf(".")
  if (separator === -1) return false
  const workspaceID = payload.slice(0, separator)
  const exp = Number(payload.slice(separator + 1))
  if (!Number.isFinite(exp) || Date.now() / 1000 > exp) return false
  return workspaceID === expectedWorkspaceID
}
