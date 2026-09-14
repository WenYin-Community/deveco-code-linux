import type { Message, Part } from "@opencode-ai/sdk/v2"

export function shouldKeepMessagesOnInterrupt(
  msgs: readonly Pick<Message, "id" | "role">[],
  parts: Record<string, readonly Part[]>,
) {
  const lastUserIdx = msgs.findLastIndex((x) => x.role === "user")

  // Without the current user message, do not take the destructive cancel path.
  if (lastUserIdx < 0) return true

  return msgs
    .slice(lastUserIdx + 1)
    .filter((x) => x.role === "assistant")
    .some((msg) => {
      const messageParts = parts[msg.id] ?? []
      return messageParts.some((part) => {
        if (part.type === "text" || part.type === "reasoning") return part.text.trim().length > 0
        if (part.type === "tool") return part.state.status !== "pending"
        return false
      })
    })
}
