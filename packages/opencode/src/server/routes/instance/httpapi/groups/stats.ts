import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/stats"

export const UsageQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionID: Schema.optional(SessionSchema.ID),
  days: Schema.optional(Schema.NumberFromString),
})

const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
}).annotate({ identifier: "StatsTokens" })

export const StatsUsage = Schema.Struct({
  directory: Schema.optional(Schema.String),
  total: Schema.Struct({
    sessions: Schema.Finite,
    messages: Schema.Finite,
    cost: Schema.Finite,
    longestDuration: Schema.Finite,
    tokens: Tokens,
  }),
  models: Schema.Array(
    Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      messages: Schema.Finite,
      cost: Schema.Finite,
      tokens: Tokens,
      daily: Schema.Array(
        Schema.Struct({
          date: Schema.String,
          tokens: Schema.Finite,
        }).annotate({ identifier: "StatsModelDaily" }),
      ),
    }).annotate({ identifier: "StatsModelUsage" }),
  ),
  session: Schema.optional(
    Schema.Struct({
      sessionID: Schema.String,
      title: Schema.String,
      timeCreated: Schema.Finite,
      model: Schema.optional(Schema.Struct({ providerID: Schema.String, modelID: Schema.String })),
      messages: Schema.Finite,
      cost: Schema.Finite,
      durationApi: Schema.Finite,
      durationWall: Schema.Finite,
      additions: Schema.Finite,
      deletions: Schema.Finite,
      tokens: Tokens,
    }).annotate({ identifier: "StatsSessionUsage" }),
  ),
  daily: Schema.Array(
    Schema.Struct({
      date: Schema.String,
      messages: Schema.Finite,
      tokens: Schema.Finite,
    }).annotate({ identifier: "StatsDailyUsage" }),
  ),
}).annotate({ identifier: "StatsUsage" })

const QuotaWindow = Schema.Struct({
  enabled: Schema.Boolean,
  periodHours: Schema.optional(Schema.Finite),
  nextResetTime: Schema.optional(Schema.String),
  total: Schema.optional(Schema.Finite),
  used: Schema.optional(Schema.Finite),
  remaining: Schema.optional(Schema.Finite),
}).annotate({ identifier: "StatsQuotaWindow" })

export const StatsQuota = Schema.Struct({
  hourly: Schema.optional(QuotaWindow),
  weekly: Schema.optional(QuotaWindow),
  monthly: Schema.optional(QuotaWindow),
}).annotate({ identifier: "StatsQuota" })

export const StatsPaths = {
  usage: `${root}/usage`,
  quota: `${root}/quota`,
} as const

export const StatsApi = HttpApi.make("stats")
  .add(
    HttpApiGroup.make("stats")
      .add(
        HttpApiEndpoint.get("usage", StatsPaths.usage, {
          query: UsageQuery,
          success: described(StatsUsage, "Aggregated token usage statistics"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "stats.usage",
            summary: "Usage statistics",
            description:
              "Aggregated token and cost usage: totals and per-model breakdown computed from assistant messages (optionally limited to the last `days` days), daily counts for the heatmap, and optional per-session usage.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("quota", StatsPaths.quota, {
          success: described(StatsQuota, "Usage quota windows and allowances"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "stats.quota",
            summary: "Usage quota",
            description: "Token quota windows (hourly/weekly/monthly) with remaining amounts and reset times from the deveco gateway.",
          }),
        ),
      ),
  )
