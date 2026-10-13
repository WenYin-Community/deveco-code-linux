import { Session } from "@/session/session"
import { Effect } from "effect"
import { getSessionCwd } from "../lib/session-cwd"
import type { Context } from "../tool"

const MAX_RESPONSE_BYTES = 1024 * 1024

export async function resolveWorktree(ctx: Context, sessions: Session.Interface): Promise<string> {
  const cwd = getSessionCwd(ctx.sessionID)
  if (cwd) return cwd

  const session = await Effect.runPromise(
    sessions.get(ctx.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined))),
  )
  return session?.directory ?? process.cwd()
}

export async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error(`Multimodal model response exceeds ${MAX_RESPONSE_BYTES} bytes`)
  }

  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error(`Multimodal model response exceeds ${MAX_RESPONSE_BYTES} bytes`)
    }
    chunks.push(chunk.value)
  }
  return Buffer.concat(chunks, size).toString("utf8")
}

export function resolveChatCompletionEndpoint(baseURL: string): string {
  const normalized = baseURL.replace(/\/+$/, "")
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
