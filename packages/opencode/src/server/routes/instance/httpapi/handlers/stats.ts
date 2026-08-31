import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { UsageQuery } from "../groups/stats"
import { Stats } from "@/stats/stats"

export const statsHandlers = HttpApiBuilder.group(InstanceHttpApi, "stats", (handlers) =>
  Effect.gen(function* () {
    const stats = yield* Stats.Service

    const usage = Effect.fn("StatsHttpApi.usage")(function* (ctx: { query: typeof UsageQuery.Type }) {
      return yield* stats.usage({
        directory: ctx.query.directory,
        sessionID: ctx.query.sessionID,
        days: ctx.query.days,
      })
    })

    const quota = Effect.fn("StatsHttpApi.quota")(function* () {
      return yield* stats.quota()
    })

    return handlers.handle("usage", usage).handle("quota", quota)
  }),
)
