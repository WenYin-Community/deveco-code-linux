import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

// Degenerate catalog rows still resolve to a non-positive prompt budget after
// the output ceiling clamp (e.g. a guard model declaring input == context).
// usable() === 0 makes isOverflow() true at any token count, which puts the
// session into a compaction loop that only ends when compaction itself fails.
// The floor is capped by what the window leaves after the completion budget, so
// it lifts a dead budget without ever overstating capacity.
const MIN_USABLE_CONTEXT = 1_024

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const maxOutput = ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax)
  const reserved = input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, maxOutput)
  const budget = input.model.limit.input ? input.model.limit.input - reserved : context - maxOutput
  const floor = Math.min(MIN_USABLE_CONTEXT, Math.max(1, context - maxOutput))
  return Math.max(floor, budget)
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
